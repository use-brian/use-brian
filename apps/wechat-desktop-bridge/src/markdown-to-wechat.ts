/**
 * Markdown → plain text the WeChat desktop client can show. The personal
 * client renders no markdown at all (unlike the iLink bot surface), so this is
 * a full flatten: bold / italic / headings / code markers stripped, list
 * bullets kept, links as `text (url)`, images as their alt text. Chunking at
 * WECHAT_MAX_CHARS keeps each send under the client's paste limit.
 */

const WECHAT_MAX_CHARS = 4000

export function markdownToWechat(text: string): string {
  let out = text.replace(/\r\n/g, '\n')

  // Fenced code blocks: drop the fences, keep the body verbatim.
  out = out.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, body: string) => body.replace(/\n$/, ''))
  out = out.replace(/```([^`]*)```/g, '$1')

  // Images → alt text (or nothing); links → text (url).
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, label: string, url: string) =>
    label.trim() === url.trim() ? url : `${label} (${url})`,
  )

  // Headings: strip the marker, keep the text.
  out = out.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')

  // Bold / italic / strikethrough markers.
  out = out.replace(/(\*\*\*|___)(?=\S)([\s\S]*?\S)\1/g, '$2')
  out = out.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
  out = out.replace(/(?<![*\w])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, '$1')
  out = out.replace(/(?<![_\w])_(?=\S)([^_\n]*?\S)_(?![_\w])/g, '$1')
  out = out.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')

  // Inline code.
  out = out.replace(/`([^`\n]+)`/g, '$1')

  // Blockquotes: drop the marker.
  out = out.replace(/^[ \t]*>[ \t]?/gm, '')

  // Lists: normalise `*`/`+` bullets to `-`, keep ordered lists as-is.
  out = out.replace(/^([ \t]*)[*+][ \t]+/gm, '$1- ')

  // Horizontal rules → blank line.
  out = out.replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '')

  // Collapse 3+ blank lines.
  out = out.replace(/\n{3,}/g, '\n\n')
  return out.trim()
}

/** Split on paragraph, then line, then hard boundaries so every chunk ≤ max. */
export function chunkText(text: string, max: number = WECHAT_MAX_CHARS): string[] {
  if (text.length <= max) return text.length ? [text] : []
  const chunks: string[] = []
  let rest = text
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max)
    if (cut < max / 2) cut = rest.lastIndexOf('\n', max)
    if (cut < max / 2) cut = rest.lastIndexOf(' ', max)
    if (cut < max / 2) cut = max
    chunks.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest.length) chunks.push(rest)
  return chunks
}
