/** App authentication enters the existing immutable context and sticky lease. [COMP:api/application-auth] */
import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { createExecutionContext, intersectAccessCeilings, maxSensitivity, minSensitivity,
  type AccessCeiling, type ExecutionContext, type Sensitivity } from '@use-brian/core'
import { ApplicationPlatformError } from '@use-brian/shared'
import { query } from '../db/client.js'
import { findAssistantById } from '../db/users.js'
import { createAuthorityLease } from '../context-scope/authority-lease.js'
import { resolveLiveAccessCeilingSystem } from '../context-scope/resolve-turn-scope.js'
import { loadApplicationAuthority, type ApplicationAuthentication, type ApplicationAuthorityState } from './grant-authority.js'

const bindings = new WeakMap<ExecutionContext, { authentication: ApplicationAuthentication; state: ApplicationAuthorityState }>()
const intersect = (left: string[], right: string[]) => left.filter(value => right.includes(value))
function freezeFacts(value: unknown): void {
  if (!value || typeof value !== 'object') return
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return
  for (const nested of Object.values(value)) freezeFacts(nested)
  Object.freeze(value)
}
function releaseCeiling(state: ApplicationAuthorityState): AccessCeiling {
  const now = Date.now()
  let compartments: string[] | undefined, projects: string[] | undefined, clearance: Sensitivity = 'confidential'
  for (const alternatives of state.layers) {
    const paths = alternatives.flatMap(path => {
      const grants = [...path.current, ...path.maximum.grants]
      if (grants.some(grant => grant.status !== 'active' || Date.parse(grant.startsAt) > now
        || grant.expiresAt !== null && Date.parse(grant.expiresAt) <= now)) return []
      return [{ clearance: minSensitivity(...grants.map(grant => grant.clearance)),
        compartments: grants.reduce((keys, grant) => intersect(keys, grant.compartments), grants[0].compartments),
        projects: grants.reduce((keys, grant) => intersect(keys, grant.projectIds), grants[0].projectIds) }]
    })
    if (!paths.length) throw new ApplicationPlatformError('grant_revoked', 'Application access is unavailable.')
    const labels = [...new Set(paths.flatMap(path => path.compartments))]
    const ids = [...new Set(paths.flatMap(path => path.projects))]
    compartments = compartments ? intersect(compartments, labels) : labels
    projects = projects ? intersect(projects, ids) : ids
    clearance = minSensitivity(clearance, maxSensitivity(...paths.map(path => path.clearance)))
  }
  return { workspaceId: state.workspaceId, userId: state.principal.userId, clearance,
    compartments: compartments ?? [], mutationCompartments: compartments ?? [], projectIds: projects ?? [], visibilityAssistantIds: [state.assistantId] }
}

/** Content-free live metadata. Timed edges disappearing also invalidate the lease. */
async function metadataSnapshot(state: ApplicationAuthorityState) {
  const result = await query<{ snapshot: unknown }>(`SELECT jsonb_build_object(
    'workspace',jsonb_build_array(w.department_read_v2,w.project_shared_spaces),
    'policy',(SELECT revision::text FROM workspace_access_policies WHERE workspace_id=w.id),
    'members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.user_id) FROM workspace_members m WHERE m.workspace_id=w.id),
    'departments',(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.id) FROM department_edges d WHERE d.workspace_id=w.id AND (d.expires_at IS NULL OR d.expires_at>statement_timestamp())),
    'projects',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM project_shared_members p WHERE p.workspace_id=w.id AND (p.expires_at IS NULL OR p.expires_at>statement_timestamp())),
    'module',(SELECT to_jsonb(m) FROM workspace_modules m WHERE m.workspace_id=w.id AND m.module_key=$2)
    ) AS snapshot FROM workspaces w WHERE w.id=$1`, [state.workspaceId, state.moduleKey])
  if (!result.rows[0]) throw new ApplicationPlatformError('grant_revoked', 'Application access is unavailable.')
  return result.rows[0].snapshot
}

