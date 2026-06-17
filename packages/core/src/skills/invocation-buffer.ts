/**
 * Per-turn skill invocation buffer (CL-8).
 *
 * Tracks which skills the model picked via `useSkill` during a single
 * turn. Flushed after the assistant message commits to update the
 * `succeeded` counter on `workspace_skills`.
 *
 * Mirrors the recall-buffer pattern in `../memory/recall-buffer.ts`:
 * push during the turn, flush at a single safe point post-commit.
 *
 * **Counter ownership**:
 *
 *   - `invocations` + `last_invoked_at` — bumped *immediately* inside
 *     `useSkill.execute` (via the `recordInvocation` callback passed to
 *     the tool factory). They're cumulative pick-counters that should
 *     fire on every successful resolution, regardless of how the turn
 *     ends. The synchronous bump also unlocks the stale → active
 *     reactivation handled by `WorkspaceSkillStore.recordInvocation`.
 *
 *   - `succeeded` — incremented here, post-commit, only for turns that
 *     completed without a provider error and without an immediate user
 *     retry. Requires turn outcome, so it can't fire from inside the
 *     tool itself.
 *
 *   - `user_corrected_after` — **deferred to a follow-up** per the
 *     plan. Cross-turn detection (matching a correction phrase in the
 *     *next* user message against the *prior* turn's invoked skills)
 *     needs state persisted across turns; not in V1 scope. The decay
 *     rule that depends on it (`user_corrected_after ≥ 3`) just stays
 *     at 0 — same as no signal observed.
 *
 * The store sink interface is injected so this module stays free of
 * DB / `pg` dependencies. The chat route plugs in a thin adapter over
 * `WorkspaceSkillStore.incrementSucceeded` / `incrementUserCorrectedAfter`.
 *
 * See `docs/architecture/context-engine/memory-consolidation.md` → "Skill invocation
 * feedback (CL-8 lock)".
 *
 * [COMP:skills/invocation-buffer]
 */

/**
 * Minimal interface needed from the workspace-skill store. Match the
 * concrete signatures in
 * `packages/api/src/db/skill-store.ts → WorkspaceSkillStore`.
 *
 * `userCorrectedAfter` is wired through the type even though V1 does
 * not call it — the buffer is shaped to absorb the cross-turn signal
 * once a follow-up lands without an interface break.
 */
export type SkillInvocationSink = {
  incrementSucceeded(skillId: string): Promise<void>
  incrementUserCorrectedAfter(skillId: string): Promise<void>
}

export type SkillInvocationOutcome = 'success' | 'error'

export type SkillInvocationBufferOptions = {
  sink: SkillInvocationSink
  /**
   * Optional override for the correction heuristic. Production code
   * uses the default `detectCorrection`; tests can inject deterministic
   * truth-table fixtures.
   */
  detectCorrection?: (msg: string) => boolean
}

export type SkillInvocationBuffer = {
  /**
   * Queue one skill row id. Cheap — adds to an in-memory set so
   * duplicate picks within the same turn dedupe.
   *
   * Built-in skills (loaded from disk, no `workspace_skills` row) MUST
   * NOT be pushed here — the caller is responsible for that filter
   * since the buffer takes whatever id its sink expects.
   */
  addInvocation(skillRowId: string): void

  /** Read-only view of buffered rows; useful for tests + instrumentation. */
  getInvocations(): readonly string[]

  /**
   * Persist buffered counters according to `outcome`:
   *
   *   - `'success'` → bumps `succeeded` for every buffered row id.
   *
   *   - `'error'`   → no DB writes (a failed turn should not credit
   *     the skill with a success).
   *
   * `getNextUserMessage` is a deferred lookup for the cross-turn
   * `user_corrected_after` signal; **not called in V1**. The hook is
   * shaped so a follow-up can wire it without a buffer signature
   * change.
   *
   * The buffer is emptied after `flush` regardless of outcome.
   * Errors from the sink propagate — the caller (chat route) catches
   * them and logs without failing the response.
   */
  flush(
    outcome: SkillInvocationOutcome,
    getNextUserMessage?: () => Promise<string | null>,
  ): Promise<void>

  /** Drop every queued invocation without writing. */
  clear(): void
}

