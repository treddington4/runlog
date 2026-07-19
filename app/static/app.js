const RUN_TYPES = ["Easy", "Tempo", "Interval", "Long Run", "Recovery", "Hill", "Race"];
const TYPE_COLORS = {
  Easy: "#5FD68A", Tempo: "#FFC857", Interval: "rgb(255,107,53)",
  "Long Run": "rgb(76,201,240)", Recovery: "#5A6270", Hill: "#B98CE0", Race: "#FF4D6D"
};
const SEGMENT_STYLE = {
  warmup: { label: "Warmup", color: "#8B93A1" },
  work: { label: "Work", color: "rgb(255,107,53)" },
  recovery: { label: "Recovery", color: "rgb(76,201,240)" },
  cooldown: { label: "Cooldown", color: "#8B93A1" },
};

let runs = [];
let goals = [];
let expandedId = null;
let currentTab = "home";
let charts = [];
let sleepHypnogramChart = null;
let chatCharts = []; // separate from `charts` (Insights) so switching tabs never tears down the other's charts
let filterMode = "rolling7"; // 'rolling7' | 'week' | 'custom' | 'all'
let filterAnchor = todayMidnight();
let customStart = addDays(todayMidnight(), -29);
let customEnd = todayMidnight();
let activityTypeFilter = "all";
let hrFloor = 30; // fallback until computeHRFloor() runs against real data

// ---------- Helpers ----------
function paceStr(sec) {
  if (!sec || !isFinite(sec)) return "--:--";
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
function timeStr(sec) {
  if (!sec) return "--";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.round(sec % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
// Below this, it's a sensor dropout (dead HRM/optical sensor mid-activity), not a real
// reading — no human sustains single-digit or near-zero bpm during exercise. Raw values
// stay stored exactly as synced (data ownership); this only gates chart/display use.
function isPlausibleHR(bpm) {
  return bpm != null && bpm >= hrFloor;
}
// A distance-sensor glitch (e.g. a treadmill session recording ~0 distance over real
// elapsed time) produces a nonsense pace when divided out — not slow running, a data
// artifact. Guards on both ends: too little distance for time/distance to mean anything,
// and a sane human-running pace range (well outside any real recorded pace in this app's
// data, including a genuine 25:00+/mi Covid-recovery jog). Raw stored value is untouched.
function isPlausiblePace(paceSecPerMi, distanceMi) {
  if (paceSecPerMi == null) return false;
  if (distanceMi != null && distanceMi < 0.1) return false;
  return paceSecPerMi >= 240 && paceSecPerMi <= 2400;
}

let restingHrFromGarmin = null; // real value from Garmin wellness data, once synced

// Prefers a real measured resting HR from Garmin (see garmin_sync._sync_resting_hr —
// unverified against the live API as of this writing, Garmin's been rate-limited all
// session) — floor = restingHR - 10%, per the user's own request. Until that's synced,
// falls back to a proxy derived from Strava history: the low end of real recorded
// exercise HR is always somewhat above true resting HR, so the 5th percentile of valid
// avgHR readings minus 10% is a safely conservative floor — flags obvious sensor
// dropouts (near-zero) without excluding genuinely easy/recovery efforts. Seeded with
// an absolute 20bpm sanity floor so a known glitch can't corrupt its own exclusion
// threshold.
function computeHRFloor() {
  if (restingHrFromGarmin) {
    hrFloor = Math.round(restingHrFromGarmin * 0.9);
    return;
  }
  const ABSOLUTE_MIN = 20;
  const validHRs = runs
    .filter((r) => isRunActivity(r) && r.avgHR != null && r.avgHR >= ABSOLUTE_MIN)
    .map((r) => r.avgHR)
    .sort((a, b) => a - b);
  if (!validHRs.length) return;
  const p5 = validHRs[Math.floor(validHRs.length * 0.05)];
  hrFloor = Math.round(p5 * 0.9);
}

async function loadRestingHR() {
  const config = await fetch("/api/config").then((r) => r.json()).catch(() => ({}));
  restingHrFromGarmin = config.restingHrBpm || null;
  computeHRFloor();
  render();
}
function tempColor(f) {
  if (f == null) return "#5A6270";
  const clamp = Math.max(30, Math.min(100, f));
  const pct = (clamp - 30) / 70;
  const cold = [76, 201, 240], hot = [255, 107, 53];
  const c = cold.map((c0, i) => Math.round(c0 + (hot[i] - c0) * pct));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
function minettiCost(i) {
  const i2 = i * i, i3 = i2 * i, i4 = i3 * i, i5 = i4 * i;
  return 155.4 * i5 - 30.4 * i4 - 43.3 * i3 + 46.3 * i2 + 19.5 * i + 3.6;
}
function gapSecPerMi(pace, elevFt, distMi) {
  if (!pace || elevFt == null || !distMi) return null;
  const grade = Math.max(-0.3, Math.min(0.3, (elevFt / 5280) / distMi));
  return pace / (minettiCost(grade) / minettiCost(0));
}
function daysUntil(d) { return Math.ceil((d - new Date()) / 86400000); }
function todayMidnight() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function startOfWeek(d) { // Monday-anchored
  const dow = (d.getDay() + 6) % 7;
  return addDays(d, -dow);
}
function fmtRangeLabel(start, end) {
  const opts = { month: "short", day: "numeric" };
  return `${start.toLocaleDateString(undefined, opts)} – ${end.toLocaleDateString(undefined, opts)}`;
}
function toDateInputValue(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function currentFilterRange() {
  if (filterMode === "week") {
    const start = startOfWeek(filterAnchor);
    return { start, end: addDays(start, 6) };
  }
  if (filterMode === "month") return { start: addDays(filterAnchor, -29), end: filterAnchor };
  if (filterMode === "sixMonths") return { start: addDays(filterAnchor, -181), end: filterAnchor };
  if (filterMode === "year") return { start: addDays(filterAnchor, -364), end: filterAnchor };
  if (filterMode === "ytd") return { start: new Date(filterAnchor.getFullYear(), 0, 1), end: filterAnchor };
  if (filterMode === "custom") {
    return { start: customStart, end: customEnd };
  }
  return { start: addDays(filterAnchor, -6), end: filterAnchor }; // rolling7
}
function filteredRuns() {
  let result = activityTypeFilter === "all"
    ? runs
    : runs.filter((r) => (r.activityType || "Run") === activityTypeFilter);
  if (filterMode === "all") return result;
  const { start, end } = currentFilterRange();
  return result.filter((r) => {
    const d = new Date(r.date + "T00:00:00");
    return d >= start && d <= end;
  });
}

// ---------- Data loading ----------
// ---------- Duplicate merging (same physical run synced from both Strava and Garmin) ----------
// The DB deliberately never dedupes at sync time (data ownership — every source's raw
// record is kept forever, untouched). This merges at the display layer only, once, right
// after load, so every downstream consumer (stat strip, Runs list, Insights, Map, activity
// filter) sees one run instead of two without needing its own dedup logic.
function canonicalActivityType(t) {
  const s = (t || "").toLowerCase();
  if (s.includes("run")) return "run";
  if (s.includes("walk")) return "walk";
  if (s.includes("ride") || s.includes("cycl") || s.includes("bik")) return "ride";
  if (s.includes("swim")) return "swim";
  if (s.includes("hik")) return "hike";
  if (s.includes("weight") || s.includes("strength")) return "strength";
  if (s.includes("yoga")) return "yoga";
  return s;
}

function isLikelyDuplicate(a, b) {
  if (a.source === b.source) return false;
  if (a.date !== b.date) return false;
  if (canonicalActivityType(a.activityType) !== canonicalActivityType(b.activityType)) return false;
  if (a.distanceMi == null || b.distanceMi == null) return false;
  if (Math.abs(a.distanceMi - b.distanceMi) > Math.max(0.1, a.distanceMi * 0.05)) return false;
  if (a.startTime && b.startTime) {
    const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
    if (Math.abs(toMin(a.startTime) - toMin(b.startTime)) > 10) return false;
  }
  return true;
}

function isEmptyValue(v) {
  return v == null || (Array.isArray(v) && v.length === 0);
}

function mergeRunPair(a, b) {
  // Strava is preferred where it has data (better route/routeMetrics for the Map
  // heatmaps); Garmin fills in anything Strava lacks — in practice this means Garmin's
  // running-dynamics fields, which Strava never populates, survive onto the merged card.
  const primary = a.source === "strava" ? a : (b.source === "strava" ? b : a);
  const secondary = primary === a ? b : a;
  const merged = { ...secondary };
  Object.entries(primary).forEach(([k, v]) => { if (!isEmptyValue(v)) merged[k] = v; });
  // Exception to the Strava-wins rule above: Garmin's activity names (e.g. "Manchester -
  // Base") are more descriptive than Strava's generic auto-names (e.g. "Morning Run").
  const garminSide = a.source === "garmin" ? a : (b.source === "garmin" ? b : null);
  if (garminSide && !isEmptyValue(garminSide.name)) merged.name = garminSide.name;
  merged.mergedSources = [a.source, b.source].sort();
  merged.mergedIds = [a.id, b.id];
  return merged;
}

function mergeDuplicateRuns(rawRuns) {
  const used = new Array(rawRuns.length).fill(false);
  const merged = [];
  for (let i = 0; i < rawRuns.length; i++) {
    if (used[i]) continue;
    let matchIdx = -1;
    for (let j = i + 1; j < rawRuns.length; j++) {
      if (used[j]) continue;
      if (isLikelyDuplicate(rawRuns[i], rawRuns[j])) { matchIdx = j; break; }
    }
    if (matchIdx >= 0) {
      used[matchIdx] = true;
      merged.push(mergeRunPair(rawRuns[i], rawRuns[matchIdx]));
    } else {
      merged.push(rawRuns[i]);
    }
  }
  return merged;
}

async function loadRuns() {
  const res = await fetch("/api/runs");
  const raw = await res.json();
  runs = mergeDuplicateRuns(raw);
  computeHRFloor();
  populateActivityTypeSelect();
  dispatchCurrentTab();
}

async function loadGoals() {
  goals = await fetch("/api/goals").then((r) => r.json()).catch(() => []);
}

async function checkStravaStatus() {
  const res = await fetch("/api/strava/status");
  const { connected } = await res.json();
  document.getElementById("connect-btn").textContent = connected ? "Strava Connected" : "Connect Strava";
  document.getElementById("connect-btn").disabled = connected;
}

document.getElementById("connect-btn").onclick = () => { window.location.href = "/auth/strava/login"; };

document.querySelectorAll(".tab").forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    currentTab = tab.dataset.tab;
    document.getElementById("nav-toggle").textContent = `☰ ${tab.textContent}`;
    document.getElementById("nav-menu").style.display = "none";
    dispatchCurrentTab();
  };
});

document.getElementById("nav-toggle").onclick = () => {
  const menu = document.getElementById("nav-menu");
  menu.style.display = menu.style.display === "flex" ? "none" : "flex";
};

// ---------- Filter bar ----------
function updateFilterBar() {
  const navEl = document.getElementById("filter-nav");
  const customEl = document.getElementById("filter-custom");
  const prevBtn = document.getElementById("filter-prev");
  const nextBtn = document.getElementById("filter-next");
  const navigable = filterMode === "rolling7" || filterMode === "week";

  navEl.style.display = (filterMode === "custom" || filterMode === "all") ? "none" : "flex";
  customEl.style.display = filterMode === "custom" ? "flex" : "none";
  prevBtn.style.visibility = navigable ? "visible" : "hidden";
  nextBtn.style.visibility = navigable ? "visible" : "hidden";

  if (filterMode === "custom") {
    document.getElementById("custom-start").value = toDateInputValue(customStart);
    document.getElementById("custom-end").value = toDateInputValue(customEnd);
    return;
  }
  if (filterMode === "all") return;

  const { start, end } = currentFilterRange();
  document.getElementById("filter-range").textContent = fmtRangeLabel(start, end);
  if (navigable) nextBtn.disabled = end >= todayMidnight();
}

document.querySelectorAll(".filter-mode").forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll(".filter-mode").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    filterMode = btn.dataset.mode;
    filterAnchor = todayMidnight();
    updateFilterBar();
    render();
  };
});

document.getElementById("filter-prev").onclick = () => {
  filterAnchor = addDays(filterAnchor, -7);
  updateFilterBar();
  render();
};

document.getElementById("filter-next").onclick = () => {
  const today = todayMidnight();
  filterAnchor = addDays(filterAnchor, 7);
  if (filterAnchor > today) filterAnchor = today;
  updateFilterBar();
  render();
};

function populateActivityTypeSelect() {
  const sel = document.getElementById("activity-type-select");
  const counts = {};
  runs.forEach((r) => {
    const t = r.activityType || "Run";
    counts[t] = (counts[t] || 0) + 1;
  });
  const prevValue = activityTypeFilter;
  sel.innerHTML = `<option value="all">All types · ${runs.length}</option>` +
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `<option value="${t}">${t} · ${n}</option>`)
      .join("");
  sel.value = counts[prevValue] ? prevValue : "all";
  activityTypeFilter = sel.value;
}

document.getElementById("activity-type-select").onchange = (e) => {
  activityTypeFilter = e.target.value;
  render();
};

document.getElementById("custom-start").onchange = (e) => {
  if (e.target.value) customStart = new Date(e.target.value + "T00:00:00");
  render();
};

document.getElementById("custom-end").onchange = (e) => {
  if (e.target.value) customEnd = new Date(e.target.value + "T00:00:00");
  render();
};

// ---------- Render ----------
function isRunActivity(r) {
  return (r.activityType || "Run") === "Run";
}

const ACTIVITY_VERBS = {
  Run: "Ran", TrailRun: "Ran", Ride: "Biked", VirtualRide: "Biked", MountainBikeRide: "Biked",
  Walk: "Walked", Hike: "Hiked", Swim: "Swam", Workout: "Worked out", WeightTraining: "Lifted",
  Yoga: "Did yoga", Elliptical: "Did elliptical",
};

function renderStatBreakdown() {
  const weekAgo = new Date(Date.now() - 7 * 86400000);
  const byType = {};
  runs.filter((r) => new Date(r.date) >= weekAgo).forEach((r) => {
    const t = r.activityType || "Run";
    byType[t] = (byType[t] || 0) + (r.distanceMi || 0);
  });

  const el = document.getElementById("stat-breakdown");
  const types = Object.keys(byType);
  // Only worth a separate line when something other than running happened this week —
  // otherwise it'd just repeat the "This week" stat card above.
  if (types.length <= 1) {
    el.textContent = "";
    return;
  }
  el.textContent = Object.entries(byType)
    .sort((a, b) => b[1] - a[1])
    .map(([t, mi]) => `${ACTIVITY_VERBS[t] || t} ${mi.toFixed(1)} mi`)
    .join(" · ");
}

