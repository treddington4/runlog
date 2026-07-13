"""
Import from Garmin Connect's official bulk "Export Your Data" ZIP (requested via
account.garmin.com's privacy/data page — a GDPR-style export, distinct from the live
unofficial-API sync in garmin_sync.py). Purpose: cover historical activities/steps from
a one-time file instead of the rate-limited live API, so garmin_sync.py's live sync only
needs to handle "what's new since the export" — a handful of recent activities, not the
entire history walk that keeps hitting Garmin's rate limit.

UNVERIFIED against a real export file as of this writing — Garmin's export format isn't
officially documented and has changed across tool versions, so this parses defensively
(multiple candidate key names, degrade-to-skip rather than crash) and logs everything it
finds at DEBUG level (see LOG_LEVEL) instead of assuming an exact schema. The import
summary returned to the caller also includes raw structural findings (file paths, a
sample record's keys) specifically so a mismatch is immediately visible and fixable —
same discipline this app already applies to Garmin wellness field names.
"""

import io
import json
import logging
import re
import zipfile
from datetime import datetime, timezone

from models import SessionLocal, Run, DailySteps, run_needs_detail_sync
from weather import get_historical_weather
from util import classify_run_type
from garmin_sync import _parse_fit_streams, METERS_PER_MILE

log = logging.getLogger("runlog")

# Every field below tries several plausible key names since the export's exact schema
# is unverified — see module docstring. Extend these lists once a real file shows the
# actual keys (check the "sampleActivityKeys" field in the import summary / debug logs).
_ACTIVITY_ID_KEYS = ("activityId", "activityUuid", "summaryId", "activity_id")
_ACTIVITY_DATE_KEYS = (
    "startTimeLocal", "beginTimestamp", "startTimeGmt", "activityDate", "summaryStartTimeLocal",
)
_ACTIVITY_DIST_KEYS = ("distance", "distanceInMeters", "sumDistance")
_ACTIVITY_DURATION_KEYS = (
    "movingDuration", "duration", "sumDuration", "sumMovingDuration",
    "durationInSeconds", "elapsedDuration",
)
_ACTIVITY_NAME_KEYS = ("activityName", "name")
_ACTIVITY_TYPE_KEYS = ("activityType",)  # often nested, e.g. {"typeKey": "running"}
_HR_AVG_KEYS = ("averageHR", "avgHr", "averageHeartRateInBeatsPerMinute")
_HR_MAX_KEYS = ("maxHR", "maxHr", "maxHeartRateInBeatsPerMinute")
_ELEV_KEYS = ("elevationGain", "elevationGainInMeters")
_CADENCE_KEYS = ("averageRunningCadenceInStepsPerMinute", "averageRunCadence", "avgRunCadence")
_LAT_KEYS = ("startLatitude", "startLatitudeInDegree")
_LON_KEYS = ("startLongitude", "startLongitudeInDegree")

_WELLNESS_DATE_KEYS = ("calendarDate", "date")
_WELLNESS_STEPS_KEYS = ("totalSteps", "steps", "stepCount")

_ID_IN_FILENAME_RE = re.compile(r"(\d{6,})")
_DATE_PREFIX_RE = re.compile(r"^\d{4}-\d{2}-\d{2}")


def _first(d: dict, keys, default=None):
    for k in keys:
        if k in d and d[k] is not None:
            return d[k]
    return default


def _looks_like_activity(d: dict) -> bool:
    if not isinstance(d, dict):
        return False
    has_id = any(k in d for k in _ACTIVITY_ID_KEYS)
    has_dist_or_dur = any(k in d for k in _ACTIVITY_DIST_KEYS + _ACTIVITY_DURATION_KEYS)
    return has_id and has_dist_or_dur


def _looks_like_daily_wellness(d: dict) -> bool:
    if not isinstance(d, dict):
        return False
    has_date = any(k in d for k in _WELLNESS_DATE_KEYS)
    has_steps = any(k in d for k in _WELLNESS_STEPS_KEYS)
    return has_date and has_steps


def _iter_candidate_lists(obj):
    """Yields every list found at the top level or as a direct value of a parsed JSON
    document — export files are known to sometimes wrap the actual array in a top-level
    key rather than being a bare array, so both shapes are checked."""
    if isinstance(obj, list):
        yield obj
    elif isinstance(obj, dict):
        for v in obj.values():
            if isinstance(v, list):
                yield v


def _normalize_date(raw) -> str:
    """Best-effort normalization to YYYY-MM-DD — the export's date format/type is
    unverified (could be an ISO string, epoch millis, or already YYYY-MM-DD)."""
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        try:
            ts = raw / 1000 if raw > 10**12 else raw
            return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")
        except Exception:
            return None
    s = str(raw)
    if _DATE_PREFIX_RE.match(s):
        return s[:10]
    try:
        return datetime.fromisoformat(s).strftime("%Y-%m-%d")
    except Exception:
        return None


