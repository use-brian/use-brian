/** Trusted command store. Never hand this store (or its owner connection) to an agent tool. */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { applyRLSGucs, getPool, rollbackAndRelease } from './client.js'
import { WorkspaceAccessError } from '../workspace-access/policy.js'
import { harnessScopeSchema, type HarnessRevision, type HarnessScope } from '../project-harness/contracts.js'
import { approveRevisionSchema, createHarnessRunSchema, humanEvidenceSchema,
  type HarnessApproval, type HarnessEvidence, type HarnessExecutionStore, type HarnessHumanActor, type HarnessRun,
} from '../project-harness/execution-contracts.js'
import { buildVerificationPreview, validateVerificationResult } from '../project-harness/verification.js'

const uuid = z.string().uuid()
const errors: Record<string, number> = {
  harness_not_found: 404, harness_requires_shared_project: 409, harness_human_required: 403,
  harness_owner_required: 403, harness_participant_required: 403, harness_requester_required: 403,
  harness_independent_reviewer_required: 403, harness_revision_stale: 409, harness_run_conflict: 409,
  harness_archived: 409, harness_invalid_input: 400, harness_history_immutable: 409,
}
function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new WorkspaceAccessError('harness_invalid_input', 400)
  return parsed.data
}
type Row = Record<string, any> // JSON records returned by the SQL authority boundary.
const time = (value: string | Date): string => new Date(value).toISOString()
function approval(r: Row): HarnessApproval {
  return { id: r.id, workspaceId: r.workspace_id, projectId: r.project_id, revisionId: r.revision_id,
    approvedBy: r.approved_by, approvedAt: time(r.approved_at), reason: r.reason }
}
function run(r: Row): HarnessRun {
  return { id: r.id, workspaceId: r.workspace_id, projectId: r.project_id, revisionId: r.revision_id,
    approvalId: r.approval_id, requestedBy: r.requested_by, executor: r.executor, status: r.status,
    preview: r.preview, result: r.result, createdAt: time(r.created_at), startedAt: r.started_at ? time(r.started_at) : null,
    expiresAt: time(r.expires_at), completedAt: r.completed_at ? time(r.completed_at) : null }
}
function evidence(r: Row): HarnessEvidence {
  return { id: r.id, runId: r.run_id, criterionKey: r.criterion_key, kind: r.kind, provenance: r.provenance,
    text: r.text, contentType: r.content_type, base64: r.base64, sha256: r.sha256, createdAt: time(r.created_at) }
}
function revision(r: Row): HarnessRevision {
  return { id: r.id, workspaceId: r.workspace_id, projectId: r.project_id,
    scope: r.component_id ? { kind: 'component', productId: r.product_id, componentId: r.component_id }
      : r.product_id ? { kind: 'product', productId: r.product_id } : { kind: 'project' },
    revision: Number(r.revision), definition: r.definition, createdBy: r.created_by, createdAt: time(r.created_at) }
}
function ancestry(scope: HarnessScope): [string | null, string | null] {
  const s = parse(harnessScopeSchema, scope)
  return [s.kind === 'project' ? null : s.productId, s.kind === 'component' ? s.componentId : null]
}
async function transaction<T>(actor: string, w: string, p: string, work: (c: PoolClient) => Promise<T>): Promise<T> {
  for (const id of [actor, w, p]) parse(uuid, id)
  let c: PoolClient
  try { c = await getPool().connect() } catch { throw new WorkspaceAccessError('harness_unavailable', 503) }
  try {
    await c.query('BEGIN')
    await applyRLSGucs(c, actor)
    // System pool bypasses RLS; every path explicitly uses canonical authorization.
    await c.query('SELECT public.project_harness_require($1,$2,NULL,NULL,false)', [w, p])
    const value = await work(c)
    await c.query('COMMIT')
    return value
  } catch (error) {
    if (error instanceof WorkspaceAccessError) throw error
    if (error instanceof z.ZodError) throw new WorkspaceAccessError('harness_invalid_input', 400)
    const { message, code } = error as { message?: string; code?: string }
    if (message && Object.hasOwn(errors, message)) throw new WorkspaceAccessError(message, errors[message])
    if (code && ['40001', '40P01', '23505'].includes(code)) throw new WorkspaceAccessError('harness_run_conflict', 409)
    if (code && ['23514', '23503', '22P02', '22003', '22001', '23502'].includes(code)) throw new WorkspaceAccessError('harness_invalid_input', 400)
    throw new WorkspaceAccessError('harness_unavailable', 503)
  } finally { await rollbackAndRelease(c) }
}
async function command(c: PoolClient, sql: string, values: unknown[]): Promise<Row> {
  return (await c.query<{ result: Row }>(sql, values)).rows[0].result
}
async function getRun(c: PoolClient, w: string, p: string, id: string): Promise<Row> {
  parse(uuid, id)
  const row = (await c.query('SELECT * FROM public.project_harness_runs WHERE workspace_id=$1 AND project_id=$2 AND id=$3', [w,p,id])).rows[0]
  if (!row) throw new WorkspaceAccessError('harness_not_found', 404)
  return row
}
function human(actor: HarnessHumanActor): void { parse(uuid, actor.userId); parse(uuid, actor.authSessionId) }
const screenshotSchema = z.object({ criterionKey: z.string().regex(/^[a-z][a-z0-9._-]{0,99}$/), base64: z.string().min(44).max(2796204) }).strict()
function screenshot(input: unknown): z.infer<typeof screenshotSchema> {
  const parsed = parse(screenshotSchema, input)
  const bytes = Buffer.from(parsed.base64, 'base64')
  // Bound before decoding; reject forgiving decoder aliases and non-PNG data.
  if (bytes.length < 33 || bytes.length > 2 * 1024 * 1024 || bytes.toString('base64') !== parsed.base64
    || bytes.subarray(0,16).toString('hex') !== '89504e470d0a1a0a0000000d49484452') {
    throw new WorkspaceAccessError('harness_invalid_input', 400)
  }
  return parsed
}

