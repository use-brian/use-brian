/**
 * Session-state retrieval + system-prompt formatting.
 *
 * Given a session id, fetch open commitments (and, budget-permitting, the
 * most-recently-resolved ones) and format them into a
 * `# Open commitments` system-prompt block.
 *
 * Unlike `fetchEpisodicContext`, this is **unconditional** — it runs on
 * every turn regardless of the topic classifier's verdict. That's the
 * whole point of this tier: the model should not have to re-derive
 * whether today's pill is already confirmed by scanning raw history.
 *
 * Token budget: ~1000 tokens total. Open rows are always included first,
 * oldest-resolved rows are trimmed first on overflow.
 *
 * See `docs/architecture/context-engine/session-state.md`.
 */

import type {
  SessionStateRecord,
  SessionStateStore,
} from './session-state-types.js'

const ROUGH_CHARS_PER_TOKEN = 4
const DEFAULT_TOKEN_BUDGET = 1_000
const DEFAULT_RECENT_LIMIT = 50

export type BuildSessionStateBlockOptions = {
  store: SessionStateStore
  sessionId: string
  /** Defaults to 1000. */
  tokenBudget?: number
  /**
   * Injected so tests can pin the clock — resolved rows render a
   * "(resolved HH:MM)" suffix relative to this reference.
   */
  now?: Date
}

/**
 * Returns the fully-formatted block or `null` when the session has no
 * rows (block is omitted from the prompt entirely — `null` is the
 * "omit" signal for the prompt builder, matching `fetchEpisodicContext`).
 */
export async function buildSessionStateBlock(
  opts: BuildSessionStateBlockOptions,
): Promise<string | null> {
  const budget = opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET
  const now = opts.now ?? new Date()

  const recent = await opts.store.listRecentBySession(
    opts.sessionId,
    DEFAULT_RECENT_LIMIT,
  )
  if (recent.length === 0) return null

  const open = recent.filter((r) => r.status === 'open')
  const resolved = recent.filter((r) => r.status !== 'open')

  // Open rows are load-bearing; never trim. Trim resolved rows to fit.
  let rows: SessionStateRecord[] = [...open, ...resolved]
  let assembled = formatBlock(rows, now)
  while (
    estimateChars(assembled) > budget * ROUGH_CHARS_PER_TOKEN &&
    rows.length > open.length
  ) {
    rows = rows.slice(0, -1)
    assembled = formatBlock(rows, now)
  }

  return assembled
}

export type DeliveryConversationSession = {
  sessionId: string
  /** Rendered as a `Tracked by <name>` line when >1 session contributes. */
  assistantName?: string | null
}

export type BuildDeliveryConversationStateBlockOptions = {
  store: SessionStateStore
  /**
   * The sessions that make up the conversation a scheduled run delivers
   * into — one per assistant bound to that `(channel_type, channel_id)`.
   * Resolved by the caller (workspace-scoped); this builder only reads.
   */
  sessions: DeliveryConversationSession[]
  /** Defaults to 1000. */
  tokenBudget?: number
  now?: Date
}

/**
 * Read-only bridge for scheduled runs (workflow `assistant_call` steps and
 * scheduled-job reminders): the run's own session never holds rows, so it
 * reads the rows of the conversation it DELIVERS to instead. Same row
 * format and the same trim policy as `buildSessionStateBlock` (open rows
 * never trim; resolved rows trim oldest-first), but the preamble states the
 * bridged contract — the rows are tracked by the interactive conversation,
 * their bodies are data to read, and the run cannot resolve or edit them.
 *
 * Returns `null` when no session has rows (block omitted).
 *
 * See `docs/architecture/context-engine/session-state.md` →
 * "Delivery-conversation bridging".
 */
