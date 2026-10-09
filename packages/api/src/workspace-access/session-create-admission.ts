/** Ordinary shared web/chat admission only, backed by migration 633.
 * Generic shared writers lack human provenance and fail closed in
 * ready mode; personal, channel/public and resumed sessions gain no defaults. */
import { classifySession } from '../session-kind.js'
import type { PoolClient } from 'pg'
import { scopeGrantContains } from '@use-brian/core'
import type { query } from '../db/client.js'
import { createDbContextScopeStore } from '../db/context-scope-store.js'
import { resolveOperationCeilingsSystem } from '../db/workspace-store.js'
import { resolveTurnScopeSystem, type TurnScopeAssistant } from '../context-scope/resolve-turn-scope.js'
import { readAdmissionPolicy } from './admission-policy-read.js'
import { admitWorkspaceResource } from './resource-admission.js'
import { WorkspaceAccessError } from './policy.js'

type Input = {
  assistantId: string; userId: string; channelType: string; channelId: string
  appId?: string; appOrigin?: string | null; workspaceId?: string | null
  effectiveClearance?: string | null; contextGroupId?: string | null
  contextProjectId?: string | null; contextCompartments?: string[]
  expectedPolicyRevision?: string
}
export async function admitSessionCreate<T extends Input>(client: PoolClient, params: T, human: boolean): Promise<T> {
  const pointer = (await client.query('SELECT workspace_id FROM assistants WHERE id=$1', [params.assistantId])).rows[0]
  const assistantWorkspaceId: string | null = pointer?.workspace_id ?? null
  // Match INSERT's COALESCE: an explicit output workspace cannot borrow the
  // compatibility policy of a foreign (or workspace-less) assistant.
  const workspaceId: string | null = params.workspaceId ?? assistantWorkspaceId
  for (const id of [...new Set([workspaceId, assistantWorkspaceId].filter((id): id is string => !!id))].sort()) {
    await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [id])
  }
  // Freeze even workspace-less assistants against transfer after inspection.
  // The initial pointer is only a lock address, never authority.
  const current = (await client.query('SELECT workspace_id FROM assistants WHERE id=$1 FOR SHARE', [params.assistantId])).rows[0]
  if (!current) throw new WorkspaceAccessError('context_not_available', 404)
  if (current.workspace_id !== assistantWorkspaceId) throw new WorkspaceAccessError('access_policy_conflict', 409)
  if (!workspaceId) {
    if (human) throw new WorkspaceAccessError('context_not_available', 404)
    return params // A frozen, genuinely workspace-less legacy output.
  }
  // Check identity before admission: a resume is not a new destination choice.
  const existing = (await client.query(`SELECT context_group_id AS "contextGroupId",
    context_project_id AS "contextProjectId", context_compartments AS "contextCompartments"
    FROM sessions WHERE assistant_id=$1 AND user_id=$2 AND channel_type=$3 AND channel_id=$4 AND app_id=$5 FOR SHARE`,
  [params.assistantId, params.userId, params.channelType, params.channelId, params.appId ?? 'Use Brian'])).rows[0]
  if (existing) return { ...params, ...existing }
  const policy = await readAdmissionPolicy(client, workspaceId)
  if (assistantWorkspaceId !== workspaceId) {
    const assistantPolicy = assistantWorkspaceId ? await readAdmissionPolicy(client, assistantWorkspaceId) : null
    if (human || policy?.setupState === 'ready' || assistantPolicy?.setupState === 'ready') {
      throw new WorkspaceAccessError('context_not_available', 404)
    }
    // Historical cross-workspace comment threads retain legacy behavior only
    // while BOTH workspaces remain legacy. New ready-mode roots require locality.
  }
  if (params.expectedPolicyRevision !== undefined && params.expectedPolicyRevision !== policy?.revision) {
    throw new WorkspaceAccessError('access_policy_conflict', 409)
  }
  if (!policy || policy.setupState === 'legacy') return params
  if (!human || params.channelType !== 'web' || params.appOrigin !== 'chat') {
    throw new WorkspaceAccessError('session_admission_unsupported', 409)
  }
  if (params.workspaceId !== workspaceId) throw new WorkspaceAccessError('context_not_available', 404)
  for (const id of [params.contextGroupId, params.contextProjectId]) {
    if (id !== undefined && id !== null && (typeof id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
      throw new WorkspaceAccessError('context_not_available', 404)
    }
  }
  const member = await client.query('SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE', [workspaceId, params.userId])
  if (!member.rows.length) throw new WorkspaceAccessError('context_not_available', 404)
  const assistant = (await client.query<TurnScopeAssistant>(`SELECT id,workspace_id AS "workspaceId",kind,clearance,compartments,
    default_compartments AS "defaultCompartments",team_scope_mode AS "teamScopeMode",
    default_workspace_group_id AS "defaultWorkspaceGroupId",project_scope_mode AS "projectScopeMode",
    default_project_id AS "defaultProjectId" FROM assistants WHERE id=$1 FOR SHARE`, [params.assistantId])).rows[0]
  if (!assistant || assistant.workspaceId !== workspaceId) throw new WorkspaceAccessError('context_not_available', 404)
  const groupId = params.contextGroupId !== undefined ? params.contextGroupId
    : policy.mode === 'simple' ? policy.defaultDepartmentId : assistant.defaultWorkspaceGroupId
  const projectId = params.contextProjectId !== undefined ? params.contextProjectId : assistant.defaultProjectId
  if (params.contextGroupId === undefined && !groupId) {
    throw new WorkspaceAccessError(policy.mode === 'simple' ? 'access_mode_default_invalid' : 'context_selection_required', 409)
  }
  const execute: typeof query = (sql, values) => client.query(sql, values)
  const scope = await resolveTurnScopeSystem({ userId: params.userId, workspaceId, assistant,
    memberMode: 'member', session: { contextGroupId: groupId, contextProjectId: projectId } }, {
    store: createDbContextScopeStore(client),
    resolveReadCeilings: (userId, wid, clearance, compartments) =>
      resolveOperationCeilingsSystem(userId, wid, clearance, compartments, true, execute),
    resolveWorkspaceRole: async (userId, wid) => (await client.query('SELECT role FROM workspace_members WHERE user_id=$1 AND workspace_id=$2', [userId, wid])).rows[0]?.role ?? null,
  })
  const admitted = await admitWorkspaceResource(client, workspaceId, params.userId, {
    expectedPolicyRevision: params.expectedPolicyRevision, visibility: 'workspace', sensitivity: assistant.clearance,
    destination: groupId ? { kind: 'department', departmentId: groupId, ...(projectId ? { projectId } : {}) }
      : { kind: 'general', ...(projectId ? { projectId } : {}) },
  })
  const ranks = { public: 0, internal: 1, confidential: 2 }
  if (ranks[admitted.envelope.sensitivity] > ranks[scope.access.clearance ?? 'public']
    || !scopeGrantContains(scope.access.mutationCompartments === undefined ? [] : scope.access.mutationCompartments, admitted.envelope.compartments)
    || !scopeGrantContains(scope.effectiveProjectIds, admitted.envelope.projectIds)) {
    throw new WorkspaceAccessError('context_not_available', 404)
  }
  // Separate, one-use receipt: no generic content receipt or source/channel
  // caller can masquerade as an ordinary authenticated chat root.
  await client.query("SELECT set_config('app.session_creation_admission',$1,true)", [JSON.stringify({
    protocol: '1', provenance: 'authenticated_chat_root', workspaceId,
    policyRevision: policy.revision, actor: params.userId,
    assistantId: params.assistantId, userId: params.userId,
    channelType: params.channelType, channelId: params.channelId,
    appId: params.appId ?? 'Use Brian', appOrigin: params.appOrigin,
    visibility: 'workspace', mode: null, anchorKind: 'none',
    sensitivity: admitted.envelope.sensitivity,
    groupId: groupId ?? null, projectId: projectId ?? null,
    compartments: admitted.envelope.compartments,
  })])
  return { ...params, workspaceId, effectiveClearance: admitted.envelope.sensitivity,
    contextGroupId: groupId ?? null, contextProjectId: projectId ?? null,
    contextCompartments: admitted.envelope.compartments }
}

