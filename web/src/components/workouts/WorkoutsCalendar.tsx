import { useMemo, useState } from "react"
import { Footprints, Bike, Dumbbell, HeartPulse, ChevronLeft, ChevronRight } from "lucide-react"
import type { Workout, RecoverySession } from "@/lib/api"
import { WORKOUT_STATUS_COLORS } from "@/lib/workouts"
import { todayLocalDateString } from "@/lib/format"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"

type Item = ({ _kind: "workout" } & Workout) | ({ _kind: "recovery" } & RecoverySession)

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

function iconForItem(item: Item) {
  if (item._kind === "recovery") return HeartPulse
  if (item.workoutType === "strength") return Dumbbell
  if (item.activityType === "Ride") return Bike
  return Footprints
}

function monthLabel(year: number, month: number): string {
  return new Date(year, month, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" })
}

function dateStr(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

export function WorkoutsCalendar({
  items,
  renderItem,
}: {
  items: Item[]
  renderItem: (item: Item) => React.ReactNode
}) {
  const today = todayLocalDateString()
  const [cursor, setCursor] = useState(() => {
    const [y, m] = today.split("-").map(Number)
    return { year: y, month: m - 1 }
  })
  const [selectedDate, setSelectedDate] = useState(today)

  const itemsByDate = useMemo(() => {
    const map = new Map<string, Item[]>()
    for (const item of items) {
      const list = map.get(item.scheduledDate) ?? []
      list.push(item)
      map.set(item.scheduledDate, list)
    }
    return map
  }, [items])

  const { year, month } = cursor
  const firstOfMonth = new Date(year, month, 1)
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const leadingBlanks = firstOfMonth.getDay()

  const cells: (number | null)[] = [
    ...Array(leadingBlanks).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ]

  const selectedItems = itemsByDate.get(selectedDate) ?? []

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="icon" onClick={() => setCursor(({ year, month }) => {
          const d = new Date(year, month - 1, 1)
          return { year: d.getFullYear(), month: d.getMonth() }
        })}>
          <ChevronLeft className="size-4" />
        </Button>
        <h3 className="text-sm font-semibold">{monthLabel(year, month)}</h3>
        <Button variant="ghost" size="icon" onClick={() => setCursor(({ year, month }) => {
          const d = new Date(year, month + 1, 1)
          return { year: d.getFullYear(), month: d.getMonth() }
        })}>
          <ChevronRight className="size-4" />
        </Button>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center">
        {WEEKDAY_LABELS.map((d) => (
          <div key={d} className="text-muted-foreground text-[11px] font-medium">
            {d}
          </div>
        ))}
        {cells.map((day, i) => {
          if (day == null) return <div key={`blank-${i}`} />
          const ds = dateStr(year, month, day)
          const dayItems = itemsByDate.get(ds) ?? []
          const isToday = ds === today
          const isSelected = ds === selectedDate
          return (
            <button
              key={ds}
              type="button"
              onClick={() => setSelectedDate(ds)}
              className={`flex min-h-14 flex-col items-center gap-0.5 rounded-md border p-1 transition-colors ${
                isSelected ? "border-primary bg-accent" : "border-transparent hover:bg-accent/50"
              }`}
            >
              <span className={`text-xs ${isToday ? "text-primary font-semibold" : ""}`}>{day}</span>
              <div className="flex flex-wrap justify-center gap-0.5">
                {dayItems.slice(0, 4).map((item) => {
                  const Icon = iconForItem(item)
                  return (
                    <Icon
                      key={item.id}
                      className="size-3"
                      style={{ color: WORKOUT_STATUS_COLORS[item.status] }}
                    />
                  )
                })}
              </div>
            </button>
          )
        })}
      </div>

      <div>
        <h4 className="mb-2 text-sm font-semibold">{selectedDate}</h4>
        {selectedItems.length ? (
          <div className="flex flex-col gap-3">{selectedItems.map(renderItem)}</div>
        ) : (
          <EmptyState icon={Dumbbell} title="Nothing this day" message="Use Quick Generate or add one manually." />
        )}
      </div>
    </div>
  )
}
