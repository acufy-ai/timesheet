"""Unit tests for the five-tier project-health classifier.

Covers _classify_health (pure-computed tier from budget/schedule/margin + the
blocked-task signal) and _apply_health_override (manual override overlay). These
are pure functions, so no DB is needed.

Tiers (severity worst->best): critical -> blocked -> at-risk -> not-set ->
(excellent | on-track). Default thresholds: over_budget 100, high_burn 80,
excellent_under 50, ending_soon 7 days, overdue 30 days.
"""
from datetime import date

from app.api.dashboard import (
    HealthConfig,
    MANUAL_HEALTH_VALUES,
    _apply_health_override,
    _classify_health,
)

# A budget + end date so 'not-set' never triggers unless we want it.
BUDGET = 100_000
END = date(2030, 1, 1)


def _health(budget_pct=None, days=None, *, budget=BUDGET, end=END,
            cfg=None, margin=None, blocked=False):
    return _classify_health(
        budget_pct, days, budget, end, cfg=cfg, margin_pct=margin,
        has_blocked_task=blocked,
    )[0]


def test_critical_over_budget():
    assert _health(budget_pct=120, days=200) == "critical"


def test_critical_long_overdue():
    # 40 days overdue (> overdue_days 30).
    assert _health(budget_pct=10, days=-40) == "critical"


def test_blocked_when_has_blocked_task():
    # Healthy numbers, but a blocked task -> blocked.
    assert _health(budget_pct=10, days=200, blocked=True) == "blocked"


def test_critical_beats_blocked():
    # Over budget AND a blocked task -> critical (checked first).
    assert _health(budget_pct=130, days=200, blocked=True) == "critical"


def test_at_risk_high_burn():
    assert _health(budget_pct=85, days=200) == "at-risk"


def test_at_risk_close_to_end():
    assert _health(budget_pct=10, days=3) == "at-risk"


def test_at_risk_low_margin_when_enabled():
    cfg = HealthConfig(margin_enabled=True, low_margin_pct=15)
    assert _health(budget_pct=10, days=200, cfg=cfg, margin=8) == "at-risk"


def test_not_set_when_no_budget_and_no_end():
    assert _health(budget_pct=None, days=None, budget=None, end=None) == "not-set"


def test_excellent_low_burn_far_from_end():
    # 30% burn (< excellent_under 50) and far from the end date.
    assert _health(budget_pct=30, days=200) == "excellent"


def test_on_track_mid_burn_far_from_end():
    # 60% burn (>= excellent_under 50, < high_burn 80) -> on-track, not excellent.
    assert _health(budget_pct=60, days=200) == "on-track"


def test_excellent_boundary_is_exclusive():
    # Exactly at excellent_under_pct (50) is NOT excellent (check is `< 50`).
    assert _health(budget_pct=50, days=200) == "on-track"
    assert _health(budget_pct=49, days=200) == "excellent"


def test_excellent_requires_schedule_comfort():
    # Low burn but only 5 days to end (<= ending_soon 7) -> at-risk wins first;
    # and even just past it, not excellent.
    assert _health(budget_pct=10, days=5) == "at-risk"
    # 8 days out (> ending_soon) + low burn -> excellent.
    assert _health(budget_pct=10, days=8) == "excellent"


def test_override_wins_over_computed():
    computed = _classify_health(130, 200, BUDGET, END)  # critical
    health, reason = _apply_health_override(computed, "on-track")
    assert health == "on-track"
    assert reason.startswith("Manually set to On track")
    assert "Auto:" in reason  # auto value is never hidden


def test_override_none_keeps_computed():
    computed = _classify_health(130, 200, BUDGET, END)  # critical
    assert _apply_health_override(computed, None)[0] == "critical"


def test_override_ignores_invalid_value():
    computed = _classify_health(10, 200, BUDGET, END)  # excellent
    # 'blocked'/'not-set' aren't settable; an unknown value is ignored.
    assert _apply_health_override(computed, "blocked")[0] == "excellent"
    assert _apply_health_override(computed, "garbage")[0] == "excellent"


def test_manual_set_is_the_four_pickable_tiers():
    assert MANUAL_HEALTH_VALUES == {"excellent", "on-track", "at-risk", "critical"}
