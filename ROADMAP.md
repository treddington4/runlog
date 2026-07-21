# Roadmap

Long-term build plan. Condensed from full architecture planning; each phase is
independently shippable. Established verification discipline applies throughout
(syntax-check pre-deploy, curl against live deployment, screenshot script for UI,
migrations validated against a DB copy first).

## Naming

The project has outgrown "RunLog" (running + cycling + strength + sleep + recovery +
nutrition + vitals). **Decided: meliora** — Latin for "ever better," carrying the
project's thesis of continuous self-betterment (the tagline "ever better" ships in the
app header). In-app branding done; repo rename next (GitHub auto-redirects); local
paths/container names migrate later at a convenient maintenance window.

## Phase 0 — Frontend re-architecture (early, before complexity compounds)

Replace the single-file vanilla-JS frontend (`app/static/app.js`, ~2,700 lines,
innerHTML templates, no build step) with a component architecture able to carry the
premium-UI bar and the feature roadmap below (widget dashboard, dual heatmaps,
calendar).

- **Stack**: Vite + React + TypeScript + Tailwind + shadcn/ui. Rationale: largest
  premium component ecosystem for the least design effort; Chart.js and Leaflet carry
  over unchanged. (Svelte was the lighter alternative; ecosystem breadth won.)
- **Supersedes** the documented "no build step" principle — deliberate decision, made
  early instead of after a re-architecture becomes expensive.
- **Dockerfile**: multi-stage (node build → dist copied into the python image). Dev
  loop: Vite dev server proxying `/api/*` to the live backend.
- **Migration**: tab-by-tab port behind the same FastAPI API (API contracts unchanged);
  design tokens (spacing/radius/color/typography — sans-serif with tabular figures for
  stats) defined first, then components: sidebar nav (desktop) / bottom tabs (mobile),
  card system replacing the settings-row-for-everything pattern, skeleton loaders,
  proper empty states, icon set (Lucide).
- **PWA** at the end of this phase: installable, offline shell, web push (daily
  workout / insight notifications).

## Phase 1 — Multi-tenant isolation & auth

- Composite-PK migration for `daily_steps` (copy-table; SQLite can't alter PKs).
- OIDC/JWT middleware (`AUTH_MODE=disabled` default preserves single-user LAN
  deployments) + device API tokens (hashed at rest) for headless clients.
- Per-user scoping of `sync_meta` keys, in-memory sync-job state, Run-id collision
  guard. First-run onboarding wizard (connect providers → set goal → confirm zones).

## Phase 2 — Telemetry ingest API

- Raw-forever `health_samples` table + idempotent batch upsert endpoint
  (`POST /api/ingest/health-connect`), per-field source precedence (garmin >
  health_connect) rolled up into daily wellness. Blood glucose included in the kind
  enum from day one.

## Phase 3 — Android client (after backend contract freezes)

- Minimal headless-first Kotlin app: Health Connect **read-only** Changes API →
  Room offline queue → WorkManager batch upload over TLS (IP/domain/Tailscale all just
  a URL). `SensorSource` interface reserved for future BLE sensors.

## Phase 4 — Goal-driven daily workout generator

Deterministic rule engine (no LLM in the prescription path — auditable, testable):

- FIT-aligned structured steps (intensity / durationType time|distance|open /
  targetType hr_zone|hr_custom|power|pace|cadence).
- Phase periodization (base/build/peak/taper from goal date), 3:1 or 2:1 mesocycles
  with deload weeks, polarized/pyramidal distribution enforcement via rolling
  time-in-zone audit.
- Weekly ramp cap (default 3%, 2–5% valid) with readiness-triggered freeze;
  readiness gating from HRV baseline shift / resting-HR spike / sleep deficit /
  active health notes → tier downgrade, micro-deload, or rest.
- Two-a-days only in build/peak with modality split and min spacing; second session
  always recovery-intensity.
- Every readiness-driven cap/downgrade names its trigger in the workout notes
  (auditability rule).

## Phase 5 — Garmin workout push

- Direct push via `garminconnect` 0.3.6 workout API (constants verified fixed
  upstream); reuses existing login cache + rate-limit cooldown machinery. FIT-file
  generation documented as the escape hatch if the unofficial API breaks; third-party
  brokers rejected.

## Phase 6 — Training-load analytics (PMC)

- Per-activity TSS (hrTSS, rTSS-from-GAP fallback — reuse the existing Minetti GAP,
  never reimplement), NP/IF/VI/aerobic decoupling for rides, efficiency factor.
- Nightly CTL/ATL/TSB pipeline (`daily_metrics`), time-in-zone tracking, weekly plan
  actual-vs-cap. Gear lifecycle tracking (shoes/bike components, wear vs. replacement
  mileage).

## Phase 7 — Geospatial pipeline

- H3 hex indexing via the `h3` pip package on SQLite (PostGIS evaluated and rejected
  at this scale) — computed at sync time, stored as indexed aggregate rows.
- Sport-isolated heatmaps (run res-9 fine-grained vs ride res-7/8 corridors, separate
  toggleable layers + palettes), Fog-of-War exploration percentage per region.
- Climb auto-detection/classification (Cat 4→HC), rolling-grade × effort analysis,
  OSM surface tags (best-effort Overpass), wind vector computation from the existing
  weather enrichment, read-time privacy-zone redaction.

## Phase 8 — Configurable dashboard

- Widget-based Home: readiness, PMC, today's prescription + push state, weekly ramp,
  gear wear, exploration, wellness, goals. Layout stored per user; single batched
  payload endpoint computing only active widgets.

## Phase 9 — Credentials & nutrition

- Encrypted-at-rest credential storage (AESGCM; also fixes the existing plaintext
  Garmin-password limitation). Per-user LLM API keys with system-env fallback.
- Nutrition logs + macro targets; meal-delivery manifest import (upload-based parser,
  best-effort — no official APIs). Low-energy-availability flag feeding the
  generator's readiness gate (only with sufficient logging coverage).

## Phase 10 — Vitals & biomarkers

- Glucose time-series from Health Connect, linked to activity windows; time-in-range.
- Lab panel storage (manual entry v1; PDF parsing deferred). Sticky lab flags
  (ferritin/CRP) act as volume-cap ceilings, not daily whipsaws.

## Cross-cutting / accepted additions

- **Weekly AI coach report** — Sonnet one-shot (separate from the Haiku chat agent),
  persona-toned, grounded in the week's real data. Pairs with the daily insight card.
- **Calendar view** — month grid of planned vs completed workouts/recovery.
- **Demo mode** — synthetic dataset + screenshot-rich README so the public repo
  presents as a product.
- **Year-in-review** — annual summary from existing data.
- **Race-day pack** — pacing plan from current fitness + race-day weather + taper
  countdown, driven by the existing race Goal.
- **Scheduled backups + full data export** — make data ownership a visible feature.

## Sequencing

0 → 1 → 2 → 4 → 6 → 5 → 10.1 → 3 → 7 → 8 → 9 → 10.2/10.3.
Phase 7 is independent of auth/generator and parallelizable after Phase 1. Coach
report/calendar/demo mode slot in after Phase 0 gives them a component system to land
in.
