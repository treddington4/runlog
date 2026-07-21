import { useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"

// Shared across the Shell's RaceCountdown chip and the Home tab's Goals section —
// TanStack Query dedupes the underlying fetch, mirroring the legacy app's single
// global `goals` array (loaded once via loadGoals()) without hand-rolling a cache.
export function useGoals() {
  return useQuery({ queryKey: ["goals"], queryFn: api.goals })
}
