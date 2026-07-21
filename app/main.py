import os
import json
import time
import logging
import threading
import hashlib
import secrets
from datetime import datetime, timedelta, timezone

import requests
from sqlalchemy import func
from fastapi import FastAPI, HTTPException, Request, UploadFile, File, Query
from fastapi.responses import RedirectResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.gzip import GZipMiddleware
from apscheduler.schedulers.background import BackgroundScheduler

import uuid
from fastapi import Depends
from models import (
    init_db, SessionLocal, Run, DailySteps, ChatMessage, User, ProviderCredential, Goal, ApiToken,
    DEFAULT_USER_ID, owned_by, get_sync_meta, set_sync_meta, user_key,
)
import auth
import strava
import stats
from util import local_today

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(level=LOG_LEVEL)
log = logging.getLogger("runlog")
log.setLevel(LOG_LEVEL)

app = FastAPI(title="HALE")
app.add_middleware(GZipMiddleware, minimum_size=1000)


@app.middleware("http")
async def _no_cache_static(request: Request, call_next):
    """Force browsers to revalidate (not blindly reuse a heuristically-cached copy) on
    every request — StaticFiles already sends ETag/Last-Modified, so revalidation is a
    cheap 304 when nothing changed, but without this header a plain reload after a
    deploy can silently keep serving pre-deploy JS/CSS. Applies to everything (low-
    traffic personal LAN app, no real caching win to give up)."""
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-cache, must-revalidate"
    return response

SYNC_INTERVAL_HOURS = int(os.environ.get("SYNC_INTERVAL_HOURS", "6"))
SYNC_LIMIT = int(os.environ.get("SYNC_ACTIVITY_LIMIT", "10"))


def _next_auto_sync_time():
    """Fire immediately on a genuinely fresh start (no recent sync on record), but
    don't re-trigger a real Strava sync on every container restart if one already ran
    recently — e.g. a burst of redeploys during active development previously fired a
    real auto-sync on every single one of them, since next_run_time=datetime.now() was
    unconditional. Only delays the *first* scheduled run; the recurring interval after
    that is unaffected. Checks DEFAULT_USER_ID's own last-synced-at specifically (a
    deliberate simplification, Phase 1.4) — this is a one-time scheduler-startup
    heuristic to avoid hammering Strava right after a redeploy, not per-user data, and
    _auto_sync() below already re-syncs every credentialed user on every tick regardless."""
    last = get_sync_meta(user_key(DEFAULT_USER_ID, "strava_last_synced_at"))
    if last:
        try:
            last_dt = datetime.fromisoformat(last)
            remaining = timedelta(hours=SYNC_INTERVAL_HOURS) - (datetime.now(timezone.utc) - last_dt)
            if remaining > timedelta(0):
                return datetime.now() + remaining
        except Exception:
            pass
    return datetime.now()


@app.on_event("startup")
def startup():
    init_db()
    scheduler = BackgroundScheduler()
    scheduler.add_job(_auto_sync, "interval", hours=SYNC_INTERVAL_HOURS, next_run_time=_next_auto_sync_time())
    scheduler.start()
    log.info(f"Auto-sync scheduled every {SYNC_INTERVAL_HOURS}h")


DASHBOARD_CACHE_KEY = "dashboard_summary_cache"
DASHBOARD_CACHE_UPDATED_AT_KEY = "dashboard_summary_cache_updated_at"


def _refresh_dashboard_cache(user_id: str):
    """Recomputes the Home tab's stat-card data and caches it in sync_meta (reusing the
    existing generic key-value store rather than a new single-purpose table — same
    pattern already used for the geocode cache) so /api/dashboard/summary is a plain
    lookup instead of recomputing 8 stats functions on every page load. Called from
    _record_sync, the one place every sync path (auto/manual Strava, manual Garmin,
    both backlog syncs) already funnels through, so the cache is refreshed at least as
    often as SYNC_INTERVAL_HOURS even on a day with zero new activities — day-counting
    stats like "days since longest run" still need to advance without new data."""
    db = SessionLocal()
    try:
        summary = stats.dashboard_summary(db, user_id=user_id)
        set_sync_meta(user_key(user_id, DASHBOARD_CACHE_KEY), json.dumps(summary))
        set_sync_meta(user_key(user_id, DASHBOARD_CACHE_UPDATED_AT_KEY), datetime.now(timezone.utc).isoformat())
    except Exception as e:
        log.warning(f"Dashboard cache refresh failed (stale cache will keep serving): {e}")
    finally:
        db.close()


def _record_sync(source: str, user_id: str, count: int = None, error: str = None):
    """Persist last-sync info to sync_meta so the UI can show real history
    across page loads instead of only reflecting the current browser session.
    A sync can partially succeed and then error (e.g. Garmin rate-limits mid-backlog
    after committing several real activities) — count and error aren't mutually
    exclusive, so both are recorded when both are given, instead of a real partial
    success being silently lost behind "Never synced". Namespaced per-user (Phase 1.4)
    so two real users' sync history never overwrites each other's."""
    if count is not None:
        set_sync_meta(user_key(user_id, f"{source}_last_synced_at"), datetime.now(timezone.utc).isoformat())
        set_sync_meta(user_key(user_id, f"{source}_last_count"), str(count))
    set_sync_meta(user_key(user_id, f"{source}_last_error"), error or "")
    _refresh_dashboard_cache(user_id)


def _users_with_credential(provider: str):
    db = SessionLocal()
    try:
        return [c.user_id for c in db.query(ProviderCredential).filter_by(provider=provider).all()]
    finally:
        db.close()


