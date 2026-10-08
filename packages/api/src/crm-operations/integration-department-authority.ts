/** Durable credential ceiling plus current v2 authority. [COMP:api/crm-integration-auth] */
import { z } from 'zod'
import type { PoolClient } from 'pg'
import { CrmCredentialDepartmentSelectionSchema, CrmCredentialParentSchema, type CrmCredentialParent, CrmOperationsError, crmOperationsSha256, intersectDepartmentReadGrants, intersectScopeGrants, minSensitivity, RANK, type DepartmentReadGrant, type AuthoringAuthority, accessCeilingContains, pinAccessCeiling } from '@use-brian/core'
import { loadDepartmentSnapshot, resolveDepartmentReadGrant } from '../context-scope/department-resolver.js'
import { currentAgentAccess, runWithAgentAccess } from '../db/agent-access-context.js'
import { admitWorkspaceResource } from '../workspace-access/resource-admission.js'
import { WorkspaceAccessError } from '../workspace-access/policy.js'
import { createDbContextScopeStore } from '../db/context-scope-store.js'
import { resolveOperationCeilingsSystem } from '../db/workspace-store.js'
import { resolveLiveAccessCeilingSystem, type TurnScopeAssistant } from '../context-scope/resolve-turn-scope.js'
import type { query } from '../db/client.js'
import { resolveRetainedWorkflowSource } from '../context-scope/workflow-authority.js'

const tier = z.enum(['public', 'internal', 'confidential'])
export const CrmIntegrationDepartmentSelectionSchema = CrmCredentialDepartmentSelectionSchema
export const CrmIntegrationBindingOptionsSchema = CrmIntegrationDepartmentSelectionSchema.omit({ departmentIds: true })
const executionSchema = z.object({
  clearance: tier,
  compartments: z.array(z.string().min(1)).nullable(),
  mutationCompartments: z.array(z.string().min(1)).nullable(),
  projectIds: z.array(z.string().min(1)).nullable(),
  visibilityAssistantIds: z.array(z.string().min(1)).nullable(),
  sharedAudience: z.boolean(),
}).strict()
export type CrmIntegrationExecutionLimits = z.infer<typeof executionSchema>
export function intersectCrmIntegrationExecutionLimits(a?: CrmIntegrationExecutionLimits, b?: CrmIntegrationExecutionLimits): CrmIntegrationExecutionLimits | undefined {
  if (!a || !b) return a || b ? structuredClone(a ?? b) : undefined
  return { clearance: minSensitivity(a.clearance, b.clearance),
    compartments: intersectScopeGrants(a.compartments, b.compartments),
    mutationCompartments: intersectScopeGrants(a.mutationCompartments, b.mutationCompartments),
    projectIds: intersectScopeGrants(a.projectIds, b.projectIds),
    visibilityAssistantIds: intersectScopeGrants(a.visibilityAssistantIds, b.visibilityAssistantIds),
    sharedAudience: a.sharedAudience || b.sharedAudience }
}

let homeAppSignerFingerprint: string | null = null
/** Host configuration only; retain no signing secret. */
export function configureCrmHomeAppParentSigner(secret: string | null): void {
  homeAppSignerFingerprint = secret ? crmOperationsSha256(['crm-home-app-signer-v1', secret]) : null
}

