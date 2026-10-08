/**
 * The in-transaction half of `DELETE /api/account`.
 *
 * Spec: docs/architecture/features/privacy-controls.md -> "Teardown order".
 *
 * The caller owns BEGIN/COMMIT and the shared-ownership guards (a user who
 * owns a workspace or assistant with other members is refused before this
 * runs). Founder decisions (2026-10-03): a leaving member's ownership moves
 * to the workspace owner, private rows go with the account, recorded actors
 * show as a deleted user (never credited to the owner), authored workflows
 * pause for review, and room messages stay.
 *
 *  1. Workspaces the user owns alone (Personal included) are deleted.
 *  2. In other people's workspaces, every NO ACTION / RESTRICT foreign key to
 *     `users` follows an explicit rule (`ACCOUNT_TEARDOWN_RULES`):
 *       - `delete`   the row is the user's own (private, or per-user state);
 *       - `reassign` ownership of shared content moves to the workspace owner;
 *       - `keep`     a recorded actor: the row keeps naming the user, who
 *                    becomes a scrubbed "Deleted user" if the row survives.
 *     An unclassified column FAILS CLOSED before anything is touched,
 *     because guessing is how private rows get handed to someone else.
 *  3. Everything the schema declares ON DELETE CASCADE from `users` is the
 *     user's by the schema's own statement, and is deleted explicitly, with
 *     one exception: workspace rooms the user started move to the owner.
 *  4. The `users` row is deleted if nothing still names it; otherwise it is
 *     TOMBSTONED: identity scrubbed, sign-in impossible, `deleted_at` set.
 *     Evidence tables are tamper-evident by design, so a member who left a
 *     trail there keeps a "Deleted user" row rather than rewriting history.
 *
 * Steps run as a fixpoint: Postgres fires NO ACTION checks and cascades as
 * separate referential triggers, so a statement can be refused by a row its
 * own cascade was about to remove. A step refused for ordering or a lock is
 * retried on the next pass; any other error stops the teardown at once and
 * names the step.
 */

export interface TeardownClient {
  query: <R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ) => Promise<{ rows: R[]; rowCount: number | null }>
}

export class AccountTeardownBlockedError extends Error {
  readonly code = 'account_data_blocked'
  constructor(readonly blockers: Array<{ step: string; error: string }>) {
    super(`Account teardown blocked by: ${blockers.map((b) => b.step).join(', ')}`)
  }
}

/**
 * What happens to rows of `table.column` that name the leaving user in a
 * workspace they do not own alone. `privateWhere` (SQL over alias `t`)
 * selects rows that are private despite the column's default; those are
 * deleted, and the default action never touches them.
 */
export interface AccountTeardownRule {
  action: 'delete' | 'reassign' | 'keep'
  privateWhere?: string
}

const del: AccountTeardownRule = { action: 'delete' }
const own: AccountTeardownRule = { action: 'reassign' }
const keep: AccountTeardownRule = { action: 'keep' }