def _auto_sync():
    """Runs for every user with a Strava credential on file, not just one hardcoded
    account — today that's still just DEFAULT_USER_ID in practice (no real login exists
    yet), but the loop itself is already correct for whenever there's more than one."""
    for user_id in _users_with_credential("strava"):
        set_sync_meta(user_key(user_id, "strava_last_error"), "")
        try:
            n = strava.sync_activities(user_id, limit=SYNC_LIMIT)
            _record_sync("strava", user_id, count=n)
            log.info(f"Auto-sync: upserted {n} runs from Strava for {user_id}")
        except Exception as e:
            _record_sync("strava", user_id, error=str(e))
            log.warning(f"Auto-sync skipped for {user_id}: {e}")


# ---------- Strava OAuth ----------
@app.get("/auth/strava/login")
def strava_login():
    return RedirectResponse(strava.get_authorize_url())


@app.get("/auth/strava/callback")
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


@app.get("/api/strava/status")
def strava_status(user_id: str = Depends(auth.current_user_id)):
    token = strava.get_valid_access_token(user_id)
    return {"connected": token is not None}


# ---------- Sync ("Sync Now" — runs as a background job with live status, same shape
# as backlog sync below, since a Garmin quick sync alone (login + wellness + adaptive
# plan + per-activity detail fetches) can genuinely take long enough that a blocking
# request with a static "Syncing…" label isn't good enough feedback) ----------
_QUICK_SYNC_LOG_LIMIT = 50
_quick_sync_lock = threading.Lock()
# Keyed by (user_id, source) rather than a source-only dict (Phase 1.4) — lazily
# created on first use via _get_quick_sync_job, since the set of real users isn't
# known ahead of time the way the 2 fixed sources were.
_quick_sync_jobs: dict = {}


def _new_job_state() -> dict:
    return {"status": "idle", "count": 0, "log": [], "startedAt": None, "finishedAt": None, "error": None}


def _get_quick_sync_job(user_id: str, source: str) -> dict:
    return _quick_sync_jobs.setdefault((user_id, source), _new_job_state())


def _quick_sync_progress(user_id: str, source: str, msg: str, count: int = None):
    with _quick_sync_lock:
        job = _get_quick_sync_job(user_id, source)
        job["log"].append(f"{datetime.now().strftime('%H:%M:%S')}  {msg}")
        job["log"] = job["log"][-_QUICK_SYNC_LOG_LIMIT:]
        if count is not None:
            job["count"] = count


def _run_quick_sync(user_id: str, source: str):
    try:
        cb = lambda msg, count=None: _quick_sync_progress(user_id, source, msg, count)
        if source == "strava":
            n = strava.sync_activities(user_id, limit=SYNC_LIMIT, progress_cb=cb)
        else:
            import garmin_sync
            n = garmin_sync.sync_garmin_activities(user_id, limit=SYNC_LIMIT, progress_cb=cb)
        with _quick_sync_lock:
            job = _get_quick_sync_job(user_id, source)
            job["status"] = "done"
            job["count"] = n
            job["finishedAt"] = datetime.now(timezone.utc).isoformat()
        _record_sync(source, user_id, count=n)
        _quick_sync_progress(user_id, source, f"Done — {n} runs upserted")
    except Exception as e:
        msg = str(e)
        with _quick_sync_lock:
            job = _get_quick_sync_job(user_id, source)
            job["status"] = "error"
            job["error"] = msg
            job["finishedAt"] = datetime.now(timezone.utc).isoformat()
        # A rate-limit error mid-sync still carries real progress (see
        # GarminMidSyncRateLimitError.synced_count) — record it as a partial success,
        # not just an error, so "Last synced" doesn't misleadingly say "Never".
        _record_sync(source, user_id, count=getattr(e, "synced_count", None), error=msg)
        _quick_sync_progress(user_id, source, f"Error: {msg}")


@app.post("/api/sync/{source}")
def manual_sync(source: str, user_id: str = Depends(auth.current_user_id)):
    if source not in ("strava", "garmin"):
        raise HTTPException(404, "Unknown source")
    if source == "strava" and not strava.get_valid_access_token(user_id):
        raise HTTPException(400, "Not authenticated with Strava — visit /auth/strava/login first")
    if source == "garmin" and not _has_credential(user_id, "garmin"):
        raise HTTPException(400, "Add your Garmin credentials in Settings → Connections to use this")

    with _quick_sync_lock:
        job = _get_quick_sync_job(user_id, source)
        if job["status"] == "running":
            raise HTTPException(409, "Sync already running")
        job.update({"status": "running", "count": 0, "log": [], "startedAt": datetime.now(timezone.utc).isoformat(),
                    "finishedAt": None, "error": None})

    set_sync_meta(user_key(user_id, f"{source}_last_error"), "")  # clear any stale error the moment a new attempt starts, not just on success
    threading.Thread(target=_run_quick_sync, args=(user_id, source), daemon=True).start()
    return {"status": "started"}


@app.get("/api/sync/{source}/status")
def quick_sync_status(source: str, user_id: str = Depends(auth.current_user_id)):
    if source not in ("strava", "garmin"):
        raise HTTPException(404, "Unknown source")
    with _quick_sync_lock:
        return dict(_get_quick_sync_job(user_id, source))


@app.post("/api/garmin/import")
async def import_garmin_export(file: UploadFile = File(...), user_id: str = Depends(auth.current_user_id)):
    """One-time bulk import from Garmin Connect's official data-export ZIP (requested via
    account.garmin.com, separate from the live unofficial-API sync above). Lets historical
    activities/steps come from a file instead of the rate-limited live API — the live
    sync's own dedup (run_needs_detail_sync) means anything this import already covers
    is automatically skipped on future syncs, so the live API only has to handle activities
    genuinely newer than the export. Safe to re-upload the same or an overlapping export."""
    import garmin_import
    data = await file.read()
    log.info(f"garmin import: received {file.filename} ({len(data)} bytes)")
    summary = garmin_import.import_garmin_export(data, user_id)
    return summary


