/**
 * Auto-title generation for doc pages.
 *
 * One generator, two triggers (see docs/architecture/features/doc.md →
 * "Auto-title"):
 *   - **Human** — the browser editor fires once the body crosses
 *     {@link AUTO_TITLE_MIN_CHARS}, via `POST /api/saved-views/:id/auto-title`.
 *   - **AI** — the chat route fires after a doc write turn, gated only by
 *     {@link AUTO_TITLE_AI_MIN_CHARS} (the AI's "first edit" is deliberate, so
 *     the floor is just "has meaningful content").
 *
 * Both extract the page body to plaintext (`@sidanclaw/doc-model`
 * `pageToPlaintext`), call {@link generatePageTitle} here, and commit through
 * the one guarded `SavedViewStore.setAutoTitle` (placeholder → auto). This
 * module owns only the model call + sanitisation so the contract matches the
 * session auto-title in `packages/api/src/routes/chat.ts` (same model, same
 * cleanup).
 *
 * This module also exports {@link deriveCommentTitle} — the model-free sibling
 * that labels a comment thread from its first message for the comment index
 * (see docs/architecture/features/doc-comments.md).
 *
 * [COMP:doc/auto-title]
 */

import type { LLMProvider, Message, TokenUsage } from '../providers/types.js'

/**
 * Minimum body plaintext length (chars) before the **human** edit trigger
 * fires. Tuned so a one-line scratch note stays "Untitled — draft" but a few
 * developed paragraphs get a title. Mirrored client-side in
 * `apps/app-web/src/lib/collab/use-auto-title.ts` (which can't import core —
 * it's browser-bundled); keep the two in sync. The server endpoint re-checks
 * this value authoritatively.
 */
export const AUTO_TITLE_MIN_CHARS = 500

/**
 * Minimum body plaintext length for the **AI** edit trigger. The AI's first
 * edit is intentional content (often a full `renderPage`), so the floor is
 * just "non-trivial" — `generatePageTitle` null-guards anything too thin to
 * summarise, leaving the placeholder untouched.
 */
export const AUTO_TITLE_AI_MIN_CHARS = 1

/** Standard-tier extraction model — same routing as the session auto-title. */
const TITLE_MODEL = 'gemini-3.1-flash-lite'

const PAGE_TITLE_SYSTEM_PROMPT =
  'Give this document a single representative emoji followed by a short descriptive title (3-6 words). The title should capture the specific topic of the page. Output ONLY one emoji, a space, then the title — no markdown, quotes, or punctuation.\n\nRules:\n- Start with exactly one emoji that fits the topic, then a space\n- Title is always 3-6 words\n- Name the specific subject, not just the category\n- No leading/trailing punctuation or quotes\n\nExamples:\nQ3 revenue is up 14% driven by enterprise renewals… → 📈 Q3 Revenue Growth Review\nNotes from the offsite: hiring plan, runway, pricing… → 🗒️ Offsite Planning Notes\nA checklist for shipping the new onboarding flow… → 🚀 Onboarding Flow Launch Checklist'

export type GenerateTitleResult = {
  title: string | null
  /**
   * A single emoji the model suggested for the page icon, or `null` when it
   * emitted none / the title couldn't be generated. Callers commit it
   * alongside the title via `setAutoTitle`, which only fills an icon the user
   * hasn't already chosen.
   */
  icon: string | null
  usage: TokenUsage | null
  model: string | null
}

/**
 * Peel a leading emoji off a raw model line. Returns the emoji (a single
 * grapheme cluster — handles VS16, skin-tone modifiers, ZWJ sequences, and
 * regional-indicator flags) plus the remaining text. When the line doesn't
 * start with an emoji, `icon` is `null` and `rest` is the input untouched.
 *
 * Defensive: a cluster longer than 8 code points is treated as noise (not a
 * real single emoji) and rejected, so a malformed model response can't smuggle
 * arbitrary text into the icon field.
 *
 * Built from U+FE0F (VS16 presentation selector) and U+200D (ZWJ sequence
 * joiner) escapes so the source carries no invisible characters.
 */
const VS16 = '\\uFE0F'
const ZWJ = '\\u200D'
const EMOJI_UNIT = `\\p{Extended_Pictographic}(?:${VS16}|\\p{Emoji_Modifier})?`
// The trailing `\s*` is part of match[0] (not the capture) so the consumed
// span includes the separating space — `rest` comes back without a leading gap.
const LEADING_EMOJI_RE = new RegExp(
  `^\\s*((?:${EMOJI_UNIT}(?:${ZWJ}${EMOJI_UNIT})*)|[\\u{1F1E6}-\\u{1F1FF}]{2})\\s*`,
  'u',
)

export function extractLeadingEmoji(raw: string): { icon: string | null; rest: string } {
  const match = raw.match(LEADING_EMOJI_RE)
  if (!match) return { icon: null, rest: raw }
  const emoji = match[1]
  if (Array.from(emoji).length > 8) return { icon: null, rest: raw }
  return { icon: emoji, rest: raw.slice(match[0].length) }
}

