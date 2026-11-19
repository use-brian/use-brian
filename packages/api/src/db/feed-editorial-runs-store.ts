/** Durable Feed editorial requests, leases and saved provider receipts. [COMP:feed/draft-review] */
import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'
import { FEED_EDITORIAL_LIMITS, type FeedEditorialRunSummary, type FeedReviewCoverage, type FeedReviewDimension, type FeedReviewContext } from '@use-brian/shared'
import { canonicalFeedValue } from '@use-brian/doc-model/feed.js'
import { query } from './client.js'
import { notifyWorkspaceChange } from '../brain-stream/notify.js'
import { FeedCollaborationError, readFeedCopy, withFeedTransaction, type FeedActor, type FeedScope } from './feed-collaboration-store.js'
export type FeedEditorialKind = FeedEditorialRunSummary['kind']
export type FeedEditorialRun = Omit<FeedEditorialRunSummary, 'createdAt'> & {
  workspaceId: string; assistantId: string; sessionId: string; actorUserId: string;
  requestId: string; fingerprint: string; logicalKey: string; request: unknown; context: unknown;
  leaseId: string | null; leaseUntil: Date | null; dispatchedPart: string | null;
  result: { parts: Record<string, unknown>; [key: string]: unknown }; usage: Record<string, unknown>;
  parentRunId: string | null; createdAt: Date;
}
export const feedEditorialHash = (value: unknown) => createHash('sha256').update(canonicalFeedValue(value)).digest('hex')
const COLUMNS = `id,workspace_id AS "workspaceId",assistant_id AS "assistantId",session_id AS "sessionId",actor_user_id AS "actorUserId",kind,source_revision AS revision,request_id AS "requestId",fingerprint,logical_key AS "logicalKey",request,context,model,parent_run_id AS "parentRunId",status,attempts,lease_id AS "leaseId",lease_until AS "leaseUntil",dispatched_part AS "dispatchedPart",result,coverage,usage,last_error AS error,summary_thread_id AS "summaryThreadId",created_at AS "createdAt"`
export const editorialActor = (run: FeedEditorialRun): FeedActor => ({ userId: run.actorUserId, assistantId: run.assistantId, sessionId: run.sessionId, kind: 'assistant' })
export async function readFeedRun(client: pg.PoolClient, sessionId: string, runId: string): Promise<FeedEditorialRun> {
  const row = (await client.query<FeedEditorialRun>(`SELECT ${COLUMNS} FROM feed_editorial_runs WHERE session_id=$1 AND id=$2`, [sessionId, runId])).rows[0]
  if (!row) throw new FeedCollaborationError(404, 'run_not_found')
  return row
}
async function lockFeedRun(client: pg.PoolClient, sessionId: string, runId: string): Promise<FeedEditorialRun> {
  const row = (await client.query<FeedEditorialRun>(`SELECT ${COLUMNS} FROM feed_editorial_runs WHERE session_id=$1 AND id=$2 FOR UPDATE`, [sessionId, runId])).rows[0]
  if (!row) throw new FeedCollaborationError(404, 'run_not_found')
  return row
}
export async function getFeedRun(actor: FeedActor, runId: string) { return withFeedTransaction(actor, client => readFeedRun(client, actor.sessionId, runId), false) }
export async function listFeedRuns(actor: FeedActor) {
  return withFeedTransaction(actor, async client => (await client.query<FeedEditorialRun>(`SELECT ${COLUMNS} FROM feed_editorial_runs WHERE session_id=$1 ORDER BY created_at DESC LIMIT 30`, [actor.sessionId])).rows, false)
}
export function summarizeFeedRun(run: FeedEditorialRun): FeedEditorialRunSummary {
  const status = run.kind === 'image_generation' && run.status === 'unknown_outcome' ? 'failed' : run.status
  return { id: run.id, kind: run.kind, revision: run.revision, status, attempts: run.attempts, error: run.error, createdAt: run.createdAt.toISOString(), coverage: run.coverage, summaryThreadId: run.summaryThreadId, model: run.model, ...(['text_generation', 'image_generation'].includes(run.kind) ? { generation: { slotId: (run.context as { slot: { id: string } }).slot.id, segmentId: (run.context as { segmentId: string }).segmentId, briefRevision: (run.context as { slot: { briefRevision: number } }).slot.briefRevision, estimate: (run.context as { estimate: import('@use-brian/shared').FeedGenerationEstimate }).estimate } } : {}), ...(run.kind === 'review' ? { month: (run.context as FeedReviewContext).month, goalTitle: (run.context as FeedReviewContext).dimensions.post_goal.sources[0]?.title } : {}) }
}
export async function enqueueFeedRun(actor: FeedActor, input: {
  requestId: string; revision: number; kind: FeedEditorialKind; request: unknown; context: unknown; model: string;
  logicalKey: string; parentRunId?: string;
}, transaction?: { client: pg.PoolClient; scope: FeedScope }): Promise<FeedEditorialRun> {
  const fingerprint = feedEditorialHash(input.request)
  const execute = async (client: pg.PoolClient, scope: FeedScope) => {
    const old = (await client.query<FeedEditorialRun>(`SELECT ${COLUMNS} FROM feed_editorial_runs WHERE session_id=$1 AND request_id=$2`, [actor.sessionId, input.requestId])).rows[0]
    if (old) {
      if (old.actorUserId !== actor.userId || old.fingerprint !== fingerprint || old.kind !== input.kind) throw new FeedCollaborationError(409, 'mutation_id_reused')
      return old
    }
    const active = await client.query("SELECT id FROM feed_editorial_runs WHERE session_id=$1 AND actor_user_id=$2 AND kind=$3 AND logical_key=$4 AND status IN ('pending','running')", [actor.sessionId, actor.userId, input.kind, input.logicalKey])
    if (active.rowCount) throw new FeedCollaborationError(409, 'editorial_run_already_active')
    const copy = await readFeedCopy(client, actor.sessionId)
    if (!copy || copy.revision !== input.revision) throw new FeedCollaborationError(409, 'revision_conflict')
    if (input.parentRunId) await readFeedRun(client, actor.sessionId, input.parentRunId)
    const reusable = (await client.query<FeedEditorialRun>(`SELECT ${COLUMNS} FROM feed_editorial_runs WHERE session_id=$1 AND actor_user_id=$2 AND kind=$3 AND logical_key=$4 AND status='succeeded' AND NOT EXISTS(SELECT 1 FROM jsonb_each(coverage) c WHERE c.value->>'state'='failed') ORDER BY created_at DESC LIMIT 1`, [actor.sessionId, actor.userId, input.kind, input.logicalKey])).rows[0]
    // A separate durable request receipt can reuse a completed result and its
    // existing threads. No new model call or summary comment is needed.
    return (await client.query<FeedEditorialRun>(`INSERT INTO feed_editorial_runs(workspace_id,assistant_id,session_id,actor_user_id,kind,source_revision,request_id,fingerprint,logical_key,request,context,model,parent_run_id,status,result,coverage,usage,summary_thread_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING ${COLUMNS}`,
      [scope.workspaceId, actor.assistantId, actor.sessionId, actor.userId, input.kind, input.revision, input.requestId, fingerprint, input.logicalKey, JSON.stringify(input.request), JSON.stringify(input.context), input.model, input.parentRunId ?? reusable?.id ?? null, reusable ? 'succeeded' : 'pending', JSON.stringify(reusable?.result ?? { parts: {} }), JSON.stringify(reusable?.coverage ?? {}), '{}', reusable?.summaryThreadId ?? null])).rows[0]!
  }
  return transaction ? execute(transaction.client, transaction.scope) : withFeedTransaction(actor, execute)
}
export async function claimFeedRun(kinds: FeedEditorialKind[]): Promise<FeedEditorialRun | null> {
  // A worker crash after dispatch cannot establish that no charge occurred.
  await query(`UPDATE feed_editorial_runs SET status=CASE WHEN dispatched_part IS NOT NULL THEN 'unknown_outcome' WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,last_error=CASE WHEN dispatched_part IS NOT NULL THEN 'provider_outcome_unknown' ELSE 'worker_interrupted' END,lease_id=NULL,lease_until=NULL,updated_at=now() WHERE status='running' AND lease_until<now() AND kind=ANY($1::text[])`, [kinds])
  const leaseId = randomUUID()
  return (await query<FeedEditorialRun>(`UPDATE feed_editorial_runs SET status='running',attempts=attempts+1,lease_id=$2,lease_until=now()+($3::int*interval '1 millisecond'),updated_at=now() WHERE id=(SELECT id FROM feed_editorial_runs WHERE status='pending' AND attempts<3 AND kind=ANY($1::text[]) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING ${COLUMNS}`, [kinds, leaseId, FEED_EDITORIAL_LIMITS.leaseMs])).rows[0] ?? null
}
export async function renewFeedLease(run: FeedEditorialRun): Promise<boolean> {
  return (await query(`UPDATE feed_editorial_runs SET lease_until=now()+($3::int*interval '1 millisecond') WHERE id=$1 AND lease_id=$2 AND status='running'`, [run.id, run.leaseId, FEED_EDITORIAL_LIMITS.leaseMs])).rowCount === 1
}
export async function markFeedDispatch(run: FeedEditorialRun, part: string, estimate?: unknown): Promise<void> {
  const dispatchId = randomUUID()
  const changed = await withFeedTransaction(editorialActor(run), client => client.query(`UPDATE feed_editorial_runs SET dispatched_part=$3,result=result||jsonb_build_object('estimates',coalesce(result->'estimates','{}'::jsonb)||jsonb_build_object($3::text,$4::jsonb),'dispatches',coalesce(result->'dispatches','{}'::jsonb)||jsonb_build_object($3::text,$5::text)),updated_at=now() WHERE id=$1 AND lease_id=$2 AND status='running' AND dispatched_part IS NULL`, [run.id, run.leaseId, part, JSON.stringify(estimate ?? null), dispatchId]))
  if (changed.rowCount !== 1) throw new FeedCollaborationError(409, 'run_no_longer_active')
  run.dispatchedPart = part
  run.result.dispatches = { ...(run.result.dispatches as Record<string, string> ?? {}), [part]: dispatchId }
  notifyWorkspaceChange(run.workspaceId, 'session', 'update', run.sessionId)
}
export async function saveFeedPart(run: FeedEditorialRun, part: string, result: unknown, usage?: unknown): Promise<void> {
  const generation = run.kind === 'text_generation' || run.kind === 'image_generation'
  const dispatchId = (run.result.dispatches as Record<string, string> | undefined)?.[part]
  const saved = await withFeedTransaction(editorialActor(run), client => client.query(`UPDATE feed_editorial_runs SET result=jsonb_set(result,ARRAY['parts',$3],$4::jsonb,true),usage=jsonb_set(usage,ARRAY[$3],$5::jsonb,true),dispatched_part=NULL,updated_at=now() WHERE id=$1 AND dispatched_part=$3 AND NOT(result->'parts' ? $3) AND ((lease_id=$2 AND status='running') OR ($6::boolean AND status IN ('cancelled','unknown_outcome') AND result->'dispatches'->>$3=$7))`, [run.id, run.leaseId, part, JSON.stringify(result), JSON.stringify(usage ?? null), generation, dispatchId ?? null]))
  if (saved.rowCount !== 1) throw new FeedCollaborationError(409, 'run_no_longer_active')
  run.result.parts[part] = result; run.dispatchedPart = null
}
export async function finishFeedRun(run: FeedEditorialRun, coverage: Partial<Record<FeedReviewDimension, FeedReviewCoverage>>, summaryThreadId: string, client: pg.PoolClient): Promise<void> {
  const changed = await client.query(`UPDATE feed_editorial_runs SET status='succeeded',coverage=$3,summary_thread_id=$4,lease_id=NULL,lease_until=NULL,last_error=NULL,updated_at=now() WHERE id=$1 AND lease_id=$2 AND status='running' AND dispatched_part IS NULL`, [run.id, run.leaseId, JSON.stringify(coverage), summaryThreadId])
  if (changed.rowCount !== 1) throw new FeedCollaborationError(409, 'run_no_longer_active')
}
function supersedeFeedDispatch(run: FeedEditorialRun, error: string) {
  const result = structuredClone(run.result); const part = run.dispatchedPart
  if (!part) return { result, part, dispatchId: null }
  const dispatches = result.dispatches && typeof result.dispatches === 'object' && !Array.isArray(result.dispatches) ? result.dispatches as Record<string, unknown> : {}
  const dispatchId = typeof dispatches[part] === 'string' ? dispatches[part] as string : null
  const discarded = Array.isArray(result.discardedDispatches) ? result.discardedDispatches : []
  discarded.push({ part, dispatchId, attempt: run.attempts, error })
  delete dispatches[part]
  result.dispatches = dispatches; result.discardedDispatches = discarded
  return { result, part, dispatchId }
}
export async function failFeedRun(run: FeedEditorialRun, error: string, options?: { providerRequest?: 'not_dispatched' }) {
  const boundedError = error.slice(0, 200)
  if (options?.providerRequest === 'not_dispatched') {
    const { result, part, dispatchId } = supersedeFeedDispatch(run, boundedError)
    const changed = await query(`UPDATE feed_editorial_runs SET status=CASE WHEN attempts<$5 THEN 'pending' ELSE 'failed' END,last_error=$3,lease_id=NULL,lease_until=NULL,dispatched_part=NULL,result=$4,updated_at=now() WHERE id=$1 AND lease_id=$2 AND status='running' AND (($6::text IS NULL AND dispatched_part IS NULL) OR (dispatched_part=$6 AND result->'dispatches'->>$6=$7))`, [run.id, run.leaseId, boundedError, JSON.stringify(result), FEED_EDITORIAL_LIMITS.attempts, part, dispatchId])
    if (changed.rowCount === 1) { run.result = result; run.dispatchedPart = null }
    return
  }
  // Recovery only repeats work whose provider outcome is known. A saved part
  // can still be applied after a restart; an unanswered dispatch cannot resend.
  await query(`UPDATE feed_editorial_runs SET status=CASE WHEN dispatched_part IS NOT NULL THEN 'unknown_outcome' ELSE 'failed' END,last_error=$3,lease_id=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_id=$2 AND status='running'`, [run.id, run.leaseId, boundedError])
}
export async function cancelFeedRun(actor: FeedActor, runId: string) {
  return withFeedTransaction(actor, async client => {
    const run = await readFeedRun(client, actor.sessionId, runId)
    if (['pending', 'running'].includes(run.status)) await client.query(`UPDATE feed_editorial_runs SET status='cancelled',last_error=CASE WHEN dispatched_part IS NOT NULL THEN 'cancelled_after_dispatch' ELSE NULL END,updated_at=now() WHERE id=$1`, [runId])
    return readFeedRun(client, actor.sessionId, runId)
  })
}
export async function retryFeedRun(actor: FeedActor, runId: string) {
  return withFeedTransaction(actor, async client => {
    const run = await lockFeedRun(client, actor.sessionId, runId)
    if (run.status === 'succeeded') return run
    const incompleteImage = run.kind === 'image_generation' && run.status === 'unknown_outcome' && run.dispatchedPart === 'generation' && !run.result.parts.generation
    if ((run.dispatchedPart || run.status === 'unknown_outcome') && !incompleteImage) throw new FeedCollaborationError(409, 'fresh_explicit_attempt_required')
    if (run.attempts >= FEED_EDITORIAL_LIMITS.attempts || (!incompleteImage && !['failed', 'cancelled'].includes(run.status))) throw new FeedCollaborationError(409, 'run_not_retryable')
    if (incompleteImage) {
      // The author explicitly supersedes one image attempt. Keep its dispatch
      // token for audit, then clear the active CAS fields so a late old receipt
      // cannot attach to the new attempt.
      const { result } = supersedeFeedDispatch(run, run.error ?? 'provider_outcome_unknown')
      await client.query('UPDATE feed_editorial_runs SET result=$2,dispatched_part=NULL WHERE id=$1', [run.id, JSON.stringify(result)])
      run.result = result; run.dispatchedPart = null
    }
    if (run.kind === 'image_generation') {
      const generation = run.result.parts.generation as { imageReceipt?: { image?: unknown; error?: unknown } } | undefined
      if (generation?.imageReceipt && (generation.imageReceipt.error || !generation.imageReceipt.image)) {
        const result = structuredClone(run.result); const usage = structuredClone(run.usage)
        const discarded = Array.isArray(result.discardedParts) ? result.discardedParts : []
        discarded.push({ part: 'generation', response: result.parts.generation, usage: usage.generation, attempt: run.attempts })
        delete result.parts.generation; delete usage.generation; result.discardedParts = discarded
        await client.query('UPDATE feed_editorial_runs SET result=$2,usage=$3 WHERE id=$1', [run.id, JSON.stringify(result), JSON.stringify(usage)])
      }
    }
    if (run.kind === 'confirmation_learning' && run.result.invalidParts) {
      const result = structuredClone(run.result)
      const discarded = Array.isArray(result.discardedParts) ? result.discardedParts : []
      for (const part of Object.keys(result.invalidParts as Record<string, unknown>)) {
        if (part in result.parts) { discarded.push({ part, response: result.parts[part], usage: run.usage[part], attempt: run.attempts }); delete result.parts[part] }
      }
      result.discardedParts = discarded; delete result.invalidParts
      await client.query('UPDATE feed_editorial_runs SET result=$2 WHERE id=$1', [run.id, JSON.stringify(result)])
    }
    await client.query(`UPDATE feed_editorial_runs SET status='pending',last_error=NULL,lease_id=NULL,lease_until=NULL,updated_at=now() WHERE id=$1`, [run.id])
    return readFeedRun(client, actor.sessionId, runId)
  })
}