// Home-tab-only now (moved out of the global header) — only meaningful to call once
// renderHomeTab() has put the stat-week/pace/count/breakdown elements in the DOM.
function updateHeaderStats() {
  // Other captured activity types (rides, walks, hikes, ...) show up in the plain Runs
  // list below, but shouldn't silently inflate running-specific stats/Insights charts.
  const runningRuns = runs.filter(isRunActivity);

  const weekAgo = new Date(Date.now() - 7 * 86400000);
  const weekMi = runningRuns.filter((r) => new Date(r.date) >= weekAgo).reduce((s, r) => s + (r.distanceMi || 0), 0);
  document.getElementById("stat-week").textContent = `${weekMi.toFixed(1)} mi`;

  const withPace = runningRuns.filter((r) => isPlausiblePace(r.avgPaceSecPerMi, r.distanceMi));
  const avgPace = withPace.length
    ? withPace.reduce((s, r) => s + r.avgPaceSecPerMi * r.distanceMi, 0) / withPace.reduce((s, r) => s + r.distanceMi, 0)
    : null;
  document.getElementById("stat-pace").textContent = avgPace ? `${paceStr(avgPace)}/mi` : "--";
  document.getElementById("stat-count").textContent = runningRuns.length;
  renderStatBreakdown();
}

// Global, ambient — kept visible on every tab (unlike the stat-strip, which moved into
// Home). Driven by the nearest active race-type Goal instead of a hardcoded date.
function renderRaceCountdown() {
  const today = todayMidnight();
  const nextRace = goals
    .filter((g) => g.goalType === "race" && g.status === "active" && g.targetDate)
    .filter((g) => new Date(g.targetDate + "T00:00:00") >= today)
    .sort((a, b) => a.targetDate.localeCompare(b.targetDate))[0];
  const el = document.getElementById("race-countdown");
  if (!nextRace) { el.textContent = ""; return; }
  const d = daysUntil(new Date(nextRace.targetDate + "T00:00:00"));
  el.textContent = d > 0 ? `${d} days to ${nextRace.name}` : "Race day!";
}

// Scope reduced to just the two tabs it's always owned — home/goals/map/chat/settings
// are all special-cased in dispatchCurrentTab() instead, same pattern map/settings/chat
// already used before this refactor.
function render() {
  document.getElementById("empty-state").style.display = runs.length === 0 ? "block" : "none";
  if (currentTab === "runs") renderRunsTab();
  else if (currentTab === "insights") renderInsightsTab();
}

// Single source of truth for "what to show given currentTab" — used by the tab click
// handler AND by loadRuns()'s completion (which used to just call render()
// unconditionally; now needs to route correctly no matter which tab is active,
// including the new Home default).
function dispatchCurrentTab() {
  document.getElementById("home-tab").style.display = currentTab === "home" ? "block" : "none";
  document.getElementById("goals-tab").style.display = currentTab === "goals" ? "block" : "none";
  document.getElementById("runs-tab").style.display = currentTab === "runs" ? "block" : "none";
  document.getElementById("insights-tab").style.display = currentTab === "insights" ? "block" : "none";
  document.getElementById("map-tab").style.display = currentTab === "map" ? "block" : "none";
  document.getElementById("chat-tab").style.display = currentTab === "chat" ? "block" : "none";
  document.getElementById("workouts-tab").style.display = currentTab === "workouts" ? "block" : "none";
  document.getElementById("settings-tab").style.display = currentTab === "settings" ? "block" : "none";
  document.getElementById("filter-bar").style.display =
    (currentTab === "runs" || currentTab === "insights") ? "flex" : "none";

  if (currentTab === "settings") {
    document.getElementById("empty-state").style.display = "none";
    renderSettingsTab();
  } else {
    stopBacklogPolling("strava");
    stopBacklogPolling("garmin");
    if (currentTab === "map") {
      document.getElementById("empty-state").style.display = "none";
      renderMapTab();
    } else if (currentTab === "chat") {
      document.getElementById("empty-state").style.display = "none";
      renderChatTab();
    } else if (currentTab === "home") {
      document.getElementById("empty-state").style.display = "none";
      renderHomeTab();
    } else if (currentTab === "goals") {
      document.getElementById("empty-state").style.display = "none";
      renderGoalsTab();
    } else if (currentTab === "workouts") {
      document.getElementById("empty-state").style.display = "none";
      renderWorkoutsTab();
    } else {
      render();
    }
  }
}

