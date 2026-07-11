const MARATHON_DATE = new Date("2026-11-08T00:00:00");
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
let expandedId = null;
let currentTab = "runs";
let charts = [];

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

// ---------- Data loading ----------
async function loadRuns() {
  const res = await fetch("/api/runs");
  runs = await res.json();
  render();
}

async function checkStravaStatus() {
  const res = await fetch("/api/strava/status");
  const { connected } = await res.json();
  document.getElementById("connect-btn").textContent = connected ? "Strava Connected" : "Connect Strava";
  document.getElementById("connect-btn").disabled = connected;
}

document.getElementById("connect-btn").onclick = () => { window.location.href = "/auth/strava/login"; };

document.getElementById("sync-btn").onclick = async () => {
  const btn = document.getElementById("sync-btn");
  const errEl = document.getElementById("sync-err");
  btn.textContent = "Syncing…"; btn.disabled = true; errEl.textContent = "";
  try {
    const res = await fetch("/api/sync/strava", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Sync failed");
    document.getElementById("sync-meta").textContent = `Last synced ${new Date().toLocaleString()}`;
    await loadRuns();
  } catch (e) {
    errEl.textContent = e.message;
  } finally {
    btn.textContent = "Sync from Strava"; btn.disabled = false;
  }
};

document.querySelectorAll(".tab").forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    currentTab = tab.dataset.tab;
    document.getElementById("runs-tab").style.display = currentTab === "runs" ? "block" : "none";
    document.getElementById("insights-tab").style.display = currentTab === "insights" ? "block" : "none";
    render();
  };
});

// ---------- Render ----------
function render() {
  const dtm = daysUntil(MARATHON_DATE);
  document.getElementById("race-countdown").textContent =
    dtm > 0 ? `${dtm} days to Manchester City Marathon` : "Race day!";

  const weekAgo = new Date(Date.now() - 7 * 86400000);
  const weekMi = runs.filter((r) => new Date(r.date) >= weekAgo).reduce((s, r) => s + (r.distanceMi || 0), 0);
  document.getElementById("stat-week").textContent = `${weekMi.toFixed(1)} mi`;

  const withPace = runs.filter((r) => r.avgPaceSecPerMi);
  const avgPace = withPace.length
    ? withPace.reduce((s, r) => s + r.avgPaceSecPerMi * r.distanceMi, 0) / withPace.reduce((s, r) => s + r.distanceMi, 0)
    : null;
  document.getElementById("stat-pace").textContent = avgPace ? `${paceStr(avgPace)}/mi` : "--";
  document.getElementById("stat-count").textContent = runs.length;

  document.getElementById("empty-state").style.display = runs.length === 0 ? "block" : "none";

  if (currentTab === "runs") renderRunsTab(); else renderInsightsTab();
}

