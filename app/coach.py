"""Coach subsystem — persona system prompts and all HealthNote/Workout read+write
logic. Deliberately separate from stats.py (documented read-only computation core —
see its own module docstring) and from assistant.py (SDK integration/tool plumbing
only). This is where the app's narrow, deliberate expansion of write access lives:
both assistant.py's chat tools and main.py's REST endpoints call into the same
functions here, so the chat-conversational and manual-UI write paths can never
validate differently.
"""
import json
import uuid
from datetime import datetime, timedelta, timezone

import stats
from models import HealthNote, Workout, Run, DEFAULT_USER_ID, owned_by

VALID_PERSONAS = ("encouraging", "normal", "spicy", "insulting")

VALID_WORKOUT_TYPES = ("easy", "tempo", "interval", "long", "rest", "strength", "cross_train")
VALID_WORKOUT_STATUSES = ("planned", "completed", "skipped", "modified")

# A step is one exercise/segment in a workout ("leg swings", "side plank", "800m repeat").
# `side` only applies to unilateral movements (leg swings, single-leg work, side planks) —
# left/right get logged as two separate steps rather than one step with an implied "do
# both", so each side can carry its own duration/reps/notes if they ever need to differ.
VALID_STEP_SIDES = ("left", "right", "both")


def _steps_from_json(steps_json) -> list | None:
    if not steps_json:
        return None
    try:
        return json.loads(steps_json)
    except (TypeError, ValueError):
        return None


def _validate_steps(steps):
    """Each step: {exercise: str, side?: one of VALID_STEP_SIDES, durationSec?: int,
    reps?: int, notes?: str}. A step needs at least a duration or a rep count — a bare
    named exercise with neither isn't actionable. Raises ValueError with a specific
    reason so a malformed tool call surfaces something the model can actually correct,
    same discipline as every other coach.py validator."""
    if steps is None:
        return None
    if not isinstance(steps, list):
        raise ValueError("steps must be a list")
    cleaned = []
    for i, step in enumerate(steps):
        if not isinstance(step, dict) or not step.get("exercise"):
            raise ValueError(f"step {i} must be an object with at least an 'exercise' name")
        side = step.get("side")
        if side is not None and side not in VALID_STEP_SIDES:
            raise ValueError(f"step {i}: side must be one of {VALID_STEP_SIDES}")
        duration_sec = step.get("durationSec")
        reps = step.get("reps")
        if duration_sec is None and reps is None:
            raise ValueError(f"step {i} ({step['exercise']!r}) needs durationSec and/or reps")
        cleaned.append({
            "exercise": str(step["exercise"]), "side": side,
            "durationSec": duration_sec, "reps": reps, "notes": step.get("notes"),
        })
    return cleaned

# What kind of thing this is — drives which fields matter and whether recurrence
# linking applies (injury only, since only it has a reliable body_area match key).
VALID_HEALTH_CATEGORIES = ("injury", "illness", "chronic_flare", "procedure", "other")

# Only populated/meaningful when category == "injury". Broadened well beyond running
# joints (hand/finger/wrist/arm/etc included) since an injury can affect strength
# training or daily life without touching running at all.
VALID_BODY_AREAS = ("left_ankle", "right_ankle", "left_knee", "right_knee", "hip",
                     "hamstring", "quad", "calf", "left_shin", "right_shin", "achilles",
                     "it_band", "shoulder", "lower_back", "foot", "hand", "finger",
                     "wrist", "elbow", "arm", "neck", "head", "chest", "abdomen",
                     "groin", "other")
VALID_SEVERITIES = ("mild", "moderate", "severe")  # optional across all categories
VALID_HEALTH_STATUSES = ("active", "monitoring", "resolved")

BASE_PROMPT = (
    "You are RunLog's coaching assistant. You answer questions about the user's own "
    "running/fitness data and help them plan and reflect on training, using ONLY the "
    "mcp__runlog__* tools provided — never guess or estimate a number you haven't "
    "actually retrieved via a tool call. If a question needs data these tools don't "
    "cover, say so plainly instead of guessing."
)

