/**
 * Markdown → Discord-flavored markdown.
 *
 * Discord renders most GitHub-flavored markdown natively, so this is a far
 * lighter touch than the Telegram HTML converter. We only fix the constructs
 * Discord renders differently or not at all:
 *
 *   - **Headers** — Discord supports `#`, `##`, `###` only. `####`+ render as
 *     literal text, so we clamp deeper levels to `###`.
 *   - **`__underline__`** — in Discord `__x__` is *underline*, but the LLM
 *     emits GFM where `__x__` means *bold*. We rewrite it to `**x**` so the
 *     author's bold intent survives.
 *   - **Tables** — Discord has no table rendering; raw pipes look broken. We
 *     flatten each row into a `**Header:** value` block (matches the Telegram
 *     converter's fallback).
 *   - **Horizontal rules** — a lone `---` / `***` / `___` renders literally on
 *     Discord, so we drop it.
 *
 * Everything else — bold, italic, strikethrough, inline code, fenced code,
 * blockquotes, bullet/numbered lists, and `[text](url)` masked links — passes
 * through untouched because Discord supports it. Component tag:
 * [COMP:channels/discord].
 */

export function markdownToDiscord(text: string): string {
  const codeBlocks: string[] = []
  const inlineCodes: string[] = []

  const placeholder = (kind: 'CB' | 'IC', idx: number) => `\x00DC_${kind}_${idx}\x00`

  let out = text

  // ── 1. Protect fenced code blocks ────────────────────────────
  // Pulled first so their contents (which may contain `#`, `|`, `__`, `---`)
  // are never touched by the rewrites below.
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

  // ── 4. Clamp headers to Discord's 3 supported levels ─────────
  // `####…` → `###`. Keep the heading text; only shrink the marker.
  out = out.replace(/^(#{4,6})(\s+)/gm, '###$2')

  // ── 5. Horizontal rules → drop ───────────────────────────────
  out = out.replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, '')

  // ── 6. GFM bold `__x__` → Discord bold `**x**` ───────────────
  // Discord reads `__` as underline; preserve the bold intent instead.
  out = out.replace(/__([^_\n]+?)__/g, '**$1**')

  // ── 7. Restore protected spans ───────────────────────────────
  out = out.replace(/\x00DC_(CB|IC)_(\d+)\x00/g, (_, kind, idx) => {
    const i = Number(idx)
    return kind === 'CB' ? (codeBlocks[i] ?? '') : (inlineCodes[i] ?? '')
  })

  return out
}

// ── Tables → vertical key-value list ─────────────────────────
//
// Input:
//   | Model | Speed |
//   |---|---|
//   | A | fast |
// Output:
//   **Model:** A
//   **Speed:** fast
function convertTables(text: string): string {
  const tableRegex = /(?:^[ \t]*\|.+\|[ \t]*$\n?)+/gm
  return text.replace(tableRegex, (block) => {
    const lines = block.trim().split('\n').map((l) => l.trim())
    if (lines.length < 2) return block

    const headers = parsePipeRow(lines[0])
    if (headers.length === 0) return block

    // A separator row (`|---|---|`) marks line 1 as the divider, data from 2.
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
