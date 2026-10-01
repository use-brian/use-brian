import { readAdmissionPolicy } from './admission-policy-read.js'
/** Canonical creation admission. Call inside the resource writer's transaction.
 * Resolving a destination is not authorization to read a parent or publish output:
 * those resource-specific checks remain the caller's responsibility.
 */
import type { PoolClient } from 'pg'
import { intersectScopeGrants, scopeGrantContains, type ScopeGrant } from '@use-brian/core'
import type { ResourceAdmission, ResourceDestination, WorkspaceAccessMode, WorkspaceResourceEnvelope } from '@use-brian/shared'
import { currentAgentAccess } from '../db/agent-access-context.js'
import { WorkspaceAccessError } from './policy.js'
import { loadDepartmentSnapshot } from '../context-scope/department-resolver.js'
import { write as referenceWrite, type Row } from '../context-scope/reference-predicate.js'

const ranks = { public: 0, internal: 1, confidential: 2 } as const
const canonical = (values: readonly string[]) => [...new Set(values)].sort()
export type AdmissionPolicy = {
  workspaceId: string
  mode: WorkspaceAccessMode
  setupState: 'legacy' | 'ready'
  revision: string
  defaultDepartmentId: string | null
  defaultCompartment: string | null
}
export type AdmissionAuthority = {
  clearance: WorkspaceResourceEnvelope['sensitivity']
  mutationCompartments: ScopeGrant
  readCompartments?: ScopeGrant
  projectIds: ScopeGrant
}
export type AdmissionWriterKind = 'task' | 'memory' | 'episode' | 'workspace_file' | 'entity' | 'entity_link' | 'knowledge_entry'
export type AdmissionInput = {
  /** Canonical writer identity, never accepted from a transport payload. */
  writerKind?: AdmissionWriterKind
  /** Exact canonical row partition after parent/assistant visibility resolution. */
  rowVisibility?: { userId: string | null; assistantId: string | null }
  expectedPolicyRevision?: string
  visibility: WorkspaceResourceEnvelope['visibility']
  sensitivity: WorkspaceResourceEnvelope['sensitivity']
  destination?: ResourceDestination
  /** Trusted canonical parent/source envelope, never copied from a request body. */
  inherited?: WorkspaceResourceEnvelope
  /** Internal canonical derivation adapter only. Readable source floors do not
   * grant mutation authority over sources or explicit destination additions. */
  inheritedAuthority?: 'read' | 'mutation'
  /** Explicit labels, validated by the SQL adapter; never an inherited floor. */
  requestedLabels?: { compartments?: string[]; projectIds?: string[] }
}

