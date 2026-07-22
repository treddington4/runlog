"""Phase 4.3 — deterministic, no-LLM workout generator. Two independent paths per
(user, date), both gated by one shared stats.readiness() result:

- Endurance: goal-driven periodization (phase from a race goal's date, weekly mileage
  ramp capped by phase, readiness-gated intensity downgrade, a distribution audit,
  two-a-days in build/peak).
- Strength (Phase 4.4 follow-on): a small hardcoded exercise-rotation template,
  readiness-gated, with double-progression state in ExerciseProgress.

Both paths are idempotent per (user, date): each only ever creates/updates its own
`source="generator"` Workout rows, never touching a "coach" (manual/chat-scheduled)
or "garmin" (adaptive-plan) row for the same date — mirrors coach.py's
sync_garmin_suggested_workouts, the one existing precedent for exactly this kind of
per-source-per-date upsert.

Known v1 approximations, called out explicitly rather than silently:
- `WeeklyPlan.target_tss`/`actual_tss` store a mileage-based proxy, not a real
  Training Stress Score (Phase 6.1's per-activity TSS hasn't shipped yet) — same
  "real number now, real thing later" tradeoff stats.readiness()'s acuteChronicRatio
  already makes.
- The distribution audit approximates "time-in-zone" with a coarse hard/easy day-type
  ratio (tempo/interval count as hard) over the trailing 7 days, not true per-second
  HR-zone time (this app doesn't store zone-time breakdowns at sync time).
- The strength exercise template is a small, hardcoded 2-day A/B full-body rotation
  (see STRENGTH_TEMPLATES) — not a real exercise-library/selection system.
"""
import json
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import or_

from models import (
    SessionLocal, Workout, Goal, User, UserTrainingConfig, HealthNote,
    Run, WeeklyPlan, DEFAULT_USER_ID, owned_by,
)
import stats
import coach
from util import local_today

log = logging.getLogger("runlog")

GENERATOR_SOURCE = "generator"

# ---------- Shared helpers ----------


def _week_start(d):
    return d - timedelta(days=d.weekday())  # Monday


def _get_training_config(db, user_id) -> UserTrainingConfig:
    config = db.get(UserTrainingConfig, user_id)
    return config or UserTrainingConfig(
        user_id=user_id, weekly_ramp_pct=3.0, mesocycle_pattern="3:1", distribution="pyramidal",
        strength_days_per_week=2, strength_template="full_body_ab",
    )


def _has_severe_health_note(db, user_id) -> bool:
    return (
        db.query(HealthNote)
        .filter(HealthNote.status.in_(("active", "monitoring")), HealthNote.suspected_severity == "severe",
                owned_by(HealthNote.user_id, user_id))
        .first()
        is not None
    )


def _existing_generator_workout(db, user_id, date_str, domain: str):
    """`domain` disambiguates which of this module's (up to 3) rows for a single
    date this is — "endurance" (primary session), "endurance_second" (the two-a-day
    slot, identified by scheduled_time being set — strength never sets it), or
    "strength". Without this, the endurance and strength paths would collide on the
    same "first generator row for this date" slot and overwrite each other (a real
    bug caught during verification, not theoretical)."""
    q = db.query(Workout).filter(
        Workout.scheduled_date == date_str, Workout.source == GENERATOR_SOURCE, owned_by(Workout.user_id, user_id),
    )
    if domain == "endurance_second":
        q = q.filter(Workout.scheduled_time.isnot(None))
    elif domain == "strength":
        q = q.filter(Workout.scheduled_time.is_(None), Workout.workout_type == "strength")
    else:
        q = q.filter(Workout.scheduled_time.is_(None), Workout.workout_type != "strength")
    return q.first()