def _extract_activity_fields(rec: dict) -> dict:
    activity_type_raw = _first(rec, _ACTIVITY_TYPE_KEYS, {}) or {}
    type_key = (
        activity_type_raw.get("typeKey")
        if isinstance(activity_type_raw, dict)
        else activity_type_raw
    ) or "unknown"
    return {
        "activity_id": _first(rec, _ACTIVITY_ID_KEYS),
        "name": _first(rec, _ACTIVITY_NAME_KEYS, "Run"),
        "type_key": type_key,
        "start_local": _first(rec, _ACTIVITY_DATE_KEYS),
        "distance_m": _first(rec, _ACTIVITY_DIST_KEYS),
        "duration_s": _first(rec, _ACTIVITY_DURATION_KEYS),
        "avg_hr": _first(rec, _HR_AVG_KEYS),
        "max_hr": _first(rec, _HR_MAX_KEYS),
        "elev_gain_m": _first(rec, _ELEV_KEYS),
        "avg_cadence": _first(rec, _CADENCE_KEYS),
        "start_lat": _first(rec, _LAT_KEYS),
        "start_lon": _first(rec, _LON_KEYS),
    }


def _guess_activity_id_from_filename(name: str):
    m = _ID_IN_FILENAME_RE.search(name)
    return m.group(1) if m else None


def _walk_zip(zf: zipfile.ZipFile, prefix=""):
    """Yields (path, raw_bytes) for every file in a zip, descending one level into any
    nested zip (Garmin's export is known to sometimes bundle raw activity files into a
    nested UploadedFiles-style zip rather than flat in the main archive)."""
    for info in zf.infolist():
        if info.is_dir():
            continue
        path = prefix + info.filename
        try:
            data = zf.read(info)
        except Exception as e:
            log.debug(f"garmin import: could not read {path} ({e})")
            continue
        yield path, data
        if path.lower().endswith(".zip"):
            try:
                with zipfile.ZipFile(io.BytesIO(data)) as inner:
                    yield from _walk_zip(inner, prefix=path + "!/")
            except Exception as e:
                log.debug(f"garmin import: {path} looked like a zip but didn't open ({e})")


def import_garmin_export(zip_bytes: bytes, user_id: str) -> dict:
    """Parses a Garmin data-export ZIP and upserts activities/daily steps found in it,
    skipping anything already fully synced (run_needs_detail_sync — the same dedup check
    the live sync uses) so this is safe to re-run against the same or an overlapping
    export. Returns a summary dict including raw structural findings so the field
    mappings above can be corrected quickly if they don't match a real file's shape."""
    summary = {
        "filesScanned": 0,
        "jsonFilesParsed": 0,
        "fitFilesFound": 0,
        "activityRecordsFound": 0,
        "activitiesImported": 0,
        "activitiesSkippedExisting": 0,
        "activitiesSkippedMalformed": 0,
        "dailyWellnessRecordsFound": 0,
        "dailyStepsImported": 0,
        "sampleFilePaths": [],
        "sampleActivityKeys": [],
        "errors": [],
    }

    fit_bytes_by_id = {}
    activity_records = []
    wellness_records = []

    try:
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
            for path, data in _walk_zip(zf):
                summary["filesScanned"] += 1
                if len(summary["sampleFilePaths"]) < 40:
                    summary["sampleFilePaths"].append(path)
                log.debug(f"garmin import: found {path} ({len(data)} bytes)")

                lower = path.lower()
                if lower.endswith(".fit"):
                    summary["fitFilesFound"] += 1
                    guessed_id = _guess_activity_id_from_filename(path)
                    if guessed_id:
                        fit_bytes_by_id[guessed_id] = data
                    continue

                if not lower.endswith(".json"):
                    continue
                try:
                    parsed = json.loads(data)
                except Exception as e:
                    log.debug(f"garmin import: {path} is not valid JSON ({e})")
                    continue
                summary["jsonFilesParsed"] += 1

                for candidate_list in _iter_candidate_lists(parsed):
                    if not candidate_list or not isinstance(candidate_list[0], dict):
                        continue
                    if _looks_like_activity(candidate_list[0]):
                        matches = [r for r in candidate_list if _looks_like_activity(r)]
                        activity_records.extend(matches)
                        if not summary["sampleActivityKeys"]:
                            summary["sampleActivityKeys"] = sorted(candidate_list[0].keys())
                        log.debug(f"garmin import: {path} looks like {len(matches)} activity records")
                    elif _looks_like_daily_wellness(candidate_list[0]):
                        matches = [r for r in candidate_list if _looks_like_daily_wellness(r)]
                        wellness_records.extend(matches)
                        log.debug(f"garmin import: {path} looks like {len(matches)} daily wellness records")
    except zipfile.BadZipFile as e:
        summary["errors"].append(f"Not a valid zip file: {e}")
        return summary

    summary["activityRecordsFound"] = len(activity_records)
    summary["dailyWellnessRecordsFound"] = len(wellness_records)
    log.info(
        f"garmin import: scanned {summary['filesScanned']} files "
        f"({summary['jsonFilesParsed']} JSON, {summary['fitFilesFound']} FIT), "
        f"found {len(activity_records)} activity records, {len(wellness_records)} wellness records"
    )

    db = SessionLocal()
    try:
        for rec in activity_records:
            fields = _extract_activity_fields(rec)
            act_id = fields["activity_id"]
            if not act_id:
                summary["activitiesSkippedMalformed"] += 1
                continue
            run_id = f"garmin_{act_id}"
            if not run_needs_detail_sync(db, run_id):
                summary["activitiesSkippedExisting"] += 1
                continue
            try:
                _import_one_activity(db, run_id, act_id, fields, fit_bytes_by_id, user_id)
                summary["activitiesImported"] += 1
            except Exception as e:
                summary["activitiesSkippedMalformed"] += 1
                summary["errors"].append(f"activity {act_id}: {e}")
                log.debug(f"garmin import: failed to import activity {act_id}: {e}")
        db.commit()

        for rec in wellness_records:
            date_str = _normalize_date(_first(rec, _WELLNESS_DATE_KEYS))
            steps = _first(rec, _WELLNESS_STEPS_KEYS)
            if not date_str or steps is None:
                continue
            existing = db.get(DailySteps, date_str)
            row = existing or DailySteps(date=date_str)
            row.user_id = user_id
            row.steps = int(steps)
            db.merge(row)
            summary["dailyStepsImported"] += 1
        db.commit()
    finally:
        db.close()

    log.info(
        f"garmin import: {summary['activitiesImported']} activities imported, "
        f"{summary['activitiesSkippedExisting']} already known, "
        f"{summary['activitiesSkippedMalformed']} malformed/skipped, "
        f"{summary['dailyStepsImported']} daily step rows imported"
    )
    return summary