@app.get("/api/sync/meta")
def sync_meta(user_id: str = Depends(auth.current_user_id)):
    def info(source: str):
        count = get_sync_meta(user_key(user_id, f"{source}_last_count"))
        return {
            "lastSyncedAt": get_sync_meta(user_key(user_id, f"{source}_last_synced_at")),
            "lastCount": int(count) if count is not None else None,
            "lastError": get_sync_meta(user_key(user_id, f"{source}_last_error")) or None,
        }
    return {"strava": info("strava"), "garmin": info("garmin")}


# ---------- Backlog sync (full history, runs as a background job) ----------
_BACKLOG_LOG_LIMIT = 200
_backlog_lock = threading.Lock()
# Keyed by (user_id, source) — see the quick-sync job dict above for why.
_backlog_jobs: dict = {}


def _get_backlog_job(user_id: str, source: str) -> dict:
    return _backlog_jobs.setdefault((user_id, source), _new_job_state())


def _backlog_progress(user_id: str, source: str, msg: str, count: int = None):
    with _backlog_lock:
        job = _get_backlog_job(user_id, source)
        job["log"].append(f"{datetime.now().strftime('%H:%M:%S')}  {msg}")
        job["log"] = job["log"][-_BACKLOG_LOG_LIMIT:]
        if count is not None:
            job["count"] = count


def _run_backlog_sync(user_id: str, source: str):
    try:
        if source == "strava":
            n = strava.sync_all_activities(user_id, progress_cb=lambda msg, count=None: _backlog_progress(user_id, source, msg, count))
        else:
            import garmin_sync
            # Auto-continue through rate limits instead of stopping and requiring a
            # manual re-click: this thread is already backgrounded, so waiting out the
            # cooldown (garmin_sync's own exponential backoff, 5min base, capped at 4h)
            # and retrying in place is strictly better than surfacing an error the user
            # has to notice and act on. Only a genuinely non-rate-limit failure (bad
            # credentials, a real bug) still propagates immediately below.
            total = 0
            while True:
                base = total

                def _progress(msg, count=None, base=base):
                    _backlog_progress(user_id, source, msg, (base + count) if count is not None else None)

                try:
                    total += garmin_sync.sync_all_garmin_activities(user_id, progress_cb=_progress)
                    break
                except Exception as e:
                    if not garmin_sync.is_rate_limit_related(e):
                        raise
                    wait = garmin_sync._garmin_cooldown_remaining_sec(user_id) + 5
                    _backlog_progress(
                        user_id, source,
                        f"Rate-limited — auto-retrying in {wait / 60:.1f} min, no need to click again…",
                    )
                    time.sleep(wait)
            n = total
        with _backlog_lock:
            job = _get_backlog_job(user_id, source)
            job["status"] = "done"
            job["count"] = n
            job["finishedAt"] = datetime.now(timezone.utc).isoformat()
        _record_sync(f"{source}_backlog", user_id, count=n)
        _backlog_progress(user_id, source, f"Done — {n} runs upserted")
    except Exception as e:
        msg = str(e)
        with _backlog_lock:
            job = _get_backlog_job(user_id, source)
            job["status"] = "error"
            job["error"] = msg
            job["finishedAt"] = datetime.now(timezone.utc).isoformat()
        # A rate-limit error mid-backlog still carries real progress (see
        # GarminMidSyncRateLimitError.synced_count) — record it as a partial success,
        # not just an error, so "Last synced" doesn't misleadingly say "Never" even
        # though real activities were committed before the failure.
        _record_sync(f"{source}_backlog", user_id, count=getattr(e, "synced_count", None), error=msg)
        _backlog_progress(user_id, source, f"Error: {msg}")


def _has_credential(user_id: str, provider: str) -> bool:
    db = SessionLocal()
    try:
        cred = db.query(ProviderCredential).filter_by(user_id=user_id, provider=provider).first()
        if provider == "garmin":
            return bool(cred and cred.username and cred.password)
        return bool(cred and cred.access_token)
    finally:
        db.close()


@app.post("/api/sync/{source}/backlog")
def start_backlog_sync(source: str, user_id: str = Depends(auth.current_user_id)):
    if source not in ("strava", "garmin"):
        raise HTTPException(404, "Unknown source")
    if source == "strava" and not strava.get_valid_access_token(user_id):
        raise HTTPException(400, "Not authenticated with Strava — visit /auth/strava/login first")
    if source == "garmin" and not _has_credential(user_id, "garmin"):
        raise HTTPException(400, "Add your Garmin credentials in Settings → Connections to use this")

    with _backlog_lock:
        job = _get_backlog_job(user_id, source)
        if job["status"] == "running":
            raise HTTPException(409, "Backlog sync already running")
        job.update({"status": "running", "count": 0, "log": [], "startedAt": datetime.now(timezone.utc).isoformat(),
                    "finishedAt": None, "error": None})

    # Clear the *persisted* last-error too, not just the in-memory job state above —
    # otherwise the old error stays visible in "last completed" for the whole duration
    # of this new run, since sync_meta only gets overwritten when _run_backlog_sync
    # finishes.
    set_sync_meta(user_key(user_id, f"{source}_backlog_last_error"), "")

    threading.Thread(target=_run_backlog_sync, args=(user_id, source), daemon=True).start()
    return {"status": "started"}


