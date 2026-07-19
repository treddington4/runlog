"""AI chat assistant — answers questions about the user's own stored fitness data by
calling read-only tools backed by stats.py. Uses the Claude Agent SDK, authenticated
via either a Claude Pro/Max subscription token (CLAUDE_CODE_OAUTH_TOKEN, generated
once via `claude setup-token` on any machine, no per-token metered cost) or a standard
metered API key (ANTHROPIC_API_KEY) — whichever the SDK finds first (its own default
precedence, not overridden here). Both are optional; if neither is set, is_configured()
returns False and callers should show a clean "not configured yet" state rather than
attempting a query.

SECURITY: this agent runs unattended, server-side, in the same container as the app
and its SQLite DB file. Nothing about this feature should let the model touch the
container filesystem or shell. Defense in depth, not just one allowlist: `allowed_tools`
lists only our own mcp__runlog__* tools, `disallowed_tools` explicitly blocks
Claude Code's built-in filesystem/shell tools as a second layer, and `setting_sources`
is empty so no local .claude/settings.json in the container can grant anything back.
Write access is narrowly and deliberately scoped: only HealthNote and Workout rows
(via coach.py) can be written by any tool here — never Run, Goal, ProviderCredential,
or anything filesystem/shell-adjacent. Every stats.py-backed tool remains a plain
SELECT.
"""
import json
import os
from datetime import datetime, timezone

from claude_agent_sdk import (
    ClaudeAgentOptions,
    ClaudeSDKClient,
    create_sdk_mcp_server,
    tool,
)

import coach
import stats
from models import SessionLocal, Run, ChatMessage, User, DEFAULT_USER_ID, owned_by

BUILTIN_TOOLS_BLOCKLIST = [
    "Bash", "Read", "Write", "Edit", "NotebookEdit", "Task", "WebFetch", "WebSearch",
    "Glob", "Grep", "EnterWorktree", "ExitWorktree", "CronCreate", "CronDelete", "CronList",
]

# Names only — fixed regardless of which user's session is asking, so this can stay a
# module-level constant even though the tool objects themselves (_build_tools below)
# are rebuilt per user.
_TOOL_NAMES = [
    "get_run_summary", "get_weekly_mileage", "get_monthly_mileage", "get_personal_records",
    "get_pace_trend", "get_training_load_trend", "get_daily_steps", "query_runs", "get_run_detail",
    "get_health_history", "find_related_health_history", "log_health_note", "update_health_status",
    "get_scheduled_workouts", "schedule_workout", "update_workout", "record_workout_completion",
    "render_chart",
]
ALLOWED_TOOL_NAMES = [f"mcp__runlog__{name}" for name in _TOOL_NAMES]


def _db_call(fn, *args, **kwargs):
    db = SessionLocal()
    try:
        return fn(db, *args, **kwargs)
    finally:
        db.close()