def _upsert_generator_workout(db, user_id, date_str, domain: str, **fields) -> dict:
    """Idempotent per (user, date, domain): a `planned` row from a prior run of this
    same date is recomputed/overwritten in place (rerunning the generator for an
    already-generated day is a no-op-if-nothing-changed, not a duplicate); a row
    that's since been completed/skipped is left alone entirely — history is
    immutable, matching sync_garmin_suggested_workouts' own rule."""
    existing = _existing_generator_workout(db, user_id, date_str, domain)
    if existing and existing.status != "planned":
        return coach._workout_to_dict(existing)
    if existing:
        return coach.update_workout(db, existing.id, user_id=user_id, **fields)
    return coach.create_workout(db, date_str, user_id=user_id, source=GENERATOR_SOURCE, **fields)


# ---------- Endurance path ----------

PHASE_CEILING_MULTIPLIER = {"base": 1.15, "build": 1.30, "peak": 1.10, "taper": 0.70}
MESOCYCLE_LENGTHS = {"3:1": 4, "2:1": 3, "4:1": 5}
_EPOCH_MONDAY = datetime(2020, 1, 6).date()  # any fixed Monday — used only to derive a stable week index

# 1-flag readiness downgrade ladder: interval -> tempo -> easy (stands in for "Z2",
# there's no distinct Zone-2 workout_type) -> "recovery" (also `easy`, shorter/lighter,
# distinguished only by a note — VALID_WORKOUT_TYPES has no separate recovery value).
DOWNGRADE_LADDER = ["interval", "tempo", "easy", "easy"]

# Very simple fixed weekly skeleton (Monday=0..Sunday=6) — "what would today be,
# absent any readiness gating." Real periodization systems vary this by phase; this
# is a deliberately small v1 template, not a full training-plan generator.
WEEKDAY_SKELETON = {0: "easy", 1: "quality", 2: "easy", 3: "cross_train", 4: "rest", 5: "long", 6: "easy"}


def _phase_for_date(db, user_id, date) -> str:
    goal = (
        db.query(Goal)
        # target_date >= today: an "active" race goal whose date has already passed
        # (never marked completed) must not pin the phase to a degenerate/negative
        # "weeks until" indefinitely — only a genuinely upcoming race counts.
        .filter(Goal.goal_type == "race", Goal.status == "active", Goal.target_date >= date.isoformat(),
                owned_by(Goal.user_id, user_id))
        .order_by(Goal.target_date)
        .first()
    )
    if not goal:
        return "base"
    race_date = datetime.strptime(goal.target_date, "%Y-%m-%d").date()
    weeks_until = (race_date - date).days / 7
    if weeks_until <= 1:
        return "taper"
    if weeks_until <= 4:
        return "peak"
    if weeks_until <= 12:
        return "build"
    return "base"


def _is_deload_week(config, week_start) -> bool:
    cycle_len = MESOCYCLE_LENGTHS.get(config.mesocycle_pattern, 4)
    weeks_since_epoch = (week_start - _EPOCH_MONDAY).days // 7
    return weeks_since_epoch % cycle_len == cycle_len - 1


def _week_mileage(db, user_id, week_start) -> float:
    week_end = week_start + timedelta(days=6)
    rows = (
        db.query(Run)
        .filter(Run.activity_type == "Run", Run.date >= week_start.isoformat(), Run.date <= week_end.isoformat(),
                owned_by(Run.user_id, user_id))
        .all()
    )
    return sum(r.distance_mi or 0 for r in rows)


def _get_or_create_weekly_plan(db, user_id, week_start, phase, config):
    plan = (
        db.query(WeeklyPlan)
        .filter(WeeklyPlan.user_id == user_id, WeeklyPlan.week_start == week_start.isoformat())
        .first()
    )
    if plan:
        return plan
    is_deload = _is_deload_week(config, week_start)
    last_week_mileage = _week_mileage(db, user_id, week_start - timedelta(days=7))
    ramp_pct = config.weekly_ramp_pct or 3.0
    uncapped = last_week_mileage * (1 + ramp_pct / 100)
    ceiling = last_week_mileage * PHASE_CEILING_MULTIPLIER.get(phase, 1.15) if last_week_mileage > 0 else 20.0
    budget = min(uncapped, ceiling) if last_week_mileage > 0 else ceiling
    if is_deload:
        budget *= 0.75
    plan = WeeklyPlan(
        user_id=user_id, week_start=week_start.isoformat(), target_tss=round(budget, 1),
        actual_tss=0.0, is_deload=is_deload, frozen=False,
    )
    db.add(plan)
    db.commit()
    return plan


