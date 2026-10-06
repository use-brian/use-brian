import type { OutgoingMessage } from '../types.js'
import { chunkText } from '../chunking.js'
import { escapeHtml, markdownToTelegramHTML } from './markdown.js'

/** Chunk before HTML escaping so limits apply to the text Telegram displays. */
export function prepareTelegramMessages(response: OutgoingMessage, maxLength: number): Array<{ text: string; html?: string }> {
  const details = response.collapsibleDetails
  if (!details) return response.text.trim() ? chunkText(response.text, maxLength).map((text) => ({ text })) : []

  const separator = response.text ? '\n\n' : ''
  const room = maxLength - response.text.length - separator.length
  if (room <= 0) {
    // A full-length heading cannot share a quote. Preserve everything unfolded.
    return chunkText(response.text + separator + details, maxLength).map((text) => ({ text }))
  }
  const heading = response.format === 'markdown' ? markdownToTelegramHTML(response.text) : escapeHtml(response.text)
  // Repeat the short heading on long emails; buttons attach only to the last chunk.
  return chunkText(details, room).map((part) => ({
    text: response.text + separator + part,
    html: `${heading}${separator}<blockquote expandable>${escapeHtml(part)}</blockquote>`,
  }))
}
