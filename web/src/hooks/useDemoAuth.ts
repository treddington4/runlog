import { useMutation, useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { setDemoSession, clearDemoSession } from "@/lib/demoAuth"

export function useDemoStatus() {
  return useQuery({ queryKey: ["demoStatus"], queryFn: api.demoStatus })
}

export function useDemoLogin() {
  return useMutation({
    mutationFn: api.demoLogin,
    onSuccess: (data) => setDemoSession(data.token, data.expiresAt),
  })
}

export function useDemoLogout() {
  return useMutation({
    mutationFn: api.demoLogout,
    onSuccess: () => {
      clearDemoSession()
      window.location.href = "/demo-login"
    },
  })
}
