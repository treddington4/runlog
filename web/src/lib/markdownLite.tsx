import type { ReactNode } from "react"

// Deliberately not a full markdown library — the only markdown this app ever
// generates is Phase 12.5's coach-feedback draft (see coach/self_review.py's system
// prompt and assistant.py's log_product_feedback), which only ever uses a narrow,
// predictable subset: ##/### headings, **bold**, "- " bullets, "> " blockquote
// quotes, and "---" section breaks. A full markdown parser (react-markdown +
// remark-gfm) would be a much heavier dependency than that subset warrants.

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={`${keyPrefix}-${i}`}>{part.slice(2, -2)}</strong>
    }
    return <span key={`${keyPrefix}-${i}`}>{part}</span>
  })
}

export function renderMarkdownLite(text: string): ReactNode {
  const lines = text.split("\n")
  const blocks: ReactNode[] = []
  let listItems: string[] = []

  function flushList(key: string) {
    if (listItems.length === 0) return
    blocks.push(
      <ul key={key} className="list-disc space-y-1 py-1 pl-5">
        {listItems.map((item, i) => (
          <li key={i}>{renderInline(item, `${key}-li-${i}`)}</li>
        ))}
      </ul>,
    )
    listItems = []
  }

  lines.forEach((line, i) => {
    const trimmed = line.trim()
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      listItems.push(trimmed.slice(2))
      return
    }
    flushList(`list-${i}`)

    if (trimmed === "---") {
      blocks.push(<hr key={i} className="border-border my-3" />)
    } else if (trimmed.startsWith("### ")) {
      blocks.push(
        <h4 key={i} className="mt-3 mb-1 text-sm font-semibold">
          {renderInline(trimmed.slice(4), `h4-${i}`)}
        </h4>,
      )
    } else if (trimmed.startsWith("## ")) {
      blocks.push(
        <h3 key={i} className="mt-3 mb-1 text-base font-bold">
          {renderInline(trimmed.slice(3), `h3-${i}`)}
        </h3>,
      )
    } else if (trimmed.startsWith("> ")) {
      blocks.push(
        <blockquote key={i} className="border-hale-faint text-muted-foreground my-1 border-l-2 pl-3 italic">
          {renderInline(trimmed.slice(2), `bq-${i}`)}
        </blockquote>,
      )
    } else if (trimmed === "") {
      blocks.push(<div key={i} className="h-2" />)
    } else {
      blocks.push(<p key={i}>{renderInline(trimmed, `p-${i}`)}</p>)
    }
  })
  flushList("list-end")

  return <>{blocks}</>
}