/** Exact authenticated parent lifetime, without persisting a bearer token or verifier. */
export async function assertCrmCredentialParent(client: PoolClient, raw: CrmCredentialParent, workspaceId: string, userId: string, authoring?: AuthoringAuthority): Promise<void> {
  const parent = CrmCredentialParentSchema.safeParse(raw)
  if (!parent.success || parent.data.workspaceId !== workspaceId || parent.data.userId !== userId) throw unavailable()
  const expected = parent.data
  if (expected.kind === 'workflow') {
    const source = expected.source
    if (source.runId !== expected.credentialId || source.workspaceId !== workspaceId || source.authorityUserId !== userId
      || (authoring && source.executingAssistantId !== authoring.assistantId)) throw unavailable()
    const previous = (await client.query("SELECT current_setting('app.current_user_id',true) AS actor")).rows[0]?.actor ?? ''
    await client.query('SAVEPOINT crm_workflow_parent')
    try {
      await client.query("SELECT set_config('app.current_user_id',$1,true)", [userId])
      const resolved = await resolveRetainedWorkflowSource(source, client)
      if (authoring && !accessCeilingContains(pinAccessCeiling(resolved.turnScope.access), authoring.ceiling)) throw unavailable()
      await client.query("SELECT set_config('app.current_user_id',$1,true)", [previous])
      await client.query('RELEASE SAVEPOINT crm_workflow_parent')
    } catch {
      await client.query('ROLLBACK TO SAVEPOINT crm_workflow_parent')
      await client.query('RELEASE SAVEPOINT crm_workflow_parent')
      throw unavailable()
    }
    return
  }
  if (expected.kind === 'home_app') {
    if (!homeAppSignerFingerprint || expected.signerFingerprint !== homeAppSignerFingerprint) throw unavailable()
    const result = await client.query('SELECT public.crm_home_app_parent_current($1::jsonb) AS allowed', [JSON.stringify(expected)])
    if (result.rows[0]?.allowed !== true) throw unavailable()
    return
  }
  if (expected.kind === 'brain_key') {
    const result = await client.query('SELECT public.crm_brain_parent_current($1::jsonb) AS allowed', [JSON.stringify(expected)])
    if (result.rows[0]?.allowed !== true) throw unavailable()
    return
  }
  const row = (await client.query('SELECT public.crm_oauth_parent_current($1,$2,$3,$4,$5,$6) AS allowed',
    [expected.credentialId, workspaceId, userId, expected.clientId, expected.expiresAt, expected.tokenFingerprint])).rows[0]
  if (row?.allowed !== true) throw unavailable()
}

const bindingSchema = z.object({
  version: z.literal(1), workspaceId: z.string().uuid(), userId: z.string().uuid(),
  assistantId: z.string().uuid().nullable(), base: tier,
  departments: z.record(z.string().uuid(), tier), contextDepartment: z.string().uuid().nullable(),
  binding: z.array(z.string().uuid()).max(100), cap: tier,
  execution: executionSchema.optional(),
  parent: CrmCredentialParentSchema.optional(),
}).strict()
export type CrmIntegrationDepartmentBinding = z.infer<typeof bindingSchema>
const unavailable = () => new CrmOperationsError('not_authorized', 'The integration authority is unavailable. Review the issuer and department access, then rotate the credential if its binding is missing.')

async function currentExecutionLimits(client: Pick<PoolClient, 'query'>, workspaceId: string, userId: string, assistantId: string | null) {
  if (!assistantId) return undefined
  const assistant = (await client.query<TurnScopeAssistant>(`SELECT id,workspace_id AS "workspaceId",kind,clearance,compartments,
    default_compartments AS "defaultCompartments",team_scope_mode AS "teamScopeMode",
    default_workspace_group_id AS "defaultWorkspaceGroupId",project_scope_mode AS "projectScopeMode",
    default_project_id AS "defaultProjectId" FROM assistants WHERE id=$1 AND workspace_id=$2`, [assistantId, workspaceId])).rows[0]
  if (!assistant) throw unavailable()
  const execute: typeof query = (sql, values) => client.query(sql, values)
  try {
    const current = await resolveLiveAccessCeilingSystem({ userId, workspaceId, assistant,
      key: { contextGroupId: null, contextProjectId: null } }, {
      // This store uses only the transaction's query method for authority reads.
      store: createDbContextScopeStore(client as PoolClient),
      resolveReadCeilings: (actor, workspace, clearance, compartments) =>
        resolveOperationCeilingsSystem(actor, workspace, clearance, compartments, true, execute),
      resolveWorkspaceRole: async (actor, workspace) =>
        (await client.query('SELECT role FROM workspace_members WHERE user_id=$1 AND workspace_id=$2', [actor, workspace])).rows[0]?.role ?? null,
      departmentRead: { query: <R>(sql: string, values: unknown[]) => client.query(sql, values) as unknown as Promise<{ rows: R[] }> },
    })
    return executionSchema.parse({ clearance: current.clearance, compartments: current.compartments,
      mutationCompartments: current.mutationCompartments, projectIds: current.projectIds,
      visibilityAssistantIds: current.visibilityAssistantIds, sharedAudience: false })
  } catch { throw unavailable() }
}