/**
 * Creation admission for an ANCHORED workspace thread (unified-sessions L12):
 * a doc / Office / feed thread or a feed draft. The anchor decides the
 * thread's audience and the caller has already checked the actor's authority
 * over the anchor (page access, file access, draft collaboration, or a live
 * public-page comment grant for a guest). This mints the one-use
 * `anchored_thread` receipt the database trigger
 * (`require_session_creation_admission`, migration 741) requires in a ready
 * workspace; a legacy workspace needs none. Must run in the same transaction
 * as the insert.
 */
export async function admitAnchoredSession<T extends Input & {
  anchorKind: 'doc_thread' | 'office_file' | 'feed_draft' | 'feed_thread'
  anchorRef?: string | null
  guestAnchor?: true
}>(client: PoolClient, params: T): Promise<T & { workspaceId?: string | null; effectiveClearance?: string | null }> {
  const assistant = (await client.query<{ workspaceId: string | null; clearance: string | null }>(
    'SELECT workspace_id AS "workspaceId", clearance FROM assistants WHERE id=$1 FOR SHARE', [params.assistantId])).rows[0]
  if (!assistant) throw new WorkspaceAccessError('context_not_available', 404)
  const workspaceId = params.workspaceId ?? assistant.workspaceId
  if (!workspaceId) return params
  await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId])
  const policy = await readAdmissionPolicy(client, workspaceId)
  const effectiveClearance = params.effectiveClearance ?? assistant.clearance ?? 'internal'
  if (!policy || policy.setupState === 'legacy') return { ...params, workspaceId, effectiveClearance }
  if (assistant.workspaceId !== workspaceId) throw new WorkspaceAccessError('context_not_available', 404)
  await client.query("SELECT set_config('app.session_creation_admission',$1,true)", [JSON.stringify({
    protocol: '1', provenance: 'anchored_thread', workspaceId,
    policyRevision: policy.revision, actor: params.userId,
    assistantId: params.assistantId, userId: params.userId,
    anchorKind: params.anchorKind,
    ...(params.anchorRef !== undefined && params.anchorRef !== null ? { anchorRef: params.anchorRef } : {}),
    sensitivity: effectiveClearance,
    ...(params.guestAnchor ? { guest: 'true' } : {}),
  })])
  return { ...params, workspaceId, effectiveClearance }
}

