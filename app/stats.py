"""Shared computation core for the dashboard summary and the chat assistant's tools.
Both read from this module so a dashboard number and the assistant's answer to the
same question are always backed by identical logic — see CLAUDE.md's note on GAP
being computed once in util.py and again in app.js (kept in sync by hand) for why a
second drifting implementation of the same numbers is worth avoiding here.

Note: like GET /api/runs, these functions query the raw `runs` table directly and do
not apply app.js's client-side mergeDuplicateRuns() dedup — the ~3 known same-physical-
run Strava+Garmin duplicate pairs (see STATUS.md) are counted once per source here, so
aggregate totals may be marginally inflated versus what the merged UI shows. Same scope
boundary as the existing /api/runs endpoint, not a new gap introduced by this module.
"""
import json
from datetime import datetime, timedelta

from models import Run, DailySteps, DEFAULT_USER_ID, owned_by, get_sync_meta

PACE_MIN_SEC_PER_MI = 240
PACE_MAX_SEC_PER_MI = 2400
MIN_DISTANCE_MI = 0.1
ABSOLUTE_HR_MIN = 20
DEFAULT_HR_FLOOR = 30


def is_plausible_pace(pace_sec_per_mi, distance_mi=None) -> bool:
    """Port of app.js's isPlausiblePace — a distance-sensor glitch (e.g. near-zero
    distance over real elapsed time) produces a nonsense pace when divided out."""
    if pace_sec_per_mi is None:
        return False
    if distance_mi is not None and distance_mi < MIN_DISTANCE_MI:
        return False
    return PACE_MIN_SEC_PER_MI <= pace_sec_per_mi <= PACE_MAX_SEC_PER_MI


def get_hr_floor(db, user_id: str = DEFAULT_USER_ID) -> float:
    """Port of app.js's computeHRFloor — prefers a real measured resting HR from
    Garmin (restingHR - 10%), falls back to a Strava-history-derived proxy (5th
    percentile of valid avgHR readings, minus 10%) when that's not synced yet.
    NOTE: garmin_resting_hr_bpm in sync_meta is still a single global value, not
    per-user (sync_meta wasn't retrofitted with user_id in this pass) — a known,
    accepted gap until real multi-user resting-HR tracking is needed."""
    resting = get_sync_meta("garmin_resting_hr_bpm")
    if resting:
        return round(float(resting) * 0.9)

    valid_hrs = sorted(
        hr for (hr,) in db.query(Run.avg_hr)
        .filter(Run.activity_type == "Run", Run.avg_hr.isnot(None), Run.avg_hr >= ABSOLUTE_HR_MIN)
        .filter(owned_by(Run.user_id, user_id))
        .all()
    )
    if not valid_hrs:
        return DEFAULT_HR_FLOOR
    p5 = valid_hrs[int(len(valid_hrs) * 0.05)]
    return round(p5 * 0.9)


def is_plausible_hr(bpm, hr_floor) -> bool:
    return bpm is not None and bpm >= hr_floor


def _all_runs(db, activity_type="Run", user_id: str = DEFAULT_USER_ID):
    """activity_type accepts a single type ("Run", the default — every existing caller
    passes a plain string and is unaffected), a list (e.g. ["Run","Ride"] for a duathlon
    goal spanning multiple activity types), or None/falsy for all types."""
    q = db.query(Run).filter(owned_by(Run.user_id, user_id))
    if activity_type:
        types = [activity_type] if isinstance(activity_type, str) else list(activity_type)
        q = q.filter(Run.activity_type.in_(types))
    return q.all()


def _week_start(d):
    return d - timedelta(days=d.weekday())  # Monday


def weekly_mileage(db, weeks: int = 12, activity_type: str = "Run", user_id: str = DEFAULT_USER_ID):
    today = datetime.now().date()
    this_week_start = _week_start(today)
    earliest = this_week_start - timedelta(weeks=weeks - 1)
    runs = [
        r for r in _all_runs(db, activity_type, user_id)
        if r.date and earliest.isoformat() <= r.date <= today.isoformat()
    ]
    buckets = {}
    for r in runs:
        wk = _week_start(datetime.strptime(r.date, "%Y-%m-%d").date())
        b = buckets.setdefault(wk, {"totalMiles": 0.0, "runCount": 0})
        b["totalMiles"] += r.distance_mi or 0
        b["runCount"] += 1
    out = []
    for i in range(weeks):
        wk = earliest + timedelta(weeks=i)
        b = buckets.get(wk, {"totalMiles": 0.0, "runCount": 0})
        out.append({"weekStart": wk.isoformat(), "totalMiles": round(b["totalMiles"], 2), "runCount": b["runCount"]})
    return out


