import { BrowserRouter, Routes, Route } from "react-router-dom"
import { Home, Target, Activity, LineChart, Map, MessageCircle, Dumbbell, Settings } from "lucide-react"
import { Shell } from "@/components/layout/Shell"
import { PlaceholderPage } from "@/pages/PlaceholderPage"

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Shell />}>
          <Route path="/" element={<PlaceholderPage icon={Home} title="Home" phase="Phase 0.3" />} />
          <Route path="/goals" element={<PlaceholderPage icon={Target} title="Goals" phase="Phase 0.9" />} />
          <Route
            path="/activities"
            element={<PlaceholderPage icon={Activity} title="Activities" phase="Phase 0.5" />}
          />
          <Route
            path="/insights"
            element={<PlaceholderPage icon={LineChart} title="Insights" phase="Phase 0.6" />}
          />
          <Route path="/map" element={<PlaceholderPage icon={Map} title="Map" phase="Phase 0.7" />} />
          <Route
            path="/chat"
            element={<PlaceholderPage icon={MessageCircle} title="Chat" phase="Phase 0.8" />}
          />
          <Route
            path="/workouts"
            element={<PlaceholderPage icon={Dumbbell} title="Workouts" phase="Phase 0.4" />}
          />
          <Route
            path="/settings"
            element={<PlaceholderPage icon={Settings} title="Settings" phase="Phase 0.9" />}
          />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