/** Pure policy kernel shared by previews and transactional writes. */
export function resolveResourceAdmission(
  policy: AdmissionPolicy,
  authority: AdmissionAuthority,
  input: AdmissionInput,
  selectedDepartment?: { id: string; compartment: string },
): ResourceAdmission {
  if (input.expectedPolicyRevision !== undefined && input.expectedPolicyRevision !== policy.revision) throw new WorkspaceAccessError('access_policy_conflict', 409)
  // Two competing encodings of an explicit department choice are ambiguous.
  // In particular, a default destination must not mask non-default raw labels.
  if (input.destination && input.requestedLabels?.compartments !== undefined) throw new WorkspaceAccessError('access_mode_destination_conflict', 409)
  if (policy.setupState !== 'ready') throw new WorkspaceAccessError('access_mode_setup_required', 409)
  if (policy.mode === 'simple' && (!policy.defaultDepartmentId || !policy.defaultCompartment)) {
    throw new WorkspaceAccessError('access_mode_default_invalid', 409)
  }
  const parent = input.inherited
  const visibility = parent?.visibility === 'private' ? 'private' : input.visibility
  const sensitivity = parent && ranks[parent.sensitivity] > ranks[input.sensitivity] ? parent.sensitivity : input.sensitivity
  let compartments = [...(parent?.compartments ?? [])]
  let projectIds = [...(parent?.projectIds ?? [])]
  let departmentId: string | null = null
  let origin: ResourceAdmission['origin'] = parent ? 'inherited' : visibility === 'private' ? 'private' : 'explicit'

  if (input.destination?.kind === 'department') {
    if (!selectedDepartment || selectedDepartment.id !== input.destination.departmentId) throw new WorkspaceAccessError('context_not_available', 404)
    if (policy.mode === 'simple' && visibility === 'workspace' && selectedDepartment.id !== policy.defaultDepartmentId) {
      throw new WorkspaceAccessError('access_mode_destination_conflict', 409)
    }
    compartments.push(selectedDepartment.compartment)
    departmentId = selectedDepartment.id
    origin = 'explicit'
  } else if (input.destination?.kind === 'general') {
    // Old clients must not silently replace an explicit General intent with the
    // new shared default. Refresh instead; inherited floors are never removed.
    if (policy.mode === 'simple' && visibility === 'workspace') throw new WorkspaceAccessError('access_mode_destination_conflict', 409)
    origin = 'explicit'
  } else if (input.requestedLabels?.compartments !== undefined) {
    if (policy.mode === 'simple' && visibility === 'workspace'
      && (input.requestedLabels.compartments.length === 0
        || input.requestedLabels.compartments.some(key => key !== policy.defaultCompartment && !parent?.compartments.includes(key)))) {
      throw new WorkspaceAccessError('access_mode_destination_conflict', 409)
    }
  } else if (!parent && visibility === 'workspace') {
    if (policy.mode !== 'simple') throw new WorkspaceAccessError('context_selection_required', 409)
    compartments.push(policy.defaultCompartment!)
    departmentId = policy.defaultDepartmentId
    origin = 'workspace_default'
  }
  if (input.destination?.projectId) projectIds.push(input.destination.projectId)
  compartments.push(...(input.requestedLabels?.compartments ?? []))
  projectIds.push(...(input.requestedLabels?.projectIds ?? []))
  compartments = canonical(compartments)
  projectIds = canonical(projectIds)
  let mutationRequirements = compartments
  if (input.inheritedAuthority === 'read') {
    if (!parent || !scopeGrantContains(authority.readCompartments === undefined ? [] : authority.readCompartments, parent.compartments)) {
      throw new WorkspaceAccessError('context_not_available', 404)
    }
    mutationRequirements = compartments.filter(key => !parent.compartments.includes(key))
    // Choosing a destination is a write operation even if that department also
    // occurs in the readable source floor.
    if (input.destination?.kind === 'department') mutationRequirements.push(selectedDepartment!.compartment)
  }
  if (ranks[sensitivity] > ranks[authority.clearance]
    || !scopeGrantContains(authority.mutationCompartments, mutationRequirements)
    || !scopeGrantContains(authority.projectIds, projectIds)) throw new WorkspaceAccessError('context_not_available', 404)
  return { policyRevision: policy.revision, origin, departmentId, envelope: { visibility, sensitivity, compartments, projectIds } }
}

/** Trusted internal adapter: the caller has already authenticated userId. Neither
 * policy/grants nor inherited source envelopes are accepted from HTTP payloads.
 * No transaction is opened here: committing admission separately from the write
 * would permit a policy change between validation and resource publication.
 */
