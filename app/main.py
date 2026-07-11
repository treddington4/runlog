import os
import json
import logging
from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import RedirectResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from apscheduler.schedulers.background import BackgroundScheduler

from models import init_db, SessionLocal, Run, get_sync_meta, set_sync_meta
import strava

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("runlog")

app = FastAPI(title="RunLog")

SYNC_INTERVAL_HOURS = int(os.environ.get("SYNC_INTERVAL_HOURS", "6"))
SYNC_LIMIT = int(os.environ.get("SYNC_ACTIVITY_LIMIT", "10"))


@app.on_event("startup")
def startup():
    init_db()
    scheduler = BackgroundScheduler()
    scheduler.add_job(_auto_sync, "interval", hours=SYNC_INTERVAL_HOURS, next_run_time=datetime.now())
    scheduler.start()
    log.info(f"Auto-sync scheduled every {SYNC_INTERVAL_HOURS}h")


def _record_sync(source: str, count: int = None, error: str = None):
    """Persist last-sync info to sync_meta so the UI can show real history
    across page loads instead of only reflecting the current browser session."""
    if error is None:
        set_sync_meta(f"{source}_last_synced_at", datetime.now(timezone.utc).isoformat())
        set_sync_meta(f"{source}_last_count", str(count))
        set_sync_meta(f"{source}_last_error", "")
    else:
        set_sync_meta(f"{source}_last_error", error)


def _auto_sync():
    try:
        n = strava.sync_activities(limit=SYNC_LIMIT)
        _record_sync("strava", count=n)
        log.info(f"Auto-sync: upserted {n} runs from Strava")
    except Exception as e:
        _record_sync("strava", error=str(e))
        log.warning(f"Auto-sync skipped: {e}")


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
    strava.exchange_code_for_token(code)
    return RedirectResponse("/?connected=strava")


@app.get("/api/strava/status")
def strava_status():
    token = strava.get_valid_access_token()
    return {"connected": token is not None}


# ---------- Sync ----------
@app.post("/api/sync/strava")
def manual_sync_strava():
    try:
        n = strava.sync_activities(limit=SYNC_LIMIT)
        _record_sync("strava", count=n)
        return {"synced": n}
    except Exception as e:
        _record_sync("strava", error=str(e))
        raise HTTPException(400, str(e))


@app.post("/api/sync/garmin")
def manual_sync_garmin():
    try:
        import garmin_sync
        n = garmin_sync.sync_garmin_activities(limit=SYNC_LIMIT)
        _record_sync("garmin", count=n)
        return {"synced": n}
    except Exception as e:
        msg = str(e)
        if "429" in msg or "not supported between instances" in msg:
            msg = ("Garmin is rate-limiting login attempts from this network right now "
                   "(this is common with the unofficial API). Wait a while before retrying.")
        _record_sync("garmin", error=msg)
        raise HTTPException(400, msg)


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


# ---------- Settings ----------
@app.get("/api/garmin/status")
def garmin_status():
    configured = bool(os.environ.get("GARMIN_EMAIL")) and bool(os.environ.get("GARMIN_PASSWORD"))
    return {"configured": configured}


@app.get("/api/config")
def get_config():
    return {"syncIntervalHours": SYNC_INTERVAL_HOURS, "syncActivityLimit": SYNC_LIMIT}


# ---------- Runs CRUD ----------
def _run_to_dict(r: Run):
    return {
        "id": r.id, "source": r.source, "date": r.date, "startTime": r.start_time,
        "name": r.name, "distanceMi": r.distance_mi, "movingTimeSec": r.moving_time_sec,
        "elevGainFt": r.elev_gain_ft, "avgHR": r.avg_hr, "maxHR": r.max_hr,
        "avgCadence": r.avg_cadence, "avgPaceSecPerMi": r.avg_pace_sec_per_mi,
        "isTreadmill": r.is_treadmill, "tempF": r.temp_f, "weatherCondition": r.weather_condition,
        "heatIndexF": r.heat_index_f, "wetBulbF": r.wet_bulb_f,
        "suggestedType": r.suggested_type, "type": r.type_override or r.suggested_type,
        "rpe": r.rpe, "notes": r.notes,
        "splits": json.loads(r.splits_json or "[]"),
        "intervals": json.loads(r.intervals_json or "[]"),
    }


@app.get("/api/runs")
def get_runs():
    db = SessionLocal()
    try:
        runs = db.query(Run).order_by(Run.date.desc()).all()
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


app.mount("/", StaticFiles(directory="static", html=True), name="static")