// Single navigation helper used by every clickable Home/dashboard/goal card — switches
// tab, optionally sets a date filter and/or expands+scrolls to a specific run, keeping
// the nav-menu toggle label and active states consistent with a real tab click.
function navigateTo({ tab, filterMode: fm, runId } = {}) {
  if (runId) {
    tab = "runs";
    fm = fm || "all";
    expandedId = runId;
  }
  if (fm) {
    filterMode = fm;
    filterAnchor = todayMidnight();
    document.querySelectorAll(".filter-mode").forEach((b) => b.classList.toggle("active", b.dataset.mode === fm));
    updateFilterBar();
  }
  currentTab = tab;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  const tabBtn = document.querySelector(`.tab[data-tab="${tab}"]`);
  document.getElementById("nav-toggle").textContent = `☰ ${tabBtn ? tabBtn.textContent : tab}`;
  document.getElementById("nav-menu").style.display = "none";
  dispatchCurrentTab();
  if (runId) {
    requestAnimationFrame(() => {
      const el = document.getElementById(`run-card-${runId}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
}

// Delegated click wiring for any container holding [data-nav-run]/[data-nav-tab]
// elements (dashboard cards, goal cards) — called after inserting their HTML.
function wireNavCards(container) {
  container.querySelectorAll("[data-nav-run]").forEach((el) => {
    el.onclick = () => navigateTo({ runId: el.dataset.navRun });
  });
  container.querySelectorAll("[data-nav-tab]").forEach((el) => {
    el.onclick = () => navigateTo({ tab: el.dataset.navTab, filterMode: el.dataset.navFilter });
  });
}

function renderRunsTab() {
  const el = document.getElementById("runs-tab");
  el.innerHTML = "";
  const data = filteredRuns();
  if (data.length === 0 && runs.length > 0) {
    el.innerHTML = `<div class="empty-chart">No runs in this range.</div>`;
    return;
  }
  data.forEach((run) => {
    const card = document.createElement("div");
    card.className = "run-card";
    card.id = `run-card-${run.id}`;
    card.style.borderLeft = `4px solid ${tempColor(run.tempF)}`;
    const type = run.type || "Easy";
    const typeColor = TYPE_COLORS[type] || "#8B93A1";
    const isOpen = expandedId === run.id;

    card.innerHTML = `
      <div class="run-card-head">
        <div class="run-row">
          <div>
            <div class="run-name">
              ${run.name}
              <span class="badge" style="color:${typeColor};border:1px solid ${typeColor}55;background:${typeColor}18">${type}</span>
              ${run.isTreadmill ? `<span class="badge" style="color:#8B93A1;border:1px solid #242B35;background:#1A2029">Treadmill</span>` : ""}
              ${run.mergedSources ? `<span class="badge" style="color:#B98CE0;border:1px solid #B98CE055;background:#B98CE018" title="Same run synced from both ${run.mergedSources.join(" and ")} — merged into one card">🔗 ${run.mergedSources.map((s) => s[0].toUpperCase() + s.slice(1)).join(" + ")}</span>` : ""}
            </div>
            <div class="run-date">${new Date(run.date + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}${run.startTime ? " · " + run.startTime : ""}</div>
          </div>
          <div>
            <div class="run-dist">${run.distanceMi?.toFixed(2)} mi</div>
            <div class="run-pace">${isPlausiblePace(run.avgPaceSecPerMi, run.distanceMi) ? paceStr(run.avgPaceSecPerMi) : "--:--"}/mi</div>
          </div>
        </div>
        <div class="mini-stats">
          <div class="mini-stat">⏱ ${timeStr(run.movingTimeSec)}</div>
          ${isPlausibleHR(run.avgHR) ? `<div class="mini-stat">♥ ${run.avgHR}${isPlausibleHR(run.maxHR) ? " / " + run.maxHR : ""} bpm</div>` : ""}
          ${run.avgCadence != null ? `<div class="mini-stat">👣 ${Math.round(run.avgCadence)} spm</div>` : ""}
          ${run.elevGainFt != null ? `<div class="mini-stat">⛰ ${Math.round(run.elevGainFt)} ft</div>` : ""}
          ${run.elevGainFt != null && run.distanceMi && isPlausiblePace(run.avgPaceSecPerMi, run.distanceMi) ? `<div class="mini-stat" style="color:rgb(76,201,240)">⚡ GAP ${paceStr(gapSecPerMi(run.avgPaceSecPerMi, run.elevGainFt, run.distanceMi))}</div>` : ""}
          ${run.rpe != null ? `<div class="mini-stat">📊 RPE ${run.rpe}</div>` : ""}
        </div>
        ${run.tempF != null || run.heatIndexF != null || run.wetBulbF != null ? `
        <div class="mini-stats weather-stats">
          ${run.tempF != null ? `<div class="mini-stat" style="color:${tempColor(run.tempF)}">${run.tempF >= 75 ? "🔥" : "❄️"} ${Math.round(run.tempF)}°F${run.weatherCondition ? " · " + run.weatherCondition : ""}</div>` : ""}
          ${run.heatIndexF != null && Math.round(run.heatIndexF) !== Math.round(run.tempF) ? `<div class="mini-stat" style="color:${tempColor(run.heatIndexF)}">🥵 HI ${Math.round(run.heatIndexF)}°F</div>` : ""}
          ${run.wetBulbF != null ? `<div class="mini-stat">💧 WB ${Math.round(run.wetBulbF)}°F</div>` : ""}
        </div>` : ""}
        ${run.verticalOscillationMm != null || run.groundContactTimeMs != null || run.verticalRatioPct != null || run.strideLengthM != null || run.avgPowerWatts != null ? `
        <div class="mini-stats">
          ${run.groundContactTimeMs != null ? `<div class="mini-stat">👟 GCT ${Math.round(run.groundContactTimeMs)}ms</div>` : ""}
          ${run.verticalOscillationMm != null ? `<div class="mini-stat">🦘 VO ${(run.verticalOscillationMm / 10).toFixed(1)}cm</div>` : ""}
          ${run.verticalRatioPct != null ? `<div class="mini-stat">📐 VR ${run.verticalRatioPct.toFixed(1)}%</div>` : ""}
          ${run.strideLengthM != null ? `<div class="mini-stat">📏 Stride ${(run.strideLengthM * 3.28084).toFixed(1)}ft</div>` : ""}
          ${run.avgPowerWatts != null ? `<div class="mini-stat">🔋 ${Math.round(run.avgPowerWatts)}W</div>` : ""}
        </div>` : ""}
        <div class="card-footer">
          <button class="edit-link" data-edit="${run.id}">✎ edit</button>
          <span>${isOpen ? "▲" : "▼"}</span>
        </div>
      </div>
      <div class="expand-slot"></div>
    `;

    card.querySelector(".run-card-head").addEventListener("click", (e) => {
      if (e.target.closest("[data-edit]")) return;
      if (isOpen && expandedMiniMap) { expandedMiniMap.remove(); expandedMiniMap = null; }
      expandedId = isOpen ? null : run.id;
      render();
    });
    card.querySelector("[data-edit]").addEventListener("click", (e) => {
      e.stopPropagation();
      openEditModal(run);
    });

    let miniMapEl = null, miniMapRoute = null;
    if (isOpen) {
      const slot = card.querySelector(".expand-slot");
      if (type === "Interval" && run.intervals?.length > 0) {
        slot.appendChild(buildIntervalsTable(run.intervals, run.recovery));
      } else if (run.splits?.length > 0) {
        slot.appendChild(buildSplitsTable(run.splits));
      }
      const route = (run.route && run.route.length > 1) ? run.route : (run.routeMetrics || []).map((p) => [p.lat, p.lon]);
      miniMapEl = document.createElement("div");
      miniMapEl.className = "run-mini-map";
      slot.appendChild(miniMapEl);
      miniMapRoute = route.length > 1 ? route : null;
    }

    el.appendChild(card);

    // Leaflet needs the container actually attached to the document (with a real
    // rendered size) before init, so this runs after el.appendChild(card) above.
    if (miniMapEl) initRunMiniMap(miniMapEl, miniMapRoute);
  });
}

let expandedMiniMap = null;

function showMiniMapMessage(container, text, color) {
  container.textContent = text;
  container.style.display = "flex";
  container.style.alignItems = "center";
  container.style.justifyContent = "center";
  container.style.color = color || "var(--faint)";
  container.style.fontSize = "12px";
  container.style.padding = "8px";
  container.style.textAlign = "center";
}

function initRunMiniMap(container, route) {
  if (expandedMiniMap) { expandedMiniMap.remove(); expandedMiniMap = null; }
  if (!route) {
    showMiniMapMessage(container, "No GPS route data for this run.");
    return;
  }
  // Wrapped defensively and made visible on failure (instead of silently showing
  // nothing) specifically because this couldn't be verified in a real browser before
  // shipping — the sandbox this was built in can't reach the NAS's LAN address.
  try {
    if (typeof L === "undefined") throw new Error("Leaflet failed to load");
    const map = L.map(container, { preferCanvas: true, zoomControl: false }).setView([40, -97], 4);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      maxZoom: 19,
    }).addTo(map);
    const layer = L.featureGroup().addTo(map);
    splitRouteAtGaps(route).forEach((segment) => {
      L.polyline(segment, { color: "#FFC857", weight: 3, opacity: 0.85 }).addTo(layer);
    });
    requestAnimationFrame(() => {
      map.invalidateSize();
      const bounds = layer.getBounds();
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [16, 16] });
    });
    expandedMiniMap = map;
  } catch (e) {
    console.error("Run mini-map failed to initialize:", e);
    showMiniMapMessage(container, `Map error: ${e.message}`, "var(--hot)");
  }
}

function buildSplitsTable(splits) {
  const wrap = document.createElement("div");
  wrap.className = "splits-table";
  const maxPace = Math.max(...splits.map((s) => s.paceSecPerMi || 0));
  const minPace = Math.min(...splits.map((s) => s.paceSecPerMi || Infinity));
  let html = `<div class="split-head"><span>Mi</span><span>Pace</span><span>Elev</span><span>HR</span><span>Max</span><span>Cad</span><span>GAP</span></div>`;
  splits.forEach((s) => {
    const w = maxPace > minPace ? (s.paceSecPerMi - minPace) / (maxPace - minPace) : 0.5;
    const gap = gapSecPerMi(s.paceSecPerMi, s.elevGainFt, 1);
    html += `<div class="split-row">
      <span style="color:var(--muted)">${s.mile}</span>
      <div class="pace-bar"><div class="pace-bar-fill" style="width:${20 + (1 - w) * 80}%"></div><span>${paceStr(s.paceSecPerMi)}</span></div>
      <span>${s.elevGainFt != null ? Math.round(s.elevGainFt) + "ft" : "--"}</span>
      <span>${isPlausibleHR(s.avgHR) ? s.avgHR : "--"}</span>
      <span style="color:var(--muted)">${isPlausibleHR(s.maxHR) ? s.maxHR : "--"}</span>
      <span style="color:var(--muted)">${s.avgCadence != null ? Math.round(s.avgCadence) : "--"}</span>
      <span style="color:rgb(76,201,240)">${gap ? paceStr(gap) : "--"}</span>
    </div>`;
  });
  wrap.innerHTML = html;
  return wrap;
}

function buildIntervalsTable(intervals, recovery) {
  const wrap = document.createElement("div");
  wrap.className = "intervals-table";
  const workReps = intervals.filter((iv) => iv.segment === "work");
  const hasRecovery = recovery && recovery.length > 0;
  const recoveryByRep = {};
  (recovery || []).forEach((r) => { recoveryByRep[r.repIndex] = r; });

  let html = "";
  if (workReps.length) {
    const avgDur = Math.round(workReps.reduce((s, r) => s + (r.durationSec || 0), 0) / workReps.length);
    html += `<div style="font-size:11px;color:var(--faint);margin-bottom:8px">${workReps.length} work reps · avg ${avgDur}s each</div>`;
  }
  html += `<div class="interval-head${hasRecovery ? " has-recovery" : ""}"><span>Segment</span><span>Pace</span><span>Time</span><span>HR</span><span>Max</span><span>Cad</span>${hasRecovery ? "<span>Recovery</span>" : ""}</div>`;
  let workIdx = 0;
  intervals.forEach((iv) => {
    const style = SEGMENT_STYLE[iv.segment] || { label: iv.segment, color: "#8B93A1" };
    if (iv.segment === "work") workIdx++;
    // Recovery time describes how long it took HR to drop 20bpm from this work rep's
    // peak during the *following* recovery rep — shown on the work row it belongs to.
    const rec = iv.segment === "work" ? recoveryByRep[workIdx] : null;
    const recoveryCell = rec
      ? (rec.recoverySec != null ? `<span style="color:rgb(76,201,240)">${Math.round(rec.recoverySec)}s</span>` : `<span style="color:var(--faint)" title="Didn't drop 20bpm before the next rep started">—</span>`)
      : "<span></span>";
    html += `<div class="interval-row${hasRecovery ? " has-recovery" : ""}" style="border-left:2px solid ${style.color};background:${iv.segment === "work" ? style.color + "0F" : "transparent"}">
      <span style="color:${style.color};font-weight:${iv.segment === "work" ? 700 : 400}">${style.label}${iv.segment === "work" ? " " + workIdx : ""}</span>
      <span>${paceStr(iv.paceSecPerMi)}/mi</span>
      <span style="color:var(--muted)">${iv.durationSec ?? "--"}s</span>
      <span>${isPlausibleHR(iv.avgHR) ? iv.avgHR : "--"}</span>
      <span style="color:var(--muted)">${isPlausibleHR(iv.maxHR) ? iv.maxHR : "--"}</span>
      <span style="color:var(--muted)">${iv.avgCadence != null ? Math.round(iv.avgCadence) : "--"}</span>
      ${hasRecovery ? recoveryCell : ""}
    </div>`;
  });
  wrap.innerHTML = html;
  return wrap;
}

// ---------- Edit modal ----------
function openEditModal(run) {
  const root = document.getElementById("modal-root");
  const optionsHtml = RUN_TYPES.map((t) => `<option value="${t}" ${t === (run.type || "Easy") ? "selected" : ""}>${t}</option>`).join("");
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <div class="modal-head"><div style="font-weight:700">${run.name}</div><button class="modal-close" id="modal-close">✕</button></div>
        <div class="field"><div class="field-label">Run type</div><select id="f-type">${optionsHtml}</select></div>
        <div class="field"><div class="field-label">Temperature (°F)</div><input id="f-temp" type="number" value="${run.tempF ?? ""}" placeholder="e.g. 72" /></div>
        <div class="field"><div class="field-label">Weather condition</div><input id="f-cond" type="text" value="${run.weatherCondition ?? ""}" placeholder="e.g. Clear, humid" /></div>
        <div class="field"><div class="field-label">Perceived effort (RPE, 1-10)</div><input id="f-rpe" type="number" min="1" max="10" value="${run.rpe ?? ""}" /></div>
        <div class="field"><label class="checkbox-row"><input type="checkbox" id="f-treadmill" ${run.isTreadmill ? "checked" : ""}/> Treadmill run (not outdoors)</label></div>
        <div class="field"><div class="field-label">Notes</div><textarea id="f-notes">${run.notes ?? ""}</textarea></div>
        <button class="modal-save" id="modal-save">Save</button>
      </div>
    </div>`;
  document.getElementById("modal-close").onclick = () => (root.innerHTML = "");
  document.getElementById("modal-backdrop").onclick = (e) => { if (e.target.id === "modal-backdrop") root.innerHTML = ""; };
  document.getElementById("modal-save").onclick = async () => {
    const isTreadmill = document.getElementById("f-treadmill").checked;
    const tempVal = document.getElementById("f-temp").value;
    const body = {
      type: document.getElementById("f-type").value,
      tempF: isTreadmill ? null : (tempVal === "" ? null : Number(tempVal)),
      weatherCondition: isTreadmill ? null : document.getElementById("f-cond").value,
      rpe: document.getElementById("f-rpe").value === "" ? null : Number(document.getElementById("f-rpe").value),
      isTreadmill,
      notes: document.getElementById("f-notes").value,
    };
    await fetch(`/api/runs/${run.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    root.innerHTML = "";
    await loadRuns();
  };
}

// ---------- Insights ----------
function destroyCharts() { charts.forEach((c) => c.destroy()); charts = []; }

function chartCardHTML(title, sub, canvasId, height = 200) {
  return `<div class="chart-card"><div class="chart-title">${title}</div>${sub ? `<div class="chart-sub">${sub}</div>` : ""}
    <div class="chart-body"><canvas id="${canvasId}" height="${height}"></canvas></div></div>`;
}

async function renderInsightsTab() {
  destroyCharts();
  const el = document.getElementById("insights-tab");
  // Insights is entirely running-specific (pace/cadence/HR trends, training load) — other
  // captured activity types (rides, hikes, ...) shouldn't skew these.
  const data = filteredRuns().filter(isRunActivity);

  if (data.length === 0 && runs.length > 0) {
    el.innerHTML = `<div class="empty-chart">No runs in this range.</div>`;
    return;
  }

  // Garmin-only wellness data (unverified as of this writing — see STATUS.md); degrades
  // to an empty-state card rather than breaking the rest of Insights if it 404s or errors.
  const stepsData = await fetch("/api/steps?days=30").then((r) => r.json()).catch(() => []);
  const wellnessData = await fetch("/api/wellness?days=90").then((r) => r.json()).catch(() => []);
  const rhrData = wellnessData.filter((d) => d.restingHrBpm != null);
  const vo2Data = wellnessData.filter((d) => d.vo2max != null);
  const sleepData = wellnessData.filter((d) => d.sleepScore != null || d.sleepSeconds != null);
  const sleepStages = await fetch("/api/wellness/sleep-stages").then((r) => r.json()).catch(() => ({ availableDates: [], date: null, segments: [] }));

  const outdoor = data.filter((r) => !r.isTreadmill && r.tempF != null);
  const perfData = [...data].sort((a, b) => (a.date < b.date ? -1 : 1)).filter((r) => isPlausiblePace(r.avgPaceSecPerMi, r.distanceMi));
  const cadPaceData = data.filter((r) => r.avgCadence && isPlausiblePace(r.avgPaceSecPerMi, r.distanceMi));

  // Rolling window looks back across ALL running history, not just the currently filtered
  // range — otherwise the first few points of a filtered view (e.g. "Custom: last 30 days")
  // would be computed from an artificially thin window with no prior lookback.
  const allRunHistory = runs.filter(isRunActivity);
  const ROLLING_WINDOW_DAYS = 7;
  const rollingPaceData = perfData.map((r) => {
    const end = new Date(r.date + "T00:00:00");
    const start = new Date(end); start.setDate(start.getDate() - (ROLLING_WINDOW_DAYS - 1));
    const windowRuns = allRunHistory.filter((rr) => {
      const d = new Date(rr.date + "T00:00:00");
      return d >= start && d <= end && isPlausiblePace(rr.avgPaceSecPerMi, rr.distanceMi);
    });
    const totalDist = windowRuns.reduce((s, rr) => s + (rr.distanceMi || 0), 0);
    const pace = totalDist ? windowRuns.reduce((s, rr) => s + rr.avgPaceSecPerMi * rr.distanceMi, 0) / totalDist : null;
    return { date: r.date, pace };
  }).filter((p) => p.pace != null);

  const weekly = {};
  data.forEach((r) => {
    const d = new Date(r.date);
    const monday = new Date(d); monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const key = monday.toISOString().slice(0, 10);
    weekly[key] = (weekly[key] || 0) + (r.distanceMi || 0);
  });
  const weeklyEntries = Object.entries(weekly).sort(([a], [b]) => (a < b ? -1 : 1));

  el.innerHTML = `
    <div class="chart-card">
      <div class="chart-title">Temperature's Effect</div>
      <div class="chart-sub">Pace, cadence, and HR vs. outdoor temp</div>
      ${outdoor.length < 2 ? `<div class="empty-chart">Log a few more outdoor runs across different temps.</div>` : `
        <div class="chart-body"><canvas id="c-temp-hr" height="120"></canvas></div>
        <div class="chart-body"><canvas id="c-temp-pace" height="120"></canvas></div>
        <div class="chart-body"><canvas id="c-temp-cad" height="120"></canvas></div>
      `}
    </div>
    ${chartCardHTML("Weekly Mileage", "", "c-mileage", 160)}
    <div class="chart-card">
      <div class="chart-title">Pace, Cadence &amp; HR Trend</div>
      <div class="chart-sub">How your speed, turnover, and cardiac cost move together over time</div>
      ${perfData.length < 2 ? `<div class="empty-chart">Need a couple more runs.</div>` : `<div class="chart-body"><canvas id="c-perf" height="200"></canvas></div>
      <div class="legend-row">
        <div class="legend-dot"><span class="dot" style="background:#FFC857"></span>Pace (left axis)</div>
        <div class="legend-dot"><span class="dot" style="background:rgb(76,201,240)"></span>Cadence</div>
        <div class="legend-dot"><span class="dot" style="background:rgb(255,107,53)"></span>Avg HR</div>
      </div>`}
    </div>
    <div class="chart-card">
      <div class="chart-title">Average Pace (${ROLLING_WINDOW_DAYS}-Day Rolling)</div>
      <div class="chart-sub">Distance-weighted average pace over the trailing week, smoothing out day-to-day noise</div>
      ${rollingPaceData.length < 2 ? `<div class="empty-chart">Need a couple more runs.</div>` : `<div class="chart-body"><canvas id="c-rolling-pace" height="160"></canvas></div>`}
    </div>
    ${chartCardHTML("Cadence vs. Pace", "Are you turning your legs over faster as pace increases, or overstriding?", "c-cadpace", 200)}
    <div class="chart-card">
      <div class="chart-title">Daily Steps</div>
      <div class="chart-sub">Garmin wellness data, last 30 days</div>
      ${stepsData.length < 2 ? `<div class="empty-chart">No step data synced yet (Garmin-only).</div>` : `<div class="chart-body"><canvas id="c-steps" height="140"></canvas></div>`}
    </div>
    <div class="chart-card">
      <div class="chart-title">Resting Heart Rate</div>
      <div class="chart-sub">Garmin wellness data, last 90 days</div>
      ${rhrData.length < 2 ? `<div class="empty-chart">No resting HR data synced yet (Garmin-only).</div>` : `<div class="chart-body"><canvas id="c-rhr" height="140"></canvas></div>`}
    </div>
    <div class="chart-card">
      <div class="chart-title">VO2 Max</div>
      <div class="chart-sub">Garmin wellness data, last 90 days — updates periodically, not every day</div>
      ${vo2Data.length < 2 ? `<div class="empty-chart">No VO2 max data synced yet (Garmin-only).</div>` : `<div class="chart-body"><canvas id="c-vo2max" height="140"></canvas></div>`}
    </div>
    <div class="chart-card">
      <div class="chart-title">Sleep</div>
      <div class="chart-sub">Sleep score and total duration, last 90 days</div>
      ${sleepData.length < 2 ? `<div class="empty-chart">No sleep data synced yet (Garmin-only).</div>` : `<div class="chart-body"><canvas id="c-sleep" height="160"></canvas></div>`}
    </div>
    <div class="chart-card">
      <div class="chart-title-row" style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <div class="chart-title">Sleep Stages</div>
          <div class="chart-sub">What stage you were in, minute by minute, for one night</div>
        </div>
        ${sleepStages.availableDates.length ? `<select id="sleep-stage-night-select"></select>` : ""}
      </div>
      ${!sleepStages.availableDates.length ? `<div class="empty-chart">No sleep stage data synced yet (Garmin-only).</div>` : `
        <div class="chart-body"><canvas id="c-sleep-hypnogram" height="140"></canvas></div>
      `}
    </div>
  `;

  Chart.defaults.color = "#8B93A1";
  Chart.defaults.borderColor = "#242B35";

  if (outdoor.length >= 2) {
    tempScatter("c-temp-hr", outdoor.map((r) => ({ x: r.tempF, y: r.avgHR })).filter((p) => isPlausibleHR(p.y)), "Avg HR", "rgb(255,107,53)", "bpm");
    tempScatter("c-temp-pace", outdoor.map((r) => ({ x: r.tempF, y: r.avgPaceSecPerMi, distanceMi: r.distanceMi })).filter((p) => isPlausiblePace(p.y, p.distanceMi)), "Pace", "#FFC857", "", (v) => paceStr(v) + "/mi", true);
    tempScatter("c-temp-cad", outdoor.map((r) => ({ x: r.tempF, y: r.avgCadence })).filter((p) => p.y != null), "Cadence", "rgb(76,201,240)", "spm");
  }

  if (weeklyEntries.length) {
    charts.push(new Chart(document.getElementById("c-mileage"), {
      type: "bar",
      data: { labels: weeklyEntries.map(([w]) => w.slice(5)), datasets: [{ data: weeklyEntries.map(([, mi]) => +mi.toFixed(1)), backgroundColor: "rgb(76,201,240)", borderRadius: 4 }] },
      options: { plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { grid: { color: "#242B35" } } } },
    }));
  }

  if (perfData.length >= 2) {
    charts.push(new Chart(document.getElementById("c-perf"), {
      type: "line",
      data: {
        labels: perfData.map((r) => r.date.slice(5)),
        datasets: [
          { label: "Pace", data: perfData.map((r) => r.avgPaceSecPerMi / 60), borderColor: "#FFC857", backgroundColor: "#FFC857", yAxisID: "pace", tension: 0.3 },
          { label: "Cadence", data: perfData.map((r) => r.avgCadence || null), borderColor: "rgb(76,201,240)", backgroundColor: "rgb(76,201,240)", yAxisID: "bpm", tension: 0.3, spanGaps: true },
          { label: "Avg HR", data: perfData.map((r) => isPlausibleHR(r.avgHR) ? r.avgHR : null), borderColor: "rgb(255,107,53)", backgroundColor: "rgb(255,107,53)", yAxisID: "bpm", tension: 0.3, spanGaps: true },
        ],
      },
      options: {
        plugins: { legend: { display: false } },
        scales: {
          pace: { type: "linear", position: "left", reverse: true, ticks: { callback: (v) => paceStr(v * 60) }, grid: { color: "#242B35" } },
          bpm: { type: "linear", position: "right", grid: { display: false } },
          x: { grid: { display: false } },
        },
      },
    }));
  }

  if (rollingPaceData.length >= 2) {
    charts.push(new Chart(document.getElementById("c-rolling-pace"), {
      type: "line",
      data: {
        labels: rollingPaceData.map((p) => p.date.slice(5)),
        datasets: [{ label: "Rolling avg pace", data: rollingPaceData.map((p) => p.pace / 60), borderColor: "#FFC857", backgroundColor: "#FFC857", tension: 0.3, pointRadius: 2 }],
      },
      options: {
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => paceStr(ctx.parsed.y * 60) + "/mi" } } },
        scales: {
          y: { reverse: true, ticks: { callback: (v) => paceStr(v * 60) }, grid: { color: "#242B35" } },
          x: { grid: { display: false } },
        },
      },
    }));
  }

  if (cadPaceData.length >= 2) {
    charts.push(new Chart(document.getElementById("c-cadpace"), {
      type: "scatter",
      data: { datasets: [{ data: cadPaceData.map((r) => ({ x: r.avgPaceSecPerMi / 60, y: r.avgCadence })), backgroundColor: "rgb(76,201,240)" }] },
      options: {
        plugins: { legend: { display: false } },
        scales: {
          x: { reverse: true, ticks: { callback: (v) => paceStr(v * 60) }, title: { display: true, text: "Pace" }, grid: { color: "#242B35" } },
          y: { title: { display: true, text: "Cadence (spm)" }, grid: { color: "#242B35" } },
        },
      },
    }));
  }

  if (stepsData.length >= 2) {
    charts.push(new Chart(document.getElementById("c-steps"), {
      type: "bar",
      data: { labels: stepsData.map((d) => d.date.slice(5)), datasets: [{ data: stepsData.map((d) => d.steps), backgroundColor: "#5FD68A", borderRadius: 4 }] },
      options: { plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { grid: { color: "#242B35" } } } },
    }));
  }

  if (rhrData.length >= 2) {
    charts.push(new Chart(document.getElementById("c-rhr"), {
      type: "line",
      data: { labels: rhrData.map((d) => d.date.slice(5)), datasets: [{ data: rhrData.map((d) => d.restingHrBpm), borderColor: "rgb(255,107,53)", backgroundColor: "rgb(255,107,53)", tension: 0.3 }] },
      options: {
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `${ctx.parsed.y} bpm` } } },
        scales: { x: { grid: { display: false } }, y: { ticks: { callback: (v) => v + " bpm" }, grid: { color: "#242B35" } } },
      },
    }));
  }

  if (vo2Data.length >= 2) {
    charts.push(new Chart(document.getElementById("c-vo2max"), {
      type: "line",
      data: { labels: vo2Data.map((d) => d.date.slice(5)), datasets: [{ data: vo2Data.map((d) => d.vo2max), borderColor: "#FFC857", backgroundColor: "#FFC857", tension: 0.3, stepped: true }] },
      options: {
        plugins: { legend: { display: false } },
        scales: { x: { grid: { display: false } }, y: { grid: { color: "#242B35" } } },
      },
    }));
  }

  if (sleepData.length >= 2) {
    charts.push(new Chart(document.getElementById("c-sleep"), {
      type: "line",
      data: {
        labels: sleepData.map((d) => d.date.slice(5)),
        datasets: [
          { label: "Sleep score", data: sleepData.map((d) => d.sleepScore), borderColor: "#5FD68A", backgroundColor: "#5FD68A", yAxisID: "score", tension: 0.3, spanGaps: true },
          { label: "Duration (hrs)", data: sleepData.map((d) => d.sleepSeconds ? +(d.sleepSeconds / 3600).toFixed(1) : null), borderColor: "rgb(76,201,240)", backgroundColor: "rgb(76,201,240)", yAxisID: "hrs", tension: 0.3, spanGaps: true },
        ],
      },
      options: {
        plugins: { legend: { display: true, labels: { boxWidth: 10 } } },
        scales: {
          score: { type: "linear", position: "left", min: 0, max: 100, grid: { color: "#242B35" } },
          hrs: { type: "linear", position: "right", min: 0, grid: { display: false } },
          x: { grid: { display: false } },
        },
      },
    }));
  }

  if (sleepStages.availableDates.length) {
    wireSleepStageSelector(sleepStages);
    drawSleepHypnogram(sleepStages.segments);
  }
}

const SLEEP_STAGE_ROWS = ["Awake", "REM", "Light", "Deep"];
const SLEEP_STAGE_KEY_TO_ROW = { awake: "Awake", rem: "REM", light: "Light", deep: "Deep" };
const SLEEP_STAGE_COLORS = { Awake: "rgb(255,107,53)", REM: "#5FD68A", Light: "rgb(76,201,240)", Deep: "#2C3E91" };
const SLEEP_CHART_TIMEZONE = "America/New_York"; // default EST/EDT display for the sleep-stage timeline

// Garmin's sleepLevels timestamps ("startGMT"/"endGMT" server-side) are genuinely UTC —
// confirmed by the field name and by matching them against dailySleepDTO's known
// deep/light/rem/awakeSleepSeconds totals — but the JSON string itself carries no "Z" or
// offset (e.g. "2026-07-13T03:26:54.0"). Per the ECMAScript spec, `new Date()` on a
// date-time string with no timezone designator parses it as *local* browser time, not
// UTC — silently shifting the whole night by the browser's UTC offset (a real bug this
// session hit: 11 PM bedtime rendering as ~4 AM). Appending "Z" forces correct UTC parsing.
function parseUtcTimestamp(s) {
  return new Date(/[Zz]|[+-]\d\d:?\d\d$/.test(s) ? s : s + "Z").getTime();
}

function fmtEstClock(epochMs, opts = {}) {
  return new Date(epochMs).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: SLEEP_CHART_TIMEZONE, ...opts });
}

function estMinute(epochMs) {
  return new Intl.DateTimeFormat("en-US", { minute: "numeric", timeZone: SLEEP_CHART_TIMEZONE }).format(new Date(epochMs));
}

// Chart.js's linear scale auto-picks "nice" numeric steps, which for raw epoch-ms
// values won't land on real hour boundaries — so ticks are generated explicitly here,
// one per EST hour boundary within the visible range, instead of relying on that.
function estHourTicks(minMs, maxMs) {
  const ticks = [];
  let t = Math.floor(minMs / 60000) * 60000;
  while (t <= maxMs) {
    if (estMinute(t) === "0") ticks.push(t);
    t += 60000;
  }
  return ticks;
}

function drawSleepHypnogram(segments) {
  const canvas = document.getElementById("c-sleep-hypnogram");
  if (sleepHypnogramChart) {
    sleepHypnogramChart.destroy();
    sleepHypnogramChart = null;
  }
  if (!canvas || !segments || !segments.length) return;

  const data = segments.map((s) => ({
    y: SLEEP_STAGE_KEY_TO_ROW[s.stage] || s.stage,
    x: [parseUtcTimestamp(s.start), parseUtcTimestamp(s.end)],
  }));
  const minMs = Math.min(...data.map((d) => d.x[0]));
  const maxMs = Math.max(...data.map((d) => d.x[1]));

  sleepHypnogramChart = new Chart(canvas, {
    type: "bar",
    data: {
      datasets: [{ data, backgroundColor: data.map((d) => SLEEP_STAGE_COLORS[d.y] || "#8B93A1"), barPercentage: 1, categoryPercentage: 0.9 }],
    },
    options: {
      indexAxis: "y",
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => items[0].raw.y,
            label: (ctx) => `${fmtEstClock(ctx.raw.x[0])} – ${fmtEstClock(ctx.raw.x[1])} (${Math.round((ctx.raw.x[1] - ctx.raw.x[0]) / 60000)} min)`,
          },
        },
      },
      scales: {
        x: {
          type: "linear",
          min: minMs,
          max: maxMs,
          afterBuildTicks: (scale) => {
            scale.ticks = estHourTicks(scale.min, scale.max).map((v) => ({ value: v }));
          },
          ticks: { callback: (value) => fmtEstClock(value) },
          title: { display: true, text: "Time (EST)" },
          grid: { color: "#242B35" },
        },
        y: { type: "category", labels: SLEEP_STAGE_ROWS, grid: { display: false } },
      },
    },
  });
}

async function loadSleepStagesFor(date) {
  const data = await fetch(`/api/wellness/sleep-stages?date=${date}`).then((r) => r.json()).catch(() => null);
  if (data) drawSleepHypnogram(data.segments);
}

function wireSleepStageSelector(sleepStages) {
  const select = document.getElementById("sleep-stage-night-select");
  if (!select) return;
  const dates = [...sleepStages.availableDates].reverse(); // newest first
  select.innerHTML = dates.map((d) => `<option value="${d}"${d === sleepStages.date ? " selected" : ""}>${d}</option>`).join("");
  select.onchange = () => loadSleepStagesFor(select.value);
}

function tempScatter(canvasId, data, label, color, unit, tickFmt, reverse = false) {
  charts.push(new Chart(document.getElementById(canvasId), {
    type: "scatter",
    data: { datasets: [{ label, data, backgroundColor: color }] },
    options: {
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `${tickFmt ? tickFmt(ctx.parsed.y) : ctx.parsed.y + unit} at ${ctx.parsed.x}°F` } } },
      scales: {
        x: { title: { display: true, text: "Temp (°F)", font: { size: 10 } }, grid: { color: "#242B35" } },
        y: { reverse, ticks: tickFmt ? { callback: tickFmt } : undefined, title: { display: true, text: label, font: { size: 10 } }, grid: { color: "#242B35" } },
      },
    },
  }));
}

// ---------- Settings ----------
const backlogPollTimers = { strava: null, garmin: null };

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function stopBacklogPolling(source) {
  if (backlogPollTimers[source]) {
    clearTimeout(backlogPollTimers[source]);
    backlogPollTimers[source] = null;
  }
}

function renderBacklogPanel(source, job) {
  const panel = document.getElementById(`backlog-panel-${source}`);
  const btn = document.getElementById(`settings-${source}-backlog-btn`);
  if (!panel || !btn) return;

  const logHtml = job.log.length
    ? `<pre class="backlog-log">${job.log.map(escapeHtml).join("\n")}</pre>` : "";

  if (job.status === "running") {
    btn.textContent = "Backlog Sync Running…";
    btn.disabled = true;
    panel.style.display = "block";
    panel.innerHTML = `<div class="backlog-summary">${job.count} run${job.count === 1 ? "" : "s"} synced so far…</div>${logHtml}`;
  } else {
    btn.textContent = job.lastCompleted.syncedAt ? "Re-run Backlog Sync" : "Run Backlog Sync";
    btn.disabled = false;
    if (job.status === "error") {
      panel.style.display = "block";
      panel.innerHTML = `<div class="backlog-summary" style="color:var(--hot)">Failed: ${escapeHtml(job.error || "unknown error")}</div>${logHtml}`;
    } else if (job.lastCompleted.syncedAt) {
      panel.style.display = "block";
      panel.innerHTML = `<div class="backlog-summary">Last backlog sync: ${new Date(job.lastCompleted.syncedAt).toLocaleString()} · ${job.lastCompleted.count} runs</div>${logHtml}`;
    } else {
      panel.style.display = "none";
      panel.innerHTML = "";
    }
  }
  const logEl = panel.querySelector(".backlog-log");
  if (logEl) logEl.scrollTop = logEl.scrollHeight;
}

async function pollBacklogStatus(source, { reloadOnFinish } = {}) {
  const res = await fetch(`/api/sync/${source}/backlog/status`);
  const job = await res.json();
  renderBacklogPanel(source, job);
  if (job.status === "running") {
    backlogPollTimers[source] = setTimeout(() => pollBacklogStatus(source, { reloadOnFinish }), 1500);
  } else {
    stopBacklogPolling(source);
    if (reloadOnFinish) await loadRuns();
  }
}

// One-time status check on every Settings render — only enters the recurring 1.5s
// poll loop if a job is genuinely "running". Calling pollBacklogStatus unconditionally
// here (as this used to) meant an idle job's first check immediately called
// loadRuns() (via reloadOnFinish), which now calls dispatchCurrentTab() (since a
// recent refactor), which re-renders Settings again if it's the active tab —
// restarting this same unconditional poll and looping forever, visibly flashing
// the whole page. This never enters that cycle unless a sync is actually in flight.
async function checkBacklogOnce(source) {
  const res = await fetch(`/api/sync/${source}/backlog/status`);
  const job = await res.json();
  renderBacklogPanel(source, job);
  if (job.status === "running") {
    pollBacklogStatus(source, { reloadOnFinish: true });
  }
}

function wireSyncNowButton(source) {
  const btn = document.getElementById(`settings-${source}-sync-btn`);
  if (!btn) return;
  btn.onclick = async () => {
    btn.textContent = "Syncing…";
    btn.disabled = true;
    try {
      await fetch(`/api/sync/${source}`, { method: "POST" });
    } catch (e) {
      // network-level failures aside, server-side outcomes are persisted via sync_meta
      // and will show up in the re-rendered panel below regardless.
    }
    // loadRuns() already re-renders Settings via dispatchCurrentTab() when this tab is
    // active — a second explicit renderSettingsTab() call here was a redundant full
    // tab rebuild on every Sync Now click (visible as a jump/flicker).
    await loadRuns();
  };
}

function wireBacklogButton(source) {
  const btn = document.getElementById(`settings-${source}-backlog-btn`);
  if (!btn) return;
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      const res = await fetch(`/api/sync/${source}/backlog`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const panel = document.getElementById(`backlog-panel-${source}`);
        panel.style.display = "block";
        panel.innerHTML = `<div class="backlog-summary" style="color:var(--hot)">${escapeHtml(data.detail || "Failed to start backlog sync")}</div>`;
        btn.disabled = false;
        return;
      }
    } catch (e) {
      btn.disabled = false;
      return;
    }
    pollBacklogStatus(source, { reloadOnFinish: true });
  };
}

function wireGarminImportButton() {
  const btn = document.getElementById("garmin-import-btn");
  const fileInput = document.getElementById("garmin-import-file");
  const panel = document.getElementById("garmin-import-result");
  if (!btn || !fileInput || !panel) return;
  btn.onclick = async () => {
    const file = fileInput.files[0];
    if (!file) {
      panel.style.display = "block";
      panel.innerHTML = `<div class="backlog-summary" style="color:var(--hot)">Choose a .zip file first</div>`;
      return;
    }
    btn.disabled = true;
    btn.textContent = "Importing…";
    panel.style.display = "block";
    panel.innerHTML = `<div class="backlog-summary">Uploading and parsing ${escapeHtml(file.name)} — this can take a while for a large export…</div>`;
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/garmin/import", { method: "POST", body: formData });
      const summary = await res.json();
      if (!res.ok) {
        panel.innerHTML = `<div class="backlog-summary" style="color:var(--hot)">${escapeHtml(summary.detail || "Import failed")}</div>`;
      } else {
        const errLines = (summary.errors || []).slice(0, 5).map((e) => `<div>${escapeHtml(e)}</div>`).join("");
        panel.innerHTML = `
          <div class="backlog-summary">
            Scanned ${summary.filesScanned} files (${summary.jsonFilesParsed} JSON, ${summary.fitFilesFound} FIT)<br>
            Activities: ${summary.activityRecordsFound} found — ${summary.activitiesImported} imported,
            ${summary.activitiesSkippedExisting} already synced, ${summary.activitiesSkippedMalformed} skipped<br>
            Daily steps: ${summary.dailyWellnessRecordsFound} found — ${summary.dailyStepsImported} imported
          </div>
          ${errLines ? `<pre class="backlog-log">${errLines}</pre>` : ""}
        `;
        if (summary.activitiesImported > 0) await loadRuns();
      }
    } catch (e) {
      panel.innerHTML = `<div class="backlog-summary" style="color:var(--hot)">Import failed: ${escapeHtml(String(e))}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = "Import";
    }
  };
}

async function renderSettingsTab() {
  const el = document.getElementById("settings-tab");
  const [stravaStatus, syncMeta, garminStatus, config, connections, routeDiag, recentSteps, coachPersonality] = await Promise.all([
    fetch("/api/strava/status").then((r) => r.json()),
    fetch("/api/sync/meta").then((r) => r.json()),
    fetch("/api/garmin/status").then((r) => r.json()),
    fetch("/api/config").then((r) => r.json()),
    fetch("/api/connections").then((r) => r.json()).catch(() => []),
    fetch("/api/garmin/route-diagnostics").then((r) => r.json()).catch(() => null),
    fetch("/api/steps?days=7").then((r) => r.json()).catch(() => []),
    fetch("/api/coach/personality").then((r) => r.json()).catch(() => ({ personality: "normal" })),
  ]);
  const latestSteps = recentSteps.length ? recentSteps[recentSteps.length - 1] : null;

  const fmtMeta = (m) => m.lastSyncedAt
    ? `${new Date(m.lastSyncedAt).toLocaleString()} · ${m.lastCount} run${m.lastCount === 1 ? "" : "s"}`
    : "Never synced";

  const garminConn = connections.find((c) => c.provider === "garmin");
  const garminFormHtml = garminStatus.configured
    ? `<div class="settings-row"><span class="settings-label">Username</span><span class="settings-value">${escapeHtml(garminConn?.username || "")}</span></div>
       <button class="edit-link" id="garmin-remove-btn">Remove connection</button>`
    : `<div class="field"><div class="field-label">Garmin email</div><input id="garmin-username-input" type="text" placeholder="you@example.com" /></div>
       <div class="field"><div class="field-label">Garmin password</div><input id="garmin-password-input" type="password" /></div>
       <button class="btn" id="garmin-save-btn">Save connection</button>`;

  el.innerHTML = `
    <div class="settings-section">
      <div class="settings-title">Strava</div>
      <div class="settings-row"><span class="settings-label">Status</span>
        <span class="settings-value"><span class="status-dot" style="background:${stravaStatus.connected ? "var(--good)" : "var(--hot)"}"></span>${stravaStatus.connected ? "Connected" : "Not connected"}</span></div>
      <div class="settings-row"><span class="settings-label">Last synced</span><span class="settings-value">${fmtMeta(syncMeta.strava)}</span></div>
      ${syncMeta.strava.lastError ? `<div class="settings-row"><span class="settings-label">Last error</span><span class="settings-value" style="color:var(--hot)">${syncMeta.strava.lastError}</span></div>` : ""}
      <div class="btn-row" style="justify-content:flex-start;margin-top:10px">
        <button class="btn" id="settings-strava-sync-btn" ${stravaStatus.connected ? "" : "disabled"}>Sync Now</button>
        <button class="btn btn-ghost" id="settings-strava-backlog-btn" ${stravaStatus.connected ? "" : "disabled"}>Run Backlog Sync</button>
      </div>
      <div class="backlog-panel" id="backlog-panel-strava" style="display:none"></div>
    </div>
    <div class="settings-section">
      <div class="settings-title">Garmin <span style="color:var(--faint);font-weight:400">(optional, unofficial)</span></div>
      <div class="settings-row"><span class="settings-label">Status</span>
        <span class="settings-value"><span class="status-dot" style="background:${garminStatus.configured ? "var(--good)" : "var(--faint)"}"></span>${garminStatus.configured ? "Configured" : "Not configured"}</span></div>
      <div class="settings-row"><span class="settings-label">Last synced</span><span class="settings-value">${fmtMeta(syncMeta.garmin)}</span></div>
      ${syncMeta.garmin.lastError ? `<div class="settings-row"><span class="settings-label">Last error</span><span class="settings-value" style="color:var(--hot)">${syncMeta.garmin.lastError}</span></div>` : ""}
      ${routeDiag && (routeDiag.fit_record_stream + routeDiag.geopolyline_summary + routeDiag.none) > 0 ? `
      <div class="settings-row"><span class="settings-label">Route source</span>
        <span class="settings-value" style="font-weight:400">${routeDiag.fit_record_stream} unmasked (FIT) · ${routeDiag.geopolyline_summary} Garmin summary · ${routeDiag.none} none</span></div>
      ` : ""}
      ${config.restingHrBpm ? `<div class="settings-row"><span class="settings-label">Resting HR</span><span class="settings-value">${config.restingHrBpm} bpm</span></div>` : ""}
      ${latestSteps ? `<div class="settings-row"><span class="settings-label">Steps (${latestSteps.date})</span><span class="settings-value">${latestSteps.steps.toLocaleString()}</span></div>` : ""}
      <div class="btn-row" style="justify-content:flex-start;margin-top:10px">
        <button class="btn" id="settings-garmin-sync-btn" ${garminStatus.configured ? "" : "disabled"}>Sync Now</button>
        <button class="btn btn-ghost" id="settings-garmin-backlog-btn" ${garminStatus.configured ? "" : "disabled"}>Run Backlog Sync</button>
      </div>
      <div class="backlog-panel" id="backlog-panel-garmin" style="display:none"></div>
    </div>
    <div class="settings-section">
      <div class="settings-title">Garmin data export import</div>
      <div class="settings-row"><span class="settings-label"></span><span class="settings-value" style="color:var(--faint);font-weight:400;text-align:right">Upload the ZIP from Garmin's "Export Your Data" (account.garmin.com) to backfill history without leaning on the rate-limited live sync. Safe to re-upload the same or a newer export.</span></div>
      <div class="btn-row" style="justify-content:flex-start;margin-top:10px">
        <input type="file" id="garmin-import-file" accept=".zip" />
        <button class="btn" id="garmin-import-btn">Import</button>
      </div>
      <div class="backlog-panel" id="garmin-import-result" style="display:none"></div>
    </div>
    <div class="settings-section">
      <div class="settings-title">Connections</div>
      <div class="settings-row"><span class="settings-label"></span><span class="settings-value" style="color:var(--faint);font-weight:400;text-align:right">Manage your Garmin login here instead of container env vars. Strava connects via the button in the header.</span></div>
      ${garminFormHtml}
    </div>
    <div class="settings-section">
      <div class="settings-title">Coach</div>
      <div class="settings-row">
        <span class="settings-label">Personality</span>
        <select id="coach-personality-select" class="map-location-select">
          <option value="encouraging" ${coachPersonality.personality === "encouraging" ? "selected" : ""}>Encouraging</option>
          <option value="normal" ${coachPersonality.personality === "normal" ? "selected" : ""}>Normal</option>
          <option value="spicy" ${coachPersonality.personality === "spicy" ? "selected" : ""}>Spicy</option>
          <option value="insulting" ${coachPersonality.personality === "insulting" ? "selected" : ""}>Insulting</option>
        </select>
      </div>
      <div class="settings-row"><span class="settings-label" id="coach-personality-saved" style="color:var(--good);font-weight:400"></span></div>
    </div>
    <div class="settings-section">
      <div class="settings-title">Sync schedule</div>
      <div class="settings-row"><span class="settings-label">Auto-sync interval</span><span class="settings-value">Every ${config.syncIntervalHours}h (Strava only)</span></div>
      <div class="settings-row"><span class="settings-label">Activities per sync</span><span class="settings-value">${config.syncActivityLimit}</span></div>
      <div class="settings-row"><span class="settings-label"></span><span class="settings-value" style="color:var(--faint);font-weight:400;text-align:right">Backlog Sync pulls a source's entire history in the background — a one-time catch-up, not part of the regular schedule.</span></div>
    </div>
    <div class="settings-section">
      <div class="settings-title">About</div>
      <div class="settings-row"><span class="settings-label"></span><span class="settings-value" style="color:var(--faint);font-weight:400;text-align:right">RunLog is free and open source. Found a bug, want a feature, or just want to support the project?</span></div>
      <div class="btn-row" style="justify-content:flex-start;margin-top:10px">
        <a class="btn btn-ghost" style="text-decoration:none;display:inline-block" href="https://github.com/treddington4/runlog" target="_blank" rel="noopener noreferrer">Contribute / Donate on GitHub</a>
      </div>
    </div>
  `;

  wireSyncNowButton("strava");
  wireSyncNowButton("garmin");
  wireBacklogButton("strava");
  wireBacklogButton("garmin");
  wireGarminImportButton();

  const garminSaveBtn = document.getElementById("garmin-save-btn");
  if (garminSaveBtn) {
    garminSaveBtn.onclick = async () => {
      const username = document.getElementById("garmin-username-input").value.trim();
      const password = document.getElementById("garmin-password-input").value;
      if (!username || !password) return;
      garminSaveBtn.disabled = true;
      garminSaveBtn.textContent = "Saving…";
      await fetch("/api/connections/garmin", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      await renderSettingsTab();
    };
  }
  const garminRemoveBtn = document.getElementById("garmin-remove-btn");
  if (garminRemoveBtn) {
    garminRemoveBtn.onclick = async () => {
      await fetch("/api/connections/garmin", { method: "DELETE" });
      await renderSettingsTab();
    };
  }

  const coachPersonalitySelect = document.getElementById("coach-personality-select");
  if (coachPersonalitySelect) {
    coachPersonalitySelect.onchange = async () => {
      const personality = coachPersonalitySelect.value;
      await fetch("/api/coach/personality", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personality }),
      });
      const savedEl = document.getElementById("coach-personality-saved");
      if (savedEl) {
        savedEl.textContent = "Saved";
        setTimeout(() => { if (savedEl) savedEl.textContent = ""; }, 1500);
      }
    };
  }

  stopBacklogPolling("strava");
  stopBacklogPolling("garmin");
  checkBacklogOnce("strava");
  checkBacklogOnce("garmin");
}

// ---------- Map (heatmap of all synced GPS routes, groupable by location and metric) ----------
let map = null;
let routeLayer = null;
let metricLayer = null;
let mapClusters = [];
let mapAutoCenterApplied = false; // only ever apply the default once per page load — never override a manual location pick
const CLUSTER_RADIUS_KM = 50; // runs with start points within this distance are treated as the same location
const HEAT_BUCKETS = 16; // discrete color steps for metric-colored route segments

// Each metric gets its own gradient so switching modes is visually distinguishable
// at a glance, not just via the legend text.
const GRADIENTS = {
  // blue (slow) -> cyan -> green -> yellow -> red (fast) — classic "speed" cool-to-hot
  pace: [
    [0.00, [40, 80, 230]],
    [0.35, [0, 210, 210]],
    [0.55, [60, 200, 80]],
    [0.75, [235, 210, 40]],
    [1.00, [230, 60, 40]],
  ],
  // green -> yellow -> orange -> red, matching standard HR training-zone colors (Z1-Z5)
  hr: [
    [0.00, [50, 180, 90]],
    [0.35, [190, 210, 50]],
    [0.65, [235, 160, 30]],
    [1.00, [225, 40, 40]],
  ],
  // deep purple -> magenta -> orange, kept distinct from pace/HR's blue and green starts
  cadence: [
    [0.00, [90, 60, 190]],
    [0.45, [190, 50, 160]],
    [0.75, [230, 90, 70]],
    [1.00, [245, 160, 40]],
  ],
  // diverging: blue (downhill) -> neutral beige (flat) -> red/brown (uphill)
  elevation: [
    [0.00, [40, 110, 200]],
    [0.35, [130, 185, 210]],
    [0.50, [225, 220, 200]],
    [0.65, [220, 150, 90]],
    [1.00, [190, 60, 40]],
  ],
};

function fmtPct(v) { return `${v > 0 ? "+" : ""}${v.toFixed(1)}%`; }

const METRIC_CONFIG = {
  // clipMin/clipMax: whether to percentile-clip that end of the range, vs. use the raw
  // extreme. Pace's slow end is prone to near-stopped/GPS-noise outliers (a stoplight
  // pause can read as 80+ min/mi) that would otherwise stretch the whole scale — but the
  // fast end is real effort (sprints), so clamping it into the same bucket as ordinary
  // tempo pace would erase genuinely distinct short, fast splits. HR/cadence have no
  // confirmed equivalent issue, so both ends stay clipped there.
  pace: {
    key: "paceSecPerMi", label: "Pace", invert: true, fmt: (v) => `${paceStr(v)}/mi`,
    clipMin: false, clipMax: true, gradient: GRADIENTS.pace,
    legend: (min, max, cfg) => `blue ${cfg.fmt(max)} → red ${cfg.fmt(min)}`,
  },
  hr: {
    key: "hr", label: "Heart Rate", invert: false, fmt: (v) => `${Math.round(v)} bpm`,
    clipMin: true, clipMax: true, gradient: GRADIENTS.hr, valid: isPlausibleHR,
    legend: (min, max, cfg) => `blue ${cfg.fmt(min)} → red ${cfg.fmt(max)}`,
  },
  cadence: {
    key: "cadence", label: "Cadence", invert: false, fmt: (v) => `${Math.round(v)} spm`,
    clipMin: true, clipMax: true, gradient: GRADIENTS.cadence,
    legend: (min, max, cfg) => `blue ${cfg.fmt(min)} → red ${cfg.fmt(max)}`,
  },
  elevation: {
    // Grade can go either direction, so this uses a range symmetric around 0 (see
    // buildMetricSegments' `diverging` branch) rather than min/max clipping — flat
    // ground should always land in the middle of the gradient, not wherever this
    // particular view's data happens to center.
    key: "gradePct", label: "Grade", diverging: true, clipPercentile: 0.95, fmt: fmtPct, gradient: GRADIENTS.elevation,
    legend: (min, max, cfg) => `blue ${cfg.fmt(min)} (downhill) → red ${cfg.fmt(max)} (uphill)`,
  },
};

function heatColor(t, stops) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i], [t1, c1] = stops[i + 1];
    if (t >= t0 && t <= t1) {
      const f = (t - t0) / (t1 - t0 || 1);
      const c = c0.map((v, idx) => Math.round(v + (c1[idx] - v) * f));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
  }
  return `rgb(${stops[stops.length - 1][1].join(",")})`;
}

function haversineKm(a, b) {
  const R = 6371;
  const dLat = (b[0] - a[0]) * Math.PI / 180;
  const dLon = (b[1] - a[1]) * Math.PI / 180;
  const la1 = a[0] * Math.PI / 180, la2 = b[0] * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// A paused-then-resumed-elsewhere run (stopped recording, drove/traveled, resumed) leaves
// a real geographic gap in the point sequence — connecting it draws a straight "teleport"
// line across the map that isn't a real path. Threshold adapts to each route's own typical
// point spacing (coarser decimation on long runs naturally has wider gaps) rather than a
// single fixed distance, floored at 0.2mi so short/dense routes don't flag normal spacing.
function computeGapThresholdKm(points) {
  if (points.length < 2) return Infinity;
  const dists = [];
  for (let i = 0; i < points.length - 1; i++) dists.push(haversineKm(points[i], points[i + 1]));
  const sorted = [...dists].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  return Math.max(0.32, median * 6);
}

function splitRouteAtGaps(route) {
  if (route.length < 2) return [route];
  const threshold = computeGapThresholdKm(route);
  const segments = [];
  let current = [route[0]];
  for (let i = 0; i < route.length - 1; i++) {
    if (haversineKm(route[i], route[i + 1]) > threshold) {
      segments.push(current);
      current = [];
    }
    current.push(route[i + 1]);
  }
  segments.push(current);
  return segments.filter((s) => s.length > 1);
}

function clusterRuns(items) {
  // items: [{ run, route }]
  const clusters = [];
  items.forEach((item) => {
    const start = item.route[0];
    let cluster = clusters.find((c) => haversineKm(c.anchor, start) <= CLUSTER_RADIUS_KM);
    if (!cluster) {
      cluster = { id: `c${clusters.length}`, anchor: start, items: [], label: null };
      clusters.push(cluster);
    }
    cluster.items.push(item);
  });
  clusters.sort((a, b) => b.items.length - a.items.length);
  return clusters;
}

function clusterCentroid(cluster) {
  const lat = cluster.items.reduce((s, i) => s + i.route[0][0], 0) / cluster.items.length;
  const lon = cluster.items.reduce((s, i) => s + i.route[0][1], 0) / cluster.items.length;
  return [lat, lon];
}

async function reverseGeocode(lat, lon) {
  // Backend caches this in the DB (shared across every browser/device), so a cache
  // hit is just one fast same-origin round trip — no client-side cache or rate-limit
  // delay needed here, only genuinely new locations pay the Nominatim lookup cost.
  try {
    const res = await fetch(`/api/geocode?lat=${lat}&lon=${lon}`);
    const data = await res.json();
    return data.label || `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
  } catch (e) {
    return `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
  }
}

function populateLocationSelect() {
  const sel = document.getElementById("map-location-select");
  const prevValue = sel.value || "all";
  sel.innerHTML = `<option value="all">All locations · ${mapClusters.reduce((s, c) => s + c.items.length, 0)} runs</option>` +
    mapClusters.map((c) => `<option value="${c.id}">${escapeHtml(c.label || "Locating…")} · ${c.items.length} run${c.items.length === 1 ? "" : "s"}</option>`).join("");
  sel.value = mapClusters.some((c) => c.id === prevValue) || prevValue === "all" ? prevValue : "all";
}

async function geocodeClustersInBackground() {
  for (const cluster of mapClusters) {
    if (cluster.label) continue;
    const [lat, lon] = clusterCentroid(cluster);
    cluster.label = await reverseGeocode(lat, lon);
    populateLocationSelect();
  }
}

function buildMetricSegments(items, cfg) {
  // Turns consecutive routeMetrics points into short 2-point segments, each carrying
  // the average metric value across that segment, then buckets them into HEAT_BUCKETS
  // color bins so the whole thing renders as a handful of Leaflet layers (fast) instead
  // of one per segment (could be tens of thousands at full history).
  const segments = [];
  const runsWithMetric = new Set();
  items.forEach(({ run }) => {
    const pts = run.routeMetrics || [];
    if (pts.length < 2) return;
    // Same pause/teleport-gap guard as the density-mode route drawing — a paused-then-
    // resumed-elsewhere run shouldn't connect its pre- and post-pause points either.
    const gapThreshold = computeGapThresholdKm(pts.map((p) => [p.lat, p.lon]));
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      if (a[cfg.key] == null || b[cfg.key] == null) continue;
      if (cfg.valid && (!cfg.valid(a[cfg.key]) || !cfg.valid(b[cfg.key]))) continue;
      if (haversineKm([a.lat, a.lon], [b.lat, b.lon]) > gapThreshold) continue;
      segments.push({ line: [[a.lat, a.lon], [b.lat, b.lon]], value: (a[cfg.key] + b[cfg.key]) / 2 });
      runsWithMetric.add(run.id);
    }
  });

  if (!segments.length) return { buckets: [], min: 0, max: 0, runCount: 0 };

  const sorted = segments.map((s) => s.value).sort((a, b) => a - b);
  const percentile = (p) => {
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  };

  let min, max;
  if (cfg.diverging) {
    // Symmetric range around 0 so "flat" always lands in the middle of the gradient,
    // not wherever this view's downhill/uphill mix happens to center. Clipped by the
    // larger of the two tails' percentile magnitude, same noise-outlier reasoning as below.
    const p = cfg.clipPercentile ?? 0.95;
    const maxAbs = Math.max(Math.abs(percentile(1 - p)), Math.abs(percentile(p))) || 1;
    min = -maxAbs;
    max = maxAbs;
  } else {
    // Clip noisy ends to the 5th/95th percentile rather than raw min/max: a few near-stopped
    // or GPS-noise points (e.g. a stoplight pause) otherwise stretch the scale so far that
    // normal variation gets crushed into one or two buckets. Only clip the ends configured
    // as noise-prone per metric (see METRIC_CONFIG) — a real extreme (e.g. a short sprint)
    // should anchor the scale, not get clamped in with ordinary values.
    min = cfg.clipMin ? percentile(0.05) : sorted[0];
    max = cfg.clipMax ? percentile(0.95) : sorted[sorted.length - 1];
  }
  const range = max - min || 1;

  const buckets = Array.from({ length: HEAT_BUCKETS }, () => []);
  segments.forEach(({ line, value }) => {
    let t = Math.max(0, Math.min(1, (value - min) / range));
    if (cfg.invert) t = 1 - t;
    buckets[Math.min(HEAT_BUCKETS - 1, Math.floor(t * HEAT_BUCKETS))].push(line);
  });

  return { buckets, min, max, runCount: runsWithMetric.size };
}

function drawMapView() {
  const locSel = document.getElementById("map-location-select");
  const metricSel = document.getElementById("map-metric-select");
  const summaryEl = document.getElementById("map-summary");
  const selected = locSel.value;
  const metric = metricSel.value;
  const items = selected === "all"
    ? mapClusters.flatMap((c) => c.items)
    : (mapClusters.find((c) => c.id === selected) || {}).items || [];

  let boundsLayer = null;

  if (metric === "density") {
    if (metricLayer) { map.removeLayer(metricLayer); metricLayer = null; }
    if (!map.hasLayer(routeLayer)) routeLayer.addTo(map);
    routeLayer.clearLayers();
    items.forEach(({ route }) => {
      splitRouteAtGaps(route).forEach((segment) => {
        L.polyline(segment, { color: "#FFC857", weight: 2, opacity: 0.22, interactive: false }).addTo(routeLayer);
      });
    });
    boundsLayer = routeLayer;

    const totalWithRoutes = mapClusters.reduce((s, c) => s + c.items.length, 0);
    summaryEl.textContent = selected === "all"
      ? `${totalWithRoutes} run${totalWithRoutes === 1 ? "" : "s"} with GPS data plotted (of ${runs.length} total)`
      : `${items.length} run${items.length === 1 ? "" : "s"} plotted for this location`;
  } else {
    if (map.hasLayer(routeLayer)) map.removeLayer(routeLayer);
    if (metricLayer) { map.removeLayer(metricLayer); metricLayer = null; }

    const cfg = METRIC_CONFIG[metric];
    const { buckets, min, max, runCount } = buildMetricSegments(items, cfg);

    if (runCount) {
      metricLayer = L.featureGroup();
      buckets.forEach((segments, i) => {
        if (!segments.length) return;
        const t = (i + 0.5) / HEAT_BUCKETS;
        L.polyline(segments, { color: heatColor(t, cfg.gradient), weight: 3, opacity: 0.85, interactive: false }).addTo(metricLayer);
      });
      metricLayer.addTo(map);
      boundsLayer = metricLayer;

      summaryEl.textContent = `${cfg.label} · ${runCount} run${runCount === 1 ? "" : "s"} · ${cfg.legend(min, max, cfg)}`;
    } else {
      summaryEl.textContent = `No ${cfg.label.toLowerCase()} data yet for this selection — this is Strava-only for now, and needs a Backlog Sync to backfill runs synced before this feature existed.`;
    }
  }

  requestAnimationFrame(() => {
    map.invalidateSize();
    if (boundsLayer) {
      const bounds = boundsLayer.getBounds();
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24] });
    }
  });
}

