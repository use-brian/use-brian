/**
 * Shared Project governance: the one store behind the REST routes and Brian's
 * project access tools (inspectProjectAccess / manageProjectAccess), so both
 * carry identical authority, revision checks, errors and audit.
 * Spec: docs/architecture/features/project-shared-spaces.md -> "Canonical commands".
 *
 * Every mutation is one call into an actor-bound SQL function from migration
 * 749 on the RLS-enforced app connection: the function locks workspace then
 * scope, rechecks the actor's authority inside the transaction, refuses a
 * stale revision and treats a repeat of the current state as success.
 *
 * [COMP:api/project-shared-governance]
 */
import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { applyRLSGucs, getAppPool, rollbackAndRelease } from './client.js'
import { notifyWorkspaceChange } from '../brain-stream/notify.js'
import { WorkspaceAccessError } from '../workspace-access/policy.js'

export type ProjectPrincipal = { kind: 'user' | 'assistant'; id: string }
export type ProjectSharedRole = 'owner' | 'participant' | 'oversight'

export type ProjectRosterEntry = {
  principal: ProjectPrincipal
  name: string | null
  email: string | null
  isOwner: boolean
  expiresAt: string | null
  origin: string
}

export type ProjectRoster = {
  projectId: string
  status: 'active' | 'quarantined'
  origin: 'created' | 'converted'
  revision: number
  myRole: ProjectSharedRole | null
  /** Explicit participants (owners included, flagged). */
  members: ProjectRosterEntry[]
  /** Derived, nonremovable D27 read oversight: the current workspace owner(s), shown separately. */
  oversight: Array<{ userId: string; name: string | null; isMember: boolean }>
  audit: Array<{ action: string; actorUserId: string | null; principalKind: string | null; principalId: string | null; reason: string | null; createdAt: string }>
}

export type ProjectSharedSummary = {
  projectId: string
  status: 'active' | 'quarantined'
  revision: number
  myRole: ProjectSharedRole | null
}

export type ProjectConversionPreview = {
  projectId: string
  projectName: string
  ownerUserId: string
  userIds: string[]
  assistantIds: string[]
  /** Old participation metadata is shown for reference only; never preselected. */
  legacyParticipation: { userIds: string[]; assistantIds: string[] }
  /** Linked material the caller can see; conversion leaves all of it with its current audience. */
  linkedMaterial: { tasks: number; pages: number; files: number; chats: number }
  relabelled: 0
  requestHash: string
}

export type ProjectConversionReceipt = {
  projectId: string
  revision: number
  owners: string[]
  users: string[]
  assistants: string[]
  relabelled: number
  replayed: boolean
}

const ERRORS: Record<string, number> = {
  project_actor_required: 401,
  project_not_found: 404,
  project_owner_required: 403,
  project_create_not_allowed: 403,
  project_recovery_owner_only: 403,
  project_shared_disabled: 409,
  project_shared_requires_department_read: 409,
  project_principal_not_in_workspace: 400,
  project_assistant_unavailable: 409,
  project_principal_invalid: 400,
  project_expiry_invalid: 400,
  project_name_invalid: 400,
  project_name_taken: 409,
  project_status_invalid: 400,
  project_recovery_reason_required: 400,
  project_revision_stale: 409,
  project_last_owner: 409,
  project_owner_edge_required: 409,
  project_already_shared: 409,
  project_idempotency_conflict: 409,
  project_conversion_review_changed: 409,
  project_placement_move_refused: 409,
  project_scope_label_invalid: 400,
}

async function asActor<T>(actor: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getAppPool().connect()
  try {
    await client.query('BEGIN')
    await applyRLSGucs(client, actor)
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    const message = (error as Error).message
    if (message in ERRORS) throw new WorkspaceAccessError(message, ERRORS[message])
    // A concurrent change to the same scope or roster: retry with the current revision.
    if (['40001', '40P01', '23505'].includes((error as { code?: string }).code ?? '')) throw new WorkspaceAccessError('project_revision_stale', 409)
    throw error
  } finally {
    await rollbackAndRelease(client)
  }
}

