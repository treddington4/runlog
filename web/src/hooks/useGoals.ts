import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api, type GoalInput, type GoalStatus } from "@/lib/api"

// Shared across the Shell's RaceCountdown chip and the Home tab's Goals section —
// TanStack Query dedupes the underlying fetch, mirroring the legacy app's single
// global `goals` array (loaded once via loadGoals()) without hand-rolling a cache.
export function useGoals() {
  return useQuery({ queryKey: ["goals"], queryFn: api.goals })
}

// One shared invalidation point for every Goals-tab write — the same ["goals"]
// query key backs the Shell's race countdown and Home's goals section too, so
// a single invalidation keeps all three in sync (mirrors legacy's loadGoals()
// + renderRaceCountdown() + renderGoalsTab()/renderHomeTab() re-render trio).
export function useGoalMutations() {
  const qc = useQueryClient()
  const invalidate = () => qc.invalidateQueries({ queryKey: ["goals"] })

  const createGoal = useMutation({
    mutationFn: (body: GoalInput) => api.createGoal(body),
    onSuccess: invalidate,
  })
  const updateGoal = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<GoalInput> & { status?: GoalStatus } }) =>
      api.updateGoal(id, body),
    onSuccess: invalidate,
  })
  const deleteGoal = useMutation({
    mutationFn: (id: string) => api.deleteGoal(id),
    onSuccess: invalidate,
  })

  return { createGoal, updateGoal, deleteGoal }
}