/**
 * Clean up a raw LLM-generated title:
 * - Strip markdown (**, *, _, backticks, leading #)
 * - Strip enclosing quotes / trailing punctuation
 * - Take only the first line
 * - Trim to the last whole word that fits within `max` chars
 *
 * Shared by the page generator here and the session generator in `chat.ts`.
 */
export function sanitizeTitle(raw: string, max = 48): string {
  // First line only — the model sometimes emits a title + explanation.
  let t = raw.split(/\r?\n/)[0] ?? ''
  // Strip common markdown markers without touching the actual words.
  t = t
    .replace(/\*\*(.+?)\*\*/g, '$1') // bold
    .replace(/\*(.+?)\*/g, '$1') // italic
    .replace(/_(.+?)_/g, '$1') // italic underscore
    .replace(/`(.+?)`/g, '$1') // inline code
    .replace(/^#+\s*/, '') // leading heading
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '') // enclosing quotes
    .replace(/[.?!,;:]+$/, '') // trailing punctuation
    .trim()
  if (t.length <= max) return t
  // Word-boundary trim: cut at the last space before `max`, falling back
  // to a hard cut if there's no space.
  const slice = t.slice(0, max)
  const lastSpace = slice.lastIndexOf(' ')
  return (lastSpace > max / 2 ? slice.slice(0, lastSpace) : slice).trim()
}

/**
 * Derive a comment-thread's list label from its first comment's body text.
 *
 * Unlike {@link generatePageTitle}, this is deterministic and model-free: a
 * comment is short and usually imperative ("Group by owner instead?"), so its
 * opening line already reads as a title — we take the first line, strip
 * markdown, and trim to a word boundary (reusing {@link sanitizeTitle}). The
 * comment index (`comment-thread-list.tsx`) shows it so a page-level
 * (un-anchored) thread reads as what it's ABOUT instead of a generic
 * "Comments"; an anchored thread still prefers its `quote`, falling back to
 * this when the quote is empty.
 *
 * `max` is looser than a page title's 48 — the row truncates with CSS, and a
 * few extra words help tell sibling threads apart. Returns `null` for an empty
 * / whitespace body so the caller falls through to the generic label.
 */
export function deriveCommentTitle(body: string, max = 90): string | null {
  const cleaned = sanitizeTitle(body, max)
  return cleaned || null
}

/**
 * Generate a page title from its body plaintext. Returns `title: null` when
 * the excerpt is empty or the model can't produce a meaningful (≥3-word)
 * title and there's no usable fallback — callers keep the placeholder rather
 * than overwrite it. `usage`/`model` are returned even on the null path so
 * the caller can attribute the overhead cost.
 *
 * Guardrails mirror the session generator: a 600-char excerpt cap (a title
 * needs the opening, not the whole doc), `maxTokens: 32`, low temperature.
 */
export async function generatePageTitle(
  provider: LLMProvider,
  plaintext: string,
): Promise<GenerateTitleResult> {
  const excerpt = plaintext.replace(/\s+/g, ' ').trim().slice(0, 600)
  if (!excerpt) return { title: null, icon: null, usage: null, model: null }

  let rawTitle = ''
  let usage: TokenUsage | null = null
  for await (const chunk of provider.stream({
    model: TITLE_MODEL,
    systemPrompt: PAGE_TITLE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: excerpt }] as Message[],
    maxTokens: 32,
    temperature: 0.2,
  })) {
    if (chunk.type === 'text_delta') rawTitle += chunk.text
    if (chunk.type === 'message_end') usage = chunk.usage
  }

  // The model leads with a representative emoji, then the title. Peel the
  // emoji off (kept even when we fall back to a document-derived title); the
  // rest goes through the same cleanup as before. A missing emoji → `icon`
  // null, leaving the placeholder's generic glyph in place.
  const { icon, rest } = extractLeadingEmoji(rawTitle)
  const cleaned = sanitizeTitle(rest)
  const cleanedWords = cleaned.split(/\s+/).filter(Boolean).length
  // A solid multi-word title — use it.
  if (cleanedWords >= 3) return { title: cleaned, icon, usage, model: TITLE_MODEL }

  // Thin model output (0–2 words) — prefer deriving a fuller title from the
  // document opening; sanitizeTitle caps the length at a word boundary.
  const fallback = sanitizeTitle(excerpt)
  if (fallback.split(/\s+/).filter(Boolean).length >= 2) {
    return {
      title: fallback.charAt(0).toUpperCase() + fallback.slice(1),
      icon,
      usage,
      model: TITLE_MODEL,
    }
  }

  // Last resort: keep a 2-word model title; anything thinner (a lone word or
  // empty) isn't worth committing — leave the placeholder. A page title should
  // be descriptive, so we're stricter here than the session-title generator.
  // No title → no icon (don't decorate a page we're leaving untitled).
  if (cleanedWords >= 2) return { title: cleaned, icon, usage, model: TITLE_MODEL }
  return { title: null, icon: null, usage, model: TITLE_MODEL }
}
