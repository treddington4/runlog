// Minimal Markdown -> HTML for assistant chat replies (tables, lists, headings,
// bold/italic/code), ported 1:1 from app.js. Escapes text first, then only ever
// injects tags this function itself generates — never raw model output — so
// it's safe to render via dangerouslySetInnerHTML despite not being a real
// markdown library.
export function escapeHtml(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
}

function inlineMd(s: string): string {
  let out = escapeHtml(s)
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>")
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>")
  return out
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim())
}

export function renderMarkdown(text: string): string {
  const lines = String(text).split("\n")
  const blocks: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    if (line.trim() === "") {
      i++
      continue
    }

    // GFM table: header row followed by a |---|---| separator row
    if (
      /^\s*\|.*\|\s*$/.test(line) &&
      lines[i + 1] &&
      /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) &&
      lines[i + 1].includes("-")
    ) {
      const headerCells = splitTableRow(line)
      let j = i + 2
      const rows: string[][] = []
      while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) {
        rows.push(splitTableRow(lines[j]))
        j++
      }
      const thead = `<thead><tr>${headerCells.map((c) => `<th>${inlineMd(c)}</th>`).join("")}</tr></thead>`
      const tbody = `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inlineMd(c)}</td>`).join("")}</tr>`).join("")}</tbody>`
      blocks.push(`<table>${thead}${tbody}</table>`)
      i = j
      continue
    }

    // List (unordered or ordered) — consume consecutive matching lines as one list
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line)
      const items: string[] = []
      while (i < lines.length && (/^\s*[-*]\s+/.test(lines[i]) || /^\s*\d+\.\s+/.test(lines[i]))) {
        items.push(lines[i].replace(/^\s*(?:[-*]|\d+\.)\s+/, ""))
        i++
      }
      const tag = ordered ? "ol" : "ul"
      blocks.push(`<${tag}>${items.map((it) => `<li>${inlineMd(it)}</li>`).join("")}</${tag}>`)
      continue
    }

    // Heading
    const headingMatch = line.match(/^(#{1,4})\s+(.*)$/)
    if (headingMatch) {
      const level = Math.min(headingMatch[1].length + 3, 6) // keep small inside a chat bubble
      blocks.push(`<h${level}>${inlineMd(headingMatch[2])}</h${level}>`)
      i++
      continue
    }

    // Paragraph — consume consecutive plain lines until a blank line or another block type
    const paraLines = [line]
    i++
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^\s*\|.*\|\s*$/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^#{1,4}\s+/.test(lines[i])
    ) {
      paraLines.push(lines[i])
      i++
    }
    blocks.push(`<p>${paraLines.map(inlineMd).join("<br>")}</p>`)
  }
  return blocks.join("")
}
