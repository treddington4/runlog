"""Strava OAuth + ephemeral demo login (Phase 11). See app/accounts/auth.py for the
current_user_id dependency and app/accounts/demo.py for demo-session mechanics — this
router is just the HTTP surface over both."""
from fastapi import APIRouter, HTTPException, Request, Depends
from fastapi.responses import RedirectResponse

from ..accounts import auth
from ..sync import strava
from ..models import SessionLocal

router = APIRouter()


# ---------- Strava OAuth ----------
@router.get("/auth/strava/login")
def strava_login():
    return RedirectResponse(strava.get_authorize_url())


@router.get("/auth/strava/callback")
def strava_callback(code: str = None, error: str = None, user_id: str = Depends(auth.current_user_id)):
    if error:
        raise HTTPException(400, f"Strava auth error: {error}")
    if not code:
        raise HTTPException(400, "Missing code")
    # AUTH_MODE=disabled means user_id is always DEFAULT_USER_ID here — the natural next
    # step for real multi-user OAuth is threading a `state` param through
    # get_authorize_url()/this callback so the flow survives a redirect while still
    # knowing which logged-in user initiated it (a bare Depends() here can't, since the
    # browser leaves and comes back with no auth header of its own on this GET).
    strava.exchange_code_for_token(user_id, code)
    return RedirectResponse("/?connected=strava")


@router.get("/api/strava/status")
def strava_status(user_id: str = Depends(auth.current_user_id)):
    token = strava.get_valid_access_token(user_id)
    return {"connected": token is not None}


# ---------- Ephemeral demo login (Phase 11) — see app/accounts/demo.py. Only meaningful
# on a deployment with AUTH_MODE=enabled + ENABLE_DEMO_LOGIN=true (Phase 11.4's separate
# cloud template); a no-op / 404 everywhere else, including this app's own real NAS
# deployment. auth.current_user_id() itself is completely unchanged — a demo session's
# ApiToken authenticates via that module's existing X-Api-Token path. ----------
@router.get("/auth/demo/status")
def demo_status():
    from ..accounts import demo
    return {"enabled": demo.is_enabled()}


@router.post("/auth/demo/login")
async def demo_login(request: Request):
    from ..accounts import demo
    if not demo.is_enabled():
        raise HTTPException(404, "Not found")
    body = await request.json()
    if body.get("username") != "demo" or body.get("password") != "demo":
        raise HTTPException(401, "Invalid credentials")
    db = SessionLocal()
    try:
        try:
            return demo.create_demo_session(db)
        except ValueError:
            raise HTTPException(429, "Demo capacity full — try again in a few minutes")
    finally:
        db.close()


@router.post("/auth/demo/logout")
def demo_logout(user_id: str = Depends(auth.current_user_id)):
    from ..accounts import demo
    db = SessionLocal()
    try:
        if demo.is_demo_user(db, user_id):
            demo.delete_demo_user(db, user_id)
        return {"loggedOut": True}
    finally:
        db.close()
