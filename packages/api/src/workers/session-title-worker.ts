/** Current-authority title queue drain. [COMP:api/session-title-jobs] */
import { accessCeilingContains, type LLMProvider, type SessionContextAuthority } from '@use-brian/core'
import { claimSessionTitleJob, finishSessionTitleJob, parseSessionTitleJobAuthority, sessionTitleJobCurrent, type SessionTitleJob } from '../db/session-title-jobs.js'
import { resolveSessionTitleAuthority } from '../routes/session-title-authority.js'
import { generateAttendedSessionTitle } from '../routes/attended-session-title.js'
import { readSessionTitle } from '../db/session-title-store.js'
import { attendedSessionTurnCount, readAttendedSessionHistory } from '../routes/attended-session-context.js'
import { notifyWorkspaceChange } from '../brain-stream/notify.js'

type Runtime = { provider: LLMProvider; model: string; providerKeySource: 'user' | 'platform' }
type Generated = Awaited<ReturnType<typeof generateAttendedSessionTitle>>
type Deps = {
 claim: typeof claimSessionTitleJob; finish: typeof finishSessionTitleJob; current: typeof sessionTitleJobCurrent
 resolveAuthority: typeof resolveSessionTitleAuthority; readTitle: typeof readSessionTitle
 readHistory: typeof readAttendedSessionHistory; countTurns: typeof attendedSessionTurnCount
 generate: typeof generateAttendedSessionTitle; notify: (workspaceId: string, sessionId: string) => void
}
const defaultDeps: Deps = {
 claim: claimSessionTitleJob, finish: finishSessionTitleJob, current: sessionTitleJobCurrent,
 resolveAuthority: resolveSessionTitleAuthority, readTitle: readSessionTitle,
 readHistory: readAttendedSessionHistory, countTurns: attendedSessionTurnCount, generate: generateAttendedSessionTitle,
 notify: (workspaceId,sessionId) => notifyWorkspaceChange(workspaceId,'session','update',sessionId),
}
class TitleJobChanged extends Error { constructor() { super('title_job_changed') } }
function terminal(error: unknown): boolean {
 if (error instanceof TitleJobChanged || error instanceof Error && error.message === 'invalid_title_authority') return true
 if (!error || typeof error !== 'object') return false
 return 'reason' in error && error.reason === 'authority_changed'
  || 'code' in error && ['scope_evidence_missing','scope_source_changed','source_access_denied','source_unavailable'].includes(String(error.code))
}
/** The persisted ceiling only restricts freshly admitted authority; it cannot grant any access. */
export function restrictTitleJobAuthority(authority: SessionContextAuthority, job: SessionTitleJob, current: () => Promise<boolean>, signal: AbortSignal): SessionContextAuthority {
 const { authoring } = parseSessionTitleJobAuthority(job), execution = authority.execution, original = execution.security.authority
 if (execution.lifecycle.sessionId !== job.sessionId || execution.assistant.id !== job.assistantId
  || execution.security.access.userId !== job.actorUserId || execution.security.access.workspaceId !== job.workspaceId
  || !accessCeilingContains(execution.security.ceiling,authoring.ceiling)
  || !accessCeilingContains(authoring.ceiling,execution.security.ceiling)) throw new TitleJobChanged()
 const assertCurrent = async () => {
  signal.throwIfAborted()
  await original.assertCurrent()
  if (!await current()) throw new TitleJobChanged()
  signal.throwIfAborted()
 }
 return { accumulator: authority.accumulator, execution: { ...execution,
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
}

export function createSessionTitleWorker(options: {
 resolveRuntime: (workspaceId: string) => Promise<Runtime>
 recordUsage: (job: SessionTitleJob, generated: Generated, runtime: Runtime) => Promise<void>
 isPlaceholderTitle?: (title: string | null | undefined) => boolean
 getTitleChannelPrefix?: (title: string | null | undefined) => string | null
 deps?: Partial<Deps>; intervalMs?: number; attemptTimeoutMs?: number
}) {
 const deps = { ...defaultDeps, ...options.deps }
 let timer: ReturnType<typeof setInterval> | undefined
 let active: Promise<void> | undefined
 let controller: AbortController | undefined
 let stopped = false
 const process = async (job: SessionTitleJob) => {
  const { claims } = parseSessionTitleJobAuthority(job)
  controller = new AbortController()
  const timeout = setTimeout(() => controller?.abort(new Error('title_job_timeout')), options.attemptTimeoutMs ?? 120_000)
  timeout.unref?.()
  const signal = controller.signal
  try {
   const fresh = await deps.resolveAuthority({ claims,sessionId:job.sessionId,readOnly:false })
   const authority = restrictTitleJobAuthority(fresh,job,() => deps.current(job),signal)
   await authority.execution.security.authority.assertCurrent()
   const previous = await deps.readTitle(job.sessionId,authority)
   if (previous?.manual) return
   if (previous && !options.isPlaceholderTitle?.(previous.title)) {
    const history = await deps.readHistory(authority,job.sessionId)
    const count = await deps.countTurns(authority,history)
    if (count <= 1 || count % 10 !== 0) return
   }
   const runtime = await options.resolveRuntime(job.workspaceId)
   await authority.execution.security.authority.assertCurrent()
   // Propagate the queue deadline without retaining any request-local runtime.
   const provider: LLMProvider = { ...runtime.provider, stream: request => runtime.provider.stream({ ...request,signal }) }
   const generated = await deps.generate({authority,provider,model:runtime.model,channelPrefix:options.getTitleChannelPrefix})
   await options.recordUsage(job,generated,runtime)
   if (generated.written) {
    await authority.execution.security.authority.assertCurrent()
    deps.notify(job.workspaceId,job.sessionId)
   }
  } finally { clearTimeout(timeout); controller = undefined }
 }
 const runTick = async () => {
  // One attempt per tick gives foreground chat precedence and bounds a drain.
  const job = await deps.claim()
  if (!job) return
  try { await process(job); await deps.finish(job) }
  catch (error) {
   const isTerminal = terminal(error)
   const code = isTerminal ? 'authority_or_claim_changed' : 'title_generation_failed'
   await deps.finish(job,{ terminal:isTerminal,code })
   console.warn('[session-title-worker]', { outcome:isTerminal?'terminal':'retry',code })
  }
 }
 const tick = (): Promise<void> => {
  if (active || stopped) return active ?? Promise.resolve()
  active = runTick().catch(() => { console.warn('[session-title-worker] queue unavailable') }).finally(() => { active = undefined })
  return active
 }
 return {
  tick,
  start() {
   if (timer) return
   stopped = false
   timer = setInterval(() => void tick(),options.intervalMs??5000)
   timer.unref?.()
   void tick()
  },
  async stop() { stopped = true; if (timer) clearInterval(timer); timer = undefined; controller?.abort(new Error('title_worker_stopped')); await active },
 }
}
