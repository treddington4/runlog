# RunLog

A self-hosted running tracker: pulls activities from Strava (OAuth, official API),
computes real per-mile splits, grade-adjusted pace, and interval structure, looks up
historical weather for free via Open-Meteo, and auto-syncs on a schedule — no external
API tokens burned per sync, and no LLM in the loop.

## Setup

### 1. Create a Strava API app
Go to https://www.strava.com/settings/api and create an app.
- **Authorization Callback Domain:** `localhost`
- Note your **Client ID** and **Client Secret**.

### 2. Configure environment
```bash
cp .env.example .env
# edit .env and fill in STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET
```

### 3. Run it
```bash
docker compose up --build
```

### 4. Connect Strava
Open http://localhost:8000, click **Connect Strava**, and authorize the app.
Strava will redirect back to `/auth/strava/callback`, which stores your OAuth
token in the local SQLite DB (persisted in the `runlog_data` Docker volume).

### 5. Sync
Click **Sync from Strava** for a manual pull, or just wait — it auto-syncs every
`SYNC_INTERVAL_HOURS` (default 6) in the background via APScheduler.

## What it does automatically
- **Per-mile splits** — resampled from Strava's raw GPS/HR/cadence streams, not
  just whatever auto-lap interval your watch happened to use.
- **Cadence correction** — Strava reports running cadence per-foot; this doubles
  it to true steps/minute.
- **Grade-Adjusted Pace (GAP)** — via the Minetti cost-of-running model.
- **Run type classification** — a simple heuristic (pace variability, distance,
  HR) suggests Easy/Tempo/Interval/Long Run/Recovery. Editable per-run in the UI.
- **Interval structure** — for runs classified as Interval, the actual lap-by-lap
  work/recovery pattern is preserved instead of collapsed into miles.
- **Historical weather** — via Open-Meteo's free archive API, keyed off each
  activity's GPS start point and local start time. No API key needed.
- **Treadmill detection** — via Strava's trainer flag; treadmill runs are
  excluded from weather-related charts automatically.

## Optional: Garmin (secondary source)
Garmin has no official public API for this. This project can optionally use the
unofficial `garminconnect` Python library, which logs in with your real Garmin
credentials. **This can break at any time** if Garmin changes their internal
endpoints — it is not sanctioned or supported by Garmin. Use at your own risk,
and treat Strava as your primary, reliable source.

To enable it, set `GARMIN_EMAIL` and `GARMIN_PASSWORD` in `.env`, then hit
`POST /api/sync/garmin` (there's no button in the UI for this by default —
call it manually via curl or add a button in `app.js` if you want it wired up).

## Editing run data
Click **edit** on any run card to override the run type, temperature, weather,
add an RPE (perceived effort 1-10), mark it as a treadmill run, or add notes.

## Data storage
Everything lives in a SQLite file inside the `runlog_data` Docker volume. To
back it up:
```bash
docker cp runlog:/data/runlog.db ./runlog-backup.db
```

## Architecture
```
┌─────────────┐     OAuth      ┌──────────────┐
│   Strava    │◄──────────────►│              │
└─────────────┘                │   FastAPI    │     ┌──────────┐
┌─────────────┐   free, no key │   backend    │◄───►│  SQLite  │
│ Open-Meteo  │◄───────────────│  (Python)    │     └──────────┘
└─────────────┘                │              │
                                └──────┬───────┘
                                       │ serves
                                       ▼
                              ┌─────────────────┐
                              │ Static frontend │
                              │ (vanilla JS +   │
                              │  Chart.js)      │
                              └─────────────────┘
```

No calls to any LLM API happen in this stack — sync, weather lookup, and run
classification are all deterministic code.

## License
MIT — see [LICENSE](LICENSE).

## Support
If RunLog is useful to you, consider [buying me a coffee](https://buymeacoffee.com/treddington4).