def _import_one_activity(db, run_id, act_id, fields, fit_bytes_by_id, user_id):
    distance_mi = (fields["distance_m"] or 0) / METERS_PER_MILE
    duration_s = fields["duration_s"] or 0
    avg_pace = duration_s / distance_mi if distance_mi else None
    type_key = fields["type_key"] or "unknown"
    is_run = "running" in type_key
    is_treadmill = "treadmill" in type_key

    try:
        start_dt = datetime.fromisoformat(fields["start_local"]) if fields["start_local"] else datetime.now()
    except Exception:
        start_dt = datetime.now()

    fit_bytes = fit_bytes_by_id.get(str(act_id))
    fit_data = {"dynamics": {}, "route": [], "routeMetrics": []}
    route_source = "none"
    if fit_bytes:
        fit_data = _parse_fit_streams(fit_bytes, known_avg_cadence=fields["avg_cadence"])
        if len(fit_data["route"]) >= 2:
            route_source = "fit_record_stream"

    temp_f, condition, heat_index_f, wet_bulb_f = None, None, None, None
    if not is_treadmill and fields["start_lat"] and fields["start_lon"]:
        temp_f, condition, heat_index_f, wet_bulb_f = get_historical_weather(
            fields["start_lat"], fields["start_lon"], start_dt.strftime("%Y-%m-%d"), start_dt.hour
        )

    # No splits/laps available without the live API — classify_run_type degrades
    # gracefully to a distance/HR-only guess (see util.py), and interval detection is
    # simply skipped since it requires lap data this import path doesn't have.
    run_type = classify_run_type(distance_mi, avg_pace, [], None) if is_run else type_key

    existing = db.get(Run, run_id)
    run = existing or Run(id=run_id)
    run.user_id = user_id
    run.source = "garmin"
    run.activity_type = type_key
    run.date = start_dt.strftime("%Y-%m-%d")
    run.start_time = start_dt.strftime("%H:%M")
    run.name = fields["name"] or "Run"
    run.distance_mi = round(distance_mi, 3)
    run.moving_time_sec = int(duration_s)
    run.elev_gain_ft = round((fields["elev_gain_m"] or 0) * 3.28084, 1)
    run.avg_hr = round(fields["avg_hr"]) if fields["avg_hr"] else None
    run.max_hr = round(fields["max_hr"]) if fields["max_hr"] else None
    run.avg_cadence = fields["avg_cadence"]
    run.avg_pace_sec_per_mi = round(avg_pace, 1) if avg_pace else None
    run.is_treadmill = is_treadmill
    run.temp_f = temp_f
    run.weather_condition = condition
    run.heat_index_f = heat_index_f
    run.wet_bulb_f = wet_bulb_f
    run.suggested_type = run_type
    run.splits_json = "[]"
    run.intervals_json = "[]"
    run.recovery_json = "[]"
    run.route_json = json.dumps(fit_data["route"])
    run.route_metrics_json = json.dumps(fit_data["routeMetrics"])
    run.route_source = route_source
    run.detail_synced_at = datetime.now(timezone.utc).isoformat()

    dynamics = fit_data["dynamics"]
    run.vertical_oscillation_mm = dynamics.get("verticalOscillationMm")
    run.ground_contact_time_ms = dynamics.get("groundContactTimeMs")
    run.vertical_ratio_pct = dynamics.get("verticalRatioPct")
    run.stride_length_m = dynamics.get("strideLengthM")
    run.avg_power_watts = dynamics.get("avgPowerWatts")

    db.merge(run)
