import { useEffect } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { useConfig } from "@/hooks/useSettings"

// Phase 12.2 — real date/timezone confusion in production chat logs traced partly to
// APP_TIMEZONE being a single global env var rather than tied to where the user
// actually is. Auto-detects the browser's IANA timezone (reliable in every modern
// browser, no manual Settings field needed) and PATCHes it up once per mismatch —
// not on every render, and not proactively polled, just reconciled on app load.
export function useTimezoneSync() {
  const { data: config } = useConfig()
  const qc = useQueryClient()

  useEffect(() => {
    if (!config) return
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (!browserTz || browserTz === config.timezone) return
    api.updateConfig({ timezone: browserTz }).then(() => {
      qc.invalidateQueries({ queryKey: ["config"] })
    })
    // Intentionally re-runs only when the fetched config's timezone value itself
    // changes (including right after the PATCH above invalidates it) — not a
    // continuous poll, just re-checked whenever the stored value could be stale.
  }, [config, qc])
}
