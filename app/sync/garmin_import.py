"""
Import from Garmin Connect's official bulk "Export Your Data" ZIP (requested via
account.garmin.com's privacy/data page — a GDPR-style export, distinct from the live
unofficial-API sync in garmin_sync.py). Purpose: cover historical activities/steps from
a one-time file instead of the rate-limited live API, so garmin_sync.py's live sync only
needs to handle "what's new since the export" — a handful of recent activities, not the
entire history walk that keeps hitting Garmin's rate limit.

VERIFIED against a real export (2026-07-13, ~28MB zip, 186 activities): field names and
units below are confirmed, not guessed — see each constant's comment for what was
checked. Two real surprises found only by inspecting the actual file:
  1. Activity records are wrapped in `[{"summarizedActivitiesExport": [...]}]`, not a
     bare array — the outer list has exactly one dict, and the real records are one
     level deeper.
  2. Several numeric fields use different units than the live API: distance and
     elevationGain are in centimeters (not meters), duration/movingDuration are in
     milliseconds (not seconds) — confirmed by cross-checking each activity's top-level
     values against its own splitSummaries entries, which use plain meters/seconds and
     are exactly 100x/1000x smaller.
The raw `.FIT` files bundled in DI-Connect-Uploaded-Files/UploadedFiles_*.zip use an
unrelated internal numbering in their filenames (confirmed: zero overlap with any real
activityId in the same export) — so per-activity route/dynamics data can't be recovered
from this export's file naming alone. Skipped rather than guessed at; activities import
with route_source="none", same as any activity with no recoverable GPS.
"""

import io
import json
import logging
import re
import zipfile
from datetime import datetime, timezone

from ..models import SessionLocal, Run, DailySteps, run_needs_detail_sync
from .weather import get_historical_weather
from ..util import classify_run_type
from .garmin_sync import METERS_PER_MILE

log = logging.getLogger("runlog")

# Confirmed via the real 2026-07-13 export (sample activity + its own splitSummaries as
# a cross-check) — see module docstring. Kept as candidate-key tuples since Garmin's
# export format has changed across tool versions and might again.
_ACTIVITY_ID_KEYS = ("activityId",)
_ACTIVITY_DATE_KEYS = ("startTimeLocal", "beginTimestamp")  # epoch milliseconds, confirmed
_ACTIVITY_DIST_CM_KEYS = ("distance",)  # centimeters, confirmed (100x a split's meters)
_ACTIVITY_DURATION_MS_KEYS = ("movingDuration", "duration")  # milliseconds, confirmed
_ACTIVITY_NAME_KEYS = ("name",)
_ACTIVITY_TYPE_KEYS = ("activityType",)  # flat string, e.g. "running" — not nested
_HR_AVG_KEYS = ("avgHr",)
_HR_MAX_KEYS = ("maxHr",)
_ELEV_GAIN_CM_KEYS = ("elevationGain",)  # centimeters, confirmed (100x a split's meters)
# avgDoubleCadence is total steps/min (matches this app's "already doubled" convention
# for Run.avg_cadence); avgRunCadence is per-leg (roughly half) — confirmed by comparing
# the two fields on the same real activity (avgRunCadence=84 vs avgDoubleCadence=169.3).
_CADENCE_KEYS = ("avgDoubleCadence", "avgRunCadence")
_POWER_KEYS = ("avgPower",)
_LAT_KEYS = ("startLatitude",)  # plain degrees, confirmed — not semicircles like raw FIT
_LON_KEYS = ("startLongitude",)

_WELLNESS_DATE_KEYS = ("calendarDate", "date")
_WELLNESS_STEPS_KEYS = ("totalSteps", "steps", "stepCount")
_WELLNESS_RESTING_HR_KEYS = ("restingHeartRate",)

_DATE_PREFIX_RE = re.compile(r"^\d{4}-\d{2}-\d{2}")


def _first(d: dict, keys, default=None):
    for k in keys:
        if k in d and d[k] is not None:
            return d[k]
    return default


def _looks_like_activity(d: dict) -> bool:
    if not isinstance(d, dict):
        return False
    return "activityId" in d and ("distance" in d or "duration" in d)


def _looks_like_daily_wellness(d: dict) -> bool:
    if not isinstance(d, dict):
        return False
    has_date = any(k in d for k in _WELLNESS_DATE_KEYS)
    has_steps = any(k in d for k in _WELLNESS_STEPS_KEYS)
    return has_date and has_steps


def _iter_candidate_lists(obj):
    """Yields every list that might hold the real records — checked one level deeper
    than a naive top-level scan, since the real export wraps activity records as
    `[{"summarizedActivitiesExport": [...]}]` (a one-item list containing a dict whose
    value is the actual array), not a bare array. Also handles a bare top-level list
    (the daily-wellness/UDSFile shape) and a dict with a list-valued key, in case a
    different export file uses either of those instead."""
    if isinstance(obj, list):
        yield obj
        for item in obj:
            if isinstance(item, dict):
                for v in item.values():
                    if isinstance(v, list):
                        yield v
    elif isinstance(obj, dict):
        for v in obj.values():
            if isinstance(v, list):
                yield v