/** Open-schema rules. The hosted overlay adds its own through the boot port. */
export const ACCOUNT_TEARDOWN_RULES: Readonly<Record<string, AccountTeardownRule>> = {
  // Private: `user_id` is the visibility key read by department_row_allows /
  // agent_visibility_allows. Handing these to the owner would expose them.
  'entities.user_id': del,
  'entity_links.user_id': del,
  'episodes.user_id': del,
  'kb_chunks.user_id': del,
  'tasks.user_id': del,
  'workspace_files.user_id': del,
  // The scope key of the user's own sessions (NULL in workspace rooms).
  'session_messages.user_id': del,
  // Owner-only RLS keys and per-user state.
  'office_pdf_session_assets.owner_user_id': del,
  'workspace_file_session_bindings.owner_user_id': del,
  'connector_pending_setups.actor_user_id': del,
  'workspace_access_requests.requester_user_id': del,
  'scope_derivations.user_id': del,
  'workflow_schedule_edit_reviews.actor_id': del,

  // Ownership of shared content moves to the workspace owner.
  'entities.created_by_user_id': own,
  'episodes.created_by_user_id': own,
  'kb_chunks.created_by_user_id': own,
  'memories.created_by_user_id': own,
  'tasks.created_by_user_id': own,
  // A page with no teamspace is private to its creator.
  'saved_views.created_by': { action: 'reassign', privateWhere: 't.teamspace_id IS NULL' },
  'workspace_groups.created_by': own,
  'workspace_page_templates.created_by': own,
  'blueprint_records.created_by': own,
  'page_domains.created_by': own,
  'email_domains.created_by': own,
  'workspace_projects.created_by': own,
  'channel_sensitivity_rules.created_by': own,
  // A session-mode artifact is visible only to its owner.
  'office_artifacts.owner_user_id': { action: 'reassign', privateWhere: "t.mode = 'session'" },
  'office_artifacts.creator_user_id': { action: 'reassign', privateWhere: "t.mode = 'session'" },
  'office_templates.owner_user_id': own,
  'office_resources.created_by': own,
  // Paused first (a schedule runs as its author); migration 659 admits the
  // move on a pinned workflow only while it is disabled.
  'workflows.created_by': own,

  // Recorded actors and authority records: kept, shown as a deleted user.
  'workflows.schedule_authoring_user_id': keep,
  'workspace_knowledge_sources.configured_by_user_id': keep, // binding is held, below
  'pending_approvals.approver_user_id': keep, // pending ones are expired, below
  'assistants.owner_user_id': keep, // transferred to the workspace owner, below
  'assistant_capabilities.granted_by_user_id': keep,
  'assistant_capabilities.revoked_by_user_id': keep,
  'page_grants.created_by': keep,
  'page_slugs.created_by': keep,
  'brain_verifications.verified_by': keep,
  'memory_verifications.verified_by': keep,
  'correction_audit.actor_user_id': keep,
  'sensitivity_reclassifications.changed_by': keep,
  'entities.verified_by_user_id': keep,
  'entities.retracted_by': keep,
  'entity_links.verified_by_user_id': keep,
  'entity_merges.merged_by': keep,
  'entity_merges.undone_by': keep,
  'kb_chunks.verified_by_user_id': keep,
  'kb_chunks.retracted_by': keep,
  'memories.verified_by_user_id': keep,
  'memories.retracted_by': keep,
  'tasks.verified_by_user_id': keep,
  'tasks.retracted_by': keep,
  'workspace_files.verified_by_user_id': keep,
  'workspace_files.retracted_by': keep,
  'workspace_skills.verified_by_user_id': keep,
  'workspace_skill_scope_revisions.user_id': keep,
  'episode_extraction_runs.user_id': keep,
  'episode_extraction_runs.created_by_user_id': keep,
  'office_template_versions.created_by': keep,
  'office_comment_threads.created_by': keep,
  'office_generation_jobs.initiated_by_user_id': keep,
  'office_generation_steering.sender_user_id': keep,
  'office_release_records.released_by': keep,
  'context_scope_reclassification_events.actor_user_id': keep,
  'association_membership_offline_rescues.created_by_user_id': keep,
  'association_membership_offline_rescues.settlement_by_user_id': keep,
  'association_membership_offline_rescues.reversed_by_user_id': keep,
  'association_membership_offline_rescues.cancelled_by_user_id': keep,
  'campaign_email_dispatches.approved_by': keep,
  'workspace_team_managers.granted_by': keep,
  'workspace_access_requests.decided_by': keep,
  'workspace_access_grants.approved_by': keep,
  'workspace_access_grants.revoked_by': keep,
  'workspace_access_migration_plans.actor_user_id': keep,
  'external_app_record_versions.actor_user_id': keep,
  'external_app_record_observations.actor_user_id': keep,
  'external_app_access_versions.actor_user_id': keep,
}

/**
 * Display name of a tombstoned account. Stored, not translated: every
 * surface that renders a member name renders this without a code change.
 */
export const DELETED_USER_NAME = 'Deleted user'

export const ident = (name: string) => `"${name.replace(/"/g, '""')}"`

export type Step = { name: string; sql: string; values: unknown[] }

