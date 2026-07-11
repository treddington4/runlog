"""Strava OAuth + activity sync. Uses Strava's official REST API directly — no LLM involved."""
import os
import time
import json
import requests
from datetime import datetime, timezone

from models import SessionLocal, Run, OAuthToken
from weather import get_historical_weather
from util import gap_sec_per_mi, classify_run_type, detect_intervals

CLIENT_ID = os.environ.get("STRAVA_CLIENT_ID", "")
CLIENT_SECRET = os.environ.get("STRAVA_CLIENT_SECRET", "")
REDIRECT_URI = os.environ.get("STRAVA_REDIRECT_URI", "http://localhost:8000/auth/strava/callback")

AUTH_URL = "https://www.strava.com/oauth/authorize"
TOKEN_URL = "https://www.strava.com/oauth/token"
API_BASE = "https://www.strava.com/api/v3"

METERS_PER_MILE = 1609.34


def get_authorize_url() -> str:
    params = (
        f"client_id={CLIENT_ID}&redirect_uri={REDIRECT_URI}"
        f"&response_type=code&approval_prompt=auto"
        f"&scope=activity:read_all"
    )
    return f"{AUTH_URL}?{params}"


def exchange_code_for_token(code: str):
    resp = requests.post(TOKEN_URL, data={
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "code": code,
        "grant_type": "authorization_code",
    }, timeout=15)
    resp.raise_for_status()
    data = resp.json()
    _store_token(data)
    return data


def _store_token(data):
    db = SessionLocal()
    try:
        tok = db.get(OAuthToken, "strava")
        if not tok:
            tok = OAuthToken(provider="strava")
        tok.access_token = data["access_token"]
        tok.refresh_token = data["refresh_token"]
        tok.expires_at = data["expires_at"]
        db.merge(tok)
        db.commit()
    finally:
        db.close()


