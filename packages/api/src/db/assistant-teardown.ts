/**
 * The in-transaction half of `DELETE /api/assistants/:assistantId`.
 *
 * The caller owns BEGIN/COMMIT and the route guards (owner only, never the
 * primary, no other members). Founder decision (2026-10-09): brain rows
 * anchored on a deleted assistant move to the workspace's primary assistant.
 * `assistant_id` on those rows is not a member visibility key
 * (`department_row_allows` reads workspace, sensitivity, compartments and
 * `user_id`); it only narrows which agent runs read them
 * (`agent_visibility_allows`). Re-anchoring keeps what the team captured,
 * leaves what members see unchanged, and lets the primary's runs read the
 * rows under its own clearance. Cascading them away would delete records
 * members can see.
 *
 * Every NO ACTION / RESTRICT foreign key to `assistants` follows an explicit
 * rule (`ASSISTANT_TEARDOWN_RULES`):
 *   - `reassign` the row is the workspace's: it moves to the primary;
 *   - `clear`    a recorded author: the pointer becomes NULL, never credited
 *                to the primary;
 *   - `delete`   the assistant's own record that cannot be re-pointed
 *                (immutable evidence frozen with its scope, its action log).
 * An unclassified column FAILS CLOSED before anything is touched. Everything
 * the schema declares ON DELETE CASCADE / SET NULL goes with the assistant
 * row (its sessions, memories, grants, channels).
 *
 * Steps run through the account teardown's fixpoint: Postgres fires NO ACTION
 * checks and cascades as separate referential triggers, so a statement can be
 * refused by a row its own cascade was about to remove.
 */

import { fixpoint, ident, loadFks, ruleKey, type Step, type TeardownClient } from './account-teardown.js'

export class AssistantTeardownBlockedError extends Error {
  readonly code = 'assistant_delete_blocked'
  constructor(readonly blockers: Array<{ step: string; error: string }>) {
    super(`Assistant delete blocked by: ${blockers.map((b) => b.step).join(', ')}`)
  }
}

/**
 * What happens to rows of `table.column` that name the deleted assistant.
 * `deleteWhere` (SQL over alias `t`, `$1` = the assistant) selects rows that
 * are deleted instead; the default action never touches them.
 */
export interface AssistantTeardownRule {
  action: 'reassign' | 'clear' | 'delete'
  deleteWhere?: string
}

const toPrimary: AssistantTeardownRule = { action: 'reassign' }
const clear: AssistantTeardownRule = { action: 'clear' }
const del: AssistantTeardownRule = { action: 'delete' }

/** Open-schema rules. The hosted overlay adds its own through the boot port. */
export const ASSISTANT_TEARDOWN_RULES: Readonly<Record<string, AssistantTeardownRule>> = {
  // Brain rows anchored on the assistant: the workspace's, moved to the primary.
  'entities.assistant_id': toPrimary,
  'entity_links.assistant_id': toPrimary,
  'episodes.assistant_id': toPrimary,
  'kb_chunks.assistant_id': toPrimary,
  'tasks.assistant_id': toPrimary,
  'workspace_files.assistant_id': toPrimary,
  // Messages in the assistant's own sessions go with them (sessions cascade);
  // one it left in another session (a room) stays with that session.
  'session_messages.assistant_id': {
    action: 'reassign',
    deleteWhere: 'EXISTS (SELECT 1 FROM sessions s WHERE s.id = t.session_id AND s.assistant_id = $1)',
  },

  // Recorded authors.
  'entities.created_by_assistant_id': clear,
  'episodes.created_by_assistant_id': clear,
  'kb_chunks.created_by_assistant_id': clear,
  'memories.created_by_assistant_id': clear,
  'tasks.created_by_assistant_id': clear,

  // Evidence frozen with the assistant's scope refuses updates. Deleting an
  // extraction run leaves the episode and what it produced; deleting a past
  // scope revision holds its descendants for review. A skill whose CURRENT
  // revision names the assistant is refused up front (see below).
  'episode_extraction_runs.assistant_id': del,
  'episode_extraction_runs.created_by_assistant_id': del,
  'scope_derivations.assistant_id': del,
  'workspace_skill_scope_revisions.assistant_id': del,
}

/**
 * Deletes the assistant and resolves everything that names it. `extraRules`
 * lets an edition that adds tables (the hosted overlay) classify its own
 * columns; it cannot override an open rule.
 */
