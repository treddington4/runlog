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
- [x] Persistent left sidebar (desktop ≥900px) / bottom tab bar (mobile): Home, Goals,
      Activities, Insights, Map, Chat, Workouts, Settings — `min-[900px]:` arbitrary
      Tailwind breakpoint used for the exact 900px cutoff (`Shell.tsx`)
- [x] React Router routes per tab; HALE wordmark (white `HAL` + amber `E`) + tagline
      "HALE's Adaptive Life Engine"; race-countdown chip in the shell header —
      `RaceCountdown.tsx` reads `daysUntil` from `/api/goals`' already-computed
      `progress` field (`stats.goal_progress()`) rather than recomputing date math
      client-side like the legacy `renderRaceCountdown()` did
- [x] Loading skeleton components + empty-state component (icon, message, CTA) —
      reused by every tab port below — `components/ui/skeleton.tsx` +
      `components/ui/empty-state.tsx`; all 8 routes currently render
      `PlaceholderPage` (thin `EmptyState` wrapper) pointing at the PLAN.md section
      that ports them, swapped out route-by-route in 0.3–0.9
- [x] Verify: screenshot desktop + mobile viewports — `tsc -b --noEmit` and `oxlint`
      clean (same one expected `button.tsx` warning), `npm run build` succeeds,
      screenshotted Home/Goals/Workouts routes at both viewports via the NAS-hosted
      dev server (see `.RUNBOOK.md`): sidebar nav + active-route highlighting work
      correctly on desktop, bottom tab bar (all 8 icons, not cramped) + top header
      work correctly on mobile, race-countdown chip shows real data ("53 days to
      Wedding") in both layouts
- [x] Commit: "Phase 0.2: app shell — sidebar/bottom-tab nav, skeletons, empty states"

### 0.3 Home tab port
- [x] Stat strip (fast paint from `/api/dashboard/summary` headerStats, exact numbers
      after `/api/runs` — preserve the existing two-source pattern), goals cards,
      dashboard cards, wellness cards — added TanStack Query (`lib/queryClient.ts`)
      for shared/cached fetching (`hooks/useRuns.ts`, `useGoals.ts`,
      `useDashboardSummary.ts`, `useWellness.ts`); `lib/runs.ts` ports
      `mergeDuplicateRuns`/`isLikelyDuplicate`/`mergeRunPair`/`canonicalActivityType`
      1:1 from `app.js` (same client-side, never-in-storage duplicate merge — see
      CLAUDE.md); `RaceCountdown` refactored onto the shared `useGoals()` query
      instead of its own fetch, so the chip and Home's Goals section can't drift
- [x] Card component system (replaces settings-row-for-everything): `ChartCard` +
      `CardGrid` (`components/home/`) — title/value/sub-metric hierarchy, hover
      state + click-through navigation on `onClick` (`data-nav-tab`/`data-nav-run`
      from the legacy `wireNavCards()` become `navigate("/activities?filter=...")`
      / `navigate("/activities?run=...")` — query params 0.5's Activities port
      will read); `GoalCard` ports the race/consistency/distance_target dispatch
      from `goalCardBody()`
- [x] Verify: side-by-side screenshot vs legacy Home; all numbers identical —
      `tsc`/`oxlint`/`build` clean via the NAS-container workflow; screenshotted
      desktop + mobile against the live backend and confirmed byte-for-byte
      identical values against a fresh legacy-Home screenshot (This week 10.0 mi,
      avg pace 10:57/mi, 201 runs, breakdown line, both goal cards, all 7 dashboard
      cards incl. bar-fill widths/colors, all 3 wellness cards); confirmed the
      mobile bottom-tab-bar "gap" seen in a full-page capture is a `position:fixed`
      screenshot artifact, not a real overlap (re-verified with a scrolled
      viewport-only capture)
- [x] Commit: "Phase 0.3: Home tab ported"

### 0.4 Workouts + Recovery port
- [x] Unified date-ordered list (workouts + recovery sessions interleaved — preserve
      current behavior), structured-steps rendering with expandable how-to details,
      status actions, new-workout modal — added shadcn Dialog/Input/Label/Select/
      Textarea primitives (`@radix-ui/react-dialog`, `-label`, `-select`); TanStack
      Query mutations (`hooks/useWorkouts.ts`) invalidate the one list that actually
      changed rather than a full-tab re-render
- [x] Verify: screenshot; create/edit/delete round-trip against live API — caught and
      fixed a real bug during verification: `Workout.steps` is genuinely nullable
      (not just `[]`) for Garmin-suggested workouts with no structured steps, which
      the initial port typed as non-nullable and crashed `WorkoutCard` on
      (`Cannot read properties of null (reading 'length')` — legacy app.js's
      `w.steps && w.steps.length` guard had this right, the port initially didn't);
      fixed the type + render guard, re-verified clean. Confirmed real Garmin-
      suggested workouts, badges, multi-line notes, and the interleaved recovery
      session all render correctly; did a real create (via the actual form) →
      confirmed via `GET /api/workouts` → delete (via the actual UI) → confirmed
      gone via `GET /api/workouts` round-trip against the live backend, test data
      cleaned up after
- [x] Commit: "Phase 0.4: Workouts tab ported"

### 0.5 Activities (Runs) port
- [x] Run cards (badges, mini-stats, weather, dynamics rows), expand with splits/
      intervals/inline map, edit modal (activity-family-aware fields — preserve
      `isDistanceActivity` logic), filter bar (modes, type select, date nav) —
      `components/activities/`: `RunCard`, `SplitsTable`, `IntervalsTable`,
      `ExerciseSetsTable`, `MiniMap` (Leaflet, one instance per expanded card,
      cleans up on unmount/route-change), `EditRunDialog`, `FilterBar`; ported
      `mergeDuplicateRuns`'s partner logic (GAP/`gapSecPerMi`+`minettiCost` in
      `lib/gap.ts`, explicitly the documented client-side GAP duplicate per
      CLAUDE.md), route-gap splitting (`lib/route.ts`), HR-floor computation
      (`hooks/useHrFloor.ts`) faithfully; fixed one real legacy bug in passing —
      badge alpha colors were built by string-concatenating a hex suffix onto
      `TYPE_COLORS`, which silently produced invalid CSS for the `rgb(...)`
      entries (Interval/Long Run) — `lib/color.ts`'s `withAlpha()` parses either
      form properly instead of reproducing the same breakage
- [x] While here: filter-driven fetching — `/api/runs` gains `start`/`end`/`all`
      params (`main.py`); default load = last 90 days; `all=true` bypasses the
      window for callers needing true all-time totals (Home's exact stat-strip,
      `hooks/useRuns.ts`'s `useAllRuns()`) — wider Activities filters (6 Months/
      Year/All) fetch on demand via TanStack Query's per-key caching, no explicit
      pagination code needed; client merge/dedup logic (`lib/runs.ts`) unchanged
- [x] Verify: payload size before/after; screenshot; edit round-trip — deployed
      the backend change and confirmed via curl: default 148 runs vs `all=true`'s
      524, explicit `start`/`end` correctly bounded; payload 7.24MB → 2.85MB (61%)
      on the default view. Screenshotted the filter bar (all 8 modes, prev/next
      nav, custom range, type select) and an expanded run card against real data
      — numbers matched a direct API fetch exactly (splits, mini-stats, weather).
      Separately verified the two less-common expand paths against real runs:
      a strength session's `ExerciseSetsTable` (warmup badges, per-exercise set
      grouping) and an interval run's `IntervalsTable` + mini-map. Did a real
      edit (RPE + notes) via the actual dialog on a real run, confirmed via
      `GET /api/runs`, then reverted it back to its original `null`/`null` via a
      direct PATCH (this touches real synced data, unlike Workouts' disposable
      test rows, so the round-trip had to restore state exactly rather than
      delete). Console/pageerror-checked the route before screenshotting — no
      errors.
