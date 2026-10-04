import type { Pool } from 'pg'
import { admitWorkspaceResource } from '../workspace-access/resource-admission.js'
import { WorkspaceAccessError } from '../workspace-access/policy.js'
import { readAdmissionPolicy } from '../workspace-access/admission-policy-read.js'
import { ConnectorSetupError } from './setup-service.js'
import { ConnectorSetupLockRetry, lockConnectorSetupWorkspaces } from './setup-locks.js'

type Tier = 'public' | 'internal' | 'confidential'
type Metadata = {
  id: string; provider: string; scope: 'user' | 'workspace'; user_id: string | null; workspace_id: string | null
  version: string; sensitivity: Tier; compartments: string[]; project_ids: string[]; context_binding_origin: string
}
const ranks = { public: 0, internal: 1, confidential: 2 }
function notFound(): never { throw new ConnectorSetupError('connector_setup_not_found') }

/** Protected metadata, not a reconnect capability. Explicit projections exclude
 * credentials, config, labels/emails, provider account/root evidence and grants
 * into other workspaces. The caller must start a fresh reviewed setup. */
export async function connectorReconnectProjection(options: { pool: Pool; supportsProvider: (provider: string) => boolean },
  actorId: string, sessionId: string, workspaceId: string, instanceId: string) {
  for (let attempt = 0; ; attempt++) {
    const c = await options.pool.connect()
    try {
      await c.query('BEGIN')
      await c.query("SELECT set_config('app.system_bypass','true',true),set_config('app.current_user_id',$1,true)", [actorId])
      await lockConnectorSetupWorkspaces(c, workspaceId, instanceId)
      const session = (await c.query<{ expires_at: Date }>(`SELECT s.expires_at FROM auth_sessions s JOIN users u ON u.id=s.user_id
        WHERE s.id=$1 AND s.user_id=$2 AND s.auth_version=u.auth_version
          AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE OF s,u`, [sessionId, actorId])).rows[0]
      if (!session) notFound()
      const member = (await c.query<{ role: string; clearance: Tier }>(`SELECT role,clearance FROM workspace_members
        WHERE workspace_id=$1 AND user_id=$2 AND role IN ('owner','admin','member') FOR SHARE`, [workspaceId, actorId])).rows[0]
      if (!member) notFound()
      const admin = member.role === 'owner' || member.role === 'admin'
      const t = (await c.query<Metadata>(`SELECT id,provider,scope,user_id,workspace_id,setup_version::text AS version,
        sensitivity,compartments,project_ids,context_binding_origin FROM connector_instance WHERE id=$1
        AND ((scope='user' AND user_id=$2) OR (scope='workspace' AND workspace_id=$3 AND $4::boolean))`,
      [instanceId, actorId, workspaceId, admin])).rows[0]
      if (!t || (!admin && ranks[t.sensitivity] > ranks[member.clearance])) notFound()
      const policy = await readAdmissionPolicy(c, workspaceId)
      if (!policy) notFound()
      let reason: 'provider_unsupported' | 'workspace_setup_required' | 'account_review_required' | 'scope_unavailable' | null = null
      if (!options.supportsProvider(t.provider)) reason = 'provider_unsupported'
      else if (policy.setupState !== 'ready') reason = 'workspace_setup_required'
      else if (!(await c.query('SELECT 1 FROM connector_setup_identity WHERE instance_id=$1', [instanceId])).rowCount) reason = 'account_review_required'
      else {
        try {
          await admitWorkspaceResource(c, workspaceId, actorId, { expectedPolicyRevision: policy.revision,
            visibility: t.scope === 'user' ? 'private' : 'workspace', sensitivity: t.sensitivity,
            requestedLabels: { compartments: t.compartments, projectIds: t.project_ids } })
        } catch (error) {
          // Only canonical authorization failures become ineligible metadata.
          if (!(error instanceof WorkspaceAccessError)) throw error
          reason = 'scope_unavailable'
        }
      }
      const clock = (await c.query<{ valid_for_ms: number }>(`SELECT greatest(0,least(30000,
        floor(extract(epoch FROM ($1::timestamptz-clock_timestamp()))*1000)))::integer AS valid_for_ms`, [session.expires_at])).rows[0]
      if (clock.valid_for_ms <= 0) notFound()
      const result = { viewerUserId: actorId, workspaceId, policyRevision: policy.revision, validForMs: clock.valid_for_ms,
        instanceId: t.id, instanceVersion: t.version, provider: t.provider,
        ownership: t.scope === 'user' ? 'personal' as const : 'workspace' as const, sensitivity: t.sensitivity,
        binding: { compartments: t.compartments, projectIds: t.project_ids, origin: t.context_binding_origin },
        eligibility: { eligible: reason === null, reason } }
      await c.query('COMMIT')
      return result
    } catch (error) {
      await c.query('ROLLBACK')
      if (error instanceof ConnectorSetupLockRetry && attempt < 3) continue
      if (error instanceof ConnectorSetupError) throw error
      throw new ConnectorSetupError('connector_setup_failed')
    } finally { c.release() }
  }
}
