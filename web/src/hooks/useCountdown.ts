import { useCallback, useEffect, useRef, useState } from "react"

export type CountdownPhase = "idle" | "running" | "paused" | "done"

// This app's first use of a live client-side timer (no setInterval exists anywhere
// else in web/src). One instance is reused across the workout runner's several
// sequential countdowns (get-ready, hold, rest) — start() takes its own duration
// and completion callback each time, rather than fixing both at hook-construction
// time, since each phase needs a different one.
export function useCountdown() {
  const [remaining, setRemaining] = useState(0)
  const [phase, setPhase] = useState<CountdownPhase>("idle")
  const intervalRef = useRef<number | null>(null)
  const onCompleteRef = useRef<(() => void) | undefined>(undefined)

  const clearTimer = useCallback(() => {
    if (intervalRef.current != null) {
      window.clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }, [])

  const tick = useCallback(() => {
    setRemaining((r) => {
      if (r <= 1) {
        clearTimer()
        setPhase("done")
        onCompleteRef.current?.()
        return 0
      }
      return r - 1
    })
  }, [clearTimer])

  const start = useCallback(
    (seconds: number, onComplete?: () => void) => {
      clearTimer()
      onCompleteRef.current = onComplete
      setRemaining(seconds)
      setPhase("running")
      intervalRef.current = window.setInterval(tick, 1000)
    },
    [clearTimer, tick],
  )

  const pause = useCallback(() => {
    clearTimer()
    setPhase((p) => (p === "running" ? "paused" : p))
  }, [clearTimer])

  const resume = useCallback(() => {
    setPhase((p) => {
      if (p !== "paused") return p
      intervalRef.current = window.setInterval(tick, 1000)
      return "running"
    })
  }, [tick])

  const skip = useCallback(() => {
    clearTimer()
    setRemaining(0)
    setPhase("done")
    onCompleteRef.current?.()
  }, [clearTimer])

  useEffect(() => clearTimer, [clearTimer])

  return { remaining, phase, start, pause, resume, skip }
}