// foreign_key_violation, restrict_violation, lock_not_available, deadlock_detected
const RETRYABLE = new Set(['23503', '23001', '55P03', '40P01'])

const LOCK_CODES = new Set(['55P03', '40P01'])
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Runs `steps` to a fixpoint. `blocked` builds the error for a step that
 * cannot complete; other teardowns (assistant-teardown.ts) pass their own.
 */
export async function fixpoint(
  client: TeardownClient,
  steps: Step[],
  blocked: (blockers: Array<{ step: string; error: string }>) => Error = (b) => new AccountTeardownBlockedError(b),
): Promise<void> {
  let pending = steps
  let lastErrors = new Map<string, string>()
  let lockWait = false
  // A pass that makes progress removes at least one step, so steps.length
  // passes is enough for any dependency order.
  for (let pass = 0; pass <= steps.length && pending.length > 0; pass++) {
    const next: Step[] = []
    lastErrors = new Map()
    // A lock held by live traffic clears with time, not with another pass.
    if (lockWait) await pause(100 * pass)
    lockWait = false
    for (const step of pending) {
      await client.query('SAVEPOINT account_teardown_step')
      try {
        await client.query(step.sql, step.values)
        await client.query('RELEASE SAVEPOINT account_teardown_step')
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT account_teardown_step')
        await client.query('RELEASE SAVEPOINT account_teardown_step')
        const code = (err as { code?: string }).code
        if (!code || !RETRYABLE.has(code)) {
          throw blocked([{ step: step.name, error: (err as Error).message }])
        }
        next.push(step)
        lastErrors.set(step.name, (err as Error).message)
        if (LOCK_CODES.has(code)) lockWait = true
      }
    }
    if (next.length === pending.length) break
    pending = next
  }
  if (pending.length > 0) {
    throw blocked(pending.map((s) => ({ step: s.name, error: lastErrors.get(s.name) ?? 'unknown' })))
  }
}

export interface FkColumn {
  table: string // regclass text, already quoted where needed
  column: string
  notNull: boolean
  hasWorkspace: boolean
  targetTable: string
  /** Referenced column on the target table. */
  targetKey: string
}

/** Single-column FKs whose ON DELETE action is in `actions`, optionally to one table. */
export async function loadFks(client: TeardownClient, actions: string[], referenced?: string): Promise<FkColumn[]> {
  const { rows } = await client.query<{
    tbl: string; col: string; nn: boolean; has_ws: boolean; target: string; target_key: string
  }>(
    `SELECT c.conrelid::regclass::text AS tbl, a.attname AS col, a.attnotnull AS nn,
            EXISTS (SELECT 1 FROM pg_attribute x
                     WHERE x.attrelid = c.conrelid AND x.attname = 'workspace_id' AND NOT x.attisdropped) AS has_ws,
            c.confrelid::regclass::text AS target, k.attname AS target_key
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       JOIN pg_attribute k ON k.attrelid = c.confrelid AND k.attnum = c.confkey[1]
      WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 1
        AND c.confdeltype = ANY($1::"char"[])
        AND ($2::text IS NULL OR c.confrelid = $2::regclass)
      ORDER BY 1, 2`,
    [actions, referenced ?? null],
  )
  return rows.map((r) => ({
    table: r.tbl, column: r.col, notNull: r.nn, hasWorkspace: r.has_ws, targetTable: r.target, targetKey: r.target_key,
  }))
}

const OWNER = `(SELECT w.owner_user_id FROM public.workspaces w WHERE w.id = t.workspace_id)`

/**
 * Shared rows that point (NO ACTION / RESTRICT) at a private row about to be
 * deleted would block that delete forever. A nullable pointer is cleared
 * (provenance to erased data); a NOT NULL one stays and blocks honestly.
 */
function dependentSteps(inbound: FkColumn[], table: string, where: string): Step[] {
  return inbound
    .filter((d) => d.targetTable === table && !d.notNull && d.table !== table)
    .map((d) => ({
      name: `${d.table}.${d.column} -> ${table} (clear pointer)`,
      sql: `UPDATE ${d.table} SET ${ident(d.column)} = NULL
             WHERE ${ident(d.column)} IN (SELECT t.${ident(d.targetKey)} FROM ${table} t WHERE ${where})`,
      values: [],
    }))
}

