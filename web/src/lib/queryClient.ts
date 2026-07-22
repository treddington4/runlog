import { QueryClient } from "@tanstack/react-query"

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      // Default (3 retries w/ backoff) means a 401 — never transient — gets retried
      // 3 futile times before settling, right as Phase 11's demo-session interceptor
      // is trying to redirect. Not incorrect, just wasteful; this app's own request
      // volume is low enough that a single real network blip retrying once more
      // isn't worth reintroducing selectively.
      retry: false,
    },
  },
})
