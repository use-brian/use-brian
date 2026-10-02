import { createHash } from 'node:crypto'
import { connectorReconnectProjection } from './reconnect-projection.js'
import { z } from 'zod'
import { lockConnectorSetupWorkspaces } from './setup-locks.js'
import type { Pool, PoolClient } from 'pg'
import type { ResourceDestination } from '@use-brian/shared'
import { admitWorkspaceResource } from '../workspace-access/resource-admission.js'
import { encryptCredentials } from '../db/credential-crypto.js'
import type { ConnectorCredentials } from '../db/connector-store.js'
import { ConnectorSetupError, createConnectorSetupService, type SetupContext, type SetupIntent, type VerifiedAccount } from './setup-service.js'

/** A server-installed verifier, not client claims or a provider catalog exception. */
export type SetupProviderAdapter = {
  verify(proof: unknown, callback: { state: string }): Promise<{ credentials: ConnectorCredentials; account: VerifiedAccount; label: string; config: Record<string, unknown> }>
}
export type ConnectorSetupRequest = {
  workspaceId: string
  provider: string
  operation: 'create' | 'reconnect' | 'share' | 'transfer'
  ownership: 'personal' | 'workspace'
  instanceId?: string
  expectedInstanceVersion?: string
  destination?: ResourceDestination
  sensitivity: 'public' | 'internal' | 'confidential'
  expectedPolicyRevision: string
  /** Set from requireAuth, never from the JSON request. */
  authSessionId: string
  /** Trusted transport adapter only; never copied into intent/review. */
  oauth?: { shopDomain: string; clientId: string; clientSecret: string; redirectUri: string }
}
type Staged = { credentials: ConnectorCredentials; label: string; config: Record<string, unknown> }
function deny(code: string): never { throw new ConnectorSetupError(code) }
const accountHash = (a: VerifiedAccount) => createHash('sha256').update(JSON.stringify({
  subject: a.subject, tenant: a.tenant, roots: [...a.roots].sort(), permissions: [...a.permissions].sort(), adapter: a.adapter, adapterVersion: a.adapterVersion,
})).digest('hex')

/** All publication writes use the setup transaction's client. There is no active
 * instance, grant, credential lookup or ingest routing before explicit consent.
 * No provider adapter in this module certifies finite-context catalog access. */