function ruleSteps(fk: FkColumn, rule: AccountTeardownRule, inbound: FkColumn[]): Step[] {
  const name = `${fk.table}.${fk.column}`
  const mine = `t.${ident(fk.column)} = $1`
  const steps: Step[] = []
  const deleteWhere = (where: string, label: string) => {
    steps.push(...dependentSteps(inbound, fk.table, where))
    steps.push({ name: `${name} (${label})`, sql: `DELETE FROM ${fk.table} t WHERE ${where}`, values: [] })
  }
  if (rule.privateWhere) deleteWhere(`${mine} AND (${rule.privateWhere})`, 'delete private')
  // The default action never reaches a private row, even if its delete was
  // refused this pass: private rows leave only by being deleted.
  const shared = rule.privateWhere ? `${mine} AND NOT (${rule.privateWhere})` : mine
  if (rule.action === 'delete') deleteWhere(mine, 'delete')
  if (rule.action === 'reassign') {
    steps.push({
      name: `${name} (reassign to workspace owner)`,
      sql: `UPDATE ${fk.table} t SET ${ident(fk.column)} = ${OWNER}
             WHERE ${shared} AND ${OWNER} IS NOT NULL AND ${OWNER} <> $1`,
      values: [],
    })
  }
  return steps
}

export const ruleKey = (fk: FkColumn) => `${fk.table.replace(/^public\./, '').replace(/"/g, '')}.${fk.column}`

/** Rows the schema would cascade away with the user that must NOT go: workspace rooms. */
const CASCADE_KEEP: Readonly<Record<string, string>> = {
  'sessions.user_id': "t.visibility = 'workspace'",
  // A team brain key records the auth session it was configured in (NO
  // ACTION) and refuses a rebind, so that session row stays, revoked.
  'auth_sessions.user_id': 'EXISTS (SELECT 1 FROM brain_keys k WHERE k.configuration_session_id = t.id)',
  // A teamspace linked to a Team derives its roster from the Team and
  // refuses roster deletes; a stale explicit row stays (the derived roster
  // already excludes the user, whose Team membership goes below).
  'teamspace_members.user_id': 'EXISTS (SELECT 1 FROM teamspaces ts WHERE ts.id = t.teamspace_id AND ts.workspace_group_id IS NOT NULL)',
}

export type AccountTeardownResult = {
  mode: 'deleted' | 'tombstoned'
  workspacesDeleted: number
  assistantsDeleted: number
}

/**
 * Runs the teardown. `extraRules` lets an edition that adds tables (the
 * hosted overlay) classify its own columns; it cannot override an open rule.
 */
