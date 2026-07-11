"""
OPTIONAL secondary source. Garmin has no official public API for this kind of data —
this uses the unofficial `garminconnect` library, which logs in with your real
Garmin credentials and can break whenever Garmin changes their internal endpoints.
Use Strava as your primary source; treat this as a bonus.
"""
import os
import json
from datetime import datetime

from models import SessionLocal, Run
from weather import get_historical_weather
from util import classify_run_type, detect_intervals

GARMIN_EMAIL = os.environ.get("GARMIN_EMAIL", "")
GARMIN_PASSWORD = os.environ.get("GARMIN_PASSWORD", "")

METERS_PER_MILE = 1609.34


def sync_garmin_activities(limit: int = 10):
    if not GARMIN_EMAIL or not GARMIN_PASSWORD:
        raise RuntimeError("Set GARMIN_EMAIL and GARMIN_PASSWORD in your .env to use this")

    try:
        import garminconnect
    except ImportError:
        raise RuntimeError("garminconnect package not installed")

    client = garminconnect.Garmin(GARMIN_EMAIL, GARMIN_PASSWORD)
    client.login()

    activities = client.get_activities(0, limit)
    running = [a for a in activities if "running" in (a.get("activityType", {}).get("typeKey") or "")]

    db = SessionLocal()
    count = 0
    try:
        for act in running:
            run_id = f"garmin_{act['activityId']}"
            distance_mi = (act.get("distance") or 0) / METERS_PER_MILE
            moving_time = act.get("movingDuration") or act.get("duration") or 0
            avg_pace = moving_time / distance_mi if distance_mi else None
            is_treadmill = "treadmill" in (act.get("activityType", {}).get("typeKey") or "")

            splits = []
            try:
                laps = client.get_activity_splits(act["activityId"])
                lap_dtos = laps.get("lapDTOs", [])
                for i, lap in enumerate(lap_dtos, 1):
                    lap_dist_mi = (lap.get("distance") or 0) / METERS_PER_MILE
                    lap_time = lap.get("movingDuration") or lap.get("duration") or 0
                    if lap_dist_mi > 0:
                        splits.append({
                            "mile": i,
                            "paceSecPerMi": round(lap_time / lap_dist_mi, 1),
                            "elevGainFt": round((lap.get("elevationGain") or 0) * 3.28084, 1),
                            "avgHR": round(lap["averageHR"]) if lap.get("averageHR") else None,
                            "maxHR": round(lap["maxHR"]) if lap.get("maxHR") else None,
                            # Garmin's runningCadenceInStepsPerMinute is already total spm — no doubling needed
                            "avgCadence": lap.get("averageRunCadence"),
                        })
            except Exception:
                pass

            run_type = classify_run_type(distance_mi, avg_pace, splits, act.get("averageHR"))

            intervals_json = "[]"
            if run_type == "Interval" and splits:
                raw_laps = [{
                    "durationSec": None, "distanceMi": None,
                    "paceSecPerMi": s["paceSecPerMi"], "elevGainFt": s["elevGainFt"],
                    "avgHR": s["avgHR"], "maxHR": s["maxHR"], "avgCadence": s["avgCadence"],
                } for s in splits]
                intervals_json = json.dumps(detect_intervals(raw_laps))

            start_local = act.get("startTimeLocal", "")
            try:
                start_dt = datetime.fromisoformat(start_local)
            except Exception:
                start_dt = datetime.now()

            temp_f, condition, heat_index_f, wet_bulb_f = None, None, None, None
            if not is_treadmill:
                lat, lon = act.get("startLatitude"), act.get("startLongitude")
                if lat and lon:
                    temp_f, condition, heat_index_f, wet_bulb_f = get_historical_weather(
                        lat, lon, start_dt.strftime("%Y-%m-%d"), start_dt.hour
                    )

            existing = db.get(Run, run_id)
            run = existing or Run(id=run_id)
            run.source = "garmin"
            run.date = start_dt.strftime("%Y-%m-%d")
            run.start_time = start_dt.strftime("%H:%M")
            run.name = act.get("activityName", "Run")
            run.distance_mi = round(distance_mi, 3)
            run.moving_time_sec = int(moving_time)
            run.elev_gain_ft = round((act.get("elevationGain") or 0) * 3.28084, 1)
            run.avg_hr = round(act["averageHR"]) if act.get("averageHR") else None
            run.max_hr = round(act["maxHR"]) if act.get("maxHR") else None
            run.avg_cadence = act.get("averageRunningCadenceInStepsPerMinute")
            run.avg_pace_sec_per_mi = round(avg_pace, 1) if avg_pace else None
            run.is_treadmill = is_treadmill
            run.temp_f = temp_f
            run.weather_condition = condition
            run.heat_index_f = heat_index_f
            run.wet_bulb_f = wet_bulb_f
            run.suggested_type = run_type
            run.splits_json = json.dumps(splits)
            run.intervals_json = intervals_json

            db.merge(run)
            count += 1
        db.commit()
    finally:
        db.close()

    return count