def monthly_mileage(db, months: int = 12, activity_type: str = "Run", user_id: str = DEFAULT_USER_ID):
    today = datetime.now().date()
    months_list = []
    y, m = today.year, today.month
    for _ in range(months):
        months_list.append((y, m))
        m -= 1
        if m == 0:
            m, y = 12, y - 1
    months_list.reverse()
    runs = _all_runs(db, activity_type, user_id)
    buckets = {ym: {"totalMiles": 0.0, "runCount": 0} for ym in months_list}
    for r in runs:
        if not r.date:
            continue
        ym = (int(r.date[:4]), int(r.date[5:7]))
        if ym in buckets:
            buckets[ym]["totalMiles"] += r.distance_mi or 0
            buckets[ym]["runCount"] += 1
    return [
        {"month": f"{y:04d}-{m:02d}", "totalMiles": round(buckets[(y, m)]["totalMiles"], 2), "runCount": buckets[(y, m)]["runCount"]}
        for (y, m) in months_list
    ]


def personal_records(db, activity_type: str = "Run", user_id: str = DEFAULT_USER_ID):
    runs = _all_runs(db, activity_type, user_id)

    def pick(candidates, key):
        best = max(candidates, key=key, default=None)
        if best is None:
            return None
        return {"runId": best.id, "date": best.date, "name": best.name, "value": key(best)}

    longest_run = pick([r for r in runs if r.distance_mi], lambda r: r.distance_mi)
    most_elevation = pick([r for r in runs if r.elev_gain_ft], lambda r: r.elev_gain_ft)
    longest_duration = pick([r for r in runs if r.moving_time_sec], lambda r: r.moving_time_sec)

    plausible_pace_runs = [r for r in runs if is_plausible_pace(r.avg_pace_sec_per_mi, r.distance_mi)]
    fastest = min(plausible_pace_runs, key=lambda r: r.avg_pace_sec_per_mi, default=None)
    fastest_pace = None
    if fastest:
        fastest_pace = {"runId": fastest.id, "date": fastest.date, "name": fastest.name, "value": fastest.avg_pace_sec_per_mi}

    return {
        "longestRun": longest_run,
        "fastestPace": fastest_pace,
        "mostElevation": most_elevation,
        "longestDuration": longest_duration,
    }


def rolling_pace_trend(db, days: int = 90, window_days: int = 7, user_id: str = DEFAULT_USER_ID):
    """Port of app.js's rollingPaceData — for each run in the trailing `days`, a
    distance-weighted average pace over the `window_days` ending on that run's date,
    looking back across ALL running history (not just the `days` window) so early
    points in a narrow window aren't computed from an artificially thin lookback."""
    today = datetime.now().date()
    cutoff = (today - timedelta(days=days)).isoformat()

    all_history = [
        r for r in _all_runs(db, "Run", user_id)
        if r.date and is_plausible_pace(r.avg_pace_sec_per_mi, r.distance_mi)
    ]
    recent = [r for r in all_history if r.date >= cutoff]

    out = []
    for r in recent:
        end = datetime.strptime(r.date, "%Y-%m-%d").date()
        start = end - timedelta(days=window_days - 1)
        window_runs = [
            rr for rr in all_history
            if start.isoformat() <= rr.date <= end.isoformat()
        ]
        total_dist = sum(rr.distance_mi or 0 for rr in window_runs)
        if not total_dist:
            continue
        pace = sum((rr.avg_pace_sec_per_mi or 0) * (rr.distance_mi or 0) for rr in window_runs) / total_dist
        out.append({"date": r.date, "paceSecPerMi": round(pace, 1)})
    out.sort(key=lambda p: p["date"])
    return out


def training_load_trend(db, weeks: int = 8, user_id: str = DEFAULT_USER_ID):
    """Trailing 4 weeks vs. prior 4 weeks total mileage, using rolling 28-day windows
    (not calendar-week buckets) so the current in-progress week doesn't bias the
    comparison. Deliberately mileage-based, not an invented HR-based load score
    presented as a real physiological measurement."""
    today = datetime.now().date()
    last28_start = (today - timedelta(days=27)).isoformat()
    prior28_start = (today - timedelta(days=55)).isoformat()
    prior28_end = (today - timedelta(days=28)).isoformat()

    runs = _all_runs(db, "Run", user_id)
    last28 = sum(r.distance_mi or 0 for r in runs if r.date and last28_start <= r.date <= today.isoformat())
    prior28 = sum(r.distance_mi or 0 for r in runs if r.date and prior28_start <= r.date <= prior28_end)

    pct_change = None
    if prior28 > 0:
        pct_change = round((last28 - prior28) / prior28 * 100, 1)
    direction = "steady"
    if pct_change is not None:
        direction = "up" if pct_change > 5 else ("down" if pct_change < -5 else "steady")

    return {
        "last28DaysMiles": round(last28, 2),
        "prior28DaysMiles": round(prior28, 2),
        "pctChange": pct_change,
        "direction": direction,
    }


