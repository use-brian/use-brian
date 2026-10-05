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
  /** True only when both workspaces are still legacy (pre-mode behaviour). */
  canTransfer: boolean
  reason: 'assistant_transfer_certification_required' | null
}

export async function previewAssistantTransfer(userId: string, workspaceId: string, assistantId: string, operation: 'adopt' | 'remove') {
  return runTransfer(userId, workspaceId, assistantId, operation, undefined, undefined, true)
}

/** Closed for any workspace past legacy until every dependency writer shares a
 * certified barrier. A move between two legacy workspaces keeps its pre-mode
 * behaviour unchanged (permission-model-v2 §12.3 item 4). A preview or revision
 * is selection evidence, not permission to move content. */
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
        (SELECT u.default_workspace_id FROM users u JOIN workspaces w ON w.owner_user_id=u.id WHERE w.id=$2) END AS destination FROM assistants a WHERE a.id=$3 AND $1::uuid IS NOT NULL`,
    [userId, workspaceId, assistantId, operation])).rows[0]
    if (!discovered?.source || !discovered.destination || discovered.source === discovered.destination) return await deny()
    // Discovery is not authority. Lock the entire sorted workspace set before
    // assistant, memberships or resources, then revalidate everything.
    const workspaces = (await client.query<{ id: string; owner_user_id: string }>(
      'SELECT id,owner_user_id FROM workspaces WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
      [[discovered.source, discovered.destination]],
    )).rows
    if (workspaces.length !== 2) return await deny()
    const source = workspaces.find(w => w.id === discovered.source)!
    const destination = workspaces.find(w => w.id === discovered.destination)!
    const assistant = (await client.query<{ workspace_id: string; owner_user_id: string | null; kind: string }>(
      'SELECT workspace_id,owner_user_id,kind FROM assistants WHERE id=$1 FOR UPDATE', [assistantId],
    )).rows[0]
    if (!assistant || assistant.workspace_id !== source.id) return await deny()
    const roles = (await client.query<{ workspace_id: string; role: string }>(
      'SELECT workspace_id,role FROM workspace_members WHERE user_id=$1 AND workspace_id=ANY($2::uuid[])',
      [userId, [source.id, destination.id]],
    )).rows
    const admin = (id: string) => roles.some(r => r.workspace_id === id && ['owner', 'admin'].includes(r.role))
    if (!admin(destination.id)) return await deny()
    if (operation === 'adopt') {
      const owner = (await client.query("SELECT 1 FROM assistant_members WHERE assistant_id=$1 AND user_id=$2 AND role='owner'", [assistantId, userId])).rowCount
      if (!owner || source.owner_user_id !== userId || assistant.owner_user_id !== userId) return await deny()
    } else if (source.id !== workspaceId || !admin(source.id) || assistant.owner_user_id !== null
      || destination.owner_user_id !== source.owner_user_id) return await deny()
    const policies = (await client.query<{ workspace_id: string; access_mode: string; setup_state: string; default_department_id: string | null; revision: string }>(
      'SELECT workspace_id,access_mode,setup_state,default_department_id,revision::text FROM workspace_access_policies WHERE workspace_id=ANY($1::uuid[])',
      [[source.id, destination.id]],
    )).rows
    const policy = policies.find(p => p.workspace_id === destination.id)
    // A workspace with no policy row is legacy by construction.
    const legacy = policies.every(p => p.setup_state === 'legacy')
    if (preview) {
      const departments = (await client.query<{ id: string; name: string }>(
        "SELECT id,name FROM workspace_groups WHERE workspace_id=$1 AND kind='team' AND status='active' ORDER BY id", [destination.id],
      )).rows
      await client.query('COMMIT')
      return { destinationWorkspaceId: destination.id, policyRevision: policy?.revision ?? '1',
        mode: policy?.access_mode ?? 'departments', setupState: policy?.setup_state ?? 'legacy',
        defaultDepartmentId: policy?.default_department_id ?? null, departments,
        canTransfer: legacy, reason: legacy ? null : 'assistant_transfer_certification_required' }
    }
    if (expectedPolicyRevision !== undefined && expectedPolicyRevision !== (policy?.revision ?? '1')) {
      throw new WorkspaceAccessError('access_policy_conflict', 409)
    }
    const ready = policy?.setup_state === 'ready'
    if (!ready && (departmentId || policies.some(p => p.setup_state === 'ready'))) throw new WorkspaceAccessError('access_mode_setup_required', 409)
    if (legacy) {
      // Pre-mode transfer, unchanged: the same rows move as before the branch.
      // The receipt is what the 641 trigger accepts for a legacy-to-legacy move.
      await client.query("SELECT set_config('app.assistant_transfer',$1,true)",
        [JSON.stringify({ assistantId, source: source.id, destination: destination.id, userId, legacy: true })])
      await client.query('UPDATE assistants SET workspace_id=$1,owner_user_id=$2 WHERE id=$3',
        [destination.id, operation === 'adopt' ? null : destination.owner_user_id, assistantId])
      await client.query('DELETE FROM assistant_members WHERE assistant_id=$1', [assistantId])
      if (operation === 'remove') {
        await client.query("INSERT INTO assistant_members(assistant_id,user_id,role) VALUES($1,$2,'owner') ON CONFLICT (assistant_id,user_id) DO UPDATE SET role='owner'",
          [assistantId, destination.owner_user_id])
      }
      await client.query('COMMIT')
      return true
    }
    if (assistant.kind !== 'standard') return await deny()
    let selected: string | null = null
    if (ready) {
      selected = departmentId ?? policy.default_department_id
      if (!selected) throw new WorkspaceAccessError('context_selection_required', 409)
      if (policy.access_mode === 'simple' && selected !== policy.default_department_id) throw new WorkspaceAccessError('access_mode_destination_conflict', 409)
      if (!(await client.query("SELECT id FROM workspace_groups WHERE workspace_id=$1 AND id=$2 AND kind='team' AND status='active'", [destination.id, selected])).rowCount) throw new WorkspaceAccessError('context_not_available', 404)
    }
    await client.query('SELECT assert_assistant_transfer_unbound($1)', [assistantId])
    // Scanning even twice cannot see an uncommitted non-FK writer. No body
    // provenance, receipt or feature flag may reopen this past legacy.
    throw new WorkspaceAccessError('assistant_transfer_certification_required', 409)
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    if (error instanceof Error && error.message === 'assistant_transfer_review_required') throw new WorkspaceAccessError(error.message, 409)
    if ((error as { code?: string }).code === '55P03') throw new WorkspaceAccessError('access_policy_conflict', 409)
    throw error
  } finally { client.release() }
}
