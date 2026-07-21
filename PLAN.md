# HALE — Execution Plan

Task-level breakdown of [ROADMAP.md](ROADMAP.md), written for an execution model
(Sonnet) to work through **in order**. This file is the single source of progress
truth — keep it updated as you go.

## Working rules

1. **Order**: work sections top-to-bottom; within a section, tasks top-to-bottom.
   A section is one coherent, shippable unit.
2. **Mark completion immediately**: flip `- [ ]` to `- [x]` the moment a task is done
   *and verified* — never in bulk at the end. If a task turns out wrong or unnecessary,
   don't silently skip it: strike it through and add a one-line reason.
3. **Commit after every section**: one commit per completed section, message =
   what changed + what was verified (follow the repo's existing commit-message style:
   rationale-rich body, no bullet spam). Do **not** push unless the user asks.
4. **Verify before marking done** — this repo has no test suite; the established
   discipline is:
   - Python: `python -c "import ast; ast.parse(open('<file>').read())"` pre-deploy
   - JS (legacy): `node --check app/static/app.js` · Frontend (new): `npm run build` must pass
   - Deploy: `docker compose up -d --build` on the host (host specifics live in the
     gitignored `.RUNBOOK.md`; if absent, ask the user rather than guessing)
   - API: `curl` against the live deployment; UI: `scripts/screenshot.py` and actually
     read the image
   - **Migrations: run against a copy of the live DB first, never the original**
5. **Docs**: at the end of each numbered phase (not each section), update `STATUS.md`
   and, when architecture-level facts changed, `CLAUDE.md`.
6. **Don't re-implement what exists**: GAP (Minetti) lives in `app/util.py` + a
   documented client copy; stats are computed once in `app/stats.py`; sync-time
   enrichment happens in `app/strava.py`/`app/garmin_sync.py`. Extending these is
   right; duplicating them is a defect.

---

## Phase 0 — Frontend re-architecture

Stack decision (made): Vite + React + TypeScript + Tailwind + shadcn/ui in a new
`web/` directory. FastAPI API contracts unchanged. Chart.js + Leaflet carry over.
This supersedes the "no build step" principle — deliberate, documented in ROADMAP.

### 0.1 Scaffold + design tokens
- [x] `web/`: Vite React-TS scaffold; Tailwind; shadcn/ui init; ESLint+Prettier —
      shadcn CLI init was skipped in favor of a hand-written `components.json` +
      `button.tsx`/`card.tsx` (avoided a second interactive install after two prior
      installs already raced each other on this machine's SMB-mounted working copy;
      see below); scaffold's default `oxlint` kept in place of ESLint (paired with
      Prettier) — same purpose, already wired by create-vite, not worth fighting
- [x] Vite dev proxy: `/api/*` and `/auth/*` → live backend URL (env var, not hardcoded)
- [x] Design tokens in Tailwind config: dark palette from current app (`#0B0E12` bg
      family, amber `#FFC857` accent), spacing/radius scale, Inter with
      `font-variant-numeric: tabular-nums` for stat values; JetBrains Mono kept
      as the wordmark/stat-value accent — ported 1:1 from `app/static/style.css`
      into `web/src/index.css` as shadcn-compatible CSS variables (dark-only, no
      light theme — matches the legacy app)
- [x] Shared API client (`web/src/lib/api.ts`) with typed responses for existing
      endpoints (start with the ones Home needs) — `dashboardSummary()` +
      `HeaderStats`/`DashboardSummary` types, matching `stats._header_stats`'s
      real field names exactly
- [x] Verify: `npm run dev` renders a token-styled placeholder against live API data —
      `npx tsc -b --noEmit` clean, `npx oxlint` clean (one expected fast-refresh
      warning on `button.tsx`, matches upstream shadcn), `npm run build` succeeds,
      screenshotted desktop+mobile against the live NAS backend via the dev proxy —
      HALE wordmark (white HAL + amber E) renders correctly, card shows real
      `headerStats` JSON (`totalActivityCount`, `runCountAllTime`, etc.) fetched
      through `/api/dashboard/summary`
