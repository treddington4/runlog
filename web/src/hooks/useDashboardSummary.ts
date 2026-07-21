import { useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"

export function useDashboardSummary() {
  return useQuery({ queryKey: ["dashboardSummary"], queryFn: api.dashboardSummary })
}
