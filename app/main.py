import os
import json
import time
import logging
import threading
from datetime import datetime, timedelta, timezone

import requests
from fastapi import FastAPI, HTTPException, Request, UploadFile, File
from fastapi.responses import RedirectResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.gzip import GZipMiddleware
from apscheduler.schedulers.background import BackgroundScheduler

import uuid
from models import (
    init_db, SessionLocal, Run, DailySteps, ChatMessage, User, ProviderCredential, Goal,
    DEFAULT_USER_ID, owned_by, get_sync_meta, set_sync_meta,
)
import strava
import stats

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(level=LOG_LEVEL)
log = logging.getLogger("runlog")
log.setLevel(LOG_LEVEL)

app = FastAPI(title="RunLog")
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
    that is unaffected."""
    last = get_sync_meta("strava_last_synced_at")
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


def _record_sync(source: str, count: int = None, error: str = None):
    """Persist last-sync info to sync_meta so the UI can show real history
    across page loads instead of only reflecting the current browser session.
    A sync can partially succeed and then error (e.g. Garmin rate-limits mid-backlog
    after committing several real activities) — count and error aren't mutually
    exclusive, so both are recorded when both are given, instead of a real partial
    success being silently lost behind "Never synced"."""
    if count is not None:
        set_sync_meta(f"{source}_last_synced_at", datetime.now(timezone.utc).isoformat())
        set_sync_meta(f"{source}_last_count", str(count))
    set_sync_meta(f"{source}_last_error", error or "")


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
        set_sync_meta("strava_last_error", "")
        try:
            n = strava.sync_activities(user_id, limit=SYNC_LIMIT)
            _record_sync("strava", count=n)
            log.info(f"Auto-sync: upserted {n} runs from Strava for {user_id}")
        except Exception as e:
            _record_sync("strava", error=str(e))
            log.warning(f"Auto-sync skipped for {user_id}: {e}")


# ---------- Strava OAuth ----------
@app.get("/auth/strava/login")
def strava_login():
    return RedirectResponse(strava.get_authorize_url())


@app.get("/auth/strava/callback")
def strava_callback(code: str = None, error: str = None):
    if error:
        raise HTTPException(400, f"Strava auth error: {error}")
    if not code:
        raise HTTPException(400, "Missing code")
    # Hardcoded to DEFAULT_USER_ID until real login exists — the natural next step then
    # is threading a `state` param through get_authorize_url()/this callback so the OAuth
    # flow knows which logged-in user initiated it.
    strava.exchange_code_for_token(DEFAULT_USER_ID, code)
    return RedirectResponse("/?connected=strava")


@app.get("/api/strava/status")
def strava_status():
    token = strava.get_valid_access_token(DEFAULT_USER_ID)
    return {"connected": token is not None}


# ---------- Sync ----------
@app.post("/api/sync/strava")
def manual_sync_strava():
    set_sync_meta("strava_last_error", "")  # clear any stale error the moment a new attempt starts, not just on success
    try:
        n = strava.sync_activities(DEFAULT_USER_ID, limit=SYNC_LIMIT)
        _record_sync("strava", count=n)
        return {"synced": n}
    except Exception as e:
        _record_sync("strava", error=str(e))
        raise HTTPException(400, str(e))


@app.post("/api/sync/garmin")
def manual_sync_garmin():
    import garmin_sync
    set_sync_meta("garmin_last_error", "")  # clear any stale error the moment a new attempt starts, not just on success
    try:
        n = garmin_sync.sync_garmin_activities(DEFAULT_USER_ID, limit=SYNC_LIMIT)
        _record_sync("garmin", count=n)
        return {"synced": n}
    except Exception as e:
        msg = str(e)
        # A rate-limit error mid-sync still carries real progress (see
        # GarminMidSyncRateLimitError.synced_count) — record it as a partial success,
        # not just an error, so "Last synced" doesn't misleadingly say "Never".
        _record_sync("garmin", count=getattr(e, "synced_count", None), error=msg)
        raise HTTPException(400, msg)


@app.post("/api/garmin/import")
async def import_garmin_export(file: UploadFile = File(...)):
    """One-time bulk import from Garmin Connect's official data-export ZIP (requested via
    account.garmin.com, separate from the live unofficial-API sync above). Lets historical
    activities/steps come from a file instead of the rate-limited live API — the live
    sync's own dedup (run_needs_detail_sync) means anything this import already covers
    is automatically skipped on future syncs, so the live API only has to handle activities
    genuinely newer than the export. Safe to re-upload the same or an overlapping export."""
    import garmin_import
    data = await file.read()
    log.info(f"garmin import: received {file.filename} ({len(data)} bytes)")
    summary = garmin_import.import_garmin_export(data, DEFAULT_USER_ID)
    return summary


@app.get("/api/sync/meta")
def sync_meta():
    def info(source: str):
        count = get_sync_meta(f"{source}_last_count")
        return {
            "lastSyncedAt": get_sync_meta(f"{source}_last_synced_at"),
            "lastCount": int(count) if count is not None else None,
            "lastError": get_sync_meta(f"{source}_last_error") or None,
        }
    return {"strava": info("strava"), "garmin": info("garmin")}


# ---------- Backlog sync (full history, runs as a background job) ----------
_BACKLOG_LOG_LIMIT = 200
_backlog_lock = threading.Lock()
_backlog_jobs = {
    "strava": {"status": "idle", "count": 0, "log": [], "startedAt": None, "finishedAt": None, "error": None},
    "garmin": {"status": "idle", "count": 0, "log": [], "startedAt": None, "finishedAt": None, "error": None},
}


def _backlog_progress(source: str, msg: str, count: int = None):
    with _backlog_lock:
        job = _backlog_jobs[source]
        job["log"].append(f"{datetime.now().strftime('%H:%M:%S')}  {msg}")
        job["log"] = job["log"][-_BACKLOG_LOG_LIMIT:]
        if count is not None:
            job["count"] = count


def _run_backlog_sync(source: str):
    try:
        if source == "strava":
            n = strava.sync_all_activities(DEFAULT_USER_ID, progress_cb=lambda msg, count=None: _backlog_progress(source, msg, count))
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
                    _backlog_progress(source, msg, (base + count) if count is not None else None)

                try:
                    total += garmin_sync.sync_all_garmin_activities(DEFAULT_USER_ID, progress_cb=_progress)
                    break
                except Exception as e:
                    if not garmin_sync.is_rate_limit_related(e):
                        raise
                    wait = garmin_sync._garmin_cooldown_remaining_sec() + 5
                    _backlog_progress(
                        source,
                        f"Rate-limited — auto-retrying in {wait / 60:.1f} min, no need to click again…",
                    )
                    time.sleep(wait)
            n = total
        with _backlog_lock:
            job = _backlog_jobs[source]
            job["status"] = "done"
            job["count"] = n
            job["finishedAt"] = datetime.now(timezone.utc).isoformat()
        _record_sync(f"{source}_backlog", count=n)
        _backlog_progress(source, f"Done — {n} runs upserted")
    except Exception as e:
        msg = str(e)
        with _backlog_lock:
            job = _backlog_jobs[source]
            job["status"] = "error"
            job["error"] = msg
            job["finishedAt"] = datetime.now(timezone.utc).isoformat()
        # A rate-limit error mid-backlog still carries real progress (see
        # GarminMidSyncRateLimitError.synced_count) — record it as a partial success,
        # not just an error, so "Last synced" doesn't misleadingly say "Never" even
        # though real activities were committed before the failure.
        _record_sync(f"{source}_backlog", count=getattr(e, "synced_count", None), error=msg)
        _backlog_progress(source, f"Error: {msg}")


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
def start_backlog_sync(source: str):
    if source not in ("strava", "garmin"):
        raise HTTPException(404, "Unknown source")
    if source == "strava" and not strava.get_valid_access_token(DEFAULT_USER_ID):
        raise HTTPException(400, "Not authenticated with Strava — visit /auth/strava/login first")
    if source == "garmin" and not _has_credential(DEFAULT_USER_ID, "garmin"):
        raise HTTPException(400, "Add your Garmin credentials in Settings → Connections to use this")

    with _backlog_lock:
        job = _backlog_jobs[source]
        if job["status"] == "running":
            raise HTTPException(409, "Backlog sync already running")
        job.update({"status": "running", "count": 0, "log": [], "startedAt": datetime.now(timezone.utc).isoformat(),
                    "finishedAt": None, "error": None})

    # Clear the *persisted* last-error too, not just the in-memory job state above —
    # otherwise the old error stays visible in "last completed" for the whole duration
    # of this new run, since sync_meta only gets overwritten when _run_backlog_sync
    # finishes.
    set_sync_meta(f"{source}_backlog_last_error", "")

    threading.Thread(target=_run_backlog_sync, args=(source,), daemon=True).start()
    return {"status": "started"}


@app.get("/api/sync/{source}/backlog/status")
def backlog_status(source: str):
    if source not in ("strava", "garmin"):
        raise HTTPException(404, "Unknown source")
    with _backlog_lock:
        job = dict(_backlog_jobs[source])

    last_count = get_sync_meta(f"{source}_backlog_last_count")
    job["lastCompleted"] = {
        "syncedAt": get_sync_meta(f"{source}_backlog_last_synced_at"),
        "count": int(last_count) if last_count is not None else None,
        "error": get_sync_meta(f"{source}_backlog_last_error") or None,
    }
    return job


# ---------- Connections (per-user provider credentials — Settings tab) ----------
@app.get("/api/connections")
def get_connections():
    db = SessionLocal()
    try:
        creds = db.query(ProviderCredential).filter_by(user_id=DEFAULT_USER_ID).all()
        return [{"provider": c.provider, "username": c.username} for c in creds]
    finally:
        db.close()


@app.post("/api/connections/garmin")
async def set_garmin_connection(request: Request):
    body = await request.json()
    username, password = body.get("username"), body.get("password")
    if not username or not password:
        raise HTTPException(400, "username and password are required")
    db = SessionLocal()
    try:
        cred = db.query(ProviderCredential).filter_by(user_id=DEFAULT_USER_ID, provider="garmin").first()
        if not cred:
            cred = ProviderCredential(user_id=DEFAULT_USER_ID, provider="garmin",
                                       created_at=datetime.now(timezone.utc).isoformat())
            db.add(cred)
        cred.username = username
        cred.password = password
        db.commit()
        return {"status": "saved"}
    finally:
        db.close()


@app.delete("/api/connections/{provider}")
def delete_connection(provider: str):
    db = SessionLocal()
    try:
        cred = db.query(ProviderCredential).filter_by(user_id=DEFAULT_USER_ID, provider=provider).first()
        if cred:
            db.delete(cred)
            db.commit()
        return {"deleted": True}
    finally:
        db.close()


# ---------- Settings ----------
@app.get("/api/garmin/status")
def garmin_status():
    return {"configured": _has_credential(DEFAULT_USER_ID, "garmin")}


@app.get("/api/garmin/route-diagnostics")
def garmin_route_diagnostics():
    """How Garmin runs' routes were actually sourced — surfaces whether the FIT-derived
    unmasked path is really firing (vs. falling back to Garmin Connect's summary API,
    which independent testing found clips ~500m near a privacy-zone-protected location)
    without digging through container logs."""
    db = SessionLocal()
    try:
        rows = db.query(Run.route_source).filter(Run.source == "garmin").all()
        counts = {"fit_record_stream": 0, "geopolyline_summary": 0, "none": 0, "unknown": 0}
        for (source,) in rows:
            counts[source if source in counts else "unknown"] += 1
        return counts
    finally:
        db.close()


@app.get("/api/config")
def get_config():
    db = SessionLocal()
    try:
        resting_hr = stats.latest_resting_hr_bpm(db, DEFAULT_USER_ID)
    finally:
        db.close()
    return {
        "syncIntervalHours": SYNC_INTERVAL_HOURS,
        "syncActivityLimit": SYNC_LIMIT,
        "restingHrBpm": resting_hr,
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
def get_steps(days: int = 30):
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")
    db = SessionLocal()
    try:
        rows = (db.query(DailySteps).filter(DailySteps.date >= cutoff)
                .filter(owned_by(DailySteps.user_id, DEFAULT_USER_ID)).order_by(DailySteps.date).all())
        return [{"date": r.date, "steps": r.steps} for r in rows]
    finally:
        db.close()


# ---------- Wellness: resting HR / VO2max / sleep (Garmin-only) ----------
@app.get("/api/wellness")
def get_wellness(days: int = 90):
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")
    db = SessionLocal()
    try:
        rows = (db.query(DailySteps).filter(DailySteps.date >= cutoff)
                .filter(owned_by(DailySteps.user_id, DEFAULT_USER_ID)).order_by(DailySteps.date).all())
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
def get_sleep_stages(date: str = None):
    """Per-night sleep stage timeline (deep/light/rem/awake segments), for a real
    hypnogram rather than just daily totals — see garmin_sync._extract_sleep_stages().
    Returns every date that has stage data (for a night-picker) plus the requested
    (or most recent) night's segments."""
    db = SessionLocal()
    try:
        rows = (db.query(DailySteps)
                .filter(DailySteps.sleep_stages_json.isnot(None))
                .filter(DailySteps.sleep_stages_json != "[]")
                .filter(owned_by(DailySteps.user_id, DEFAULT_USER_ID))
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


@app.get("/api/runs")
def get_runs():
    db = SessionLocal()
    try:
        runs = (db.query(Run).filter(owned_by(Run.user_id, DEFAULT_USER_ID))
                .order_by(Run.date.desc()).all())
        return [_run_to_dict(r) for r in runs]
    finally:
        db.close()


@app.patch("/api/runs/{run_id}")
async def update_run(run_id: str, request: Request):
    body = await request.json()
    db = SessionLocal()
    try:
        run = db.get(Run, run_id)
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
def chat_history():
    db = SessionLocal()
    try:
        rows = (db.query(ChatMessage).filter(owned_by(ChatMessage.user_id, DEFAULT_USER_ID))
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
async def chat_message(request: Request):
    import assistant
    if not assistant.is_configured():
        raise HTTPException(400, "AI assistant not configured — set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY")
    body = await request.json()
    message = (body.get("message") or "").strip()
    if not message:
        raise HTTPException(400, "message is required")
    try:
        return await assistant.send_message(message, DEFAULT_USER_ID)
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/api/chat/reset")
async def chat_reset():
    import assistant
    db = SessionLocal()
    try:
        db.query(ChatMessage).filter(owned_by(ChatMessage.user_id, DEFAULT_USER_ID)).delete(synchronize_session=False)
        db.commit()
    finally:
        db.close()
    await assistant.reset_client(DEFAULT_USER_ID)
    return {"status": "reset"}


@app.get("/api/coach/personality")
def get_coach_personality():
    db = SessionLocal()
    try:
        user = db.get(User, DEFAULT_USER_ID)
        return {"personality": (user.coach_personality if user else None) or "normal"}
    finally:
        db.close()


@app.post("/api/coach/personality")
async def set_coach_personality(request: Request):
    import assistant
    import coach
    body = await request.json()
    personality = body.get("personality")
    if personality not in coach.VALID_PERSONAS:
        raise HTTPException(400, f"personality must be one of {coach.VALID_PERSONAS}")
    db = SessionLocal()
    try:
        user = db.get(User, DEFAULT_USER_ID)
        if user:
            user.coach_personality = personality
            db.commit()
    finally:
        db.close()
    # Persona is baked into the SDK's system prompt at client-construction time, not
    # re-read per message — reset so the next chat message rebuilds it with the new tone.
    await assistant.reset_client(DEFAULT_USER_ID)
    return {"personality": personality}


@app.get("/api/health-notes")
def get_health_notes(status: str = None, category: str = None):
    """Read-only — no POST/PATCH/DELETE. Health-note lifecycle is chat-tool-driven
    only (see coach.py's log_health_note/update_health_status), not a manual form."""
    import coach
    db = SessionLocal()
    try:
        return coach.list_health_notes(db, status, category)
    finally:
        db.close()


# ---------- Workouts (manual-UI path — mirrors the schedule_workout/update_workout
# chat tools exactly, both call into coach.py so validation can't drift between them) ----------
@app.get("/api/workouts")
def get_workouts(startDate: str = None, endDate: str = None, status: str = None):
    import coach
    db = SessionLocal()
    try:
        return coach.list_workouts(db, startDate, endDate, status)
    finally:
        db.close()


@app.post("/api/workouts")
async def create_workout_endpoint(request: Request):
    import coach
    body = await request.json()
    db = SessionLocal()
    try:
        return coach.create_workout(
            db, body.get("scheduledDate"), body.get("workoutType"), body.get("activityType"),
            body.get("targetDistanceMi"), body.get("targetPaceSecPerMi"), body.get("targetDurationSec"),
            body.get("notes"), body.get("steps"),
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    finally:
        db.close()


@app.patch("/api/workouts/{workout_id}")
async def update_workout_endpoint(workout_id: str, request: Request):
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
        return coach.update_workout(db, workout_id, **fields)
    except ValueError as e:
        raise HTTPException(400, str(e))
    finally:
        db.close()


@app.delete("/api/workouts/{workout_id}")
def delete_workout_endpoint(workout_id: str):
    import coach
    db = SessionLocal()
    try:
        coach.delete_workout(db, workout_id)
        return {"deleted": True}
    finally:
        db.close()


# ---------- Dashboard (real computed stats, no LLM involved) ----------
@app.get("/api/dashboard/summary")
def dashboard_summary():
    db = SessionLocal()
    try:
        return {
            "weeklyMileage": stats.weekly_mileage(db, weeks=12),
            "trainingLoad": stats.training_load_trend(db),
            "consistencyStreak": stats.weekly_consistency_streak(db),
            "daysSinceLongestRun": stats.days_since_longest_run(db),
            "daysSinceLastRun": stats.days_since_last_run(db),
            "paceTrend": stats.rolling_pace_trend(db, days=90),
            "personalRecords": stats.personal_records(db),
            "monthlyMileage": stats.monthly_mileage(db, months=2),
        }
    finally:
        db.close()


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
        "startDate": g.start_date, "notes": g.notes,
        "createdAt": g.created_at, "completedAt": g.completed_at,
        "progress": progress,
    }


@app.get("/api/goals")
def get_goals():
    db = SessionLocal()
    try:
        goals = (db.query(Goal).filter(owned_by(Goal.user_id, DEFAULT_USER_ID))
                 .order_by(Goal.status, Goal.target_date).all())
        return [_goal_to_dict(g, db) for g in goals]
    finally:
        db.close()


@app.post("/api/goals")
async def create_goal(request: Request):
    body = await request.json()
    if body.get("goalType") not in _VALID_GOAL_TYPES:
        raise HTTPException(400, f"goalType must be one of {_VALID_GOAL_TYPES}")
    db = SessionLocal()
    try:
        g = Goal(
            id=f"goal_{uuid.uuid4().hex[:12]}", user_id=DEFAULT_USER_ID,
            goal_type=body["goalType"], name=body.get("name") or "Untitled goal", status="active",
            activity_types_json=json.dumps(body.get("activityTypes") or ["Run"]),
            target_value=body.get("targetValue"), target_unit=body.get("targetUnit"),
            target_date=body.get("targetDate"), start_date=body.get("startDate"),
            notes=body.get("notes"), created_at=datetime.now(timezone.utc).isoformat(),
        )
        db.add(g)
        db.commit()
        return _goal_to_dict(g, db)
    finally:
        db.close()


@app.patch("/api/goals/{goal_id}")
async def update_goal(goal_id: str, request: Request):
    body = await request.json()
    db = SessionLocal()
    try:
        g = db.query(Goal).filter(Goal.id == goal_id, owned_by(Goal.user_id, DEFAULT_USER_ID)).first()
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
        if "status" in body and body["status"] != g.status:
            g.status = body["status"]
            g.completed_at = datetime.now(timezone.utc).isoformat() if body["status"] in ("completed", "abandoned") else None
        db.commit()
        return _goal_to_dict(g, db)
    finally:
        db.close()


@app.delete("/api/goals/{goal_id}")
def delete_goal(goal_id: str):
    db = SessionLocal()
    try:
        g = db.query(Goal).filter(Goal.id == goal_id, owned_by(Goal.user_id, DEFAULT_USER_ID)).first()
        if not g:
            raise HTTPException(404, "Goal not found")
        db.delete(g)
        db.commit()
        return {"deleted": True}
    finally:
        db.close()


app.mount("/", StaticFiles(directory="static", html=True), name="static")
