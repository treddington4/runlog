import { useEffect, useRef, useState } from "react"
import L from "leaflet"
import { splitRouteAtGaps } from "@/lib/route"

// Ports initRunMiniMap() — a per-run expand-view map, one Leaflet instance per
// mounted card (unlike the shared Map tab in 0.7). Cleans up its own map
// instance on unmount/route-change instead of the legacy single-module-level
// `expandedMiniMap` variable, since React can have more than one of these
// mounted (or remounted) without a full-page single-map assumption.
export function MiniMap({ route }: { route: [number, number][] | null }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setError(null)
    const container = containerRef.current
    if (!container || !route || route.length < 2) return

    let map: L.Map | null = null
    let raf = 0
    try {
      map = L.map(container, { preferCanvas: true, zoomControl: false }).setView([40, -97], 4)
      L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        maxZoom: 19,
      }).addTo(map)
      const layer = L.featureGroup().addTo(map)
      splitRouteAtGaps(route).forEach((segment) => {
        L.polyline(segment, { color: "#FFC857", weight: 3, opacity: 0.85 }).addTo(layer!)
      })
      const m = map
      raf = requestAnimationFrame(() => {
        m.invalidateSize()
        const bounds = layer.getBounds()
        if (bounds.isValid()) m.fitBounds(bounds, { padding: [16, 16] })
      })
    } catch (e) {
      console.error("Run mini-map failed to initialize:", e)
      setError(e instanceof Error ? e.message : String(e))
    }

    return () => {
      cancelAnimationFrame(raf)
      map?.remove()
    }
  }, [route])

  if (!route || route.length < 2) {
    return (
      <div className="text-hale-faint flex h-48 items-center justify-center rounded-md p-2 text-center text-xs">
        No GPS route data for this run.
      </div>
    )
  }

  if (error) {
    return (
      <div className="text-hale-hot flex h-48 items-center justify-center rounded-md p-2 text-center text-xs">
        Map error: {error}
      </div>
    )
  }

  return <div ref={containerRef} className="h-48 w-full overflow-hidden rounded-md" />
}
