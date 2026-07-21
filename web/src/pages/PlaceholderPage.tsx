import type { LucideIcon } from "lucide-react"
import { EmptyState } from "@/components/ui/empty-state"

// Every Phase 0 tab route starts as this placeholder and is replaced by its
// real port in the matching PLAN.md section (0.3 Home ... 0.9 Goals+Settings).
export function PlaceholderPage({
  icon,
  title,
  phase,
}: {
  icon: LucideIcon
  title: string
  phase: string
}) {
  return <EmptyState icon={icon} title={title} message={`Ported in ${phase}.`} />
}