def _distribution_would_break(db, user_id, date, candidate_hard: bool) -> bool:
    """Coarse day-type-ratio approximation of a real time-in-zone distribution audit
    (see module docstring). tempo/interval count as "hard"; everything else (incl.
    long, which is hard on volume, not intensity) counts as "easy" for this ratio."""
    if not candidate_hard:
        return False
    week_start = date - timedelta(days=6)
    rows = (
        db.query(Workout)
        .filter(Workout.scheduled_date >= week_start.isoformat(), Workout.scheduled_date < date.isoformat(),
                Workout.workout_type.in_(("easy", "tempo", "interval", "long")), owned_by(Workout.user_id, user_id))
        .all()
    )
    hard_count = sum(1 for w in rows if w.workout_type in ("tempo", "interval"))
    total = len(rows) + 1  # +1 for the candidate day itself
    ratio = (hard_count + 1) / total
    return ratio > 0.2  # polarized/pyramidal both cap hard-day share at ~20% in this v1 approximation


def _generate_endurance(db, user_id, date, readiness_result, config) -> dict | None:
    date_str = date.isoformat()
    week_start = _week_start(date)
    phase = _phase_for_date(db, user_id, date)
    plan = _get_or_create_weekly_plan(db, user_id, week_start, phase, config)
    flags = readiness_result["flags"]
    severe_health = _has_severe_health_note(db, user_id)

    skeleton_type = WEEKDAY_SKELETON[date.weekday()]
    if skeleton_type == "quality":
        base_type = "interval" if phase == "peak" else "tempo"
    elif skeleton_type == "rest":
        base_type = "rest"
    elif skeleton_type == "cross_train":
        base_type = "cross_train"
    else:
        base_type = skeleton_type  # "easy" | "long"

    trigger_notes = []
    workout_type = base_type

    if severe_health:
        workout_type = "rest"
        trigger_notes.append("Active health note flagged severe — micro-deload rest day.")
    elif len(flags) >= 2:
        workout_type = "rest"
        trigger_notes.append(f"Readiness flags {flags} — rest day, week's budget frozen.")
        if not plan.frozen:
            plan.frozen = True
            db.commit()
    elif len(flags) == 1 and workout_type in DOWNGRADE_LADDER:
        downgraded = DOWNGRADE_LADDER[min(DOWNGRADE_LADDER.index(workout_type) + 1, len(DOWNGRADE_LADDER) - 1)]
        if downgraded != workout_type:
            trigger_notes.append(f"Readiness flag {flags} — downgraded {workout_type} -> {downgraded}.")
            workout_type = downgraded
    elif workout_type in ("tempo", "interval") and _distribution_would_break(db, user_id, date, candidate_hard=True):
        trigger_notes.append(f"Distribution audit ({config.distribution}) — downgraded {workout_type} -> easy to keep hard-day share in check.")
        workout_type = "easy"

    if plan.is_deload and workout_type == "long":
        trigger_notes.append("Deload week — trimmed long run.")

    day_share = {"long": 0.30, "tempo": 0.18, "interval": 0.15, "easy": 0.10, "cross_train": 0.10, "rest": 0}
    target_distance_mi = None
    if workout_type not in ("rest",):
        share = day_share.get(workout_type, 0.10)
        target_distance_mi = round((plan.target_tss or 20.0) * share, 1) if workout_type != "cross_train" else None

    activity_type = "Run" if workout_type != "cross_train" else "Other"
    notes = " ".join(trigger_notes) or None

    result = _upsert_generator_workout(
        db, user_id, date_str, domain="endurance",
        workout_type=workout_type, activity_type=activity_type,
        target_distance_mi=target_distance_mi, notes=notes,
    )

    # Two-a-days: build/peak, clean readiness, on the day's quality/long session only.
    if phase in ("build", "peak") and not flags and not severe_health and workout_type in ("tempo", "interval", "long"):
        second = _upsert_generator_workout(
            db, user_id, date_str, domain="endurance_second",
            workout_type="cross_train", activity_type="Other",
            notes="Second session — easy recovery-intensity, modality split from the main session.",
            scheduled_time="18:00",
        )
        result = {"primary": result, "secondSession": second}

    return result


