import { useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"

export function useSteps(days = 30) {
  return useQuery({ queryKey: ["steps", days], queryFn: () => api.steps(days) })
}