- [x] Commit: "Phase 0.1: web/ scaffold, design tokens, API client"

  **Environment note for future sections**: on a network-mounted working copy
  (confirm with your platform's mount-info command — e.g. `net use` on
  Windows), avoid running `npm`/Vite directly against that mount: bulk
  `node_modules` operations are extremely slow and can fail outright
  (`ENOTEMPTY` on deletes; Vite's dev server can crash on startup with
  `Error: UNKNOWN: unknown error, watch`, since native `fs.watch()` isn't
  supported over network filesystems). The real fix isn't a slower-but-working
  code tweak — if your network mount points at a real machine you can reach
  (a NAS, a remote dev box), run `npm`/`vite` **there**, against the local
  path the mount resolves to, ideally inside a throwaway container pinned to
  a modern Node (this repo's target: `node:22-slim`, matching Phase 0.10's
  eventual Dockerfile stage) so the host's own Node version doesn't matter.
  Confirmed in this repo: the same `npm install` that took ~15min over the
  mount took ~9s run this way, and Vite's dev-server startup dropped from
  ~28s to ~480ms with native (non-polling) file-watching working correctly.
  `server.watch.usePolling` in `vite.config.ts` is kept only as a defensive
  fallback for whoever runs `npm run dev` directly over a network mount
  anyway — see the gitignored `.RUNBOOK.md` for this dev environment's exact
  commands.

### 0.2 App shell
- [ ] Persistent left sidebar (desktop ≥900px) / bottom tab bar (mobile): Home, Goals,
      Activities, Insights, Map, Chat, Workouts, Settings
- [ ] React Router routes per tab; HALE wordmark (white `HAL` + amber `E`) + tagline
      "HALE's Adaptive Life Engine"; race-countdown chip in the shell header
- [ ] Loading skeleton components + empty-state component (icon, message, CTA) —
      reused by every tab port below
- [ ] Verify: screenshot desktop + mobile viewports
- [ ] Commit: "Phase 0.2: app shell — sidebar/bottom-tab nav, skeletons, empty states"

### 0.3 Home tab port
- [ ] Stat strip (fast paint from `/api/dashboard/summary` headerStats, exact numbers
      after `/api/runs` — preserve the existing two-source pattern), goals cards,
      dashboard cards, wellness cards
- [ ] Card component system (replaces settings-row-for-everything): title/value/
      sub-metric hierarchy, hover states, click-through navigation preserved
- [ ] Verify: side-by-side screenshot vs legacy Home; all numbers identical
- [ ] Commit: "Phase 0.3: Home tab ported"

### 0.4 Workouts + Recovery port
- [ ] Unified date-ordered list (workouts + recovery sessions interleaved — preserve
      current behavior), structured-steps rendering with expandable how-to details,
      status actions, new-workout modal
- [ ] Verify: screenshot; create/edit/delete round-trip against live API
- [ ] Commit: "Phase 0.4: Workouts tab ported"

### 0.5 Activities (Runs) port
- [ ] Run cards (badges, mini-stats, weather, dynamics rows), expand with splits/
      intervals/inline map, edit modal (activity-family-aware fields — preserve
      `isDistanceActivity` logic), filter bar (modes, type select, date nav)
- [ ] While here: filter-driven fetching — `/api/runs` gains `start`/`end`/`limit`
      params; default load = last 90 days; wider filters fetch on demand (kills the
      7 MB initial payload; client merge/dedup logic ports as-is)
- [ ] Verify: payload size before/after; screenshot; edit round-trip
- [ ] Commit: "Phase 0.5: Activities tab ported + windowed /api/runs fetching"

### 0.6 Insights port
- [ ] All existing charts (weekly mileage, pace trend, HR, cadence, dynamics, steps,
      wellness, sleep hypnogram) on a unified Chart.js theme (palette, axes, tooltips)
