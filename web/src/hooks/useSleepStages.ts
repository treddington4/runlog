import { useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"

export function useSleepStages(date?: string) {
  return useQuery({ queryKey: ["sleepStages", date], queryFn: () => api.sleepStages(date) })
}
