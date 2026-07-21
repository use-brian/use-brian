/**
 * Markdown → email body renderer.
 *
 * The model drafts email bodies in GitHub-flavored markdown, but email
 * clients do not parse markdown — a text/plain body ships `**bold**`,
 * `### headings`, and `[label](url)` literally. This module renders the
 * model's markdown into the two bodies a real email carries
 * (multipart/alternative):
 *
 *   - `html` — semantic email HTML: <p>/<br> paragraphs, <h2>–<h4>
 *     headings, <strong>/<em>/<del>, <ul>/<ol>, <a> (http/https/mailto
 *     only), <blockquote>, <pre>/<code>, and real <table>. Escape-first:
 *     raw HTML in the source is model-composed free text and is always
 *     escaped, never passed through.
 *   - `text` — the plain-text alternative via the shared `stripMarkdown`
 *     (markers removed, links as `label (url)`, bullets as `•`).
 *
 * Consumers — every boundary where model text exits as an email body:
 * the email channel adapter (./adapter.ts), the AgentMail tool wiring
 * (packages/api/src/mcp/inject.ts), and the Gmail MIME assembly
 * (packages/api/src/google/client.ts).
 *
 * Companions: `markdownToTelegramHTML` (../telegram/markdown.ts),
 * `markdownToWhatsApp` (../whatsapp/formatter.ts).
 * Component tag: [COMP:channels/email-markdown]
 */

import { escapeHtml, stripMarkdown } from '../telegram/markdown.js'

export type EmailBody = {
  /** Plain-text alternative — markdown markers stripped. */
  text: string
  /** HTML body fragment — block elements, no <html>/<body> wrapper. */
  html: string
}

/** Render a markdown body into the text + HTML pair an outgoing email carries. */
export function renderEmailBody(markdown: string): EmailBody {
  return {
    text: stripMarkdown(markdown).trim(),
    html: markdownToEmailHtml(markdown),
  }
}

/**
 * Convert GitHub-flavored markdown to a semantic email-HTML fragment.
 * Same escape-first placeholder technique as `markdownToTelegramHTML`;
 * differs in the target: email clients render real block structure, so
 * headings, lists, and tables come out as actual tags instead of being
 * flattened to bold lines and bullet characters.
 */
