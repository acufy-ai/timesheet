"""Per-day month-natural split for ingestion line items.

A multi-week timesheet pill (e.g. Mar 29 - Apr 4) spans two calendar months.
Each weekday must keep its natural date so that on approval each line item
becomes a TimeEntry on the correct calendar day, and Approved Timesheets
aggregates by month without anything being clamped to a single "dominant"
month.

The contract these tests pin:
1. _normalize_line_items preserves cross-month rows verbatim (no clamping).
2. _resolve_total_hours sums every retained row, regardless of month.
"""
from __future__ import annotations

from app.services.ingestion_pipeline import (
    _normalize_line_items,
    _resolve_total_hours,
)


def _item(date: str, hours: float = 8) -> dict:
    return {"work_date": date, "hours": hours}


def test_bridge_week_keeps_both_months():
    # Mar 29 (Sun) - Apr 4 (Sat) 2026. Sunday and Saturday are off,
    # weekdays are: Mon Mar 30, Tue Mar 31, Wed Apr 1, Thu Apr 2, Fri Apr 3.
    items = [
        _item("2026-03-30"),
        _item("2026-03-31"),
        _item("2026-04-01"),
        _item("2026-04-02"),
        _item("2026-04-03"),
    ]
    result = _normalize_line_items(items, "2026-03-29", "2026-04-04")
    dates = [r["work_date"] for r in result]
    # All five weekdays survive, sorted.
    assert dates == [
        "2026-03-30",
        "2026-03-31",
        "2026-04-01",
        "2026-04-02",
        "2026-04-03",
    ]
    # Total is 40h, even though the rows fall across two months.
    total = _resolve_total_hours({}, result)
    assert total is not None
    assert float(total) == 40.0


def test_three_month_span_kept_verbatim():
    # Feb 28 leak + 20 March days + 3 April days. None are dropped now.
    items = (
        [_item("2026-02-28")]
        + [_item(f"2026-03-{d:02d}") for d in range(2, 22)]
        + [_item("2026-04-01"), _item("2026-04-02"), _item("2026-04-03")]
    )
    result = _normalize_line_items(items, "2026-02-28", "2026-04-03")
    # 1 Feb + 20 March + 3 April = 24 rows preserved.
    assert len(result) == 24
    months = sorted({r["work_date"][:7] for r in result})
    assert months == ["2026-02", "2026-03", "2026-04"]


def test_period_tolerance_still_drops_far_outliers():
    # Tolerance guard is unchanged: rows more than 7 days outside the
    # stated period get dropped, so genuine extraction noise still goes
    # away. Bridge-month days stay because they're within tolerance.
    items = [
        _item("2026-01-15"),  # >7 days before period_start → dropped
        _item("2026-03-30"),  # in period
        _item("2026-04-01"),  # spills 0 days past period_end → kept
        _item("2026-05-20"),  # >7 days after period_end → dropped
    ]
    result = _normalize_line_items(items, "2026-03-29", "2026-04-04")
    dates = [r["work_date"] for r in result]
    assert dates == ["2026-03-30", "2026-04-01"]


def test_total_hours_sums_across_months():
    # If the LLM omitted total_hours and only line_items are present,
    # _resolve_total_hours adds them all up. With the clamp gone, the
    # cross-month rows are included in the sum.
    items = [
        _item("2026-03-30", 8),
        _item("2026-03-31", 8),
        _item("2026-04-01", 8),
        _item("2026-04-02", 8),
        _item("2026-04-03", 8),
    ]
    extracted = {}
    total = _resolve_total_hours(extracted, items)
    assert total is not None
    assert float(total) == 40.0
