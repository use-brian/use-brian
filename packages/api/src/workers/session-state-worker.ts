/** Durable commitment analysis outside the chat lease. [COMP:api/session-state-jobs] */
import {
  accessCeilingContains, bindScopeSources, boundScopeSources, runSessionStateDiff,
  type LLMProvider, type Message, type SessionContextAuthority, type SessionStateStore,
} from '@use-brian/core'
import { claimSessionStateJob, finishSessionStateJob, parseSessionStateJobAuthority, sessionStateJobCurrent, type SessionStateJob } from '../db/session-state-jobs.js'
import { resolveSessionTitleAuthority } from '../routes/session-title-authority.js'
import { readAdmittedSessionQuery } from '../db/session-query-reader.js'
import { createDbSessionStateStore } from '../db/session-state-store.js'
import { sessionContextGeneration } from '../db/session-context-revisions.js'
import { upsertSessionState, resolveSessionState } from '../db/session-state-queries.js'
import { assertSourceModelInputAuthority } from '../application-platform/model-source-authority.js'
import { executionToolContext } from '@use-brian/core'
import { inheritPrivateTranscriptCredential } from '../db/private-transcript.js'

type Runtime = { provider: LLMProvider; model: string; providerKeySource: 'user' | 'platform' }
type Result = Awaited<ReturnType<typeof runSessionStateDiff>>
class StateJobChanged extends Error {
  readonly reason = 'authority_changed'
  constructor() { super('state_job_changed') }
}

/** A queued ceiling restricts newly admitted authority; it never grants access. */
export function restrictStateJobAuthority(authority: SessionContextAuthority, job: SessionStateJob,
  current: () => Promise<boolean>, signal: AbortSignal): SessionContextAuthority {
  const { authoring } = parseSessionStateJobAuthority(job), execution = authority.execution, original = execution.security.authority
  if (execution.lifecycle.sessionId !== job.sessionId || execution.assistant.id !== job.assistantId
    || execution.security.access.userId !== job.actorUserId || execution.security.access.workspaceId !== job.workspaceId
    || !accessCeilingContains(execution.security.ceiling, authoring.ceiling)
    || !accessCeilingContains(authoring.ceiling, execution.security.ceiling)) throw new StateJobChanged()
  const assertCurrent = async () => {
    signal.throwIfAborted()
    await original.assertCurrent()
    if (!await current()) throw new StateJobChanged()
    signal.throwIfAborted()
  }
  const restricted: SessionContextAuthority = { accumulator: authority.accumulator, execution: { ...execution,
    lifecycle: { ...execution.lifecycle, abortSignal: signal },
    security: { ...execution.security, authority: { ...original, assertCurrent,
      async execute<T>(operation: () => Promise<T>): Promise<T> {
        await assertCurrent()
        const result = await original.execute(operation)
        await assertCurrent()
        return result
      },
    } },
  } }
  inheritPrivateTranscriptCredential(execution, restricted.execution)
  return restricted
}

/** Keep the pre-inference generation through the actual SQL CAS, not a preflight. */
export function backgroundSessionStateStore(generation: string,
  deps = { base: createDbSessionStateStore(), upsert: upsertSessionState, resolve: resolveSessionState }): SessionStateStore {
  let expectedGeneration = generation
  const write = async <T>(operation: () => Promise<T>, changed: (result: T) => boolean): Promise<T> => {
    try {
      const result = await operation()
      if (changed(result)) expectedGeneration = (BigInt(expectedGeneration) + 1n).toString()
      return result
    } catch (error) {
      // Core's best-effort per-row handling must not swallow a stale CAS.
      throw Object.assign(new Error('state_diff_write_refused', { cause: error }), { reason: 'authority_changed' })
    }
  }
  return { ...deps.base,
    upsert: params => write(() => deps.upsert({ ...params, expectedGeneration }), () => true),
    resolve: params => write(() => deps.resolve({ ...params, expectedGeneration }), result => result !== null),
  }
}

