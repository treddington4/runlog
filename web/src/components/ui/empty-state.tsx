import * as React from "react"
import type { LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  message?: string
  action?: React.ReactNode
  className?: string
}

function EmptyState({ icon: Icon, title, message, action, className }: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border py-16 text-center",
        className,
      )}
    >
      <Icon className="text-hale-faint size-8" strokeWidth={1.5} />
      <div className="mt-1 text-sm font-medium">{title}</div>
      {message && <div className="text-muted-foreground max-w-sm text-sm">{message}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export { EmptyState }
