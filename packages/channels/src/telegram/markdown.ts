/**
 * Markdown → Telegram HTML converter.
 *
 * Telegram's HTML parse_mode is the least fragile of its formatting options:
 *   - Only `<`, `>`, `&` need escaping (vs. MarkdownV2's ~20 reserved chars).
 *   - Inline entities nest freely (bold/italic/underline/strike/spoiler).
 *   - Headers, lists, tables, and horizontal rules are NOT supported — we
 *     normalise them to inline bold / bullet chars / key-value blocks so the
 *     LLM's default GFM output renders cleanly instead of leaking `###`/`*  `.
 *
 * Supported output tags (per core.telegram.org/bots/api#html-style):
 *   <b> <i> <u> <s> <code> <pre> <a href> <blockquote> <tg-spoiler>
 *
 * Companion: `markdownToWhatsApp` in ../whatsapp/formatter.ts. Component tag:
 * [COMP:channels/telegram].
 */

/** HTML-escape plain text for safe injection into Telegram HTML parse_mode. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Convert GitHub-flavored markdown to Telegram-compatible HTML.
 *
 * Intended to be paired with `parse_mode: 'HTML'` on `sendMessage` /
 * `editMessageText`. If the Telegram API still rejects the result (e.g. a
 * malformed link URL), the caller should fall back to `stripMarkdown(input)`
 * with no parse_mode.
 */
