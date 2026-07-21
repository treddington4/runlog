import { useEffect, useState } from "react"
import { api, type DashboardSummary } from "@/lib/api"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"

export default function App() {
  const [summary, setSummary] = useState<DashboardSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = () => {
    setLoading(true)
    setError(null)
    api
      .dashboardSummary()
      .then(setSummary)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 p-8">
      <h1 className="font-mono text-3xl font-bold tracking-tight">
        HAL<span className="text-primary">E</span>
      </h1>
      <p className="text-muted-foreground text-sm tracking-wide italic">
        HALE's Adaptive Life Engine
      </p>

      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Phase 0.1 scaffold check</CardTitle>
        </CardHeader>
        <CardContent>
          {error && <div className="text-destructive">{error}</div>}
          {!error && loading && <div className="text-muted-foreground">Loading live API data…</div>}
          {summary && (
            <pre className="tabular-nums font-mono text-xs whitespace-pre-wrap">
              {JSON.stringify(summary.headerStats, null, 2)}
            </pre>
          )}
        </CardContent>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          Refetch
        </Button>
      </Card>
    </div>
  )
}