- [ ] Verify: screenshot vs legacy for chart parity
- [ ] Commit: "Phase 0.6: Insights tab ported"

### 0.7 Map port
- [ ] Leaflet map, location select, metric modes (density/pace/HR/cadence/grade),
      per-run mini-maps in Activities expand
- [ ] Verify: screenshot each metric mode
- [ ] Commit: "Phase 0.7: Map tab ported"

### 0.8 Chat port
- [ ] Thread UI, tool-call transparency chips, inline charts (`charts` payload),
      persona-aware empty state, send flow with optimistic pending bubble
- [ ] Verify: real message round-trip; history renders with charts
- [ ] Commit: "Phase 0.8: Chat tab ported"

### 0.9 Goals + Settings port
- [ ] Goals CRUD + progress cards; Settings: connections, sync controls with live
      sync/backlog status panels (preserve poll-only-while-running discipline —
      see the flashing-loop bug history in git log), coach personality, import, About
- [ ] Verify: sync-now round-trip shows live status; screenshot
- [ ] Commit: "Phase 0.9: Goals + Settings ported"

### 0.10 Cutover
- [ ] Dockerfile → multi-stage: `node:22-slim` builds `web/dist` → copied into the
      python image; FastAPI serves `web/dist` at `/` (keep legacy at `/legacy` for
      one release)
- [ ] `scripts/screenshot.py`: update tab navigation for the new shell
- [ ] Delete `app/static/` legacy after one week of parity (separate commit)
- [ ] Verify: full-container build + deploy; every tab screenshot; `STATUS.md` +
      `CLAUDE.md` updated (build step now exists; architecture section rewritten)
- [ ] Commit: "Phase 0.10: cutover to built frontend"

### 0.11 PWA
- [ ] Manifest (name HALE, amber-E icon set), service worker (offline shell,
      network-first API), web push: backend `POST /api/push/subscribe` +
      `pywebpush` sends on daily insight/generated workout
- [ ] Verify: Lighthouse installability pass; real push received on phone
- [ ] Commit: "Phase 0.11: PWA + push notifications"

---

## Phase 1 — Multi-tenant isolation & auth

