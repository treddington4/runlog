import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import 'leaflet/dist/leaflet.css'
import './index.css'
import App from './App.tsx'
import { applyChartTheme } from '@/lib/chartTheme'

// Applied once, process-wide, before any chart (Insights or Chat's inline
// charts) ever mounts — see lib/chartTheme.ts for why this matters.
applyChartTheme()

// registerType: 'autoUpdate' (vite.config.ts) means a new SW activates and takes over
// automatically on next load — no "update available" prompt needed for a single-user
// self-hosted app like this one.
registerSW({ immediate: true })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
