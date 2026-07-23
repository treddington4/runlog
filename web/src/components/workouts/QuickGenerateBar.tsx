import { useState } from "react"
import { Footprints, Bike, Dumbbell, HeartPulse } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useQuickGenerate } from "@/hooks/useWorkouts"
import type { QuickGenerateDomain } from "@/lib/api"

// Phase 14 — matches STRENGTH_TEMPLATES' keys in app/coach/generator.py exactly.
// `null` means "no override" (let the backend auto-pick from recent cardio volume).
const STRENGTH_TEMPLATES: { key: string | null; label: string }[] = [
  { key: null, label: "Auto" },
  { key: "full_body_ab", label: "Full Body" },
  { key: "runner_focus", label: "Runner Focus" },
  { key: "back_and_legs", label: "Back & Legs" },
]

const BUTTONS: { domain: QuickGenerateDomain; label: string; icon: typeof Footprints }[] = [
  { domain: "run", label: "Run", icon: Footprints },
  { domain: "ride", label: "Ride", icon: Bike },
  { domain: "strength", label: "Strength", icon: Dumbbell },
  { domain: "recovery", label: "Recovery", icon: HeartPulse },
]

export function QuickGenerateBar() {
  const quickGenerate = useQuickGenerate()
  const [strengthTemplate, setStrengthTemplate] = useState<string | null>(null)
  const [showStrengthPicker, setShowStrengthPicker] = useState(false)

  const pending = quickGenerate.isPending ? quickGenerate.variables?.domain : null

  function press(domain: QuickGenerateDomain, templateOverride?: string) {
    quickGenerate.mutate({ domain, templateOverride: templateOverride ?? undefined })
    if (domain === "strength") setShowStrengthPicker(true)
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {BUTTONS.map(({ domain, label, icon: Icon }) => (
          <Button
            key={domain}
            variant="outline"
            className="h-auto flex-col gap-1 px-4 py-3"
            disabled={quickGenerate.isPending}
            onClick={() => press(domain, domain === "strength" ? (strengthTemplate ?? undefined) : undefined)}
          >
            <Icon className="size-5" />
            <span className="text-xs">{pending === domain ? "Generating…" : label}</span>
          </Button>
        ))}
      </div>

      {/* Shown once Strength has been pressed at least once this session — lets the
          user override the auto-picked template without re-discovering the button. */}
      {showStrengthPicker && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground text-xs">Target:</span>
          {STRENGTH_TEMPLATES.map(({ key, label }) => (
            <button
              key={label}
              type="button"
              disabled={quickGenerate.isPending}
              onClick={() => {
                setStrengthTemplate(key)
                press("strength", key ?? undefined)
              }}
              className={`rounded-full border px-2.5 py-1 text-xs transition-colors disabled:opacity-50 ${
                strengthTemplate === key
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-input bg-transparent hover:bg-accent"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {quickGenerate.isError && (
        <p className="text-hale-hot text-xs">Couldn't generate that — try again.</p>
      )}
    </div>
  )
}