@app.get("/api/sync/{source}/backlog/status")
def backlog_status(source: str, user_id: str = Depends(auth.current_user_id)):
    if source not in ("strava", "garmin"):
        raise HTTPException(404, "Unknown source")
    with _backlog_lock:
        job = dict(_get_backlog_job(user_id, source))

    last_count = get_sync_meta(user_key(user_id, f"{source}_backlog_last_count"))
    job["lastCompleted"] = {
        "syncedAt": get_sync_meta(user_key(user_id, f"{source}_backlog_last_synced_at")),
        "count": int(last_count) if last_count is not None else None,
        "error": get_sync_meta(user_key(user_id, f"{source}_backlog_last_error")) or None,
    }
    return job


# ---------- Connections (per-user provider credentials — Settings tab) ----------
@app.get("/api/connections")
def get_connections(user_id: str = Depends(auth.current_user_id)):
    db = SessionLocal()
    try:
        creds = db.query(ProviderCredential).filter_by(user_id=user_id).all()
        return [{"provider": c.provider, "username": c.username} for c in creds]
    finally:
        db.close()


@app.post("/api/connections/garmin")
async def set_garmin_connection(request: Request, user_id: str = Depends(auth.current_user_id)):
    body = await request.json()
    username, password = body.get("username"), body.get("password")
    if not username or not password:
        raise HTTPException(400, "username and password are required")
    db = SessionLocal()
    try:
        cred = db.query(ProviderCredential).filter_by(user_id=user_id, provider="garmin").first()
        if not cred:
            cred = ProviderCredential(user_id=user_id, provider="garmin",
                                       created_at=datetime.now(timezone.utc).isoformat())
            db.add(cred)
        cred.username = username
        cred.password = password
        db.commit()
        return {"status": "saved"}
    finally:
        db.close()


@app.delete("/api/connections/{provider}")
def delete_connection(provider: str, user_id: str = Depends(auth.current_user_id)):
    db = SessionLocal()
    try:
        cred = db.query(ProviderCredential).filter_by(user_id=user_id, provider=provider).first()
        if cred:
            db.delete(cred)
            db.commit()
        return {"deleted": True}
    finally:
        db.close()


# ---------- API tokens (Phase 1.5 — device/headless-client auth, e.g. the Android
# client planned for Phase 3, or any script hitting the ingest endpoint planned for
# Phase 2.2). Meaningful even with AUTH_MODE=disabled: the tokens themselves are
# created and listed now, ready to actually authenticate the moment AUTH_MODE is
# turned on and a caller starts sending X-Api-Token — see app/auth.py. ----------
@app.get("/api/tokens")
def list_tokens(user_id: str = Depends(auth.current_user_id)):
    db = SessionLocal()
    try:
        rows = db.query(ApiToken).filter(ApiToken.user_id == user_id).order_by(ApiToken.created_at.desc()).all()
        return [{"id": t.id, "name": t.name, "createdAt": t.created_at, "lastUsedAt": t.last_used_at} for t in rows]
    finally:
        db.close()


@app.post("/api/tokens")
async def create_token(request: Request, user_id: str = Depends(auth.current_user_id)):
    """Returns the raw token exactly once — only its SHA-256 hash is ever persisted
    (see ApiToken/auth._verify_api_token), so this response is the only chance to see it."""
    body = await request.json()
    name = (body.get("name") or "").strip() or None
    raw_token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
    db = SessionLocal()
    try:
        row = ApiToken(
            id=f"tok_{uuid.uuid4().hex[:12]}", user_id=user_id, token_hash=token_hash,
            name=name, created_at=datetime.now(timezone.utc).isoformat(),
        )
        db.add(row)
        db.commit()
        return {"id": row.id, "name": row.name, "createdAt": row.created_at, "token": raw_token}
    finally:
        db.close()


@app.delete("/api/tokens/{token_id}")
def delete_token(token_id: str, user_id: str = Depends(auth.current_user_id)):
    db = SessionLocal()
    try:
        row = db.query(ApiToken).filter(ApiToken.id == token_id, ApiToken.user_id == user_id).first()
        if row:
            db.delete(row)
            db.commit()
        return {"deleted": True}
    finally:
        db.close()


# ---------- Web Push (Phase 0.11, PWA push notifications) ----------
@app.get("/api/push/vapid-public-key")
def get_vapid_public_key():
    """Unauthenticated on purpose — this is a public key by definition (it's handed to
    PushManager.subscribe() client-side), same non-secret status as an OAuth client id."""
    import push
    return {"configured": push.is_configured(), "publicKey": push.VAPID_PUBLIC_KEY}


@app.post("/api/push/subscribe")
async def push_subscribe(request: Request, user_id: str = Depends(auth.current_user_id)):
    import push
    body = await request.json()
    endpoint = body.get("endpoint")
    keys = body.get("keys") or {}
    if not endpoint or not keys.get("p256dh") or not keys.get("auth"):
        raise HTTPException(400, "endpoint and keys.p256dh/keys.auth are required")
    db = SessionLocal()
    try:
        push.subscribe(db, user_id, endpoint, keys["p256dh"], keys["auth"])
        return {"subscribed": True}
    finally:
        db.close()


@app.post("/api/push/unsubscribe")
async def push_unsubscribe(request: Request, user_id: str = Depends(auth.current_user_id)):
    import push
    body = await request.json()
    endpoint = body.get("endpoint")
    if not endpoint:
        raise HTTPException(400, "endpoint is required")
    db = SessionLocal()
    try:
        push.unsubscribe(db, user_id, endpoint)
        return {"unsubscribed": True}
    finally:
        db.close()