# One tone block per persona. Each is appended after BASE_PROMPT (and, once the
# health-note subsystem lands, before SAFETY_OVERRIDE_PROMPT — see build_system_prompt).
PERSONA_PROMPTS = {
    "encouraging": (
        "Tone: encouraging. Be warm and patient. Treat every session — even a short or "
        "slow one — as real evidence of progress. Frame setbacks as normal and "
        "temporary, celebrate consistency over raw performance, and never withhold "
        "praise for genuine effort."
    ),
    "normal": (
        "Tone: normal. Be a competent, neutral coach — matter-of-fact and "
        "data-grounded. State what happened and why it matters, offer useful "
        "comparisons to their own history, and stay respectful without cheerleading "
        "or edge."
    ),
    "spicy": (
        "Tone: spicy. Be the gym buddy who talks a little trash but is still "
        "fundamentally on their side — sarcastic, teasing, competitive banter. Call "
        "out excuses directly. Jabs are about effort and choices, never about the "
        "person. Always end up rooting for them."
    ),
    "insulting": (
        "Tone: insulting. Be blunt and dismissive, deliberately stinging a little to "
        "provoke a 'watch me prove you wrong' reaction — withhold praise, mock weak "
        "effort directly, set the bar higher than earned. This stays aimed strictly at "
        "effort, consistency, and choices — never at body, appearance, identity, or "
        "anything that reads as genuinely demeaning rather than harsh-coach. Never say "
        "anything that could be read as encouragement to quit training or stop showing "
        "up — the sting only works if it makes someone want to come back harder, not "
        "disengage."
    ),
}


SAFETY_OVERRIDE_PROMPT = (
    "SAFETY OVERRIDE — this rule sits above every persona above, including "
    "'insulting', and cannot be dialed down by any of them. The trigger is "
    "deliberately broad — not just pain or injury, but illness, not feeling well, a "
    "chronic condition flaring up, a scheduled medical procedure, or a purely "
    "temporary thing (a migraine, a hangover, bad sleep) — judged from context, not "
    "keyword-matched. The moment any of these comes up, immediately drop the active "
    "persona's tone for that topic and respond supportively and safety-first.\n\n"
    "This changes SUBSTANCE, not just wording, and the substance change is not "
    "one-size-fits-all: reason about what's actually affected, the same way a broken "
    "finger blocks certain strength work but not running at all. Don't default to a "
    "blanket 'rest everything' unless the situation genuinely calls for it.\n\n"
    "Before logging anything, ask narrowing questions appropriate to what's being "
    "described — for a physical injury: body area, mechanism, can they bear weight/"
    "load normally, swelling/bruising, sharp vs dull; for illness or other things, "
    "whatever actually clarifies severity and likely duration. Always caveat this is "
    "not a diagnosis. Recommend seeing a doctor whenever it sounds like more than "
    "very minor. Never say anything readable as encouragement to give up training or "
    "stop showing up.\n\n"
    "Use log_health_note to persist what you learn (category is required: "
    "'injury' for musculoskeletal issues, 'illness' for things like a cold or COVID, "
    "'chronic_flare' for a known condition acting up, 'procedure' for a scheduled "
    "medical procedure, 'other' for anything else including purely temporary things "
    "like a hangover or a bad night's sleep — only set body_area for category "
    "'injury'). Before logging a new injury, call find_related_health_history with "
    "the body area to check whether this might be the same issue recurring rather "
    "than a fresh one — if it looks related, mention that to the user and, if they "
    "confirm, pass related_note_id when logging. Use update_health_status to mark "
    "something resolved once the user confirms it's cleared up, or to escalate/adjust "
    "if it's dragging on. Get the current state of anything active via "
    "get_health_history before making assumptions."
)


def build_system_prompt(personality: str) -> str:
    persona_text = PERSONA_PROMPTS.get(personality, PERSONA_PROMPTS["normal"])
    return f"{BASE_PROMPT}\n\n{persona_text}\n\n{SAFETY_OVERRIDE_PROMPT}"


def _hours_since(iso_timestamp: str) -> float:
    try:
        then = datetime.fromisoformat(iso_timestamp)
        if then.tzinfo is None:
            then = then.replace(tzinfo=timezone.utc)
    except ValueError:
        return float("inf")
    return (datetime.now(timezone.utc) - then).total_seconds() / 3600


