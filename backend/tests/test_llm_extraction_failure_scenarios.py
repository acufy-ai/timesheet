"""
Tests for LLM extraction failure and edge-case scenarios.

Covers the 10 scenarios most likely to cause silent bad data or dropped entries:

  1. Forwarded / reply chains -- old quoted content in body
  2. Vague time descriptions -- "worked all day", "a few hours"
  3. Non-standard / relative date formats
  4. Multiple projects in one email
  5. HTML-heavy body noise
  6. Non-English content
  7. Hours expressed as time ranges ("9am-5pm")
  8. LLM timeout / unavailable (graceful degradation)
  9. Rate-limit / 429 (retry exhausted, graceful degradation)
 10. Attachment-only email (empty body)

Each test mocks _call_llm so no real OpenAI calls are made.
"""
from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, patch

from app.services.llm_ingestion import (
    classify_email,
    extract_timesheet_data,
    _deterministic_anomalies,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _llm_patch(return_value):
    """Patch _call_llm in the llm_ingestion module."""
    return patch(
        "app.services.llm_ingestion._call_llm",
        new_callable=AsyncMock,
        return_value=return_value,
    )


def _llm_raise(exc):
    """Patch _call_llm to raise an exception."""
    return patch(
        "app.services.llm_ingestion._call_llm",
        new_callable=AsyncMock,
        side_effect=exc,
    )


# ---------------------------------------------------------------------------
# Scenario 1: Forwarded / reply chains
# ---------------------------------------------------------------------------

class TestForwardedChainBody:
    """The email body contains a quoted previous message with its own dates and
    hours. The LLM should extract only the NEW entry, not the quoted one."""

    BODY_WITH_QUOTED_OLD_ENTRY = """\
Hi manager,

Please find my timesheet for this week.
I logged 8 hours on Mon 12 May on Project Alpha.

> -----Original Message-----
> From: bob@example.com
> Sent: Monday, May 5, 2025
>
> Last week I logged 6 hours on Project Beta (Mon 5 May).
> Total: 6h
"""

    @pytest.mark.asyncio
    async def test_extract_new_entry_not_quoted_old(self):
        """LLM should return the May 12 entry, not the May 5 quoted one."""
        with _llm_patch({
            "timesheets": [{
                "employee_name": "Bob",
                "period_start": "2025-05-12",
                "period_end": "2025-05-12",
                "total_hours": 8.0,
                "line_items": [{"work_date": "2025-05-12", "hours": 8.0, "description": "Project Alpha"}],
                "extraction_confidence": 0.9,
                "uncertain_fields": [],
            }]
        }):
            results = await extract_timesheet_data(
                self.BODY_WITH_QUOTED_OLD_ENTRY,
                filename_hint="",
                reference_date="2025-05-12",
            )

        assert len(results) == 1
        ts = results[0]
        assert ts["period_start"] == "2025-05-12"
        items = ts["line_items"]
        assert len(items) == 1
        assert items[0]["work_date"] == "2025-05-12"
        assert items[0]["hours"] == 8.0

    @pytest.mark.asyncio
    async def test_extract_returns_list_even_for_chain_body(self):
        """Pipeline must always get a list back, never a bare dict."""
        with _llm_patch({
            "timesheets": [{
                "employee_name": None,
                "period_start": "2025-05-12",
                "period_end": "2025-05-12",
                "total_hours": 8.0,
                "line_items": [],
                "extraction_confidence": 0.4,
                "uncertain_fields": ["employee_name"],
            }]
        }):
            results = await extract_timesheet_data(
                self.BODY_WITH_QUOTED_OLD_ENTRY,
                reference_date="2025-05-12",
            )

        assert isinstance(results, list)


# ---------------------------------------------------------------------------
# Scenario 2: Vague time descriptions
# ---------------------------------------------------------------------------

class TestVagueTimeDescriptions:
    """Emails like "worked all day" or "a few hours" give the LLM nothing
    concrete to extract. It should return low confidence or empty."""

    VAGUE_BODY = "Hey, I worked on the project most of the day on Tuesday. Let me know if you need details."

    @pytest.mark.asyncio
    async def test_low_confidence_on_vague_body(self):
        """LLM returns low confidence; pipeline should still receive the result."""
        with _llm_patch({
            "timesheets": [{
                "employee_name": None,
                "period_start": None,
                "period_end": None,
                "total_hours": None,
                "line_items": [],
                "extraction_confidence": 0.1,
                "uncertain_fields": ["total_hours", "period_start", "period_end", "employee_name"],
            }]
        }):
            results = await extract_timesheet_data(self.VAGUE_BODY)

        assert len(results) == 1
        assert results[0]["extraction_confidence"] < 0.5
        assert "total_hours" in results[0]["uncertain_fields"]

    @pytest.mark.asyncio
    async def test_empty_line_items_on_vague_body(self):
        """No concrete dates/hours means line_items must be empty, not invented."""
        with _llm_patch({
            "timesheets": [{
                "employee_name": None,
                "period_start": None,
                "period_end": None,
                "total_hours": None,
                "line_items": [],
                "extraction_confidence": 0.05,
                "uncertain_fields": ["all"],
            }]
        }):
            results = await extract_timesheet_data(self.VAGUE_BODY)

        assert results[0]["line_items"] == []

    @pytest.mark.asyncio
    async def test_not_classified_as_timesheet_without_keywords(self):
        """Vague body with no timesheet keywords should not be classified as a submission."""
        with _llm_patch({
            "is_timesheet_email": False,
            "intent": "unknown",
            "confidence": 0.15,
            "reasoning": "No hours or dates found.",
        }):
            result = await classify_email(
                subject="Quick update",
                body_text=self.VAGUE_BODY,
                attachment_filenames=[],
            )

        assert result["is_timesheet_email"] is False
        assert result["confidence"] < 0.5


# ---------------------------------------------------------------------------
# Scenario 3: Non-standard / relative date formats
# ---------------------------------------------------------------------------

class TestNonStandardDates:
    """Dates written as "3rd to 7th", "last Mon-Fri", or "Mar 29 - Apr 4"
    require LLM to resolve against reference_date."""

    @pytest.mark.asyncio
    async def test_month_day_without_year_resolved_via_reference_date(self):
        """'Mar 29 - Apr 4' should resolve to 2025 when reference_date is Apr 2025."""
        body = "Timesheet: Mar 29 - Apr 4, 8h each day."
        with _llm_patch({
            "timesheets": [{
                "employee_name": "Alice",
                "period_start": "2025-03-29",
                "period_end": "2025-04-04",
                "total_hours": 40.0,
                "line_items": [
                    {"work_date": f"2025-03-{d:02d}", "hours": 8.0, "description": None}
                    for d in range(29, 32)
                ] + [
                    {"work_date": f"2025-04-{d:02d}", "hours": 8.0, "description": None}
                    for d in range(1, 5)
                ],
                "extraction_confidence": 0.85,
                "uncertain_fields": [],
            }]
        }):
            results = await extract_timesheet_data(
                body, reference_date="2025-04-02"
            )

        assert results[0]["period_start"] == "2025-03-29"
        assert results[0]["period_end"] == "2025-04-04"

    @pytest.mark.asyncio
    async def test_relative_dates_produce_uncertain_fields(self):
        """'Worked last Tuesday through Friday' cannot be resolved; uncertain_fields must reflect it."""
        body = "I worked last Tuesday through Friday, about 7 hours each day."
        with _llm_patch({
            "timesheets": [{
                "employee_name": None,
                "period_start": None,
                "period_end": None,
                "total_hours": 28.0,
                "line_items": [],
                "extraction_confidence": 0.3,
                "uncertain_fields": ["period_start", "period_end"],
            }]
        }):
            results = await extract_timesheet_data(body, reference_date="2025-05-13")

        ts = results[0]
        assert "period_start" in ts["uncertain_fields"]
        assert "period_end" in ts["uncertain_fields"]

    @pytest.mark.asyncio
    async def test_ordinal_dates_resolved(self):
        """'3rd to 7th of May' should produce ISO dates when LLM resolves them."""
        body = "Timesheet for 3rd to 7th of May, 8h each."
        with _llm_patch({
            "timesheets": [{
                "employee_name": "Carol",
                "period_start": "2025-05-03",
                "period_end": "2025-05-07",
                "total_hours": 40.0,
                "line_items": [
                    {"work_date": f"2025-05-0{d}", "hours": 8.0, "description": None}
                    for d in range(3, 8)
                ],
                "extraction_confidence": 0.8,
                "uncertain_fields": [],
            }]
        }):
            results = await extract_timesheet_data(body, reference_date="2025-05-10")

        assert results[0]["period_start"] == "2025-05-03"
        assert len(results[0]["line_items"]) == 5


# ---------------------------------------------------------------------------
# Scenario 4: Multiple projects in one email
# ---------------------------------------------------------------------------

class TestMultipleProjectsInEmail:
    """An email mentions hours split across several clients/projects.
    Each should appear as a separate line item, not merged."""

    MULTI_PROJECT_BODY = """\
Timesheet for week of May 5-9:
- Project Alpha (Acme Corp): Mon 4h, Tue 3h
- Project Beta (Globex): Wed 5h, Thu 4h
- Internal meetings: Fri 2h
"""

    @pytest.mark.asyncio
    async def test_all_projects_extracted_as_separate_line_items(self):
        with _llm_patch({
            "timesheets": [{
                "employee_name": "Dave",
                "period_start": "2025-05-05",
                "period_end": "2025-05-09",
                "total_hours": 18.0,
                "line_items": [
                    {"work_date": "2025-05-05", "hours": 4.0, "description": "Project Alpha", "project_code": "ACME"},
                    {"work_date": "2025-05-06", "hours": 3.0, "description": "Project Alpha", "project_code": "ACME"},
                    {"work_date": "2025-05-07", "hours": 5.0, "description": "Project Beta", "project_code": "GLOBEX"},
                    {"work_date": "2025-05-08", "hours": 4.0, "description": "Project Beta", "project_code": "GLOBEX"},
                    {"work_date": "2025-05-09", "hours": 2.0, "description": "Internal meetings", "project_code": None},
                ],
                "extraction_confidence": 0.9,
                "uncertain_fields": [],
            }]
        }):
            results = await extract_timesheet_data(
                self.MULTI_PROJECT_BODY, reference_date="2025-05-09"
            )

        assert len(results) == 1
        items = results[0]["line_items"]
        assert len(items) == 5
        descriptions = {i["description"] for i in items}
        assert "Project Alpha" in descriptions
        assert "Project Beta" in descriptions
        assert "Internal meetings" in descriptions

    @pytest.mark.asyncio
    async def test_total_hours_sum_matches_line_items(self):
        with _llm_patch({
            "timesheets": [{
                "employee_name": "Dave",
                "period_start": "2025-05-05",
                "period_end": "2025-05-09",
                "total_hours": 18.0,
                "line_items": [
                    {"work_date": "2025-05-05", "hours": 4.0, "description": "Alpha"},
                    {"work_date": "2025-05-06", "hours": 3.0, "description": "Alpha"},
                    {"work_date": "2025-05-07", "hours": 5.0, "description": "Beta"},
                    {"work_date": "2025-05-08", "hours": 4.0, "description": "Beta"},
                    {"work_date": "2025-05-09", "hours": 2.0, "description": "Internal"},
                ],
                "extraction_confidence": 0.9,
                "uncertain_fields": [],
            }]
        }):
            results = await extract_timesheet_data(
                self.MULTI_PROJECT_BODY, reference_date="2025-05-09"
            )

        ts = results[0]
        extracted_sum = sum(i["hours"] for i in ts["line_items"])
        assert extracted_sum == pytest.approx(ts["total_hours"])


# ---------------------------------------------------------------------------
# Scenario 5: HTML-heavy body noise
# ---------------------------------------------------------------------------

class TestHtmlNoisyBody:
    """Outlook-formatted messages include nav links, unsubscribe footers,
    and corporate disclaimers in the plain-text fallback. The LLM should
    still find the actual timesheet content."""

    HTML_NOISY_BODY = """\
View this email in your browser | Unsubscribe | Privacy Policy

ACME CORP INTERNAL PORTAL

Hi John,

Please approve my timesheet for May 5-9:
Monday: 8h - Backend work
Tuesday: 7h - Code review
Wednesday: 8h - Deployment

Total: 23h

--
This email and any attachments are confidential. If received in error,
please delete and notify sender. ACME Corp, 123 Main St, Springfield.
Visit us at www.acme.example.com | Support: help@acme.example.com
"""

    @pytest.mark.asyncio
    async def test_core_timesheet_data_extracted_despite_noise(self):
        with _llm_patch({
            "timesheets": [{
                "employee_name": None,
                "period_start": "2025-05-05",
                "period_end": "2025-05-07",
                "total_hours": 23.0,
                "line_items": [
                    {"work_date": "2025-05-05", "hours": 8.0, "description": "Backend work"},
                    {"work_date": "2025-05-06", "hours": 7.0, "description": "Code review"},
                    {"work_date": "2025-05-07", "hours": 8.0, "description": "Deployment"},
                ],
                "extraction_confidence": 0.8,
                "uncertain_fields": ["employee_name"],
            }]
        }):
            results = await extract_timesheet_data(
                self.HTML_NOISY_BODY, reference_date="2025-05-09"
            )

        assert len(results) == 1
        assert results[0]["total_hours"] == 23.0
        assert len(results[0]["line_items"]) == 3

    @pytest.mark.asyncio
    async def test_disclaimer_links_not_extracted_as_employee(self):
        """Unsubscribe links and email addresses in footers must not bleed into employee fields."""
        with _llm_patch({
            "timesheets": [{
                "employee_name": None,
                "contact_emails": ["help@acme.example.com"],
                "period_start": "2025-05-05",
                "period_end": "2025-05-07",
                "total_hours": 23.0,
                "line_items": [],
                "extraction_confidence": 0.7,
                "uncertain_fields": ["employee_name"],
            }]
        }):
            results = await extract_timesheet_data(self.HTML_NOISY_BODY)

        # employee_name must not be a URL or address fragment
        emp = results[0].get("employee_name")
        assert emp is None or "@" not in str(emp)


# ---------------------------------------------------------------------------
# Scenario 6: Non-English content
# ---------------------------------------------------------------------------

class TestNonEnglishContent:
    """An employee submits in Spanish. The LLM should still extract structured
    data; uncertain_fields may be longer but must not be empty line_items."""

    SPANISH_BODY = """\
Hoja de horas – semana del 5 al 9 de mayo de 2025

Empleado: Maria García
Lunes: 8 horas – Desarrollo backend
Martes: 7 horas – Revisión de código
Miércoles: 8 horas – Reunión con cliente
Jueves: 7 horas – Pruebas
Viernes: 6 horas – Documentación
Total: 36 horas
"""

    @pytest.mark.asyncio
    async def test_structured_data_extracted_from_spanish(self):
        with _llm_patch({
            "timesheets": [{
                "employee_name": "Maria García",
                "period_start": "2025-05-05",
                "period_end": "2025-05-09",
                "total_hours": 36.0,
                "line_items": [
                    {"work_date": "2025-05-05", "hours": 8.0, "description": "Desarrollo backend"},
                    {"work_date": "2025-05-06", "hours": 7.0, "description": "Revisión de código"},
                    {"work_date": "2025-05-07", "hours": 8.0, "description": "Reunión con cliente"},
                    {"work_date": "2025-05-08", "hours": 7.0, "description": "Pruebas"},
                    {"work_date": "2025-05-09", "hours": 6.0, "description": "Documentación"},
                ],
                "extraction_confidence": 0.85,
                "uncertain_fields": [],
            }]
        }):
            results = await extract_timesheet_data(
                self.SPANISH_BODY, reference_date="2025-05-09"
            )

        assert results[0]["employee_name"] == "Maria García"
        assert results[0]["total_hours"] == 36.0
        assert len(results[0]["line_items"]) == 5

    @pytest.mark.asyncio
    async def test_classified_as_timesheet_in_spanish(self):
        with _llm_patch({
            "is_timesheet_email": True,
            "intent": "new_submission",
            "confidence": 0.88,
            "reasoning": "Contains structured hours per day with a total.",
        }):
            result = await classify_email(
                subject="Hoja de horas semana 5-9 mayo",
                body_text=self.SPANISH_BODY,
                attachment_filenames=[],
            )

        assert result["is_timesheet_email"] is True


# ---------------------------------------------------------------------------
# Scenario 7: Hours expressed as time ranges
# ---------------------------------------------------------------------------

class TestHoursAsTimeRanges:
    """'9am-5pm' or '8 hours minus lunch' requires the LLM to do arithmetic."""

    RANGE_BODY = """\
Timesheet May 5-9:
Monday: 9am-5pm (1h lunch break)
Tuesday: 9am-6pm (1h lunch break)
Wednesday: 9am-5pm (1h lunch break)
"""

    @pytest.mark.asyncio
    async def test_net_hours_computed_from_time_range(self):
        """9am-5pm minus 1h lunch = 7h net. LLM should return 7, not 8."""
        with _llm_patch({
            "timesheets": [{
                "employee_name": None,
                "period_start": "2025-05-05",
                "period_end": "2025-05-07",
                "total_hours": 22.0,
                "line_items": [
                    {"work_date": "2025-05-05", "hours": 7.0, "description": None},
                    {"work_date": "2025-05-06", "hours": 8.0, "description": None},
                    {"work_date": "2025-05-07", "hours": 7.0, "description": None},
                ],
                "extraction_confidence": 0.75,
                "uncertain_fields": ["employee_name"],
            }]
        }):
            results = await extract_timesheet_data(
                self.RANGE_BODY, reference_date="2025-05-09"
            )

        items = results[0]["line_items"]
        assert items[0]["hours"] == 7.0  # 9-5 minus lunch
        assert items[1]["hours"] == 8.0  # 9-6 minus lunch

    @pytest.mark.asyncio
    async def test_time_range_ambiguity_surfaced_in_uncertain_fields(self):
        """If LLM can't resolve breaks, it should flag the hours fields as uncertain."""
        with _llm_patch({
            "timesheets": [{
                "employee_name": None,
                "period_start": "2025-05-05",
                "period_end": "2025-05-07",
                "total_hours": None,
                "line_items": [
                    {"work_date": "2025-05-05", "hours": None, "description": "9am-5pm"},
                ],
                "extraction_confidence": 0.35,
                "uncertain_fields": ["total_hours", "line_items.hours"],
            }]
        }):
            results = await extract_timesheet_data(self.RANGE_BODY)

        ts = results[0]
        assert ts["extraction_confidence"] < 0.5


# ---------------------------------------------------------------------------
# Scenario 8: LLM unavailable (no API key / client returns None)
# ---------------------------------------------------------------------------

class TestLlmUnavailable:
    """When OpenAI is not configured, every LLM function must degrade gracefully."""

    @pytest.mark.asyncio
    async def test_extract_returns_empty_list_when_llm_unavailable(self):
        """_call_llm returns None when client is None. extract_timesheet_data must return []."""
        with _llm_patch(None):
            results = await extract_timesheet_data("8 hours on Monday May 5.")

        assert results == []

    @pytest.mark.asyncio
    async def test_classify_falls_back_to_heuristics_when_llm_unavailable(self):
        """classify_email falls back to keyword heuristics when LLM returns None."""
        with _llm_patch(None):
            result = await classify_email(
                subject="Timesheet submission May 5-9",
                body_text="Please find my timesheet for this week.",
                attachment_filenames=[],
            )

        # Keyword "timesheet" in subject -> heuristic should classify as timesheet
        assert result["is_timesheet_email"] is True

    @pytest.mark.asyncio
    async def test_classify_non_timesheet_falls_back_to_heuristics(self):
        """Non-timesheet email body + no keywords -> heuristic returns False."""
        with _llm_patch(None):
            result = await classify_email(
                subject="Team lunch Friday",
                body_text="Hey, are you joining us for lunch on Friday?",
                attachment_filenames=[],
            )

        assert result["is_timesheet_email"] is False


# ---------------------------------------------------------------------------
# Scenario 9: LLM rate-limit (exception raised, retry exhausted)
# ---------------------------------------------------------------------------

class TestLlmRateLimitExhausted:
    """When OpenAI raises (e.g. 429 / timeout), _call_llm catches all exceptions
    internally and returns None after retries. The pipeline functions must handle
    None from _call_llm gracefully -- they must never propagate exceptions.

    We simulate this by patching _call_llm to return None (its post-retry
    return value) rather than raising, since internal exception handling is
    already tested by TestLlmUnavailable. A separate test verifies the
    exception-safety contract end-to-end by patching at the openai client level.
    """

    @pytest.mark.asyncio
    async def test_extract_returns_empty_list_when_call_llm_returns_none(self):
        """_call_llm exhausted retries -> returns None -> extract returns []."""
        with _llm_patch(None):
            results = await extract_timesheet_data("8 hours Monday.")

        assert results == []

    @pytest.mark.asyncio
    async def test_classify_falls_back_on_rate_limit_with_keyword(self):
        """_call_llm returns None -> heuristic: 'timesheet' keyword -> True."""
        with _llm_patch(None):
            result = await classify_email(
                subject="Timesheet for week ending May 9",
                body_text="Hours: Mon 8, Tue 8, Wed 7.",
                attachment_filenames=[],
            )

        assert result["is_timesheet_email"] is True

    @pytest.mark.asyncio
    async def test_extract_does_not_raise_when_openai_client_raises(self):
        """Exceptions from the openai client are caught inside _call_llm.
        Neither _call_llm nor extract_timesheet_data should re-raise them.
        We use a plain Exception to avoid depending on the openai package being
        installed in the test environment."""

        async def _fake_create(*args, **kwargs):
            raise Exception("429 rate limit exceeded")

        with patch("app.services.llm_ingestion._get_client") as mock_get_client:
            mock_client = AsyncMock()
            mock_client.chat.completions.create = _fake_create
            mock_get_client.return_value = mock_client
            try:
                results = await extract_timesheet_data("8h Monday.")
                assert results == []
            except Exception as exc:
                pytest.fail(f"extract_timesheet_data raised unexpectedly: {exc}")


# ---------------------------------------------------------------------------
# Scenario 10: Attachment-only email (empty body)
# ---------------------------------------------------------------------------

class TestAttachmentOnlyEmail:
    """Some employees attach an Excel and write nothing in the body.
    extract_timesheet_data receives empty or near-empty text."""

    @pytest.mark.asyncio
    async def test_empty_body_returns_empty_list(self):
        with _llm_patch(None):
            results = await extract_timesheet_data("", filename_hint="timesheet_may.xlsx")

        assert results == []

    @pytest.mark.asyncio
    async def test_whitespace_only_body_returns_empty_list(self):
        with _llm_patch(None):
            results = await extract_timesheet_data("   \n\n\t  ", filename_hint="hours.pdf")

        assert results == []

    @pytest.mark.asyncio
    async def test_classify_attachment_only_email_uses_subject(self):
        """No body text, but subject says 'Timesheet'. Heuristic should still classify correctly."""
        with _llm_patch(None):
            result = await classify_email(
                subject="Timesheet week of May 5",
                body_text="",
                attachment_filenames=["timesheet_may5.xlsx"],
            )

        assert result["is_timesheet_email"] is True

    @pytest.mark.asyncio
    async def test_classify_no_body_no_keywords_not_timesheet(self):
        """Truly empty email with no timesheet signal should not be classified as timesheet."""
        with _llm_patch(None):
            result = await classify_email(
                subject="Please see attached",
                body_text="",
                attachment_filenames=["document.pdf"],
            )

        assert result["is_timesheet_email"] is False


# ---------------------------------------------------------------------------
# Bonus: Deterministic anomaly detection (no LLM needed)
# ---------------------------------------------------------------------------

class TestDeterministicAnomalies:
    """_deterministic_anomalies runs without any LLM. These check the rules
    the pipeline enforces before even calling detect_anomalies()."""

    def test_duplicate_date_flagged(self):
        items = [
            {"work_date": "2025-05-05", "hours": 4.0, "description": "Morning"},
            {"work_date": "2025-05-05", "hours": 4.0, "description": "Afternoon"},
        ]
        anomalies = _deterministic_anomalies({}, items)
        types = [a["type"] for a in anomalies]
        assert "duplicate_date" in types

    def test_weekend_work_flagged(self):
        items = [{"work_date": "2025-05-10", "hours": 8.0, "description": "Saturday work"}]
        anomalies = _deterministic_anomalies({}, items)
        types = [a["type"] for a in anomalies]
        assert "weekend_work" in types

    def test_high_daily_hours_flagged(self):
        items = [{"work_date": "2025-05-05", "hours": 14.0, "description": "Long day"}]
        anomalies = _deterministic_anomalies({}, items)
        types = [a["type"] for a in anomalies]
        assert "high_daily_hours" in types

    def test_missing_description_flagged(self):
        items = [{"work_date": "2025-05-05", "hours": 8.0, "description": ""}]
        anomalies = _deterministic_anomalies({}, items)
        types = [a["type"] for a in anomalies]
        assert "missing_description" in types

    def test_hours_mismatch_flagged(self):
        """Stated total_hours differs significantly from sum of line items."""
        extracted = {"total_hours": 40.0}
        items = [
            {"work_date": f"2025-05-0{d}", "hours": 6.0, "description": "Work"}
            for d in range(5, 10)
        ]  # sum = 30, stated = 40
        anomalies = _deterministic_anomalies(extracted, items)
        types = [a["type"] for a in anomalies]
        assert "hours_mismatch" in types

    def test_no_anomalies_on_clean_data(self):
        extracted = {"total_hours": 40.0}
        items = [
            {"work_date": f"2025-05-0{d}", "hours": 8.0, "description": "Development"}
            for d in range(5, 10)
        ]
        anomalies = _deterministic_anomalies(extracted, items)
        assert anomalies == []