export async function admitWorkspaceResource(
  client: PoolClient,
  workspaceId: string,
  userId: string,
  input: AdmissionInput,
): Promise<ResourceAdmission> {
  const ambient = currentAgentAccess()
  if ((ambient?.workspaceId !== undefined && ambient.workspaceId !== workspaceId)
    || (ambient?.userId !== undefined && ambient.userId !== userId)) throw new WorkspaceAccessError('not_found', 404)
  // Same lock order as canonical reviewed commands: workspace -> member/policy.
  await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId])
  // The v2 flag (migration 649) rides on this read, through to_jsonb so an
  // older schema reads "off" instead of aborting the caller's transaction.
  const member = (await client.query<{ role: string; clearance: AdmissionAuthority['clearance']; departmentReadV2: string | null }>(
    `SELECT role,clearance,(SELECT to_jsonb(w)->>'department_read_v2' FROM workspaces w WHERE w.id=$1) AS "departmentReadV2"
       FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE OF workspace_members`, [workspaceId, userId],
  )).rows[0]
  if (!member) throw new WorkspaceAccessError('not_found', 404)
  const policy = await readAdmissionPolicy(client, workspaceId)
  if (!policy) throw new WorkspaceAccessError('access_mode_setup_required', 409)
  if (member.departmentReadV2 === 'true') {
    return admitDepartmentWrite(client, workspaceId, userId, policy, input)
  }
  const trustedRole = member.role === 'owner' || member.role === 'admin'
  const reach = (await client.query<{ compartments: string[] | null; readCompartments: string[] | null; projectIds: string[] | null }>(`SELECT
    effective_member_team_compartments($2,$1) AS compartments,
    effective_member_read_compartments($2,$1) AS "readCompartments",
    CASE WHEN $3::boolean THEN NULL ELSE ARRAY(SELECT pm.project_id::text FROM workspace_project_members pm
      JOIN workspace_projects p ON p.id=pm.project_id WHERE p.workspace_id=$1 AND pm.user_id=$2 AND p.status='active') END AS "projectIds"`,
  [workspaceId, userId, trustedRole])).rows[0]
  const clearance = trustedRole ? 'confidential' : member.clearance
  const authority: AdmissionAuthority = {
    clearance: ambient && ranks[ambient.clearance] < ranks[clearance] ? ambient.clearance : clearance,
    mutationCompartments: intersectScopeGrants(reach.compartments, ambient
      ? ambient.mutationCompartments === undefined ? ambient.compartments === undefined ? [] : ambient.compartments : ambient.mutationCompartments
      : null),
    readCompartments: intersectScopeGrants(reach.readCompartments, ambient ? ambient.compartments === undefined ? [] : ambient.compartments : null),
    projectIds: intersectScopeGrants(reach.projectIds, ambient ? ambient.projectIds === undefined ? [] : ambient.projectIds : null),
  }
  let selected: { id: string; compartment: string } | undefined
  if (input.destination?.kind === 'department') {
    selected = (await client.query<{ id: string; compartment: string }>(
      "SELECT id,compartment_key AS compartment FROM workspace_groups WHERE workspace_id=$1 AND id=$2 AND kind='team' AND status='active'",
      [workspaceId, input.destination.departmentId],
    )).rows[0]
  }
  if (input.destination?.projectId) {
    const project = await client.query("SELECT id FROM workspace_projects WHERE workspace_id=$1 AND id=$2 AND status='active'", [workspaceId, input.destination.projectId])
    if (!project.rows.length) throw new WorkspaceAccessError('context_not_available', 404)
  }
  for (const key of input.requestedLabels?.compartments ?? []) {
    if (input.inherited?.compartments.includes(key)) continue
    const found = await client.query(`SELECT g.id FROM workspace_groups g
      WHERE g.workspace_id=$1 AND g.compartment_key=$2 AND g.kind='team' AND g.status='active'`, [workspaceId, key])
    if (!found.rows.length) throw new WorkspaceAccessError('context_not_available', 404)
  }
  for (const id of input.requestedLabels?.projectIds ?? []) {
    if (input.inherited?.projectIds.includes(id)) continue
    const found = await client.query("SELECT id FROM workspace_projects WHERE workspace_id=$1 AND id=$2 AND status='active'", [workspaceId, id])
    if (!found.rows.length) throw new WorkspaceAccessError('context_not_available', 404)
  }
  const admitted = resolveResourceAdmission(policy, authority, input, selected)
  if (input.writerKind) {
    // SET LOCAL is reset at commit/rollback; the INSERT trigger consumes this
    // once and checks the actual envelope and live policy revision. Old writers
    // cannot silently insert through a ready-mode canonical table without it.
    await client.query("SELECT set_config('app.creation_admission',$1,true)", [JSON.stringify({
      protocol: 1, kind: input.writerKind, workspaceId, actor: userId,
      policyRevision: admitted.policyRevision, envelope: admitted.envelope,
      rowVisibility: input.rowVisibility ?? { userId: null, assistantId: null },
    })])
  }
  return admitted
}