# ---------- Strength path (Phase 4.4 follow-on) ----------

STRENGTH_TEMPLATES = {
    "full_body_ab": {
        "A": [
            {"exercise": "Goblet Squat", "targetType": "reps", "category": "squat"},
            {"exercise": "Push-up", "targetType": "reps", "category": "push"},
            {"exercise": "Bent-over Row", "targetType": "reps", "category": "pull"},
            {"exercise": "Plank", "targetType": "hold_sec", "category": "core"},
            {"exercise": "Glute Bridge", "targetType": "reps", "category": "hinge"},
        ],
        "B": [
            {"exercise": "Romanian Deadlift", "targetType": "reps", "category": "hinge"},
            {"exercise": "Overhead Press", "targetType": "reps", "category": "push"},
            {"exercise": "Pull-up", "targetType": "reps", "category": "pull"},
            {"exercise": "Side Plank", "targetType": "hold_sec", "category": "core"},
            {"exercise": "Dead Bug", "targetType": "reps", "category": "core"},
        ],
    },
}
WEIGHT_INCREMENT_LB = {"squat": 10, "hinge": 10, "push": 5, "pull": 5, "core": 0}
HOLD_INCREMENT_SEC = 5
HOLD_CAP_SEC = 60
# strength_days_per_week -> which weekdays (Mon=0) host a session
WEEKDAY_STRENGTH_SLOTS = {1: [1], 2: [0, 3], 3: [0, 2, 4], 4: [0, 1, 3, 4]}


def _build_exercise_step(ex: dict, progress: dict, light: bool) -> dict:
    rest_seconds = 90 if ex["category"] in ("squat", "hinge") else 60
    set_count = 2 if light else 3
    if ex["targetType"] == "hold_sec":
        hold_sec = 20 if light else (progress["currentHoldSec"] or 20)
        sets = [
            {"index": i, "targetType": "hold_sec", "targetReps": None, "targetHoldSec": hold_sec,
             "targetWeightLb": None, "actualReps": None, "actualHoldSec": None, "actualWeightLb": None,
             "completedAt": None}
            for i in range(set_count)
        ]
    else:
        reps = progress["currentRepsTarget"] or 8
        weight = None if light else progress["currentWeightLb"]
        sets = [
            {"index": i, "targetType": "reps", "targetReps": reps, "targetHoldSec": None,
             "targetWeightLb": weight, "actualReps": None, "actualHoldSec": None, "actualWeightLb": None,
             "completedAt": None}
            for i in range(set_count)
        ]
    return {"stepType": "strength_exercise", "exercise": ex["exercise"], "restSeconds": rest_seconds, "sets": sets}


def _generate_strength(db, user_id, date, readiness_result, config) -> dict | None:
    days_per_week = config.strength_days_per_week or 2
    slots = WEEKDAY_STRENGTH_SLOTS.get(days_per_week, WEEKDAY_STRENGTH_SLOTS[2])
    if date.weekday() not in slots:
        return None

    template = STRENGTH_TEMPLATES.get(config.strength_template, STRENGTH_TEMPLATES["full_body_ab"])
    slot_index = slots.index(date.weekday())
    half = "A" if slot_index % 2 == 0 else "B"
    exercises = template[half]

    flags = readiness_result["flags"]
    severe_health = _has_severe_health_note(db, user_id)
    light = severe_health or len(flags) >= 2

    steps = [
        _build_exercise_step(ex, coach.get_exercise_progress(db, ex["exercise"], user_id), light)
        for ex in exercises
    ]
    if light:
        notes = "Readiness/health flagged — light bodyweight session, no progression check this time."
    elif len(flags) == 1:
        notes = "Holding at current weights/targets — readiness flagged, pausing progression this session."
    else:
        notes = f"Full body {half} — prescribed from current progression."

    return _upsert_generator_workout(
        db, user_id, date.isoformat(), domain="strength",
        workout_type="strength", activity_type="Other", steps=steps, notes=notes,
    )