@app.post("/api/push/test")
def push_test(user_id: str = Depends(auth.current_user_id)):
    """Sends a real notification to every device this user has subscribed — the one
    genuinely useful verification hook, independent of any feature (daily insight,
    generated workout) that would otherwise trigger a push, since neither exists yet."""
    import push
    if not push.is_configured():
        raise HTTPException(400, "Push not configured — set VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY")
    db = SessionLocal()
    try:
        sent = push.send_push(db, user_id, "HALE", "Push notifications are working.", "/")
        return {"sent": sent}
    finally:
        db.close()


# ---------- Settings ----------
@app.get("/api/garmin/status")
def garmin_status(user_id: str = Depends(auth.current_user_id)):
    return {"configured": _has_credential(user_id, "garmin")}


@app.get("/api/garmin/route-diagnostics")
def garmin_route_diagnostics(user_id: str = Depends(auth.current_user_id)):
    """How Garmin runs' routes were actually sourced — surfaces whether the FIT-derived
    unmasked path is really firing (vs. falling back to Garmin Connect's summary API,
    which independent testing found clips ~500m near a privacy-zone-protected location)
    without digging through container logs."""
    db = SessionLocal()
    try:
        rows = db.query(Run.route_source).filter(Run.source == "garmin", owned_by(Run.user_id, user_id)).all()
        counts = {"fit_record_stream": 0, "geopolyline_summary": 0, "none": 0, "unknown": 0}
        for (source,) in rows:
            counts[source if source in counts else "unknown"] += 1
        return counts
    finally:
        db.close()


@app.get("/api/config")
def get_config(user_id: str = Depends(auth.current_user_id)):
    import push
    db = SessionLocal()
    try:
        resting_hr = stats.latest_resting_hr_bpm(db, user_id)
    finally:
        db.close()
    return {
        "syncIntervalHours": SYNC_INTERVAL_HOURS,
        "syncActivityLimit": SYNC_LIMIT,
        "restingHrBpm": resting_hr,
        "pushConfigured": push.is_configured(),
    }


# ---------- Geocoding (for the Map tab's location labels) ----------
_last_nominatim_call = 0.0


@app.get("/api/geocode")
def geocode(lat: float, lon: float):
    """Reverse-geocode a lat/lon to a place name, cached in sync_meta (shared across every
    browser/device, unlike a client-side cache) so each real-world location is only ever
    looked up once."""
    key = f"geocode_{lat:.2f}_{lon:.2f}"
    cached = get_sync_meta(key)
    if cached:
        return {"label": cached, "cached": True}

    global _last_nominatim_call
    elapsed = time.monotonic() - _last_nominatim_call
    if elapsed < 1.1:
        time.sleep(1.1 - elapsed)
    _last_nominatim_call = time.monotonic()

    try:
        resp = requests.get(
            "https://nominatim.openstreetmap.org/reverse",
            params={"format": "json", "lat": lat, "lon": lon, "zoom": 10, "addressdetails": 1},
            headers={"User-Agent": "RunLog/1.0 (self-hosted personal running tracker)"},
            timeout=10,
        )
        data = resp.json()
        addr = data.get("address", {})
        place = addr.get("city") or addr.get("town") or addr.get("village") or addr.get("county") \
            or (data.get("display_name") or "").split(",")[0]
        label = f"{place}, {addr['state']}" if place and addr.get("state") else (place or f"{lat:.2f}, {lon:.2f}")
    except Exception:
        label = f"{lat:.2f}, {lon:.2f}"

    set_sync_meta(key, label)
    return {"label": label, "cached": False}


# ---------- Daily steps (Garmin-only) ----------
@app.get("/api/steps")
def get_steps(days: int = 30, user_id: str = Depends(auth.current_user_id)):
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")
    db = SessionLocal()
    try:
        rows = (db.query(DailySteps).filter(DailySteps.date >= cutoff)
                .filter(owned_by(DailySteps.user_id, user_id)).order_by(DailySteps.date).all())
        return [{"date": r.date, "steps": r.steps} for r in rows]
    finally:
        db.close()


# ---------- Wellness: resting HR / VO2max / sleep (Garmin-only) ----------
@app.get("/api/wellness")
def get_wellness(days: int = 90, user_id: str = Depends(auth.current_user_id)):
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")
    db = SessionLocal()
    try:
        rows = (db.query(DailySteps).filter(DailySteps.date >= cutoff)
                .filter(owned_by(DailySteps.user_id, user_id)).order_by(DailySteps.date).all())
        return [{
            "date": r.date,
            "restingHrBpm": r.resting_hr_bpm,
            "vo2max": r.vo2max,
            "sleepScore": r.sleep_score,
            "sleepSeconds": r.sleep_seconds,
            "deepSleepSeconds": r.deep_sleep_seconds,
            "lightSleepSeconds": r.light_sleep_seconds,
            "remSleepSeconds": r.rem_sleep_seconds,
            "awakeSleepSeconds": r.awake_sleep_seconds,
        } for r in rows]
    finally:
        db.close()


@app.get("/api/wellness/sleep-stages")
def get_sleep_stages(date: str = None, user_id: str = Depends(auth.current_user_id)):
    """Per-night sleep stage timeline (deep/light/rem/awake segments), for a real
    hypnogram rather than just daily totals — see garmin_sync._extract_sleep_stages().
    Returns every date that has stage data (for a night-picker) plus the requested
    (or most recent) night's segments."""
    db = SessionLocal()
    try:
        rows = (db.query(DailySteps)
                .filter(DailySteps.sleep_stages_json.isnot(None))
                .filter(DailySteps.sleep_stages_json != "[]")
                .filter(owned_by(DailySteps.user_id, user_id))
                .order_by(DailySteps.date).all())
        available_dates = [r.date for r in rows]
        if not available_dates:
            return {"availableDates": [], "date": None, "segments": []}
        target_row = next((r for r in rows if r.date == date), rows[-1])
        return {
            "availableDates": available_dates,
            "date": target_row.date,
            "segments": json.loads(target_row.sleep_stages_json or "[]"),
        }
    finally:
        db.close()


