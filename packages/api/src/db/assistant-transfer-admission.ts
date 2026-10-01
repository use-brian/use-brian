import { getPool } from './client.js'
import { currentAgentAccess } from './agent-access-context.js'
import { WorkspaceAccessError } from '../workspace-access/policy.js'

export type AssistantTransferPreview = {
  destinationWorkspaceId: string
  policyRevision: string
  mode: string
  setupState: string
  defaultDepartmentId: string | null
  departments: { id: string; name: string }[]
  canTransfer: false
  reason: 'assistant_transfer_certification_required'
}

export async function previewAssistantTransfer(userId: string, workspaceId: string, assistantId: string, operation: 'adopt' | 'remove') {
  return runTransfer(userId, workspaceId, assistantId, operation, undefined, undefined, true)
}

/** Temporarily closed until every dependency writer shares a certified barrier.
 * A preview or revision is selection evidence, not permission to move content. */
export async function transferAssistant(userId: string, workspaceId: string, assistantId: string,
  operation: 'adopt' | 'remove', departmentId?: string, expectedPolicyRevision?: string): Promise<boolean> {
  const result = await runTransfer(userId, workspaceId, assistantId, operation, departmentId, expectedPolicyRevision)
  return result === true
}

async function runTransfer(
  userId: string, workspaceId: string, assistantId: string,
  operation: 'adopt' | 'remove', departmentId?: string, expectedPolicyRevision?: string, preview = false,
): Promise<boolean | AssistantTransferPreview> {
  // Principal policy changes are human operations; finite agent execution is not
  // permission to replace its own principal or cross workspace boundary.
  if (currentAgentAccess()) throw new WorkspaceAccessError('assistant_transfer_review_required', 409)
  const client = await getPool().connect()
  const deny = async () => { await client.query('ROLLBACK'); return false }
  try {
    await client.query('BEGIN')
    await client.query("SELECT set_config('app.current_user_id',$1,true)", [userId])
    const discovered = (await client.query<{ source: string; destination: string }>(`
      SELECT a.workspace_id AS source, CASE WHEN $4='adopt' THEN $2::uuid ELSE
        (SELECT pw.id FROM workspaces w JOIN workspaces pw ON pw.owner_user_id=w.owner_user_id AND pw.is_personal
          WHERE w.id=$2) END AS destination FROM assistants a WHERE a.id=$3 AND $1::uuid IS NOT NULL`,
    [userId, workspaceId, assistantId, operation])).rows[0]
    if (!discovered?.source || !discovered.destination || discovered.source === discovered.destination) return await deny()
    // Discovery is not authority. Lock the entire sorted workspace set before
    // assistant, memberships or resources, then revalidate everything.
    const workspaces = (await client.query<{ id: string; owner_user_id: string; is_personal: boolean }>(
      'SELECT id,owner_user_id,is_personal FROM workspaces WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
      [[discovered.source, discovered.destination]],
    )).rows
    if (workspaces.length !== 2) return await deny()
    const source = workspaces.find(w => w.id === discovered.source)!
    const destination = workspaces.find(w => w.id === discovered.destination)!
    const assistant = (await client.query<{ workspace_id: string; owner_user_id: string | null; kind: string }>(
      'SELECT workspace_id,owner_user_id,kind FROM assistants WHERE id=$1 FOR UPDATE', [assistantId],
    )).rows[0]
    if (!assistant || assistant.workspace_id !== source.id || assistant.kind !== 'standard') return await deny()
    const roles = (await client.query<{ workspace_id: string; role: string }>(
      'SELECT workspace_id,role FROM workspace_members WHERE user_id=$1 AND workspace_id=ANY($2::uuid[])',
      [userId, [source.id, destination.id]],
    )).rows
    const admin = (id: string) => roles.some(r => r.workspace_id === id && ['owner', 'admin'].includes(r.role))
    if (!admin(destination.id)) return await deny()
    if (operation === 'adopt') {
      const owner = (await client.query("SELECT 1 FROM assistant_members WHERE assistant_id=$1 AND user_id=$2 AND role='owner'", [assistantId, userId])).rowCount
      if (!owner || !source.is_personal || source.owner_user_id !== userId || assistant.owner_user_id !== userId) return await deny()
    } else if (source.id !== workspaceId || !admin(source.id) || assistant.owner_user_id !== null
      || !destination.is_personal || destination.owner_user_id !== source.owner_user_id) return await deny()
    const policies = (await client.query<{ workspace_id: string; access_mode: string; setup_state: string; default_department_id: string | null; revision: string }>(
      'SELECT workspace_id,access_mode,setup_state,default_department_id,revision::text FROM workspace_access_policies WHERE workspace_id=ANY($1::uuid[])',
      [[source.id, destination.id]],
    )).rows
    const policy = policies.find(p => p.workspace_id === destination.id)
    if (preview) {
      const departments = (await client.query<{ id: string; name: string }>(
        "SELECT id,name FROM workspace_groups WHERE workspace_id=$1 AND kind='team' AND status='active' ORDER BY id", [destination.id],
      )).rows
      await client.query('COMMIT')
      return { destinationWorkspaceId: destination.id, policyRevision: policy?.revision ?? '1',
        mode: policy?.access_mode ?? 'departments', setupState: policy?.setup_state ?? 'legacy',
        defaultDepartmentId: policy?.default_department_id ?? null, departments,
        canTransfer: false, reason: 'assistant_transfer_certification_required' }
    }
    if (expectedPolicyRevision !== undefined && expectedPolicyRevision !== (policy?.revision ?? '1')) {
      throw new WorkspaceAccessError('access_policy_conflict', 409)
    }
    const ready = policy?.setup_state === 'ready'
    if (!ready && (departmentId || policies.some(p => p.setup_state === 'ready'))) throw new WorkspaceAccessError('access_mode_setup_required', 409)
    let selected: string | null = null
    if (ready) {
      selected = departmentId ?? policy.default_department_id
      if (!selected) throw new WorkspaceAccessError('context_selection_required', 409)
      if (policy.access_mode === 'simple' && selected !== policy.default_department_id) throw new WorkspaceAccessError('access_mode_destination_conflict', 409)
      if (!(await client.query("SELECT id FROM workspace_groups WHERE workspace_id=$1 AND id=$2 AND kind='team' AND status='active'", [destination.id, selected])).rowCount) throw new WorkspaceAccessError('context_not_available', 404)
    }
    await client.query('SELECT assert_assistant_transfer_unbound($1)', [assistantId])
    // Scanning even twice cannot see an uncommitted non-FK writer. No body
    // provenance, receipt, feature flag or legacy destination may reopen this.
    throw new WorkspaceAccessError('assistant_transfer_certification_required', 409)
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    if (error instanceof Error && error.message === 'assistant_transfer_review_required') throw new WorkspaceAccessError(error.message, 409)
    if ((error as { code?: string }).code === '55P03') throw new WorkspaceAccessError('access_policy_conflict', 409)
    throw error
  } finally { client.release() }
}