def apply_strength_progression(db, workout: Workout) -> None:
    """Called by coach.update_workout once a strength Workout's status transitions to
    "completed" with actuals logged. Double progression, evaluated per exercise: if
    every logged set in this session hit (or exceeded) its target, bump the exercise's
    ExerciseProgress for next time; otherwise hold steady (v1 never auto-decreases)."""
    steps = coach._steps_from_json(workout.steps_json) or []
    for step in steps:
        if step.get("stepType") != "strength_exercise":
            continue
        sets = step.get("sets", [])
        if not sets or any(s.get("actualReps") is None and s.get("actualHoldSec") is None for s in sets):
            continue  # not actually logged — nothing to evaluate
        progress = coach.get_exercise_progress(db, step["exercise"], workout.user_id or DEFAULT_USER_ID)
        now_iso = datetime.now(timezone.utc).isoformat()
        if sets[0]["targetType"] == "hold_sec":
            hit_all = all((s.get("actualHoldSec") or 0) >= (s.get("targetHoldSec") or 0) for s in sets)
            if hit_all:
                new_hold = min((progress["currentHoldSec"] or sets[0]["targetHoldSec"] or 20) + HOLD_INCREMENT_SEC, HOLD_CAP_SEC)
                coach.upsert_exercise_progress(db, step["exercise"], workout.user_id or DEFAULT_USER_ID,
                                                current_hold_sec=new_hold, last_completed_at=now_iso)
            else:
                coach.upsert_exercise_progress(db, step["exercise"], workout.user_id or DEFAULT_USER_ID, last_completed_at=now_iso)
        else:
            hit_all = all((s.get("actualReps") or 0) >= (s.get("targetReps") or 0) for s in sets)
            if hit_all and sets[0].get("targetWeightLb") is not None:
                category = next(
                    (e["category"] for tpl in STRENGTH_TEMPLATES.values() for half in tpl.values()
                     for e in half if e["exercise"] == step["exercise"]),
                    "push",
                )
                increment = WEIGHT_INCREMENT_LB.get(category, 5)
                new_weight = (progress["currentWeightLb"] or sets[0]["targetWeightLb"] or 0) + increment
                coach.upsert_exercise_progress(db, step["exercise"], workout.user_id or DEFAULT_USER_ID,
                                                current_weight_lb=new_weight, last_completed_at=now_iso)
            else:
                coach.upsert_exercise_progress(db, step["exercise"], workout.user_id or DEFAULT_USER_ID, last_completed_at=now_iso)


# ---------- Orchestration ----------


def run_for_user(db, user_id: str = DEFAULT_USER_ID, date=None) -> dict:
    target = date or local_today()
    if isinstance(target, str):
        target = datetime.strptime(target, "%Y-%m-%d").date()
    config = _get_training_config(db, user_id)
    readiness_result = stats.readiness(db, user_id, target)
    endurance = _generate_endurance(db, user_id, target, readiness_result, config)
    strength = _generate_strength(db, user_id, target, readiness_result, config)
    return {"date": target.isoformat(), "readiness": readiness_result, "endurance": endurance, "strength": strength}


def run_for_all_users(date=None) -> dict:
    db = SessionLocal()
    try:
        users = db.query(User).filter(or_(User.is_demo == False, User.is_demo.is_(None))).all()  # noqa: E712
        results = {}
        for user in users:
            try:
                results[user.id] = run_for_user(db, user.id, date)
            except Exception as e:
                log.warning(f"generator: run failed for {user.id}: {e}")
                results[user.id] = {"error": str(e)}
        return results
    finally:
        db.close()