# ---------- Runs CRUD ----------
def _run_to_dict(r: Run):
    return {
        "id": r.id, "source": r.source, "activityType": r.activity_type, "date": r.date, "startTime": r.start_time,
        "name": r.name, "distanceMi": r.distance_mi, "movingTimeSec": r.moving_time_sec,
        "elevGainFt": r.elev_gain_ft, "avgHR": r.avg_hr, "maxHR": r.max_hr,
        "avgCadence": r.avg_cadence, "avgPaceSecPerMi": r.avg_pace_sec_per_mi,
        "isTreadmill": r.is_treadmill, "tempF": r.temp_f, "weatherCondition": r.weather_condition,
        "heatIndexF": r.heat_index_f, "wetBulbF": r.wet_bulb_f,
        "suggestedType": r.suggested_type, "type": r.type_override or r.suggested_type,
        "rpe": r.rpe, "notes": r.notes,
        "splits": json.loads(r.splits_json or "[]"),
        "intervals": json.loads(r.intervals_json or "[]"),
        "recovery": json.loads(r.recovery_json or "[]"),
        "route": json.loads(r.route_json or "[]"),
        "routeMetrics": json.loads(r.route_metrics_json or "[]"),
        "verticalOscillationMm": r.vertical_oscillation_mm, "groundContactTimeMs": r.ground_contact_time_ms,
        "verticalRatioPct": r.vertical_ratio_pct, "strideLengthM": r.stride_length_m, "avgPowerWatts": r.avg_power_watts,
        "exerciseSets": json.loads(r.exercise_sets_json) if r.exercise_sets_json else None,
    }


DEFAULT_RUNS_WINDOW_DAYS = 90


@app.get("/api/runs")
def get_runs(start: str | None = None, end: str | None = None, all_time: bool = Query(False, alias="all"),
             user_id: str = Depends(auth.current_user_id)):
    """Windowed by default (Phase 0.5 — this used to return every activity ever
    synced unconditionally, a multi-MB payload on every page load). `all=true`
    bypasses the window entirely — used by callers that need true all-time totals
    (e.g. the Home tab's exact stat-strip numbers, see web/src/hooks/useRuns.ts)
    rather than trying to guess a "big enough" default range for every caller."""
    db = SessionLocal()
    try:
        q = db.query(Run).filter(owned_by(Run.user_id, user_id))
        if not all_time:
            if not start and not end:
                start = (local_today() - timedelta(days=DEFAULT_RUNS_WINDOW_DAYS - 1)).isoformat()
            if start:
                q = q.filter(Run.date >= start)
            if end:
                q = q.filter(Run.date <= end)
        runs = q.order_by(Run.date.desc()).all()
        return [_run_to_dict(r) for r in runs]
    finally:
        db.close()


@app.patch("/api/runs/{run_id}")
async def update_run(run_id: str, request: Request, user_id: str = Depends(auth.current_user_id)):
    body = await request.json()
    db = SessionLocal()
    try:
        run = db.query(Run).filter(Run.id == run_id, owned_by(Run.user_id, user_id)).first()
        if not run:
            raise HTTPException(404, "Run not found")
        if "type" in body:
            run.type_override = body["type"]
        if "tempF" in body:
            run.temp_f = body["tempF"]
        if "weatherCondition" in body:
            run.weather_condition = body["weatherCondition"]
        if "rpe" in body:
            run.rpe = body["rpe"]
        if "isTreadmill" in body:
            run.is_treadmill = body["isTreadmill"]
        if "notes" in body:
            run.notes = body["notes"]
        db.commit()
        return _run_to_dict(run)
    finally:
        db.close()


# ---------- AI Chat Assistant ----------
@app.get("/api/chat/status")
def chat_status():
    import assistant
    return {"configured": assistant.is_configured()}


@app.get("/api/chat/history")
def chat_history(user_id: str = Depends(auth.current_user_id)):
    db = SessionLocal()
    try:
        rows = (db.query(ChatMessage).filter(owned_by(ChatMessage.user_id, user_id))
                .order_by(ChatMessage.id).all())
        return [{
            "role": r.role, "content": r.content,
            "toolCalls": json.loads(r.tool_calls_json) if r.tool_calls_json else None,
            "charts": json.loads(r.charts_json) if r.charts_json else None,
            "createdAt": r.created_at,
        } for r in rows]
    finally:
        db.close()


@app.post("/api/chat/message")
async def chat_message(request: Request, user_id: str = Depends(auth.current_user_id)):
    import assistant
    if not assistant.is_configured():
        raise HTTPException(400, "AI assistant not configured — set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY")
    body = await request.json()
    message = (body.get("message") or "").strip()
    if not message:
        raise HTTPException(400, "message is required")
    try:
        return await assistant.send_message(message, user_id)
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/api/chat/reset")
async def chat_reset(user_id: str = Depends(auth.current_user_id)):
    import assistant
    db = SessionLocal()
    try:
        db.query(ChatMessage).filter(owned_by(ChatMessage.user_id, user_id)).delete(synchronize_session=False)
        db.commit()
    finally:
        db.close()
    await assistant.reset_client(user_id)
    return {"status": "reset"}


