import { sessionKindSql } from '../session-kind.js'
import { createHash } from 'node:crypto'
import type pg from 'pg'
import {
  MEMORY_CANDIDATE_RETENTION_DAYS, countIndependentMemoryEvidence, deriveMemoryLearning, memoryLearningSchema, proposeMemoryLearning,
  type DerivedWriteEvidence, type MemoryLearning, type MemoryLearningProposal, type MemoryObservation,
} from '@use-brian/core'
import { buildMemoryAccessPredicate } from './memory-access-predicate.js'
import { appendDecisionEvent } from './decision-event-store.js'
import { appendDecisionDerivation } from './decision-provenance-store.js'

/** [COMP:memory/learning] Rollout gates admission only; readers always enforce persisted metadata. */
export function memoryLearningAdmissionEnabled(): boolean {
  return process.env.BRIAN_MEMORY_LEARNING_V1 === '1'
}
function digest(value: string) { return createHash('sha256').update(value).digest('hex') }
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(textOf).join('\n')
  if (content && typeof content === 'object' && 'text' in content) return textOf(content.text)
  return ''
}

export type LearningWrite = {
  assistantId: string; userId: string | null; workspaceId?: string; createdByUserId: string
  source?: string; summary: string; sourceSessionId?: string; sensitivity: 'public' | 'internal' | 'confidential'
  learning?: MemoryLearning | null; learningProposal?: MemoryLearningProposal; observation?: MemoryObservation
  compartments?: string[]; projectIds?: string[]
  derivation?: DerivedWriteEvidence
}