function renderMapTab() {
  const summaryEl = document.getElementById("map-summary");
  const locSel = document.getElementById("map-location-select");
  const metricSel = document.getElementById("map-metric-select");
  // Some activities have no summary_polyline from Strava (a data quirk, not a sync bug)
  // but still have real GPS via the streams-derived routeMetrics — fall back to deriving
  // a route from that rather than dropping the activity from the map entirely.
  const items = runs
    .map((r) => ({ run: r, route: (r.route && r.route.length > 1) ? r.route : (r.routeMetrics || []).map((p) => [p.lat, p.lon]) }))
    .filter((item) => item.route.length > 1);

  if (!map) {
    map = L.map("map-canvas", { preferCanvas: true }).setView([40, -97], 4);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      maxZoom: 19,
    }).addTo(map);
    routeLayer = L.featureGroup().addTo(map);
  }

  if (!items.length) {
    routeLayer.clearLayers();
    if (metricLayer) { map.removeLayer(metricLayer); metricLayer = null; }
    locSel.style.display = "none";
    metricSel.style.display = "none";
    summaryEl.textContent = runs.length
      ? "No GPS routes yet. Run a Backlog Sync from Settings to backfill routes for existing runs (this feature was added after they were first synced)."
      : "No runs yet.";
    requestAnimationFrame(() => map.invalidateSize());
    return;
  }

  locSel.style.display = "inline-block";
  metricSel.style.display = "inline-block";
  mapClusters = clusterRuns(items);
  populateLocationSelect();
  selectClusterForMostRecentActivity();
  locSel.onchange = drawMapView;
  metricSel.onchange = drawMapView;
  drawMapView();
  geocodeClustersInBackground();
}