async function currentGrant(client: Pick<PoolClient, 'query'>, grant: DepartmentReadGrant): Promise<DepartmentReadGrant> {
  const input = { workspaceId: grant.workspaceId, userId: grant.userId, assistantId: grant.assistantId,
    contextDepartment: grant.contextDepartment, credential: { binding: grant.binding, cap: grant.cap } }
  try {
    const { snapshot, principal } = await loadDepartmentSnapshot(
      <R>(sql: string, values: unknown[]) => client.query(sql, values) as unknown as Promise<{ rows: R[] }>, input)
    if (principal.kind !== 'user') throw unavailable()
    return resolveDepartmentReadGrant(snapshot, principal, input, new Date())
  } catch (error) {
    if (error instanceof Error && error.message === 'authority_unavailable') throw unavailable()
    throw error
  }
}

/** Call under the workspace admission lock, before inserting the new key. */
export async function admitCrmIntegrationBinding(
  client: PoolClient, workspaceId: string, userId: string,
  raw: z.input<typeof CrmIntegrationDepartmentSelectionSchema> = {}, parent?: CrmCredentialParent,
): Promise<CrmIntegrationDepartmentBinding> {
  if (parent) await assertCrmCredentialParent(client, parent, workspaceId, userId)
  const selection = CrmIntegrationDepartmentSelectionSchema.parse(raw)
  const empty: DepartmentReadGrant = { workspaceId, userId, assistantId: selection.assistantId ?? null,
    base: 'public', departments: {}, contextDepartment: null, binding: null, cap: selection.cap }
  let grant = await currentGrant(client, empty)
  const access = currentAgentAccess()
  if (access && (access.workspaceId !== workspaceId || access.userId !== userId)) throw unavailable()
  const execution = access ? executionSchema.safeParse({ clearance: access.clearance, compartments: access.compartments,
    mutationCompartments: access.mutationCompartments, projectIds: access.projectIds,
    visibilityAssistantIds: access.visibilityAssistantIds, sharedAudience: access.sharedAudience === true }) : null
  if (execution && !execution.success) throw unavailable()
  const ambient = access?.departmentRead
  if (ambient) grant = intersectDepartmentReadGrants(grant, ambient)
  const admitted = await runWithAgentAccess({ workspaceId, userId, clearance: 'confidential', compartments: null,
    departmentRead: grant }, () => admitWorkspaceResource(client, workspaceId, userId, {
    visibility: 'workspace', sensitivity: selection.cap,
    ...(selection.departmentIds?.length === 0 ? { destination: { kind: 'general' as const } }
      : selection.departmentIds ? { requestedLabels: { compartments: selection.departmentIds.map(id => `team:${id}`) } } : {}),
  }))
  const binding = [...new Set(admitted.envelope.compartments.map(key => {
    if (!key.startsWith('team:')) throw unavailable()
    return key.slice(5)
  }))].sort()
  for (const id of binding) {
    if (!grant.departments[id] || RANK[grant.departments[id]] < RANK[selection.cap]
      || (grant.binding !== null && !grant.binding.includes(id))) throw unavailable()
  }
  if (binding.length === 0 && RANK[grant.base] < RANK[selection.cap]) throw unavailable()
  const limits = intersectCrmIntegrationExecutionLimits(execution?.success ? execution.data : undefined,
    await currentExecutionLimits(client, workspaceId, userId, grant.assistantId))
  return bindingSchema.parse({ ...grant, version: 1, binding, cap: selection.cap, ...(parent ? { parent } : {}),
    ...(limits ? { execution: limits } : {}) })
}

