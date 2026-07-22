import { useNavigate } from "react-router-dom"
import { useDemoLogin } from "@/hooks/useDemoAuth"
import { Button } from "@/components/ui/button"
import { ApiError } from "@/lib/api"

export function DemoLoginPage() {
  const navigate = useNavigate()
  const login = useDemoLogin()

  function handleTryDemo() {
    login.mutate(undefined, {
      onSuccess: () => navigate("/", { replace: true }),
    })
  }

  const capacityFull = login.error instanceof ApiError && login.error.status === 429

  return (
    <div className="mx-auto flex min-h-svh max-w-md flex-col justify-center gap-6 px-4 py-8 text-center">
      <div>
        <h1 className="font-mono text-xl font-bold tracking-tight">
          HAL<span className="text-primary">E</span>
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">HALE's Adaptive Life Engine</p>
      </div>

      <p className="text-muted-foreground text-sm">
        This is a live demo — you'll get a throwaway account pre-populated with realistic sample data. Nothing you
        do here is saved beyond your session, and no real Strava, Garmin, or AI credits are ever touched.
      </p>

      <Button disabled={login.isPending} onClick={handleTryDemo}>
        {login.isPending ? "Setting up your demo…" : "Try the Demo"}
      </Button>

      {login.isError && (
        <div className="text-hale-hot text-xs">
          {capacityFull ? "Demo is at capacity — try again in a few minutes." : "Something went wrong — try again."}
        </div>
      )}
    </div>
  )
}
