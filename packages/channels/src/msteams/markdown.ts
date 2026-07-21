/**
 * Markdown → Microsoft Teams message text.
 *
 * Teams renders a GitHub-flavored-markdown subset when an activity carries
 * `textFormat: 'markdown'` — bold, italic, `[text](url)` links, bullet/numbered
 * lists, inline + fenced code, and blockquotes all pass through. Two constructs
 * render badly and are normalized (mirrors the Slack `markdownToMrkdwn` /
 * Discord `markdownToDiscord` approach):
 *
 *   - **Headers** — Teams' `#`/`##`/`###` heading rendering is inconsistent
 *     across desktop / mobile / web clients (often oversized or ignored), so we
 *     flatten a heading line to bold, the way Slack strips headers to `*bold*`.
 *   - **Tables** — Teams has no markdown table rendering in message bodies; raw
 *     pipes look broken. Each row is flattened into a `**Header:** value` block.
 *   - **Horizontal rules** — a lone `---` / `***` / `___` renders as literal
 *     text or a stray divider, so it is dropped.
 *
 * Fenced + inline code are protected first so `#` / `|` / `---` inside code are
 * never rewritten. Component tag: [COMP:channels/msteams-markdown].
 */

export function markdownToTeams(text: string): string {
  const codeBlocks: string[] = []
  const inlineCodes: string[] = []

  const placeholder = (kind: 'CB' | 'IC', idx: number) => `\x00MT_${kind}_${idx}\x00`

  let out = text

  // ── 1. Protect fenced code blocks ────────────────────────────
  out = out.replace(/```[\s\S]*?```/g, (block) => {
    codeBlocks.push(block)
    return placeholder('CB', codeBlocks.length - 1)
  })

  // ── 2. Protect inline code ───────────────────────────────────
  out = out.replace(/`[^`\n]+`/g, (code) => {
    inlineCodes.push(code)
    return placeholder('IC', inlineCodes.length - 1)
  })

  // ── 3. Tables → key-value blocks ─────────────────────────────
  out = convertTables(out)

  // ── 4. Headers → bold line ───────────────────────────────────
  out = out.replace(/^#{1,6}[ \t]+(.+?)[ \t]*$/gm, '**$1**')

  // ── 5. Horizontal rules → drop ───────────────────────────────
  out = out.replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, '')

  // ── 6. Restore protected spans ───────────────────────────────
  out = out.replace(/\x00MT_(CB|IC)_(\d+)\x00/g, (_, kind, idx) => {
    const i = Number(idx)
    return kind === 'CB' ? (codeBlocks[i] ?? '') : (inlineCodes[i] ?? '')
  })

  return out
}

// ── Tables → vertical key-value list ─────────────────────────
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
    return rows.length ? rows.join('\n\n') + '\n' : block
  })
}

function parsePipeRow(line: string): string[] {
  const stripped = line.replace(/^\||\|$/g, '')
  return stripped.split('|').map((c) => c.trim()).filter((c) => c.length > 0)
}
