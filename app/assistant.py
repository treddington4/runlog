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
lists only our own read-only mcp__runlog__* tools, `disallowed_tools` explicitly blocks
Claude Code's built-in filesystem/shell tools as a second layer, and `setting_sources`
is empty so no local .claude/settings.json in the container can grant anything back.
No tool here writes to the DB — every stats.py call is a plain SELECT.
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

import stats
from models import SessionLocal, Run, ChatMessage, DEFAULT_USER_ID

BUILTIN_TOOLS_BLOCKLIST = [
    "Bash", "Read", "Write", "Edit", "NotebookEdit", "Task", "WebFetch", "WebSearch",
    "Glob", "Grep", "EnterWorktree", "ExitWorktree", "CronCreate", "CronDelete", "CronList",
]

SYSTEM_PROMPT = (
    "You are RunLog's data assistant. You answer questions about the user's own "
    "running/fitness data using ONLY the mcp__runlog__* tools provided — never guess "
    "or estimate a number you haven't actually retrieved via a tool call. If a question "
    "needs data these tools don't cover (e.g. weight, sleep, nutrition — not tracked "
    "yet), say so plainly instead of guessing. Be concise and factual; this is a "
    "personal dashboard, not a chat companion."
)


def _db_call(fn, *args, **kwargs):
    db = SessionLocal()
    try:
        return fn(db, *args, **kwargs)
    finally:
        db.close()


@tool("get_run_summary", "Totals/averages (count, distance, pace, elevation, time) over an optional date range", {
    "type": "object",
    "properties": {
        "startDate": {"type": "string", "description": "YYYY-MM-DD, inclusive"},
        "endDate": {"type": "string", "description": "YYYY-MM-DD, inclusive"},
        "activityType": {"type": "string", "description": "e.g. 'Run', 'Ride', 'Walk'. Defaults to 'Run'."},
    },
})
async def get_run_summary(args):
    result = _db_call(stats.run_summary, args.get("startDate"), args.get("endDate"), args.get("activityType", "Run"))
    return {"content": [{"type": "text", "text": json.dumps(result)}]}


@tool("get_weekly_mileage", "Weekly mileage totals for the trailing N weeks", {
    "type": "object",
    "properties": {"weeks": {"type": "integer", "description": "Default 12"}},
})
async def get_weekly_mileage(args):
    result = _db_call(stats.weekly_mileage, args.get("weeks", 12))
    return {"content": [{"type": "text", "text": json.dumps(result)}]}


@tool("get_monthly_mileage", "Monthly mileage totals for the trailing N months", {
    "type": "object",
    "properties": {"months": {"type": "integer", "description": "Default 12"}},
})
async def get_monthly_mileage(args):
    result = _db_call(stats.monthly_mileage, args.get("months", 12))
    return {"content": [{"type": "text", "text": json.dumps(result)}]}


@tool("get_personal_records", "Longest run, fastest plausible pace, most elevation, longest duration", {
    "type": "object", "properties": {},
})
async def get_personal_records(args):
    result = _db_call(stats.personal_records)
    return {"content": [{"type": "text", "text": json.dumps(result)}]}


@tool("get_pace_trend", "Rolling window pace trend over the trailing N days", {
    "type": "object",
    "properties": {
        "days": {"type": "integer", "description": "Default 90"},
        "windowDays": {"type": "integer", "description": "Rolling window size in days, default 7"},
    },
})
async def get_pace_trend(args):
    result = _db_call(stats.rolling_pace_trend, args.get("days", 90), args.get("windowDays", 7))
    return {"content": [{"type": "text", "text": json.dumps(result)}]}


@tool("get_training_load_trend", "Trailing 4 weeks vs prior 4 weeks mileage, with percent change and direction", {
    "type": "object", "properties": {},
})
async def get_training_load_trend(args):
    result = _db_call(stats.training_load_trend)
    return {"content": [{"type": "text", "text": json.dumps(result)}]}


@tool("get_daily_steps", "Daily step counts (Garmin-only) for the trailing N days", {
    "type": "object",
    "properties": {"days": {"type": "integer", "description": "Default 30"}},
})
async def get_daily_steps(args):
    result = _db_call(stats.daily_steps_summary, args.get("days", 30))
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
        args.get("sortBy", "date"), args.get("limit", 20),
    )
    return {"content": [{"type": "text", "text": json.dumps(result)}]}


@tool("get_run_detail", "Full detail for a single run by id (splits, HR, notes) — use the id from query_runs/get_personal_records", {
    "type": "object",
    "properties": {"runId": {"type": "string"}},
    "required": ["runId"],
})
async def get_run_detail(args):
    def _fetch(db, run_id):
        r = db.get(Run, run_id)
        if not r:
            return None
        hr_floor = stats.get_hr_floor(db)
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


ALL_TOOLS = [
    get_run_summary, get_weekly_mileage, get_monthly_mileage, get_personal_records,
    get_pace_trend, get_training_load_trend, get_daily_steps, query_runs, get_run_detail,
]
ALLOWED_TOOL_NAMES = [f"mcp__runlog__{t.name}" for t in ALL_TOOLS]

_server = create_sdk_mcp_server(name="runlog", version="0.1.0", tools=ALL_TOOLS)

_options = ClaudeAgentOptions(
    mcp_servers={"runlog": _server},
    allowed_tools=ALLOWED_TOOL_NAMES,
    disallowed_tools=BUILTIN_TOOLS_BLOCKLIST,
    system_prompt=SYSTEM_PROMPT,
    permission_mode="bypassPermissions",  # headless container, no TTY to prompt for approval
    setting_sources=[],  # don't inherit any local .claude/settings.json in the container
    max_turns=8,
)

_client: ClaudeSDKClient | None = None


def is_configured() -> bool:
    return bool(os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") or os.environ.get("ANTHROPIC_API_KEY"))


async def _get_client() -> ClaudeSDKClient:
    global _client
    if _client is None:
        _client = ClaudeSDKClient(options=_options)
        await _client.connect()
    return _client


async def reset_client():
    global _client
    if _client is not None:
        await _client.disconnect()
        _client = None


def _persist(role: str, content: str, tool_calls=None, user_id: str = DEFAULT_USER_ID):
    db = SessionLocal()
    try:
        db.add(ChatMessage(
            user_id=user_id, role=role, content=content,
            tool_calls_json=json.dumps(tool_calls) if tool_calls else None,
            created_at=datetime.now(timezone.utc).isoformat(),
        ))
        db.commit()
    finally:
        db.close()


async def send_message(user_text: str) -> dict:
    """Non-streaming: blocks for the full response, persists both sides, returns
    {reply, toolCalls}. toolCalls records which real queries backed the answer, for
    UI transparency — directly serving the "grounded, not hallucinated" requirement."""
    if not is_configured():
        raise RuntimeError("AI assistant not configured — set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY")

    _persist("user", user_text)
    client = await _get_client()
    await client.query(user_text)

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

    _persist("assistant", reply_text, tool_calls)
    return {"reply": reply_text, "toolCalls": tool_calls}
