/** Owner-reviewed attended MCP setup using the existing protected-source authority. [COMP:api/attended-source-setup] */
import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import type { ExecutionContext } from '@use-brian/core'
import { ApplicationPlatformError } from '@use-brian/shared'
import { SOURCE_PROTOCOL_VERSION, type SourceAuthorizationRequest } from '@use-brian/brian-app/connector'
import { getPool } from '../db/client.js'
import { buildConnectorAuthHeaders } from '../mcp/auth-headers.js'
import { createConnectorRuntimeAuthority } from './connector-runtime-authority.js'
import { createSourceAccessClient, trustedSourceEnvelope } from './source-access.js'
import { getSharedSourceDeployment } from './source-runtime.js'
import { attendedSourceActionsInput } from './attended-source-actions.js'

export const attendedSourceSetupInput = z.object({
  instanceId: z.string().uuid(),
  tenant: z.string().min(1).max(256),
  audience: z.string().url().max(2048),
  sourceBaseUrl: z.string().url().max(2048),
  httpReadPath: z.string().regex(/^\/(?!\/)[^?#\s\\]*$/).max(2048).optional(),
  probeTool: z.string().min(1).max(128),
  probeInput: z.record(z.unknown()),
  actions: attendedSourceActionsInput.optional(),
}).strict()

function denied(): never { throw new ApplicationPlatformError('access_unavailable', 'Attended connector setup is unavailable.') }
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Exact source paths are installation configuration, never model-result redirects. */
export function validateAttendedSourceEndpoints(sourceBaseUrl: string, mcpUrl: string, audience: string) {
  const base = new URL(sourceBaseUrl), mcp = new URL(mcpUrl), target = new URL(audience)
  const protectedUrl = (url: URL) => (url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1','[::1]'].includes(url.hostname))
    && !url.username && !url.password && !url.search && !url.hash
  if (!protectedUrl(base) || !protectedUrl(mcp) || base.origin !== mcp.origin
    || base.pathname !== '/' && base.pathname.endsWith('/') || target.protocol !== 'https:'
    || target.username || target.password || target.search || target.hash) denied()
}

async function assertOwner(client: PoolClient, execution: ExecutionContext) {
  const { workspaceId, userId } = execution.security.access
  if (execution.surface.readOnly || execution.identity.kind !== 'attended' || execution.identity.principal.kind !== 'workspace_member'
    || execution.identity.principal.authenticationKind !== 'native_session') denied()
  if (!(await client.query(`SELECT w.id FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id AND m.user_id=w.owner_user_id
    WHERE w.id=$1 AND w.owner_user_id=$2 AND m.role='owner' FOR SHARE OF w,m`, [workspaceId,userId])).rowCount) denied()
  await execution.security.authority.assertCurrent()
}

export async function prepareAttendedConnectorIdentity(client: PoolClient, execution: ExecutionContext) {
  await assertOwner(client, execution)
  const deployment = getSharedSourceDeployment()
  if (!deployment?.keys) denied()
  if (!await deployment.keys.loadActiveKey(deployment.issuer)) await deployment.keys.rotateSystem(deployment.issuer)
  await execution.security.authority.assertCurrent()
  return { issuer: deployment.issuer, publicJwks: await deployment.keys.publicJwks(deployment.issuer) }
}

export async function reviewAttendedSourceSetup(client: PoolClient, execution: ExecutionContext, raw: unknown) {
  await assertOwner(client, execution)
  const input = attendedSourceSetupInput.parse(raw), deployment = getSharedSourceDeployment()
  if (!deployment?.keys || !await deployment.keys.loadActiveKey(deployment.issuer)) denied()
  if (JSON.stringify(input.probeInput).length > 32_768) denied()
  const instance = await deployment.instances.getSystem(input.instanceId)
  if (!instance?.url || !instance.connected || instance.scope !== 'workspace' || instance.workspaceId !== execution.security.access.workspaceId) denied()
  validateAttendedSourceEndpoints(input.sourceBaseUrl, instance.url, input.audience)
  const native = await createConnectorRuntimeAuthority({ workspaceId: instance.workspaceId, initiatingUserId: execution.security.access.userId, assistantId: execution.assistant.id })
  if (!native.allows(instance)) denied()
  await native.assertCurrent()
  const { instanceId, ...selection } = input
  const proposal = { ...selection, issuer: deployment.issuer, mcpUrl: instance.url }
  const row = (await client.query<{ id: string }>('SELECT connector_prepare_attended_source($1,$2,$3,$4) AS id',
    [instance.workspaceId,instanceId,execution.assistant.id,proposal])).rows[0]
  const review = (await client.query<{ profileId: string; expiresAt: Date }>('SELECT profile_id AS "profileId",expires_at AS "expiresAt" FROM connector_attended_setup_reviews WHERE id=$1', [row.id])).rows[0]
  await native.assertCurrent(); await execution.security.authority.assertCurrent()
  return { reviewId: row.id, ...review, issuer: deployment.issuer, audience: input.audience, tenant: input.tenant,
    workspaceId: instance.workspaceId, connectorInstanceId: instanceId, userId: execution.security.access.userId,
    assistantId: execution.assistant.id, bindingRevision: '2', publicJwks: await deployment.keys.publicJwks(deployment.issuer),
    profile: input.actions ? 'attended_governed_actions_v1' : 'attended_governed_read_v1', state: 'pending' }
}

export async function applyAttendedSourceSetup(client: PoolClient, execution: ExecutionContext, reviewId: string) {
  await assertOwner(client, execution)
  const { workspaceId, userId } = execution.security.access
  const row = (await client.query<{ profileId: string; instanceId: string; snapshot: string; consumed: boolean; expiresAt: Date; proposal: Omit<z.infer<typeof attendedSourceSetupInput>,'instanceId'> & { issuer: string; mcpUrl: string } }>(
    `SELECT r.profile_id AS "profileId",p.connector_instance_id AS "instanceId",r.snapshot,r.consumed,r.proposal,r.expires_at AS "expiresAt"
    FROM connector_attended_setup_reviews r JOIN connector_source_profiles p ON p.id=r.profile_id
    WHERE r.id=$1 AND r.workspace_id=$2 AND r.actor_id=$3 AND r.assistant_id=$4`, [reviewId,workspaceId,userId,execution.assistant.id])).rows[0]
  if (!row) denied()
  const proposal=attendedSourceSetupInput.omit({instanceId:true}).extend({issuer:z.string().url(),mcpUrl:z.string().url()}).strict().safeParse(row.proposal)
  if(!proposal.success)denied()
  row.proposal=proposal.data
  if (row.consumed) return { profileId: (await client.query<{ id: string }>('SELECT connector_apply_attended_source($1,NULL) AS id', [reviewId])).rows[0].id, state: 'qualified' }
  if (row.expiresAt.getTime() <= Date.now()) denied()
  const deployment = getSharedSourceDeployment()
  if (!deployment?.keys || deployment.issuer !== row.proposal.issuer) denied()
  const key = await deployment.keys.loadActiveKey(deployment.issuer)
  const instance = await deployment.instances.getSystem(row.instanceId), credentials = await deployment.instances.getAuthCredentialsSystem(row.instanceId)
  if (!key || !instance || !credentials || !['bearer','custom_header'].includes(credentials.type) || instance.url !== row.proposal.mcpUrl) denied()
  validateAttendedSourceEndpoints(row.proposal.sourceBaseUrl, row.proposal.mcpUrl, row.proposal.audience)
  const native = await createConnectorRuntimeAuthority({ workspaceId, initiatingUserId: userId, assistantId: execution.assistant.id })
  const state = fingerprint([instance,credentials])
  const assertCurrent = async () => {
    await execution.security.authority.assertCurrent(); await native.assertCurrent()
    if (!native.allows(instance) || !await deployment.keys!.keyCurrent(key.kid)
      || fingerprint([await deployment.instances.getSystem(row.instanceId),await deployment.instances.getAuthCredentialsSystem(row.instanceId)]) !== state) denied()
    if ((await client.query<{ value: string | null }>('SELECT connector_attended_setup_snapshot($1,$2,$3) AS value', [workspaceId,row.instanceId,execution.assistant.id])).rows[0]?.value !== row.snapshot) denied()
  }
  const subject = { kind: 'human' as const, id: userId, executingAssistantId: execution.assistant.id }
  const source = createSourceAccessClient(execution, { issuer: deployment.issuer, audience: row.proposal.audience, workspaceId,
    connectorInstanceId: row.instanceId, sourceBaseUrl: row.proposal.sourceBaseUrl, mcpUrl: row.proposal.mcpUrl,
    tenant: row.proposal.tenant, bindingRevision: '2', subject,
    ...(row.proposal.httpReadPath ? {httpReadPath: row.proposal.httpReadPath} : {}) }, { ...deployment.keys, admit: async () => {
      await assertCurrent(); return { bindingRevision: '2', actor: { kind: 'human', userId, authenticationKind: 'native_session' } }
    } }, { headers: buildConnectorAuthHeaders(credentials) ?? {} })
  await assertCurrent()
  const capabilities = await source.capabilities()
  if (!capabilities.retentionModes.includes('governed')) denied()
  if (row.proposal.actions) {
    if (!capabilities.reconciliation || capabilities.attendedActions?.idempotencyMetadataKey !== row.proposal.actions.idempotencyMetadataKey) denied()
    const catalog = await source.discoverMcp('Attended action setup')
    if (row.proposal.actions.tools.some(name => !catalog.tools.some(tool => tool.name === name && tool.readOnlyHint !== true))) denied()
  }
  const read = await source.readMcp(row.proposal.probeTool, row.proposal.probeInput)
  const envelope = trustedSourceEnvelope(read)
  if (!envelope || envelope.resources.length === 0) denied()
  const actions = ['context','derive','retain','deliver'] as const
  for (const resource of envelope.resources) if (actions.some(action => !resource.actions.includes(action))) denied()
  const request: SourceAuthorizationRequest = { version: SOURCE_PROTOCOL_VERSION, operationId: randomUUID(),
    items: envelope.resources.flatMap(resource => actions.map(action => ({ itemId: randomUUID(), resource: resource.resource,
      fields: resource.fields, action, retentionMode: 'governed' as const }))), recipients: [{ recipientId: randomUUID(), subject }] }
  const proof = await source.authorize(request)
  const expiresAt = Math.min(...proof.response.decisions.flatMap(decision => decision.allowed ? [decision.receipt.expiresAt] : []))
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) denied()
  await assertCurrent()
  const approval = randomUUID()
  await getPool().query(`INSERT INTO connector_attended_setup_approvals(id,review_id,actor_id,snapshot,proof_digest,expires_at)
    VALUES($1,$2,$3,$4,$5,$6)`, [approval,reviewId,userId,row.snapshot,proof.requestDigest,new Date(expiresAt)])
  try {
    const profileId = (await client.query<{ id: string }>('SELECT connector_apply_attended_source($1,$2) AS id', [reviewId,approval])).rows[0].id
    await assertCurrent()
    return { profileId, bindingRevision: '2', profile: row.proposal.actions ? 'attended_governed_actions_v1' : 'attended_governed_read_v1', state: 'qualified' }
  } finally { await getPool().query('DELETE FROM connector_attended_setup_approvals WHERE id=$1', [approval]) }
}