- [x] Commit: "Phase 0.5: Activities tab ported + windowed /api/runs fetching"

### 0.6 Insights port
- [x] All existing charts (temp-vs-pace/HR/cadence scatter, weekly mileage, pace/
      cadence/HR trend, 7-day rolling pace, cadence-vs-pace scatter, steps, resting
      HR, VO2max, sleep score/duration, sleep-stage hypnogram) ported — `chart.js`
      added as a real dependency (legacy had no build step so it loaded via CDN);
      `lib/chartTheme.ts`'s `applyChartTheme()` centralizes the palette + grid/tick
      defaults legacy hand-repeated per chart (called once in `main.tsx`, before
      any chart mounts anywhere — fixes a real legacy fragility where Chat's charts
      silently depended on Insights having rendered first to set `Chart.defaults`);
      `components/insights/ChartCanvas.tsx` is a small per-canvas Chart.js
      lifecycle wrapper (create/destroy via `useEffect` cleanup keyed on a
      `useMemo`'d config) — deliberately not the legacy global `charts` array +
      manual `destroyCharts()`, since React's unmount timing doesn't line up with
      that pattern's assumptions; `ChartPanel.tsx` ports the title/sub/canvas/
      empty-state card shell (`chartCardHTML`); `lib/sleepStages.ts` ports the
      hypnogram's EST-timezone tick/label helpers 1:1; reused the existing
      `FilterBar`/`useHrFloor`/`isPlausiblePace`/`isPlausibleHR` rather than
      duplicating; added `api.steps()`/`api.sleepStages()` + `useSteps`/
      `useSleepStages` hooks (previously unused by any ported tab). One
      Chart.js/TS typing gap hit and resolved: the sleep hypnogram's floating-bar-
      on-a-category-axis pattern (`x: [start,end], y: label`) isn't modeled by
      Chart.js's bundled bar-chart types (they expect `Point`/`BubbleDataPoint`) —
      narrowly cast just the `dataset.data` field rather than the whole config
      object, which preserves contextual typing (and real type-checking) for
      every sibling callback (tooltip formatters, `afterBuildTicks`)
- [x] Verify: screenshot vs legacy for chart parity — `tsc -b --noEmit` and
      `oxlint` clean (same one expected `button.tsx` fast-refresh warning as every
      prior phase), `npm run build` succeeds. Screenshotted against the live NAS
      backend at both the default 7-day range and a wider "Month" range: real
      data renders correctly in every panel — temp-effect scatters, weekly
      mileage bars, the dual-axis pace/cadence/HR trend line with its legend row,
      7-day rolling pace, cadence-vs-pace scatter, daily steps bars, resting HR,
      VO2max (stepped line), sleep score+duration dual-axis line, and the sleep
      hypnogram (correct per-stage colors, EST time-of-night axis, working
      night-picker showing "2026-07-20") — no broken canvases, no console/page
      errors. Confirmed chart cleanup works correctly by navigating Insights →
      Activities → Insights and re-checking for console errors (none) — this
      exercises the `ChartCanvas` unmount path the legacy app never had to handle
      (it only ever tore down charts on tab-*in*, never on tab-away)
- [x] Commit: "Phase 0.6: Insights tab ported"

### 0.7 Map port
- [x] Leaflet map, location select, metric modes (density/pace/HR/cadence/grade) —
      per-run mini-maps were already ported in 0.5 (`MiniMap.tsx`). New:
      `lib/mapClusters.ts` (greedy proximity clustering + centroid, ported from
      `clusterRuns`/`clusterCentroid`), `lib/mapHeat.ts` (gradients, `METRIC_CONFIG`,
      `heatColor`, `buildMetricSegments`), `api.geocode()` (wraps the existing
      `/api/geocode` reverse-geocoding endpoint — server-cached, rate-limited,
      unchanged), `MapPage.tsx`. Exported `haversineKm`/`computeGapThresholdKm`
      from `lib/route.ts` (previously internal) since the metric-segment builder
      needs the gap threshold directly, not just the pre-split polyline segments
      `splitRouteAtGaps` produces. Ported the dark-theme Leaflet chrome overrides
      (`.leaflet-control-zoom`/`.leaflet-control-attribution`/`.leaflet-container`)
      into `index.css`, which had been missed in 0.5 (MiniMap's `zoomControl:false`
      meant the gap was invisible until Map's full page showed a visible zoom
      control). One deliberate behavior change from legacy: the Leaflet map
      instance is created on mount / destroyed on unmount (a real `useEffect`
      lifecycle) rather than ported as legacy's module-level `if (!map)` singleton
      that persists across tab switches — legacy's approach only worked because
      the vanilla app never unmounts tab content (just toggles `display:none`);
      this component genuinely mounts/unmounts with route navigation, so
      create-on-mount/destroy-on-unmount is the correct mapping, not a shortcut
- [x] While here: found and fixed a real regression from Phase 0.5's backend
      change — `GET /api/runs` now defaults to a 90-day window, but the
      still-in-production legacy `app.js` was never updated to pass `all=true`,
      so the live app had silently lost access to run history older than 90 days
      (Map's clustering, Insights' all-time rolling-pace lookback, etc.). Fixed
      and deployed independently (commit `e6e8f60`), verified live via curl
      (148 windowed vs 524 all-time) and by confirming the deployed `app.js`
      actually contains the fix
- [x] Verify: screenshot each metric mode — `tsc -b --noEmit` and `oxlint` clean
      (same one expected `button.tsx` warning). Caught and fixed a real bug during
      first-pass verification: the map canvas rendered completely blank because
      the component's loading-state `Skeleton` early-return meant the map
      container `<div>` didn't exist in the DOM on first mount (when
      `useAllRuns()` data was still loading) — since the map-creation effect has
      an empty dependency array, it only runs once, found `containerRef.current`
      null, and never created the Leaflet map at all, even after data arrived and
      the component re-rendered with the container present. Fixed by removing the
      early return (the container now always renders; the "no items yet" empty
      state already degrades correctly during the brief loading window). After
      the fix, screenshotted all 5 modes (Density/Pace/Heart Rate/Cadence/Grade)
      against live data — correct tiles, dark zoom-control styling, geocoded
      location label ("Manchester, New Hampshire"), correct per-mode gradient
      colors and legend text (e.g. "Pace · 160 runs · blue 23:04/mi → red
      2:16/mi"), and "All locations" correctly zooming out to include a real
      travel run near the Dominican Republic. Confirmed the map's create/destroy
      lifecycle is clean by navigating Map → Insights → Map and re-checking for
      console errors (none) — the map correctly re-initializes and re-auto-selects
      the most-recent-activity cluster on remount
- [x] Commit: "Phase 0.7: Map tab ported"

### 0.8 Chat port
- [x] Thread UI, tool-call transparency chips, inline charts (`charts` payload),
      persona-aware empty state, send flow with optimistic pending bubble —
      `lib/chatMarkdown.ts` ports the legacy hand-rolled Markdown subset
      (`escapeHtml`/`inlineMd`/`splitTableRow`/`renderMarkdown`) line-for-line —
      escapes everything first, only ever injects tags it generates itself, so
      it's safe to render via `dangerouslySetInnerHTML` despite not being a real
      markdown library; `components/chat/ChatBubble.tsx` (bubble shell + tool
      trace + charts), `ChatChart.tsx` (own `useMemo`'d Chart.js config, reusing
      0.6's `ChartCanvas`/`chartTheme` — no manual `chatCharts` array/
      `destroyChatCharts()` needed, React's per-component effect cleanup gives
      Insights-vs-Chat chart isolation for free), `ChatInputBar.tsx` (owns its
      own input state so keystroke re-renders never touch the message list or
      any mounted chart instance — the React-idiomatic replacement for legacy's
      DOM-mutation approach, which never re-rendered the thread per keystroke
      either, just via a different mechanism). `pages/ChatPage.tsx` reuses
      `DashboardCards` exported from `HomePage.tsx` (matches legacy's
      `renderChatTab()` reusing the same `renderDashboardCards()` Home uses).
      New persona-aware empty state (`PERSONA_LABELS`, short UI glosses of
      `coach.py`'s `PERSONA_PROMPTS` tones, fetched via new `api.coachPersonality()`)
      — this is a deliberate addition beyond legacy parity per this section's own
      checklist, since legacy has no empty state at all (blank thread pane until
      the first message)
- [x] While here: `api.sendChatMessage()` never throws — returns a discriminated
      `ChatSendResult` (`{ok:true,...}` or `{ok:false, kind:"http"|"network", message}`)
      so the page can reproduce legacy's exact two different error strings
      (`Error: ${detail}` for a real HTTP error vs. the bare literal
      `"Network error — try again."` for a fetch failure) without a try/catch
      in the component
- [x] Verify: real message round-trip; history renders with charts — `tsc -b
      --noEmit` and `oxlint` clean (same one expected `button.tsx` warning),
      `npm run build` succeeds. Screenshotted against live data (14 real
      persisted messages, `insulting` persona active): collapse/expand toggle
      works ("Show earlier (12)" / "Hide earlier"), markdown renders correctly
      (bold, lists, dashes), tool-trace chip shows real bare tool names
      (`get_scheduled_workouts, get_run_summary, get_training_load_trend,
      get_health_history`). Caught and fixed a real bug during verification:
      user-message bubbles showed literal `&#39;` instead of an apostrophe —
      `ChatBubble` was calling `escapeHtml()` on plain JSX text children, but
      React already escapes text nodes itself; `escapeHtml` is only correct for
      the markdown branch, which builds a raw HTML string for
      `dangerouslySetInnerHTML`. Removed the double-escaping, re-verified with a
      screenshot showing the correct apostrophe. Did a real send round-trip
      (not a mock): typed a message, clicked Send, confirmed the `POST
      /api/chat/message` request/response over the network, and confirmed the
      real reply rendered in the active `insulting` persona's tone, input
      cleared and re-enabled correctly. Deliberately did **not** exercise the
      "Clear conversation" button against this live data — unlike Workouts'
      disposable test rows, resetting Chat destroys the entire real
      conversation history irreversibly with no undo, so this path was verified
      by code review (the handler is a two-line `resetChat()` + cache-clear)
      rather than a live click
- [x] Commit: "Phase 0.8: Chat tab ported"

### 0.9 Goals + Settings port
- [x] Goals CRUD + progress cards — `GoalCard.tsx` (already ported in 0.3) extended
      with optional `onEdit`/`onComplete`/`onAbandon`/`onDelete` props rendering the
      legacy action row (Home's usage is unaffected, passes none of them);
      `ChartCard` gained a generic `actions` slot to carry them. New
      `GoalFormDialog.tsx` (discriminated race/consistency/distance_target fields,
      activity-type checklist data-driven from real run history via `useAllRuns()`,
      same "only send the fields relevant to the current type" behavior as legacy
      — switching goal type on edit leaves old fields stale server-side but
      harmless, since `goal_progress()`'s dispatch is entirely keyed on
      `goal_type`), `GoalsPage.tsx` (Active/Completed/Abandoned sections),
      `useGoalMutations()` (create/update/delete, one shared `["goals"]`
      invalidation covering the Shell's race countdown and Home's goals section too)
- [x] Settings: connections, sync controls with live sync/backlog status panels,
      coach personality, Garmin import, About — `hooks/useSettings.ts` ports every
      remaining endpoint (`stravaStatus`, `garminStatus`, `syncMeta`, `connections`,
      `routeDiagnostics`, `config`) plus `useSyncStatus`/`useBacklogStatus`, which
      reproduce the poll-only-while-running discipline (see the flashing-loop bug
      history) via TanStack Query's `refetchInterval` callback — `(query) =>
      query.state.data?.status === "running" ? interval : false` — rather than
      porting the manual `setTimeout`/`stopBacklogPolling`/`checkBacklogOnce` state
      machine: a query with no active observers simply doesn't refetch, so there is
      no way to reintroduce the original unconditional-poll bug this pattern was
      written to fix. `manualSync`/`backlogSync`/`garminImport` in `api.ts` never
      throw (mirrors Chat's `sendChatMessage` convention from 0.8) so the UI can
      show the exact inline failure text a non-OK response or network error
      produces. `components/settings/SyncControls.tsx` is shared by both sources'
      Strava/Garmin sections
- [x] Verify: sync-now round-trip shows live status; screenshot — `tsc -b --noEmit`
      and `oxlint` clean (same one expected `button.tsx` warning), `npm run build`
      succeeds. Screenshotted Goals (active/completed cards with real countdown/
      progress data) and every Settings section against live data — status dots,
      last-synced/last-error text (including Garmin's real rate-limit cooldown
      message), route-source diagnostics, resting HR, steps, connections, coach
      personality, sync schedule, About. Did real round-trips against the live
      backend, not mocks: created a distance-target test goal through the actual
      dialog (confirmed via screenshot: "0 / 100 mi", "0% complete"), then deleted
      it through the UI and confirmed via `GET /api/goals` it's gone; clicked
      "Sync Now" for Strava and confirmed via network-request logging that the
      button correctly POSTs, the status panel shows "Syncing…"/"N runs synced so
      far…" while running, polling stops and the button/panel revert to idle once
      the job finishes; toggled the coach personality select (Insulting →
      Encouraging → back to Insulting) and confirmed the "Saved" flash and that
      `POST /api/coach/personality` actually fired each time
- [x] Commit: "Phase 0.9: Goals + Settings ported"

### 0.10 Cutover
- [x] Dockerfile → multi-stage: `node:22-slim` builds `web/dist` → copied into the
      python image; FastAPI serves `web/dist` at `/` (keep legacy at `/legacy` for
      one release) — `main.py`'s final route registration replaced the old bare
      `app.mount("/", StaticFiles(directory="static", html=True))` with: a
      `/legacy` mount for the old app unchanged, a plain `StaticFiles` mount at
      `/assets` for Vite's content-hashed bundle, and an explicit catch-all
      `@app.get("/{full_path:path}")` (`serve_web_app`) that serves a real file
      in `web-dist/` if one exists at that path, else falls through to
      `index.html` — needed because `StaticFiles(html=True)` only auto-serves
      `index.html` at a mount's own root, not for arbitrary unmatched sub-paths,
      so a hard reload on a React Router route like `/insights` would otherwise
      404 rather than letting client-side routing take over. Falls back to
      serving legacy at `/` if `web-dist/` doesn't exist (e.g. local dev running
      `main.py` directly against the Vite dev server on :5173 instead of a built
      image) so the app is never left with nothing at `/`
- [x] `scripts/screenshot.py`: updated tab navigation for the new shell — the old
      `navigateTo()` global JS function doesn't exist in the new frontend
      (React Router paths, not client-side tab-switching in one page); replaced
      with a `TAB_PATHS` map and a real `page.goto()` per tab, which is simpler
      than the old approach and works identically across every viewport
      regardless of which nav chrome (sidebar vs. icon-only bottom bar) is visible
- [ ] Delete `app/static/` legacy after one week of parity (separate commit) —
      deliberately not done yet; `/legacy` needs to stay reachable for the parity
      window described above before this is safe
- [x] Verify: full-container build + deploy; every tab screenshot; `STATUS.md` +
      `CLAUDE.md` updated (build step now exists; architecture section rewritten) —
      caught and fixed one real Dockerfile bug during the first build attempt
      (`chown ... /web-dist` referenced an absolute path that doesn't exist —
      the copy target was `/app/web-dist` given `WORKDIR /app`, already covered
      by the recursive `chown -R runlog:runlog /app`). After the fix: full
      `docker compose up -d --build` succeeded; curl-verified `/` serves the new
      React shell (real `<script src="/assets/...">` tags), `/legacy` serves the
      unchanged old app, a hard-reload-style request to `/insights` returns 200
      (SPA fallback working), `/api/config` still responds correctly, and
      `/assets/*` files serve with 200. Ran the full updated `scripts/screenshot.py`
      suite (all 8 tabs × desktop + mobile = 16 screenshots) against the live
      production deployment at `192.168.68.80:8000` (not the dev server) and
      read every one: Home/Goals/Activities/Insights/Map/Chat/Workouts/Settings
      all render real data correctly on both viewports, mobile bottom nav intact.
      Updated `CLAUDE.md`'s "What this is"/Commands/Architecture sections (new
      "Frontend" section describing the SPA-fallback serving approach, corrected
      the stale "no Node.js needed in the Dockerfile" claim, updated file-path
      references from `app/static/app.js` to their `web/src/` equivalents) and
      `STATUS.md` (new frontend-rewrite-complete status line, resolved the
      "no visual QA pass" backlog item, corrected the GAP-duplication note to
      mention all copies)
- [x] Commit: "Phase 0.10: cutover to built frontend"

### 0.11 PWA
- [ ] Manifest (name HALE, amber-E icon set), service worker (offline shell,
      network-first API), web push: backend `POST /api/push/subscribe` +
      `pywebpush` sends on daily insight/generated workout
- [ ] Verify: Lighthouse installability pass; real push received on phone
- [ ] Commit: "Phase 0.11: PWA + push notifications"

---

## Phase 1 — Multi-tenant isolation & auth

### 1.1 daily_steps composite PK
- [x] Copy-table migration in `models.init_db()` (SQLite can't alter PKs): new table
      PK `(date, user_id)`, backfill NULL user_id → `'default'`, swap, idempotent —
      `_migrate_daily_steps_composite_pk()` reflects the live table's exact column
      set via `PRAGMA table_info` (so it carries any column added since by
      `_migrate_add_missing_columns()`, which runs first in `init_db()`), copies
      every row with `COALESCE(user_id, 'default')`, then drops/renames. Idempotent
      via a `PRAGMA table_info` check for whether `user_id` is already part of the
      primary key — true for both an already-migrated DB and a brand-new one
      (`create_all()` already builds the composite-PK schema from scratch there).
      `DailySteps.user_id` changed from `nullable=True` to `primary_key=True,
      default=DEFAULT_USER_ID`
- [x] Update every `db.get(DailySteps, date)` call site (garmin_sync, garmin_import,
      models.py's `day_needs_wellness_sync`) to composite `(date, user_id)` lookup —
      `stats.py`'s `DailySteps` queries use `.query().filter()`, not `.get()` by PK,
      so they needed no change (already `owned_by()`-scoped). `day_needs_wellness_sync`
      gained a `user_id` parameter, threaded from its one call site in
      `garmin_sync.py`. No `coach.py` call site exists — that module doesn't touch
      `DailySteps` at all
- [x] Verify: migration on a **copy** of the live DB; row counts identical; wellness
      cards still render — copied the live DB out of the running container
      (`docker cp`), ran the actual `_migrate_daily_steps_composite_pk()` function
      against the copy inside a throwaway container built from the real app image
      (so real SQLAlchemy/dependencies, not a bare Python venv): 208 rows before
      and after (no data loss), PK correctly `(date, user_id)`, zero NULL `user_id`
      rows, and a second run confirmed idempotency (no further change). Deployed
      for real via `docker compose up -d --build`; confirmed via a fresh `sqlite3`
      read against the actual production DB (not just the copy) that the composite
      PK and all 208 rows are present; `GET /api/wellness`/`GET /api/steps` both
      still return correct real data post-migration. Did not force a live Garmin
      sync to exercise the write path directly, since Garmin was mid-rate-limit-
      cooldown at deploy time and forcing a sync would only have extended that
      backoff — relied instead on the migration's data-preservation proof plus
      direct review of every updated `.get()`/constructor call site
- [x] Commit: "Phase 1.1: daily_steps composite PK migration"

### 1.2 Auth schema
- [x] `User.oidc_subject` (unique, nullable) — `users` already in `_MIGRATABLE_TABLES`,
      so `_migrate_add_missing_columns()` picks it up with no extra migration code
- [x] New `ApiToken` table: `id, user_id, token_hash (sha256), name, created_at,
      last_used_at` — device tokens for headless clients. A whole new table
      (`create_all()` creates it from scratch), no `_MIGRATABLE_TABLES` entry needed
- [x] Verify: deployed via `docker compose up -d --build`; confirmed against the
      live production DB that `users` gained the `oidc_subject` column and
      `api_tokens` exists as a real table; confirmed `GET /api/coach/personality`
      (a `User`-table read) and `GET /api/config` still work correctly post-migration
- [x] Commit: "Phase 1.2: auth schema (oidc_subject, api_tokens)"

### 1.3 Auth middleware
- [x] `app/auth.py`: `current_user_id()` FastAPI dependency — `AUTH_MODE=disabled`
      (default) → DEFAULT_USER_ID; else Bearer JWT (PyJWT + cached JWKS fetch;
      env `OIDC_ISSUER/OIDC_AUDIENCE/OIDC_JWKS_URL`; auto-provision User on first
      valid sub) or `X-Api-Token` (hash lookup, stamp last_used_at); else 401 — JWKS
      cache is a module-level dict with a 1hr TTL, force-refetched once if a token's
      `kid` isn't found in the current cache (covers an IdP key-rotation edge case
      without needing that hourly wait). Not wired into any endpoint yet — that's
      Phase 1.4; this module is dormant/unused by itself, exactly why disabled-mode
      verification below is trivially "zero behavior change"
- [x] Added `PyJWT`/`cryptography` to `requirements.txt` — had to bump the initial
      `PyJWT==2.9.0` pin to `2.10.1` after a real dependency-resolution conflict:
      `claude-agent-sdk`'s `mcp` dependency requires `pyjwt>=2.10.1`
- [x] Verify: disabled mode = zero behavior change (curl suite); enabled mode rejects
      missing/bad tokens, accepts a hand-built test JWT — deployed (confirming the
      new deps installed cleanly and the app starts with zero behavior change, since
      nothing imports `auth.py` yet) and curl-verified `/api/config` still works.
      Wrote two isolated test scripts run inside the real app image against a
      throwaway scratch DB (`DB_PATH` pointed at a `/tmp` file, never the real
      production data): **disabled mode** — confirmed `current_user_id()` returns
      `DEFAULT_USER_ID` unconditionally even with garbage `Authorization`/
      `X-Api-Token` headers. **enabled mode** — generated a real RSA keypair,
      built a matching JWKS, hand-signed a test JWT, and pre-populated
      `auth._jwks_cache` (so no real network fetch to a real IdP was needed):
      confirmed a valid JWT auto-provisions a `User` row with the correct
      `oidc_subject`, a second call with the same `sub` returns the same
      `user_id` (no duplicate), a malformed JWT and a missing credential both
      correctly 401, and the `X-Api-Token` path correctly resolves via SHA-256
      hash lookup, stamps `last_used_at`, and 401s on an unknown token. All test
      artifacts (scratch DBs, scripts) cleaned up afterward
- [x] Commit: "Phase 1.3: OIDC/JWT + device-token auth middleware"

### 1.4 Endpoint threading
- [x] Every endpoint in `main.py`: `user_id = Depends(auth.current_user_id)` replaces
      DEFAULT_USER_ID literals — all ~40 endpoints threaded (catalogued exhaustively
      first via a research pass before editing). Along the way, fixed several endpoints
      that had **no user scoping at all** (not just a hardcode) prior to this phase:
      `PATCH /api/runs/{run_id}` (`db.get(Run, run_id)` → `owned_by()`-filtered query),
      `GET /api/garmin/route-diagnostics` (added an `owned_by()` filter it never had).
      The 9 `coach.py`-backed endpoints (health-notes/workouts/recovery-*) turned out to
      already accept a `user_id` parameter (defaulting to `DEFAULT_USER_ID`) — main.py
      just wasn't passing it through; smaller fix than the original research pass
      expected, since it only needed call-site threading, not new function signatures.
      `/auth/strava/login`, `/api/geocode`, `/api/chat/status`, and the SPA catch-all
      stay unscoped (genuinely no user concept)
- [x] In-memory job state keyed `(user_id, source)` (quick-sync + backlog dicts) — both
      `_quick_sync_jobs`/`_backlog_jobs` switched from eagerly-initialized `{source: {...}}`
      dicts to lazily-created `{(user_id, source): {...}}` via `_get_quick_sync_job()`/
      `_get_backlog_job()` (`.setdefault(...)`), since the set of real users isn't known
      ahead of time the way the 2 fixed sources were
- [x] `sync_meta` scoping: `user_key(user_id, key)` helper (`models.py`) applied to
      every genuinely per-user key across `main.py` (`_record_sync`,
      `_refresh_dashboard_cache`, the dashboard cache pair, `manual_sync`/
      `start_backlog_sync`'s error-clear) and `garmin_sync.py` (the 4 rate-limit-cooldown
      helper functions gained a `user_id` parameter and now use `user_key()`; the
      adaptive-plan-last-checked and activities-backlog-offset/complete keys too).
      Deliberately **not** applied to the geocode cache (`f"geocode_{lat:.2f}_{lon:.2f}"`)
      — that's keyed by physical location, not by asker, and should stay one shared
      cache. `_next_auto_sync_time()` checks `DEFAULT_USER_ID`'s own namespaced key
      specifically (documented simplification — it's a one-time scheduler-startup
      heuristic to avoid hammering Strava right after a redeploy, not per-user data,
      and `_auto_sync()` already re-syncs every credentialed user on every tick
      regardless of what this heuristic decides). One-time copy of every pre-1.4
      global key to its `user_key(DEFAULT_USER_ID, key)` equivalent —
      `_migrate_sync_meta_to_user_keys()`, copies (not moves) so a rollback still reads
      its own expected keys, idempotent (skips a key whose namespaced target is already set)
- [x] Run-id collision guard: on cross-user id conflict in `_process_activity`, write
      `{source}_{user_id}_{activity_id}` — `models.resolve_run_id(db, source, activity_id,
      user_id)`, shared by both `strava.py` and `garmin_sync.py`'s `_process_activity`
      *and* their loop-level dedup-check call sites (both must agree on the same id for
      the same activity). Plain `f"{source}_{activity_id}"` id used in the common case
      (no existing row, or an existing row already owned by this user or unowned);
      falls back to the user-suffixed id only on a genuine cross-user conflict
- [x] Verify: full curl regression as default user; `STATUS.md` — deployed for real
      (`docker compose up -d --build`, confirmed clean startup logs) and ran a full
      curl regression across every read endpoint (all 200s) plus content-level checks
      confirming exact byte-for-byte-equivalent data to before the refactor (same sync
      timestamps — proving the one-time key migration correctly carried forward
      existing state, same route-diagnostics counts, same dashboard headerStats, same
      run counts windowed/all-time, same goal count). Verified a real write path
      end-to-end, not just reads: triggered `POST /api/sync/strava`, confirmed the job
      dict correctly tracked running→done under the new `(user_id, source)` keying,
      and confirmed `GET /api/sync/meta` reflected the new sync timestamp under the
      namespaced key. Screenshotted Home against the live production deployment —
      identical to pre-refactor, confirming the full stack (new frontend + refactored
      backend) still works together correctly
- [x] Commit: "Phase 1.4: per-user scoping of endpoints, job state, sync_meta"

### 1.5 Token management + onboarding
- [x] `POST/GET/DELETE /api/tokens` (raw token shown once); Settings UI section —
      the raw token (`secrets.token_urlsafe(32)`) is only ever returned from the
      create call; every other read persists/returns just its SHA-256 hash,
      matching `ApiToken`'s existing design from Phase 1.2. New `TokensSection` in
      Settings shows a one-time "copy now" box on create, plus a list of existing
      tokens (name/created/last-used) with a revoke action
- [x] First-run wizard (new frontend): connect Strava/Garmin → create goal —
      ~~confirm training config (feeds Phase 4's UserTrainingConfig)~~ struck: that
      table/settings don't exist yet (Phase 4 hasn't started), so there's nothing
      real to confirm — a step that configures nothing isn't worth building yet;
      revisit once Phase 4.2 ships. New `OnboardingPage.tsx` (`/onboarding`, outside
      the `Shell` nav chrome) with the 2 real steps, reusing `GoalFormDialog` from
      0.9 rather than a new form. New `useOnboardingGate()` hook (called from
      `Shell`) redirects there automatically only when every one of 4 signals
      agrees the account is genuinely fresh (no Strava, no Garmin, zero goals, zero
      runs) — deliberately conservative so it can never misfire against an
      already-populated account. While here: fixed a real gap noticed along the
      way — the new Settings page had no way to actually *connect* Strava if
      disconnected at all (legacy had this as a header button, never ported when
      the header was rebuilt in 0.2) — added a "Connect Strava" link to Settings'
      Strava section too, not just the wizard
- [x] Verify: token round-trip incl. ingest auth (after 2.2); wizard screenshot —
      the "(after 2.2)" qualifier in this checklist item is load-bearing: Phase
      2.2's ingest endpoint doesn't exist yet, so there's no real endpoint to test
      token-gated ingest auth against. Verified everything that *is* testable now:
      real `POST/GET/DELETE /api/tokens` round-trip against the live production
      backend (create → list shows it without the raw token → delete → list empty).
      Verified actual authentication (not just CRUD) in an isolated test — same
      technique as Phase 1.3, a throwaway scratch DB, never production data:
      created a token the same way the real endpoint does (`secrets.token_urlsafe`
      + SHA-256 hash), confirmed it authenticates via `X-Api-Token`, stamps
      `last_used_at`, and correctly stops authenticating once revoked (401).
      Screenshotted the wizard directly (`/onboarding`) against live production —
      both steps correctly detect and reflect the account's real state (Strava
      "Connected", Garmin "Configured", "4 goals set." on step 2) rather than
      showing empty-account UI against populated data. Screenshotted Home to
      confirm the onboarding gate correctly stays dormant for the real,
      already-populated account (no unwanted redirect)
- [x] Commit: "Phase 1.5: device tokens + onboarding wizard"

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
