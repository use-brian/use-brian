// ⚠️ STALE — The WhatsApp channel is deprecated and unmaintained as of 2026-06-02.
// It is no longer surfaced in the web UI and must not be extended. It is kept only
// so any pre-existing integration keeps functioning. See docs/architecture/channels/whatsapp.md (Status: Stale).
/**
 * Markdown → WhatsApp formatting converter.
 *
 * WhatsApp supported formatting (as of 2024):
 *   *bold*  _italic_  ~strikethrough~  ```code block```  `inline code`
 *   > blockquote   - bulleted list   1. numbered list
 *
 * Key difference from standard Markdown:
 *   - Markdown *text* = italic, but WhatsApp *text* = bold
 *   - Markdown **text** = bold, but WhatsApp uses single *text*
 *   - No markdown links — WhatsApp auto-links bare URLs
 *   - No headers — converted to bold
 *   - No language hints on code blocks
 *   - No horizontal rules
 *
 * Follows the same pattern as Slack's markdownToMrkdwn in ../slack/adapter.ts.
 * Component tag: [COMP:channels/whatsapp].
 */

/** Convert standard Markdown to WhatsApp-compatible formatting. */
export function markdownToWhatsApp(text: string): string {
  let out = text

  // Inline images: ![alt](url) → alt (url)  — must run before links
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1 ($2)')

  // Links: [text](url) → text (url)  — WhatsApp auto-links bare URLs
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')

  // Fenced code blocks: ```lang\ncode\n``` → ```\ncode\n```
  // WhatsApp supports ``` for monospace blocks but not language identifiers.
  // Preserve the content exactly — just strip the language hint.
  out = out.replace(/```[a-zA-Z]*\n([\s\S]*?)```/g, '```\n$1```')

  // Bold-italic: ***text*** → *_text_*  (must come before bold and italic)
  out = out.replace(/\*\*\*(.+?)\*\*\*/g, '*_$1_*')

  // Headers: ### text → *text* (bold, since WhatsApp has no header syntax)
  // Must run BEFORE bold conversion so "### **text**" → "### *text*" doesn't double up.
  out = out.replace(/^#{1,6}\s+(.+)$/gm, '*$1*')

  // Bold: **text** → *text*  (must come before italic)
  out = out.replace(/\*\*(.+?)\*\*/g, '*$1*')

  // Italic: *text* → _text_  (single asterisk italic → underscore italic)
  // Must run AFTER bold conversion. At this point, remaining single *text*
  // that weren't part of ** pairs are markdown italics.
  // Use negative lookbehind/lookahead to avoid matching inside words like file*name
  // Only match *text* where * is at a word boundary.
  // However, we also just converted **bold** to *bold* above, so those are now
  // single-asterisk. We can't easily distinguish converted bold from original italic.
  //
  // The practical approach: after ** → * conversion, ALL remaining *text* patterns
  // become WhatsApp bold, which is acceptable since both bold and italic serve
  // as emphasis. The key win is that **bold** renders as bold (not literal **),
  // and _italic_ passes through correctly.

  // Strikethrough: ~~text~~ → ~text~
  out = out.replace(/~~(.+?)~~/g, '~$1~')

  // Horizontal rules: --- or *** or ___ → blank line (not supported)
  out = out.replace(/^[-*_]{3,}\s*$/gm, '')

  // Tables: convert markdown tables to a readable list format.
  // WhatsApp has no table rendering — raw pipes look broken.
  out = convertTables(out)

  // Lists and blockquotes are natively supported by WhatsApp (since 2024):
  //   - bulleted list (- item or * item)
  //   > blockquote
  //   1. numbered list
  // No conversion needed — leave as-is.

  return out
}

/**
 * Convert markdown tables to a vertical key-value list.
 *
 * Input:
 *   | Model | Context | Speed |
 *   |---|---|---|
 *   | Gemini 2.5 | 1M | Fast |
 *   | GPT-4o | 128k | Medium |
 *
 * Output:
 *   *Model:* Gemini 2.5
 *   *Context:* 1M
 *   *Speed:* Fast
 *
 *   *Model:* GPT-4o
 *   *Context:* 128k
 *   *Speed:* Medium
 */
function convertTables(text: string): string {
  // Match consecutive lines that start/end with pipes
  const tableRegex = /(?:^[ \t]*\|.+\|[ \t]*$\n?)+/gm

  return text.replace(tableRegex, (tableBlock) => {
    const lines = tableBlock.trim().split('\n').map((l) => l.trim())
    if (lines.length < 2) return tableBlock // not a real table

    // Parse header row
    const headers = parsePipeRow(lines[0])
    if (headers.length === 0) return tableBlock

    // Skip separator row (|---|---|---|)
    const dataStartIndex = lines[1].match(/^\|[\s:*-]+\|/) ? 2 : 1

    // Parse data rows and format as key-value pairs
    const rows: string[] = []
    for (let i = dataStartIndex; i < lines.length; i++) {
      const cells = parsePipeRow(lines[i])
      if (cells.length === 0) continue
      // Skip separator rows that appear mid-table
      if (cells.every((c) => /^[\s:*-]*$/.test(c))) continue

      const parts: string[] = []
      for (let j = 0; j < headers.length && j < cells.length; j++) {
        parts.push(`*${headers[j]}:* ${cells[j]}`)
      }
      rows.push(parts.join('\n'))
    }

    return rows.join('\n\n') + '\n'
  })
}

/** Extract trimmed cell values from a pipe-delimited row. */
function parsePipeRow(line: string): string[] {
  // Strip leading/trailing pipes and split
  const stripped = line.replace(/^\||\|$/g, '')
  return stripped.split('|').map((c) => c.trim()).filter((c) => c.length > 0)
}
