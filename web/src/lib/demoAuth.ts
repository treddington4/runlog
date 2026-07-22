// Demo-session token storage (Phase 11). Plain localStorage — acceptable given this
// is a disposable, synthetic-data-only session with a short (default 2h) server-side
// TTL, not a real credential with lasting value.
const TOKEN_KEY = "hale_demo_token"
const EXPIRES_KEY = "hale_demo_expires_at"

export interface DemoSession {
  token: string
  expiresAt: string
}

export function getDemoSession(): DemoSession | null {
  const token = localStorage.getItem(TOKEN_KEY)
  const expiresAt = localStorage.getItem(EXPIRES_KEY)
  if (!token || !expiresAt) return null
  if (new Date(expiresAt).getTime() <= Date.now()) return null
  return { token, expiresAt }
}

export function setDemoSession(token: string, expiresAt: string) {
  localStorage.setItem(TOKEN_KEY, token)
  localStorage.setItem(EXPIRES_KEY, expiresAt)
}

export function clearDemoSession() {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(EXPIRES_KEY)
}
