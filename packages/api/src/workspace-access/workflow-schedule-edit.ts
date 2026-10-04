/** Explicit prepare/apply consent for ready-mode schedule editing. One owned
 * transaction/connection, workspace -> workflow -> firing rows. */
import type { PoolClient } from 'pg'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { intersectAccessCeilings, type AuthoringAuthority, type WorkflowStore } from '@use-brian/core'
import { admitOperationalAuthoring, lockOperationalPolicy } from './operational-admission.js'
import { WorkspaceAccessError } from './policy.js'

type Fields = Parameters<WorkflowStore['update']>[2]
type Proof = NonNullable<Parameters<WorkflowStore['update']>[3]>
type Policy = Awaited<ReturnType<typeof lockOperationalPolicy>>
const columns = { name: 'name', description: 'description', definition: 'definition', enabled: 'enabled', trigger: 'trigger',
  modelAlias: 'model_alias', maxTurns: 'max_turns', researchMode: 'research_mode', contextGroupId: 'context_group_id',
  contextProjectId: 'context_project_id', nameManuallySet: 'name_manually_set', pinned: 'pinned', lifecycleState: 'lifecycle_state' } as const
function fail(code: string): never { throw new WorkspaceAccessError(code,409) }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  return JSON.stringify(value)
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')

export async function scheduleEditRow(client: PoolClient, id: string): Promise<Record<string, any>> {
  return (await client.query('SELECT to_jsonb(w) AS row FROM workflows w WHERE id=$1', [id])).rows[0].row
}
async function session(client: PoolClient, row: Record<string, any>, userId: string, proof: Proof | undefined, policy: Policy) {
  if (!proof || proof.kind !== 'authenticated-workflow-rest' || proof.userId !== userId || !proof.authSessionId) fail('operational_authoring_proof_required')
  if (policy?.setupState !== 'ready') fail('workflow_schedule_review_unavailable')
  if (proof.expectedPolicyRevision !== undefined && proof.expectedPolicyRevision !== policy.revision) fail('access_policy_conflict')
  const live = await client.query(`SELECT s.id FROM auth_sessions s JOIN users u ON u.id=s.user_id
    JOIN workspace_members m ON m.user_id=u.id AND m.workspace_id=$3
    WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
      AND s.auth_version=u.auth_version FOR SHARE OF s,u,m`, [proof.authSessionId,userId,row.workspace_id])
  if (!live.rows.length) fail('operational_authoring_proof_required')
}
function after(row: Record<string, any>, fields: Fields) {
  const value = { ...row }
  for (const [key,v] of Object.entries(fields)) {
    if (v === undefined) continue
    if (!(key in columns)) fail('workflow_schedule_edit_unsupported')
    value[columns[key as keyof typeof columns]] = v
  }
  if (value.managed_by || value.definition.principal || !['manual','schedule'].includes(value.trigger.kind)) fail('workflow_schedule_edit_unsupported')
  if (value.lifecycle_state === 'stale') value.lifecycle_state = 'active'
  return value
}

export async function prepareScheduleEdit(client: PoolClient, userId: string, id: string, fields: Fields, proof: Proof, policy: Policy,
  primary?: (workspaceId: string, client: PoolClient) => Promise<string | null>) {
  const row = await scheduleEditRow(client,id)
  await session(client,row,userId,proof,policy)
  const value = after(row,fields)
  if (row.trigger.kind !== 'schedule' && value.trigger.kind !== 'schedule') fail('workflow_schedule_edit_unsupported')
  const assistantId = await primary?.(row.workspace_id,client)
  if (!assistantId) fail('workflow_authoring_primary_unavailable')
  // Omitted bindings keep their exact saved value, including explicit General.
  const admitted = await admitOperationalAuthoring(client,{ userId,workspaceId: row.workspace_id,
    contextGroupId: value.context_group_id,contextProjectId: value.context_project_id }, { userId,assistantId })
  const captured = admitted.authoringAuthority!
  const team = value.context_group_id ? (await client.query('SELECT compartment_key FROM workspace_groups WHERE id=$1 AND workspace_id=$2', [value.context_group_id,row.workspace_id])).rows[0]?.compartment_key : null
  // This bounded lane never grants an open universe, including read axes.
  const finite = intersectAccessCeilings(captured.ceiling,{ ...captured.ceiling,
    compartments: team ? [team] : [],mutationCompartments: team ? [team] : [],
    projectIds: value.context_project_id ? [value.context_project_id] : [], visibilityAssistantIds: [assistantId] })
  value.authoring_authority = { ...captured,ceiling: finite }
  value.schedule_authoring_user_id = userId
  const shapes = (await client.query('SELECT workflow_schedule_review_shape($1::jsonb) AS before,workflow_schedule_review_shape($2::jsonb) AS after',
    [JSON.stringify(row),JSON.stringify(value)])).rows[0]
  const reviewId = randomUUID(), expiresAt = new Date(Date.now()+10*60_000).toISOString()
  const workflowVersion = hash(row)
  const payloadHash = hash({ reviewId,expiresAt,workflowVersion,userId,sessionId: proof.authSessionId,policyRevision: policy!.revision,
    before: shapes.before,after: shapes.after,patch: JSON.parse(JSON.stringify(fields)) })
  // The receipt's actor is the connection's app.current_user_id, never an argument.
  await client.query('SELECT workflow_schedule_review_create($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9)',
  [reviewId,id,proof.authSessionId,policy!.revision,JSON.stringify(row),JSON.stringify(shapes.after),JSON.stringify(fields),payloadHash,expiresAt])
  return { reviewId,payloadHash,expiresAt,workflowVersion,policyRevision: policy!.revision,before: shapes.before,after: shapes.after }
}

export async function applyScheduleEdit(client: PoolClient, userId: string, id: string, fields: Fields, proof: Proof, policy: Policy) {
  const row = await scheduleEditRow(client,id)
  await session(client,row,userId,proof,policy)
  const r = (await client.query('SELECT * FROM workflow_schedule_review_claim($1,$2,$3)',
    [proof.reviewId,id,proof.authSessionId])).rows[0]
  if (!r || !proof.payloadHash || r.payload_hash !== proof.payloadHash || !isDeepStrictEqual(r.patch,JSON.parse(JSON.stringify(fields)))) fail('workflow_schedule_review_stale')
  if (r.policy_revision !== policy!.revision) fail('access_policy_conflict')
  // A consumed receipt is a read-only retry, even after its preview expires.
  // It must still belong to this live actor/session and current policy.
  if (r.apply_txid && r.result_record) return { fields,replayRow: r.result_record }
  if (r.apply_txid || new Date(r.expires_at).getTime() <= Date.now() || !isDeepStrictEqual(r.before_row,row)) fail('workflow_schedule_review_stale')
  const authority = r.after_shape.authoring_authority as AuthoringAuthority
  if (!authority.assistantId) fail('workflow_schedule_review_stale')
  // Revalidate saved reviewed consent, NEVER recapture/renew it during apply.
  await admitOperationalAuthoring(client,{ userId,workspaceId: row.workspace_id,contextGroupId: r.after_shape.context_group_id,
    contextProjectId: r.after_shape.context_project_id,authoringAuthority: authority }, { userId,assistantId: authority.assistantId })
  await client.query('SELECT workflow_schedule_review_mark_applied($1)', [r.id])
  await client.query("SELECT set_config('app.workflow_schedule_review',$1,true)", [r.id])
  return { fields: { ...fields,authoringAuthority: authority },replayRow: null }
}