export function markdownToTelegramHTML(text: string): string {
  const codeBlocks: string[] = []
  const inlineCodes: string[] = []
  const links: string[] = []

  const placeholder = (kind: 'CB' | 'IC' | 'LN', idx: number) =>
    `\x00TG_${kind}_${idx}\x00`

  let out = text

  // ── 1. Fenced code blocks ────────────────────────────────────
  // Pulled first so their contents are not mangled by later passes.
  out = out.replace(/```([a-zA-Z0-9_+\-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const body = escapeHtml(code.replace(/\n$/, ''))
    const html = lang
      ? `<pre><code class="language-${escapeHtml(lang)}">${body}</code></pre>`
      : `<pre>${body}</pre>`
    codeBlocks.push(html)
    return placeholder('CB', codeBlocks.length - 1)
  })

  // ── 2. Inline code ───────────────────────────────────────────
  out = out.replace(/`([^`\n]+)`/g, (_, code) => {
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`)
    return placeholder('IC', inlineCodes.length - 1)
  })

  // ── 3. Tables → key-value blocks ─────────────────────────────
  // Telegram has no table rendering; leaving raw pipes looks broken.
  out = convertTables(out)

  // ── 4. Images & links ────────────────────────────────────────
  // Images first so their `!` prefix isn't stripped by the link rule.
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt, url) => {
    const label = alt.trim() || url
    return `${escapeHtml(label)} (${escapeHtml(url)})`
  })

  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, url) => {
    // Telegram only accepts http(s), tg:// and mailto: schemes on <a href>.
    const safe = /^(https?:|tg:\/\/|mailto:)/i.test(url) ? url : null
    if (!safe) return escapeHtml(`${label} (${url})`)
    links.push(`<a href="${escapeHtml(safe)}">${escapeHtml(label)}</a>`)
    return placeholder('LN', links.length - 1)
  })

  // ── 5. HTML-escape remaining literal text ────────────────────
  // Everything that survives this point is either a placeholder (restored
  // last) or plain markdown we're about to rewrite into `<b>` / `<i>` etc.
  out = escapeHtml(out)

  // ── 6. Headers → bold line ───────────────────────────────────
  // Telegram has no header tag; bold + line break is the closest render.
  // Must run before the bold rule so `### **text**` collapses cleanly.
  // Trailing whitespace is matched as [ \t] only — a bare \s* would eat the
  // newline(s) after the heading and glue it to the next paragraph.
  out = out.replace(/^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, '<b>$1</b>')

  // ── 7. Horizontal rules → drop ───────────────────────────────
  out = out.replace(/^[-*_]{3,}\s*$/gm, '')

  // ── 8. Blockquotes ───────────────────────────────────────────
  // Step 5 escaped `>` to `&gt;`, so we match the escaped form here. Group
  // consecutive quote lines into a single <blockquote>; nested `>>` collapses
  // to one level since Telegram disallows nested blockquotes.
  out = out.replace(/(?:^&gt;[ \t]?.*(?:\n|$))+/gm, (block) => {
    const inner = block
      .replace(/^&gt;[ \t]?/gm, '')
      .replace(/\n$/, '')
    return `<blockquote>${inner}</blockquote>\n`
  })

  // ── 9. Bullet markers → • ────────────────────────────────────
  // Telegram strips `<ul>/<li>` tags, so `*   item` would render literally.
  // A leading `•` reads well and survives chunking.
  out = out.replace(/^[ \t]*[*+-][ \t]+/gm, '• ')

  // ── 10. Bold-italic ***text*** ───────────────────────────────
  out = out.replace(/\*\*\*([^*\n]+?)\*\*\*/g, '<b><i>$1</i></b>')

  // ── 11. Bold ─────────────────────────────────────────────────
  out = out.replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>')
  out = out.replace(/__([^_\n]+?)__/g, '<b>$1</b>')

  // ── 12. Italic ───────────────────────────────────────────────
  // Require word-boundary-ish context so `a*b*c` and `snake_case` pass through.
  out = out.replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\w)/g, '$1<i>$2</i>')
  out = out.replace(/(^|[^_\w])_(?!\s)([^_\n]+?)(?<!\s)_(?!\w)/g, '$1<i>$2</i>')

  // ── 13. Strikethrough ────────────────────────────────────────
  out = out.replace(/~~([^~\n]+?)~~/g, '<s>$1</s>')

  // ── 14. Restore placeholders ─────────────────────────────────
  out = out.replace(/\x00TG_(CB|IC|LN)_(\d+)\x00/g, (_, kind, idx) => {
    const i = Number(idx)
    if (kind === 'CB') return codeBlocks[i] ?? ''
    if (kind === 'IC') return inlineCodes[i] ?? ''
    return links[i] ?? ''
  })

  return out
}

// ── Tables → vertical key-value list ─────────────────────────
//
// Input:
//   | Model | Speed |
//   |---|---|
//   | A | fast |
//   | B | slow |
// Output:
//   <b>Model:</b> A
//   <b>Speed:</b> fast
//
//   <b>Model:</b> B
//   <b>Speed:</b> slow
//
// The <b> tags are emitted as plain markdown (`**Model:**`) here so the
// downstream bold rule (step 11) wraps them consistently with the rest of
// the document. Table contents are still subject to HTML escaping in step 5.
function convertTables(text: string): string {
  const tableRegex = /(?:^[ \t]*\|.+\|[ \t]*$\n?)+/gm
  return text.replace(tableRegex, (block) => {
    const lines = block.trim().split('\n').map((l) => l.trim())
    if (lines.length < 2) return block

    const headers = parsePipeRow(lines[0])
    if (headers.length === 0) return block

    const dataStart = lines[1].match(/^\|[\s:*-]+\|/) ? 2 : 1
    const rows: string[] = []
    for (let i = dataStart; i < lines.length; i++) {
      const cells = parsePipeRow(lines[i])
      if (cells.length === 0) continue
      if (cells.every((c) => /^[\s:*-]*$/.test(c))) continue
      const parts: string[] = []
      for (let j = 0; j < headers.length && j < cells.length; j++) {
        parts.push(`**${headers[j]}:** ${cells[j]}`)
      }
      rows.push(parts.join('\n'))
    }
    return rows.join('\n\n') + '\n'
  })
}

function parsePipeRow(line: string): string[] {
  const stripped = line.replace(/^\||\|$/g, '')
  return stripped.split('|').map((c) => c.trim()).filter((c) => c.length > 0)
}

/**
 * Strip markdown to readable plain text. Used as the last-ditch fallback when
 * Telegram rejects our HTML (malformed URL, unclosed tag, …). Handles the
 * constructs markdownToTelegramHTML normalises so the user never sees raw
 * `###` / `*   ` / `**` markers.
 */
export function stripMarkdown(text: string): string {
  let out = text

  // Fenced code blocks — strip fences, keep body
  out = out.replace(/```[a-zA-Z0-9_+\-]*\n?([\s\S]*?)```/g, '$1')

  // Inline code
  out = out.replace(/`([^`\n]+)`/g, '$1')

  // Images → alt (url)
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt, url) =>
    (alt.trim() || url) + ' (' + url + ')',
  )

  // Links → text (url), or just text for tel/tg schemes
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '$1 ($2)')

  // Headers ([ \t] only — \s* would eat the blank line after the heading)
  out = out.replace(/^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, '$1')

  // Horizontal rules
  out = out.replace(/^[-*_]{3,}\s*$/gm, '')

  // Bullet markers
  out = out.replace(/^[ \t]*[*+-][ \t]+/gm, '• ')

  // Blockquote markers
  out = out.replace(/^>[ \t]?/gm, '')

  // Bold-italic / bold / italic / strike
  out = out.replace(/\*\*\*(.+?)\*\*\*/g, '$1')
  out = out.replace(/\*\*(.+?)\*\*/g, '$1')
  out = out.replace(/__(.+?)__/g, '$1')
  out = out.replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\w)/g, '$1$2')
  out = out.replace(/(^|[^_\w])_(?!\s)([^_\n]+?)(?<!\s)_(?!\w)/g, '$1$2')
  out = out.replace(/~~(.+?)~~/g, '$1')

  return out
}
