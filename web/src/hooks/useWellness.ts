import { useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"

export function useWellness(days = 30) {
  return useQuery({ queryKey: ["wellness", days], queryFn: () => api.wellness(days) })
}
