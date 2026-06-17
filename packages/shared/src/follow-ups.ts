/**
 * Parse and strip the trailing `<followup>[...]</followup>` tag the model
 * appends per the `# Follow-up questions` block in Layer 1. Returns the
 * user-visible text and the parsed question list.
 *
 * Web renders the questions as clickable chips; messaging channels
 * (Telegram, Slack, WhatsApp) have no chip affordance, so they call this
 * to strip the tag before sending — otherwise the raw `<followup>...`
 * text leaks into the message body.
 *
 * Spec: `docs/architecture/features/follow-up-questions.md`.
 */
export function parseFollowUps(text: string): { display: string; questions: string[] } {
  const tagStart = text.indexOf('<followup')
  if (tagStart === -1) return { display: text, questions: [] }

  const display = text.slice(0, tagStart).trimEnd()

  const match = text.match(/<followup>\s*(\[[\s\S]*?\])\s*<\/followup>/)
  if (!match) return { display, questions: [] }

  try {
    const parsed = JSON.parse(match[1])
    const questions = Array.isArray(parsed)
      ? parsed
          .filter((q: unknown): q is string => typeof q === 'string' && q.trim().length > 0)
          .slice(0, 4)
      : []
    return { display, questions }
  } catch {
    return { display, questions: [] }
  }
}

/**
 * Remove every `<followup>[...]</followup>` tag from a string, wherever it
 * appears — not just a single trailing one. Unlike `parseFollowUps` (which
 * splits at the first `<followup` and discards everything after), this is a
 * surgical strip that preserves any surrounding prose, so it's safe to run
 * over content that legitimately continues after the tag (e.g. a block of
 * page text the model authored).
 *
 * Used as a defense-in-depth sanitizer on AI-authored doc page content:
 * the chip tag is a chat-surface convention and must never become document
 * text. A trailing malformed opener (`<followup` with no close) is also
 * dropped so a half-streamed tag can't survive.
 *
 * Spec: `docs/architecture/features/follow-up-questions.md`.
 */
export function stripFollowUps(text: string): string {
  return text
    .replace(/<followup>\s*\[[\s\S]*?\]\s*<\/followup>/g, '')
    .replace(/<followup[\s\S]*$/, '')
    .trimEnd()
}