def _build_tools(user_id: str) -> list:
    """Returns a fresh set of tool closures bound to one user's id, so every DB
    read/write a tool makes is actually scoped to that user — not just the SDK session
    wrapper around them (see _get_client). Called once per user, when that user's
    client is first created, not per message."""

    @tool("get_run_summary", "Totals/averages (count, distance, pace, elevation, time) over an optional date range", {
        "type": "object",
        "properties": {
            "startDate": {"type": "string", "description": "YYYY-MM-DD, inclusive"},
            "endDate": {"type": "string", "description": "YYYY-MM-DD, inclusive"},
            "activityType": {"type": "string", "description": "e.g. 'Run', 'Ride', 'Walk'. Defaults to 'Run'."},
        },
    })
    async def get_run_summary(args):
        result = _db_call(stats.run_summary, args.get("startDate"), args.get("endDate"),
                           args.get("activityType", "Run"), user_id=user_id)
        return {"content": [{"type": "text", "text": json.dumps(result)}]}

    @tool("get_weekly_mileage", "Weekly mileage totals for the trailing N weeks", {
        "type": "object",
        "properties": {"weeks": {"type": "integer", "description": "Default 12"}},
    })
    async def get_weekly_mileage(args):
        result = _db_call(stats.weekly_mileage, args.get("weeks", 12), user_id=user_id)
        return {"content": [{"type": "text", "text": json.dumps(result)}]}

    @tool("get_monthly_mileage", "Monthly mileage totals for the trailing N months", {
        "type": "object",
        "properties": {"months": {"type": "integer", "description": "Default 12"}},
    })
    async def get_monthly_mileage(args):
        result = _db_call(stats.monthly_mileage, args.get("months", 12), user_id=user_id)
        return {"content": [{"type": "text", "text": json.dumps(result)}]}

    @tool("get_personal_records", "Longest run, fastest plausible pace, most elevation, longest duration", {
        "type": "object", "properties": {},
    })
    async def get_personal_records(args):
        result = _db_call(stats.personal_records, user_id=user_id)
        return {"content": [{"type": "text", "text": json.dumps(result)}]}

    @tool("get_pace_trend", "Rolling window pace trend over the trailing N days", {
        "type": "object",
        "properties": {
            "days": {"type": "integer", "description": "Default 90"},
            "windowDays": {"type": "integer", "description": "Rolling window size in days, default 7"},
        },
    })
    async def get_pace_trend(args):
        result = _db_call(stats.rolling_pace_trend, args.get("days", 90), args.get("windowDays", 7), user_id=user_id)
        return {"content": [{"type": "text", "text": json.dumps(result)}]}

    @tool("get_training_load_trend", "Trailing 4 weeks vs prior 4 weeks mileage, with percent change and direction", {
        "type": "object", "properties": {},
    })
    async def get_training_load_trend(args):
        result = _db_call(stats.training_load_trend, user_id=user_id)
        return {"content": [{"type": "text", "text": json.dumps(result)}]}

    @tool("get_daily_steps", "Daily step counts (Garmin-only) for the trailing N days", {
        "type": "object",
        "properties": {"days": {"type": "integer", "description": "Default 30"}},
    })
    async def get_daily_steps(args):
        result = _db_call(stats.daily_steps_summary, args.get("days", 30), user_id=user_id)
        return {"content": [{"type": "text", "text": json.dumps(result)}]}

    @tool("query_runs", "Flexible run lookup: filter by date range/type/distance, sort, limit. Use for free-form questions the other tools don't cover.", {
        "type": "object",
        "properties": {
            "startDate": {"type": "string"},
            "endDate": {"type": "string"},
            "activityType": {"type": "string", "description": "Omit for all activity types"},
            "minDistance": {"type": "number"},
            "maxDistance": {"type": "number"},
            "sortBy": {"type": "string", "description": "'date' (default), 'distance_mi', 'elev_gain_ft', or 'pace' (ascending, fastest first)"},
            "limit": {"type": "integer", "description": "Default 20"},
        },
    })
    async def query_runs(args):
        result = _db_call(
            stats.query_runs,
            args.get("startDate"), args.get("endDate"), args.get("activityType"),
            args.get("minDistance"), args.get("maxDistance"),
            args.get("sortBy", "date"), args.get("limit", 20), user_id=user_id,
        )
        return {"content": [{"type": "text", "text": json.dumps(result)}]}

    @tool("get_run_detail", "Full detail for a single run by id (splits, HR, notes) — use the id from query_runs/get_personal_records", {
        "type": "object",
        "properties": {"runId": {"type": "string"}},
        "required": ["runId"],
    })
    async def get_run_detail(args):
        def _fetch(db, run_id):
            r = db.query(Run).filter(Run.id == run_id, owned_by(Run.user_id, user_id)).first()
            if not r:
                return None
            hr_floor = stats.get_hr_floor(db, user_id)
            return {
                "id": r.id, "date": r.date, "name": r.name, "activityType": r.activity_type,
                "distanceMi": r.distance_mi, "movingTimeSec": r.moving_time_sec,
                "paceSecPerMi": r.avg_pace_sec_per_mi if stats.is_plausible_pace(r.avg_pace_sec_per_mi, r.distance_mi) else None,
                "avgHR": r.avg_hr if stats.is_plausible_hr(r.avg_hr, hr_floor) else None,
                "maxHR": r.max_hr if stats.is_plausible_hr(r.max_hr, hr_floor) else None,
                "elevGainFt": r.elev_gain_ft, "avgCadence": r.avg_cadence,
                "type": r.type_override or r.suggested_type, "rpe": r.rpe, "notes": r.notes,
                "splits": json.loads(r.splits_json or "[]"),
            }
        result = _db_call(_fetch, args["runId"])
        if result is None:
            return {"content": [{"type": "text", "text": f"No run found with id {args['runId']}"}], "is_error": True}
        return {"content": [{"type": "text", "text": json.dumps(result)}]}

    @tool("get_health_history", "List logged health notes (injuries, illness, chronic-condition flares, scheduled procedures, or other temporary things affecting training). Use before making assumptions about the user's current health state.", {
        "type": "object",
        "properties": {
            "status": {"type": "string", "enum": list(coach.VALID_HEALTH_STATUSES), "description": "Omit for all statuses"},
            "category": {"type": "string", "enum": list(coach.VALID_HEALTH_CATEGORIES), "description": "Omit for all categories"},
        },
    })
    async def get_health_history(args):
        result = _db_call(coach.list_health_notes, args.get("status"), args.get("category"), user_id=user_id)
        return {"content": [{"type": "text", "text": json.dumps(result)}]}

    @tool("find_related_health_history", "Check whether a resolved injury exists for the same body area before logging a new one — call this for category='injury' before log_health_note so a recurring issue can be linked rather than treated as fresh.", {
        "type": "object",
        "properties": {"bodyArea": {"type": "string", "enum": list(coach.VALID_BODY_AREAS)}},
        "required": ["bodyArea"],
    })
    async def find_related_health_history(args):
        try:
            result = _db_call(coach.find_related_health_history, args["bodyArea"], user_id=user_id)
        except ValueError as e:
            return {"content": [{"type": "text", "text": str(e)}], "is_error": True}
        return {"content": [{"type": "text", "text": json.dumps(result)}]}

    @tool("log_health_note", "Record something affecting training — an injury, illness, chronic-condition flare, scheduled procedure, or other temporary thing. body_area and relatedNoteId are only valid when category is 'injury'.", {
        "type": "object",
        "properties": {
            "category": {"type": "string", "enum": list(coach.VALID_HEALTH_CATEGORIES)},
            "bodyArea": {"type": "string", "enum": list(coach.VALID_BODY_AREAS), "description": "Only for category='injury'"},
            "suspectedType": {"type": "string", "description": "e.g. 'ankle sprain', 'COVID', 'migraine', 'colonoscopy prep'"},
            "suspectedSeverity": {"type": "string", "enum": list(coach.VALID_SEVERITIES)},
            "trainingImpact": {"type": "string", "description": "What's actually restricted vs fine — e.g. 'avoid grip/strength work, running is fine'"},
            "expectedClearDate": {"type": "string", "description": "YYYY-MM-DD, your best-judgment estimate of when this should have cleared"},
            "notes": {"type": "string"},
            "relatedNoteId": {"type": "string", "description": "Only for category='injury' — id of a prior resolved note this appears to be a recurrence of"},
        },
        "required": ["category"],
    })
    async def log_health_note(args):
        try:
            result = _db_call(
                coach.log_health_note, args["category"],
                args.get("suspectedType"), args.get("suspectedSeverity"), args.get("trainingImpact"),
                args.get("expectedClearDate"), args.get("notes"), args.get("bodyArea"), args.get("relatedNoteId"),
                user_id=user_id,
            )
        except ValueError as e:
            return {"content": [{"type": "text", "text": str(e)}], "is_error": True}
        return {"content": [{"type": "text", "text": json.dumps(result)}]}

    @tool("update_health_status", "Update a health note's status — e.g. mark it resolved once the user confirms it's cleared up.", {
        "type": "object",
        "properties": {
            "noteId": {"type": "string"},
            "status": {"type": "string", "enum": list(coach.VALID_HEALTH_STATUSES)},
            "notes": {"type": "string"},
        },
        "required": ["noteId", "status"],
    })
    async def update_health_status(args):
        try:
            result = _db_call(coach.update_health_status, args["noteId"], args["status"], args.get("notes"), user_id=user_id)
        except ValueError as e:
            return {"content": [{"type": "text", "text": str(e)}], "is_error": True}
        return {"content": [{"type": "text", "text": json.dumps(result)}]}

    @tool("get_scheduled_workouts", "List scheduled/prescribed workouts. Planned workouts whose date has passed are auto-checked against real synced runs and linked/marked completed if a match is found.", {
        "type": "object",
        "properties": {
            "startDate": {"type": "string", "description": "YYYY-MM-DD"},
            "endDate": {"type": "string", "description": "YYYY-MM-DD"},
            "status": {"type": "string", "enum": list(coach.VALID_WORKOUT_STATUSES), "description": "Omit for all statuses"},
        },
    })
    async def get_scheduled_workouts(args):
        result = _db_call(coach.list_workouts, args.get("startDate"), args.get("endDate"), args.get("status"), user_id=user_id)
        return {"content": [{"type": "text", "text": json.dumps(result)}]}

    STEPS_SCHEMA = {
        "type": "array",
        "description": "Structured step-by-step breakdown, in order. Use this instead of (or alongside) notes whenever the session has distinct exercises/segments — e.g. a mobility circuit or a strength session. Split a unilateral movement (leg swings, single-leg work, side plank) into two separate steps, one per side, rather than one step covering both.",
        "items": {
            "type": "object",
            "properties": {
                "exercise": {"type": "string", "description": "e.g. 'Leg swings', 'Side plank', 'Bird dog', '800m repeat'"},
                "side": {"type": "string", "enum": list(coach.VALID_STEP_SIDES), "description": "Only for unilateral movements — omit for bilateral/whole-body steps."},
                "durationSec": {"type": "integer", "description": "For time-based steps (holds, circuits, intervals)"},
                "reps": {"type": "integer", "description": "For rep-based steps"},
                "notes": {"type": "string", "description": "Cueing/form notes for this specific step"},
            },
            "required": ["exercise"],
        },
    }

    @tool("schedule_workout", "Prescribe a workout for a specific date. Check get_health_history first — a workout suggestion must be modified (rest/lower intensity/avoid the affected area) if anything active would be affected, not just persona-toned around the same plan.", {
        "type": "object",
        "properties": {
            "scheduledDate": {"type": "string", "description": "YYYY-MM-DD"},
            "workoutType": {"type": "string", "enum": list(coach.VALID_WORKOUT_TYPES)},
            "activityType": {"type": "string", "description": "e.g. 'Run', 'Ride', 'Walk' — must match what the user actually does for this session so it can auto-link to the right synced activity later. Leave unset for rest/cross_train/strength days that aren't literally a run or ride (e.g. a mobility/core session) — it defaults to a non-linking placeholder so an unrelated activity synced that day can't wrongly mark it complete. Only set it explicitly when the cross-training itself is a trackable activity type, e.g. 'Ride' for a bike cross-training day."},
            "targetDistanceMi": {"type": "number"},
            "targetPaceSecPerMi": {"type": "integer"},
            "targetDurationSec": {"type": "integer"},
            "notes": {"type": "string", "description": "Prescription rationale — keep this the high-level why; put the actual exercise-by-exercise plan in steps"},
            "steps": STEPS_SCHEMA,
        },
        "required": ["scheduledDate", "workoutType"],
    })
    async def schedule_workout(args):
        try:
            result = _db_call(
                coach.create_workout, args["scheduledDate"], args["workoutType"],
                args.get("activityType"), args.get("targetDistanceMi"),
                args.get("targetPaceSecPerMi"), args.get("targetDurationSec"), args.get("notes"),
                args.get("steps"), user_id=user_id,
            )
        except ValueError as e:
            return {"content": [{"type": "text", "text": str(e)}], "is_error": True}
        return {"content": [{"type": "text", "text": json.dumps(result)}]}

    @tool("update_workout", "Update a scheduled workout — reschedule, change prescription, or mark skipped.", {
        "type": "object",
        "properties": {
            "workoutId": {"type": "string"},
            "scheduledDate": {"type": "string"},
            "workoutType": {"type": "string", "enum": list(coach.VALID_WORKOUT_TYPES)},
            "activityType": {"type": "string"},
            "targetDistanceMi": {"type": "number"},
            "targetPaceSecPerMi": {"type": "integer"},
            "targetDurationSec": {"type": "integer"},
            "notes": {"type": "string"},
            "steps": STEPS_SCHEMA,
            "status": {"type": "string", "enum": list(coach.VALID_WORKOUT_STATUSES)},
        },
        "required": ["workoutId"],
    })
    async def update_workout(args):
        fields = {
            "scheduled_date": args.get("scheduledDate"), "workout_type": args.get("workoutType"),
            "activity_type": args.get("activityType"), "target_distance_mi": args.get("targetDistanceMi"),
            "target_pace_sec_per_mi": args.get("targetPaceSecPerMi"), "target_duration_sec": args.get("targetDurationSec"),
            "notes": args.get("notes"), "steps": args.get("steps"), "status": args.get("status"),
        }
        try:
            result = _db_call(coach.update_workout, args["workoutId"], user_id=user_id, **fields)
        except ValueError as e:
            return {"content": [{"type": "text", "text": str(e)}], "is_error": True}
        return {"content": [{"type": "text", "text": json.dumps(result)}]}

    @tool("record_workout_completion", "Record a critique of a completed workout — pair it with a real run (from query_runs/get_run_detail) and your honest analysis of how it went relative to the plan or recent trends.", {
        "type": "object",
        "properties": {
            "workoutId": {"type": "string"},
            "runId": {"type": "string", "description": "The real Run this session corresponds to, if not already auto-linked"},
            "critiqueText": {"type": "string"},
        },
        "required": ["workoutId", "critiqueText"],
    })
    async def record_workout_completion(args):
        try:
            result = _db_call(coach.record_workout_completion, args["workoutId"], args.get("runId"),
                               args["critiqueText"], user_id=user_id)
        except ValueError as e:
            return {"content": [{"type": "text", "text": str(e)}], "is_error": True}
        return {"content": [{"type": "text", "text": json.dumps(result)}]}

    @tool("render_chart", "Embed a chart in your reply. Use real numbers you already retrieved via another tool this turn (e.g. get_weekly_mileage) — this tool does not compute anything itself, it just declares what to draw. labels and each dataset's data array must be the same length.", {
        "type": "object",
        "properties": {
            "chartType": {"type": "string", "enum": ["line", "bar"]},
            "title": {"type": "string"},
            "labels": {"type": "array", "items": {"type": "string"}, "description": "X-axis labels, e.g. dates or week-start strings"},
            "datasets": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "label": {"type": "string"},
                        "data": {"type": "array", "items": {"type": "number"}},
                    },
                    "required": ["label", "data"],
                },
            },
        },
        "required": ["chartType", "title", "labels", "datasets"],
    })
    async def render_chart(args):
        # Pure passthrough — no DB call, no computation. Its "result" is just its own
        # input echoed back; send_message() pulls chart specs straight out of the
        # already-captured tool_calls list rather than needing to parse a separate
        # ToolResultBlock from the SDK stream.
        return {"content": [{"type": "text", "text": json.dumps(args)}]}

    return [
        get_run_summary, get_weekly_mileage, get_monthly_mileage, get_personal_records,
        get_pace_trend, get_training_load_trend, get_daily_steps, query_runs, get_run_detail,
        get_health_history, find_related_health_history, log_health_note, update_health_status,
        get_scheduled_workouts, schedule_workout, update_workout, record_workout_completion,
        render_chart,
    ]