export function createSkillInvocationBuffer(
  opts: SkillInvocationBufferOptions,
): SkillInvocationBuffer {
  const queued = new Set<string>()
  // Reserved for the deferred `user_corrected_after` path. The chat
  // route doesn't pass `getNextUserMessage` in V1, so this stays unset.
  // Declared on the closure to keep the future wire-up additive.
  const detect = opts.detectCorrection ?? detectCorrection
  // Reference `detect` so TS doesn't complain about an unused binding
  // before the V1.1 cross-turn wire-up lands.
  void detect

  return {
    addInvocation(skillRowId) {
      if (!skillRowId) return
      queued.add(skillRowId)
    },

    getInvocations() {
      return Array.from(queued)
    },

    async flush(outcome, getNextUserMessage) {
      const ids = Array.from(queued)
      // Empty before any await — same defensive pattern as the recall
      // buffer. A second flush sees nothing and no-ops.
      queued.clear()

      if (outcome === 'error') return

      // V1: bump `succeeded` for every invoked skill on clean completion.
      // Sequential awaits are fine — the buffer is tiny (typically 0–2
      // skill picks per turn) and the underlying UPDATE is a single
      // row each.
      for (const id of ids) {
        await opts.sink.incrementSucceeded(id)
      }

      // V1.1 — cross-turn correction detection. Intentionally a no-op
      // today. The shape is preserved so a future patch can populate
      // a `pending_correction_checks` row (or equivalent) keyed by the
      // freshly-flushed ids and consult `getNextUserMessage` once the
      // next user turn arrives.
      void getNextUserMessage
    },

    clear() {
      queued.clear()
    },
  }
}

/**
 * Lightweight "is this user message a correction?" heuristic.
 *
 * The detector intentionally errs toward false-negatives — better to
 * undercount corrections than to overcount them and demote a perfectly
 * good skill. The V1 decay rule (`user_corrected_after ≥ 3`) gives the
 * signal three independent chances to fire before any action is taken,
 * so a ~20% miss rate is tolerable.
 *
 * Detection: lowercase the first 80 characters, then look for any of a
 * small set of correction phrases that appear *near the start* of the
 * message. "Near the start" is enforced because messages like
 *
 *     "Could you do X? Wait actually do Y instead"
 *
 * are not a correction of the previous turn — they're a refinement
 * within the current ask. Only when the correction phrase opens the
 * message does it count.
 *
 * Phrases match on word boundaries — substring matches like "snowstop"
 * for "stop" would otherwise misfire.
 *
 * See `docs/architecture/context-engine/memory-consolidation.md` → "Skill invocation
 * feedback (CL-8 lock)" for the broader signal design.
 */
const CORRECTION_PHRASES: readonly string[] = [
  // Word-boundary aware. The regex builder below escapes none of these
  // because they're hard-coded — keep that invariant when adding new
  // phrases.
  'no',
  'not',
  'nope',
  'nah',
  'wrong',
  'stop',
  "don't",
  'dont',
  'incorrect',
  'actually',
  'instead',
  "that's wrong",
  'thats wrong',
  'not what i meant',
  "that's not",
  'thats not',
  'undo',
  'cancel',
]

// Anchor the match to the start of the trimmed message, allow at most
// a leading punctuation/whitespace burst, and require a word boundary
// after the phrase. Built once at module load.
const CORRECTION_REGEX = new RegExp(
  `^[\\s,.;:!\\-]*(?:${CORRECTION_PHRASES.map((p) =>
    // Escape regex metachars in the phrase. Apostrophes / spaces don't
    // need escaping but the build-time `replace` is cheap.
    p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  ).join('|')})\\b`,
  'i',
)

export function detectCorrection(message: string): boolean {
  if (!message) return false
  const head = message.slice(0, 80).trim()
  if (head.length === 0) return false
  return CORRECTION_REGEX.test(head)
}
