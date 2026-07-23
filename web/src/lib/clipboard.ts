// navigator.clipboard requires a secure context (HTTPS or localhost) — unavailable
// entirely (not just permission-denied, the property itself is undefined) on HALE's
// typical real deployment, a plain http:// LAN address (see .RUNBOOK.md). Falls back
// to the classic hidden-textarea + execCommand("copy") technique, which has no such
// restriction, so this works on both a real self-hosted instance and any future
// HTTPS-fronted one.
export async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // fall through to the legacy path below
    }
  }
  const textarea = document.createElement("textarea")
  textarea.value = text
  textarea.style.position = "fixed"
  textarea.style.opacity = "0"
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  let ok = false
  try {
    ok = document.execCommand("copy")
  } catch {
    ok = false
  }
  document.body.removeChild(textarea)
  return ok
}