// Defaults the map to the location cluster containing the most recent activity, instead
// of always showing "All locations" (zoomed out enough to include any one-off travel/
// vacation runs, which makes the cluster the user actually cares about day-to-day tiny
// and hard to read). Deterministic and synchronous — no permissions or network required,
// unlike a GPS-based approach, which browsers restrict to secure contexts (HTTPS or
// literally localhost) anyway; this app is plain HTTP on a LAN IP, so geolocation would
// likely never have fired at all. Applied only once per page load (a module-level flag)
// so it never overrides a location the user has since picked manually.
function selectClusterForMostRecentActivity() {
  if (mapAutoCenterApplied) return;
  mapAutoCenterApplied = true;

  let mostRecent = null;
  let mostRecentCluster = null;
  mapClusters.forEach((c) => {
    c.items.forEach((item) => {
      const key = `${item.run.date}T${item.run.startTime || ""}`;
      if (!mostRecent || key > mostRecent) {
        mostRecent = key;
        mostRecentCluster = c;
      }
    });
  });

  const sel = document.getElementById("map-location-select");
  if (sel && sel.value === "all" && mostRecentCluster) {
    sel.value = mostRecentCluster.id;
  }
}

// ---------- Home + Goals ----------
function fmtGoalDate(d) {
  if (!d) return "";
  return new Date(d + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function goalCardBody(g) {
  const p = g.progress || {};
  if (g.goalType === "race") {
    const days = p.daysUntil;
    const linked = p.linkedRun;
    // "Race day!" only makes sense for day 0 — once it's actually passed, either show
    // the real matched result (see stats._find_and_link_race_run) or say so plainly,
    // rather than repeating "Race day!" forever if the goal is never manually completed.
    let statusLine;
    if (days == null) statusLine = "--";
    else if (days > 0) statusLine = `${days}d`;
    else if (days === 0) statusLine = "Race day!";
    else if (linked) statusLine = `${linked.distanceMi} mi`;
    else statusLine = "Race day passed";

    const detailLine = linked
      ? `Finished in ${timeStr(linked.movingTimeSec)}${linked.avgPaceSecPerMi ? " · " + paceStr(linked.avgPaceSecPerMi) + "/mi" : ""} on ${fmtGoalDate(linked.date)}`
      : `${fmtGoalDate(g.targetDate)} · ${p.recent28DayMiles ?? 0} mi (${g.activityTypes.join("+")}) last 28 days`;

    return `
      <div class="stat-value">${statusLine}</div>
      <div class="stat-breakdown">${detailLine}</div>
    `;
  }
  if (g.goalType === "consistency") {
    const targetLabel = g.targetUnit === "runs_per_week" ? `${g.targetValue}x/week` : `${g.targetValue} mi/week`;
    return `
      <div class="stat-value">${p.streakWeeks ?? 0} wk streak</div>
      <div class="stat-breakdown">Target ${targetLabel} · this week: ${p.currentWeekRunCount ?? 0} runs, ${p.currentWeekMiles ?? 0} mi</div>
    `;
  }
  // distance_target
  const pct = p.pctComplete;
  return `
    <div class="stat-value">${p.completedMi ?? 0} / ${g.targetValue} mi</div>
    ${pct != null ? dashBar(pct, pct >= 100 ? "var(--good)" : "var(--gold)") : ""}
    <div class="stat-breakdown">${pct != null ? pct + "% complete" : ""}${g.targetDate ? " · by " + fmtGoalDate(g.targetDate) : ""}</div>
  `;
}

function renderGoalCards(list, { actions = false, linkToGoalsTab = false } = {}) {
  if (!list.length) return `<div class="empty-chart">No goals here yet.</div>`;
  return `<div class="dashboard-grid">${list.map((g) => `
    <div class="chart-card${linkToGoalsTab ? " clickable" : ""}" ${linkToGoalsTab ? `data-nav-tab="goals"` : ""}>
      <div class="stat-label">${escapeHtml(g.name)}</div>
      ${goalCardBody(g)}
      ${actions ? `
        <div class="btn-row" style="justify-content:flex-start;margin-top:10px">
          <button class="edit-link" data-goal-edit="${g.id}">Edit</button>
          ${g.status === "active" ? `<button class="edit-link" data-goal-complete="${g.id}">Mark complete</button>
          <button class="edit-link" data-goal-abandon="${g.id}">Abandon</button>` : ""}
          <button class="edit-link" data-goal-delete="${g.id}" style="color:var(--hot)">Delete</button>
        </div>
      ` : ""}
    </div>
  `).join("")}</div>`;
}

async function renderHomeTab() {
  const el = document.getElementById("home-tab");
  el.innerHTML = `
    <div class="stat-strip">
      <div class="stat-card clickable" data-nav-tab="runs" data-nav-filter="week"><div class="stat-label">This week</div><div class="stat-value" id="stat-week">--</div></div>
      <div class="stat-card clickable" data-nav-tab="runs" data-nav-filter="all"><div class="stat-label">Avg pace (all)</div><div class="stat-value" id="stat-pace">--</div></div>
      <div class="stat-card clickable" data-nav-tab="runs" data-nav-filter="all"><div class="stat-label">Runs logged</div><div class="stat-value" id="stat-count">--</div></div>
    </div>
    <div class="stat-breakdown" id="stat-breakdown"></div>
    <div class="chart-title" style="margin-top:20px">Goals</div>
    <div id="home-goals"><div class="empty-chart">Loading…</div></div>
    <div id="home-dashboard" style="margin-top:10px"></div>
    <div id="home-wellness" style="margin-top:10px"></div>
  `;
  updateHeaderStats();
  wireNavCards(el.querySelector(".stat-strip"));

  const activeGoals = goals.filter((g) => g.status === "active");
  const homeGoalsEl = document.getElementById("home-goals");
  homeGoalsEl.innerHTML = activeGoals.length
    ? renderGoalCards(activeGoals, { linkToGoalsTab: true })
    : `<div class="empty-chart">No active goals yet — add one on the Goals tab.</div>`;
  wireNavCards(homeGoalsEl);

  const dashboard = await fetch("/api/dashboard/summary").then((r) => r.json()).catch(() => null);
  const homeDashboardEl = document.getElementById("home-dashboard");
  homeDashboardEl.innerHTML = dashboard ? renderDashboardCards(dashboard) : "";
  wireNavCards(homeDashboardEl);

  // Garmin-only wellness (resting HR / VO2max / sleep) — degrades to nothing (not an
  // empty-state card) if there's no data yet, since it's an optional bonus source.
  const wellnessData = await fetch("/api/wellness?days=30").then((r) => r.json()).catch(() => []);
  const homeWellnessEl = document.getElementById("home-wellness");
  homeWellnessEl.innerHTML = renderWellnessCards(wellnessData);
  wireNavCards(homeWellnessEl);
}

function latestWellnessValue(wellnessData, field) {
  for (let i = wellnessData.length - 1; i >= 0; i--) {
    if (wellnessData[i][field] != null) return { value: wellnessData[i][field], date: wellnessData[i].date };
  }
  return null;
}

function fmtSleepDuration(seconds) {
  if (!seconds) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function renderWellnessCards(wellnessData) {
  const rhr = latestWellnessValue(wellnessData, "restingHrBpm");
  const vo2 = latestWellnessValue(wellnessData, "vo2max");
  const sleepScore = latestWellnessValue(wellnessData, "sleepScore");
  const sleepDuration = latestWellnessValue(wellnessData, "sleepSeconds");
  if (!rhr && !vo2 && !sleepScore) return "";

  return `
    <div class="chart-title" style="margin-top:20px">Wellness</div>
    <div class="dashboard-grid" style="margin-top:10px">
      <div class="chart-card clickable" data-nav-tab="insights">
        <div class="stat-label">Resting HR</div>
        <div class="stat-value">${rhr ? rhr.value + " bpm" : "--"}</div>
        <div class="stat-breakdown">${rhr ? rhr.date : "no data yet"}</div>
      </div>
      <div class="chart-card clickable" data-nav-tab="insights">
        <div class="stat-label">VO2 max</div>
        <div class="stat-value">${vo2 ? vo2.value : "--"}</div>
        <div class="stat-breakdown">${vo2 ? vo2.date : "no data yet"}</div>
      </div>
      <div class="chart-card clickable" data-nav-tab="insights">
        <div class="stat-label">Sleep</div>
        <div class="stat-value">${sleepScore ? sleepScore.value : "--"}</div>
        <div class="stat-breakdown">${sleepDuration ? fmtSleepDuration(sleepDuration.value) : ""} ${sleepScore ? `on ${sleepScore.date}` : "no data yet"}</div>
      </div>
    </div>
  `;
}

const GOAL_TYPE_LABELS = { race: "Race", consistency: "Consistency", distance_target: "Distance target" };

async function renderGoalsTab() {
  const el = document.getElementById("goals-tab");
  el.innerHTML = `
    <div class="btn-row" style="justify-content:flex-start;margin:16px 0"><button class="btn" id="new-goal-btn">+ New Goal</button></div>
    <div id="goals-list"><div class="empty-chart">Loading…</div></div>
  `;
  document.getElementById("new-goal-btn").onclick = () => openGoalModal(null);

  const active = goals.filter((g) => g.status === "active");
  const completed = goals.filter((g) => g.status === "completed");
  const abandoned = goals.filter((g) => g.status === "abandoned");

  document.getElementById("goals-list").innerHTML = `
    <div class="chart-title">Active</div>
    <div style="margin-top:10px">${renderGoalCards(active, { actions: true })}</div>
    ${completed.length ? `<div class="chart-title" style="margin-top:20px">Completed</div><div style="margin-top:10px">${renderGoalCards(completed, { actions: true })}</div>` : ""}
    ${abandoned.length ? `<div class="chart-title" style="margin-top:20px">Abandoned</div><div style="margin-top:10px">${renderGoalCards(abandoned, { actions: true })}</div>` : ""}
  `;

  document.querySelectorAll("[data-goal-edit]").forEach((btn) => {
    btn.onclick = () => openGoalModal(goals.find((g) => g.id === btn.dataset.goalEdit));
  });
  document.querySelectorAll("[data-goal-complete]").forEach((btn) => {
    btn.onclick = () => patchGoalStatus(btn.dataset.goalComplete, "completed");
  });
  document.querySelectorAll("[data-goal-abandon]").forEach((btn) => {
    btn.onclick = () => patchGoalStatus(btn.dataset.goalAbandon, "abandoned");
  });
  document.querySelectorAll("[data-goal-delete]").forEach((btn) => {
    btn.onclick = async () => {
      await fetch(`/api/goals/${btn.dataset.goalDelete}`, { method: "DELETE" });
      await loadGoals();
      renderRaceCountdown();
      renderGoalsTab();
    };
  });
}

async function patchGoalStatus(goalId, status) {
  await fetch(`/api/goals/${goalId}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }),
  });
  await loadGoals();
  renderRaceCountdown();
  renderGoalsTab();
}

function openGoalModal(goal) {
  const root = document.getElementById("modal-root");
  const isEdit = !!goal;
  const type = goal?.goalType || "race";
  const knownTypes = Array.from(new Set(["Run", "Ride", "Swim", ...runs.map((r) => r.activityType || "Run")]));
  const selectedTypes = goal?.activityTypes || ["Run"];

  const typeOptionsHtml = Object.entries(GOAL_TYPE_LABELS)
    .map(([v, label]) => `<option value="${v}" ${v === type ? "selected" : ""}>${label}</option>`).join("");
  const activityChecksHtml = knownTypes.map((t) => `
    <label class="checkbox-row"><input type="checkbox" value="${t}" ${selectedTypes.includes(t) ? "checked" : ""} class="f-goal-activity-type"/> ${t}</label>
  `).join("");

  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <div class="modal-head"><div style="font-weight:700">${isEdit ? "Edit Goal" : "New Goal"}</div><button class="modal-close" id="modal-close">✕</button></div>
        <div class="field"><div class="field-label">Name</div><input id="f-goal-name" type="text" value="${goal ? escapeHtml(goal.name) : ""}" placeholder="e.g. Manchester City Marathon" /></div>
        <div class="field"><div class="field-label">Goal type</div><select id="f-goal-type">${typeOptionsHtml}</select></div>
        <div class="field"><div class="field-label">Activity types</div>${activityChecksHtml}</div>

        <div id="f-race-fields" style="display:${type === "race" ? "block" : "none"}">
          <div class="field"><div class="field-label">Race date</div><input id="f-target-date" type="date" value="${goal?.targetDate || ""}" /></div>
          <div class="field"><div class="field-label">Race distance (mi)</div><input id="f-race-mi" type="number" step="0.1" value="${type === "race" ? (goal?.targetValue ?? "") : ""}" placeholder="e.g. 26.2" /></div>
        </div>
        <div id="f-consistency-fields" style="display:${type === "consistency" ? "block" : "none"}">
          <div class="field"><div class="field-label">Target</div>
            <select id="f-consistency-unit">
              <option value="runs_per_week" ${goal?.targetUnit === "runs_per_week" ? "selected" : ""}>Runs per week</option>
              <option value="miles_per_week" ${goal?.targetUnit === "miles_per_week" ? "selected" : ""}>Miles per week</option>
            </select>
            <input id="f-consistency-value" type="number" step="0.1" value="${type === "consistency" ? (goal?.targetValue ?? "") : ""}" placeholder="e.g. 3" style="margin-top:6px" />
          </div>
        </div>
        <div id="f-distance-fields" style="display:${type === "distance_target" ? "block" : "none"}">
          <div class="field"><div class="field-label">Target distance (mi)</div><input id="f-distance-mi" type="number" step="1" value="${type === "distance_target" ? (goal?.targetValue ?? "") : ""}" placeholder="e.g. 500" /></div>
          <div class="field"><div class="field-label">Start date</div><input id="f-distance-start" type="date" value="${goal?.startDate || ""}" /></div>
          <div class="field"><div class="field-label">Deadline (optional)</div><input id="f-distance-deadline" type="date" value="${type === "distance_target" ? (goal?.targetDate || "") : ""}" /></div>
        </div>

        <div class="field"><div class="field-label">Notes</div><textarea id="f-goal-notes">${goal?.notes ?? ""}</textarea></div>
        <button class="modal-save" id="modal-save">${isEdit ? "Save" : "Create Goal"}</button>
      </div>
    </div>`;

  document.getElementById("modal-close").onclick = () => (root.innerHTML = "");
  document.getElementById("modal-backdrop").onclick = (e) => { if (e.target.id === "modal-backdrop") root.innerHTML = ""; };

  const typeSelect = document.getElementById("f-goal-type");
  typeSelect.onchange = () => {
    const t = typeSelect.value;
    document.getElementById("f-race-fields").style.display = t === "race" ? "block" : "none";
    document.getElementById("f-consistency-fields").style.display = t === "consistency" ? "block" : "none";
    document.getElementById("f-distance-fields").style.display = t === "distance_target" ? "block" : "none";
  };

  document.getElementById("modal-save").onclick = async () => {
    const goalType = typeSelect.value;
    const activityTypes = Array.from(document.querySelectorAll(".f-goal-activity-type:checked")).map((c) => c.value);
    const body = {
      goalType, name: document.getElementById("f-goal-name").value || "Untitled goal",
      activityTypes: activityTypes.length ? activityTypes : ["Run"],
      notes: document.getElementById("f-goal-notes").value,
    };
    if (goalType === "race") {
      body.targetDate = document.getElementById("f-target-date").value || null;
      body.targetValue = Number(document.getElementById("f-race-mi").value) || null;
      body.targetUnit = "miles";
    } else if (goalType === "consistency") {
      body.targetUnit = document.getElementById("f-consistency-unit").value;
      body.targetValue = Number(document.getElementById("f-consistency-value").value) || null;
    } else {
      body.targetValue = Number(document.getElementById("f-distance-mi").value) || null;
      body.targetUnit = "miles";
      body.startDate = document.getElementById("f-distance-start").value || null;
      body.targetDate = document.getElementById("f-distance-deadline").value || null;
    }

    if (isEdit) {
      await fetch(`/api/goals/${goal.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
    } else {
      await fetch("/api/goals", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
    }
    root.innerHTML = "";
    await loadGoals();
    renderRaceCountdown();
    if (currentTab === "goals") renderGoalsTab();
    else if (currentTab === "home") renderHomeTab();
  };
}

// ---------- Workouts (coach-scheduled or manually-created prescribed sessions —
// auto-links to the matching synced Run server-side, see coach._find_and_link_workout_run) ----------
const WORKOUT_TYPE_LABELS = {
  easy: "Easy", tempo: "Tempo", interval: "Interval", long: "Long", rest: "Rest",
  strength: "Strength", cross_train: "Cross-train",
};
const WORKOUT_STATUS_COLORS = { completed: "var(--good)", skipped: "var(--hot)", modified: "var(--faint)", planned: "var(--faint)" };

function parsePaceToSec(str) {
  if (!str) return null;
  const parts = String(str).trim().split(":");
  if (parts.length !== 2) return null;
  const m = Number(parts[0]), s = Number(parts[1]);
  if (!isFinite(m) || !isFinite(s)) return null;
  return m * 60 + s;
}

function workoutCardHTML(w) {
  const targetParts = [];
  if (w.targetDistanceMi) targetParts.push(`${w.targetDistanceMi} mi`);
  if (w.targetPaceSecPerMi) targetParts.push(`${paceStr(w.targetPaceSecPerMi)}/mi`);
  if (w.targetDurationSec) targetParts.push(`${Math.round(w.targetDurationSec / 60)} min`);
  return `
    <div class="settings-section" style="margin-bottom:10px">
      <div class="settings-row">
        <span class="settings-label">${w.scheduledDate} · ${WORKOUT_TYPE_LABELS[w.workoutType] || w.workoutType} (${escapeHtml(w.activityType)})</span>
        <span class="settings-value" style="color:${WORKOUT_STATUS_COLORS[w.status] || "var(--faint)"}">${w.status}</span>
      </div>
      ${targetParts.length ? `<div class="settings-row"><span class="settings-label">Target</span><span class="settings-value">${escapeHtml(targetParts.join(" · "))}</span></div>` : ""}
      ${w.notes ? `<div class="settings-row"><span class="settings-label">Notes</span><span class="settings-value" style="font-weight:400;text-align:right">${escapeHtml(w.notes)}</span></div>` : ""}
      ${w.critiqueText ? `<div class="settings-row"><span class="settings-label">Critique</span><span class="settings-value" style="font-weight:400;text-align:right">${escapeHtml(w.critiqueText)}</span></div>` : ""}
      <div class="btn-row" style="justify-content:flex-start;margin-top:8px">
        <button class="edit-link" data-workout-edit="${w.id}">Edit</button>
        <button class="edit-link" data-workout-delete="${w.id}">Delete</button>
      </div>
    </div>
  `;
}

async function renderWorkoutsTab() {
  const el = document.getElementById("workouts-tab");
  el.innerHTML = `
    <div class="btn-row" style="justify-content:flex-start;margin:16px 0"><button class="btn" id="new-workout-btn">+ New Workout</button></div>
    <div id="workouts-list"><div class="empty-chart">Loading…</div></div>
  `;
  document.getElementById("new-workout-btn").onclick = () => openWorkoutModal(null);

  const workouts = await fetch("/api/workouts").then((r) => r.json()).catch(() => []);
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = workouts.filter((w) => w.status === "planned" && w.scheduledDate >= today);
  const past = workouts.filter((w) => !(w.status === "planned" && w.scheduledDate >= today));

  document.getElementById("workouts-list").innerHTML = `
    <div class="chart-title">Upcoming</div>
    <div style="margin-top:10px">${upcoming.length ? upcoming.map(workoutCardHTML).join("") : `<div class="empty-chart">Nothing scheduled — ask the coach in Chat, or add one here.</div>`}</div>
    ${past.length ? `<div class="chart-title" style="margin-top:20px">Past</div><div style="margin-top:10px">${past.map(workoutCardHTML).join("")}</div>` : ""}
  `;

  document.querySelectorAll("[data-workout-edit]").forEach((btn) => {
    btn.onclick = () => openWorkoutModal(workouts.find((w) => w.id === btn.dataset.workoutEdit));
  });
  document.querySelectorAll("[data-workout-delete]").forEach((btn) => {
    btn.onclick = async () => {
      await fetch(`/api/workouts/${btn.dataset.workoutDelete}`, { method: "DELETE" });
      renderWorkoutsTab();
    };
  });
}

function openWorkoutModal(workout) {
  const root = document.getElementById("modal-root");
  const isEdit = !!workout;
  const typeOptionsHtml = Object.entries(WORKOUT_TYPE_LABELS)
    .map(([v, label]) => `<option value="${v}" ${v === (workout?.workoutType || "easy") ? "selected" : ""}>${label}</option>`).join("");

  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <div class="modal-head"><div style="font-weight:700">${isEdit ? "Edit Workout" : "New Workout"}</div><button class="modal-close" id="modal-close">✕</button></div>
        <div class="field"><div class="field-label">Date</div><input id="f-workout-date" type="date" value="${workout?.scheduledDate || ""}" /></div>
        <div class="field"><div class="field-label">Type</div><select id="f-workout-type">${typeOptionsHtml}</select></div>
        <div class="field"><div class="field-label">Activity</div><input id="f-workout-activity" type="text" value="${workout ? escapeHtml(workout.activityType) : "Run"}" placeholder="Run" /></div>
        <div class="field"><div class="field-label">Target distance (mi)</div><input id="f-workout-distance" type="number" step="0.1" value="${workout?.targetDistanceMi ?? ""}" /></div>
        <div class="field"><div class="field-label">Target pace (min:sec/mi)</div><input id="f-workout-pace" type="text" placeholder="8:00" value="${workout?.targetPaceSecPerMi ? paceStr(workout.targetPaceSecPerMi) : ""}" /></div>
        <div class="field"><div class="field-label">Target duration (min)</div><input id="f-workout-duration" type="number" step="1" value="${workout?.targetDurationSec ? Math.round(workout.targetDurationSec / 60) : ""}" /></div>
        <div class="field"><div class="field-label">Notes</div><textarea id="f-workout-notes">${workout ? escapeHtml(workout.notes || "") : ""}</textarea></div>
        <button class="modal-save" id="modal-save">${isEdit ? "Save" : "Create Workout"}</button>
      </div>
    </div>`;

  document.getElementById("modal-close").onclick = () => (root.innerHTML = "");
  document.getElementById("modal-backdrop").onclick = (e) => { if (e.target.id === "modal-backdrop") root.innerHTML = ""; };

  document.getElementById("modal-save").onclick = async () => {
    const durationMin = Number(document.getElementById("f-workout-duration").value);
    const body = {
      scheduledDate: document.getElementById("f-workout-date").value,
      workoutType: document.getElementById("f-workout-type").value,
      activityType: document.getElementById("f-workout-activity").value || "Run",
      targetDistanceMi: Number(document.getElementById("f-workout-distance").value) || null,
      targetPaceSecPerMi: parsePaceToSec(document.getElementById("f-workout-pace").value),
      targetDurationSec: durationMin ? durationMin * 60 : null,
      notes: document.getElementById("f-workout-notes").value,
    };
    if (!body.scheduledDate) return;
    if (isEdit) {
      await fetch(`/api/workouts/${workout.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
    } else {
      await fetch("/api/workouts", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
    }
    root.innerHTML = "";
    renderWorkoutsTab();
  };
}

// ---------- Chat (AI assistant grounded in real synced data, plus a real-data dashboard) ----------
let chatConfigured = null;
let chatSending = false;

function fmtPctChange(pct) {
  if (pct == null) return "--";
  return `${pct > 0 ? "+" : ""}${pct}%`;
}

function dashBar(pct, color) {
  const clamped = Math.max(0, Math.min(100, pct || 0));
  return `<div class="dash-bar"><div class="dash-bar-fill" style="width:${clamped}%;background:${color}"></div></div>`;
}

// Finds the pace-trend point closest to (but not after) 30 days before the most
// recent point, so "pace trend" reads as "vs about a month ago" without needing an
// exact-30-days-back data point to exist.
function paceTrendDelta(paceTrend) {
  if (!paceTrend.length) return { now: null, deltaSec: null };
  const latest = paceTrend[paceTrend.length - 1];
  const target = new Date(latest.date + "T00:00:00");
  target.setDate(target.getDate() - 30);
  let closest = null;
  for (const p of paceTrend) {
    if (new Date(p.date + "T00:00:00") <= target) closest = p;
  }
  const deltaSec = closest ? Math.round(closest.paceSecPerMi - latest.paceSecPerMi) : null;
  return { now: latest.paceSecPerMi, deltaSec };
}

function renderDashboardCards(d) {
  const streak = d.consistencyStreak || {};
  const load = d.trainingLoad || {};
  const dsl = d.daysSinceLongestRun;
  const pr = d.personalRecords || {};
  const weekly = d.weeklyMileage || [];
  const monthly = d.monthlyMileage || [];

  const thisWeek = weekly.length ? weekly[weekly.length - 1] : null;
  const avgWeek = weekly.length ? weekly.reduce((s, w) => s + w.totalMiles, 0) / weekly.length : 0;
  const weekPct = thisWeek && avgWeek ? (thisWeek.totalMiles / avgWeek) * 100 : 0;

  const loadColor = load.direction === "up" ? "var(--hot)" : load.direction === "down" ? "var(--cold)" : "var(--good)";

  const { now: paceNow, deltaSec: paceDeltaSec } = paceTrendDelta(d.paceTrend || []);
  const paceColor = paceDeltaSec > 0 ? "var(--good)" : paceDeltaSec < 0 ? "var(--hot)" : "var(--text)";
  const paceLabel = paceDeltaSec == null ? "--"
    : paceDeltaSec === 0 ? "steady"
    : `${paceStr(Math.abs(paceDeltaSec))} ${paceDeltaSec > 0 ? "faster" : "slower"}`;

  const thisMonth = monthly.length ? monthly[monthly.length - 1] : null;
  const lastMonth = monthly.length > 1 ? monthly[monthly.length - 2] : null;
  const monthPct = thisMonth && lastMonth && lastMonth.totalMiles ? (thisMonth.totalMiles / lastMonth.totalMiles) * 100 : 0;

  return `
    <div class="dashboard-grid">
      <div class="chart-card clickable" data-nav-tab="runs" data-nav-filter="week">
        <div class="stat-label">Consistency streak</div>
        <div class="stat-value">${streak.streakWeeks ?? 0} wk${streak.streakWeeks === 1 ? "" : "s"}</div>
        ${thisWeek ? dashBar(weekPct, "var(--gold)") : ""}
        <div class="stat-breakdown">${thisWeek ? `${thisWeek.totalMiles} mi this week` : "no data yet"}</div>
      </div>
      <div class="chart-card clickable" data-nav-tab="insights">
        <div class="stat-label">4-week training load</div>
        <div class="stat-value" style="color:${loadColor}">${fmtPctChange(load.pctChange)}</div>
        <div class="stat-breakdown">${load.last28DaysMiles ?? "--"} mi vs ${load.prior28DaysMiles ?? "--"} mi prior</div>
      </div>
      <div class="chart-card${dsl ? " clickable" : ""}" ${dsl ? `data-nav-run="${dsl.runId}"` : ""}>
        <div class="stat-label">Days since longest run</div>
        <div class="stat-value">${dsl ? dsl.days : "--"}</div>
        <div class="stat-breakdown">${dsl ? `${dsl.distanceMi} mi on ${dsl.date}` : "no data yet"}</div>
      </div>
      <div class="chart-card clickable" data-nav-tab="insights">
        <div class="stat-label">Pace trend (~30d)</div>
        <div class="stat-value" style="color:${paceColor}">${paceLabel}</div>
        <div class="stat-breakdown">${paceNow != null ? `now ${paceStr(paceNow)}/mi` : "no data yet"}</div>
      </div>
      <div class="chart-card${pr.longestRun ? " clickable" : ""}" ${pr.longestRun ? `data-nav-run="${pr.longestRun.runId}"` : ""}>
        <div class="stat-label">Longest run</div>
        <div class="stat-value">${pr.longestRun ? pr.longestRun.value.toFixed(2) + " mi" : "--"}</div>
        <div class="stat-breakdown">${pr.longestRun ? pr.longestRun.date : ""}</div>
      </div>
      <div class="chart-card${pr.fastestPace ? " clickable" : ""}" ${pr.fastestPace ? `data-nav-run="${pr.fastestPace.runId}"` : ""}>
        <div class="stat-label">Fastest pace</div>
        <div class="stat-value">${pr.fastestPace ? paceStr(pr.fastestPace.value) + "/mi" : "--"}</div>
        <div class="stat-breakdown">${pr.fastestPace ? pr.fastestPace.date : ""}</div>
      </div>
      <div class="chart-card clickable" data-nav-tab="runs" data-nav-filter="month">
        <div class="stat-label">This month vs last</div>
        <div class="stat-value">${thisMonth ? thisMonth.totalMiles + " mi" : "--"}</div>
        ${thisMonth && lastMonth ? dashBar(monthPct, "var(--cold)") : ""}
        <div class="stat-breakdown">${lastMonth ? `${lastMonth.totalMiles} mi last month` : ""}</div>
      </div>
    </div>
  `;
}

function destroyChatCharts() { chatCharts.forEach((c) => c.destroy()); chatCharts = []; }

function chatBubble(msg, chartIdPrefix) {
  const toolTrace = msg.toolCalls && msg.toolCalls.length
    ? `<div class="chat-tool-trace">used: ${msg.toolCalls.map((t) => t.tool).join(", ")}</div>` : "";
  const chartsHtml = (msg.charts || []).map((c, i) =>
    chartCardHTML(escapeHtml(c.title || ""), "", `${chartIdPrefix}-chart-${i}`, 180)).join("");
  return `<div class="chat-msg ${msg.role}">${escapeHtml(msg.content)}${chartsHtml}${toolTrace}</div>`;
}

// Second, separate pass after the bubble's HTML is actually in the DOM — Chart.js
// needs a real mounted <canvas>, same two-step pattern renderInsightsTab already uses.
function mountChatCharts(msg, chartIdPrefix) {
  (msg.charts || []).forEach((c, i) => {
    const canvas = document.getElementById(`${chartIdPrefix}-chart-${i}`);
    if (!canvas || !Array.isArray(c.labels) || !Array.isArray(c.datasets)) return;
    chatCharts.push(new Chart(canvas, {
      type: c.chartType === "bar" ? "bar" : "line",
      data: {
        labels: c.labels,
        datasets: c.datasets.map((d) => ({ label: d.label, data: d.data, borderColor: "#4CC9F0", backgroundColor: "#4CC9F0" })),
      },
      options: { responsive: true, maintainAspectRatio: false },
    }));
  });
}

async function renderChatTab() {
  const el = document.getElementById("chat-tab");
  el.innerHTML = `
    <div id="chat-dashboard"><div class="empty-chart">Loading dashboard…</div></div>
    <div class="chat-header-row" style="display:flex;justify-content:space-between;align-items:center;margin-top:20px">
      <div class="chart-title">Chat</div>
      <button class="edit-link" id="chat-reset-btn">Clear conversation</button>
    </div>
    <div class="chat-thread" id="chat-thread"></div>
    <div id="chat-not-configured" class="empty-state" style="display:none;margin-top:14px">
      AI assistant isn't configured yet. Add <span class="mono">CLAUDE_CODE_OAUTH_TOKEN</span> (Claude Pro/Max
      subscription) or <span class="mono">ANTHROPIC_API_KEY</span> to your <span class="mono">.env</span> and
      restart the container to enable chat — see <span class="mono">.env.example</span> for setup steps.
    </div>
    <div class="chat-input-row" id="chat-input-row" style="display:none">
      <input type="text" id="chat-input" placeholder="Ask about your training…" />
      <button class="btn" id="chat-send-btn">Send</button>
    </div>
  `;

  const [dashboard, status, history] = await Promise.all([
    fetch("/api/dashboard/summary").then((r) => r.json()).catch(() => null),
    fetch("/api/chat/status").then((r) => r.json()).catch(() => ({ configured: false })),
    fetch("/api/chat/history").then((r) => r.json()).catch(() => []),
  ]);

  const chatDashboardEl = document.getElementById("chat-dashboard");
  chatDashboardEl.innerHTML = dashboard
    ? renderDashboardCards(dashboard)
    : `<div class="empty-chart">Couldn't load dashboard.</div>`;
  wireNavCards(chatDashboardEl);

  chatConfigured = status.configured;
  document.getElementById("chat-input-row").style.display = chatConfigured ? "flex" : "none";
  document.getElementById("chat-not-configured").style.display = chatConfigured ? "none" : "block";

  const thread = document.getElementById("chat-thread");
  destroyChatCharts();
  thread.innerHTML = history.map((m, i) => chatBubble(m, `hist-${i}`)).join("");
  history.forEach((m, i) => mountChatCharts(m, `hist-${i}`));
  thread.scrollTop = thread.scrollHeight;

  document.getElementById("chat-reset-btn").onclick = async () => {
    await fetch("/api/chat/reset", { method: "POST" });
    renderChatTab();
  };

  if (!chatConfigured) return;

  const input = document.getElementById("chat-input");
  const sendBtn = document.getElementById("chat-send-btn");

  const send = async () => {
    const text = input.value.trim();
    if (!text || chatSending) return;
    chatSending = true;
    input.value = "";
    input.disabled = true;
    sendBtn.disabled = true;
    thread.insertAdjacentHTML("beforeend", chatBubble({ role: "user", content: text }));
    const pendingId = "chat-pending-" + Date.now();
    thread.insertAdjacentHTML("beforeend", `<div class="chat-msg assistant" id="${pendingId}">Thinking…</div>`);
    thread.scrollTop = thread.scrollHeight;
    try {
      const res = await fetch("/api/chat/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const data = await res.json().catch(() => ({}));
      const pendingEl = document.getElementById(pendingId);
      if (!res.ok) {
        pendingEl.outerHTML = chatBubble({ role: "assistant", content: `Error: ${data.detail || "something went wrong"}` });
      } else {
        pendingEl.outerHTML = chatBubble({ role: "assistant", content: data.reply, toolCalls: data.toolCalls, charts: data.charts }, pendingId);
        mountChatCharts({ charts: data.charts }, pendingId);
      }
    } catch (e) {
      const pendingEl = document.getElementById(pendingId);
      if (pendingEl) pendingEl.outerHTML = chatBubble({ role: "assistant", content: "Network error — try again." });
    }
    thread.scrollTop = thread.scrollHeight;
    input.disabled = false;
    sendBtn.disabled = false;
    chatSending = false;
    input.focus();
  };
  sendBtn.onclick = send;
  input.onkeydown = (e) => { if (e.key === "Enter") send(); };
}

// ---------- Init ----------
loadRuns();
loadGoals().then(() => { renderRaceCountdown(); if (currentTab === "home" || currentTab === "goals") dispatchCurrentTab(); });
loadRestingHR();
checkStravaStatus();
updateFilterBar();