def _normalize_date(raw) -> str:
    """Best-effort normalization to YYYY-MM-DD — epoch-ms confirmed for activities;
    wellness/UDS files use a plain "YYYY-MM-DD" string directly."""
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


def _epoch_ms_to_datetime(value):
    """Activity start times in this export are epoch milliseconds (confirmed: the gap
    between startTimeGmt and startTimeLocal for a real activity was exactly 4h in ms,
    matching this account's EDT offset) — not ISO strings like the live API returns."""
    if value is None:
        return None
    try:
        return datetime.fromtimestamp(float(value) / 1000, tz=timezone.utc)
    except Exception:
        return None


def _extract_activity_fields(rec: dict) -> dict:
    type_key = _first(rec, _ACTIVITY_TYPE_KEYS) or "unknown"
    distance_cm = _first(rec, _ACTIVITY_DIST_CM_KEYS)
    duration_ms = _first(rec, _ACTIVITY_DURATION_MS_KEYS)
    elev_gain_cm = _first(rec, _ELEV_GAIN_CM_KEYS)
    return {
        "activity_id": _first(rec, _ACTIVITY_ID_KEYS),
        "name": _first(rec, _ACTIVITY_NAME_KEYS, "Run"),
        "type_key": type_key,
        "start_dt": _epoch_ms_to_datetime(_first(rec, _ACTIVITY_DATE_KEYS)),
        "distance_m": (distance_cm / 100) if distance_cm is not None else None,
        "duration_s": (duration_ms / 1000) if duration_ms is not None else None,
        "avg_hr": _first(rec, _HR_AVG_KEYS),
        "max_hr": _first(rec, _HR_MAX_KEYS),
        "elev_gain_m": (elev_gain_cm / 100) if elev_gain_cm is not None else None,
        "avg_cadence": _first(rec, _CADENCE_KEYS),
        "avg_power": _first(rec, _POWER_KEYS),
        "start_lat": _first(rec, _LAT_KEYS),
        "start_lon": _first(rec, _LON_KEYS),
    }


def _walk_zip(zf: zipfile.ZipFile, prefix=""):
    """Yields (path, raw_bytes) for every non-.fit file in a zip, descending one level
    into any nested zip. Raw .FIT files are deliberately skipped without reading their
    bytes — this export's UploadedFiles_*.zip bundles ~5000 of them under a filename
    numbering confirmed unrelated to any real activityId, so there's nothing to match
    them to; reading thousands of files just to discard them would only waste time."""
    for info in zf.infolist():
        if info.is_dir():
            continue
        path = prefix + info.filename
        if path.lower().endswith(".fit"):
            yield path, None
            continue
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
    export. Returns a summary dict including raw structural findings so a mismatch
    against a future export version is immediately visible and fixable."""
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

    activity_records = []
    wellness_records = []

    try:
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
            for path, data in _walk_zip(zf):
                summary["filesScanned"] += 1
                if len(summary["sampleFilePaths"]) < 40:
                    summary["sampleFilePaths"].append(path)

                lower = path.lower()
                if lower.endswith(".fit"):
                    summary["fitFilesFound"] += 1
                    continue

                if not lower.endswith(".json"):
                    continue
                log.debug(f"garmin import: found {path} ({len(data)} bytes)")
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
        f"({summary['jsonFilesParsed']} JSON, {summary['fitFilesFound']} FIT skipped), "
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
            run_id = f"garmin_{int(act_id)}"
            if not run_needs_detail_sync(db, run_id):
                summary["activitiesSkippedExisting"] += 1
                continue
            try:
                _import_one_activity(db, run_id, fields, user_id)
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
            existing = db.get(DailySteps, (date_str, user_id))
            row = existing or DailySteps(date=date_str, user_id=user_id)
            row.steps = int(steps)
            resting_hr = _first(rec, _WELLNESS_RESTING_HR_KEYS)
            if resting_hr is not None and row.resting_hr_bpm is None:
                row.resting_hr_bpm = round(resting_hr)
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


def _import_one_activity(db, run_id, fields, user_id):
    distance_mi = (fields["distance_m"] or 0) / METERS_PER_MILE
    duration_s = fields["duration_s"] or 0
    avg_pace = duration_s / distance_mi if distance_mi else None
    type_key = fields["type_key"] or "unknown"
    is_run = "running" in type_key
    is_treadmill = "treadmill" in type_key

    start_dt = fields["start_dt"] or datetime.now(timezone.utc)

    # No FIT match possible from this export (see module docstring) and no live-API
    # laps/geoPolyline calls either — route/dynamics simply aren't available via this
    # path. Activities still import fully otherwise; route_source reflects that honestly.
    route_source = "none"

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
    run.route_json = "[]"
    run.route_metrics_json = "[]"
    run.route_source = route_source
    run.avg_power_watts = fields["avg_power"]
    run.detail_synced_at = datetime.now(timezone.utc).isoformat()

    db.merge(run)
