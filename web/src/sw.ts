/// <reference lib="webworker" />
import { precacheAndRoute } from "workbox-precaching"
import { registerRoute } from "workbox-routing"
import { NetworkFirst } from "workbox-strategies"

declare const self: ServiceWorkerGlobalScope

// App shell + hashed assets, injected at build time by vite-plugin-pwa (injectManifest).
precacheAndRoute(self.__WB_MANIFEST)

// API calls: try the network first (data should be fresh whenever online), fall back
// to the last successful response so the shell isn't just a blank error offline.
registerRoute(
  ({ url }) => url.pathname.startsWith("/api/"),
  new NetworkFirst({ cacheName: "hale-api", networkTimeoutSeconds: 8 }),
)

self.addEventListener("install", () => self.skipWaiting())
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()))

// Web push — payload shape matches app/push.py's send_push(): {title, body, url}.
self.addEventListener("push", (event) => {
  let data: { title?: string; body?: string; url?: string } = {}
  try {
    data = event.data?.json() ?? {}
  } catch {
    data = { body: event.data?.text() }
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "HALE", {
      body: data.body,
      icon: "/icons/pwa-192.png",
      badge: "/icons/pwa-192.png",
      data: { url: data.url || "/" },
    }),
  )
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const url = (event.notification.data as { url?: string } | undefined)?.url || "/"
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.navigate(url)
          return client.focus()
        }
      }
      return self.clients.openWindow(url)
    }),
  )
})