export async function deleteAccountFootprint(
  client: TeardownClient,
  userId: string,
  extraRules: Readonly<Record<string, AccountTeardownRule>> = {},
): Promise<AccountTeardownResult> {
  // Serialize concurrent deletes on the user row: the second waits, then
  // finds the row gone or already tombstoned and does nothing.
  const current = await client.query<{ deleted_at: Date | null }>(
    `SELECT deleted_at FROM users WHERE id = $1 FOR UPDATE`, [userId],
  )
  if (current.rows.length === 0) return { mode: 'deleted', workspacesDeleted: 0, assistantsDeleted: 0 }
  if (current.rows[0]!.deleted_at) return { mode: 'tombstoned', workspacesDeleted: 0, assistantsDeleted: 0 }

  const rules: Record<string, AccountTeardownRule> = { ...extraRules, ...ACCOUNT_TEARDOWN_RULES }
  const userRefs = (await loadFks(client, ['a', 'r'], 'public.users')).filter((fk) => fk.targetKey === 'id')

  // Fail closed before touching anything.
  const problems: Array<{ step: string; error: string }> = []
  for (const fk of userRefs) {
    const rule = rules[ruleKey(fk)]
    if (!rule) problems.push({ step: ruleKey(fk), error: 'no account teardown rule' })
    else if (rule.action === 'reassign' && !fk.hasWorkspace) {
      problems.push({ step: ruleKey(fk), error: 'reassign rule on a table without workspace_id' })
    }
  }
  if (problems.length > 0) throw new AccountTeardownBlockedError(problems)

  // Owner-only, FORCE-RLS tables answer to the system bypass or to their
  // owner; the leaver is both the subject and, for this transaction, the
  // actor. The erasure registration (migration 659) is what the pinned
  // workflow guard checks; it is bound to this transaction's id.
  await client.query(
    `SELECT set_config('app.system_bypass', 'true', true),
            set_config('app.current_user_id', $1, true),
            set_config('app.account_erasure', $1, true)`,
    [userId],
  )
  await client.query(
    `INSERT INTO account_erasures (txid, user_id) VALUES (pg_current_xact_id()::text, $1)`,
    [userId],
  )
  // Deferred foreign keys would otherwise surface only at COMMIT, outside
  // the per-step savepoints that let the fixpoint retry them.
  await client.query('SET CONSTRAINTS ALL IMMEDIATE')

  // The route checks shared ownership before the transaction opens; a member
  // added in between would otherwise see their workspace go with the user.
  const shared = await client.query<{ n: number }>(
    `SELECT (SELECT count(*) FROM workspaces w
              WHERE w.owner_user_id = $1
                AND EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.user_id <> $1))
          + (SELECT count(*) FROM assistants a
              WHERE a.owner_user_id = $1
                AND EXISTS (SELECT 1 FROM assistant_members am WHERE am.assistant_id = a.id AND am.user_id <> $1)) AS n`,
    [userId],
  )
  if (Number(shared.rows[0]?.n ?? 0) > 0) {
    throw new AccountTeardownBlockedError([
      { step: 'ownership', error: 'the user owns a workspace or assistant with other members' },
    ])
  }

  // 1. Solo-owned workspaces. CASCADE children go with the workspace row;
  //    NO ACTION / RESTRICT children (rows that otherwise leave only through
  //    a grandchild cascade, e.g. file_segments, recordings) are emptied
  //    first so the workspace delete is not refused over them.
  const solo = await client.query<{ id: string }>(
    `SELECT w.id FROM workspaces w
      WHERE w.owner_user_id = $1
        AND NOT EXISTS (SELECT 1 FROM workspace_members wm
                         WHERE wm.workspace_id = w.id AND wm.user_id <> $1)`,
    [userId],
  )
  const soloIds = solo.rows.map((r) => r.id)
  if (soloIds.length > 0) {
    const wsChildren = await loadFks(client, ['a', 'r'], 'public.workspaces')
    await fixpoint(client, [
      ...wsChildren.map((fk) => ({
        name: `${fk.table}.${fk.column} (solo workspace)`,
        sql: `DELETE FROM ${fk.table} WHERE ${ident(fk.column)} = ANY($1::uuid[])`,
        values: [soloIds],
      })),
      { name: 'workspaces (solo-owned)', sql: `DELETE FROM workspaces WHERE id = ANY($1::uuid[])`, values: [soloIds] },
    ])
  }

  // 2. The footprint in other people's workspaces.
  const soloAssistantFilter = `owner_user_id = $1
       AND NOT EXISTS (SELECT 1 FROM assistant_members
                        WHERE assistant_id = assistants.id AND user_id <> $1)`
  const counted = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM assistants WHERE workspace_id IS NULL AND ${soloAssistantFilter}`,
    [userId],
  )
  const inbound = await loadFks(client, ['a', 'r'])
  const withUser = (s: Step): Step => ({ ...s, values: [userId] })
  const officeVisibility = ['office_artifacts', 'office_templates', 'office_artifact_sources']
  // Its own pass first: the user's owner rows may go only once every
  // department they own alone has a successor, or the last-owner guard
  // refuses (non-retryably) in a pass where the hand-on was deferred.
  await fixpoint(client, [
    // Departments (founder decision 2026-10-03). An owner's edge can go only
    // after their owner row, and an active department must keep an owner. A
    // department the user owns alone passes to an existing confidential
    // member (who already has that read); only if there is none does the
    // workspace owner take it. No workspace role silently substitutes for
    // department ownership: every handoff and removal bumps the revision and
    // writes a members-visible audit event, the same trail as break-glass.
    {
      name: 'department_owners (hand sole-owned departments on)',
      sql: `WITH sole AS (
              SELECT o.workspace_id, o.department_id, w.owner_user_id AS ws_owner
                FROM department_owners o
                JOIN workspaces w ON w.id = o.workspace_id
                JOIN workspace_groups g ON g.id = o.department_id AND g.kind = 'team' AND g.status = 'active'
               WHERE o.user_id = $1 AND w.owner_user_id <> $1
                 AND NOT EXISTS (SELECT 1 FROM department_owners x
                                  WHERE x.department_id = o.department_id AND x.user_id <> $1)),
            pick AS (
              SELECT s.*, m.user_id AS member_successor, coalesce(m.user_id, s.ws_owner) AS successor
                FROM sole s
                LEFT JOIN LATERAL (
                  SELECT e.user_id FROM department_edges e
                   WHERE e.department_id = s.department_id AND e.principal_kind = 'user'
                     AND e.user_id <> $1 AND e.clearance = 'confidential'
                     AND (e.expires_at IS NULL OR e.expires_at > now())
                     AND EXISTS (SELECT 1 FROM workspace_members wm
                                  WHERE wm.workspace_id = s.workspace_id AND wm.user_id = e.user_id)
                   ORDER BY e.created_at, e.user_id LIMIT 1) m ON true),
            added AS (
              INSERT INTO department_owners (workspace_id, department_id, user_id, added_by)
              SELECT workspace_id, department_id, successor, NULL FROM pick
              ON CONFLICT DO NOTHING RETURNING department_id),
            audited AS (
              INSERT INTO department_audit_events (workspace_id, department_id, actor_user_id, action, principal_kind, principal_id, reason)
              SELECT workspace_id, department_id, NULL, 'owner_added', 'user', successor,
                     CASE WHEN member_successor IS NOT NULL
                          THEN 'The only owner deleted their account; ownership passed to an existing confidential member.'
                          ELSE 'The only owner deleted their account and no confidential member remained; ownership passed to the workspace owner.'
                     END
                FROM pick RETURNING 1)
            SELECT department_bump(department_id) FROM pick`,
      values: [userId],
    },
  ])
  await fixpoint(client, [
    // A schedule runs as its author: pause before ownership moves.
    {
      name: 'workflows (pause authored)',
      sql: `UPDATE workflows SET enabled = false
             WHERE enabled AND (created_by = $1 OR schedule_authoring_user_id = $1)`,
      values: [userId],
    },
    // A pending decision can carry the user's private tool payload; it is
    // expired, never handed to someone else.
    {
      name: 'pending_approvals (expire pending)',
      sql: `UPDATE pending_approvals SET status = 'expired' WHERE approver_user_id = $1 AND status = 'pending'`,
      values: [userId],
    },
    // A knowledge source binds the clearance of whoever configured it; a
    // deleted user's binding is held, so it stops syncing on their authority.
    {
      name: 'workspace_knowledge_sources (hold binding)',
      sql: `UPDATE workspace_knowledge_sources SET binding_held = true
             WHERE configured_by_user_id = $1 AND NOT binding_held`,
      values: [userId],
    },
    // Rooms the user started stay for the team, owned by the workspace owner.
    {
      name: 'sessions (rooms to workspace owner)',
      sql: `UPDATE sessions t SET user_id = ${OWNER}
             WHERE t.user_id = $1 AND t.visibility = 'workspace' AND ${OWNER} IS NOT NULL AND ${OWNER} <> $1`,
      values: [userId],
    },
    // Tasks assigned to the user move to the owner. `assignee_id` names a
    // membership row, which goes below and would otherwise unassign them.
    {
      name: 'tasks.assignee_id (reassign to workspace owner)',
      sql: `UPDATE tasks t SET assignee_id = om.id
              FROM workspace_members lm
              JOIN workspaces w ON w.id = lm.workspace_id
              JOIN workspace_members om ON om.workspace_id = w.id AND om.user_id = w.owner_user_id
             WHERE t.assignee_id = lm.id AND lm.user_id = $1 AND w.owner_user_id <> $1`,
      values: [userId],
    },
    // Office rows restricted to the user alone are private. An empty list
    // means unrestricted, so the user is never just removed from a list of one.
    ...officeVisibility.flatMap((table) => [
      {
        name: `${table}.visibility_user_ids (delete private)`,
        sql: `DELETE FROM ${table} WHERE visibility_user_ids = ARRAY[$1::uuid]`,
        values: [userId],
      },
      {
        name: `${table}.visibility_user_ids (remove user)`,
        sql: `UPDATE ${table} SET visibility_user_ids = array_remove(visibility_user_ids, $1::uuid)
               WHERE $1::uuid = ANY(visibility_user_ids) AND cardinality(visibility_user_ids) > 1`,
        values: [userId],
      },
    ]),
    // Archived mail owned by the user is theirs (owner-only RLS key).
    {
      name: 'email_archive_messages (delete owned)',
      sql: `DELETE FROM email_archive_messages WHERE owner_user_id = $1`,
      values: [userId],
    },
    // Access the user requested goes with them: grants first (composite FK).
    {
      name: 'workspace_access_grants (delete requested)',
      sql: `DELETE FROM workspace_access_grants g USING workspace_access_requests r
             WHERE g.workspace_id = r.workspace_id AND g.request_id = r.id AND r.requester_user_id = $1`,
      values: [userId],
    },
    {
      name: 'department_owners (remove user)',
      sql: `WITH gone AS (
              DELETE FROM department_owners WHERE user_id = $1 RETURNING workspace_id, department_id),
            audited AS (
              INSERT INTO department_audit_events (workspace_id, department_id, actor_user_id, action, principal_kind, principal_id, reason)
              SELECT workspace_id, department_id, NULL, 'owner_removed', 'user', $1, 'The owner deleted their account.'
                FROM gone RETURNING 1)
            SELECT department_bump(department_id) FROM gone`,
      values: [userId],
    },
    // Credentials the user created stop working (founder decision
    // 2026-10-03): a deleted member keeps no access through a key.
    {
      name: 'api_keys (revoke created)',
      sql: `UPDATE api_keys SET status = 'revoked'
             WHERE status = 'active' AND (created_by = $1 OR issuer_user_id = $1)`,
      values: [userId],
    },
    {
      name: 'brain_keys (revoke created)',
      sql: `UPDATE brain_keys SET status = 'revoked'
             WHERE status = 'active' AND (created_by = $1 OR issuer_user_id = $1)`,
      values: [userId],
    },
    // Every sign-in session ends now, including any kept below.
    {
      name: 'auth_sessions (revoke)',
      sql: `UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
      values: [userId],
    },
    // The user's own rows in tables that name them without a foreign key.
    { name: 'deferred_confirmations (delete own)', sql: `DELETE FROM deferred_confirmations WHERE user_id = $1`, values: [userId] },
    { name: 'memories_shadow (delete own)', sql: `DELETE FROM memories_shadow WHERE user_id = $1`, values: [userId] },
    { name: 'doc_notifications (delete received)', sql: `DELETE FROM doc_notifications WHERE recipient_user_id = $1`, values: [userId] },
    // Chat routes bound through the user's linked identities.
    {
      name: 'channel_routes (linked identities)',
      sql: `DELETE FROM channel_routes cr USING linked_identities li
             WHERE cr.provider = li.provider AND cr.provider_id = li.provider_id AND li.user_id = $1`,
      values: [userId],
    },
    // An assistant the user owns in someone else's workspace anchors shared
    // brain rows scoped to it (visibility needs user_id OR assistant_id), so
    // it moves to the workspace owner like the rest of the user's ownership.
    // Its private sessions and memories with the user still go (cascade).
    {
      name: 'assistant_members (workspace owner joins transferred assistants)',
      sql: `INSERT INTO assistant_members (assistant_id, user_id, role)
            SELECT t.id, ${OWNER}, 'owner' FROM assistants t
             WHERE t.owner_user_id = $1 AND ${OWNER} IS NOT NULL AND ${OWNER} <> $1
            ON CONFLICT DO NOTHING`,
      values: [userId],
    },
    {
      name: 'assistants (transfer to workspace owner)',
      sql: `UPDATE assistants t SET owner_user_id = ${OWNER}
             WHERE t.owner_user_id = $1 AND ${OWNER} IS NOT NULL AND ${OWNER} <> $1`,
      values: [userId],
    },
    // One owned outside any workspace has no one to move to.
    { name: 'assistants (solo-owned, no workspace)', sql: `DELETE FROM assistants WHERE workspace_id IS NULL AND ${soloAssistantFilter}`, values: [userId] },
    ...userRefs.flatMap((fk) => ruleSteps(fk, rules[ruleKey(fk)]!, inbound)).map(withUser),
  ])

  // 3. What the schema cascades with the user is the user's: delete it
  //    explicitly (it must go whether the row is deleted or tombstoned),
  //    except the rooms moved above.
  const cascades = (await loadFks(client, ['c'], 'public.users'))
    .filter((fk) => fk.targetKey === 'id' && ruleKey(fk) !== 'workspaces.owner_user_id')
  await fixpoint(client, cascades.map((fk) => {
    const keepWhere = CASCADE_KEEP[ruleKey(fk)]
    return {
      name: `${ruleKey(fk)} (cascade)`,
      sql: `DELETE FROM ${fk.table} t WHERE t.${ident(fk.column)} = $1${keepWhere ? ` AND NOT (${keepWhere})` : ''}`,
      values: [userId],
    }
  }))

  // 4. Delete the row only if nothing kept above still names it (the
  //    database would cascade it away); otherwise, or if anything refuses,
  //    tombstone it.
  let keptLeft = 0
  for (const fk of cascades.filter((c) => CASCADE_KEEP[ruleKey(c)])) {
    keptLeft += Number((await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${fk.table} t WHERE t.${ident(fk.column)} = $1`, [userId],
    )).rows[0]?.n ?? 0)
  }
  let mode: AccountTeardownResult['mode'] = 'tombstoned'
  if (keptLeft === 0) {
    await client.query('SAVEPOINT account_teardown_delete')
    try {
      await client.query(`DELETE FROM users WHERE id = $1`, [userId])
      await client.query('RELEASE SAVEPOINT account_teardown_delete')
      mode = 'deleted'
    } catch (err) {
      // Expected when a kept record still names the user; logged so a new
      // reason shows up instead of silently tombstoning.
      console.warn(`[account-delete] tombstoning ${userId}: ${(err as Error).message}`)
      await client.query('ROLLBACK TO SAVEPOINT account_teardown_delete')
      await client.query('RELEASE SAVEPOINT account_teardown_delete')
    }
  }
  if (mode === 'tombstoned') {
    await client.query(
      `UPDATE users
          SET email = NULL, name = $2, handle = NULL, entity_id = NULL,
              avatar_url = NULL, avatar_source = NULL, avatar_storage_key = NULL,
              avatar_storage_workspace_id = NULL, avatar_storage_uri = NULL,
              stripe_customer_id = NULL, timezone = NULL, last_seen_tz = NULL, last_seen_tz_at = NULL,
              tz_nudge_suppressed_until = NULL, dismissed_nudges = '{}'::jsonb,
              auth_provider = 'deleted', auth_provider_id = 'deleted:' || id::text,
              auth_version = auth_version + 1, analytics_opt_out = true,
              deleted_at = now(), updated_at = now()
        WHERE id = $1`,
      [userId, DELETED_USER_NAME],
    )
  }
  await client.query(`DELETE FROM account_erasures WHERE txid = pg_current_xact_id()::text`)
  return { mode, workspacesDeleted: soloIds.length, assistantsDeleted: Number(counted.rows[0]?.n ?? 0) }
}
