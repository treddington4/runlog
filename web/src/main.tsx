import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'leaflet/dist/leaflet.css'
import './index.css'
import App from './App.tsx'
import { applyChartTheme } from '@/lib/chartTheme'

// Applied once, process-wide, before any chart (Insights or Chat's inline
// charts) ever mounts — see lib/chartTheme.ts for why this matters.
applyChartTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
