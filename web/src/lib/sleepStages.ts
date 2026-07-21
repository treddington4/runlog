// Sleep-hypnogram helpers, ported 1:1 from app.js. The `/api/wellness/sleep-stages`
// endpoint returns naive-UTC timestamp strings (no offset suffix), and the stage
// timeline is always displayed in US Eastern regardless of the viewer's actual
// locale — a hardcoded legacy display convention, not locale-detection.
export const SLEEP_STAGE_ROWS = ["Awake", "REM", "Light", "Deep"]

export const SLEEP_STAGE_KEY_TO_ROW: Record<string, string> = {
  awake: "Awake",
  rem: "REM",
  light: "Light",
  deep: "Deep",
}

export const SLEEP_STAGE_COLORS: Record<string, string> = {
  Awake: "rgb(255,107,53)",
  REM: "#5FD68A",
  Light: "rgb(76,201,240)",
  Deep: "#2C3E91",
}

const SLEEP_CHART_TIMEZONE = "America/New_York"

export function parseUtcTimestamp(s: string): number {
  return new Date(/[Zz]|[+-]\d\d:?\d\d$/.test(s) ? s : s + "Z").getTime()
}

export function fmtEstClock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: SLEEP_CHART_TIMEZONE,
  })
}

function estMinute(epochMs: number): string {
  return new Intl.DateTimeFormat("en-US", { minute: "numeric", timeZone: SLEEP_CHART_TIMEZONE }).format(
    new Date(epochMs),
  )
}

export function estHourTicks(minMs: number, maxMs: number): number[] {
  const ticks: number[] = []
  let t = Math.floor(minMs / 60000) * 60000
  while (t <= maxMs) {
    if (estMinute(t) === "0") ticks.push(t)
    t += 60000
  }
  return ticks
}