def get_health_context_block(db, user_id: str = DEFAULT_USER_ID) -> str:
    """Built fresh on every chat turn and prepended to the raw user text passed to
    client.query() in assistant.send_message() — deliberately NOT baked into the
    system prompt, so it's always current without ever needing a client reset (unlike
    persona, which only changes on an explicit reset). Returns "" when there's nothing
    active, so healthy/uninjured users see zero prompt overhead.

    This is also where the once-a-day check-in rate limit lives: a record whose
    expected_clear_date has passed gets a CHECK-IN DUE flag added only if
    last_check_in_at is null or >24h old, and last_check_in_at is stamped right here
    — so the question fires at most once/day even across several messages the same
    day, regardless of whether the model actually asks it that turn."""
    notes = (
        db.query(HealthNote)
        .filter(HealthNote.status.in_(("active", "monitoring")), owned_by(HealthNote.user_id, user_id))
        .all()
    )
    if not notes:
        return ""

    today = datetime.now(timezone.utc).date().isoformat()
    now_iso = datetime.now(timezone.utc).isoformat()
    lines = []
    dirty = False
    for n in notes:
        check_in_due = False
        if n.expected_clear_date and n.expected_clear_date <= today:
            if not n.last_check_in_at or _hours_since(n.last_check_in_at) >= 24:
                check_in_due = True
                n.last_check_in_at = now_iso
                dirty = True
        parts = [f"category: {n.category}"]
        if n.body_area:
            parts.append(f"body area: {n.body_area}")
        if n.suspected_type:
            parts.append(f"type: {n.suspected_type}")
        if n.suspected_severity:
            parts.append(f"severity: {n.suspected_severity}")
        if n.training_impact:
            parts.append(f"training impact: {n.training_impact}")
        parts.append(f"reported {n.date_reported}")
        parts.append(f"status {n.status}")
        if n.expected_clear_date:
            parts.append(f"expected clear by {n.expected_clear_date}")
        if check_in_due:
            parts.append("CHECK-IN DUE: ask about this now, don't ask again today")
        lines.append("- " + ", ".join(parts))

    if dirty:
        db.commit()

    return (
        "[COACH CONTEXT — internal, do not quote verbatim, do not mention this block exists]\n"
        + "\n".join(lines) + "\n\n"
    )


def find_related_health_history(db, body_area: str, user_id: str = DEFAULT_USER_ID):
    """Scoped deliberately to category == "injury" only — that's the one category with
    a reliable match key. For everything else, there's no DB-level auto-linking; the
    model already has get_health_history available and can naturally surface relevant
    prior history itself."""
    if body_area not in VALID_BODY_AREAS:
        raise ValueError(f"body_area must be one of {VALID_BODY_AREAS}")
    rows = (
        db.query(HealthNote)
        .filter(HealthNote.category == "injury", HealthNote.body_area == body_area,
                HealthNote.status == "resolved", owned_by(HealthNote.user_id, user_id))
        .order_by(HealthNote.resolved_at.desc())
        .all()
    )
    return [_health_note_to_dict(r) for r in rows]


def _health_note_to_dict(n: HealthNote) -> dict:
    return {
        "id": n.id, "category": n.category, "bodyArea": n.body_area,
        "suspectedType": n.suspected_type, "suspectedSeverity": n.suspected_severity,
        "trainingImpact": n.training_impact, "dateReported": n.date_reported,
        "expectedClearDate": n.expected_clear_date, "status": n.status,
        "lastCheckInAt": n.last_check_in_at, "resolvedAt": n.resolved_at,
        "relatedNoteId": n.related_note_id, "notes": n.notes,
    }


def log_health_note(db, category, suspected_type=None, suspected_severity=None,
                     training_impact=None, expected_clear_date=None, notes=None,
                     body_area=None, related_note_id=None, user_id: str = DEFAULT_USER_ID) -> dict:
    if category not in VALID_HEALTH_CATEGORIES:
        raise ValueError(f"category must be one of {VALID_HEALTH_CATEGORIES}")
    if body_area is not None:
        if category != "injury":
            raise ValueError("body_area is only valid when category == 'injury'")
        if body_area not in VALID_BODY_AREAS:
            raise ValueError(f"body_area must be one of {VALID_BODY_AREAS}")
    if suspected_severity is not None and suspected_severity not in VALID_SEVERITIES:
        raise ValueError(f"suspected_severity must be one of {VALID_SEVERITIES}")
    if related_note_id is not None and category != "injury":
        raise ValueError("related_note_id is only valid when category == 'injury'")

    note = HealthNote(
        id=f"health_{uuid.uuid4().hex[:12]}", user_id=user_id, category=category,
        body_area=body_area, suspected_type=suspected_type, suspected_severity=suspected_severity,
        training_impact=training_impact, date_reported=datetime.now(timezone.utc).date().isoformat(),
        expected_clear_date=expected_clear_date, status="active", related_note_id=related_note_id,
        notes=notes, created_at=datetime.now(timezone.utc).isoformat(),
    )
    db.add(note)
    db.commit()
    return _health_note_to_dict(note)


