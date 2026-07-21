import { useState } from "react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"

// Owns its own input state so typing never re-renders the parent ChatPage (and
// therefore never touches the message list or any mounted chart instances) —
// only this leaf re-renders per keystroke.
export function ChatInputBar({ sending, onSend }: { sending: boolean; onSend: (text: string) => void }) {
  const [value, setValue] = useState("")

  function submit() {
    const text = value.trim()
    if (!text || sending) return
    setValue("")
    onSend(text)
  }

  return (
    <div className="mt-3 flex gap-2">
      <Input
        placeholder="Ask about your training…"
        value={value}
        disabled={sending}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit()
        }}
      />
      <Button disabled={sending} onClick={submit}>
        Send
      </Button>
    </div>
  )
}