/**
 * Creation admission for a CONVERGED CHANNEL ROOM (unified-sessions D15): a
 * provider group bound to the workspace by its channel integration. The
 * binding is the authority, not the sender: the starter may be a guest. Mints
 * the `channel_room` receipt `require_session_creation_admission` checks in a
 * ready workspace (migration 741). A department assistant's room binds its
 * department compartment (the 741 sharing guard requires it). Must run in the
 * insert's transaction.
 */
export async function admitChannelRoom(client: PoolClient, params: {
  assistantId: string
  userId: string
  workspaceId: string
  channelType: string
  channelId: string
  channelIntegrationId: string
}): Promise<{ effectiveClearance: string; contextGroupId: string | null; contextCompartments: string[] }> {
  const assistant = (await client.query<{ workspaceId: string | null; clearance: string | null; groupId: string | null; compartment: string | null }>(
    `SELECT a.workspace_id AS "workspaceId", a.clearance, g.id AS "groupId", g.compartment_key AS compartment
       FROM assistants a LEFT JOIN workspace_groups g ON g.id = a.placement_department_id
      WHERE a.id=$1 FOR SHARE OF a`, [params.assistantId])).rows[0]
  if (!assistant || assistant.workspaceId !== params.workspaceId) throw new WorkspaceAccessError('context_not_available', 404)
  const bound = await client.query(
    `SELECT 1 FROM channel_integrations ci JOIN channels c ON c.id = ci.channel_id
      WHERE ci.id=$1 AND c.workspace_id=$2 AND ci.channel_type=$3`,
    [params.channelIntegrationId, params.workspaceId, params.channelType])
  if (!bound.rows.length) throw new WorkspaceAccessError('context_not_available', 404)
  const effectiveClearance = assistant.clearance ?? 'internal'
  const department = assistant.groupId && assistant.compartment
    ? { contextGroupId: assistant.groupId, contextCompartments: [assistant.compartment] }
    : { contextGroupId: null, contextCompartments: [] as string[] }
  await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [params.workspaceId])
  const policy = await readAdmissionPolicy(client, params.workspaceId)
  if (!policy || policy.setupState === 'legacy') return { effectiveClearance, ...department }
  await client.query("SELECT set_config('app.session_creation_admission',$1,true)", [JSON.stringify({
    protocol: '1', provenance: 'channel_room', workspaceId: params.workspaceId,
    policyRevision: policy.revision, actor: params.userId,
    assistantId: params.assistantId, userId: params.userId,
    anchorKind: 'channel', sensitivity: effectiveClearance,
    channelType: params.channelType, channelId: params.channelId,
    channelIntegrationId: params.channelIntegrationId,
  })])
  return { effectiveClearance, ...department }
}

/** Constructed from verified transport claims, passed separately from input. */
export type PersonalWebSessionPrincipal = {
  actorUserId: string; authSessionId: string; authVersion: number
}