/** Read only after successful binding renewal; malformed persisted limits deny. */
export async function crmIntegrationExecutionLimits(client: Pick<PoolClient, 'query'>, raw: unknown): Promise<CrmIntegrationExecutionLimits | undefined> {
  const parsed = bindingSchema.safeParse(raw)
  if (!parsed.success) throw unavailable()
  return intersectCrmIntegrationExecutionLimits(parsed.data.execution,
    await currentExecutionLimits(client, parsed.data.workspaceId, parsed.data.userId, parsed.data.assistantId))
}

/** NULL historical evidence is deliberately not reconstructed from current edges. */
export async function renewCrmIntegrationBinding(
  client: PoolClient, workspaceId: string, issuerUserId: string | null, raw: unknown,
): Promise<DepartmentReadGrant> {
  const parsed = bindingSchema.safeParse(raw)
  if (!parsed.success || parsed.data.workspaceId !== workspaceId || parsed.data.userId !== issuerUserId) throw unavailable()
  if (parsed.data.parent) await assertCrmCredentialParent(client, parsed.data.parent, workspaceId, issuerUserId!)
  const current = await currentGrant(client, parsed.data)
  const grant = intersectDepartmentReadGrants(parsed.data, current)
  const ambient = currentAgentAccess()?.departmentRead
  return ambient ? intersectDepartmentReadGrants(grant, ambient) : grant
}

/** Advisory only: every offered destination passes canonical issuance admission. */
export async function previewCrmIntegrationBindings(
  client: PoolClient, workspaceId: string, userId: string,
  raw: z.input<typeof CrmIntegrationBindingOptionsSchema> = {},
) {
  const selection = CrmIntegrationBindingOptionsSchema.parse(raw)
  const v2 = (await client.query('SELECT department_read_v2 AS v2 FROM workspaces WHERE id=$1', [workspaceId])).rows[0]?.v2
  if (!v2) return { mode: 'legacy' as const, choices: [], assistants: [], validForMs: 30_000 }
  const assistants = (await client.query<{ id: string; name: string }>(
    'SELECT id,name FROM assistants WHERE workspace_id=$1 AND public.assistant_placement_visible($2,id) ORDER BY name,id',
    [workspaceId, userId])).rows
  if (selection.assistantId && !assistants.some(row => row.id === selection.assistantId)) throw unavailable()
  let grant = await currentGrant(client, { workspaceId, userId, assistantId: selection.assistantId ?? null,
    base: 'public', departments: {}, contextDepartment: null, binding: null, cap: selection.cap })
  const ambient = currentAgentAccess()?.departmentRead
  if (ambient) grant = intersectDepartmentReadGrants(grant, ambient)
  const departments = (await client.query<{ id: string; name: string }>(
    "SELECT id,name FROM workspace_groups WHERE workspace_id=$1 AND kind='team' AND status='active' AND id=ANY($2::uuid[]) ORDER BY name,id",
    [workspaceId, Object.keys(grant.departments)])).rows
  const candidates = [selection, { ...selection, departmentIds: [] },
    ...departments.map(row => ({ ...selection, departmentIds: [row.id] }))]
  const choices = []
  for (const candidate of candidates) {
    try {
      const admitted = await admitCrmIntegrationBinding(client, workspaceId, userId, candidate)
      choices.push({ selection: candidate, binding: admitted.binding,
        departments: departments.filter(row => admitted.binding.includes(row.id)) })
    } catch (error) {
      if (!(error instanceof WorkspaceAccessError) && !(error instanceof CrmOperationsError && error.code === 'not_authorized')) throw error
    }
  }
  return { mode: 'department-v2' as const, choices, assistants, validForMs: 30_000 }
}

export { CrmCredentialParentSchema, type CrmCredentialParent } from '@use-brian/core'