def weekly_consistency_streak(db, min_miles: float = 1.0, min_runs: int = None,
                               activity_type="Run", user_id: str = DEFAULT_USER_ID):
    """Consecutive Mon-Sun weeks, walking backward from the current (possibly
    in-progress) week, meeting a threshold. If min_runs is given (e.g. a "3x/week"
    consistency goal), a week must have that many runs; otherwise it must meet
    min_miles. Stops at the first week below threshold or at the earliest run on
    record."""
    today = datetime.now().date()
    runs = _all_runs(db, activity_type, user_id)
    if not runs:
        return {"streakWeeks": 0, "minMiles": min_miles, "minRuns": min_runs}
    earliest_date = min(r.date for r in runs if r.date)

    buckets = {}
    for r in runs:
        if not r.date:
            continue
        wk = _week_start(datetime.strptime(r.date, "%Y-%m-%d").date())
        b = buckets.setdefault(wk, {"totalMiles": 0.0, "runCount": 0})
        b["totalMiles"] += r.distance_mi or 0
        b["runCount"] += 1

    def meets(b):
        if min_runs is not None:
            return b["runCount"] >= min_runs
        return b["totalMiles"] >= min_miles

    streak = 0
    wk = _week_start(today)
    empty_bucket = {"totalMiles": 0.0, "runCount": 0}
    while wk.isoformat() >= earliest_date:
        if meets(buckets.get(wk, empty_bucket)):
            streak += 1
            wk -= timedelta(weeks=1)
        else:
            break
    return {"streakWeeks": streak, "minMiles": min_miles, "minRuns": min_runs}


def days_since_longest_run(db, user_id: str = DEFAULT_USER_ID):
    pr = personal_records(db, user_id=user_id)
    longest = pr["longestRun"]
    if not longest:
        return None
    days = (datetime.now().date() - datetime.strptime(longest["date"], "%Y-%m-%d").date()).days
    return {"days": days, "date": longest["date"], "distanceMi": longest["value"], "runId": longest["runId"]}


def days_since_last_run(db, activity_type: str = "Run", user_id: str = DEFAULT_USER_ID):
    runs = [r for r in _all_runs(db, activity_type, user_id) if r.date]
    if not runs:
        return None
    latest = max(runs, key=lambda r: r.date)
    days = (datetime.now().date() - datetime.strptime(latest.date, "%Y-%m-%d").date()).days
    return {"days": days, "date": latest.date, "runId": latest.id, "name": latest.name}


def run_summary(db, start_date=None, end_date=None, activity_type="Run", user_id: str = DEFAULT_USER_ID):
    runs = _all_runs(db, activity_type, user_id)
    if start_date:
        runs = [r for r in runs if r.date and r.date >= start_date]
    if end_date:
        runs = [r for r in runs if r.date and r.date <= end_date]

    total_dist = sum(r.distance_mi or 0 for r in runs)
    plausible = [r for r in runs if is_plausible_pace(r.avg_pace_sec_per_mi, r.distance_mi)]
    avg_pace = None
    if total_dist and plausible:
        weighted = sum((r.avg_pace_sec_per_mi or 0) * (r.distance_mi or 0) for r in plausible)
        plausible_dist = sum(r.distance_mi or 0 for r in plausible)
        avg_pace = round(weighted / plausible_dist, 1) if plausible_dist else None

    return {
        "runCount": len(runs),
        "totalDistanceMi": round(total_dist, 2),
        "avgPaceSecPerMi": avg_pace,
        "totalElevGainFt": round(sum(r.elev_gain_ft or 0 for r in runs), 1),
        "totalMovingTimeSec": sum(r.moving_time_sec or 0 for r in runs),
    }


