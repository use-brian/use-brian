/**
 * Normalize bullet characters so react-markdown can render them as a list.
 * The model sometimes emits literal "•" (U+2022) with single-newline
 * separators, which CommonMark treats as inline text and collapses into one
 * paragraph. We rewrite those to "-" markers on their own lines.
 *
 * Originally lived at apps/web/src/lib/normalize-markdown.ts. Source of
 * truth now lives here; the apps/web copy will be replaced with a re-export
 * shim when this package is consumed there.
 */
export function normalizeBullets(text: string): string {
  if (!text.includes('\u2022')) return text
  const lines = text.split('\n')
  let inFence = false
  const out: string[] = []
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    const leading = line.replace(/^(\s*)\u2022\s+/, '$1- ')
    if (!leading.includes(' \u2022 ')) {
      out.push(leading)
      continue
    }
    const segments = leading.split(' \u2022 ')
    out.push(segments[0])
    for (let i = 1; i < segments.length; i++) {
      out.push('- ' + segments[i])
    }
  }
  return out.join('\n')
}
