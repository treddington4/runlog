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
// section). No polling — checked on Settings mount, refreshed after a clear.
export function useCoachIssue() {
  return useQuery({ queryKey: ["coachIssue"], queryFn: api.coachIssue })
}

export function useClearCoachIssue() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.clearCoachIssue(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["coachIssue"] }),
  })
}
