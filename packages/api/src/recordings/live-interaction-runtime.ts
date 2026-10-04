import { AsyncLocalStorage } from 'node:async_hooks'
import { createKnowledgeTools, calculateCost, scopeGrantContains, type UsageStore, type TokenUsage, ContextScopeAccumulator, SensitivityAccumulator, CompartmentAccumulator, maxSensitivity,
  type LLMProvider, type Tool, type Embedder, type SavedViewStore, type ScopeEvidence,
  type ToolContext } from '@use-brian/core'
import { getPool } from '../db/client.js'
import { readSessionById, addSessionMessage } from '../db/sessions.js'
import { findAssistantById } from '../db/users.js'
import type { WorkspaceStore } from '../db/workspace-store.js'
import { runWithAgentAccess } from '../db/agent-access-context.js'
import { readCurrentScopeSources } from '../db/derived-scope-store.js'
import { createLiveInteractionStore, type ClaimedJob, type Capture } from '../db/live-interaction-store.js'
import { resolveExecutionContextSystem } from '../context-scope/execution-context.js'
import { sessionMessageInputScope } from '../context-scope/resolve-turn-scope.js'
import { createTurnLedger } from '../ledger/recorder.js'
import type { LedgerPayloadStore } from '../ledger/payload-store.js'
import { createLiveInteractionService, InteractionError, type Binding, type LiveInteractionDeps } from './live-interaction-service.js'
import { createInteractionAnswerAdapter, createInteractionRuleEvaluator } from './live-interaction-model.js'
import { createLiveInteractionTools } from './live-interaction-tools.js'

/** Boot supplies the existing scoped stores, approved tool registry and ledger payload store.
 * No workers start until the returned service's start() is called. Each job owns its
 * context, evidence, live cursors and ledger; no chat buffers/managers are inherited.
 */
export type LiveInteractionRuntimeDeps = {
  provider: LLMProvider
  model: string
  tools: ReadonlyMap<string, Tool>
  embedder?: Embedder
  savedViewStore: Pick<SavedViewStore, 'getById'>
  workspaceStore: Pick<WorkspaceStore, 'getRole'>
  payloads: LedgerPayloadStore
  /** KB tools are per-turn in chat, NOT registered in boot's allTools. */
  knowledgeStore: Parameters<typeof createKnowledgeTools>[0]
  usageStore?: UsageStore
  voiceTranscriptionEnabled?: boolean
  onError?: LiveInteractionDeps['onError']
}
const approved = ['searchBrain', 'browseBrain', 'searchKnowledge', 'browseKnowledge', 'readKnowledgeEntry', 'searchRecording', 'listRecordings']
const deny = () => new InteractionError(403, 'Interaction access denied')