### 1.1 daily_steps composite PK
- [ ] Copy-table migration in `models.init_db()` (SQLite can't alter PKs): new table
      PK `(user_id, date)`, backfill NULL user_id → `'default'`, swap, idempotent
- [ ] Update every `db.get(DailySteps, date)` call site (garmin_sync, stats, coach,
      main) to composite lookup
- [ ] Verify: migration on a **copy** of the live DB; row counts identical; wellness
      cards still render
- [ ] Commit: "Phase 1.1: daily_steps composite PK migration"

### 1.2 Auth schema
- [ ] `User.oidc_subject` (unique, nullable) — `users` already in `_MIGRATABLE_TABLES`
- [ ] New `ApiToken` table: `id, user_id, token_hash (sha256), name, created_at,
      last_used_at` — device tokens for headless clients
- [ ] Commit: "Phase 1.2: auth schema (oidc_subject, api_tokens)"

### 1.3 Auth middleware
- [ ] `app/auth.py`: `current_user_id()` FastAPI dependency — `AUTH_MODE=disabled`
      (default) → DEFAULT_USER_ID; else Bearer JWT (PyJWT + cached JWKS fetch;
      env `OIDC_ISSUER/OIDC_AUDIENCE/OIDC_JWKS_URL`; auto-provision User on first
      valid sub) or `X-Api-Token` (hash lookup, stamp last_used_at); else 401
- [ ] Verify: disabled mode = zero behavior change (curl suite); enabled mode rejects
      missing/bad tokens, accepts a hand-built test JWT
- [ ] Commit: "Phase 1.3: OIDC/JWT + device-token auth middleware"

### 1.4 Endpoint threading
- [ ] Every endpoint in `main.py`: `user_id = Depends(auth.current_user_id)` replaces
      DEFAULT_USER_ID literals
- [ ] In-memory job state keyed `(user_id, source)` (quick-sync + backlog dicts)
- [ ] `sync_meta` scoping: `user_key(user_id, key)` helper; migrate cooldown/cursor/
      cache/throttle call sites; one-time copy of globals to `u:default:*`
- [ ] Run-id collision guard: on cross-user id conflict in `_process_activity`, write
      `{source}_{user_id}_{activity_id}`
- [ ] Verify: full curl regression as default user; `STATUS.md`
- [ ] Commit: "Phase 1.4: per-user scoping of endpoints, job state, sync_meta"

### 1.5 Token management + onboarding
- [ ] `POST/GET/DELETE /api/tokens` (raw token shown once); Settings UI section
- [ ] First-run wizard (new frontend): connect Strava/Garmin → create goal → confirm
      training config (feeds Phase 4's UserTrainingConfig)
- [ ] Verify: token round-trip incl. ingest auth (after 2.2); wizard screenshot
- [ ] Commit: "Phase 1.5: device tokens + onboarding wizard"

---

## Phase 2 — Telemetry ingest API

### 2.1 Schema
- [ ] `HealthSample` table: `id (client "{device}:{record_id}" → idempotent), user_id,
      kind (steps|sleep_session|hrv|resting_hr|heart_rate|blood_glucose), start_ts,
      end_ts, value_json, device_id, received_at` — raw kept forever
- [ ] `daily_steps` adds `hrv_last_night_avg_ms`, `glucose_tir_pct`,
      `field_sources_json` (per-field provenance; precedence garmin > health_connect)
- [ ] Commit: "Phase 2.1: health_samples schema + wellness provenance columns"

### 2.2 Endpoint
- [ ] `app/ingest.py` + `POST /api/ingest/health-connect`: batch INSERT OR IGNORE,
      rollup touched dates into daily wellness respecting precedence; device-token auth
- [ ] Glucose rollup: link readings to overlapping Run windows → `Run.glucose_json`;
      daily time-in-range (70–180 default) → `glucose_tir_pct`
- [ ] Verify: curl a synthetic batch twice → second reports duplicates, rollup correct
- [ ] Commit: "Phase 2.2: Health Connect ingest endpoint + rollup"

---

## Phase 4 — Workout generator

### 4.1 Readiness core
- [ ] `stats.readiness(db, user_id, date)` → hrvDeltaMs (vs 7d baseline),
      restingHrDelta, sleepScore, acuteChronicRatio (7d/28d mileage until Phase 6
      swaps in ATL/CTL), daysSinceHard, flags (`hrv_below_baseline` >10ms drop,
      `rhr_spike` +5bpm, `sleep_deficit` <6.5h) — single computation core, chat tool
      `get_readiness` added in `assistant.py`
- [ ] Verify: container probe against real data; chat tool answers with real numbers
- [ ] Commit: "Phase 4.1: readiness computation + chat tool"

### 4.2 Structured endurance steps
- [ ] Extend `coach._validate_steps` with second shape (discriminate on `stepType`):
      `{stepType: warmup|active|rest|cooldown|repeat, durationSec XOR distanceM
      (or neither = lap-press "open"), targetType: hr_zone|hr_custom|power|pace|
      cadence|open, targetZone XOR targetLow/High, repeatCount+children (1 level)}`
      — metric units stored, converted at display/push edges
- [ ] `UserTrainingConfig` table: `user_id PK, max_hr, threshold_hr, ftp_watts?,
      zones_json (5-zone HR bounds; default max_hr=208−0.7·age), weekly_ramp_pct
      (default 3.0), mesocycle_pattern ("3:1"), distribution ("pyramidal")` +
      `GET/PATCH /api/training-config` + Settings UI
- [ ] Frontend: render endurance steps in workout cards (zones/paces humanized)
- [ ] Commit: "Phase 4.2: endurance step contract + training config"

### 4.3 Generator engine
- [ ] `weekly_plan` table: `(user_id, week_start) PK, target_tss, actual_tss,
      is_deload, frozen`
- [ ] `app/generator.py` — deterministic, no LLM, evaluated strictly in order:
      (1) phase from goal date (base/build/peak/taper) + mesocycle position (deload
      week = volume ×0.7–0.8); (2) weekly budget = min(last_week × (1+ramp%), phase
      ceiling); (3) readiness gate — 1 flag: downgrade one tier (interval→tempo→Z2→
      recovery); 2+: Z1/rest **and** freeze week (`frozen=1`, next week ramps from
      frozen base); severe/HealthNote: micro-deload rest of week; (4) distribution
      audit — refuse a hard day that would break 80/20 (polarized) or pyramid ratio
      over rolling 7d time-in-zone; (5) two-a-days only build/peak with clean
      readiness, modality split, `scheduled_time` (new nullable Workout column),
      second session always recovery-intensity. Idempotent per (user, date). Every
      cap/downgrade names its trigger in `Workout.notes`
- [ ] Scheduler: daily 04:00 local per active user + `POST /api/generator/run`
- [ ] Verify: force-generate across synthetic readiness states (clean/1-flag/2-flag/
      deload-week) via container probe; inspect prescriptions + notes rationale
- [ ] Commit: "Phase 4.3: goal-driven daily workout generator"

---

## Phase 6 — Training-load analytics

### 6.1 Per-activity metrics (sync-time, stored on Run)
- [ ] `tss` (hrTSS from avg HR vs threshold_hr; fallback rTSS from existing GAP),
      `efficiency_factor`; rides with power: `normalized_power` (30s rolling 4th-power
      mean), `intensity_factor`, `variability_index`, `aerobic_decoupling`
- [ ] Backfill command for existing activities (one-shot, container-run)
- [ ] Commit: "Phase 6.1: per-activity TSS/NP/EF/decoupling"

### 6.2 PMC pipeline
- [ ] `DailyMetrics` table: `(user_id, date) PK, trimp, ctl, atl, tsb,
      hrv_baseline_ms, readiness_score, time_in_zone_json, computed_at`
- [ ] `app/pipeline.py` nightly job: TRIMP→CTL (42d) / ATL (7d) / TSB; weekly
      actual_tss into `weekly_plan`; `stats.readiness` switches acuteChronicRatio
      to ATL/CTL; strength tonnage → TRIMP via fixed intensity factor (documented
      v1 approximation)
- [ ] `GET /api/metrics?days=` + Insights CTL/ATL/TSB chart
- [ ] Verify: hand-check CTL/ATL recursion on a known 5-day window
- [ ] Commit: "Phase 6.2: PMC pipeline (CTL/ATL/TSB)"

### 6.3 Gear tracking
- [ ] `Gear` table (`id, user_id, name, kind shoe|bike|bike_component,
      parent_gear_id?, start_date, retired_date?, replace_at_mi?`) +
      `Run.gear_id`; default-gear-per-type rule at sync; `stats.gear_summary`
      (read-time mileage); CRUD + Settings UI + wear on dashboard
- [ ] Commit: "Phase 6.3: gear lifecycle tracking"

---

## Phase 5 — Garmin workout push

- [ ] `app/garmin_push.py`: endurance steps → garminconnect 0.3.6 workout model
      (hr_zone→HR target via UserTrainingConfig, pace→m/s, repeat blocks); reuse
      `garmin_sync._login` + cooldown wrapper; `push_workout` (upload + schedule,
      store `garmin_workout_uuid`), `unpush_workout`; 429 → `Workout.push_error`
      (new column), never crashes the scheduler. All garminconnect workout types
      isolated in this one module (FIT-file generation is the documented escape hatch)
- [ ] `POST /api/workouts/{id}/push`; `User.auto_push_garmin` flag (default false)
      auto-pushes generator output; "Push to Garmin" button on workout cards
- [ ] Verify: real push of one workout; confirm on watch/Connect; unpush cleans up
- [ ] Commit: "Phase 5: Garmin workout push pipeline"

---

## Phase 3 — Android client (`android/`, after ingest contract freezes)

- [ ] 3.1 Gradle scaffold: minimal Compose single-activity (server URL, device token,
      HC permission grant, last-sync status) — headless-first, no dashboards
- [ ] 3.2 Room: `QueuedSample(id PK, kind, startTs, endTs, valueJson, queuedAt,
      uploadedAt?)`, `ChangesToken(recordType PK, token)`
- [ ] 3.3 Health Connect source — **read-only** (READ_STEPS/SLEEP/HRV/RESTING_HR/
      BLOOD_GLUCOSE, never WRITE): Changes API loop per type, token persisted
      transactionally with its batch; expired-token fallback = 30-day re-baseline
- [ ] 3.4 WorkManager: 15-min periodic (network-required, exponential backoff) —
      drain HC → Room, upload batches ≤500 to `/api/ingest/health-connect`
      (X-Api-Token), prune uploaded >7d
- [ ] 3.5 `SensorSource` interface (future BLE) — interface only
- [ ] Verify: end-to-end real phone → NAS: steps/sleep/HRV land in daily wellness
- [ ] Commit per sub-task; final: "Phase 3: Android Health Connect client"

---

## Phase 7 — Geospatial pipeline

- [ ] 7.1 `h3` dep + `RouteHex` table (`(user_id, hex_id, res) PK, sport, first_visited,
      visit_count, sum_speed/sum_hr/sum_sec/n`); sync-time hex upsert (run→res 9,
      ride→res 7, both→res 8) + one-shot backfill over existing activities
- [ ] 7.2 `GET /api/spatial/heatmap?sport&year&metric&bbox&zoom` → GeoJSON from
      aggregates (precomputed = fast; no tile server)
- [ ] 7.3 Map layers: separate toggleable Run (crimson/orange) vs Ride (cyan/blue)
      heatmaps; weight = speed (ride) / time-in-cell or HR (run)
- [ ] 7.4 Fog of War: `GET /api/spatial/exploration?region` (unique res-9 hexes / region
      bbox) + cleared-fog map layer + dashboard stat
- [ ] 7.5 Climb detection at sync: smoothed elevation, ≥3% sustained ≥300m segments,
      length×grade → Cat 4…HC → `Run.climbs_json`; rolling-grade histogram ×
      speed/HR/power → `Run.grade_analysis_json`; surface in run expand + Insights
- [ ] 7.6 OSM surface tags (Overpass, throttled + cached, degrade-to-null) →
      `Run.surface_json`
- [ ] 7.7 Wind: extend existing Open-Meteo call with wind speed/direction; mean
      route bearing vs wind → `Run.wind_json {headwindPct, avgHeadwindMph}`
- [ ] 7.8 Privacy zones: table + Settings CRUD; **read-time** redaction in route
      output (raw stays stored)
- [ ] Verify each: backfill on DB copy; screenshot heatmap layers; spot-check a known
      hilly run's climbs against Strava's segment data
- [ ] Commit per sub-task

---

## Phase 8 — Configurable dashboard

- [ ] Layout config in `sync_meta` (`user_key(uid,"dashboard_config")`) —
      `{widgets:[{id, pos, visible}]}`; `GET/PUT /api/dashboard/config`
- [ ] Extend `/api/dashboard/summary` with per-widget keys (readiness, pmc,
      todayWorkout+push state, weeklyRamp, gear, exploration, wellness, goals,
      records) — compute only active widgets
- [ ] Frontend: widget rendering from config, visibility toggles + reorder (up/down
      v1, no drag-grid)
- [ ] Verify: toggle/reorder round-trip; screenshot
- [ ] Commit: "Phase 8: configurable widget dashboard"

---

## Phase 9 — Credentials & nutrition

- [ ] 9.1 `app/crypto.py` (AESGCM, `ENCRYPTION_KEY` env, plaintext fallback with
      startup warning); migrate `ProviderCredential.password` to encrypted-at-rest
- [ ] 9.2 Per-user LLM keys (`provider="anthropic"|"openai"` rows, encrypted);
      `assistant.py` prefers user key over system env; Settings UI (masked)
- [ ] 9.3 Nutrition schema: `NutritionLog (id, user_id, ts, meal_name, calories,
      protein_g, carbs_g, fat_g, source)`, `MacroTarget (user_id PK, …)`,
      `DeliveryImport (id, user_id, provider, imported_at, item_manifest_json)`
- [ ] 9.4 `POST /api/nutrition/import` manifest upload parser (CSV/HTML — best-effort,
      Garmin-ZIP-import pattern) + manual log CRUD + daily macro summary in stats
- [ ] 9.5 LEA flag in `stats.readiness`: 7d intake < 0.85 × (BMR est + activity kcal),
      only when logging coverage ≥5/7 days; generator treats as one flag; two
      consecutive weeks → cap freeze
- [ ] Commit per sub-task

---

## Phase 10 — Vitals & biomarkers

- [ ] 10.1 (done in 2.1/2.2 + 3.3 — glucose ingest end-to-end; verify here and mark)
- [ ] 10.2 `LabPanel` table (`id, user_id, lab_date, source, markers_json`); manual
      CRUD + Settings UI (PDF parsing explicitly deferred)
- [ ] 10.3 Sticky lab flags in readiness (`ferritin_low`, `crp_elevated`,
      `glucose_instability` TIR<70% 7d) — act as ramp-cap ceilings (0% increase),
      not daily downgrades; persist until next panel; rationale named in notes
- [ ] Commit per sub-task

---

## Cross-cutting features (slot in any time after the listed dependency)

- [ ] **Daily AI insight card** (after 0.3): Sonnet one-shot (separate short-lived SDK
      client, same persona prompt), cached per day in sync_meta, Home widget —
      existing backlog item
- [ ] **Weekly coach report** (after 6.2): Sonnet one-shot every Sunday evening —
      week's load vs plan, readiness trend, next week rationale; persona-toned;
      stored + surfaced on Home, push notification
- [ ] **Workout critique** (after 4.3): coach compares completed run vs prescription
      (existing `record_workout_completion` path) — existing backlog item
- [ ] **Calendar view** (after 0.4): month grid, planned vs completed workouts +
      recovery; click-through to day detail
- [ ] **Demo mode** (after 0.10): `DEMO_MODE=1` seeds a synthetic-but-plausible
      dataset (generator script, ~1yr of runs/rides/strength/wellness); screenshot-rich
      README for the public repo
- [ ] **Race-day pack** (after 4.1): pacing plan from current fitness + race-day
      weather forecast + taper countdown, driven by the race Goal
- [ ] **Backups/export** (any time): nightly SQLite `VACUUM INTO` snapshot to the data
      volume (rotate 14), `GET /api/export` full-data zip; Settings section
- [ ] **Year-in-review** (after 7.1): annual summary page (totals, PRs, exploration,
      consistency), shareable image
- [ ] **Standing backlog** (fold in opportunistically): unified sync coordinator with
      per-source backoff; verify Garmin auto-retry/batch-pause on a real streak;
      deeper strength-training tracking (progression charts per exercise from
      `exercise_sets_json`)

---

## Deferred / explicitly out of scope

- PostGIS/PostgreSQL migration (rejected at current scale — see ROADMAP)
- MVT vector tiles / Mapbox (precomputed GeoJSON + Leaflet instead)
- Lab-panel PDF parsing (manual entry first)
- Meal-delivery live API sync (no official APIs; manifest import only)
- BLE sensors (interface reserved in 3.5)
- Local path / container / volume renames to `hale` (maintenance window; ROADMAP)