export async function resolveApplicationExecutionContext(authentication: ApplicationAuthentication,
  options: { abortSignal?: AbortSignal; sessionId?: string; channelType?: string } = {}): Promise<ExecutionContext> {
  // Keep the authenticated objects themselves: cloning their public metadata must lose proof.
  const auth = Object.freeze({ credential: authentication.credential, user: authentication.user, home: authentication.home })
  async function resolve() {
    const state = await loadApplicationAuthority(auth)
    const assistant = await findAssistantById(state.assistantId)
    if (!assistant || assistant.workspaceId !== state.workspaceId) throw new ApplicationPlatformError('grant_revoked', 'Application access is unavailable.')
    let ceiling = releaseCeiling(state)
    ceiling = { ...ceiling, clearance: minSensitivity(ceiling.clearance, assistant.clearance, state.clearanceCap ?? 'confidential') }
    if (state.principal.kind === 'member') {
      ceiling = intersectAccessCeilings(ceiling, await resolveLiveAccessCeilingSystem({ userId: state.principal.userId, workspaceId: state.workspaceId, assistant, memberMode: 'member' }))
    }
    const signature = createHash('sha256').update(JSON.stringify({ fingerprint: state.fingerprint, ceiling, assistant,
      metadata: await metadataSnapshot(state) })).digest('hex')
    return { state, assistant, ceiling, signature }
  }
  const initial = await resolve()
  const authority = createAuthorityLease(initial.ceiling, async () => {
    const current = await resolve()
    return current.signature === initial.signature ? current.ceiling : null
  })
  const execution = createExecutionContext({ identity: { kind: 'programmatic', credentialOwnerUserId: initial.state.issuerUserId,
    principal: { kind: 'application', credentialId: initial.state.credentialId, applicationId: initial.state.appId,
      actorUserId: initial.state.principal.userId, subjectKind: initial.state.principal.kind, serviceUserId: initial.state.serviceUserId } },
  ownership: { kind: 'workspace', workspaceId: initial.state.workspaceId },
  access: { ...initial.ceiling, assistantId: initial.assistant.id, assistantKind: initial.assistant.kind },
  writeDefaults: { compartments: [], projectIds: [] }, authority,
  lifecycle: { abortSignal: options.abortSignal ?? new AbortController().signal, sessionId: options.sessionId ?? randomUUID(),
    channelType: options.channelType ?? 'application', channelId: initial.state.appId, sessionPersisted: false },
  surface: initial.state.readOnly ? { readOnly: true } : {}, attribution: { credentialOwnerUserId: initial.state.issuerUserId } })
  for (const facts of [execution.identity, execution.ownership, execution.security.access, execution.security.ceiling,
    execution.security.writeDefaults, execution.security.provenance, execution.surface, execution.attribution]) freezeFacts(facts)
  Object.freeze(execution.security.authority)
  bindings.set(execution, { authentication: auth, state: initial.state })
  return execution
}

/** No public descriptor or model args can attach a verified binding to a context. */
export function getApplicationExecutionBinding(execution: ExecutionContext) {
  const binding = bindings.get(execution)
  return binding ? { state: structuredClone(binding.state) } : undefined
}

export async function applyApplicationRLSContext(client: PoolClient, execution: ExecutionContext): Promise<boolean> {
  const binding = bindings.get(execution)
  if (!binding) return false
  await execution.security.authority.assertCurrent()
  await client.query(`SELECT set_config('app.application_id',$1,true),set_config('app.application_credential_id',$2,true),
    set_config('app.application_oauth_id',$3,true),set_config('app.application_assistant_id',$4,true),
    set_config('app.v2_assistant_id',$4,true),set_config('app.v2_cap',$5,true),set_config('app.application_home_binding_id',$6,true)`,
  [binding.state.appId, binding.authentication.credential?.credentialId ?? '', binding.authentication.user?.authorizationId ?? '',
    execution.assistant.id, execution.security.access.clearance, binding.authentication.home?.bindingId ?? ''])
  const result = await client.query<{ admitted: boolean }>('SELECT application_lock_workspace($1) AS admitted', [binding.state.workspaceId])
  if (result.rows[0]?.admitted !== true) throw new ApplicationPlatformError('grant_revoked', 'Application access is unavailable.')
  return true
}
