import { admitAnchoredSession } from '../workspace-access/session-create-admission.js'
import { sessionKindSql } from '../session-kind.js'
import { assertFeedLinkedInDestination } from '../content-planning/linkedin-authority.js'
import { feedSelectedFiles, readFeedSelectedSources, feedSourceFloor } from '../content-planning/source-authority.js'
/** Atomic Feed content, discussion and decision history. [COMP:feed/draft-comments] [COMP:feed/draft-suggestions] [COMP:feed/editorial-decisions] */
import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'
import {
  feedCommandRequestSchema, feedMediaSchema, type FeedCommandRequest, type FeedCollaborationReceipt,
  type FeedComposition, type FeedEdit, type FeedAnchor, type FeedLinkedInContext,
} from '@use-brian/shared'
import { applyFeedEdits, locateFeedNode, canonicalFeedValue, createFeedAnchor, importLegacyFeed, projectFeed, validateFeedComposition, walkFeed, FeedCompositionError } from '@use-brian/doc-model'
import { getPool } from './client.js'
import { canMemberDraftRole } from './workspace-store.js'
import { appendDecisionEvent } from './decision-event-store.js'
import { appendDecisionDerivation, type DecisionDerivationRelation } from './decision-provenance-store.js'
import type { PostWorkingContent, PostWorkingCopy } from './post-working-copies.js'

