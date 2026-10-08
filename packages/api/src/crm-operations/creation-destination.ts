/** Manual CRM creation uses the canonical human WRITE predicate. [COMP:crm/creation-destination] */
import { z } from 'zod'
import { query } from '../db/client.js'
import { loadDepartmentSnapshot } from '../context-scope/department-resolver.js'
import { write, clearanceIn, baseClearance, type AccessSnapshot, type Principal, type Tier } from '../context-scope/reference-predicate.js'

export const crmDestinationSchema = z.object({
  departmentId: z.string().uuid().nullable(),
  sensitivity: z.enum(['public', 'internal', 'confidential']),
}).strict()
export type CrmDestination = z.infer<typeof crmDestinationSchema>
const denied = () => Object.assign(new Error('Creation destination unavailable'), { code: 'scope_operation_denied' })

export function admitCrmDestination(snapshot: AccessSnapshot, principal: Principal, home: string | null,
  destination: CrmDestination | undefined, now = new Date()) {
  if (principal.kind !== 'user') throw denied()
  const department = destination ? destination.departmentId : home
  const clearance = department ? clearanceIn(snapshot, principal, department, now) : baseClearance(snapshot, principal)
  const sensitivity = destination?.sensitivity ?? (clearance === 'public' ? 'public' : 'internal')
  const result = write(snapshot, { principal, assistant: null }, {
    requestedTier: sensitivity, sources: [], homeDepartment: home,
    explicitGeneral: destination?.departmentId === null,
  }, { workspaceId: snapshot.workspaceId, department, now })
  if (!result.allowed) throw denied()
  return { explicitGeneral: destination?.departmentId === null, sensitivity: result.row.tier, compartments: result.row.departmentIds.map(id => `team:${id}`) }
}

async function facts(userId: string, workspaceId: string) {
  const loaded = await loadDepartmentSnapshot(<R>(sql: string, values: unknown[]) => query<R & Record<string, unknown>>(sql, values),
    { userId, workspaceId, assistantId: null })
  if (loaded.principal.kind !== 'user') throw denied()
  const home = (await query<{ home: string | null }>(
    'SELECT home_department_id AS home FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [workspaceId, userId])).rows[0]?.home ?? null
  return { ...loaded, home }
}

export async function resolveCrmDestination(userId: string, workspaceId: string, input: unknown) {
  const { snapshot, principal, home } = await facts(userId, workspaceId)
  const destination = input === undefined ? undefined : crmDestinationSchema.parse(input)
  return admitCrmDestination(snapshot, principal, home, destination)
}

export async function previewCrmDestination(userId: string, workspaceId: string) {
  const { snapshot, principal, home } = await facts(userId, workspaceId)
  const now = new Date()
  const ids = snapshot.edges.filter(edge => clearanceIn(snapshot, principal, edge.departmentId, now) !== null).map(edge => edge.departmentId)
  const rows = await query<{ id: string; name: string }>(
    "SELECT id,name FROM workspace_groups WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND status='active' ORDER BY name", [workspaceId, ids])
  const departments = rows.rows.map(row => ({ ...row, clearance: clearanceIn(snapshot, principal, row.id, now) as Tier }))
  // A missing/archived home must be repaired explicitly, never silently changed to General.
  if (home && !departments.some(row => row.id === home)) throw denied()
  const defaultScope = admitCrmDestination(snapshot, principal, home, undefined, now)
  return { departments, generalClearance: baseClearance(snapshot, principal), defaultDestination: { departmentId: home, sensitivity: defaultScope.sensitivity } }
}
