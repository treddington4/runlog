"""Health notes and recovery tools/sessions — both read-only here (lifecycle is
chat-tool-driven only, see app/coach/core.py's log_health_note/update_health_status
and recommend_recovery_session), no manual-creation POST exists yet."""
from fastapi import APIRouter, HTTPException, Request, Depends

from ..models import SessionLocal
from ..accounts import auth

router = APIRouter()


@router.get("/api/health-notes")
def get_health_notes(status: str = None, category: str = None, user_id: str = Depends(auth.current_user_id)):
    """Read-only — no POST/PATCH/DELETE. Health-note lifecycle is chat-tool-driven
    only (see coach/core.py's log_health_note/update_health_status), not a manual form."""
    from ..coach import core as coach
    db = SessionLocal()
    try:
        return coach.list_health_notes(db, status, category, user_id)
    finally:
        db.close()


@router.get("/api/recovery-tools")
def get_recovery_tools_endpoint(user_id: str = Depends(auth.current_user_id)):
    from ..coach import core as coach
    db = SessionLocal()
    try:
        return coach.list_recovery_tools(db, user_id)
    finally:
        db.close()


@router.get("/api/recovery-sessions")
def get_recovery_sessions_endpoint(startDate: str = None, endDate: str = None, status: str = None,
                                    user_id: str = Depends(auth.current_user_id)):
    from ..coach import core as coach
    db = SessionLocal()
    try:
        return coach.list_recovery_sessions(db, startDate, endDate, status, user_id)
    finally:
        db.close()


@router.patch("/api/recovery-sessions/{session_id}")
async def update_recovery_session_endpoint(session_id: str, request: Request, user_id: str = Depends(auth.current_user_id)):
    from ..coach import core as coach
    body = await request.json()
    db = SessionLocal()
    try:
        return coach.update_recovery_session_status(db, session_id, body.get("status"), user_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    finally:
        db.close()


@router.delete("/api/recovery-sessions/{session_id}")
def delete_recovery_session_endpoint(session_id: str, user_id: str = Depends(auth.current_user_id)):
    from ..coach import core as coach
    db = SessionLocal()
    try:
        coach.delete_recovery_session(db, session_id, user_id)
        return {"deleted": True}
    finally:
        db.close()