export class FeedCollaborationError extends Error {
  constructor(public status: number, public code: string) { super(code) }
}
export type FeedActor = { userId: string; assistantId: string; sessionId: string; kind: 'user' | 'assistant' }
export type StructuredFeedContent = PostWorkingContent & { schemaVersion: 2; composition: FeedComposition }
export type FeedThread = { id: string; transcriptSessionId: string; anchor: FeedAnchor; resolved: boolean; authorUserId: string; authorName?: string | null; authorKind: 'user' | 'assistant'; createdAt: Date }
export type FeedSuggestion = { sourceRunId?: string | null; id: string; sourceRevision: number; edits: FeedEdit[]; rationale: string; status: string; threadId: string | null; parentId: string | null; authorUserId: string; authorName?: string | null; authorKind: 'user' | 'assistant'; acceptanceReceipt: FeedCollaborationReceipt | null; applicationId: string | null }
export type FeedScope = { workspaceId: string; clearance: string; compartments: string[] | null; role: 'owner' | 'admin' | 'member'; canDraft: boolean; memberClearance: string; memberCompartments?: string[] | null }
export async function lockFeedAccess(client: pg.PoolClient, actor: FeedActor, write = true): Promise<FeedScope> {
  const row = (await client.query<FeedScope>(
    `SELECT a.workspace_id AS "workspaceId", a.clearance, a.compartments FROM sessions s JOIN assistants a ON a.id=s.assistant_id
     WHERE s.id=$1 AND a.id=$2 AND ${sessionKindSql.anchored('s', 'feed_draft')}
       AND s.workspace_id=a.workspace_id AND a.kind='app' AND a.app_type='distribution' FOR UPDATE OF s`,
    [actor.sessionId, actor.assistantId],
  )).rows[0]
  if (!row) throw new FeedCollaborationError(404, 'draft_not_found')
  const member = (await client.query<Pick<FeedScope, 'role' | 'canDraft' | 'memberClearance' | 'memberCompartments'>>(
    `SELECT role,can_draft AS "canDraft",clearance AS "memberClearance",effective_member_team_compartments(user_id,workspace_id) AS "memberCompartments" FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE`,
    [row.workspaceId, actor.userId],
  )).rows[0]
  if (!member || (write && !canMemberDraftRole(member.role, member.canDraft))) throw new FeedCollaborationError(403, 'draft_access_required')
  if (!(await client.query('SELECT feed_draft_audience_allowed($1) AS allowed', [actor.sessionId])).rows[0]?.allowed) throw new FeedCollaborationError(403, 'draft_source_access_required')
  return { ...row, ...member }
}
export async function withFeedTransaction<T>(actor: FeedActor, work: (client: pg.PoolClient, scope: FeedScope) => Promise<T>, write = true): Promise<T> {
  const client = await getPool().connect()
  try { await client.query('BEGIN'); const scope = await lockFeedAccess(client, actor, write); const result = await work(client, scope); await client.query('COMMIT'); return result }
  catch (error) { await client.query('ROLLBACK'); if (error instanceof FeedCompositionError) throw new FeedCollaborationError(409, error.code); throw error }
  finally { client.release() }
}
const COPY_COLUMNS = 'revision,mutation_id AS "mutationId",content,discussion_sequence::int AS sequence'
export type FeedReader = { query: typeof import('./client.js').query }
export async function readFeedCopy(client: FeedReader, sessionId: string): Promise<(PostWorkingCopy & { sequence: number }) | null> {
  return (await client.query<PostWorkingCopy & { sequence: number }>(`SELECT ${COPY_COLUMNS} FROM feed_post_working_copies WHERE session_id=$1`, [sessionId])).rows[0] ?? null
}
export function requireFeedComposition(content: PostWorkingContent): StructuredFeedContent {
  if (content.schemaVersion !== 2 || !content.composition) throw new FeedCollaborationError(409, 'upgrade_required')
  validateFeedComposition(content.composition); return content as StructuredFeedContent
}
async function threads(client: pg.PoolClient, sessionId: string): Promise<FeedThread[]> {
  return (await client.query<FeedThread>(`SELECT (SELECT name FROM users WHERE id=author_user_id) AS "authorName",id,transcript_session_id AS "transcriptSessionId",anchor,resolved,author_user_id AS "authorUserId",author_kind AS "authorKind",created_at AS "createdAt" FROM feed_comment_threads WHERE session_id=$1 ORDER BY created_at,id`, [sessionId])).rows
}
const SUGGESTION_COLUMNS = 'id,source_run_id AS "sourceRunId",source_proposal AS "sourceProposal",source_revision AS "sourceRevision",edits,rationale,status,thread_id AS "threadId",parent_id AS "parentId",author_user_id AS "authorUserId",author_kind AS "authorKind",acceptance_receipt AS "acceptanceReceipt",application_id AS "applicationId"'
export async function assertFeedFiles(client: pg.PoolClient, actor: FeedActor, scope: FeedScope, composition: FeedComposition, historicalFileIds: readonly string[] = [], linkedin?: FeedLinkedInContext): Promise<void> {
  const ids = feedSelectedFiles(composition, linkedin)
  for (const id of historicalFileIds) if (!ids.has(id)) ids.set(id, null)
  const files = await readFeedSelectedSources(client, actor, scope, 'file', [...ids.keys()])
  if (files.length !== ids.size || files.some(f => ids.get(f.id) !== null && ids.get(f.id) !== f.mime)) throw new FeedCollaborationError(403, 'file_not_available_to_draft')
  if (actor.kind === 'assistant') {
    const copy = await readFeedCopy(client, actor.sessionId)
    const selected = copy?.content.composition ? feedSelectedFiles(copy.content.composition, copy.content.linkedin) : new Map()
    const ranks = ['public', 'internal', 'confidential']
    for (const file of files) {
      if (ranks.indexOf(file.sensitivity) <= ranks.indexOf(scope.clearance) || selected.has(file.id)) continue
      const generation = file.metadata?.feedGeneration as { sessionId?: string; runId?: string } | undefined
      if (!generation?.runId || generation.sessionId !== actor.sessionId || !(await client.query(
        "SELECT 1 FROM feed_editorial_runs WHERE id=$1 AND session_id=$2 AND kind='image_generation' AND result->'candidates' @> $3::jsonb",
        [generation.runId, actor.sessionId, JSON.stringify([{ edits: [{ replacement: [{ type: 'image', attrs: { fileId: file.id } }] }] }])])).rows.length) throw new FeedCollaborationError(403, 'source_selection_required')
    }
  }

}
async function assertSameReference(client: pg.PoolClient, table: 'feed_comment_threads' | 'feed_draft_suggestions', sessionId: string, ref?: string): Promise<void> {
  if (ref && !(await client.query(`SELECT id FROM ${table} WHERE session_id=$1 AND id=$2`, [sessionId, ref])).rows.length) throw new FeedCollaborationError(404, 'reference_not_found')
}
async function assertApplication(client: pg.PoolClient, actor: FeedActor, scope: FeedScope, applicationId?: string): Promise<void> {
  if (applicationId && !(await client.query(`SELECT id FROM decision_applications WHERE id=$1 AND workspace_id=$2 AND assistant_id=$3 AND actor_user_id=$4 AND (operation_id=$5 OR (operation_kind='feed_chat' AND source_kind='feed_session' AND source_id=$5 AND EXISTS(SELECT 1 FROM session_messages m WHERE m.id::text=decision_applications.operation_id AND (m.session_id=$5::uuid OR m.session_id IN (SELECT transcript_session_id FROM feed_comment_threads WHERE session_id=$5::uuid)))) OR (operation_kind IN ('feed_review','feed_generation') AND EXISTS(SELECT 1 FROM feed_editorial_runs r WHERE r.id::text=decision_applications.operation_id AND r.session_id=$5::uuid AND r.actor_user_id=$4)))`, [applicationId, scope.workspaceId, actor.assistantId, actor.userId, actor.sessionId])).rows.length) throw new FeedCollaborationError(403, 'application_scope_mismatch')
}
async function assertUnchangedProposalTargets(client: pg.PoolClient, sessionId: string, sourceRevision: number, current: FeedComposition, edits: FeedEdit[]): Promise<void> {
  const source = (await client.query<{ content: PostWorkingContent }>('SELECT content FROM feed_post_revisions WHERE session_id=$1 AND revision=$2', [sessionId, sourceRevision])).rows[0]
  if (!source?.content.composition) throw new FeedCollaborationError(409, 'source_revision_unavailable')
  for (const edit of edits) {
    const targets = edit.kind === 'replaceText' ? edit.spans : 'blockId' in edit ? [{ segmentId: edit.segmentId, blockId: edit.blockId }] : []
    for (const target of targets) {
      const before = locateFeedNode(source.content.composition, target.segmentId, target.blockId).node
      const now = locateFeedNode(current, target.segmentId, target.blockId).node
      if (canonicalFeedValue(before) !== canonicalFeedValue(now)) throw new FeedCollaborationError(409, 'proposal_target_changed')
    }
  }
}
export async function executeFeedCommands(actor: FeedActor, raw: FeedCommandRequest, transaction?: { client: pg.PoolClient; scope: FeedScope }): Promise<FeedCollaborationReceipt> {
  const input = feedCommandRequestSchema.parse(raw)
  const fingerprint = createHash('sha256').update(canonicalFeedValue(input)).digest('hex')
  const execute = async (client: pg.PoolClient, scope: FeedScope) => {
    const prior = (await client.query<{ fingerprint: string; actorUserId: string; actorKind: string; receipt: FeedCollaborationReceipt }>(
      `SELECT fingerprint,actor_user_id AS "actorUserId",actor_kind AS "actorKind",receipt FROM feed_collaboration_mutations WHERE session_id=$1 AND mutation_id=$2`, [actor.sessionId, input.mutationId],
    )).rows[0]
    if (prior) {
      if (prior.actorUserId !== actor.userId || prior.actorKind !== actor.kind || prior.fingerprint !== fingerprint) throw new FeedCollaborationError(409, 'mutation_id_reused')
      return prior.receipt
    }
    const copy = await readFeedCopy(client, actor.sessionId)
    if (!copy) throw new FeedCollaborationError(409, 'working_copy_required')
    if (copy.revision !== input.expectedRevision) throw new FeedCollaborationError(409, 'revision_conflict')
    let content = copy.content; let currentRevision = copy.revision; let sequence = copy.sequence
    const receipt: FeedCollaborationReceipt = { mutationId: input.mutationId, revision: currentRevision, sequence, threadIds: [], suggestionIds: [] }
    const reactToApplication = async (eventId: string, applicationId: string | null | undefined, relation: DecisionDerivationRelation) => {
      if (!applicationId || actor.kind !== 'user') return
      const application = (await client.query<{ artifact_refs: { kind: string; id: string }[] }>('SELECT artifact_refs FROM decision_applications WHERE id=$1 AND workspace_id=$2 AND assistant_id=$3', [applicationId, scope.workspaceId, actor.assistantId])).rows[0]
      for (const ref of application?.artifact_refs ?? []) await appendDecisionDerivation({ decisionEventId: eventId, artifactKind: ref.kind, artifactId: ref.id, relation }, client)
    }
    const recordRevision = async (forward: FeedEdit[], inverse: FeedEdit[], capture: boolean, reasonThreadId?: string, applicationId?: string) => {
      const structured = requireFeedComposition(content); const projection = projectFeed(structured.composition)
      if (structured.postFormat !== 'thread' && structured.composition.segments.length !== 1) throw new FeedCollaborationError(400, 'format_segment_mismatch')
      content = { ...structured, text: projection.text, threadSegments: projection.threadSegments, media: projection.media }
      await assertFeedFiles(client, actor, scope, structured.composition, [], structured.linkedin)
      const files = await readFeedSelectedSources(client, actor, scope, 'file', [...feedSelectedFiles(structured.composition, structured.linkedin).keys()])
      const memories = await readFeedSelectedSources(client, actor, scope, 'memory', structured.selectedMemoryIds ?? [])
      if (memories.length !== new Set(structured.selectedMemoryIds ?? []).size) throw new FeedCollaborationError(403, 'memory_not_available_to_draft')
      content = { ...content, sourceSensitivity: feedSourceFloor(content.sourceSensitivity, [...files, ...memories]),
        sourceCompartments: [...new Set([...(content.sourceCompartments ?? []), ...[...files, ...memories].flatMap(source => source.compartments ?? [])])],
        sourceFileIds: [...new Set([...(content.sourceFileIds ?? []), ...files.map(source => source.id)])],
        sourceMemoryIds: [...new Set([...(content.sourceMemoryIds ?? []), ...memories.map(source => source.id)])],
        sourceProjectIds: [...new Set([...(content.sourceProjectIds ?? []), ...[...files, ...memories].flatMap(source => source.projectIds ?? [])])] }
      await client.query(`UPDATE sessions SET effective_clearance=CASE WHEN sensitivity_rank(COALESCE(effective_clearance,'public'))<sensitivity_rank($2) THEN $2 ELSE effective_clearance END WHERE id=$1 OR id IN(SELECT transcript_session_id FROM feed_comment_threads WHERE session_id=$1)`, [actor.sessionId, content.sourceSensitivity])
      currentRevision++
      await client.query(`INSERT INTO feed_post_revisions(session_id,revision,workspace_id,assistant_id,actor_user_id,actor_kind,mutation_id,content,forward_commands,inverse_commands) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [actor.sessionId, currentRevision, scope.workspaceId, actor.assistantId, actor.userId, actor.kind, input.mutationId, JSON.stringify(content), JSON.stringify(forward), JSON.stringify(inverse)])
      if (capture && actor.kind === 'user') {
        const captured = await appendDecisionEvent({ idempotencyKey: `feed:${actor.sessionId}:${input.mutationId}:revision:${currentRevision}`, workspaceId: scope.workspaceId, actorUserId: actor.userId, assistantId: actor.assistantId, sessionId: actor.sessionId, sourceKind: 'feed_revision', sourceId: `${actor.sessionId}:${currentRevision}`, declaredScope: 'instance', visibility: 'workspace', sensitivity: 'internal', eventKind: 'feed.draft_revised', causedByApplicationId: applicationId, payload: { previousRevision: currentRevision - 1, revision: currentRevision, mutationId: input.mutationId, ...(reasonThreadId ? { reasonThreadId } : {}) } }, client)
        if (reasonThreadId) await reactToApplication(captured.event.id, applicationId, 'contradicts')
      }
    }
    const editContent = async (edits: FeedEdit[], reasonThreadId?: string, applicationId?: string, inverse = false) => {
      await assertSameReference(client, 'feed_comment_threads', actor.sessionId, reasonThreadId)
      await assertApplication(client, actor, scope, applicationId)
      const source = requireFeedComposition(content); const existing = await threads(client, actor.sessionId)
      // Validate each transition, not the net counter change: offline autosave
      // coalesces several keystrokes into one ordered, preimage-checked command.
      const previousSlots = new Map(walkFeed(source.composition).filter(item => item.node.type === 'generationPlaceholder').map(item => [item.node.attrs.id, item.node]))
      const applied = applyFeedEdits(source.composition, edits, existing.map(t => t.anchor), inverse ? undefined : (_before, after) => {
        for (const { node } of walkFeed(after)) {
          if (node.type !== 'generationPlaceholder') continue
          const before = previousSlots.get(node.attrs.id)
          if (before?.type === 'generationPlaceholder' && canonicalFeedValue(before.attrs) !== canonicalFeedValue(node.attrs) && node.attrs.briefRevision !== before.attrs.briefRevision + 1) throw new FeedCollaborationError(409, 'placeholder_brief_revision_conflict')
          // Retain deleted IDs until this command ends so a remove/reinsert
          // cannot bypass the same slot's counter validation.
          previousSlots.set(node.attrs.id, structuredClone(node))
        }
      })
      content = { ...source, composition: applied.composition }
      for (let i = 0; i < existing.length; i++) if (canonicalFeedValue(existing[i]!.anchor) !== canonicalFeedValue(applied.anchors[i])) await client.query('UPDATE feed_comment_threads SET anchor=$3,updated_at=now() WHERE session_id=$1 AND id=$2', [actor.sessionId, existing[i]!.id, JSON.stringify(applied.anchors[i])])
      await recordRevision(edits, applied.inverse, true, reasonThreadId, applicationId)
    }
    const proposalDecision = async (suggestion: FeedSuggestion, outcome: 'accepted' | 'rejected' | 'deferred' | 'undone', reasonThreadId?: string) => {
      if (actor.kind !== 'user') throw new FeedCollaborationError(403, 'member_decision_required')
      await assertSameReference(client, 'feed_comment_threads', actor.sessionId, reasonThreadId)
      await client.query('UPDATE feed_draft_suggestions SET status=$3,acceptance_receipt=CASE WHEN $3=\'accepted\' THEN $4::jsonb ELSE acceptance_receipt END WHERE session_id=$1 AND id=$2', [actor.sessionId, suggestion.id, outcome, JSON.stringify({ ...receipt, revision: currentRevision, sequence: sequence + 1 })])
      const captured = await appendDecisionEvent({ idempotencyKey: `feed:${actor.sessionId}:${input.mutationId}:proposal:${suggestion.id}:${outcome}`, workspaceId: scope.workspaceId, actorUserId: actor.userId, assistantId: actor.assistantId, sessionId: actor.sessionId, sourceKind: 'feed_suggestion', sourceId: suggestion.id, declaredScope: 'instance', visibility: 'workspace', sensitivity: 'internal', eventKind: 'feed.proposal_decided', causedByApplicationId: suggestion.applicationId, payload: { suggestionId: suggestion.id, revision: currentRevision, outcome, ...(reasonThreadId ? { reasonThreadId } : {}) } }, client)
      // Silent acceptance is not preference evidence. Explicit linked reactions
      // record provenance only; native reflection still enforces distinct posts.
      if (outcome === 'undone' || outcome === 'rejected' || outcome === 'accepted' && reasonThreadId) await reactToApplication(captured.event.id, suggestion.applicationId, outcome === 'undone' ? 'invalidates' : outcome === 'rejected' ? 'contradicts' : 'supports')
      sequence++
    }
    for (const command of input.commands) {
      if (command.kind === 'upgrade') {
        if (content.schemaVersion === 2) continue
        // Preserve the pre-upgrade revision as well as the imported snapshot.
        await client.query(`INSERT INTO feed_post_revisions(session_id,revision,workspace_id,assistant_id,actor_user_id,actor_kind,content,forward_commands,inverse_commands) VALUES($1,$2,$3,$4,$5,$6,$7,'[]','[]') ON CONFLICT (session_id,revision) DO NOTHING`, [actor.sessionId, currentRevision, scope.workspaceId, actor.assistantId, actor.userId, actor.kind, JSON.stringify(content)])
        content = { ...content, schemaVersion: 2, composition: importLegacyFeed({ ...content, media: content.media.map(item => feedMediaSchema.parse(item)) }, command.seed) }; await recordRevision([], [], false)
        continue
      }
      const structured = requireFeedComposition(content)
      if (command.kind === 'edit') await editContent(command.edits, command.reasonThreadId, command.applicationId)
      else if (command.kind === 'comment') {
        const sourceRevision = command.sourceRevision ?? currentRevision
        const source = await historicalFeedContent(client, actor.sessionId, sourceRevision, currentRevision, structured)
        const anchor = await mapFeedHistoricalAnchor(client, actor.sessionId, createFeedAnchor(source.composition, command.target, sourceRevision), currentRevision, source.composition); const transcript = randomUUID()
        // The draft anchors the discussion: admitted by its anchor (L12).
        const admitted = await admitAnchoredSession(client, { assistantId: actor.assistantId, userId: actor.userId, channelType: 'web', channelId: `feed-thread:${command.threadId}`, workspaceId: scope.workspaceId, anchorKind: 'feed_thread', anchorRef: command.threadId })
        await client.query(`INSERT INTO sessions(id,assistant_id,user_id,channel_type,channel_id,workspace_id,visibility,title,anchor_kind,anchor_ref,effective_clearance) VALUES($1,$2,$3,'web',$4,$5,'workspace','Draft discussion','feed_thread',$6,$7)`, [transcript, actor.assistantId, actor.userId, `feed-thread:${command.threadId}`, scope.workspaceId, command.threadId, admitted.effectiveClearance])
        await client.query(`INSERT INTO feed_comment_threads(id,session_id,workspace_id,assistant_id,transcript_session_id,anchor,author_user_id,author_kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [command.threadId, actor.sessionId, scope.workspaceId, actor.assistantId, transcript, JSON.stringify(anchor), actor.userId, actor.kind])
        await client.query(`INSERT INTO session_messages(session_id,role,content,sequence_num,sender_user_id) VALUES($1,$2,$3,1,$4)`, [transcript, actor.kind === 'user' ? 'user' : 'assistant', JSON.stringify([{ type: 'text', text: command.text }]), actor.kind === 'user' ? actor.userId : null])
        receipt.threadIds.push(command.threadId); sequence++
      } else if (command.kind === 'reply' || command.kind === 'resolve' || command.kind === 'reattach') {
        const thread = (await threads(client, actor.sessionId)).find(t => t.id === command.threadId)
        if (!thread) throw new FeedCollaborationError(404, 'thread_not_found')
        if (command.kind === 'reply') await client.query(`INSERT INTO session_messages(session_id,role,content,sequence_num,sender_user_id) SELECT $1,$2,$3,coalesce(max(sequence_num),0)+1,$4 FROM session_messages WHERE session_id=$1`, [thread.transcriptSessionId, actor.kind === 'user' ? 'user' : 'assistant', JSON.stringify([{ type: 'text', text: command.text }]), actor.kind === 'user' ? actor.userId : null])
        else if (command.kind === 'resolve') await client.query('UPDATE feed_comment_threads SET resolved=$3,updated_at=now() WHERE session_id=$1 AND id=$2', [actor.sessionId, command.threadId, command.resolved])
        else await client.query('UPDATE feed_comment_threads SET anchor=$3,updated_at=now() WHERE session_id=$1 AND id=$2', [actor.sessionId, command.threadId, JSON.stringify(createFeedAnchor(structured.composition, command.target, currentRevision))])
        sequence++
      } else if (command.kind === 'propose') {
        await assertSameReference(client, 'feed_comment_threads', actor.sessionId, command.threadId)
        await assertSameReference(client, 'feed_draft_suggestions', actor.sessionId, command.parentId)
        await assertApplication(client, actor, scope, command.applicationId)
        if (command.sourceMessageId && !(await client.query(`SELECT id FROM session_messages WHERE id=$1 AND (session_id=$2 OR session_id IN (SELECT transcript_session_id FROM feed_comment_threads WHERE session_id=$2))`, [command.sourceMessageId, actor.sessionId])).rows.length) throw new FeedCollaborationError(403, 'message_scope_mismatch')
        const sourceRevision = command.sourceRevision ?? currentRevision
        if (command.sourceRunId) {
          const run = (await client.query(`SELECT actor_user_id,source_revision,result FROM feed_editorial_runs WHERE session_id=$1 AND id=$2 AND kind IN ('text_generation','image_generation')`, [actor.sessionId, command.sourceRunId])).rows[0]
          const generated = run?.result.candidates?.find((item: { id: string }) => item.id === command.suggestionId)
          if (!run || run.actor_user_id !== actor.userId || run.source_revision !== sourceRevision || !generated || canonicalFeedValue(generated.edits) !== canonicalFeedValue(command.edits) || generated.rationale !== command.rationale || (generated.applicationId ?? null) !== (command.applicationId ?? null)) throw new FeedCollaborationError(403, 'generation_source_mismatch')
        }
        const source = await historicalFeedContent(client, actor.sessionId, sourceRevision, currentRevision, structured)
        const candidate = applyFeedEdits(source.composition, command.edits).composition
        await assertFeedFiles(client, actor, scope, candidate)
        await client.query(`INSERT INTO feed_draft_suggestions(id,session_id,workspace_id,assistant_id,author_user_id,author_kind,source_revision,edits,rationale,thread_id,parent_id,source_message_id,source_tool_call_id,application_id,source_proposal,source_run_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, [command.suggestionId, actor.sessionId, scope.workspaceId, actor.assistantId, actor.userId, actor.kind, sourceRevision, JSON.stringify(command.edits), command.rationale, command.threadId, command.parentId, command.sourceMessageId, command.sourceToolCallId, command.applicationId, command.sourceProposal ? JSON.stringify(command.sourceProposal) : null, command.sourceRunId ?? null])
        receipt.suggestionIds.push(command.suggestionId); sequence++
      } else if (command.kind === 'decide') {
        const suggestion = (await client.query<FeedSuggestion>(`SELECT ${SUGGESTION_COLUMNS} FROM feed_draft_suggestions WHERE session_id=$1 AND id=$2`, [actor.sessionId, command.suggestionId])).rows[0]
        if (!suggestion) throw new FeedCollaborationError(404, 'suggestion_not_found')
        if (suggestion.status === command.outcome) continue
        if (!['proposed', 'deferred'].includes(suggestion.status)) throw new FeedCollaborationError(409, 'suggestion_already_decided')
        if (command.outcome === 'accepted') {
          await assertUnchangedProposalTargets(client, actor.sessionId, suggestion.sourceRevision, structured.composition, suggestion.edits)
          await editContent(suggestion.edits, command.reasonThreadId)
        }
        await proposalDecision(suggestion, command.outcome, command.reasonThreadId)
      } else if (command.kind === 'undo') {
        const history = (await client.query<{ inverse: FeedEdit[] }>('SELECT inverse_commands AS inverse FROM feed_post_revisions WHERE session_id=$1 AND revision=$2', [actor.sessionId, command.revision])).rows[0]
        if (!history?.inverse.length) {
          const rows = (await client.query<{ revision: number; content: PostWorkingContent }>('SELECT revision,content FROM feed_post_revisions WHERE session_id=$1 AND revision IN ($2,$3) ORDER BY revision', [actor.sessionId, command.revision - 1, command.revision])).rows
          const previous = rows[0]?.content; const changed = rows[1]?.content
          if (!previous || !changed || canonicalFeedValue(previous.linkedin ?? null) === canonicalFeedValue(changed.linkedin ?? null)) throw new FeedCollaborationError(409, 'revision_not_undoable')
          if (canonicalFeedValue(structured.linkedin ?? null) !== canonicalFeedValue(changed.linkedin ?? null) || structured.postFormat !== changed.postFormat) throw new FeedCollaborationError(409, 'preimage_conflict')
          if (previous.linkedin?.destinationId) await assertFeedLinkedInDestination(actor, scope, previous.linkedin)
          content = { ...structured, linkedin: previous.linkedin, postFormat: previous.postFormat }
          await recordRevision([], [], false)
          continue
        }
        await assertUnchangedProposalTargets(client, actor.sessionId, command.revision, structured.composition, history.inverse)
        await editContent(history.inverse, undefined, undefined, true)
        const accepted = (await client.query<FeedSuggestion>(`SELECT ${SUGGESTION_COLUMNS} FROM feed_draft_suggestions WHERE session_id=$1 AND status='accepted' AND (acceptance_receipt->>'revision')::int=$2`, [actor.sessionId, command.revision])).rows
        for (const suggestion of accepted) await proposalDecision(suggestion, 'undone')
      } else if (command.kind === 'release') {
        if (actor.kind !== 'user') throw new FeedCollaborationError(403, 'member_release_required')
        if (input.commands.length !== 1) throw new FeedCollaborationError(400, 'release_requires_exact_revision')
        await assertFeedFiles(client, actor, scope, structured.composition, [], structured.linkedin)
        await client.query('UPDATE feed_post_working_copies SET public_release=$2 WHERE session_id=$1', [actor.sessionId, JSON.stringify({ revision: currentRevision, audience: 'public', actorUserId: actor.userId, mutationId: input.mutationId })])
        sequence++
      } else if (command.kind === 'context') {
        if (command.selectedMemoryIds && actor.kind !== 'user' && command.selectedMemoryIds.some(id => !structured.selectedMemoryIds?.includes(id))) throw new FeedCollaborationError(403, 'source_selection_required')
        if (command.goalId && !(await client.query('SELECT id FROM goals WHERE id=$1 AND workspace_id=$2', [command.goalId, scope.workspaceId])).rows.length) throw new FeedCollaborationError(403, 'goal_scope_mismatch')
        const { kind: _kind, ...patch } = command
        content = { ...structured, ...patch }
        // Context changes are revisioned so a review's frozen goal/month cannot
        // silently describe a different current context. Undo of copy is separate.
        await recordRevision([], [], false)
      } else if (command.kind === 'linkedin') {
        if (command.metadata?.destinationId) await assertFeedLinkedInDestination(actor, scope, command.metadata)
        content = { ...structured, linkedin: command.metadata ?? undefined, postFormat: command.metadata?.mode === 'post' ? 'post' : command.metadata ? 'article' : structured.postFormat }
        await recordRevision([], [], false)
      } else if (command.kind === 'email') {
        content = { ...structured, email: command.metadata }
        // Email envelope metadata and body share one monotonically increasing
        // history. There is no separately editable HTML or campaign copy.
        await recordRevision([], [], false)
      }
    }
    receipt.revision = currentRevision; receipt.sequence = sequence
    await client.query('UPDATE feed_post_working_copies SET revision=$2,mutation_id=$3,content=$4,discussion_sequence=$5,updated_at=now() WHERE session_id=$1', [actor.sessionId, currentRevision, input.mutationId, JSON.stringify(content), sequence])
    if (content.title !== copy.content.title) await client.query("UPDATE sessions SET title=(CASE WHEN split_part(title,' ',1) IN ('[instagram]','[threads]','[twitter]','[xhs]','[linkedin]','[email]') THEN split_part(title,' ',1) ELSE '[threads]' END)||' '||$2,title_manually_set=true WHERE id=$1", [actor.sessionId, content.title])
    await client.query(`INSERT INTO feed_collaboration_mutations(session_id,mutation_id,workspace_id,assistant_id,actor_user_id,actor_kind,fingerprint,command_kind,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [actor.sessionId, input.mutationId, scope.workspaceId, actor.assistantId, actor.userId, actor.kind, fingerprint, input.commands.map(c => c.kind).join(','), JSON.stringify(receipt)])
    return receipt
  }
  return transaction ? execute(transaction.client, transaction.scope) : withFeedTransaction(actor, execute)
}

export async function getFeedCollaboration(actor: FeedActor) {
  return withFeedTransaction(actor, async client => ({ runs: (await client.query(`SELECT id,kind,CASE WHEN kind IN ('text_generation','image_generation') THEN jsonb_build_object('slotId',context#>>'{slot,id}','segmentId',context->>'segmentId','briefRevision',context#>'{slot,briefRevision}','estimate',context->'estimate') END AS generation,context->>'month' AS month,context#>>'{dimensions,post_goal,sources,0,title}' AS \"goalTitle\",source_revision AS revision,status,attempts,last_error AS error,created_at AS \"createdAt\",coverage,summary_thread_id AS \"summaryThreadId\",model FROM feed_editorial_runs WHERE session_id=$1 ORDER BY created_at DESC LIMIT 30`, [actor.sessionId])).rows, reviewFindings: (await client.query(`SELECT DISTINCT ON(thread_id) thread_id AS \"threadId\",run_id AS \"runId\",finding FROM feed_review_findings WHERE session_id=$1 ORDER BY thread_id,created_at DESC`, [actor.sessionId])).rows, copy: await readFeedCopy(client, actor.sessionId), threads: await threads(client, actor.sessionId), suggestions: (await client.query<FeedSuggestion>(`SELECT ${SUGGESTION_COLUMNS} FROM feed_draft_suggestions WHERE session_id=$1 ORDER BY created_at,id`, [actor.sessionId])).rows }), false)
}
export async function getFeedThreadMessages(actor: FeedActor, threadId: string, beforeSequence = 2_000_000_000) {
  return withFeedTransaction(actor, async client => {
    const thread = (await threads(client, actor.sessionId)).find(t => t.id === threadId)
    if (!thread) throw new FeedCollaborationError(404, 'thread_not_found')
    return (await client.query(`SELECT (SELECT name FROM users WHERE id=sender_user_id) AS "senderName",id,role,content,sequence_num AS sequence,sender_user_id AS "senderUserId",created_at AS "createdAt" FROM session_messages WHERE session_id=$1 AND sequence_num<$2 ORDER BY sequence_num DESC LIMIT 50`, [thread.transcriptSessionId, beforeSequence])).rows.reverse()
  }, false)
}

async function historicalFeedContent(client: pg.PoolClient, sessionId: string, revision: number, currentRevision: number, current: StructuredFeedContent): Promise<StructuredFeedContent> {
  if (revision > currentRevision) throw new FeedCollaborationError(409, 'revision_conflict')
  if (revision === currentRevision) return current
  const row = (await client.query<{ content: PostWorkingContent }>('SELECT content FROM feed_post_revisions WHERE session_id=$1 AND revision=$2', [sessionId, revision])).rows[0]
  if (!row) throw new FeedCollaborationError(409, 'source_revision_unavailable')
  return requireFeedComposition(row.content)
}
async function mapFeedHistoricalAnchor(client: pg.PoolClient, sessionId: string, anchor: FeedAnchor, currentRevision: number, source: FeedComposition): Promise<FeedAnchor> {
  const rows = (await client.query<{ revision: number; edits: FeedEdit[]; content: StructuredFeedContent }>('SELECT revision,forward_commands AS edits,content FROM feed_post_revisions WHERE session_id=$1 AND revision>$2 AND revision<=$3 ORDER BY revision', [sessionId, anchor.sourceRevision, currentRevision])).rows
  let mapped = anchor; let composition = source; let expected = anchor.sourceRevision
  for (const row of rows) {
    if (row.revision !== ++expected) throw new FeedCollaborationError(409, 'source_history_incomplete')
    if (row.edits.length) mapped = applyFeedEdits(composition, row.edits, [mapped]).anchors[0]!
    composition = row.content.composition
  }
  if (expected !== currentRevision) throw new FeedCollaborationError(409, 'source_history_incomplete')
  return mapped
}