const revisionOf = (rows: { revision: string }[]) => Number(rows[0].revision)
const sorted = (values: readonly string[]) => [...new Set(values)].sort()

/** A conversion review binds exactly this request. */
export function projectConversionHash(input: { projectId: string; ownerUserId: string; userIds: readonly string[]; assistantIds: readonly string[] }): string {
  return createHash('sha256').update(JSON.stringify({
    projectId: input.projectId, ownerUserId: input.ownerUserId, userIds: sorted(input.userIds), assistantIds: sorted(input.assistantIds),
  })).digest('hex')
}

/** The caller's role in one shared Project, read inside the actor transaction. */
async function roleOf(client: PoolClient, actor: string, projectId: string): Promise<ProjectSharedRole | null> {
  const row = (await client.query<{ owner: boolean; member: boolean; workspaceOwner: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM project_shared_owners o WHERE o.project_id=$1 AND o.user_id=$2) AS owner,
            project_member_live($1,'user',$2) AS member,
            EXISTS (SELECT 1 FROM project_shared_scopes s JOIN workspace_members m ON m.workspace_id=s.workspace_id
                     WHERE s.project_id=$1 AND m.user_id=$2 AND m.role='owner') AS "workspaceOwner"`, [projectId, actor])).rows[0]
  if (!row) return null
  if (row.owner && row.member) return 'owner'
  if (row.member) return 'participant'
  return row.workspaceOwner ? 'oversight' : null
}

export function createProjectSharedStore() {
  const notify = (workspaceId: string) => notifyWorkspaceChange(workspaceId, 'workspace_config', 'update')
  const scopeWorkspace = async (client: PoolClient, projectId: string) =>
    (await client.query<{ workspaceId: string }>('SELECT workspace_id AS "workspaceId" FROM project_shared_scopes WHERE project_id=$1', [projectId])).rows[0]?.workspaceId
  const mutate = async (actor: string, projectId: string, sql: string, values: unknown[]): Promise<number> => {
    const { revision, workspaceId } = await asActor(actor, async (client) => {
      const workspaceId = await scopeWorkspace(client, projectId)
      if (!workspaceId) throw new WorkspaceAccessError('project_not_found', 404)
      return { revision: revisionOf((await client.query<{ revision: string }>(sql, values)).rows), workspaceId }
    })
    notify(workspaceId)
    return revision
  }

  return {
    /** Whether the workspace has shared spaces enabled, and whether the caller is its owner. */
    async capability(actor: string, workspaceId: string): Promise<{ enabled: boolean; canConfigure: boolean }> {
      return asActor(actor, async (client) => {
        const row = (await client.query<{ enabled: boolean; owner: boolean }>(
          `SELECT w.project_shared_spaces AND w.department_read_v2 AS enabled,
                  EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id=w.id AND m.user_id=$2 AND m.role='owner') AS owner
             FROM workspaces w JOIN workspace_members me ON me.workspace_id=w.id AND me.user_id=$2 WHERE w.id=$1`, [workspaceId, actor])).rows[0]
        if (!row) throw new WorkspaceAccessError('project_not_found', 404)
        return { enabled: row.enabled, canConfigure: row.owner }
      })
    },

    async setCapability(actor: string, workspaceId: string, enabled: boolean): Promise<boolean> {
      const result = await asActor(actor, async (client) =>
        (await client.query<{ enabled: boolean }>('SELECT public.project_shared_set_capability($1,$2) AS enabled', [workspaceId, enabled])).rows[0].enabled)
      notify(workspaceId)
      return result
    },

    /** Shared summaries for the Projects the caller can see (RLS hides the rest). */
    async summaries(actor: string, workspaceId: string): Promise<ProjectSharedSummary[]> {
      return asActor(actor, async (client) => {
        const rows = (await client.query<{ projectId: string; status: 'active' | 'quarantined'; revision: string }>(
          `SELECT project_id AS "projectId", status, revision::text FROM project_shared_scopes WHERE workspace_id=$1 ORDER BY project_id`, [workspaceId])).rows
        const out: ProjectSharedSummary[] = []
        for (const row of rows) out.push({ projectId: row.projectId, status: row.status, revision: Number(row.revision), myRole: await roleOf(client, actor, row.projectId) })
        return out
      })
    },

    /** The roster as the caller may see it; a nonmember who is not the workspace owner gets not_found. */
    async roster(actor: string, workspaceId: string, projectId: string): Promise<ProjectRoster> {
      return asActor(actor, async (client) => {
        const scope = (await client.query<{ status: 'active' | 'quarantined'; origin: 'created' | 'converted'; revision: string }>(
          'SELECT status, origin, revision::text FROM project_shared_scopes WHERE project_id=$1 AND workspace_id=$2', [projectId, workspaceId])).rows[0]
        if (!scope) throw new WorkspaceAccessError('project_not_found', 404)
        const members = (await client.query<{ kind: 'user' | 'assistant'; id: string; name: string | null; email: string | null; isOwner: boolean; expiresAt: Date | null; origin: string }>(
          `SELECT e.principal_kind AS kind, coalesce(e.user_id, e.assistant_id) AS id, coalesce(u.name, a.name) AS name, u.email,
                  EXISTS (SELECT 1 FROM project_shared_owners o WHERE o.project_id=e.project_id AND o.user_id=e.user_id) AS "isOwner",
                  e.expires_at AS "expiresAt", e.origin
             FROM project_shared_members e
             LEFT JOIN users u ON u.id=e.user_id
             LEFT JOIN assistants a ON a.id=e.assistant_id
            WHERE e.project_id=$1 AND (e.expires_at IS NULL OR e.expires_at > clock_timestamp())
            ORDER BY e.principal_kind DESC, "isOwner" DESC, coalesce(u.name, a.name) NULLS LAST, coalesce(e.user_id, e.assistant_id)`, [projectId])).rows
        const oversight = (await client.query<{ userId: string; name: string | null; isMember: boolean }>(
          `SELECT m.user_id AS "userId", u.name, project_member_live($1,'user',m.user_id) AS "isMember"
             FROM workspace_members m LEFT JOIN users u ON u.id=m.user_id
            WHERE m.workspace_id=$2 AND m.role='owner' ORDER BY m.user_id`, [projectId, workspaceId])).rows
        const audit = (await client.query<{ action: string; actorUserId: string | null; principalKind: string | null; principalId: string | null; reason: string | null; createdAt: Date }>(
          `SELECT action, actor_user_id AS "actorUserId", principal_kind AS "principalKind", principal_id AS "principalId", reason, created_at AS "createdAt"
             FROM project_shared_audit_events WHERE project_id=$1 ORDER BY created_at DESC, id DESC LIMIT 50`, [projectId])).rows
        return {
          projectId, status: scope.status, origin: scope.origin, revision: Number(scope.revision), myRole: await roleOf(client, actor, projectId),
          members: members.map(m => ({ principal: { kind: m.kind, id: m.id }, name: m.name, email: m.email, isOwner: m.isOwner,
            expiresAt: m.expiresAt ? m.expiresAt.toISOString() : null, origin: m.origin })),
          oversight,
          audit: audit.map(a => ({ ...a, createdAt: a.createdAt.toISOString() })),
        }
      })
    },

    /** D20/D21/D23: name plus visibly selected participants; creator becomes owner. */
    async create(actor: string, workspaceId: string, input: { name: string; description?: string | null; icon?: string | null; userIds: string[]; assistantIds: string[] }): Promise<string> {
      const id = await asActor(actor, async (client) => (await client.query<{ id: string }>(
        'SELECT public.project_shared_create($1,$2,$3,$4,$5::uuid[],$6::uuid[]) AS id',
        [workspaceId, input.name, input.description ?? null, input.icon ?? null, sorted(input.userIds), sorted(input.assistantIds)])).rows[0].id)
      notify(workspaceId)
      return id
    },

    async setMember(actor: string, projectId: string, principal: ProjectPrincipal, expiresAt: Date | null, expectedRevision?: number): Promise<number> {
      return mutate(actor, projectId, 'SELECT public.project_shared_set_member($1,$2,$3,$4,$5) AS revision',
        [projectId, principal.kind, principal.id, expiresAt, expectedRevision ?? null])
    },
    async removeMember(actor: string, projectId: string, principal: ProjectPrincipal, expectedRevision?: number): Promise<number> {
      return mutate(actor, projectId, 'SELECT public.project_shared_remove_member($1,$2,$3,$4) AS revision',
        [projectId, principal.kind, principal.id, expectedRevision ?? null])
    },
    async addOwner(actor: string, projectId: string, userId: string, expectedRevision?: number): Promise<number> {
      return mutate(actor, projectId, 'SELECT public.project_shared_add_owner($1,$2,$3) AS revision', [projectId, userId, expectedRevision ?? null])
    },
    async removeOwner(actor: string, projectId: string, userId: string, expectedRevision?: number): Promise<number> {
      return mutate(actor, projectId, 'SELECT public.project_shared_remove_owner($1,$2,$3) AS revision', [projectId, userId, expectedRevision ?? null])
    },
    async transferOwner(actor: string, projectId: string, userId: string, expectedRevision?: number): Promise<number> {
      return mutate(actor, projectId, 'SELECT public.project_shared_transfer_owner($1,$2,$3) AS revision', [projectId, userId, expectedRevision ?? null])
    },
    /** D26: workspace owner, any time, audited; existing owners stay. */
    async recover(actor: string, projectId: string, targetUserId: string | null, reason: string, expectedRevision?: number): Promise<number> {
      return mutate(actor, projectId, 'SELECT public.project_shared_recover($1,$2,$3,$4) AS revision', [projectId, targetUserId, reason, expectedRevision ?? null])
    },
    async setStatus(actor: string, projectId: string, status: 'active' | 'quarantined', reason: string | null, expectedRevision?: number): Promise<number> {
      return mutate(actor, projectId, 'SELECT public.project_shared_set_status($1,$2,$3,$4) AS revision', [projectId, status, reason, expectedRevision ?? null])
    },
    async updateDetails(actor: string, projectId: string, input: { name?: string; description?: string | null; icon?: string | null }, expectedRevision?: number): Promise<number> {
      // NULL means "unchanged" in SQL; an explicit clear is the empty string.
      return mutate(actor, projectId, 'SELECT public.project_shared_update_details($1,$2,$3,$4,$5) AS revision',
        [projectId, input.name ?? null, input.description === undefined ? null : input.description ?? '', input.icon === undefined ? null : input.icon ?? '', expectedRevision ?? null])
    },
    async archive(actor: string, projectId: string, archived: boolean, expectedRevision?: number): Promise<number> {
      return mutate(actor, projectId, 'SELECT public.project_shared_archive($1,$2,$3) AS revision', [projectId, archived, expectedRevision ?? null])
    },

    /**
     * §15.3 preview: the exact Project, accountable owner and reviewed roster.
     * Old participation metadata is returned separately and never selected.
     */
    async previewConversion(actor: string, workspaceId: string, projectId: string,
      input: { ownerUserId?: string | null; userIds: string[]; assistantIds: string[] }): Promise<ProjectConversionPreview> {
      return asActor(actor, async (client) => {
        const project = (await client.query<{ name: string; shared: boolean; owner: boolean; enabled: boolean }>(
          `SELECT p.name, EXISTS (SELECT 1 FROM project_shared_scopes s WHERE s.project_id=p.id) AS shared,
                  EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id=p.workspace_id AND m.user_id=$3 AND m.role='owner') AS owner,
                  w.project_shared_spaces AND w.department_read_v2 AS enabled
             FROM workspace_projects p JOIN workspaces w ON w.id=p.workspace_id WHERE p.id=$1 AND p.workspace_id=$2`, [projectId, workspaceId, actor])).rows[0]
        if (!project) throw new WorkspaceAccessError('project_not_found', 404)
        if (!project.owner) throw new WorkspaceAccessError('project_recovery_owner_only', 403)
        if (!project.enabled) throw new WorkspaceAccessError('project_shared_disabled', 409)
        if (project.shared) throw new WorkspaceAccessError('project_already_shared', 409)
        const legacy = (await client.query<{ userIds: string[]; assistantIds: string[] }>(
          `SELECT coalesce((SELECT array_agg(user_id::text ORDER BY user_id) FROM workspace_project_members WHERE project_id=$1), '{}') AS "userIds",
                  coalesce((SELECT array_agg(assistant_id::text ORDER BY assistant_id) FROM assistant_project_grants WHERE project_id=$1), '{}') AS "assistantIds"`,
          [projectId])).rows[0]
        const linked = (await client.query<{ tasks: number; pages: number; files: number; chats: number }>(
          `SELECT (SELECT count(*)::int FROM tasks WHERE workspace_id=$2 AND project_ids @> ARRAY[$1::uuid]) AS tasks,
                  (SELECT count(*)::int FROM saved_views WHERE workspace_id=$2 AND project_id=$1) AS pages,
                  (SELECT count(*)::int FROM workspace_files WHERE workspace_id=$2 AND project_ids @> ARRAY[$1::uuid]) AS files,
                  (SELECT count(*)::int FROM sessions WHERE workspace_id=$2 AND context_project_id=$1) AS chats`, [projectId, workspaceId])).rows[0]
        const ownerUserId = input.ownerUserId ?? actor
        const userIds = sorted([...input.userIds, ownerUserId])
        const assistantIds = sorted(input.assistantIds)
        return { projectId, projectName: project.name, ownerUserId, userIds, assistantIds, legacyParticipation: legacy, linkedMaterial: linked, relabelled: 0,
          requestHash: projectConversionHash({ projectId, ownerUserId, userIds, assistantIds }) }
      })
    },

    /** Apply exactly the reviewed request. A repeat with the same key and hash returns the stored receipt. */
    async applyConversion(actor: string, workspaceId: string, projectId: string,
      input: { ownerUserId?: string | null; userIds: string[]; assistantIds: string[]; idempotencyKey: string; requestHash: string }): Promise<ProjectConversionReceipt> {
      const ownerUserId = input.ownerUserId ?? actor
      const userIds = sorted([...input.userIds, ownerUserId])
      const assistantIds = sorted(input.assistantIds)
      if (projectConversionHash({ projectId, ownerUserId, userIds, assistantIds }) !== input.requestHash) {
        throw new WorkspaceAccessError('project_conversion_review_changed', 409)
      }
      const receipt = await asActor(actor, async (client) => {
        const project = (await client.query('SELECT 1 FROM workspace_projects WHERE id=$1 AND workspace_id=$2', [projectId, workspaceId])).rows[0]
        if (!project) throw new WorkspaceAccessError('project_not_found', 404)
        return (await client.query<{ receipt: ProjectConversionReceipt }>(
          'SELECT public.project_shared_convert($1,$2,$3::uuid[],$4::uuid[],$5,$6) AS receipt',
          [projectId, ownerUserId, userIds, assistantIds, input.idempotencyKey, input.requestHash])).rows[0].receipt
      })
      if (!receipt.replayed) notify(workspaceId)
      return receipt
    },
  }
}

export type ProjectSharedStore = ReturnType<typeof createProjectSharedStore>