@app.get("/api/coach/personality")
def get_coach_personality(user_id: str = Depends(auth.current_user_id)):
    db = SessionLocal()
    try:
        user = db.get(User, user_id)
        return {"personality": (user.coach_personality if user else None) or "normal"}
    finally:
        db.close()


@app.post("/api/coach/personality")
async def set_coach_personality(request: Request, user_id: str = Depends(auth.current_user_id)):
    import assistant
    import coach
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


@app.get("/api/health-notes")
def get_health_notes(status: str = None, category: str = None, user_id: str = Depends(auth.current_user_id)):
    """Read-only — no POST/PATCH/DELETE. Health-note lifecycle is chat-tool-driven
    only (see coach.py's log_health_note/update_health_status), not a manual form."""
    import coach
    db = SessionLocal()
    try:
        return coach.list_health_notes(db, status, category, user_id)
    finally:
        db.close()


# ---------- Workouts (manual-UI path — mirrors the schedule_workout/update_workout
# chat tools exactly, both call into coach.py so validation can't drift between them) ----------
@app.get("/api/workouts")
def get_workouts(startDate: str = None, endDate: str = None, status: str = None,
                  user_id: str = Depends(auth.current_user_id)):
    import coach
    db = SessionLocal()
    try:
        return coach.list_workouts(db, startDate, endDate, status, user_id)
    finally:
        db.close()


