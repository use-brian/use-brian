/**
 * Post-turn session-state diff pass.
 *
 * Safety net that mirrors `extractMemoriesBeforeCompaction` in
 * `packages/core/src/compaction/compact.ts` — one cheap Standard-tier call,
 * examines the latest user+assistant exchange against the current set of
 * open commitments, and emits JSON with two lists:
 *
 *   { "upserts": [{ "key", "summary", "detail"? }, ...],
 *     "resolves": [{ "key" }, ...] }
 *
 * The caller invokes this fire-and-forget after a `turn_complete` event so
 * commitments the model forgot to track with `trackCommitment` are caught
 * before the next turn starts. Deduped against `openCommitments` so
 * unchanged rows don't get re-upserted.
 *
 * On any failure (provider error, non-JSON output, schema mismatch) the
 * function returns zero counts and the caller logs `session_state_diff_failed`.
 *
 * See `docs/architecture/context-engine/session-state.md`.
 */

import type { LLMProvider, Message, TokenUsage } from '../providers/types.js'
import { collectStream } from '../providers/accumulator.js'
import type {
  SessionStateRecord,
  SessionStateStore,
} from './session-state-types.js'

const DIFF_PROMPT_PREAMBLE = `You are a session-state differ. Your job is to spot multi-turn commitments that a companion assistant is expected to remember across turns, and to flip already-tracked commitments to resolved when the user confirms completion or cancels them.

A "commitment" is something the user is relying on the assistant to carry across turns — not every passing mention. Examples:
- the user asks to be nagged until they confirm taking medicine
- the user asks to hold a decision open ("pick a restaurant later")
- the user asks for a follow-up at a specific time
- the user says "remember this for tonight"

Output ONE JSON object with exactly two fields, and NOTHING else (no markdown, no prose):
{
  "upserts":  [ { "key": "<kind:id>", "summary": "<one-line>", "detail": "<optional>" } ],
  "resolves": [ { "key": "<kind:id>" } ]
}

Key shape: "kind:identifier". Reuse an existing key from the OPEN COMMITMENTS list when you are resolving it or updating its summary — NEVER invent a new key for something that is already tracked. Prefer stable identifiers (dates, slugs) over free text.

If there are no changes, return {"upserts":[],"resolves":[]}.`

export type RunSessionStateDiffOptions = {
  provider: LLMProvider
  /** Cheap model — Standard tier (Gemini 3.1 Flash Lite). */
  model: string
  sessionId: string
  userId: string
  assistantId: string
  store: SessionStateStore
  /** The latest user turn + assistant response (and their tool calls). */
  recentTurns: Message[]
  /** Current open set — used as dedup prior. */
  openCommitments: SessionStateRecord[]
  /**
   * Active scheduled-job IDs for this user. Upserts whose key collides
   * with one of these are dropped — recurring policy already lives on
   * the job row and re-tracking it as a session commitment is the
   * pill-leak failure mode (see docs/architecture/context-engine/session-state.md
   * → "Diff-pass filters"). Pass an empty array if not available.
   */
  activeJobIds?: string[]
}

/**
 * Recurrence keywords. Upserts whose summary contains any of these are
 * dropped — recurring policies belong on `scheduled_jobs`, not
 * session_state. The list is intentionally short and conservative; the
 * heuristic is meant to catch obvious drift, not classify all language.
 */
const RECURRENCE_KEYWORDS = [
  'daily', 'every day', 'each day',
  'weekly', 'every week', 'each week',
  'monthly', 'every month', 'each month',
  'every morning', 'every evening', 'every night',
  'recurring', 'recurrent',
]

function looksLikeRecurringPolicy(summary: string): boolean {
  const lower = summary.toLowerCase()
  return RECURRENCE_KEYWORDS.some((kw) => lower.includes(kw))
}

function collidesWithActiveJob(key: string, activeJobIds: string[]): boolean {
  if (activeJobIds.length === 0) return false
  // Either the key IS the job id (rare but possible) or it embeds it
  // after a kind prefix like `reminder:<jobId>` / `job:<jobId>`.
  const tail = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key
  return activeJobIds.some((id) => key === id || tail === id || tail.startsWith(`${id}:`))
}

/**
 * Sum two token-usage records. Keeps overhead accounting honest when
 * the diff call is retried — both attempts are billed. Returns null
 * only when neither attempt reached the provider.
 */
function addUsage(
  a: TokenUsage | null,
  b: TokenUsage | null,
): TokenUsage | null {
  if (!a) return b
  if (!b) return a
  const cacheRead =
    a.cacheReadTokens != null || b.cacheReadTokens != null
      ? (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0)
      : undefined
  const cacheWrite =
    a.cacheWriteTokens != null || b.cacheWriteTokens != null
      ? (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0)
      : undefined
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  }
}

export type SessionStateDiffResult = {
  upserts: number
  resolves: number
  /** Non-null when the LLM call reached the provider (even if parsing failed). */
  usage: TokenUsage | null
  model: string | null
  errorMessage?: string
}

