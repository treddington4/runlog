"""Synthetic demo-account data generator (Phase 11.2). Not a refactor of any existing
seeder — models.py's `_seed_*` functions seed the *real* default user's actual real
gear/goal and must never be reused or touched here. Everything this module writes is
fabricated, pure-Python, and has zero external I/O (no Strava/Garmin/weather calls),
so `demo.create_demo_session()` can call it synchronously without a noticeable delay.

Deliberately does not seed RouteHex spatial data — Phase 7 (geospatial pipeline)
doesn't exist in this codebase yet, so there's no real table to populate.
"""
import random
import uuid
from datetime import datetime, timedelta, timezone

from .models import Run, DailySteps, Goal, ChatMessage

WEATHER_CONDITIONS = ["Clear", "Partly Cloudy", "Cloudy", "Light Rain", "Overcast"]

# (run_type, distance_mi range, pace_sec_per_mi range, avg_hr range)
RUN_PROFILES = {
    "Easy": ((3.0, 6.0), (565, 630), (135, 152)),
    "Tempo": ((4.0, 6.5), (480, 525), (158, 170)),
    "Interval": ((3.5, 5.5), (490, 545), (160, 178)),
    "Long Run": ((8.0, 13.5), (585, 645), (140, 158)),
}

SEED_CHAT_THREAD = [
    ("user", "How's my training looking lately?"),
    ("assistant", "Good rhythm overall — you've been consistent with 3-4 runs a week "
                  "and mixing in some faster work alongside the easy mileage. Keep "
                  "building on that base."),
    ("user", "Any tips for my next long run?"),
    ("assistant", "Keep it conversational pace for most of it, and don't be afraid to "
                  "walk through aid stations if this is race prep — the goal is time "
                  "on feet, not speed."),
]


def _iso_date(d) -> str:
    return d.strftime("%Y-%m-%d")


def seed_demo_user(db, user_id: str) -> None:
    now = datetime.now(timezone.utc)
    today = now.date()

    # ~90 days of daily step counts.
    for i in range(90):
        d = today - timedelta(days=i)
        db.add(DailySteps(
            date=_iso_date(d),
            user_id=user_id,
            steps=random.randint(4000, 13000),
        ))

    # ~50-60 runs over the trailing ~120 days, 3-4x/week, rotating through easy/
    # tempo/interval/long — a plausible-looking training block, not statistically
    # rigorous.
    run_day_offsets = sorted(random.sample(range(120), k=random.randint(48, 58)), reverse=True)
    for idx, offset in enumerate(run_day_offsets):
        run_date = today - timedelta(days=offset)
        if idx % 10 == 9:
            run_type = "Long Run"
        elif idx % 4 == 3:
            run_type = "Tempo"
        elif idx % 7 == 6:
            run_type = "Interval"
        else:
            run_type = "Easy"

        (dist_lo, dist_hi), (pace_lo, pace_hi), (hr_lo, hr_hi) = RUN_PROFILES[run_type]
        distance_mi = round(random.uniform(dist_lo, dist_hi), 2)
        pace_sec_per_mi = random.randint(pace_lo, pace_hi)
        moving_time_sec = int(distance_mi * pace_sec_per_mi)
        start_hour = random.choice([6, 7, 8, 17, 18])
        start_time = f"{start_hour:02d}:{random.randint(0, 59):02d}"

        db.add(Run(
            id=f"demo_{uuid.uuid4().hex[:16]}",
            user_id=user_id,
            source="strava",
            activity_type="Run",
            date=_iso_date(run_date),
            start_time=start_time,
            name=f"{run_type} Run",
            distance_mi=distance_mi,
            moving_time_sec=moving_time_sec,
            elev_gain_ft=round(random.uniform(20, 300), 1),
            avg_hr=random.randint(hr_lo, hr_hi),
            max_hr=random.randint(hr_hi, hr_hi + 20),
            avg_cadence=round(random.uniform(164, 180), 1),
            avg_pace_sec_per_mi=float(pace_sec_per_mi),
            is_treadmill=False,
            temp_f=round(random.uniform(45, 82), 1),
            weather_condition=random.choice(WEATHER_CONDITIONS),
            suggested_type=run_type,
            detail_synced_at=now.isoformat(),
        ))

    # One active race goal, a couple months out.
    db.add(Goal(
        id=f"demo_goal_{uuid.uuid4().hex[:12]}",
        user_id=user_id,
        goal_type="race",
        name="Fall Half Marathon",
        status="active",
        activity_types_json='["Run"]',
        target_value=13.1,
        target_unit="miles",
        target_date=_iso_date(today + timedelta(days=63)),
        created_at=now.isoformat(),
    ))

    # A short pre-seeded chat thread so the Chat tab isn't empty on first login.
    for role, content in SEED_CHAT_THREAD:
        db.add(ChatMessage(user_id=user_id, role=role, content=content, created_at=now.isoformat()))

    db.commit()
