// Legacy app.js badges built alpha variants by string-concatenating a hex suffix
// onto the color (`${color}55`) — silently broken for the TYPE_COLORS entries
// that are `rgb(...)` rather than hex (produces invalid CSS, so those badges
// rendered with no border/background tint). Parses either form properly instead.
export function withAlpha(color: string, alpha: number): string {
  const hexMatch = /^#([0-9a-f]{6})$/i.exec(color)
  if (hexMatch) {
    const int = parseInt(hexMatch[1], 16)
    const r = (int >> 16) & 255
    const g = (int >> 8) & 255
    const b = int & 255
    return `rgba(${r},${g},${b},${alpha})`
  }
  const rgbMatch = /^rgb\(([\d.]+),\s*([\d.]+),\s*([\d.]+)\)$/i.exec(color)
  if (rgbMatch) {
    return `rgba(${rgbMatch[1]},${rgbMatch[2]},${rgbMatch[3]},${alpha})`
  }
  return color
}
