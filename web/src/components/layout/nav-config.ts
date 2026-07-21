import {
  Home,
  Target,
  Activity,
  LineChart,
  Map,
  MessageCircle,
  Dumbbell,
  Settings,
  type LucideIcon,
} from "lucide-react"

export interface NavItem {
  path: string
  label: string
  icon: LucideIcon
}

// Order matches the legacy app's nav-bar (app/static/index.html) — Home,
// Goals, Activities, Insights, Map, Chat, Workouts, Settings — so muscle
// memory carries over during the tab-by-tab Phase 0 port.
export const NAV_ITEMS: NavItem[] = [
  { path: "/", label: "Home", icon: Home },
  { path: "/goals", label: "Goals", icon: Target },
  { path: "/activities", label: "Activities", icon: Activity },
  { path: "/insights", label: "Insights", icon: LineChart },
  { path: "/map", label: "Map", icon: Map },
  { path: "/chat", label: "Chat", icon: MessageCircle },
  { path: "/workouts", label: "Workouts", icon: Dumbbell },
  { path: "/settings", label: "Settings", icon: Settings },
]