def update_health_status(db, note_id: str, status: str, notes=None, user_id: str = DEFAULT_USER_ID) -> dict:
    if status not in VALID_HEALTH_STATUSES:
        raise ValueError(f"status must be one of {VALID_HEALTH_STATUSES}")
    note = db.get(HealthNote, note_id)
    if not note:
        raise ValueError(f"no health note with id {note_id}")
    note.status = status
    if notes is not None:
        note.notes = notes
    if status == "resolved":
        note.resolved_at = datetime.now(timezone.utc).isoformat()
    db.commit()
    return _health_note_to_dict(note)


def list_health_notes(db, status=None, category=None, user_id: str = DEFAULT_USER_ID) -> list:
    q = db.query(HealthNote).filter(owned_by(HealthNote.user_id, user_id))
    if status:
        q = q.filter(HealthNote.status == status)
    if category:
        q = q.filter(HealthNote.category == category)
    return [_health_note_to_dict(r) for r in q.order_by(HealthNote.created_at.desc()).all()]


def _workout_to_dict(w: Workout) -> dict:
    return {
        "id": w.id, "scheduledDate": w.scheduled_date, "workoutType": w.workout_type,
        "activityType": w.activity_type, "targetDistanceMi": w.target_distance_mi,
        "targetPaceSecPerMi": w.target_pace_sec_per_mi, "targetDurationSec": w.target_duration_sec,
        "notes": w.notes, "steps": _steps_from_json(w.steps_json), "status": w.status,
        "linkedRunId": w.linked_run_id, "critiqueText": w.critique_text, "createdAt": w.created_at,
    }


# rest/cross_train/strength days aren't a run by default — defaulting them to "Run" let
# any incidental run synced that same day auto-complete a session that was never a run
# (see _find_and_link_workout_run). "Other" normalizes (stats._normalize_activity_type)
# to a bucket real Strava/Garmin activities essentially never land in, so these simply
# stay "planned" until an explicit activityType is given or record_workout_completion
# is called directly.
_NON_RUN_WORKOUT_TYPES = ("rest", "cross_train", "strength")


def _default_activity_type(workout_type: str) -> str:
    return "Other" if workout_type in _NON_RUN_WORKOUT_TYPES else "Run"


def create_workout(db, scheduled_date, workout_type, activity_type=None, target_distance_mi=None,
                    target_pace_sec_per_mi=None, target_duration_sec=None, notes=None, steps=None,
                    user_id: str = DEFAULT_USER_ID) -> dict:
    if workout_type not in VALID_WORKOUT_TYPES:
        raise ValueError(f"workout_type must be one of {VALID_WORKOUT_TYPES}")
    cleaned_steps = _validate_steps(steps)
    workout = Workout(
        id=f"workout_{uuid.uuid4().hex[:12]}", user_id=user_id, scheduled_date=scheduled_date,
        workout_type=workout_type, activity_type=activity_type or _default_activity_type(workout_type),
        target_distance_mi=target_distance_mi, target_pace_sec_per_mi=target_pace_sec_per_mi,
        target_duration_sec=target_duration_sec, notes=notes,
        steps_json=json.dumps(cleaned_steps) if cleaned_steps else None, status="planned",
        created_at=datetime.now(timezone.utc).isoformat(),
    )
    db.add(workout)
    db.commit()
    return _workout_to_dict(workout)


def update_workout(db, workout_id: str, user_id: str = DEFAULT_USER_ID, **fields) -> dict:
    workout = db.get(Workout, workout_id)
    if not workout:
        raise ValueError(f"no workout with id {workout_id}")
    if "status" in fields and fields["status"] is not None and fields["status"] not in VALID_WORKOUT_STATUSES:
        raise ValueError(f"status must be one of {VALID_WORKOUT_STATUSES}")
    if "workout_type" in fields and fields["workout_type"] is not None and fields["workout_type"] not in VALID_WORKOUT_TYPES:
        raise ValueError(f"workout_type must be one of {VALID_WORKOUT_TYPES}")
    if "steps" in fields and fields["steps"] is not None:
        fields["steps_json"] = json.dumps(_validate_steps(fields["steps"])) or None
    for key in ("scheduled_date", "workout_type", "activity_type", "target_distance_mi",
                "target_pace_sec_per_mi", "target_duration_sec", "notes", "steps_json", "status"):
        if key in fields and fields[key] is not None:
            setattr(workout, key, fields[key])
    db.commit()
    return _workout_to_dict(workout)


