import { useCallback, useEffect, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"

// PushManager.subscribe's applicationServerKey wants a raw Uint8Array, but the VAPID
// public key travels over the wire as a URL-safe base64 string (see app/push.py).
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4)
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"))
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

const PUSH_SUPPORTED = typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window

/** Manages this browser's Web Push subscription — enabling/disabling notifications and
 * sending a real test push, independent of any feature (daily insight, generated
 * workout) that would eventually trigger one automatically. See Settings' PushSection. */
export function usePush() {
  const [subscribed, setSubscribed] = useState(false)
  const [checking, setChecking] = useState(true)

  const { data: vapid } = useQuery({ queryKey: ["pushVapidKey"], queryFn: api.pushVapidKey })

  useEffect(() => {
    if (!PUSH_SUPPORTED) {
      setChecking(false)
      return
    }
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setSubscribed(!!sub))
      .finally(() => setChecking(false))
  }, [])

  const enable = useMutation({
    mutationFn: async () => {
      if (!vapid?.publicKey) throw new Error("Push not configured on the server")
      const permission = await Notification.requestPermission()
      if (permission !== "granted") throw new Error("Notification permission denied")
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid.publicKey),
      })
      await api.pushSubscribe(sub.toJSON() as PushSubscriptionJSON)
      return sub
    },
    onSuccess: () => setSubscribed(true),
  })

  const disable = useMutation({
    mutationFn: async () => {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (sub) {
        await api.pushUnsubscribe(sub.endpoint)
        await sub.unsubscribe()
      }
    },
    onSuccess: () => setSubscribed(false),
  })

  const sendTest = useMutation({ mutationFn: api.pushTest })

  const toggle = useCallback(() => {
    if (subscribed) disable.mutate()
    else enable.mutate()
  }, [subscribed, disable, enable])

  return {
    supported: PUSH_SUPPORTED,
    configured: !!vapid?.configured,
    subscribed,
    checking,
    toggle,
    enable,
    disable,
    sendTest,
  }
}