export function markdownToEmailHtml(text: string): string {
  const codeBlocks: string[] = []
  const inlineCodes: string[] = []
  const links: string[] = []
  const tables: string[] = []

  const placeholder = (kind: 'CB' | 'IC' | 'LN' | 'TB', idx: number) =>
    `\x00EM_${kind}_${idx}\x00`

  let out = text

  // ── 1. Fenced code blocks ────────────────────────────────────
  // Pulled first so their contents are not mangled by later passes.
  out = out.replace(/```([a-zA-Z0-9_+\-]*)\n?([\s\S]*?)```/g, (_, _lang, code) => {
    codeBlocks.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`)
    return `\n\n${placeholder('CB', codeBlocks.length - 1)}\n\n`
  })

  // ── 2. Inline code ───────────────────────────────────────────
  out = out.replace(/`([^`\n]+)`/g, (_, code) => {
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`)
    return placeholder('IC', inlineCodes.length - 1)
  })

  // ── 3. Images & links ────────────────────────────────────────
  // Images degrade to `alt (url)` text — remote images in outbound mail are
  // a tracking/clipping liability, and the model has no image URLs a
  // recipient should load anyway. Images first so `!` isn't link-matched.
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt, url) =>
    `${alt.trim() || url} (${url})`,
  )
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, url) => {
    if (!/^(https?:|mailto:)/i.test(url)) return `${label} (${url})`
    links.push(`<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`)
    return placeholder('LN', links.length - 1)
  })

  // ── 4. Tables → real <table> ─────────────────────────────────
  // Cells are escaped + inline-formatted here (the global escape below never
  // sees them); restored before the other placeholders so their inner
  // IC/LN placeholders resolve too.
  out = convertEmailTables(out, tables, placeholder)

  // ── 5. HTML-escape remaining literal text ────────────────────
  out = escapeHtml(out)

  // ── 6. Headings ──────────────────────────────────────────────
  // # → <h2>, ## → <h3>, deeper → <h4> — an email should never carry the
  // page-title weight of <h1>.
  out = out.replace(/^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, (_, hashes, body) => {
    const level = Math.min(hashes.length + 1, 4)
    return `\n\n<h${level}>${body}</h${level}>\n\n`
  })

  // ── 7. Horizontal rules ──────────────────────────────────────
  out = out.replace(/^[-*_]{3,}\s*$/gm, '\n\n<hr>\n\n')

  // ── 8. Lists ─────────────────────────────────────────────────
  // Before blockquotes: quote lines start with `&gt;` so the list regexes
  // never touch them, and running lists first keeps a bulleted list inside
  // a quote from splicing <ul> tags into an already-built <blockquote>.
  out = out.replace(/(?:^[ \t]*[*+-][ \t]+.+(?:\n|$))+/gm, (block) => {
    const items = block
      .trimEnd()
      .split('\n')
      .map((l) => l.replace(/^[ \t]*[*+-][ \t]+/, ''))
    return `\n\n<ul>\n${items.map((i) => `<li>${i}</li>`).join('\n')}\n</ul>\n\n`
  })
  out = out.replace(/(?:^[ \t]*\d{1,3}[.)][ \t]+.+(?:\n|$))+/gm, (block) => {
    const items = block
      .trimEnd()
      .split('\n')
      .map((l) => l.replace(/^[ \t]*\d{1,3}[.)][ \t]+/, ''))
    return `\n\n<ol>\n${items.map((i) => `<li>${i}</li>`).join('\n')}\n</ol>\n\n`
  })

  // ── 9. Blockquotes ───────────────────────────────────────────
  // Step 5 escaped `>` to `&gt;`; nested quotes collapse to one level.
  out = out.replace(/(?:^(?:&gt;[ \t]?)+.*(?:\n|$))+/gm, (block) => {
    const inner = block
      .replace(/^(?:&gt;[ \t]?)+/gm, '')
      .trimEnd()
      .split('\n')
      .join('<br>\n')
    return `\n\n<blockquote>${inner}</blockquote>\n\n`
  })

  // ── 10. Inline formatting ────────────────────────────────────
  out = applyInlineFormatting(out)

  // ── 11. Paragraphs ───────────────────────────────────────────
  // Blank-line-separated chunks become <p> (inner newlines → <br>); chunks
  // that already start with a block tag or block placeholder pass through.
  const blockStart = /^(?:<(?:h[1-6]|ul|ol|table|blockquote|pre|hr)\b|\x00EM_(?:CB|TB)_)/
  out = out
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0)
    .map((b) => (blockStart.test(b) ? b : `<p>${b.replace(/\n/g, '<br>\n')}</p>`))
    .join('\n')

  // ── 12. Restore placeholders (tables first — they nest IC/LN) ─
  out = out.replace(/\x00EM_TB_(\d+)\x00/g, (_, idx) => tables[Number(idx)] ?? '')
  out = out.replace(/\x00EM_(CB|IC|LN)_(\d+)\x00/g, (_, kind, idx) => {
    const i = Number(idx)
    if (kind === 'CB') return codeBlocks[i] ?? ''
    if (kind === 'IC') return inlineCodes[i] ?? ''
    return links[i] ?? ''
  })

  return out
}

function applyInlineFormatting(out: string): string {
  let s = out
  s = s.replace(/\*\*\*([^*\n]+?)\*\*\*/g, '<strong><em>$1</em></strong>')
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/__([^_\n]+?)__/g, '<strong>$1</strong>')
  // Word-boundary-ish context so `a*b*c` and `snake_case` pass through.
  s = s.replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\w)/g, '$1<em>$2</em>')
  s = s.replace(/(^|[^_\w])_(?!\s)([^_\n]+?)(?<!\s)_(?!\w)/g, '$1<em>$2</em>')
  s = s.replace(/~~([^~\n]+?)~~/g, '<del>$1</del>')
  return s
}

// Borders inline (email clients ignore <style> blocks); a borderless table
// in an email reads as word soup.
const TABLE_STYLE = 'border-collapse:collapse'
const CELL_STYLE = 'border:1px solid #ddd;padding:6px 10px;text-align:left'

function convertEmailTables(
  text: string,
  store: string[],
  placeholder: (kind: 'TB', idx: number) => string,
): string {
  const tableRegex = /(?:^[ \t]*\|.+\|[ \t]*$\n?)+/gm
  return text.replace(tableRegex, (block) => {
    const lines = block.trim().split('\n').map((l) => l.trim())
    if (lines.length < 2) return block

    const headers = parsePipeRow(lines[0])
    if (headers.length === 0) return block

    const dataStart = lines[1].match(/^\|[\s:*-]+\|/) ? 2 : 1
    const cell = (raw: string, tag: 'th' | 'td') =>
      `<${tag} style="${CELL_STYLE}">${applyInlineFormatting(escapeHtml(raw))}</${tag}>`

    const rows: string[] = [`<tr>${headers.map((h) => cell(h, 'th')).join('')}</tr>`]
    for (let i = dataStart; i < lines.length; i++) {
      const cells = parsePipeRow(lines[i])
      if (cells.length === 0) continue
      if (cells.every((c) => /^[\s:*-]*$/.test(c))) continue
      rows.push(`<tr>${cells.map((c) => cell(c, 'td')).join('')}</tr>`)
    }

    store.push(`<table style="${TABLE_STYLE}">\n${rows.join('\n')}\n</table>`)
    return `\n\n${placeholder('TB', store.length - 1)}\n\n`
  })
}

function parsePipeRow(line: string): string[] {
  const stripped = line.replace(/^\||\|$/g, '')
  return stripped.split('|').map((c) => c.trim()).filter((c) => c.length > 0)
}
