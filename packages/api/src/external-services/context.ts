/** Current human context for independently deployed services. [COMP:api/external-services] */
import { createHash } from 'node:crypto'
import type { DepartmentReadGrant, Sensitivity } from '@use-brian/core'
import { query } from '../db/client.js'
import { createDbOAuthAuthorizationStore, parseOAuthBearerToken } from '../db/oauth-authorization-store.js'
import { verifySecret } from '../db/api-key-store.js'
import { loadDepartmentSnapshot, resolveDepartmentReadGrant } from '../context-scope/department-resolver.js'

export interface ExternalServiceAccess {
  workspaceId: string
  userId: string
  role: string
  clearance: Sensitivity
  departmentRead: DepartmentReadGrant
  departmentNames: Record<string,string>
  projectNames: Record<string,string>
  departmentCompartments: Record<string,string>
  mutationCompartments: string[] | null
  compartments: string[] | null
  projectIds: string[] | null
  projectMode: 'shared' | 'legacy'
}
export interface ExternalServiceContext extends ExternalServiceAccess {
  version: 1
  serviceId: string
  authorizationId: string
  scope: 'read' | 'read_write'
  revision: string
}
/** Authentication/permission metadata only; no business payload on the system pool. */
export async function loadExternalServiceAccessSystem(workspaceId: string, userId: string): Promise<ExternalServiceAccess | null> {
  const member = (await query<{role:string;departmentV2:boolean;shared:boolean}>(`SELECT m.role,w.department_read_v2 AS "departmentV2",w.project_shared_spaces AS shared
    FROM workspace_members m JOIN workspaces w ON w.id=m.workspace_id JOIN users u ON u.id=m.user_id AND u.auth_provider<>'channel'
    WHERE m.workspace_id=$1 AND m.user_id=$2`,[workspaceId,userId])).rows[0]
  // Service context is defined against the canonical department model, never a role-expanded approximation.
  if (!member?.departmentV2) return null
  const input = { workspaceId,userId,assistantId:null }
  const loaded = await loadDepartmentSnapshot(query as <R>(sql:string,values:unknown[])=>Promise<{rows:R[]}>,input)
  const departmentRead = resolveDepartmentReadGrant(loaded.snapshot,loaded.principal,input,new Date())
  const departments=(await query<{id:string;compartment:string;name:string}>(`SELECT id,name,compartment_key AS compartment FROM workspace_groups
    WHERE workspace_id=$1 AND kind='team' AND status='active' AND id=ANY($2::uuid[]) ORDER BY id`,[workspaceId,Object.keys(departmentRead.departments)])).rows
  // Ensure inactive/deleted departments cannot survive in the exported map.
  departmentRead.departments=Object.fromEntries(departments.map(d=>[d.id,departmentRead.departments[d.id]]))
  const reach=(await query<{compartments:string[]|null;mutationCompartments:string[]|null;projectIds:string[]|null}>(`SELECT effective_member_read_compartments($2,$1) AS compartments,effective_member_team_compartments($2,$1) AS "mutationCompartments",
    CASE WHEN $3::boolean THEN ARRAY(SELECT jsonb_object_keys($4::jsonb))
      WHEN $5::boolean THEN NULL ELSE ARRAY(SELECT pm.project_id::text FROM workspace_project_members pm
      JOIN workspace_projects p ON p.id=pm.project_id WHERE pm.user_id=$2 AND p.workspace_id=$1 AND p.status='active') END AS "projectIds"`,
    [workspaceId,userId,member.shared,JSON.stringify(departmentRead.projects??{}),['owner','admin'].includes(member.role)])).rows[0]
  const projects=(await query<{id:string;name:string}>(`SELECT id,name FROM workspace_projects
    WHERE workspace_id=$1 AND status='active' AND ($2::text[] IS NULL OR id::text=ANY($2::text[])) ORDER BY id`,[workspaceId,reach.projectIds])).rows
  return {workspaceId,userId,departmentNames:Object.fromEntries(departments.map(d=>[d.id,d.name])),projectNames:Object.fromEntries(projects.map(p=>[p.id,p.name])),role:member.role,clearance:departmentRead.base,departmentRead,departmentCompartments:Object.fromEntries(departments.map(d=>[d.id,d.compartment])),
    compartments:reach.compartments?.sort()??null,mutationCompartments:reach.mutationCompartments?.sort()??null,projectIds:reach.projectIds?.sort()??null,projectMode:member.shared?'shared':'legacy'}
}
export async function authenticateExternalService(token: string, serviceId: string): Promise<ExternalServiceContext | null> {
  if (token.length>128 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(serviceId)) return null
  const parsed=parseOAuthBearerToken(token,'oat')
  if (!parsed || !/^[A-Za-z0-9_-]{43}$/.test(parsed.secret)) return null
  const store=createDbOAuthAuthorizationStore({audience:'service',serviceId})
  const row=await store.getByIdSystem(parsed.id)
  if (!row?.accessTokenHash || row.revokedAt || !row.accessTokenExpiresAt || row.accessTokenExpiresAt.getTime()<=Date.now()) return null
  try { if (!await verifySecret(parsed.secret,row.accessTokenHash)) return null } catch { return null }
  const access=await loadExternalServiceAccessSystem(row.workspaceId,row.userId)
  if (!access) return null
  const fresh=await store.getByIdSystem(parsed.id)
  if (!fresh || fresh.revokedAt || fresh.accessTokenHash!==row.accessTokenHash || !fresh.accessTokenExpiresAt || fresh.accessTokenExpiresAt.getTime()<=Date.now()) return null
  const context={version:1 as const,serviceId,authorizationId:row.id,scope:row.scope,...access}
  return {...context,revision:createHash('sha256').update(JSON.stringify(context)).digest('hex')}
}
