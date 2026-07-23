"""AI chat assistant (Chat tab) HTTP surface — see app/coach/assistant.py for the
actual Claude Agent SDK wiring, kept intentionally thin here."""
import json
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request, Depends

from ..models import SessionLocal, ChatMessage, CoachIssueDraft, User, owned_by
from ..accounts import auth

router = APIRouter()


@router.get("/api/chat/status")
def chat_status():
    from ..coach import assistant
    return {"configured": assistant.is_configured()}


@router.get("/api/chat/history")
def chat_history(user_id: str = Depends(auth.current_user_id)):
    db = SessionLocal()
    try:
        rows = (db.query(ChatMessage)
                .filter(owned_by(ChatMessage.user_id, user_id), ChatMessage.is_test.isnot(True))
                .order_by(ChatMessage.id).all())
        return [{
            "role": r.role, "content": r.content,
            "toolCalls": json.loads(r.tool_calls_json) if r.tool_calls_json else None,
            "charts": json.loads(r.charts_json) if r.charts_json else None,
            "createdAt": r.created_at,
        } for r in rows]
    finally:
        db.close()


def _is_test_request(request: Request) -> bool:
    """Phase 12.1 — set only by my own manual verification traffic against a real
    deployment (X-Hale-Test: 1), never sent by the real browser app. See CLAUDE.md for
    the convention this enforces: any manual chat-endpoint test against production must
    send this header, or it risks polluting real health-note/workout history exactly
    the way an untagged test message once did (see PLAN.md Phase 12's context)."""
    return request.headers.get("x-hale-test") == "1"


@router.post("/api/chat/message")
async def chat_message(request: Request, user_id: str = Depends(auth.current_user_id)):
    body = await request.json()
    message = (body.get("message") or "").strip()
    if not message:
        raise HTTPException(400, "message is required")
    is_test = _is_test_request(request)

    from ..accounts import demo
    db = SessionLocal()
    try:
        if demo.is_demo_user(db, user_id):
            # Never imports assistant.py for a demo user — no Claude Agent SDK client
            # is ever constructed, so a demo session can never burn real API credits.
            reply = demo.mock_chat_reply(message)
            now_iso = datetime.now(timezone.utc).isoformat()
            db.add(ChatMessage(user_id=user_id, role="user", content=message, created_at=now_iso))
            db.add(ChatMessage(user_id=user_id, role="assistant", content=reply, created_at=now_iso))
            db.commit()
            return {"reply": reply, "toolCalls": [], "charts": []}
    finally:
        db.close()

    from ..coach import assistant
    if not assistant.is_configured():
        raise HTTPException(400, "AI assistant not configured — set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY")
    try:
        return await assistant.send_message(message, user_id, is_test=is_test)
    except Exception as e:
        raise HTTPException(500, str(e))


@router.post("/api/chat/reset")
async def chat_reset(user_id: str = Depends(auth.current_user_id)):
    from ..coach import assistant
    db = SessionLocal()
    try:
        db.query(ChatMessage).filter(owned_by(ChatMessage.user_id, user_id)).delete(synchronize_session=False)
        db.commit()
    finally:
        db.close()
    await assistant.reset_client(user_id)
    return {"status": "reset"}


@router.get("/api/coach/personality")
def get_coach_personality(user_id: str = Depends(auth.current_user_id)):
    db = SessionLocal()
    try:
        user = db.get(User, user_id)
        return {"personality": (user.coach_personality if user else None) or "normal"}
    finally:
        db.close()


@router.post("/api/coach/personality")
async def set_coach_personality(request: Request, user_id: str = Depends(auth.current_user_id)):
    from ..coach import assistant
    from ..coach import core as coach
    body = await request.json()
    personality = body.get("personality")
    if personality not in coach.VALID_PERSONAS:
        raise HTTPException(400, f"personality must be one of {coach.VALID_PERSONAS}")
    db = SessionLocal()
    try:
        user = db.get(User, user_id)
        if user:
            user.coach_personality = personality
            db.commit()
    finally:
        db.close()
    # Persona is baked into the SDK's system prompt at client-construction time, not
    # re-read per message — reset so the next chat message rebuilds it with the new tone.
    await assistant.reset_client(user_id)
    return {"personality": personality}


# ---------- Coach self-review draft (Phase 12.5) — one rolling draft GitHub issue per
# user, accumulated by coach/self_review.py's periodic job and the live
# log_product_feedback chat tool. Draft-only: never posted to github.com from here,
# see CLAUDE.md. Fetched via GET, cleared via POST once pulled/published elsewhere. ----------
@router.get("/api/coach-issue")
def get_coach_issue(user_id: str = Depends(auth.current_user_id)):
    db = SessionLocal()
    try:
        draft = db.get(CoachIssueDraft, user_id)
        if not draft or not draft.body_markdown:
            return None
        return {
            "title": draft.title, "body": draft.body_markdown,
            "frustrationCount": draft.frustration_count or 0, "updatedAt": draft.updated_at,
        }
    finally:
        db.close()


@router.post("/api/coach-issue/clear")
def clear_coach_issue(user_id: str = Depends(auth.current_user_id)):
    db = SessionLocal()
    try:
        draft = db.get(CoachIssueDraft, user_id)
        if draft:
            db.delete(draft)
            db.commit()
        return {"cleared": True}
    finally:
        db.close()