def delete_workout(db, workout_id: str, user_id: str = DEFAULT_USER_ID):
    workout = db.get(Workout, workout_id)
    if workout:
        db.delete(workout)
        db.commit()


def record_workout_completion(db, workout_id: str, run_id=None, critique_text=None,
                               user_id: str = DEFAULT_USER_ID) -> dict:
    workout = db.get(Workout, workout_id)
    if not workout:
        raise ValueError(f"no workout with id {workout_id}")
    if run_id:
        workout.linked_run_id = run_id
    if critique_text is not None:
        workout.critique_text = critique_text
    workout.status = "completed"
    db.commit()
    return _workout_to_dict(workout)


def _find_and_link_workout_run(db, workout: Workout, user_id: str = DEFAULT_USER_ID):
    """Auto-links a planned Workout to the real synced Run that satisfies it — directly
    mirrors stats._find_and_link_race_run, the one existing precedent for this kind of
    matching in this codebase. Strict on activity type (normalized via
    stats._normalize_activity_type, so Garmin's lowercase "running" still matches a
    "Run"-typed workout) — a run workout never links to a Ride and vice versa.
    Permissive on distance/duration: prefers the closest match among same-day (+/-1
    day), same-type, not-already-claimed candidates, with no hard rejection threshold —
    a run that was cut short still links to its planned session rather than being
    ignored, same principle as the race-goal matcher tolerating an imperfect match."""
    if workout.linked_run_id:
        return db.get(Run, workout.linked_run_id)
    try:
        target = datetime.strptime(workout.scheduled_date, "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return None

    wanted = stats._normalize_activity_type(workout.activity_type)
    already_claimed = {
        row[0] for row in db.query(Workout.linked_run_id).filter(Workout.linked_run_id.isnot(None)).all()
    }

    candidates = []
    for offset in (0, -1, 1):
        d = (target + timedelta(days=offset)).isoformat()
        candidates.extend(db.query(Run).filter(Run.date == d).filter(owned_by(Run.user_id, user_id)).all())
    candidates = [
        r for r in candidates
        if stats._normalize_activity_type(r.activity_type) == wanted and r.id not in already_claimed
    ]
    if not candidates:
        return None

    if workout.target_distance_mi:
        best = min(candidates, key=lambda r: abs((r.distance_mi or 0) - workout.target_distance_mi))
    elif workout.target_duration_sec:
        best = min(candidates, key=lambda r: abs((r.moving_time_sec or 0) - workout.target_duration_sec))
    else:
        best = max(candidates, key=lambda r: r.distance_mi or 0)

    workout.linked_run_id = best.id
    workout.status = "completed"
    db.commit()
    return best


def list_workouts(db, start_date=None, end_date=None, status=None, user_id: str = DEFAULT_USER_ID) -> list:
    q = db.query(Workout).filter(owned_by(Workout.user_id, user_id))
    if start_date:
        q = q.filter(Workout.scheduled_date >= start_date)
    if end_date:
        q = q.filter(Workout.scheduled_date <= end_date)
    if status:
        q = q.filter(Workout.status == status)
    workouts = q.order_by(Workout.scheduled_date).all()

    # Auto-link any planned workout whose date has passed against real synced runs —
    # read-time reconciliation, mirrors how stats._find_and_link_race_run works, so no
    # sync-pipeline hook is needed in strava.py/garmin_sync.py for this to happen. This
    # can flip a row's status out from under the `status` filter applied above (a
    # `status=planned` query can trigger a row to become "completed" mid-call) — re-
    # apply the filter after linking so the response always matches what was asked for.
    today = datetime.now(timezone.utc).date().isoformat()
    for w in workouts:
        if w.status == "planned" and w.scheduled_date <= today and not w.linked_run_id:
            _find_and_link_workout_run(db, w, user_id)
    if status:
        workouts = [w for w in workouts if w.status == status]

    return [_workout_to_dict(w) for w in workouts]
