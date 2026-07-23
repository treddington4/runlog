import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"

export function useChatStatus() {
  return useQuery({ queryKey: ["chatStatus"], queryFn: api.chatStatus })
}

export function useChatHistory() {
  return useQuery({ queryKey: ["chatHistory"], queryFn: api.chatHistory })
}

export function useCoachPersonality() {
  return useQuery({ queryKey: ["coachPersonality"], queryFn: api.coachPersonality })
}

// Phase 12.5 — one rolling draft GitHub issue per user (see Settings' Coach Feedback
// section). No polling — checked on Settings mount, refreshed after a clear or an
// explicit on-demand refresh (see useRefreshCoachIssue).
export function useCoachIssue() {
  return useQuery({ queryKey: ["coachIssue"], queryFn: api.coachIssue })
}

// On-demand incremental re-check — fired when the user opens the Preview dialog, so
// anything said since the last scheduled/manual review is picked up before they read
// it. Writes straight into the query cache from the mutation response rather than a
// separate invalidate+refetch round trip, since refreshCoachIssue's response *is*
// the freshly updated draft already.
export function useRefreshCoachIssue() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.refreshCoachIssue(),
    onSuccess: (data) => qc.setQueryData(["coachIssue"], data),
  })
}

export function useClearCoachIssue() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.clearCoachIssue(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["coachIssue"] }),
  })
}
