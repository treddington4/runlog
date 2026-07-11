import os
import json
import logging
from datetime import datetime

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import RedirectResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from apscheduler.schedulers.background import BackgroundScheduler

from models import init_db, SessionLocal, Run
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


def _auto_sync():
    try:
        n = strava.sync_activities(limit=SYNC_LIMIT)
        log.info(f"Auto-sync: upserted {n} runs from Strava")
    except Exception as e:
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
        return {"synced": n}
    except Exception as e:
        raise HTTPException(400, str(e))


@app.post("/api/sync/garmin")
def manual_sync_garmin():
    try:
        import garmin_sync
        n = garmin_sync.sync_garmin_activities(limit=SYNC_LIMIT)
        return {"synced": n}
    except Exception as e:
        raise HTTPException(400, str(e))


# ---------- Runs CRUD ----------
def _run_to_dict(r: Run):
    return {
        "id": r.id, "source": r.source, "date": r.date, "startTime": r.start_time,
        "name": r.name, "distanceMi": r.distance_mi, "movingTimeSec": r.moving_time_sec,
        "elevGainFt": r.elev_gain_ft, "avgHR": r.avg_hr, "maxHR": r.max_hr,
        "avgCadence": r.avg_cadence, "avgPaceSecPerMi": r.avg_pace_sec_per_mi,
        "isTreadmill": r.is_treadmill, "tempF": r.temp_f, "weatherCondition": r.weather_condition,
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
