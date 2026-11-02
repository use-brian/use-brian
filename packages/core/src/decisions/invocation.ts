/** Terminal decision deadlines, including admission. [COMP:decisions/hydra] */
import { DecisionProviderError } from './types.js'
import { assertInputAuthority } from '../providers/input-authority.js'
import { sharesClassifierCompletionAdmission, transferClassifierDecisionCheck } from './authority-ownership.js'

/** Finite host ceiling; operator profiles and caller deadlines may only narrow it. */
export const DECISION_INVOCATION_MAX_MS = 120_000

/** An injected runtime may narrow admission, never replace the caller's check. */
export function decisionCompletionInput(
  context: { signal: AbortSignal; request: { assertInputAuthority?: () => Promise<void> } },
  original: { signal?: AbortSignal; assertInputAuthority?: () => Promise<void> },
): { signal: AbortSignal; assertInputAuthority(): Promise<void> } {
  const signal = original.signal ? AbortSignal.any([context.signal, original.signal]) : context.signal
  const current = context.request.assertInputAuthority
  const prior = original.assertInputAuthority
  const check = async () => {
    signal.throwIfAborted()
    await assertInputAuthority(current)
    signal.throwIfAborted()
    if (prior !== current && !sharesClassifierCompletionAdmission(current, prior)) await assertInputAuthority(prior)
    signal.throwIfAborted()
  }
  if (sharesClassifierCompletionAdmission(current, prior)) transferClassifierDecisionCheck(current, check)
  return { signal, assertInputAuthority: check }
}

export async function withDecisionInvocation<T>(options: {
  signal?: AbortSignal
  deadlineAt?: number
  now?: () => number
  call(context: {
    signal: AbortSignal
    assertActive(): void
    tightenDeadline(deadlineAt: number): void
  }): Promise<T>
}): Promise<T> {
  const now = options.now ?? Date.now
  const controller = new AbortController()
  let deadline = options.deadlineAt
  let terminal: DecisionProviderError | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let rejectInterrupted!: (reason: DecisionProviderError) => void
  const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject })
  const interrupt = (kind: 'timeout' | 'cancelled') => {
    if (terminal) return
    terminal = new DecisionProviderError(kind, kind === 'timeout' ? 'decision invocation deadline exhausted' : 'decision invocation cancelled')
    controller.abort(terminal)
    rejectInterrupted(terminal)
  }
  const assertActive = () => {
    if (options.signal?.aborted) interrupt('cancelled')
    if (deadline !== undefined && now() >= deadline) interrupt('timeout')
    if (terminal) throw terminal
  }
  const arm = () => {
    if (timer !== undefined) clearTimeout(timer)
    if (deadline !== undefined) timer = setTimeout(() => interrupt('timeout'), Math.max(0, deadline - now()))
  }
  const onAbort = () => interrupt('cancelled')
  options.signal?.addEventListener('abort', onAbort, { once: true })
  arm()
  // Attach the race before checking an already-expired/aborted invocation.
  const work = Promise.resolve().then(async () => {
    assertActive()
    const value = await options.call({ signal: controller.signal, assertActive, tightenDeadline: value => {
      deadline = Math.min(deadline ?? Infinity, value)
      arm(); assertActive()
    } })
    assertActive()
    return value
  })
  try { return await Promise.race([work, interrupted]) }
  finally {
    if (timer !== undefined) clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}