/** Personal web roots are private, not ordinary shared work. No mode or
 * assistant defaults, and no ambient/attributed user is authentication proof. */
export async function admitPersonalWebSession(client: PoolClient, params: Input, principal: PersonalWebSessionPrincipal) {
  if (principal.actorUserId !== params.userId || params.channelType !== 'web' || params.appOrigin !== 'chat' || !params.workspaceId) {
    throw new WorkspaceAccessError('context_not_available', 404)
  }
  await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [params.workspaceId])
  const auth = await client.query(`SELECT s.id FROM auth_sessions s JOIN users u ON u.id=s.user_id
    WHERE s.id=$1 AND s.user_id=$2 AND s.auth_version=$3 AND u.auth_version=s.auth_version
    AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE OF s,u`,
  [principal.authSessionId, principal.actorUserId, principal.authVersion])
  if (!auth.rows.length) throw new WorkspaceAccessError('authenticated_session_required', 401)
  const member = await client.query('SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE', [params.workspaceId, params.userId])
  if (!member.rows.length) throw new WorkspaceAccessError('context_not_available', 404)
  const assistant = (await client.query<TurnScopeAssistant>(`SELECT id,workspace_id AS "workspaceId",kind,clearance,compartments,
    default_compartments AS "defaultCompartments",team_scope_mode AS "teamScopeMode",project_scope_mode AS "projectScopeMode"
    FROM assistants WHERE id=$1 AND workspace_id=$2 FOR SHARE`, [params.assistantId, params.workspaceId])).rows[0]
  if (!assistant) throw new WorkspaceAccessError('context_not_available', 404)
  const existing = (await client.query(`SELECT visibility,mode,workspace_id,channel_type AS "channelType",anchor_kind AS "anchorKind" FROM sessions
    WHERE assistant_id=$1 AND user_id=$2 AND channel_type='web' AND channel_id=$3 AND app_id=$4 FOR SHARE`,
  [params.assistantId, params.userId, params.channelId, params.appId ?? 'Use Brian'])).rows[0]
  if (existing) {
    const kind = classifySession(existing)
    if (kind.audience !== 'personal' || kind.anchor.kind !== 'none' || existing.workspace_id !== params.workspaceId) throw new WorkspaceAccessError('context_not_available', 404)
    return params // Store UPDATE-first returns the actual binding, including null.
  }
  const policy = await readAdmissionPolicy(client, params.workspaceId)
  if (params.expectedPolicyRevision !== undefined && params.expectedPolicyRevision !== policy?.revision) throw new WorkspaceAccessError('access_policy_conflict', 409)
  const binding = { contextGroupId: params.contextGroupId ?? null, contextProjectId: params.contextProjectId ?? null }
  const execute: typeof query = (sql, values) => client.query(sql, values)
  const scope = await resolveTurnScopeSystem({ userId: params.userId, workspaceId: params.workspaceId, assistant, memberMode: 'member', session: binding }, {
    store: createDbContextScopeStore(client),
    resolveReadCeilings: (uid, wid, clearance, compartments) => resolveOperationCeilingsSystem(uid, wid, clearance, compartments, true, execute),
    resolveWorkspaceRole: async (uid, wid) => (await client.query('SELECT role FROM workspace_members WHERE user_id=$1 AND workspace_id=$2', [uid, wid])).rows[0]?.role ?? null,
  })
  const admitted = { ...params, ...binding, effectiveClearance: null,
    contextCompartments: scope.activeTeam ? [scope.activeTeam.compartmentKey] : [] }
  // Reuse the terminal database authority predicate, not just receipt equality.
  // It independently enforces current member + assistant creation floors.
  const authority = await client.query<{ allowed: boolean }>(
    'SELECT personal_web_session_scope_allows($1,$2,$3,$4,$5,$6) AS allowed',
    [params.workspaceId, params.userId, params.assistantId, binding.contextGroupId, binding.contextProjectId, admitted.contextCompartments],
  )
  if (authority.rows[0]?.allowed !== true) throw new WorkspaceAccessError('context_not_available', 404)
  await client.query("SELECT set_config('app.session_creation_admission',$1,true)", [JSON.stringify({
    protocol: '1', provenance: 'authenticated_personal_web', ...principal,
    workspaceId: params.workspaceId, policyRevision: policy?.revision,
    assistantId: params.assistantId, userId: params.userId, channelId: params.channelId,
    appId: params.appId ?? 'Use Brian', ...binding, compartments: admitted.contextCompartments,
  })])
  return admitted
}