_clients: dict[str, ClaudeSDKClient] = {}


def is_configured() -> bool:
    return bool(os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") or os.environ.get("ANTHROPIC_API_KEY"))


def _current_personality(user_id: str = DEFAULT_USER_ID) -> str:
    db = SessionLocal()
    try:
        user = db.get(User, user_id)
        return (user.coach_personality if user else None) or "normal"
    finally:
        db.close()


async def _get_client(user_id: str = DEFAULT_USER_ID) -> ClaudeSDKClient:
    """One SDK session per user, not one shared session for the whole app — otherwise
    two real users' conversations would bleed into each other's live SDK-side context
    (the turn-by-turn memory the SDK keeps internally, separate from the ChatMessage
    history in SQLite, which was already correctly scoped per-user via owned_by()), and
    resetting one user's session (e.g. on a persona change) would silently blow away
    every other user's conversation too. Options are built fresh per client rather than
    once at import time, since the system prompt depends on that user's
    coach_personality. reset_client() (below) forces a rebuild for one user only — the
    next message from that user rebuilds with the new tone; other users' sessions are
    untouched."""
    if user_id not in _clients:
        server = create_sdk_mcp_server(name="runlog", version="0.1.0", tools=_build_tools(user_id))
        options = ClaudeAgentOptions(
            mcp_servers={"runlog": server},
            allowed_tools=ALLOWED_TOOL_NAMES,
            disallowed_tools=BUILTIN_TOOLS_BLOCKLIST,
            system_prompt=coach.build_system_prompt(_current_personality(user_id)),
            permission_mode="bypassPermissions",  # headless container, no TTY to prompt for approval
            setting_sources=[],  # don't inherit any local .claude/settings.json in the container
            max_turns=8,
        )
        client = ClaudeSDKClient(options=options)
        await client.connect()
        _clients[user_id] = client
    return _clients[user_id]


async def reset_client(user_id: str = DEFAULT_USER_ID):
    client = _clients.pop(user_id, None)
    if client is not None:
        await client.disconnect()


def _persist(role: str, content: str, tool_calls=None, charts=None, user_id: str = DEFAULT_USER_ID):
    db = SessionLocal()
    try:
        db.add(ChatMessage(
            user_id=user_id, role=role, content=content,
            tool_calls_json=json.dumps(tool_calls) if tool_calls else None,
            charts_json=json.dumps(charts) if charts else None,
            created_at=datetime.now(timezone.utc).isoformat(),
        ))
        db.commit()
    finally:
        db.close()


async def send_message(user_text: str, user_id: str = DEFAULT_USER_ID) -> dict:
    """Non-streaming: blocks for the full response, persists both sides, returns
    {reply, toolCalls}. toolCalls records which real queries backed the answer, for
    UI transparency — directly serving the "grounded, not hallucinated" requirement."""
    if not is_configured():
        raise RuntimeError("AI assistant not configured — set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY")

    _persist("user", user_text, user_id=user_id)  # persist the ORIGINAL text only — the
                                  # health context block below is injected into what the
                                  # model sees, never into chat history or the UI
    db = SessionLocal()
    try:
        health_context = coach.get_health_context_block(db, user_id)
    finally:
        db.close()

    client = await _get_client(user_id)
    await client.query(health_context + user_text)

    reply_text = ""
    tool_calls = []
    async for msg in client.receive_response():
        msg_type = type(msg).__name__
        if msg_type == "AssistantMessage":
            if getattr(msg, "error", None):
                raise RuntimeError(f"Assistant error: {msg.error}")
            for block in msg.content:
                block_type = type(block).__name__
                if block_type == "TextBlock":
                    reply_text += block.text
                elif block_type == "ToolUseBlock" and str(block.name).startswith("mcp__runlog__"):
                    tool_calls.append({"tool": block.name.replace("mcp__runlog__", ""), "input": block.input})

    # render_chart is a pure passthrough (see _build_tools) — its "result" is exactly
    # its own input, already captured above via the normal ToolUseBlock handling, so
    # chart specs are pulled straight out of tool_calls rather than needing a second
    # pass over the SDK's tool-result message stream.
    charts = [tc["input"] for tc in tool_calls if tc["tool"] == "render_chart"]

    _persist("assistant", reply_text, tool_calls, charts, user_id=user_id)
    return {"reply": reply_text, "toolCalls": tool_calls, "charts": charts}
