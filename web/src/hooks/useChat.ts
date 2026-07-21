import { useQuery } from "@tanstack/react-query"
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
