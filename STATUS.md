# Status

_Last updated: 2026-07-11. Written for picking this project back up in a fresh session — see [CLAUDE.md](CLAUDE.md) for architecture._

## Current state

- **Deployed and running** on the UGREEN DXP2800 NAS at `http://REDACTED-LAN-IP:8000`, container name `runlog`. `REDACTED-DEV-PATH` (dev machine) is a live SMB mount to `REDACTED-NAS-PATH` on the NAS — no separate deploy/copy step, editing files here edits them there directly.
- **Deploy command**: `ssh nas 'cd REDACTED-NAS-PATH && docker compose up -d --build'`. SSH alias `nas` → `REDACTED-LAN-IP`, user `REDACTED-USER`, dedicated key `~/.ssh/REDACTED-SSH-KEY` (configured in `~/.ssh/config` on the dev machine). `REDACTED-USER` is in the NAS's `docker` group.
- **Git**: private repo at [github.com/REDACTED-GH-USER/runlog](https://github.com/REDACTED-GH-USER/runlog), `master` branch, all work through this session is committed and pushed.
- **Strava**: connected and auto-syncing (official OAuth, every 6h + immediately on container start). 8 runs synced as of this writing.
- **Garmin**: credentials configured in `.env` (unofficial `garminconnect` library), but the account hit Garmin's login rate limit (`429`) during testing today — hasn't been successfully synced yet. Retry later via the Settings tab's "Sync Garmin Now" button; no code issue, just needs the rate limit to clear.

## What's been built this session (chronological)

1. Initial deploy of the pre-existing app (found already scaffolded, not built from scratch) — fixed a broken `garminconnect==0.2.19` transitive dependency (pinned to `0.3.2`) and a nonexistent Chart.js CDN version (`4.4.4` → `4.5.0`) that was silently breaking Insights.
2. Heat index + wet bulb temperature, computed from Open-Meteo hourly humidity, shown per-run.
3. Fixed "Never synced" always showing — `sync_meta` table existed but was unused; now persists last-sync time/count/error per source across restarts, exposed via `GET /api/sync/meta`.
4. Weather badges moved to their own row in run cards (was wrapping awkwardly mixed with performance stats).
5. `CLAUDE.md` added.
6. Settings tab — Strava/Garmin status, last-synced info, sync schedule, and a working "Sync Garmin Now" button (previously had to be triggered via `curl`).
7. Date-range filter bar — toggle between rolling 7-day, calendar week (Mon–Sun), fully custom start/end dates, or all-time, with prev/next navigation on the two preset modes. Applies to both the Runs list and Insights charts.

## Known gaps / things to watch

- **No test suite** exists in this repo.
- **Strava/Garmin runs aren't deduplicated** — if both sources are ever synced for the same physical run, it'll show as two separate cards (documented as a known limitation in `CLAUDE.md`, not yet addressed).
- **GAP (grade-adjusted pace) is implemented twice** — once in `app/util.py` (backend, used at sync time) and once in `app/static/app.js` (frontend, used for live split recalculation). If the Minetti formula ever changes, both need updating.
- The app is plain HTTP on `:8000`, no TLS/reverse proxy — fine on LAN, would need attention before any exposure beyond the local network.
- I haven't been able to visually verify the UI myself (the sandboxed browser can't reach the NAS's private LAN address) — verification so far has been via `curl`/API checks plus Node-based logic simulation for the date-filter math. Worth a visual once-over, especially the new Settings tab and custom date picker.

## Possible next steps (not started, just noted)

- Visual QA pass on Settings tab and date filter UI.
- Decide whether to keep polling Garmin sync until the rate limit clears, or investigate why the client library throws a raw `TypeError` on 429 instead of a clean error (currently just pattern-matched around in `main.py`).
- SQLite backup strategy for `/data/runlog.db` on the NAS (currently just a Docker named volume, no external backup).