type DiffUpsert = { key: string; summary: string; detail?: string }
type DiffResolve = { key: string }
type DiffOutput = { upserts?: DiffUpsert[]; resolves?: DiffResolve[] }

export async function runSessionStateDiff(
  opts: RunSessionStateDiffOptions,
): Promise<SessionStateDiffResult> {
  if (opts.recentTurns.length === 0) {
    return { upserts: 0, resolves: 0, usage: null, model: null }
  }

  const openList = opts.openCommitments.length > 0
    ? opts.openCommitments
        .map(
          (r) =>
            `- [${r.status}] ${r.key} — ${r.summary}${r.detail ? ` (${r.detail})` : ''}`,
        )
        .join('\n')
    : '(none)'

  const directive = `OPEN COMMITMENTS (current state, do not re-emit as upsert unless summary genuinely changed):\n${openList}\n\nReturn the JSON object now.`

  // One Standard-tier call + parse attempt. Returns the parsed diff, or
  // null with an `errorMessage` naming why it failed: a hard provider
  // error, an empty/garbled `no-json` body, or a malformed-JSON parse throw.
  async function callAndParse(): Promise<{
    parsed: DiffOutput | null
    usage: TokenUsage | null
    errorMessage?: string
  }> {
    try {
      const response = await collectStream(
        opts.provider.stream({
          model: opts.model,
          systemPrompt: DIFF_PROMPT_PREAMBLE,
          messages: [
            ...opts.recentTurns,
            { role: 'user', content: directive },
          ],
          maxTokens: 1_000,
          temperature: 0.1,
        }),
      )

      const text = response.content
        .filter((b) => b.type === 'text')
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('')

      const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()
      const match = cleaned.match(/\{[\s\S]*\}/)
      if (!match) {
        return { parsed: null, usage: response.usage, errorMessage: 'no-json' }
      }
      return {
        parsed: JSON.parse(match[0]) as DiffOutput,
        usage: response.usage,
      }
    } catch (err) {
      return {
        parsed: null,
        usage: null,
        errorMessage: err instanceof Error ? err.message : 'unknown',
      }
    }
  }

  // The Standard-tier diff call occasionally returns an empty / non-JSON
  // body — a thinking-budget truncation or a transient empty completion
  // drops the JSON entirely. One retry recovers that common transient
  // case; a genuine repeatable failure still surfaces as
  // `session_state_diff_failed`. Usage from both attempts is summed so
  // the caller's overhead-usage accounting stays honest.
  let result = await callAndParse()
  let usage: TokenUsage | null = result.usage
  if (!result.parsed) {
    const retry = await callAndParse()
    usage = addUsage(usage, retry.usage)
    result = retry
  }
  const parsed = result.parsed
  const errorMessage = result.errorMessage

  if (!parsed) {
    return {
      upserts: 0,
      resolves: 0,
      usage,
      model: usage ? opts.model : null,
      errorMessage,
    }
  }

  const openByKey = new Map(opts.openCommitments.map((r) => [r.key, r]))
  const activeJobIds = opts.activeJobIds ?? []
  let upsertCount = 0
  let resolveCount = 0

  for (const u of parsed.upserts ?? []) {
    if (!u || typeof u.key !== 'string' || typeof u.summary !== 'string') continue
    if (u.key.length === 0 || u.key.length > 200) continue
    if (u.summary.length === 0 || u.summary.length > 400) continue

    // Filter: drop upserts that re-state policy already owned by a
    // scheduled_jobs row. The pill-leak failure mode was the diff pass
    // creating `reminder:pill_taking` to mirror an existing daily cron.
    if (collidesWithActiveJob(u.key, activeJobIds)) continue
    if (looksLikeRecurringPolicy(u.summary)) continue

    // Dedupe: skip if key + summary already match an open row.
    const existing = openByKey.get(u.key)
    if (
      existing &&
      existing.summary === u.summary &&
      (existing.detail ?? '') === (u.detail ?? '')
    ) {
      continue
    }

    try {
      await opts.store.upsert({
        sessionId: opts.sessionId,
        userId: opts.userId,
        assistantId: opts.assistantId,
        key: u.key,
        summary: u.summary,
        detail: u.detail ?? null,
        source: 'diff-pass',
      })
      upsertCount += 1
    } catch {
      // Individual row failure shouldn't abort the rest of the diff.
    }
  }

  for (const r of parsed.resolves ?? []) {
    if (!r || typeof r.key !== 'string' || r.key.length === 0) continue
    // Only resolve keys we currently have open — don't fabricate resolutions.
    if (!openByKey.has(r.key)) continue

    try {
      const resolved = await opts.store.resolve({
        sessionId: opts.sessionId,
        key: r.key,
        source: 'diff-pass',
      })
      if (resolved) resolveCount += 1
    } catch {
      // Per-row, non-fatal.
    }
  }

  return {
    upserts: upsertCount,
    resolves: resolveCount,
    usage,
    model: usage ? opts.model : null,
    errorMessage,
  }
}