export function createLiveInteractionRuntime(deps: LiveInteractionRuntimeDeps) {
  const store = createLiveInteractionStore()
  const preview = new AsyncLocalStorage<boolean>()
  // The service serializes detector claims. Snapshot identity before each evaluator call;
  // preview is explicitly excluded, even while a detector awaits its provider.
  let detectorCapture: Capture | undefined
  const claimInbox = store.claimInbox.bind(store)
  store.claimInbox = async () => {
    const inbox = await claimInbox()
    detectorCapture = inbox?.capture
    return inbox
  }
  const meter = (capture: Capture, source: string) => async (usage: TokenUsage, model: string) => {
    try { await deps.usageStore?.recordUsage({ userId: capture.ownerId, assistantId: capture.assistantId,
      workspaceId: capture.workspaceId, sessionId: capture.chatSessionId, model,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens,
      actualCostUsd: calculateCost(model, usage), source, triggerKey: capture.id })
    } catch (error) { deps.onError?.(error) }
  }
  const scopedAccess = (scope: Awaited<ReturnType<typeof resolveExecutionContextSystem>>['turnScope']) =>
    ({ ...scope.access, clearance: scope.access.clearance, compartments: scope.access.compartments })
  async function resolve(userId: string, binding: Binding, signal: AbortSignal) {
    signal.throwIfAborted()
    const [session, assistant, role] = await Promise.all([
      readSessionById(binding.chatSessionId), findAssistantById(binding.assistantId),
      deps.workspaceStore.getRole(userId, binding.workspaceId),
    ])
    if (!role || !session || !assistant || session.userId !== userId ||
      session.channelType !== 'web' || session.visibility !== 'owner' || session.mode !== null ||
      session.assistantId !== assistant.id || assistant.workspaceId !== binding.workspaceId) throw deny()
    const resolved = await resolveExecutionContextSystem({
      userId, assistant, workspaceId: binding.workspaceId, session, sessionAuthority: session,
      identity: { kind: 'attended', principal: { kind: 'workspace_member', userId } },
      ownership: { kind: 'workspace', workspaceId: binding.workspaceId },
      lifecycle: { abortSignal: signal, sessionId: session.id, channelType: 'web', channelId: session.channelId },
      attribution: { billingUserId: userId },
    })
    const page = await runWithAgentAccess(scopedAccess(resolved.turnScope), () => deps.savedViewStore.getById(userId, binding.pageId))
    if (!page || page.workspaceId !== binding.workspaceId) throw deny()
    const compartments: string[] = []
    if (page.teamspaceId) {
      const teamspace = (await getPool().query<{ workspaceGroupId: string | null; compartmentKey: string | null }>(
        `SELECT t.workspace_group_id AS "workspaceGroupId", g.compartment_key AS "compartmentKey" FROM teamspaces t
         LEFT JOIN workspace_groups g ON g.id=t.workspace_group_id AND g.workspace_id=t.workspace_id
         WHERE t.id=$1 AND t.workspace_id=$2`,
        [page.teamspaceId, binding.workspaceId])).rows[0]
      // The scoped page read above remains the access gate. A teamspace may
      // legitimately have no linked group; that adds no compartment label.
      // Missing teamspaces or unresolved linked groups still fail closed.
      if (!teamspace || (teamspace.workspaceGroupId !== null && !teamspace.compartmentKey)) throw deny()
      if (teamspace.compartmentKey) compartments.push(teamspace.compartmentKey)
    }
    const pageEvidence: ScopeEvidence = { sensitivity: page.clearance, compartments,
      projectIds: page.projectId ? [page.projectId] : [] }
    return { ...resolved, session, assistant, pageEvidence }
  }
  const authorize: LiveInteractionDeps['authorize'] = async (userId, binding) => {
    try { await resolve(userId, binding, new AbortController().signal); return true } catch { return false }
  }
  async function checkEvidence(capture: Capture, current: Awaited<ReturnType<typeof resolve>>,
    evidence: ScopeEvidence | undefined, db: Parameters<typeof readCurrentScopeSources>[0] = getPool()) {
    if (!evidence) throw new Error('Missing publication evidence')
    await current.executionContext.security.authority.assertCurrent()
    const states = await readCurrentScopeSources(db, capture.workspaceId, evidence.sources ?? [])
    if (states.some(state => state.state !== 'current')) throw new Error('Interaction evidence changed')
    const ceiling = current.turnScope.access
    if (maxSensitivity(ceiling.clearance ?? 'public', evidence.sensitivity ?? 'public') !== ceiling.clearance ||
      !scopeGrantContains(ceiling.compartments === undefined ? [] : ceiling.compartments, evidence.compartments ?? []) ||
      !scopeGrantContains(ceiling.projectIds === undefined ? [] : ceiling.projectIds, evidence.projectIds ?? [])) throw deny()
  }
  const authorizeJob: NonNullable<LiveInteractionDeps['authorizeJob']> = async (capture, job) => {
    try {
      const current = await resolve(capture.ownerId, capture, new AbortController().signal)
      const data = job as typeof job & { publicationEvidence?: ScopeEvidence; answerEvidence?: unknown[] }
      // Evidence is itself output, including the brief window before the first text write.
      // Truly empty queued/running jobs remain visible.
      if (!job.answer && !data.publicationEvidence && !data.answerEvidence?.length) return true
      await checkEvidence(capture, current, data.publicationEvidence)
      return true
    } catch { return false }
  }
  const answer = createInteractionAnswerAdapter(deps.provider, deps.model)
  const service = createLiveInteractionService({
    store, authorize, authorizeJob, voiceTranscriptionEnabled: deps.voiceTranscriptionEnabled, onError: deps.onError,
    evaluateRule: (input, signal) => createInteractionRuleEvaluator(deps.provider, deps.model, {
      onUsage: !preview.getStore() && detectorCapture ? meter(detectorCapture, 'overhead:classifier') : undefined,
    })(input, signal),
    async answer({ capture, job, signal, onText }) {
      const resolved = await resolve(capture.ownerId, capture, signal)
      const { executionContext, turnScope, session, assistant } = resolved
      const assertAccess = async () => {
        signal.throwIfAborted()
        const current = await resolve(capture.ownerId, capture, signal)
        scopeAccumulator.note(current.pageEvidence)
        await executionContext.security.authority.assertCurrent()
      }
      const scopeAccumulator = new ContextScopeAccumulator(resolved.pageEvidence)
      const sensitivity = new SensitivityAccumulator()
      const compartmentAccumulator = new CompartmentAccumulator()
      sensitivity.note(resolved.pageEvidence.sensitivity)
      compartmentAccumulator.note(resolved.pageEvidence.compartments)
      const tools = createLiveInteractionTools({ scopeId: capture.id, embedder: deps.embedder,
        pagePath: `/w/${capture.workspaceId}/p/${capture.pageId}`,
        assertAccess, read: async () => (await store.listUtterances(capture.id)),
      })
      const registry = new Map(deps.tools)
      for (const tool of createKnowledgeTools(deps.knowledgeStore, { allowWrites: false })) registry.set(tool.name, tool)
      for (const name of approved) {
        const tool = registry.get(name)
        if (tool?.isReadOnly && !tool.requiresConfirmation) tools.set(name, tool)
      }
      const ledger = createTurnLedger({ workspaceId: capture.workspaceId, assistantId: assistant.id,
        sessionId: session.id, assistantMessageId: job.assistantMessageId ?? undefined, payloads: deps.payloads,
        sensitivity: turnScope.access.clearance })
      let text = ''
      const answerEvidence: unknown[] = []
      const persistEvidence = async (exactEvidence: readonly unknown[] = answerEvidence) => {
        const current = await resolve(capture.ownerId, capture, signal)
        scopeAccumulator.note(current.pageEvidence)
        const evidence: ScopeEvidence = { ...scopeAccumulator.evidence,
          sensitivity: maxSensitivity(scopeAccumulator.sensitivity, sensitivity.max),
          compartments: [...new Set([...scopeAccumulator.compartments, ...compartmentAccumulator.compartments])],
        }
        await checkEvidence(capture, current, evidence)
        signal.throwIfAborted()
        // Commit labels and exact retrieval results before any partial text can be polled.
        const saved = await getPool().query(`UPDATE live_interaction_jobs SET data = data || jsonb_build_object(
          'publicationEvidence', $3::jsonb, 'answerEvidence', $4::jsonb)
          WHERE id=$1 AND token=$2 AND status='running' AND lease_until > now() RETURNING id`,
        [job.id, (job as ClaimedJob).token, JSON.stringify(evidence), JSON.stringify(exactEvidence)])
        if (!saved.rowCount) throw new Error('Interaction lease lost')
      }
      try {
        const result = await runWithAgentAccess(scopedAccess(turnScope), () => answer({
          question: job.question, signal, assertAccess, tools, ledger: ledger.ledger,
          onUsage: meter(capture, 'included'),
          createContext: (abortSignal): ToolContext => ({
            ...turnScope.access, executionContext, userId: capture.ownerId, workspaceActorUserId: capture.ownerId,
            assistantId: assistant.id, sessionId: session.id, appId: session.appId,
            channelType: 'web', channelId: session.channelId, abortSignal,
            authority: executionContext.security.authority, scopeAccumulator, sensitivity, compartmentAccumulator,
          }),
          onEvidence: results => { answerEvidence.push(...structuredClone(results)) },
          onText: async chunk => {
            await persistEvidence()
            signal.throwIfAborted()
            text += chunk
            await onText(text)
          },
        }))
        await assertAccess()
        await persistEvidence(result.evidence)
        return result.text
      } finally { await ledger.flush() }
    },
    async publish({ capture, job, signal }) {
      const resolved = await resolve(capture.ownerId, capture, signal)
      const tx = await getPool().connect()
      try {
        await tx.query('BEGIN')
        const locked = await tx.query(`SELECT data, published FROM live_interaction_jobs
          WHERE id=$1 AND token=$2 AND status='completed' AND lease_until > now() FOR UPDATE`,
        [job.id, (job as ClaimedJob).token])
        if (!locked.rows[0]) throw new Error('Interaction lease lost')
        const data = locked.rows[0].data
        if (!data.canonicalPublished) {
          // Serialize sequence allocation and freeze the destination binding during insertion.
          await tx.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE', [capture.chatSessionId])
          // Revalidate under the lock using read-only lookups: a pooled recency
          // touch would wait on our own transaction and prevent it from completing.
          const current = await resolve(capture.ownerId, capture, signal)
          await resolved.executionContext.security.authority.assertCurrent()
          const evidence = data.publicationEvidence as ScopeEvidence | undefined
          await checkEvidence(capture, current, evidence, tx)
          const floor = new ContextScopeAccumulator(evidence)
          floor.note(current.pageEvidence)
          const envelope = sessionMessageInputScope({ scope: resolved.turnScope, workspaceId: capture.workspaceId, userId: capture.ownerId })!
          // Transcript output retains the destination's personal audience, not the audience
          // of a retrieved workspace source. Raise every label without widening ownership.
          const scope = { ...envelope, sensitivity: maxSensitivity(envelope.sensitivity, floor.sensitivity),
            compartments: [...new Set([...envelope.compartments, ...floor.compartments])],
            projectIds: [...new Set([...envelope.projectIds, ...floor.projectIds])], }
          const user = await addSessionMessage({ sessionId: capture.chatSessionId, role: 'user',
            senderUserId: capture.ownerId, content: [{ type: 'text', text: job.question }], scope }, tx)
          const reply = await addSessionMessage({ sessionId: capture.chatSessionId, role: 'assistant',
            senderAssistantId: capture.assistantId, content: [{ type: 'text', text: job.answer }], scope }, tx)
          // Tool traces were recorded against the reserved reply ID. Rebind atomically
          // with canonical insertion so retries never leave orphaned ledger events.
          if (job.assistantMessageId) await tx.query(`UPDATE turn_events SET assistant_message_id=$1
            WHERE assistant_message_id=$2 AND session_id=$3 AND workspace_id=$4`,
          [reply.id, job.assistantMessageId, capture.chatSessionId, capture.workspaceId])
          await tx.query(`UPDATE live_interaction_jobs SET data=data || $2::jsonb WHERE id=$1`,
            [job.id, JSON.stringify({ userMessageId: user.id, assistantMessageId: reply.id, canonicalPublished: true })])
        }
        signal.throwIfAborted()
        await tx.query('COMMIT')
      } catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() }
    },
  })
  return { ...service,
    async create(userId: string, binding: Binding) {
      // The dock may use a different assistant from the active main chat.
      // Resolve the immutable destination's assistant server-side, then perform
      // the usual owner/workspace/page checks before persisting the capture.
      const session = await readSessionById(binding.chatSessionId)
      if (!session || session.userId !== userId || !session.assistantId) throw deny()
      return service.create(userId, { ...binding, assistantId: session.assistantId })
    },
    preview: (...args: Parameters<typeof service.preview>) => preview.run(true, () => service.preview(...args)),
  }
}