export async function prepareMemoryLearning(client: pg.PoolClient, params: LearningWrite, workspaceId: string): Promise<{
  learning: MemoryLearning | null; eventId?: string; replayId?: string
}> {
  // Derived semantic constraints survive even while new admission is disabled.
  const sourceIds = params.derivation?.sources.filter(source => source.resourceKind === 'memory').map(source => source.resourceId) ?? []
  const sources = sourceIds.length ? (await client.query<{ learning: MemoryLearning | null }>(
    'SELECT learning FROM memories WHERE workspace_id=$1 AND id=ANY($2::uuid[]) FOR SHARE', [workspaceId, sourceIds],
  )).rows.map(row => row.learning) : []
  const inherited = deriveMemoryLearning(sources)
  if (!memoryLearningAdmissionEnabled()) {
    if (params.learningProposal) throw new Error('memory_learning_unavailable: admission is not enabled on this deployment')
    return { learning: inherited ?? (params.learning ? memoryLearningSchema.parse(params.learning) : null) }
  }
  let observation: MemoryObservation | undefined
  if (params.observation) {
    const proposed = params.observation
    if (proposed.userId !== params.createdByUserId || proposed.sessionId !== params.sourceSessionId) throw new Error('memory_source_mismatch')
    const row = (await client.query<{ content: unknown; actor: string; held: boolean }>(
      `SELECT m.content,coalesce(m.sender_user_id,s.user_id) AS actor,m.scope_held AS held
       FROM session_messages m JOIN sessions s ON s.id=m.session_id
       JOIN assistants a ON a.id=s.assistant_id
       WHERE m.id=$1 AND m.session_id=$2 AND m.role='user' AND a.workspace_id=$3 AND m.workspace_id=$3 AND s.recording_revision IS NULL AND session_recording_read_allowed(s.id) AND ${sessionKindSql.conversationLane('s')}
       AND (m.sender_user_id=$4 OR m.sender_user_id IS NULL AND s.user_id=$4 AND NOT (${sessionKindSql.workspaceAudience('s')})) FOR SHARE OF m,s`,
      [proposed.messageId, proposed.sessionId, workspaceId, proposed.userId],
    )).rows[0]
    if (!row || row.held !== false || row.actor !== proposed.userId || textOf(row.content).trim() !== proposed.text.trim()) throw new Error('memory_source_mismatch')
    observation = proposed
  }
  // Explicit manual authoring and deterministic client/self APIs retain their authored intent.
  let learning = (params.source === 'user' || params.source === 'manual')
    ? memoryLearningSchema.parse({ version: 1, ...(params.learning ?? {}), state: 'established', origin: 'explicit', confirmed: true })
    : params.learning ? memoryLearningSchema.parse(params.learning) : proposeMemoryLearning(params.learningProposal, observation)
  if (params.source === 'consolidation' && sourceIds.length && !params.learningProposal) {
    learning = inherited ?? memoryLearningSchema.parse({version:1,state:'established',origin:'derived'})
  }
  if (inherited) {
    const floor = deriveMemoryLearning([inherited, { ...learning, state: 'established' }])!
    learning = { ...learning, applicability: floor.applicability, appliesFrom: floor.appliesFrom, appliesUntil: floor.appliesUntil, evidenceGroups:floor.evidenceGroups }
    if (params.source === 'consolidation' && !params.learningProposal) learning = floor
  }
  if (!observation || !params.learningProposal) return { learning }
  // Evidence is attributable to a human observation, never the generated summary alone.
  const quote = params.learningProposal.quote.trim()
  if (quote.length < 8 || /^(?:ok|yes|thanks|good|approved)[.!\s]*$/i.test(quote)) return { learning }
  let claim = digest(JSON.stringify([params.summary.trim().toLocaleLowerCase().replace(/\s+/g,' '), learning.applicability, params.userId, params.assistantId, params.sensitivity, [...(params.compartments ?? [])].sort(), [...(params.projectIds ?? [])].sort()]))
  if (params.learningProposal.contradictsMemoryId) {
    const access = buildMemoryAccessPredicate({workspaceId,userId:params.createdByUserId,assistantId:params.assistantId,
      assistantKind:'standard',clearance:params.sensitivity,compartments:params.compartments,projectIds:params.projectIds,memoryReview:true},{startIdx:2})
    const target = (await client.query<{learning:MemoryLearning}>(`SELECT learning FROM memories WHERE id=$1 AND valid_to IS NULL
      AND retracted_at IS NULL AND ${access.sql} FOR SHARE`,[params.learningProposal.contradictsMemoryId,...access.params])).rows[0]
    if (!target?.learning?.claimKey) throw new Error('memory_contradiction_target_unavailable')
    claim = target.learning.claimKey
  }
  learning = {...learning,claimKey:claim}
  const root = digest(JSON.stringify([observation.userId, observation.sessionId]))
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`memory-learning:${workspaceId}:${claim}`])
  const originHash = digest(observation.text.trim().replace(/\s+/g,' '))
  const { event, inserted } = await appendDecisionEvent({
    eventKind: 'memory.observation_recorded', workspaceId, actorUserId: params.createdByUserId,
    assistantId: params.assistantId, sessionId: observation.sessionId,
    idempotencyKey: `memory:${workspaceId}:${learning.origin === 'explicit' ? observation.messageId : originHash}:${claim}`,
    sourceKind: 'session_message', sourceId: observation.messageId, declaredScope: 'user',
    visibility: params.userId === null ? 'workspace' : 'owner', sensitivity: params.sensitivity,
    payload: { claim, root, originHash, messageId: observation.messageId, intent: learning.origin === 'explicit' ? 'explicit' : 'inferred' },
  }, client)
  if (!inserted) {
    const replay = (await client.query<{ id: string }>(
      `WITH RECURSIVE chain AS (
       SELECT m.id,m.superseded_by,m.valid_to,m.retracted_at,m.learning FROM decision_derivations d JOIN memories m ON m.id::text=d.artifact_id
        WHERE d.decision_event_id=$1 AND d.artifact_kind='memory' AND m.workspace_id=$2
       UNION SELECT m.id,m.superseded_by,m.valid_to,m.retracted_at,m.learning FROM memories m JOIN chain c ON m.id=c.superseded_by WHERE m.workspace_id=$2)
       SELECT id FROM chain WHERE valid_to IS NULL AND retracted_at IS NULL AND coalesce(learning->>'state','legacy')<>'retired' LIMIT 1`,
      [event.id,workspaceId],
    )).rows[0]
    if (!replay) throw new Error('memory_evidence_replayed: this observation was already recorded or forgotten')
    return { learning, replayId: replay.id }
  }
  if (params.learningProposal.contradictsMemoryId) await appendDecisionDerivation({decisionEventId:event.id,
    artifactKind:'memory',artifactId:params.learningProposal.contradictsMemoryId,relation:'contradicts'},client)
  const evidence = (await client.query<{ eventId: string; root: string; aliases: string[]; rootStartedAt: string; at: string; relation: 'supports' | 'contradicts' }>(
    `SELECT id AS "eventId",payload->>'root' AS root,ARRAY[payload->>'originHash'] AS aliases,
     (SELECT min(prior.created_at)::text FROM decision_events prior WHERE prior.workspace_id=e.workspace_id AND prior.actor_user_id=e.actor_user_id
       AND prior.event_kind=e.event_kind AND prior.payload->>'claim'=e.payload->>'claim' AND prior.payload->>'root'=e.payload->>'root') AS "rootStartedAt",created_at::text AS at,CASE WHEN EXISTS(SELECT 1 FROM decision_derivations d WHERE d.decision_event_id=e.id AND d.relation IN ('invalidates','contradicts')) THEN 'contradicts' ELSE 'supports' END AS relation
     FROM decision_events e WHERE workspace_id=$1 AND actor_user_id=$2 AND event_kind='memory.observation_recorded'
       AND payload->>'claim'=$3 AND (created_at>=now()-interval '30 days'
         OR EXISTS(SELECT 1 FROM decision_derivations d WHERE d.decision_event_id=e.id AND d.relation IN ('contradicts','invalidates')))
       AND NOT EXISTS(SELECT 1 FROM decision_events reversal WHERE reversal.reverses_event_id=e.id)
       AND EXISTS(SELECT 1 FROM session_messages m JOIN sessions s ON s.id=m.session_id
         WHERE m.id::text=e.source_id AND NOT m.scope_held AND s.recording_revision IS NULL
           AND session_recording_read_allowed(s.id) AND ${sessionKindSql.conversationLane('s')}
           AND (m.sender_user_id=e.actor_user_id OR m.sender_user_id IS NULL AND s.user_id=e.actor_user_id AND NOT (${sessionKindSql.workspaceAudience('s')})))
       AND (e.id=$4 OR EXISTS(SELECT 1 FROM decision_derivations d JOIN memories m ON m.id::text=d.artifact_id
         WHERE d.decision_event_id=e.id AND d.artifact_kind='memory' AND d.relation='supports'
           AND m.valid_to IS NULL AND m.retracted_at IS NULL AND NOT m.scope_held
           AND coalesce(m.learning->>'state','legacy') NOT IN ('retired')))`,
    [workspaceId,params.createdByUserId,claim,event.id],
  )).rows
  const counts = countIndependentMemoryEvidence(evidence,new Date())
  learning = { ...learning, evidenceCount:counts.events, independentSources:counts.roots,
    lastSupportedAt: counts.lastIndependentSupportAt,
    ...(learning.state === 'candidate' && counts.lastIndependentSupportAt ? {candidateUntil:new Date(Date.parse(counts.lastIndependentSupportAt)+MEMORY_CANDIDATE_RETENTION_DAYS*86400000).toISOString()} : {}),
  }
  if (learning.state === 'candidate' && params.userId !== null && params.learningProposal.kind === 'preference' && counts.eligible) {
    learning = { ...learning, state: 'established', candidateUntil: null,
      evidenceGroups:[...learning.evidenceGroups,evidence.filter(row=>row.relation==='supports').map(row=>row.eventId)] }
  }
  return { learning, eventId: event.id }
}

export async function recordMemoryLearning(client: pg.PoolClient, memoryId: string, eventId?: string, evidenceIds: readonly string[] = []): Promise<void> {
  for (const id of new Set([...evidenceIds,...(eventId ? [eventId] : [])])) {
    await appendDecisionDerivation({ decisionEventId:id, artifactKind:'memory',artifactId:memoryId,relation:'supports' },client)
  }
}
