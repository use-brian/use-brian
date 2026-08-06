/**
 * Mid-turn input — the port a running `queryLoop` reads to pick up messages
 * the user sent WHILE the turn was working, plus the framing that hands them
 * to the model.
 *
 * The loop owns *when* to look (three drain points; see `query-loop.ts` and
 * docs/architecture/engine/mid-turn-input.md). This module owns the vocabulary,
 * the framing, and the two pure decisions the loop needs — so both are testable
 * without a provider, a session, or a socket.
 *
 * `[COMP:engine/turn-inbox]`
 */

/**
 * How urgently the sender wants the running turn to take this message.
 *
 * - `queued` — take it at the next safe boundary. The assistant finishes the
 *   step it is on.
 * - `steer` — the user is redirecting. Take it at the next boundary AND
 *   interrupt the in-flight model response when interrupting is free (nothing
 *   user-visible has streamed yet this turn).
 */
export type MidTurnInputMode = 'queued' | 'steer'

/** One message waiting for the running turn to take it. */
export type PendingTurnInput = {
  /** Client-minted id. The inbox dedupes on it, so a later steer for an
   *  already-queued message upgrades that entry instead of adding one. */
  id: string
  text: string
  mode: MidTurnInputMode
  /**
   * Display name of the sender. Present only where a session has more than one
   * human in it — a 1:1 chat leaves it unset rather than telling the model its
   * own user's name twice.
   */
  from?: string
  /** Arrival order. Drains emit oldest-first. */
  receivedAt: number
}

/** Cheap synchronous state read. Called at every boundary, so it must stay O(1). */
export type TurnInboxPeek = {
  /** Anything waiting at all. */
  pending: boolean
  /** At least one waiting input asked to be expedited. */
  steer: boolean
}

/**
 * The seam between the engine and whatever holds queued messages. The chat
 * route backs it with an in-memory registry fed by a `turn_input` pg NOTIFY
 * channel (`packages/api/src/turn-inbox.ts`); tests back it with an array.
 *
 * Both methods are synchronous by contract. The loop peeks between stream
 * chunks — a promise there would add an await to the hottest path in the
 * engine for a lookup that is a map read.
 */
export type TurnInboxPort = {
  peek(): TurnInboxPeek
  /** Take everything waiting, oldest-first, and clear it. */
  drain(): PendingTurnInput[]
}

/**
 * Budget for one drained block. A user can queue as many messages as they can
 * type, and a paste storm must not be able to blow the context window mid-turn
 * — the newest inputs are the ones that matter, so overflow drops the oldest.
 */
export const MID_TURN_INPUT_MAX_CHARS = 8_000

const QUEUED_DIRECTIVE =
  'The user sent this while you were working. Finish or adapt what you are doing as appropriate, then address it. Do not redo work you have already completed.'

const STEER_DIRECTIVE =
  'The user is redirecting you. Treat this as the current instruction: drop what no longer applies, keep what still does, and act on it now.'

/**
 * The stronger mode wins for the block as a whole: if any waiting message asked
 * to be expedited, the user has redirected and the whole drain is a steer.
 */
export function resolveDrainMode(inputs: readonly PendingTurnInput[]): MidTurnInputMode {
  return inputs.some((i) => i.mode === 'steer') ? 'steer' : 'queued'
}

/**
 * Neutralise anything in user text that would close or forge the envelope.
 * The envelope is a framing device, not a security boundary — the provenance
 * rule (this content rides in the USER role, never the trusted system channel)
 * is what actually keeps authority straight. This just stops a message that
 * happens to contain the tag from making the block unparseable to the model.
 */
function neutralizeEnvelope(text: string): string {
  return text.replace(/<(\/?)mid-turn-message/gi, '&lt;$1mid-turn-message')
}

/**
 * Build the user-role text block for a drained set of inputs.
 *
 * Ordering is oldest-first so the model reads the corrections in the order they
 * were typed. The trailing directive is mode-dependent and deliberately
 * concrete about what NOT to do — a bare injected message reliably makes the
 * model restart work it had already finished.
 */
export function formatMidTurnInput(inputs: readonly PendingTurnInput[]): string {
  if (inputs.length === 0) return ''
  const mode = resolveDrainMode(inputs)
  const ordered = [...inputs].sort((a, b) => a.receivedAt - b.receivedAt)

  // Fit newest-first, then restore chronological order — overflow must drop
  // the oldest, since the newest message is the one the user is waiting on.
  const kept: string[] = []
  let budget = MID_TURN_INPUT_MAX_CHARS
  let omitted = 0
  for (let i = ordered.length - 1; i >= 0; i--) {
    const input = ordered[i]
    const attrs = input.from ? ` from=${JSON.stringify(input.from)}` : ''
    const open = `<mid-turn-message mode="${input.mode}"${attrs}>`
    const close = '</mid-turn-message>'
    const overhead = open.length + close.length + 2
    if (budget - overhead <= 0) {
      omitted = i + 1
      break
    }
    const room = budget - overhead
    const body = neutralizeEnvelope(input.text)
    const clipped = body.length > room ? `${body.slice(0, Math.max(0, room - 3))}...` : body
    kept.push(`${open}\n${clipped}\n${close}`)
    budget -= overhead + clipped.length
  }
  kept.reverse()

  const lines: string[] = []
  if (omitted > 0) {
    lines.push(
      `[${omitted} earlier message${omitted === 1 ? '' : 's'} the user sent during this turn ${omitted === 1 ? 'was' : 'were'} omitted for length]`,
    )
  }
  lines.push(...kept)
  lines.push(mode === 'steer' ? STEER_DIRECTIVE : QUEUED_DIRECTIVE)
  return lines.join('\n')
}

/**
 * Should the loop break out of the model stream RIGHT NOW to take a steer?
 *
 * The rule, and the reason it is a rule rather than a preference: you cannot
 * unstream a chunk. Once a `text_delta` / `tool_start` / `citation` has reached
 * the consumer, abandoning the turn leaves a half-answer on screen that the
 * transcript will never contain, and the user cannot tell it from a crash. So a
 * steer that arrives after visible output degrades to the next boundary — where
 * it is taken anyway, one step later.
 *
 * `hasYieldedUserVisibleOutput` is the same variable that gates the transient
 * stream retry, for the same reason. Keep them on the same signal.
 */
export function shouldInterruptStreamForSteer(params: {
  peek: TurnInboxPeek
  hasYieldedUserVisibleOutput: boolean
}): boolean {
  if (!params.peek.pending || !params.peek.steer) return false
  return !params.hasYieldedUserVisibleOutput
}