export function createHarnessExecutionStore(): HarnessExecutionStore {
  const action = async (actor: string, w: string, p: string, id: string, sid: string | null, mode: string, body: unknown = {}) => {
    parse(uuid, id)
    return transaction(actor,w,p,async c => {
      let payload = body
      if (mode.startsWith('complete_')) {
        const stored = await getRun(c,w,p,id)
        payload = validateVerificationResult(stored.preview, body)
      }
      return command(c,'SELECT public.harness_execution_action($1,$2,$3,$4,$5,$6::jsonb) result', [w,p,id,sid,mode,JSON.stringify(payload)])
    })
  }
  const list = (actor: string,w: string,p: string,scope: HarnessScope,table: 'approvals' | 'runs') => {
    const [product,component] = ancestry(scope)
    return transaction(actor,w,p,async c => {
      await c.query('SELECT public.project_harness_require($1,$2,$3,$4,false)', [w,p,product,component])
      if (table === 'runs') await c.query('SELECT public.harness_execution_expire($1,$2)', [w,p])
      return (await c.query(`SELECT x.* FROM public.project_harness_${table} x JOIN public.project_harness_revisions r ON r.id=x.revision_id
        WHERE x.workspace_id=$1 AND x.project_id=$2 AND r.product_id IS NOT DISTINCT FROM $3::uuid AND r.component_id IS NOT DISTINCT FROM $4::uuid
        ORDER BY x.${table === 'runs' ? 'created_at' : 'approved_at'} DESC,x.id LIMIT 100`, [w,p,product,component])).rows
    })
  }
  return {
    async approvals(user,w,p,scope) { return (await list(user,w,p,scope,'approvals')).map(approval) },
    async approve(actor,w,p,rid,expectedRevision,reason) {
      human(actor); parse(uuid,rid)
      const input = parse(approveRevisionSchema,{expectedRevision,reason})
      return approval(await transaction(actor.userId,w,p,c => command(c,
        'SELECT public.harness_execution_approve($1,$2,$3,$4,$5,$6) result', [w,p,rid,actor.authSessionId,input.expectedRevision,input.reason])))
    },
    async createRun(actor,w,p,input) {
      human(actor)
      const parsed = parse(createHarnessRunSchema,input)
      return run(await transaction(actor.userId,w,p,async c => {
        const rows = (await c.query(`SELECT r.* FROM public.project_harness_revisions r JOIN public.project_harness_approvals a
          ON a.revision_id=r.id AND a.workspace_id=r.workspace_id AND a.project_id=r.project_id
          WHERE a.workspace_id=$1 AND a.project_id=$2 AND a.id=$3`, [w,p,parsed.approvalId])).rows
        if (!rows[0]) throw new WorkspaceAccessError('harness_not_found',404)
        const id = randomUUID()
        const preview = buildVerificationPreview({runId:id,revision:revision(rows[0]),scenarioKey:parsed.scenarioKey,
          build:parsed.build,target:parsed.target,environment:parsed.environment})
        return command(c,'SELECT public.harness_execution_create($1,$2,$3,$4,$5,$6,$7::jsonb) result',
          [w,p,parsed.approvalId,actor.authSessionId,id,parsed.executor,JSON.stringify(preview)])
      }))
    },
    async runs(user,w,p,scope) { return (await list(user,w,p,scope,'runs')).map(run) },
    async run(user,w,p,id) { return transaction(user,w,p,async c => {
      await c.query('SELECT public.harness_execution_expire($1,$2)',[w,p])
      return run(await getRun(c,w,p,id))
    }) },
    async evidence(user,w,p,id) { return transaction(user,w,p,async c => {
      await getRun(c,w,p,id)
      return (await c.query('SELECT * FROM public.project_harness_evidence WHERE workspace_id=$1 AND project_id=$2 AND run_id=$3 ORDER BY created_at,id',[w,p,id])).rows.map(evidence)
    }) },
    async addHumanEvidence(actor,w,p,id,input) { human(actor); return evidence(await action(actor.userId,w,p,id,actor.authSessionId,'evidence_human',parse(humanEvidenceSchema,input))) },
    async completeHuman(actor,w,p,id,result) { human(actor); return run(await action(actor.userId,w,p,id,actor.authSessionId,'complete_human',result)) },
    async cancel(actor,w,p,id) { human(actor); return run(await action(actor.userId,w,p,id,actor.authSessionId,'cancel')) },
    async claimAgent(user,w,p,id) { return run(await action(user,w,p,id,null,'claim_agent')) },
    async authorizeAgent(user,w,p,id) { await action(user,w,p,id,null,'authorize_agent') },
    async addAgentEvidence(user,w,p,id,input) { return evidence(await action(user,w,p,id,null,'evidence_agent',screenshot(input))) },
    async completeAgent(user,w,p,id,result) { return run(await action(user,w,p,id,null,'complete_agent',result)) },
  }
}
