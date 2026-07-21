import { useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { mergeDuplicateRuns } from "@/lib/runs"

// The full /api/runs payload (several MB — see CLAUDE.md) merged client-side, same
// as the legacy app's loadRuns(). Slow to resolve on first load, which is why Home
// (0.3) treats /api/dashboard/summary's headerStats as a fast-paint fallback until
// this query settles — see HomePage.tsx. Phase 0.5 replaces the unbounded fetch with
// a windowed one; this hook's shape (merged Run[]) stays the same either way.
export function useRuns() {
  return useQuery({
    queryKey: ["runs"],
    queryFn: api.runs,
    select: mergeDuplicateRuns,
    staleTime: 5 * 60_000,
  })
}