def get_valid_access_token():
    db = SessionLocal()
    try:
        tok = db.get(OAuthToken, "strava")
        if not tok:
            return None
        if tok.expires_at - 60 > int(time.time()):
            return tok.access_token
        # refresh
        resp = requests.post(TOKEN_URL, data={
            "client_id": CLIENT_ID,
            "client_secret": CLIENT_SECRET,
            "grant_type": "refresh_token",
            "refresh_token": tok.refresh_token,
        }, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        _store_token(data)
        return data["access_token"]
    finally:
        db.close()


def _resample_mile_splits(streams: dict):
    """Turn raw time-series streams into true per-mile splits (distance-resampled)."""
    dist = streams.get("distance", {}).get("data", [])
    time_s = streams.get("time", {}).get("data", [])
    hr = streams.get("heartrate", {}).get("data", [])
    cad = streams.get("cadence", {}).get("data", [])
    alt = streams.get("altitude", {}).get("data", [])

    if not dist or not time_s:
        return []

    splits = []
    next_mark = METERS_PER_MILE
    seg_start_t = time_s[0]
    seg_start_alt = alt[0] if alt else 0
    hr_buf, cad_buf = [], []
    mile_num = 1

    for i, d in enumerate(dist):
        if hr and i < len(hr):
            hr_buf.append(hr[i])
        if cad and i < len(cad):
            cad_buf.append(cad[i])

        if d >= next_mark:
            elapsed = time_s[i] - seg_start_t
            elev_gain_m = max(0, (alt[i] if alt else 0) - seg_start_alt)
            splits.append({
                "mile": mile_num,
                "paceSecPerMi": elapsed,
                "elevGainFt": round(elev_gain_m * 3.28084, 1),
                "avgHR": round(sum(hr_buf) / len(hr_buf)) if hr_buf else None,
                "maxHR": max(hr_buf) if hr_buf else None,
                # Strava reports run cadence per-foot; double for true steps/min
                "avgCadence": round((sum(cad_buf) / len(cad_buf)) * 2, 1) if cad_buf else None,
            })
            mile_num += 1
            next_mark += METERS_PER_MILE
            seg_start_t = time_s[i]
            seg_start_alt = alt[i] if alt else 0
            hr_buf, cad_buf = [], []

    # trailing partial mile
    if dist and dist[-1] > (next_mark - METERS_PER_MILE) + 100:  # only if meaningfully more than a few meters
        partial_mi = (dist[-1] - (next_mark - METERS_PER_MILE)) / METERS_PER_MILE
        elapsed = time_s[-1] - seg_start_t
        if partial_mi > 0.05 and elapsed > 0:
            splits.append({
                "mile": round(mile_num - 1 + partial_mi, 2),
                "paceSecPerMi": round(elapsed / partial_mi),
                "elevGainFt": round(max(0, (alt[-1] if alt else 0) - seg_start_alt) * 3.28084, 1),
                "avgHR": round(sum(hr_buf) / len(hr_buf)) if hr_buf else None,
                "maxHR": max(hr_buf) if hr_buf else None,
                "avgCadence": round((sum(cad_buf) / len(cad_buf)) * 2, 1) if cad_buf else None,
            })
    return splits


def sync_activities(limit: int = 10):
    """Main sync entrypoint. Returns number of runs upserted."""
    token = get_valid_access_token()
    if not token:
        raise RuntimeError("Not authenticated with Strava — visit /auth/strava/login first")

    headers = {"Authorization": f"Bearer {token}"}
    resp = requests.get(f"{API_BASE}/athlete/activities", headers=headers,
                         params={"per_page": limit}, timeout=20)
    resp.raise_for_status()
    activities = [a for a in resp.json() if a.get("type") == "Run"]

    db = SessionLocal()
    count = 0
    try:
        for act in activities:
            run_id = f"strava_{act['id']}"
            is_treadmill = bool(act.get("trainer"))

            streams_resp = requests.get(
                f"{API_BASE}/activities/{act['id']}/streams",
                headers=headers,
                params={"keys": "time,distance,heartrate,cadence,altitude,latlng", "key_by_type": "true"},
                timeout=20,
            )
            streams = streams_resp.json() if streams_resp.ok else {}

            splits = _resample_mile_splits(streams)

            distance_mi = act["distance"] / METERS_PER_MILE
            moving_time = act["moving_time"]
            avg_pace = moving_time / distance_mi if distance_mi else None
            avg_cadence = (act.get("average_cadence") or 0) * 2 or None
            elev_gain_ft = (act.get("total_elevation_gain") or 0) * 3.28084

            run_type = classify_run_type(distance_mi, avg_pace, splits, act.get("average_heartrate"))

            intervals_json = "[]"
            if run_type == "Interval":
                laps_resp = requests.get(f"{API_BASE}/activities/{act['id']}/laps", headers=headers, timeout=20)
                if laps_resp.ok:
                    raw_laps = [{
                        "durationSec": l["moving_time"],
                        "distanceMi": round(l["distance"] / METERS_PER_MILE, 4),
                        "paceSecPerMi": round(l["moving_time"] / (l["distance"] / METERS_PER_MILE), 1) if l["distance"] else None,
                        "elevGainFt": round((l.get("total_elevation_gain") or 0) * 3.28084, 1),
                        "avgHR": round(l["average_heartrate"]) if l.get("average_heartrate") else None,
                        "maxHR": l.get("max_heartrate"),
                        "avgCadence": round((l.get("average_cadence") or 0) * 2, 1) if l.get("average_cadence") else None,
                    } for l in laps_resp.json()]
                    intervals_json = json.dumps(detect_intervals(raw_laps))

            temp_f, condition = None, None
            if not is_treadmill:
                latlng = act.get("start_latlng") or []
                start_dt = datetime.fromisoformat(act["start_date_local"].replace("Z", ""))
                if len(latlng) == 2:
                    temp_f, condition = get_historical_weather(
                        latlng[0], latlng[1], start_dt.strftime("%Y-%m-%d"), start_dt.hour
                    )

            start_dt = datetime.fromisoformat(act["start_date_local"].replace("Z", ""))

            existing = db.get(Run, run_id)
            run = existing or Run(id=run_id)
            run.source = "strava"
            run.date = start_dt.strftime("%Y-%m-%d")
            run.start_time = start_dt.strftime("%H:%M")
            run.name = act.get("name", "Run")
            run.distance_mi = round(distance_mi, 3)
            run.moving_time_sec = moving_time
            run.elev_gain_ft = round(elev_gain_ft, 1)
            run.avg_hr = round(act["average_heartrate"]) if act.get("average_heartrate") else None
            run.max_hr = act.get("max_heartrate")
            run.avg_cadence = avg_cadence
            run.avg_pace_sec_per_mi = round(avg_pace, 1) if avg_pace else None
            run.is_treadmill = is_treadmill
            run.temp_f = temp_f
            run.weather_condition = condition
            run.suggested_type = run_type
            run.splits_json = json.dumps(splits)
            run.intervals_json = intervals_json

            db.merge(run)
            count += 1
        db.commit()
    finally:
        db.close()

    return count