@app.post("/api/workouts")
async def create_workout_endpoint(request: Request, user_id: str = Depends(auth.current_user_id)):
    import coach
    body = await request.json()
    db = SessionLocal()
    try:
        return coach.create_workout(
            db, body.get("scheduledDate"), body.get("workoutType"), body.get("activityType"),
            body.get("targetDistanceMi"), body.get("targetPaceSecPerMi"), body.get("targetDurationSec"),
            body.get("notes"), body.get("steps"), user_id=user_id,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    finally:
        db.close()


@app.patch("/api/workouts/{workout_id}")
async def update_workout_endpoint(workout_id: str, request: Request, user_id: str = Depends(auth.current_user_id)):
    import coach
    body = await request.json()
    field_map = {
        "scheduledDate": "scheduled_date", "workoutType": "workout_type", "activityType": "activity_type",
        "targetDistanceMi": "target_distance_mi", "targetPaceSecPerMi": "target_pace_sec_per_mi",
        "targetDurationSec": "target_duration_sec", "notes": "notes", "steps": "steps", "status": "status",
    }
    fields = {py_key: body[api_key] for api_key, py_key in field_map.items() if api_key in body}
    db = SessionLocal()
    try:
        return coach.update_workout(db, workout_id, user_id=user_id, **fields)
    except ValueError as e:
        raise HTTPException(400, str(e))
    finally:
        db.close()


@app.delete("/api/workouts/{workout_id}")
def delete_workout_endpoint(workout_id: str, user_id: str = Depends(auth.current_user_id)):
    import coach
    db = SessionLocal()
    try:
        coach.delete_workout(db, workout_id, user_id)
        return {"deleted": True}
    finally:
        db.close()


# ---------- Recovery tools/sessions (read-only tool list + coach-driven session log —
# no POST here: recommend_recovery_session is chat-tool-driven only, same reasoning as
# health-notes above; manual creation isn't built yet, see coach.py's RecoveryTool docstring) ----------
@app.get("/api/recovery-tools")
def get_recovery_tools_endpoint(user_id: str = Depends(auth.current_user_id)):
    import coach
    db = SessionLocal()
    try:
        return coach.list_recovery_tools(db, user_id)
    finally:
        db.close()


@app.get("/api/recovery-sessions")
def get_recovery_sessions_endpoint(startDate: str = None, endDate: str = None, status: str = None,
                                    user_id: str = Depends(auth.current_user_id)):
    import coach
    db = SessionLocal()
    try:
        return coach.list_recovery_sessions(db, startDate, endDate, status, user_id)
    finally:
        db.close()


@app.patch("/api/recovery-sessions/{session_id}")
async def update_recovery_session_endpoint(session_id: str, request: Request, user_id: str = Depends(auth.current_user_id)):
    import coach
    body = await request.json()
    db = SessionLocal()
    try:
        return coach.update_recovery_session_status(db, session_id, body.get("status"), user_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    finally:
        db.close()


@app.delete("/api/recovery-sessions/{session_id}")
def delete_recovery_session_endpoint(session_id: str, user_id: str = Depends(auth.current_user_id)):
    import coach
    db = SessionLocal()
    try:
        coach.delete_recovery_session(db, session_id, user_id)
        return {"deleted": True}
    finally:
        db.close()


# ---------- Dashboard (real computed stats, no LLM involved) ----------
@app.get("/api/dashboard/summary")
def dashboard_summary(user_id: str = Depends(auth.current_user_id)):
    cached = get_sync_meta(user_key(user_id, DASHBOARD_CACHE_KEY))
    if cached:
        try:
            return json.loads(cached)
        except (TypeError, ValueError):
            pass  # corrupt cache entry — fall through to live compute below
    # Cache miss (fresh install, or the cache write never ran yet) — compute live once
    # and populate the cache so every subsequent load is a plain lookup.
    db = SessionLocal()
    try:
        summary = stats.dashboard_summary(db, user_id=user_id)
    finally:
        db.close()
    set_sync_meta(user_key(user_id, DASHBOARD_CACHE_KEY), json.dumps(summary))
    set_sync_meta(user_key(user_id, DASHBOARD_CACHE_UPDATED_AT_KEY), datetime.now(timezone.utc).isoformat())
    return summary


# ---------- Goals ----------
_VALID_GOAL_TYPES = ("race", "consistency", "distance_target")


def _goal_to_dict(g: Goal, db):
    # goal_progress() can mutate g.status/g.completed_at as a side effect (auto-completing
    # a race goal once it finds a matching run — see stats._find_and_link_race_run). Must
    # run before status/completedAt are read below: a dict literal evaluates its values in
    # written order, so reading them first would silently capture the pre-mutation values.
    progress = stats.goal_progress(db, g)
    return {
        "id": g.id, "goalType": g.goal_type, "name": g.name, "status": g.status,
        "activityTypes": json.loads(g.activity_types_json or "[]"),
        "targetValue": g.target_value, "targetUnit": g.target_unit, "targetDate": g.target_date,
        "startDate": g.start_date, "notes": g.notes, "priority": g.priority or 0,
        "createdAt": g.created_at, "completedAt": g.completed_at,
        "progress": progress,
    }


@app.get("/api/goals")
def get_goals(user_id: str = Depends(auth.current_user_id)):
    db = SessionLocal()
    try:
        goals = (db.query(Goal).filter(owned_by(Goal.user_id, user_id))
                 .order_by(Goal.status, func.coalesce(Goal.priority, 0), Goal.target_date).all())
        return [_goal_to_dict(g, db) for g in goals]
    finally:
        db.close()


@app.post("/api/goals")
async def create_goal(request: Request, user_id: str = Depends(auth.current_user_id)):
    body = await request.json()
    if body.get("goalType") not in _VALID_GOAL_TYPES:
        raise HTTPException(400, f"goalType must be one of {_VALID_GOAL_TYPES}")
    db = SessionLocal()
    try:
        g = Goal(
            id=f"goal_{uuid.uuid4().hex[:12]}", user_id=user_id,
            goal_type=body["goalType"], name=body.get("name") or "Untitled goal", status="active",
            activity_types_json=json.dumps(body.get("activityTypes") or ["Run"]),
            target_value=body.get("targetValue"), target_unit=body.get("targetUnit"),
            target_date=body.get("targetDate"), start_date=body.get("startDate"),
            notes=body.get("notes"), priority=body.get("priority") or 0,
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        db.add(g)
        db.commit()
        return _goal_to_dict(g, db)
    finally:
        db.close()


@app.patch("/api/goals/{goal_id}")
async def update_goal(goal_id: str, request: Request, user_id: str = Depends(auth.current_user_id)):
    body = await request.json()
    db = SessionLocal()
    try:
        g = db.query(Goal).filter(Goal.id == goal_id, owned_by(Goal.user_id, user_id)).first()
        if not g:
            raise HTTPException(404, "Goal not found")
        if "name" in body:
            g.name = body["name"]
        if "activityTypes" in body:
            g.activity_types_json = json.dumps(body["activityTypes"])
        if "targetValue" in body:
            g.target_value = body["targetValue"]
        if "targetUnit" in body:
            g.target_unit = body["targetUnit"]
        if "targetDate" in body:
            g.target_date = body["targetDate"]
        if "startDate" in body:
            g.start_date = body["startDate"]
        if "notes" in body:
            g.notes = body["notes"]
        if "priority" in body:
            g.priority = body["priority"] or 0
        if "status" in body and body["status"] != g.status:
            g.status = body["status"]
            g.completed_at = datetime.now(timezone.utc).isoformat() if body["status"] in ("completed", "abandoned") else None
        db.commit()
        return _goal_to_dict(g, db)
    finally:
        db.close()


@app.delete("/api/goals/{goal_id}")
def delete_goal(goal_id: str, user_id: str = Depends(auth.current_user_id)):
    db = SessionLocal()
    try:
        g = db.query(Goal).filter(Goal.id == goal_id, owned_by(Goal.user_id, user_id)).first()
        if not g:
            raise HTTPException(404, "Goal not found")
        db.delete(g)
        db.commit()
        return {"deleted": True}
    finally:
        db.close()


# Legacy vanilla-JS frontend (Phase 0 predecessor) — kept reachable at /legacy for
# one release during the parity window (see PLAN.md 0.10), then deleted along with
# app/static/ once the new frontend below is confirmed stable.
app.mount("/legacy", StaticFiles(directory="static", html=True), name="legacy-static")

# New built frontend (web/dist, copied in by the Dockerfile's web-builder stage).
# Vite content-hashes everything under assets/, so that directory alone can be
# served as plain static files; every other path (every React Router route, a
# hard reload on /insights, /map, etc.) needs to fall through to index.html so
# client-side routing can take over — StaticFiles(html=True) only auto-serves
# index.html for the mount's own root, not for arbitrary unmatched sub-paths, so
# this is a explicit catch-all rather than a second bare StaticFiles mount.
WEB_DIST_DIR = os.path.join(os.path.dirname(__file__), "web-dist")

if os.path.isdir(WEB_DIST_DIR):
    app.mount("/assets", StaticFiles(directory=os.path.join(WEB_DIST_DIR, "assets")), name="web-assets")

    @app.get("/{full_path:path}")
    async def serve_web_app(full_path: str):
        candidate = os.path.join(WEB_DIST_DIR, full_path)
        if full_path and os.path.isfile(candidate):
            return FileResponse(candidate)
        return FileResponse(os.path.join(WEB_DIST_DIR, "index.html"))
else:
    # Local dev without a built web-dist/ (e.g. running main.py directly against
    # the Vite dev server on :5173 instead) — fall back to legacy at the root so
    # the app is never left with literally nothing at "/".
    app.mount("/", StaticFiles(directory="static", html=True), name="static")
