/**
 * In-page comment-thread discovery — the prompt section.
 *
 * `formatThreadDiscovery` renders a compact, metadata-only index of a page's
 * comment threads, injected into the doc system prompt alongside the page
 * outline (see `packages/api/src/routes/chat.ts`). It lets the AI KNOW a thread
 * exists and what it's about without reading the conversation; it pulls the
 * actual messages on demand via the `getCommentThread` tool.
 *
 * Surface-scoped (the caller picks the variant):
 *   - `chat`   — floating dock / Space→AI: list ALL threads on the page.
 *   - `thread` — a comment reply turn: list all threads EXCEPT the one being
 *                replied in (excluded by `currentSessionId`).
 *
 * Pure + deterministic (inject `now` in tests). Returns '' when there's nothing
 * to show, so the caller can skip the injection entirely.
 *
 * [COMP:doc/comment-discovery]
 */

import type { CommentThreadSummary } from './comment-types.js'

export type ThreadDiscoveryVariant = 'chat' | 'thread'

export type ThreadDiscoveryOptions = {
  variant: ThreadDiscoveryVariant
  /** The current turn's session id; the thread it backs is excluded (thread variant). */
  currentSessionId?: string
  /** Clock injection point for deterministic tests. Defaults to now. */
  now?: Date
}

/** Open threads are unbounded; cap the list so the prompt stays compact. */
const OPEN_CAP = 30
/** Anchor-quote length in the index line. */
const QUOTE_MAX = 80

function formatRelative(iso: string | null, now: Date): string | null {
  if (!iso) return null
  const then = new Date(iso).getTime()
  const diffMs = now.getTime() - then
  if (!Number.isFinite(diffMs) || diffMs < 0) return 'just now'
  const min = Math.floor(diffMs / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

function scopeLabel(t: CommentThreadSummary): string {
  const where = t.anchorBlockId ? `block ${t.anchorBlockId}` : 'page-level'
  if (!t.quote) return where
  const quote = t.quote.replace(/\s+/g, ' ').trim().slice(0, QUOTE_MAX)
  return quote ? `${where} "${quote}"` : where
}

function line(t: CommentThreadSummary, now: Date): string {
  const parts = [t.id, scopeLabel(t), `${t.messageCount} msg${t.messageCount === 1 ? '' : 's'}`]
  const rel = formatRelative(t.lastActivityAt, now)
  if (rel) parts.push(`last ${rel}`)
  return `- ${parts.join(' · ')}`
}

export function formatThreadDiscovery(
  summaries: CommentThreadSummary[],
  opts: ThreadDiscoveryOptions,
): string {
  const now = opts.now ?? new Date()
  const visible = summaries.filter((t) => t.sessionId !== opts.currentSessionId)
  if (visible.length === 0) return ''

  const open = visible.filter((t) => !t.resolvedAt)
  const resolved = visible.filter((t) => t.resolvedAt)

  const header =
    opts.variant === 'thread'
      ? '# Other comment threads on this page'
      : '# Comment threads on this page'
  const intro =
    'Discovery metadata only — NOT the conversations. ' +
    (opts.variant === 'thread'
      ? "These are the page's other threads, besides the one you're replying in. "
      : '') +
    'When a thread is relevant to what you are doing, call `getCommentThread({ threadId })` to read it. ' +
    "Don't re-ask a question an open thread already covers, and don't reopen a resolved one."

  const sections: string[] = [header, intro]

  if (open.length > 0) {
    const shown = open.slice(0, OPEN_CAP)
    const lines = shown.map((t) => line(t, now))
    if (open.length > OPEN_CAP) lines.push(`- …and ${open.length - OPEN_CAP} more open`)
    sections.push(['Open:', ...lines].join('\n'))
  }
  if (resolved.length > 0) {
    sections.push(['Resolved (latest 10):', ...resolved.map((t) => line(t, now))].join('\n'))
  }

  return sections.join('\n\n')
}
