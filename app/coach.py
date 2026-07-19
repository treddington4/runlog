"""Coach subsystem — persona system prompts and all HealthNote/Workout read+write
logic. Deliberately separate from stats.py (documented read-only computation core —
see its own module docstring) and from assistant.py (SDK integration/tool plumbing
only). This is where the app's narrow, deliberate expansion of write access lives:
both assistant.py's chat tools and main.py's REST endpoints call into the same
functions here, so the chat-conversational and manual-UI write paths can never
validate differently.
"""
import uuid
from datetime import datetime, timedelta, timezone

from models import HealthNote, DEFAULT_USER_ID, owned_by

VALID_PERSONAS = ("encouraging", "normal", "spicy", "insulting")

# What kind of thing this is — drives which fields matter and whether recurrence
# linking applies (injury only, since only it has a reliable body_area match key).
VALID_HEALTH_CATEGORIES = ("injury", "illness", "chronic_flare", "procedure", "other")

# Only populated/meaningful when category == "injury". Broadened well beyond running
# joints (hand/finger/wrist/arm/etc included) since an injury can affect strength
# training or daily life without touching running at all.
VALID_BODY_AREAS = ("left_ankle", "right_ankle", "left_knee", "right_knee", "hip",
                     "hamstring", "calf", "it_band", "shoulder", "lower_back", "foot",
                     "hand", "finger", "wrist", "elbow", "arm", "neck", "head", "chest",
                     "abdomen", "groin", "other")
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