def query_runs(db, start_date=None, end_date=None, activity_type=None,
                min_distance=None, max_distance=None, sort_by="date", limit=20,
                user_id: str = DEFAULT_USER_ID):
    """General-purpose flexible lookup backing free-form chat questions the canned
    aggregates above don't cover (e.g. "runs over 10 miles this year")."""
    hr_floor = get_hr_floor(db, user_id)
    runs = _all_runs(db, activity_type, user_id)
    if start_date:
        runs = [r for r in runs if r.date and r.date >= start_date]
    if end_date:
        runs = [r for r in runs if r.date and r.date <= end_date]
    if min_distance is not None:
        runs = [r for r in runs if (r.distance_mi or 0) >= min_distance]
    if max_distance is not None:
        runs = [r for r in runs if (r.distance_mi or 0) <= max_distance]

    reverse = sort_by in ("date", "distance_mi", "elev_gain_ft")
    key_fn = {
        "date": lambda r: r.date or "",
        "distance_mi": lambda r: r.distance_mi or 0,
        "elev_gain_ft": lambda r: r.elev_gain_ft or 0,
        "pace": lambda r: r.avg_pace_sec_per_mi or 9999999,
    }.get(sort_by, lambda r: r.date or "")
    runs = sorted(runs, key=key_fn, reverse=reverse)[:limit]

    return [{
        "id": r.id, "date": r.date, "name": r.name, "activityType": r.activity_type,
        "distanceMi": r.distance_mi,
        "paceSecPerMi": r.avg_pace_sec_per_mi if is_plausible_pace(r.avg_pace_sec_per_mi, r.distance_mi) else None,
        "elevGainFt": r.elev_gain_ft,
        "avgHR": r.avg_hr if is_plausible_hr(r.avg_hr, hr_floor) else None,
        "type": r.type_override or r.suggested_type,
    } for r in runs]


def daily_steps_summary(db, days: int = 30, user_id: str = DEFAULT_USER_ID):
    cutoff = (datetime.now().date() - timedelta(days=days)).isoformat()
    rows = (db.query(DailySteps).filter(DailySteps.date >= cutoff)
            .filter(owned_by(DailySteps.user_id, user_id)).order_by(DailySteps.date).all())
    steps = [r.steps for r in rows if r.steps is not None]
    return {
        "days": [{"date": r.date, "steps": r.steps} for r in rows],
        "avgSteps": round(sum(steps) / len(steps)) if steps else None,
    }


def goal_progress(db, goal, user_id: str = DEFAULT_USER_ID):
    """Dispatches to the right progress calculation for a Goal row. Deliberately no
    invented "on track" verdict for race goals — just a countdown plus real recent
    training volume, so this never presents a fabricated judgment as fact."""
    types = json.loads(goal.activity_types_json or '["Run"]')
    if goal.goal_type == "race":
        return _race_goal_progress(db, goal, types, user_id)
    if goal.goal_type == "consistency":
        return _consistency_goal_progress(db, goal, types, user_id)
    if goal.goal_type == "distance_target":
        return _distance_target_progress(db, goal, types, user_id)
    return {"error": f"unknown goal_type: {goal.goal_type}"}


def _race_goal_progress(db, goal, types, user_id):
    today = datetime.now().date()
    days_until = None
    if goal.target_date:
        days_until = (datetime.strptime(goal.target_date, "%Y-%m-%d").date() - today).days
    recent = run_summary(db, start_date=(today - timedelta(days=27)).isoformat(),
                          end_date=today.isoformat(), activity_type=types, user_id=user_id)
    return {
        "goalType": "race", "raceDate": goal.target_date, "daysUntil": days_until,
        "targetDistanceMi": goal.target_value,
        "recent28DayMiles": recent["totalDistanceMi"], "recent28DayRunCount": recent["runCount"],
    }


def _consistency_goal_progress(db, goal, types, user_id):
    if goal.target_unit == "runs_per_week":
        streak = weekly_consistency_streak(db, min_runs=int(goal.target_value), activity_type=types, user_id=user_id)
    else:
        streak = weekly_consistency_streak(db, min_miles=goal.target_value, activity_type=types, user_id=user_id)
    wk = weekly_mileage(db, weeks=1, activity_type=types, user_id=user_id)[0]
    return {
        "goalType": "consistency", "targetValue": goal.target_value, "targetUnit": goal.target_unit,
        "streakWeeks": streak["streakWeeks"],
        "currentWeekMiles": wk["totalMiles"], "currentWeekRunCount": wk["runCount"],
    }


def _distance_target_progress(db, goal, types, user_id):
    start = goal.start_date or (goal.created_at or "")[:10]
    summary = run_summary(db, start_date=start, end_date=goal.target_date, activity_type=types, user_id=user_id)
    pct = round(summary["totalDistanceMi"] / goal.target_value * 100, 1) if goal.target_value else None
    days_remaining = None
    if goal.target_date:
        days_remaining = (datetime.strptime(goal.target_date, "%Y-%m-%d").date() - datetime.now().date()).days
    return {
        "goalType": "distance_target", "targetMi": goal.target_value,
        "completedMi": summary["totalDistanceMi"], "pctComplete": pct,
        "startDate": start, "deadline": goal.target_date, "daysRemaining": days_remaining,
    }