function renderRunsTab() {
  const el = document.getElementById("runs-tab");
  el.innerHTML = "";
  runs.forEach((run) => {
    const card = document.createElement("div");
    card.className = "run-card";
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
            </div>
            <div class="run-date">${new Date(run.date + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}${run.startTime ? " · " + run.startTime : ""}</div>
          </div>
          <div>
            <div class="run-dist">${run.distanceMi?.toFixed(2)} mi</div>
            <div class="run-pace">${paceStr(run.avgPaceSecPerMi)}/mi</div>
          </div>
        </div>
        <div class="mini-stats">
          <div class="mini-stat">⏱ ${timeStr(run.movingTimeSec)}</div>
          ${run.avgHR ? `<div class="mini-stat">♥ ${run.avgHR}${run.maxHR ? " / " + run.maxHR : ""} bpm</div>` : ""}
          ${run.avgCadence != null ? `<div class="mini-stat">👣 ${Math.round(run.avgCadence)} spm</div>` : ""}
          ${run.elevGainFt != null ? `<div class="mini-stat">⛰ ${Math.round(run.elevGainFt)} ft</div>` : ""}
          ${run.elevGainFt != null && run.distanceMi ? `<div class="mini-stat" style="color:rgb(76,201,240)">⚡ GAP ${paceStr(gapSecPerMi(run.avgPaceSecPerMi, run.elevGainFt, run.distanceMi))}</div>` : ""}
          ${run.tempF != null ? `<div class="mini-stat" style="color:${tempColor(run.tempF)}">${run.tempF >= 75 ? "🔥" : "❄️"} ${Math.round(run.tempF)}°F${run.weatherCondition ? " · " + run.weatherCondition : ""}</div>` : ""}
          ${run.heatIndexF != null && Math.round(run.heatIndexF) !== Math.round(run.tempF) ? `<div class="mini-stat" style="color:${tempColor(run.heatIndexF)}">🥵 HI ${Math.round(run.heatIndexF)}°F</div>` : ""}
          ${run.wetBulbF != null ? `<div class="mini-stat">💧 WB ${Math.round(run.wetBulbF)}°F</div>` : ""}
          ${run.rpe != null ? `<div class="mini-stat">📊 RPE ${run.rpe}</div>` : ""}
        </div>
        <div class="card-footer">
          <button class="edit-link" data-edit="${run.id}">✎ edit</button>
          <span>${isOpen ? "▲" : "▼"}</span>
        </div>
      </div>
      <div class="expand-slot"></div>
    `;

    card.querySelector(".run-card-head").addEventListener("click", (e) => {
      if (e.target.closest("[data-edit]")) return;
      expandedId = isOpen ? null : run.id;
      render();
    });
    card.querySelector("[data-edit]").addEventListener("click", (e) => {
      e.stopPropagation();
      openEditModal(run);
    });

    if (isOpen) {
      const slot = card.querySelector(".expand-slot");
      if (type === "Interval" && run.intervals?.length > 0) {
        slot.appendChild(buildIntervalsTable(run.intervals));
      } else if (run.splits?.length > 0) {
        slot.appendChild(buildSplitsTable(run.splits));
      }
    }

    el.appendChild(card);
  });
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
      <span>${s.avgHR ?? "--"}</span>
      <span style="color:var(--muted)">${s.maxHR ?? "--"}</span>
      <span style="color:var(--muted)">${s.avgCadence != null ? Math.round(s.avgCadence) : "--"}</span>
      <span style="color:rgb(76,201,240)">${gap ? paceStr(gap) : "--"}</span>
    </div>`;
  });
  wrap.innerHTML = html;
  return wrap;
}

function buildIntervalsTable(intervals) {
  const wrap = document.createElement("div");
  wrap.className = "intervals-table";
  const workReps = intervals.filter((iv) => iv.segment === "work");
  let html = "";
  if (workReps.length) {
    const avgDur = Math.round(workReps.reduce((s, r) => s + (r.durationSec || 0), 0) / workReps.length);
    html += `<div style="font-size:11px;color:var(--faint);margin-bottom:8px">${workReps.length} work reps · avg ${avgDur}s each</div>`;
  }
  html += `<div class="interval-head"><span>Segment</span><span>Pace</span><span>Time</span><span>HR</span><span>Max</span><span>Cad</span></div>`;
  let workIdx = 0;
  intervals.forEach((iv) => {
    const style = SEGMENT_STYLE[iv.segment] || { label: iv.segment, color: "#8B93A1" };
    if (iv.segment === "work") workIdx++;
    html += `<div class="interval-row" style="border-left:2px solid ${style.color};background:${iv.segment === "work" ? style.color + "0F" : "transparent"}">
      <span style="color:${style.color};font-weight:${iv.segment === "work" ? 700 : 400}">${style.label}${iv.segment === "work" ? " " + workIdx : ""}</span>
      <span>${paceStr(iv.paceSecPerMi)}/mi</span>
      <span style="color:var(--muted)">${iv.durationSec ?? "--"}s</span>
      <span>${iv.avgHR ?? "--"}</span>
      <span style="color:var(--muted)">${iv.maxHR ?? "--"}</span>
      <span style="color:var(--muted)">${iv.avgCadence != null ? Math.round(iv.avgCadence) : "--"}</span>
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

function renderInsightsTab() {
  destroyCharts();
  const el = document.getElementById("insights-tab");

  const outdoor = runs.filter((r) => !r.isTreadmill && r.tempF != null);
  const perfData = [...runs].sort((a, b) => (a.date < b.date ? -1 : 1)).filter((r) => r.avgPaceSecPerMi);
  const cadPaceData = runs.filter((r) => r.avgCadence && r.avgPaceSecPerMi);

  const weekly = {};
  runs.forEach((r) => {
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
    ${chartCardHTML("Cadence vs. Pace", "Are you turning your legs over faster as pace increases, or overstriding?", "c-cadpace", 200)}
  `;

  Chart.defaults.color = "#8B93A1";
  Chart.defaults.borderColor = "#242B35";

  if (outdoor.length >= 2) {
    tempScatter("c-temp-hr", outdoor.map((r) => ({ x: r.tempF, y: r.avgHR })).filter((p) => p.y != null), "Avg HR", "rgb(255,107,53)", "bpm");
    tempScatter("c-temp-pace", outdoor.map((r) => ({ x: r.tempF, y: r.avgPaceSecPerMi })).filter((p) => p.y != null), "Pace", "#FFC857", "", (v) => paceStr(v) + "/mi", true);
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
          { label: "Avg HR", data: perfData.map((r) => r.avgHR || null), borderColor: "rgb(255,107,53)", backgroundColor: "rgb(255,107,53)", yAxisID: "bpm", tension: 0.3, spanGaps: true },
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

// ---------- Init ----------
loadRuns();
checkStravaStatus();