export async function deleteAssistantFootprint(
  client: TeardownClient,
  assistantId: string,
  actorUserId: string,
  extraRules: Readonly<Record<string, AssistantTeardownRule>> = {},
): Promise<{ deleted: boolean; primaryAssistantId: string | null }> {
  const blocked = (b: Array<{ step: string; error: string }>) => new AssistantTeardownBlockedError(b)

  const current = await client.query<{ workspace_id: string | null; kind: string }>(
    `SELECT workspace_id, kind FROM assistants WHERE id = $1 FOR UPDATE`, [assistantId],
  )
  const assistant = current.rows[0]
  if (!assistant) return { deleted: false, primaryAssistantId: null }
  if (assistant.kind === 'primary') {
    throw blocked([{ step: 'primary', error: 'the primary assistant goes only with its workspace' }])
  }

  const rules: Record<string, AssistantTeardownRule> = { ...extraRules, ...ASSISTANT_TEARDOWN_RULES }
  const refs = (await loadFks(client, ['a', 'r'], 'public.assistants')).filter((fk) => fk.targetKey === 'id')

  // Fail closed before touching anything.
  const problems: Array<{ step: string; error: string }> = []
  for (const fk of refs) {
    const rule = rules[ruleKey(fk)]
    if (!rule) problems.push({ step: ruleKey(fk), error: 'no assistant teardown rule' })
    else if (rule.action === 'reassign' && !fk.hasWorkspace) {
      problems.push({ step: ruleKey(fk), error: 'reassign rule on a table without workspace_id' })
    } else if (rule.action === 'clear' && fk.notNull) {
      problems.push({ step: ruleKey(fk), error: 'clear rule on a NOT NULL column' })
    }
  }
  if (problems.length > 0) throw blocked(problems)

  // FORCE-RLS evidence tables (workspace_skill_scope_revisions) admit writes
  // only under the system bypass, even from the owner role; the actor is who
  // their triggers record. Transaction-local: both revert at COMMIT/ROLLBACK.
  await client.query(
    `SELECT set_config('app.system_bypass', 'true', true), set_config('app.current_user_id', $1, true)`,
    [actorUserId],
  )

  // A skill learned from the assistant's conversations carries its scope in
  // the CURRENT revision. Re-scoping it needs new derivation evidence, so the
  // delete names the skills instead of unscoping them.
  const skills = await client.query<{ name: string }>(
    `SELECT s.name FROM workspace_skills s
       JOIN workspace_skill_scope_revisions sr ON sr.id = s.scope_revision_id
      WHERE sr.assistant_id = $1 ORDER BY s.name`,
    [assistantId],
  )
  if (skills.rows.length > 0) {
    throw blocked([{ step: 'workspace_skills', error: skills.rows.map((r) => r.name).join(', ') }])
  }

  const primary = assistant.workspace_id
    ? (await client.query<{ id: string }>(
        `SELECT id FROM assistants WHERE workspace_id = $1 AND kind = 'primary' AND id <> $2 LIMIT 1`,
        [assistant.workspace_id, assistantId],
      )).rows[0]?.id ?? null
    : null

  const reassigned = refs.filter((fk) => rules[ruleKey(fk)]!.action === 'reassign')
  if (!primary) {
    // Nothing to move them to. Refuse only if there is something to move.
    for (const fk of reassigned) {
      const n = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${fk.table} t WHERE t.${ident(fk.column)} = $1`, [assistantId],
      )
      if (Number(n.rows[0]?.n ?? 0) > 0) {
        throw blocked([{ step: ruleKey(fk), error: 'no primary assistant in the workspace to receive the rows' }])
      }
    }
  }

  // Deferred foreign keys would otherwise surface only at COMMIT, outside
  // the per-step savepoints that let the fixpoint retry them.
  await client.query('SET CONSTRAINTS ALL IMMEDIATE')

  const steps: Step[] = []
  for (const fk of refs) {
    const rule = rules[ruleKey(fk)]!
    const name = ruleKey(fk)
    const col = ident(fk.column)
    const mine = `t.${col} = $1`
    if (rule.deleteWhere) {
      steps.push({
        name: `${name} (delete)`,
        sql: `DELETE FROM ${fk.table} t WHERE ${mine} AND (${rule.deleteWhere})`,
        values: [assistantId],
      })
    }
    // The default action never reaches a deleteWhere row, even if its delete
    // was refused this pass.
    const rest = rule.deleteWhere ? `${mine} AND NOT (${rule.deleteWhere})` : mine
    if (rule.action === 'delete') {
      steps.push({ name: `${name} (delete)`, sql: `DELETE FROM ${fk.table} t WHERE ${rest}`, values: [assistantId] })
    } else if (rule.action === 'clear') {
      steps.push({ name: `${name} (clear)`, sql: `UPDATE ${fk.table} t SET ${col} = NULL WHERE ${rest}`, values: [assistantId] })
    } else if (primary) {
      // Only within the assistant's own workspace; a row elsewhere stays and
      // blocks the delete below.
      steps.push({
        name: `${name} (reassign to primary)`,
        sql: `UPDATE ${fk.table} t SET ${col} = $2 WHERE ${rest} AND t.workspace_id = $3`,
        values: [assistantId, primary, assistant.workspace_id],
      })
    }
  }
  steps.push({ name: 'assistants', sql: `DELETE FROM assistants WHERE id = $1`, values: [assistantId] })

  await fixpoint(client, steps, blocked)
  return { deleted: true, primaryAssistantId: primary }
}