const TEAM = 'team:'
/**
 * Permission model v2 admission (workspace v2 flag on): the reference WRITE.
 * The new row is stamped with ctx.department (the chosen destination, else
 * the turn's bound department) and every inherited source department, at the
 * max of the requested and inherited tiers (I12), and must be readable by the
 * acting assistant's clearances alone (the write ceiling). Access mode,
 * classification mode, Team scope mode and the readiness constants are not
 * inputs. Labels already on an inherited floor are never removed (I13).
 */
async function admitDepartmentWrite(
  client: PoolClient, workspaceId: string, userId: string, policy: AdmissionPolicy, input: AdmissionInput,
): Promise<ResourceAdmission> {
  if (input.expectedPolicyRevision !== undefined && input.expectedPolicyRevision !== policy.revision) throw new WorkspaceAccessError('access_policy_conflict', 409)
  if (input.destination && input.requestedLabels?.compartments !== undefined) throw new WorkspaceAccessError('access_mode_destination_conflict', 409)
  const grant = currentAgentAccess()?.departmentRead
  if (grant && grant.userId !== userId) throw new WorkspaceAccessError('not_found', 404)
  const query = <R>(sql: string, values: unknown[]) => client.query(sql, values) as unknown as Promise<{ rows: R[] }>
  const { snapshot, principal } = await loadDepartmentSnapshot(query, { workspaceId, userId, assistantId: grant?.assistantId ?? null })
  const destination = input.destination?.kind === 'department' ? input.destination.departmentId : null
  if (destination && !(await client.query("SELECT 1 FROM workspace_groups WHERE workspace_id=$1 AND id=$2 AND kind='team' AND status='active'", [workspaceId, destination])).rowCount) {
    throw new WorkspaceAccessError('context_not_available', 404)
  }
  const department = (key: string) => key.startsWith(TEAM) ? key.slice(TEAM.length) : null
  const parent = input.inherited
  const otherKeys = [...(parent?.compartments ?? []), ...(input.requestedLabels?.compartments ?? [])].filter(k => department(k) === null)
  const sources: Row[] = []
  const inheritedDepartments = (parent?.compartments ?? []).map(department).filter((d): d is string => d !== null)
  const requested = (input.requestedLabels?.compartments ?? []).map(department).filter((d): d is string => d !== null)
  if (parent || requested.length) {
    sources.push({ id: '__inherited__', workspaceId, tier: parent?.sensitivity ?? input.sensitivity,
      departmentIds: [...new Set([...inheritedDepartments, ...requested])], userId: null })
  }
  const result = referenceWrite(snapshot, {
    principal,
    assistant: grant?.assistantId ? { kind: 'assistant', id: grant.assistantId } : null,
    credential: grant?.cap ? { issuerUserId: userId, cap: grant.cap, binding: grant.binding, scope: 'read_write' } : null,
  }, { requestedTier: input.sensitivity, sources }, {
    workspaceId, department: destination ?? grant?.contextDepartment ?? null, now: new Date(),
  })
  if (!result.allowed) throw new WorkspaceAccessError('context_not_available', 404)
  const visibility = parent?.visibility === 'private' ? 'private' : input.visibility
  const projectIds = canonical([...(parent?.projectIds ?? []), ...(input.destination?.projectId ? [input.destination.projectId] : []),
    ...(input.requestedLabels?.projectIds ?? [])])
  const admitted: ResourceAdmission = {
    policyRevision: policy.revision,
    origin: parent ? 'inherited' : visibility === 'private' ? 'private' : 'explicit',
    departmentId: destination ?? grant?.contextDepartment ?? null,
    envelope: { visibility, sensitivity: result.row.tier,
      compartments: canonical([...result.row.departmentIds.map(d => TEAM + d), ...otherKeys]), projectIds },
  }
  if (input.writerKind) {
    await client.query("SELECT set_config('app.creation_admission',$1,true)", [JSON.stringify({
      protocol: 1, kind: input.writerKind, workspaceId, actor: userId,
      policyRevision: admitted.policyRevision, envelope: admitted.envelope,
      rowVisibility: input.rowVisibility ?? { userId: null, assistantId: null },
    })])
  }
  return admitted
}