export function createTransactionalConnectorSetup(options: { pool: Pool; encryptionKey: Buffer; adapters: ReadonlyMap<string, SetupProviderAdapter> }) {
  async function human(c: PoolClient, actor: string, session: string) {
    return !!(await c.query(`SELECT s.id FROM auth_sessions s JOIN users u ON u.id=s.user_id
      WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
        AND s.auth_version=u.auth_version FOR SHARE OF s,u`, [session, actor])).rowCount
  }
  async function target(c: PoolClient, id: string) {
    return (await c.query(`SELECT *,setup_version::text AS version FROM connector_instance WHERE id=$1 FOR UPDATE`, [id])).rows[0]
  }
  async function grants(c: PoolClient, id: string) {
    return (await c.query<{ id: string; version: string }>(`SELECT id,setup_version::text AS version FROM connector_grant
      WHERE connector_instance_id=$1 ORDER BY id FOR UPDATE`, [id])).rows
  }
  async function validate(c: PoolClient, s: SetupContext, checkTarget = true) {
    if (!s.workspaceId || !await human(c, s.actorId, s.intent.sessionBinding)) return false
    const m = (await c.query('SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE', [s.workspaceId, s.actorId])).rows[0]
    if (!m || !['owner', 'admin', 'member'].includes(m.role)) return false
    if ((s.intent.ownership === 'workspace' || s.intent.operation === 'transfer') && !['owner', 'admin'].includes(m.role)) return false
    if (checkTarget && s.intent.target) {
      const t = await target(c, s.intent.target.instanceId)
      if (!t || t.provider !== s.provider || t.version !== s.intent.target.version) return false
      if (t.scope === 'user' ? t.user_id !== s.actorId : t.workspace_id !== s.workspaceId || !['owner', 'admin'].includes(m.role)) return false
      if (JSON.stringify(await grants(c, t.id)) !== JSON.stringify(s.intent.target.grants)) return false
    }
    try {
      await admitWorkspaceResource(c, s.workspaceId, s.actorId, {
        expectedPolicyRevision: s.policyRevision!, visibility: s.intent.ownership === 'personal' && s.intent.operation !== 'share' ? 'private' : 'workspace',
        sensitivity: s.intent.binding.sensitivityFloor as ConnectorSetupRequest['sensitivity'],
        requestedLabels: { compartments: s.intent.binding.departments, projectIds: s.intent.binding.projects },
      })
      return true
    } catch { return false }
  }
  const service = createConnectorSetupService<ConnectorSetupRequest, unknown, Staged>({
    ...options,
    startMaterial: r => r.oauth,
    validateStage: true,
    validateCommit: async (c, s, expiresAt) => {
      // Our publication deliberately changed target/grant versions. Recheck
      // actor and admitted envelope, not the old snapshot against our writes.
      if (!await validate(c, s, false)) return false
      return !!(await c.query(`SELECT 1 FROM auth_sessions a JOIN users u ON u.id=a.user_id
        JOIN workspace_members m ON m.user_id=a.user_id AND m.workspace_id=$3
        JOIN workspace_access_policies p ON p.workspace_id=m.workspace_id
        WHERE a.id=$1 AND a.user_id=$2 AND a.revoked_at IS NULL AND a.auth_version=u.auth_version
          AND a.expires_at>clock_timestamp() AND $4::timestamptz>clock_timestamp()
          AND p.revision=$5 AND m.role IN ('owner','admin','member')`,
      [s.intent.sessionBinding, s.actorId, s.workspaceId, expiresAt, s.policyRevision])).rowCount
    },
    authorityValidForMs: async (c, s) => (await c.query<{ ms: number }>(`SELECT greatest(0,least(30000,
      floor(extract(epoch FROM (expires_at-clock_timestamp()))*1000)))::integer AS ms
      FROM auth_sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL`, [s.intent.sessionBinding, s.actorId])).rows[0]?.ms ?? 0,
    lockWorkspaces: (c, s) => lockConnectorSetupWorkspaces(c, s.workspaceId, s.intent.target?.instanceId),
    async admit(c, actor, r) {
      if (!options.adapters.has(r.provider)) deny('connector_setup_provider_unsupported')
      await lockConnectorSetupWorkspaces(c, r.workspaceId, r.instanceId)
      if (!await human(c, actor, r.authSessionId)) deny('connector_setup_human_required')
      const t = r.instanceId ? await target(c, r.instanceId) : null
      if ((r.operation === 'create') !== !r.instanceId || (r.instanceId && !t)) deny('connector_setup_target_invalid')
      if (t && (t.provider !== r.provider || (t.scope === 'user' ? t.user_id !== actor : t.workspace_id !== r.workspaceId))) deny('connector_setup_forbidden')
      if (r.expectedInstanceVersion !== undefined && (!t || t.version !== r.expectedInstanceVersion)) deny('connector_setup_target_changed')
      if (t && r.operation !== 'reconnect' && t.scope !== 'user') deny('connector_setup_target_invalid')
      if (r.operation === 'reconnect' && r.ownership !== (t.scope === 'user' ? 'personal' : 'workspace')) deny('connector_setup_scope_changed')
      if ((r.operation === 'share' && r.ownership !== 'personal') || (r.operation === 'transfer' && r.ownership !== 'workspace')) deny('connector_setup_target_invalid')
      const existingGrants = t ? await grants(c, t.id) : []
      // Transferring multi-workspace credentials needs a separate review per
      // retained exposure. Never silently delete another workspace's grants.
      if (r.operation === 'transfer' && existingGrants.length) deny('connector_setup_transfer_has_grants')
      if (r.operation === 'share' && (await c.query('SELECT 1 FROM connector_grant WHERE connector_instance_id=$1 AND target_id=$2', [t.id, r.workspaceId])).rowCount) deny('connector_setup_already_shared')
      const inherited = t ? {
        visibility: r.ownership === 'personal' && r.operation !== 'share' ? 'private' as const : 'workspace' as const,
        sensitivity: t.sensitivity, compartments: t.compartments, projectIds: t.project_ids,
      } : undefined
      if (r.operation === 'reconnect' && inherited && (r.destination || r.sensitivity !== inherited.sensitivity)) deny('connector_setup_scope_changed')
      // Grants have no independent sensitivity column. Do not claim a higher
      // floor than the unchanged personal instance actually enforces.
      if (r.operation === 'share' && r.sensitivity !== t.sensitivity) deny('connector_setup_scope_changed')
      const a = await admitWorkspaceResource(c, r.workspaceId, actor, {
        expectedPolicyRevision: r.expectedPolicyRevision, visibility: r.ownership === 'personal' && r.operation !== 'share' ? 'private' : 'workspace',
        sensitivity: r.sensitivity, destination: r.destination, inherited,
      })
      const intent: SetupIntent = { operation: r.operation, surface: 'authenticated-settings', ownership: r.ownership,
        credentialOwnerId: t?.user_id ?? actor,
        target: t ? { instanceId: t.id, version: t.version, grants: existingGrants } : null,
        binding: { departments: a.envelope.compartments, projects: a.envelope.projectIds, origin: a.origin, sensitivityFloor: a.envelope.sensitivity },
        importDestination: null, ingestionOptIn: false, authorityReferences: [], boundaryProposal: 'no-catalog-exception',
        sessionBinding: r.authSessionId, redirectIdentity: r.oauth?.redirectUri ?? 'authenticated-manual-proof' }
      return { workspaceId: r.workspaceId, provider: r.provider, intent }
    },
    lockAndValidate: validate,
    async verifyProvider(s, proof, callback, material) {
      const adapter = options.adapters.get(s.provider)
      if (!adapter) deny('connector_setup_provider_unsupported')
      if (material !== undefined) {
        const auth = z.object({ shopDomain: z.string(), clientId: z.string(), clientSecret: z.string(), redirectUri: z.string() }).strict().parse(material)
        const request = z.object({ params: z.record(z.string(), z.string().max(8192)) }).strict().parse(proof)
        if (s.provider !== 'shopify' || request.params.shop !== auth.shopDomain || s.intent.redirectIdentity !== auth.redirectUri) deny('connector_setup_binding_mismatch')
        proof = { kind: 'oauth', params: request.params, clientId: auth.clientId, clientSecret: auth.clientSecret }
      }
      const v = await adapter.verify(proof, callback)
      return { credentials: { credentials: v.credentials, label: v.label, config: v.config }, account: v.account }
    },
    async activate(c, s, { credentials: staged, account }) {
      const i = s.intent, b = i.binding
      const digest = accountHash(account)
      let instanceId = i.target?.instanceId
      const grantIds: string[] = []
      // A reconnect can rotate a credential only for an identical verified
      // account/root/permission tuple, including every retained share.
      if (instanceId) {
        const previous = (await c.query('SELECT account_digest FROM connector_setup_identity WHERE instance_id=$1 FOR UPDATE', [instanceId])).rows[0]
        if (!previous || previous.account_digest !== digest) deny('connector_setup_account_review_required')
      }
      const blob = encryptCredentials(staged.credentials, options.encryptionKey)
      // SQL backstop checks the immutable ready setup on this same transaction.
      await c.query("SELECT set_config('app.connector_setup_id',$1,true)", [s.id])
      if (i.operation === 'create') {
        instanceId = (await c.query(`INSERT INTO connector_instance(scope,user_id,workspace_id,provider,label,credentials,credentials_type,
          config,sensitivity,connected,created_by,compartments,project_ids)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10,$11,$12) RETURNING id`,
        [i.ownership === 'personal' ? 'user' : 'workspace', i.ownership === 'personal' ? s.actorId : null,
          i.ownership === 'workspace' ? s.workspaceId : null, s.provider, staged.label, blob, staged.credentials.type,
          staged.config, b.sensitivityFloor, s.actorId, b.departments, b.projects])).rows[0].id
      } else if (i.operation === 'reconnect') {
        await c.query(`UPDATE connector_instance SET credentials=$2,credentials_type=$3,connected=true,health_status='ok',last_error=NULL WHERE id=$1`,
          [instanceId, blob, staged.credentials.type])
        // Explicit reviewed reconnect supersedes unpublished rotation material,
        // but retains the old-token fences so unknown consumption never retries.
        await c.query(`UPDATE connector_rotation_attempts SET status='reconnect_required',encrypted_result=NULL
          WHERE instance_id=$1 AND status IN ('uncertain','pending_verification')`, [instanceId])
      } else if (i.operation === 'share') {
        grantIds.push((await c.query(`INSERT INTO connector_grant(connector_instance_id,target_type,target_id,granted_by_user_id,compartments,project_ids)
          VALUES($1,'workspace',$2,$3,$4,$5) RETURNING id`, [instanceId, s.workspaceId, s.actorId, b.departments, b.projects])).rows[0].id)
      } else if (i.operation === 'transfer') {
        await c.query(`UPDATE connector_instance SET scope='workspace',user_id=NULL,workspace_id=$2,sensitivity=$3,
          compartments=$4,project_ids=$5,ingestion_enabled=false,ingest_workspace_id=NULL WHERE id=$1`,
        [instanceId, s.workspaceId, b.sensitivityFloor, b.departments, b.projects])
      }
      if (!instanceId) deny('connector_setup_result_invalid')
      await c.query(`INSERT INTO connector_setup_identity(instance_id,account_digest,setup_id) VALUES($1,$2,$3)
        ON CONFLICT(instance_id) DO UPDATE SET account_digest=excluded.account_digest,setup_id=excluded.setup_id`, [instanceId, digest, s.id])
      return { instanceId, grantIds, outboxIds: [] }
    },
  })
  return { ...service, reconnectProjection: (actorId: string, sessionId: string, workspaceId: string, instanceId: string) =>
    connectorReconnectProjection({ pool: options.pool, supportsProvider: provider => options.adapters.has(provider) }, actorId, sessionId, workspaceId, instanceId) }
}
export type TransactionalConnectorSetup = ReturnType<typeof createTransactionalConnectorSetup>
