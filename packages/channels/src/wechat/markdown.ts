/**
 * Markdown → WeChat text.
 *
 * The iLink bot chat surface renders a GFM subset natively (bold, tables,
 * fenced/inline code, H1-H4, lists, links), so this is a light touch like
 * `markdownToDiscord`, fixing only what WeChat renders wrong — behavior
 * mirrored from the official plugin's StreamingMarkdownFilter:
 *
 * - Images (`![alt](url)`) are removed entirely (no inline rendering).
 * - H5/H6 heading markers are stripped (content kept).
 * - Italic / bold-italic markers wrapping CJK content are stripped — WeChat
 *   shows the raw `*` around CJK instead of italicizing. Bold (`**`) and
 *   italics around Latin text pass through.
 *
 * Fenced code blocks are protected first so `#`, `*`, and `![` inside code
 * are never rewritten. Component tag: [COMP:channels/wechat-adapter].
 */

const CJK_RE = /[　-鿿豈-﫿＀-￯]/

export function markdownToWechat(text: string): string {
  // Protect fenced code blocks from all rewriting.
  const fences: string[] = []
  let out = text.replace(/```[\s\S]*?```/g, (block) => {
    fences.push(block)
    return `\u0000${fences.length - 1}\u0000`
  })

  // Images: drop the whole construct (keep nothing — matches the reference).
  out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, '')

  // H5/H6: strip the marker, keep the heading text.
  out = out.replace(/^#{5,6}\s+/gm, '')

  // Bold-italic (***x*** / ___x___) wrapping CJK → keep content bare.
  out = out.replace(/(\*\*\*|___)([^*_\n]+)\1/g, (m, _marker, inner: string) =>
    CJK_RE.test(inner) ? inner : m,
  )

  // Italic (*x* / _x_) wrapping CJK → keep content bare. Negative lookarounds
  // keep `**bold**` intact.
  out = out.replace(/(?<![*\w])\*([^*\n]+)\*(?!\*)/g, (m, inner: string) =>
    CJK_RE.test(inner) ? inner : m,
  )
  out = out.replace(/(?<![_\w])_([^_\n]+)_(?!_)/g, (m, inner: string) =>
    CJK_RE.test(inner) ? inner : m,
  )

  // Restore fences.
  out = out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => fences[Number(i)])

  return out
}
