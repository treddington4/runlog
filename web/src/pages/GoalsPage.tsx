import { useState } from "react"
import { Target } from "lucide-react"
import type { Goal } from "@/lib/api"
import { useGoals, useGoalMutations } from "@/hooks/useGoals"
import { GoalCard } from "@/components/home/GoalCard"
import { GoalFormDialog } from "@/components/goals/GoalFormDialog"
import { CardGrid } from "@/components/home/ChartCard"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { Skeleton } from "@/components/ui/skeleton"

export function GoalsPage() {
  const { data: goals } = useGoals()
  const { createGoal, updateGoal, deleteGoal } = useGoalMutations()

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingGoal, setEditingGoal] = useState<Goal | null>(null)

  if (!goals) return <Skeleton className="h-64 w-full" />

  const active = goals.filter((g) => g.status === "active")
  const completed = goals.filter((g) => g.status === "completed")
  const abandoned = goals.filter((g) => g.status === "abandoned")

  function openNew() {
    setEditingGoal(null)
    setDialogOpen(true)
  }

  function renderCards(list: Goal[]) {
    return (
      <CardGrid>
        {list.map((g) => (
          <GoalCard
            key={g.id}
            goal={g}
            onEdit={() => {
              setEditingGoal(g)
              setDialogOpen(true)
            }}
            onComplete={() => updateGoal.mutate({ id: g.id, body: { status: "completed" } })}
            onAbandon={() => updateGoal.mutate({ id: g.id, body: { status: "abandoned" } })}
            onDelete={() => deleteGoal.mutate(g.id)}
          />
        ))}
      </CardGrid>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Button onClick={openNew}>+ New Goal</Button>
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold">Active</h2>
        {active.length ? renderCards(active) : <EmptyState icon={Target} title="No goals here yet" />}
      </div>

      {completed.length > 0 && (
        <div>
          <h2 className="mb-3 text-sm font-semibold">Completed</h2>
          {renderCards(completed)}
        </div>
      )}

      {abandoned.length > 0 && (
        <div>
          <h2 className="mb-3 text-sm font-semibold">Abandoned</h2>
          {renderCards(abandoned)}
        </div>
      )}

      <GoalFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        goal={editingGoal}
        onSave={(body) => {
          if (editingGoal) updateGoal.mutate({ id: editingGoal.id, body })
          else createGoal.mutate(body)
        }}
      />
    </div>
  )
}
