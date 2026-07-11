# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

RunLog: a self-hosted running tracker. FastAPI backend, SQLite storage (via SQLAlchemy), vanilla-JS/Chart.js static frontend, no build step. Pulls activities from Strava (official OAuth API, primary) and optionally Garmin Connect (unofficial `garminconnect` library, secondary/manual-only), enriches them with historical weather, grade-adjusted pace, and a heuristic run-type/interval classifier, computed once at sync time and stored — not recomputed on read (except GAP, see Gotchas).

## Commands

- **Run it**: `docker compose up --build` from the repo root — app on `http://localhost:8000` (or `SYNC_INTERVAL_HOURS`/port as configured in `.env`, copy from `.env.example`).
- **Deploy**: this repo's working copy (`REDACTED-DEV-PATH` on the dev machine) is a live SMB mount directly to `REDACTED-NAS-PATH` on the UGREEN NAS — editing files here edits them on the NAS in place, no separate copy/rsync step. Rebuild on the NAS with `ssh nas 'cd REDACTED-NAS-PATH && docker compose up -d --build'` (SSH alias `nas` configured in `~/.ssh/config`).
- No test suite or lint config exists in this repo currently.

## Architecture

**Two independent sync sources write to one `runs` table.** `app/strava.py` and `app/garmin_sync.py` each own their own fetch → normalize → upsert pipeline, keyed by a source-prefixed id (`"strava_<id>"` / `"garmin_<id>"`). They are **not** deduplicated against each other — if both sources are synced for the same physical run, two separate cards appear. Strava is the auto-scheduled primary source (`app/main.py`'s `_auto_sync`, every `SYNC_INTERVAL_HOURS`, fires immediately on container start via `next_run_time=datetime.now()`); Garmin only runs when `POST /api/sync/garmin` is called manually.

**Derived metrics are computed at sync time, not read time**, and stored on the `Run` row: per-mile splits (resampled from raw GPS/HR/cadence streams for Strava, from lap data for Garmin), Grade-Adjusted Pace (Minetti cost-of-running model), heat index / wet bulb (NWS Rothfusz regression / Stull approximation, from Open-Meteo's hourly humidity), run-type classification and interval/rep detection (`app/util.py`, pace-variability heuristics) — all in `app/strava.py`/`app/garmin_sync.py` at sync time. **Exception:** GAP is *also* independently reimplemented client-side in `app/static/app.js` (`gapSecPerMi`/`minettiCost`) to redraw per-split GAP without a round trip — the two Minetti implementations must be kept in sync by hand if the formula ever changes.

**No migration framework.** `app/models.py`'s `init_db()` calls SQLAlchemy's `create_all()` (which only creates missing *tables*, not missing *columns*) followed by `_migrate_add_missing_columns()`, a hand-rolled `PRAGMA table_info` diff + `ALTER TABLE ADD COLUMN`. Any new column added to the `Run` model needs no separate migration step — this function picks it up automatically on next container start — but the type-mapping in that function (TEXT/INTEGER/REAL) needs to stay correct for new column types.

**`sync_meta` table** persists last-sync timestamp/count/error per source (`get_sync_meta`/`set_sync_meta` in `models.py`), written by `main.py`'s `_record_sync()` after every sync attempt (auto or manual), read via `GET /api/sync/meta`. This is what backs the "Last synced" UI text — it intentionally does not reset on page reload or container restart.

**Garmin is explicitly best-effort.** There's no official Garmin API; `garminconnect` logs in with real credentials and can break without warning. It's pinned to `0.3.2` specifically — `0.2.19` pulls in a broken transitive `withings-sync` dependency chain, and anything `0.3.3+` requires Python 3.12 while the Dockerfile uses `python:3.11-slim`. 429s from Garmin during login surface as a raw `TypeError` from the client library rather than a clean rate-limit error; `main.py`'s `manual_sync_garmin` pattern-matches the message to give a readable error instead.

**Strava OAuth** is a live in-app flow (`/auth/strava/login` → Strava → `/auth/strava/callback`), not a manual token exchange — tokens are stored in the `oauth_tokens` SQLite table and auto-refreshed in `strava.get_valid_access_token()`.
