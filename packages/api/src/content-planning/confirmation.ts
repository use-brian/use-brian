import { buildLinkedInPayload, type LinkedInPayload } from './linkedin-payload.js'
/** Atomic editorial finish; provider delivery is a subsequent boundary. [COMP:feed/confirmation-learning] */
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { feedLinkedInFileIds, feedConfirmationRequestSchema, type FeedConfirmationRequest, type FeedConfirmationSummary, type FeedLearningScope } from '@use-brian/shared'
import { canonicalFeedValue, walkFeed } from '@use-brian/doc-model'
import { withFeedTransaction, readFeedCopy, requireFeedComposition, assertFeedFiles, FeedCollaborationError, type FeedActor, type FeedScope, type StructuredFeedContent } from '../db/feed-collaboration-store.js'
import { appendDecisionEvent } from '../db/decision-event-store.js'
import { enqueueFeedRun, feedEditorialHash } from '../db/feed-editorial-runs-store.js'
import { feedOutputProjection, type FeedSavedCanonical } from './projection.js'
import { notifyWorkspaceChange } from '../brain-stream/notify.js'
import { getGoalById } from '../db/goals.js'
export type FeedConfirmationHistory = {
  revisions: number[]; eventIds: string[]; messageIds: string[];
  proposals: { id: string; status: string; parentId: string | null; acceptedRevision: number | null }[];
  goal?: { id: string; outcome: string; brief: unknown; doneWhen: unknown; updatedAt: string; contextGroupId: string | null; contextProjectId: string | null } | null;
  /** Detect source editing after the cutoff without copying transcripts. */
  sourceHashes?: Record<string, string>;
  fileIds?: string[];
}
export type FeedConfirmation = {
  id: string; workspaceId: string; assistantId: string; sessionId: string; revision: number;
  actorUserId: string; content: StructuredFeedContent; projection: ReturnType<typeof feedOutputProjection> & { linkedinPayload?: LinkedInPayload };
  history: FeedConfirmationHistory; historyCutoff: Date; scope: FeedLearningScope;
  priorConfirmationId: string | null; reviewRunId: string | null; createdAt: Date;
}
const columns = `id,workspace_id AS "workspaceId",assistant_id AS "assistantId",session_id AS "sessionId",source_revision AS revision,actor_user_id AS "actorUserId",content,projection,history,history_cutoff AS "historyCutoff",scope,prior_confirmation_id AS "priorConfirmationId",review_run_id AS "reviewRunId",created_at AS "createdAt"`
export async function readFeedConfirmation(client: pg.PoolClient, sessionId: string, id: string): Promise<FeedConfirmation> {
  const row = (await client.query<FeedConfirmation>(`SELECT ${columns} FROM feed_post_confirmations WHERE session_id=$1 AND id=$2`, [sessionId, id])).rows[0]
  if (!row) throw new FeedCollaborationError(404, 'confirmation_not_found')
  return row
}
export async function confirmFeedPost(actor: FeedActor, raw: FeedConfirmationRequest, options: {
  source?: { canonical: FeedSavedCanonical; platform: string };
  transaction?: { client: pg.PoolClient; scope: FeedScope };
} = {}) {
  const input = feedConfirmationRequestSchema.parse(raw)
  if (actor.kind !== 'user') throw new FeedCollaborationError(403, 'member_confirmation_required')
  const fingerprint = feedEditorialHash({ kind: 'confirmation', input, source: options.source ?? null })
  const execute = async (client: pg.PoolClient, access: FeedScope) => {
    const priorReceipt = (await client.query('SELECT actor_user_id,actor_kind,fingerprint,receipt FROM feed_collaboration_mutations WHERE session_id=$1 AND mutation_id=$2', [actor.sessionId, input.mutationId])).rows[0]
    if (priorReceipt) {
      if (priorReceipt.actor_user_id !== actor.userId || priorReceipt.actor_kind !== actor.kind || priorReceipt.fingerprint !== fingerprint) throw new FeedCollaborationError(409, 'mutation_id_reused')
      const confirmation = await readFeedConfirmation(client, actor.sessionId, priorReceipt.receipt.confirmationId)
      if (await isFeedConfirmationRevoked(client, confirmation.id)) throw new FeedCollaborationError(409, 'revoked_confirmation_requires_revision')
      await assertFeedFiles(client, actor, access, confirmation.content.composition, [], confirmation.content.linkedin)
      return { confirmation, runId: priorReceipt.receipt.runId as string }
    }
    const copy = await readFeedCopy(client, actor.sessionId)
    if (!copy || copy.revision !== input.expectedRevision) throw new FeedCollaborationError(409, 'revision_conflict')
    const content = requireFeedComposition(copy.content)
    if (options.source && (options.source.canonical.revision !== copy.revision || canonicalFeedValue(options.source.canonical.content) !== canonicalFeedValue(content))) throw new FeedCollaborationError(409, 'saved_composition_conflict')
    await assertFeedFiles(client, actor, access, content.composition, [], content.linkedin)
    const session = (await client.query('SELECT title,context_compartments,context_project_id FROM sessions WHERE id=$1', [actor.sessionId])).rows[0]
    const platform = options.source?.platform ?? /^\[([^\]]+)\]/.exec(session.title)?.[1] ?? 'threads'
    const projection: FeedConfirmation['projection'] = feedOutputProjection(content, platform)
    if (platform === 'linkedin' && content.linkedin?.destinationId && content.linkedin.mode !== 'newsletter_edition') {
      const prepared = await buildLinkedInPayload(actor, access, content, copy.revision)
      if (input.linkedinPreviewHash !== prepared.hash) throw new FeedCollaborationError(409, 'linkedin_preview_required')
      projection.linkedinPayload = prepared.payload
    }
    if (projection.issues.length) throw new FeedCollaborationError(409, projection.issues[0]!.code)
    const existing = (await client.query<FeedConfirmation>(`SELECT ${columns} FROM feed_post_confirmations WHERE session_id=$1 AND source_revision=$2`, [actor.sessionId, copy.revision])).rows[0]
    let confirmation = existing
    let runId: string
    if (existing) {
      if (existing.projection.platform !== platform) throw new FeedCollaborationError(409, 'confirmed_platform_conflict')
      if (await isFeedConfirmationRevoked(client, existing.id)) throw new FeedCollaborationError(409, 'revoked_confirmation_requires_revision')
      const run = (await client.query("SELECT id FROM feed_editorial_runs WHERE session_id=$1 AND kind='confirmation_learning' AND logical_key=$2 ORDER BY created_at LIMIT 1", [actor.sessionId, `confirmation:${existing.id}`])).rows[0]
      if (!run) throw new FeedCollaborationError(409, 'confirmation_job_unavailable')
      runId = run.id
    } else {
      if (input.reviewRunId && !(await client.query("SELECT 1 FROM feed_editorial_runs WHERE session_id=$1 AND id=$2 AND kind='review'", [actor.sessionId, input.reviewRunId])).rowCount) throw new FeedCollaborationError(404, 'review_not_found')
      const revisions = (await client.query<{ revision: number; content: StructuredFeedContent }>('SELECT revision,content FROM feed_post_revisions WHERE session_id=$1 AND revision<=$2 ORDER BY revision', [actor.sessionId, copy.revision])).rows
      const history: FeedConfirmationHistory = {
        revisions: revisions.map(row => row.revision),
        eventIds: (await client.query('SELECT id FROM decision_events WHERE session_id=$1 ORDER BY created_at,id', [actor.sessionId])).rows.map(row => row.id),
        messageIds: (await client.query('SELECT m.id FROM session_messages m JOIN feed_comment_threads t ON t.transcript_session_id=m.session_id WHERE t.session_id=$1 ORDER BY m.created_at,m.id', [actor.sessionId])).rows.map(row => row.id),
        proposals: (await client.query<{ id: string; status: string; parentId: string | null; acceptedRevision: number | null }>('SELECT id,status,parent_id AS "parentId",(acceptance_receipt->>\'revision\')::int AS "acceptedRevision" FROM feed_draft_suggestions WHERE session_id=$1 ORDER BY created_at,id', [actor.sessionId])).rows,
      }
      let goalCompartment: string | null = null
      if (content.goalId) {
        const goal = await getGoalById(actor.userId, content.goalId, client)
        if (goal?.workspaceId === access.workspaceId) {
          history.goal = { id: goal.id, outcome: goal.outcome, brief: goal.brief, doneWhen: goal.doneWhen, updatedAt: goal.updatedAt.toISOString(), contextGroupId: goal.contextGroupId, contextProjectId: goal.contextProjectId }
          if (goal.contextGroupId) goalCompartment = (await client.query('SELECT compartment_key FROM workspace_groups WHERE id=$1 AND workspace_id=$2', [goal.contextGroupId, access.workspaceId])).rows[0]?.compartment_key ?? null
        }
        else history.goal = null
      }
      history.sourceHashes = Object.fromEntries((await client.query<{ key: string; hash: string }>(`
        SELECT 'message:'||m.id AS key,encode(sha256(convert_to(m.content::text,'UTF8')),'hex') AS hash
          FROM session_messages m WHERE m.id=ANY($1::uuid[])
        UNION ALL SELECT 'proposal:'||p.id,encode(sha256(convert_to(jsonb_build_object('edits',p.edits,'rationale',p.rationale)::text,'UTF8')),'hex')
          FROM feed_draft_suggestions p WHERE p.id=ANY($2::uuid[])`, [history.messageIds, history.proposals.map(item => item.id)])).rows.map(row => [row.key, row.hash]))
      const files = [...new Set([...revisions.flatMap(row=>feedLinkedInFileIds(row.content.linkedin)), ...revisions.flatMap(row => row.content.schemaVersion === 2 && row.content.composition ? walkFeed(row.content.composition).flatMap(({ node }) => node.type === 'image' ? [node.attrs.fileId] : node.type === 'generationPlaceholder' ? node.attrs.references.flatMap(ref => 'fileId' in ref ? [ref.fileId] : []) : []) : [])])]
      history.fileIds = files
      const sourceScopes = (await client.query<{ sensitivity: FeedLearningScope['sensitivity']; compartments: string[]; project_ids: string[] }>('SELECT sensitivity,compartments,project_ids FROM workspace_files WHERE workspace_id=$1 AND id=ANY($2::uuid[])', [access.workspaceId, files])).rows
      const ranks: FeedLearningScope['sensitivity'][] = ['public', 'internal', 'confidential', 'restricted']
      const scope: FeedLearningScope = { platform, postFormat: projection.postFormat, brandId: (await client.query('SELECT id FROM workspace_brands WHERE workspace_id=$1 AND is_default=true AND active_version_id IS NOT NULL LIMIT 1', [access.workspaceId])).rows[0]?.id ?? null,
        sensitivity: ranks[Math.max(1, ranks.indexOf(content.sourceSensitivity ?? 'public'), ...sourceScopes.map(row => ranks.indexOf(row.sensitivity)))]!, compartments: [...new Set([...(content.sourceCompartments ?? []), ...(session.context_compartments ?? []), ...(goalCompartment ? [goalCompartment] : []), ...sourceScopes.flatMap(row => row.compartments)])], projectIds: [...new Set([...(content.sourceProjectIds ?? []), ...(session.context_project_id ? [session.context_project_id] : []), ...(history.goal?.contextProjectId ? [history.goal.contextProjectId] : []), ...sourceScopes.flatMap(row => row.project_ids)])] }
      const prior = (await client.query('SELECT id FROM feed_post_confirmations WHERE session_id=$1 ORDER BY source_revision DESC LIMIT 1', [actor.sessionId])).rows[0]?.id ?? null
      confirmation = (await client.query<FeedConfirmation>(`INSERT INTO feed_post_confirmations(workspace_id,assistant_id,session_id,source_revision,actor_user_id,content,projection,history,discussion_sequence,scope,prior_confirmation_id,review_run_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${columns}`, [access.workspaceId, actor.assistantId, actor.sessionId, copy.revision, actor.userId, JSON.stringify(content), JSON.stringify(projection), JSON.stringify(history), copy.sequence, JSON.stringify(scope), prior, input.reviewRunId ?? null])).rows[0]!
      await appendDecisionEvent({ idempotencyKey: `feed:confirmed:${confirmation.id}`, workspaceId: access.workspaceId, actorUserId: actor.userId, assistantId: actor.assistantId, sessionId: actor.sessionId, sourceKind: 'feed_confirmation', sourceId: confirmation.id, declaredScope: 'instance', visibility: 'workspace', sensitivity: scope.sensitivity, eventKind: 'feed.post_confirmed', payload: { confirmationId: confirmation.id, revision: copy.revision, priorConfirmationId: prior } }, client)
      const run = await enqueueFeedRun(actor, { requestId: randomUUID(), revision: copy.revision, kind: 'confirmation_learning', request: { confirmationId: confirmation.id, locale: input.locale }, context: { confirmationId: confirmation.id }, model: 'configured-background', logicalKey: `confirmation:${confirmation.id}` }, { client, scope: access })
      runId = run.id
      await client.query("INSERT INTO feed_learning_outputs(workspace_id,assistant_id,session_id,confirmation_id,actor_user_id,kind,scope,suppression_key) VALUES($1,$2,$3,$4,$5,'summary',$6,$7)", [access.workspaceId, actor.assistantId, actor.sessionId, confirmation.id, actor.userId, JSON.stringify(scope), `feed:${confirmation.id}:summary`])
    }
    const receipt = { mutationId: input.mutationId, revision: copy.revision, sequence: copy.sequence, confirmationId: confirmation.id, runId, threadIds: [], suggestionIds: [] }
    await client.query("INSERT INTO feed_collaboration_mutations(session_id,mutation_id,workspace_id,assistant_id,actor_user_id,actor_kind,fingerprint,command_kind,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,'confirmation',$8)", [actor.sessionId, input.mutationId, access.workspaceId, actor.assistantId, actor.userId, actor.kind, fingerprint, JSON.stringify(receipt)])
    return { confirmation, runId }
  }
  const result = options.transaction ? await execute(options.transaction.client, options.transaction.scope) : await withFeedTransaction(actor, execute)
  if (!options.transaction) notifyWorkspaceChange(result.confirmation.workspaceId, 'session', 'update', actor.sessionId)
  return result
}
export async function isFeedConfirmationRevoked(client: pg.PoolClient, id: string) {
  return Boolean((await client.query("SELECT 1 FROM decision_events WHERE event_kind='feed.confirmation_revoked' AND payload->>'confirmationId'=$1", [id])).rowCount)
}
export async function listFeedConfirmations(actor: FeedActor): Promise<FeedConfirmationSummary[]> {
  return withFeedTransaction(actor, async client => {
    const rows = (await client.query<FeedConfirmation & { revoked: boolean }>(`SELECT ${columns},EXISTS(SELECT 1 FROM decision_events de WHERE de.event_kind='feed.confirmation_revoked' AND de.payload->>'confirmationId'=feed_post_confirmations.id::text) AS revoked FROM feed_post_confirmations WHERE session_id=$1 ORDER BY source_revision DESC LIMIT 30`, [actor.sessionId])).rows
    const copy = await readFeedCopy(client, actor.sessionId)
    return rows.map(row => ({ id: row.id, revision: row.revision, actorUserId: row.actorUserId, createdAt: row.createdAt.toISOString(), priorConfirmationId: row.priorConfirmationId, reviewRunId: row.reviewRunId, revoked: row.revoked, current: !row.revoked && row.revision === copy?.revision }))
  }, false)
}
