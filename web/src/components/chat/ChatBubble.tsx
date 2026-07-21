import { cn } from "@/lib/utils"
import { renderMarkdown } from "@/lib/chatMarkdown"
import { ChatChart } from "@/components/chat/ChatChart"
import type { ChatMessage } from "@/lib/api"

// A message currently in flight — rendered as an optimistic bubble before the
// real response (or error) comes back and replaces it in the query cache.
export type DisplayMessage = ChatMessage | { role: "assistant"; content: string; pending: true }

export function ChatBubble({ msg }: { msg: DisplayMessage }) {
  const isPending = "pending" in msg && msg.pending
  const toolCalls = "toolCalls" in msg ? msg.toolCalls : null
  const charts = "charts" in msg ? msg.charts : null

  return (
    <div
      className={cn(
        "max-w-[80%] rounded-lg border px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap",
        msg.role === "user"
          ? "border-border bg-secondary self-end"
          : "border-border bg-card self-start",
      )}
    >
      {isPending ? (
        msg.content
      ) : msg.role === "assistant" ? (
        <div
          className="chat-markdown whitespace-normal"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
        />
      ) : (
        // Plain JSX text child — React already escapes this when rendering to
        // the DOM, unlike the markdown branch above which builds raw HTML
        // itself and needs its own escaping (see lib/chatMarkdown.ts).
        msg.content
      )}

      {charts?.map((c, i) => <ChatChart key={i} spec={c} />)}

      {toolCalls && toolCalls.length > 0 && (
        <div className="text-hale-faint mt-1.5 font-mono text-[10px]">
          used: {toolCalls.map((t) => t.tool).join(", ")}
        </div>
      )}
    </div>
  )
}