export async function analyzeSessionStateJob(input: { job: SessionStateJob; authority: SessionContextAuthority; runtime: Runtime }): Promise<Result> {
  const { job, authority, runtime } = input
  await authority.execution.security.authority.assertCurrent()
  const generation = await sessionContextGeneration(job.sessionId)
  const query = await readAdmittedSessionQuery({ sessionId: job.sessionId, throughSequence: job.throughSequence,
    topicThroughSequence: 0, authority })
  const context = { ...executionToolContext(authority.execution, { appId: 'session-state-worker' }), scopeAccumulator: authority.accumulator }
  const assertInputAuthority = () => assertSourceModelInputAuthority(context)
  await assertInputAuthority()
  const selected = query.history.filter(row => row.sequenceNum >= job.firstSequence)
  if (!selected.some(row => row.sequenceNum === job.throughSequence && row.role === 'assistant')) throw new StateJobChanged()
  const recentTurns: Message[] = []
  for (const row of selected) {
    if (row.role !== 'user' && row.role !== 'assistant') continue
    // Tool-bearing assistant narration is never a commitment. Tool-result
    // carriers are not human instructions. Original query evidence is retained.
    if (Array.isArray(row.content) && row.content.some(block => block.type === 'tool_use' || block.type === 'tool_result')) continue
    const text = typeof row.content === 'string' ? row.content
      : Array.isArray(row.content) ? row.content.flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n') : ''
    if (text.trim()) recentTurns.push(bindScopeSources({ role: row.role, content: text }, boundScopeSources(query)))
  }
  const store = backgroundSessionStateStore(generation)
  const openCommitments = await store.listOpenBySession(job.sessionId, authority)
  return runSessionStateDiff({ provider: runtime.provider, model: runtime.model, sessionId: job.sessionId,
    userId: job.actorUserId, assistantId: job.assistantId, store, recentTurns, openCommitments,
    authority, assertInputAuthority, allowTrivialShortcut: false })
}

const defaultDeps = { claim: claimSessionStateJob, finish: finishSessionStateJob, current: sessionStateJobCurrent,
  resolveAuthority: resolveSessionTitleAuthority, analyze: analyzeSessionStateJob }

export function createSessionStateWorker(options: {
  resolveRuntime: (workspaceId: string) => Promise<Runtime>
  recordResult: (job: SessionStateJob, result: Result, runtime: Runtime) => Promise<void>
  deps?: Partial<typeof defaultDeps>; intervalMs?: number; attemptTimeoutMs?: number
}) {
  const deps = { ...defaultDeps, ...options.deps }
  let timer: ReturnType<typeof setInterval> | undefined, active: Promise<void> | undefined
  let controller: AbortController | undefined, stopped = false
  const process = async (job: SessionStateJob) => {
    const { claims } = parseSessionStateJobAuthority(job)
    controller = new AbortController()
    const signal = controller.signal
    const timeout = setTimeout(() => controller?.abort(new Error('state_job_timeout')), options.attemptTimeoutMs ?? 120_000)
    timeout.unref?.()
    try {
      const fresh = await deps.resolveAuthority({ claims, sessionId: job.sessionId, readOnly: false })
      const authority = restrictStateJobAuthority(fresh, job, () => deps.current(job), signal)
      await authority.execution.security.authority.assertCurrent()
      const runtime = await options.resolveRuntime(job.workspaceId)
      await authority.execution.security.authority.assertCurrent()
      const provider: LLMProvider = { ...runtime.provider, stream: request => runtime.provider.stream({ ...request, signal }) }
      const result = await deps.analyze({ job, authority, runtime: { ...runtime, provider } })
      await options.recordResult(job, result, runtime)
      if (result.errorMessage) throw new Error('state_diff_provider_failed')
    } finally { clearTimeout(timeout); controller = undefined }
  }
  const runTick = async () => {
    const job = await deps.claim()
    if (!job) return
    try { await process(job); await deps.finish(job) }
    catch (error) {
      // A newer turn/state may have superseded an inference. Retain its range
      // for a fresh attempt; malformed queued credentials cannot be repaired.
      const terminal = error instanceof Error && error.message === 'invalid_state_authority'
      await deps.finish(job, { terminal, code: terminal ? 'invalid_authority' : 'state_analysis_unavailable' })
      console.warn('[session-state-worker]', { outcome: terminal ? 'terminal' : 'retry' })
    }
  }
  const tick = (): Promise<void> => {
    if (active || stopped) return active ?? Promise.resolve()
    active = runTick().catch(() => console.warn('[session-state-worker] queue unavailable')).finally(() => { active = undefined })
    return active
  }
  return { tick,
    start() {
      if (timer) return
      stopped = false
      timer = setInterval(() => void tick(), options.intervalMs ?? 5000)
      timer.unref?.()
      void tick()
    },
    async stop() {
      stopped = true
      if (timer) clearInterval(timer)
      timer = undefined
      controller?.abort(new Error('state_worker_stopped'))
      await active
    },
  }
}