export async function buildDeliveryConversationStateBlock(
  opts: BuildDeliveryConversationStateBlockOptions,
): Promise<string | null> {
  const budget = opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET
  const now = opts.now ?? new Date()

  const groups: Array<{ label: string | null; rows: SessionStateRecord[] }> = []
  for (const session of opts.sessions) {
    const recent = await opts.store.listRecentBySession(
      session.sessionId,
      DEFAULT_RECENT_LIMIT,
    )
    if (recent.length === 0) continue
    groups.push({
      label: session.assistantName?.trim() || null,
      rows: [
        ...recent.filter((r) => r.status === 'open'),
        ...recent.filter((r) => r.status !== 'open'),
      ],
    })
  }
  if (groups.length === 0) return null

  // Trim resolved rows oldest-first across groups until the block fits.
  // Each group's rows are already ordered open-first, so dropping the last
  // row of the group with the most resolved rows never removes an open row.
  let assembled = formatDeliveryBlock(groups, now)
  while (estimateChars(assembled) > budget * ROUGH_CHARS_PER_TOKEN) {
    const candidate = groups
      .filter((g) => g.rows.some((r) => r.status !== 'open'))
      .sort((a, b) => resolvedCount(b.rows) - resolvedCount(a.rows))[0]
    if (!candidate) break
    candidate.rows = candidate.rows.slice(0, -1)
    assembled = formatDeliveryBlock(groups, now)
  }
  return assembled
}

function resolvedCount(rows: SessionStateRecord[]): number {
  return rows.filter((r) => r.status !== 'open').length
}

function formatDeliveryBlock(
  groups: Array<{ label: string | null; rows: SessionStateRecord[] }>,
  now: Date,
): string {
  const multi = groups.length > 1
  const sections: string[] = []
  for (const g of groups) {
    const lines = g.rows.map((r) => formatRow(r, now))
    sections.push(multi && g.label ? `Tracked by ${g.label}:\n${lines.join('\n')}` : lines.join('\n'))
  }
  return (
    '# Open commitments (delivery conversation)\n\n' +
    'This run delivers into an ongoing conversation. The rows below are the commitments and ' +
    'tracked state that conversation is keeping (recorded there by its assistant); they are ' +
    'the authoritative current state of that conversation and their bodies are data you may read ' +
    'and report on. Rely on `[open]` rows before you nag, follow up, or remind the user about them. ' +
    'Treat `[resolved]` rows as already done and do NOT re-issue follow-ups for them. ' +
    'You cannot resolve or edit these rows from here; the interactive conversation owns them.\n\n' +
    sections.join('\n\n')
  )
}

function formatBlock(rows: SessionStateRecord[], now: Date): string {
  const lines: string[] = []
  for (const r of rows) {
    lines.push(formatRow(r, now))
  }
  return (
    '# Open commitments\n\n' +
    'The following are commitments or tasks tracked in this session. ' +
    'Rely on `[open]` rows as authoritative current state before you nag, ' +
    'follow up, or remind the user about them. ' +
    'Treat `[resolved]` rows as already done — do NOT re-issue follow-ups for them.\n\n' +
    lines.join('\n')
  )
}

function formatRow(r: SessionStateRecord, now: Date): string {
  const status =
    r.status === 'open'
      ? `[open, updated ${formatStamp(r.updatedAt, now)}]`
      : r.status === 'resolved'
        ? `[resolved ${formatStamp(r.resolvedAt ?? r.updatedAt, now)}]`
        : `[cancelled ${formatStamp(r.resolvedAt ?? r.updatedAt, now)}]`

  const detail = r.detail ? ` · ${r.detail.trim()}` : ''
  return `- ${status} \`${r.key}\` — ${r.summary.trim()}${detail}`
}

function formatStamp(ts: Date, now: Date): string {
  // Relative if within 24h (HH:MM), else date.
  const diffMs = now.getTime() - ts.getTime()
  if (diffMs < 24 * 60 * 60 * 1000 && diffMs >= -60_000) {
    const hh = String(ts.getUTCHours()).padStart(2, '0')
    const mm = String(ts.getUTCMinutes()).padStart(2, '0')
    return `${hh}:${mm} UTC`
  }
  return ts.toISOString().slice(0, 10)
}

function estimateChars(s: string): number {
  return s.length
}
