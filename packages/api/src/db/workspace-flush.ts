/**
 * Workspace data flush — delete everything the workspace's brain holds while
 * preserving the shell (workspace, members, assistants, connectors, channels,
 * settings, billing, audit).
 *
 * This is the self-serve "start over" primitive. Workspace *deletion* covers
 * non-personal workspaces, but the auto-created Personal workspace is never
 * deletable (`workspace-store.ts` → `delete`), so before this module existed a
 * personal-workspace user had NO way to clear their accumulated brain data —
 * `DELETE /api/account/memories` covers only `memories` + `user_souls`, leaving
 * tasks, workflows, pages, episodes, entities, goals, files untouched.
 *
 * Charter (spec: docs/architecture/platform/workspaces.md → "Workspace data
 * flush"):
 *   - FLUSH everything the brain learned or produced: conversations, the
 *     memory graph, brain records, content artifacts, automation and its
 *     outputs, scheduled work.
 *   - PRESERVE identity & access (members, invitations, compartments),
 *     assistants + their configuration, connectors & channels, policies /
 *     settings / templates, billing & usage records, and audit surfaces
 *     (metadata-only).
 *
 * Every table with a `workspace_id` column MUST be classified into exactly one
 * of the two lists below — the completeness check in
 * `__tests__/workspace-flush.integration.test.ts` diffs the lists against
 * `information_schema` so a new migration cannot silently leave a table
 * unclassified (the drift class that made delete-memories "not clear all brain
 * entries" in the first place).
 *
 * Deletes run on the SYSTEM pool inside one transaction: the flush removes
 * rows authored by every member, which per-user RLS would (correctly) refuse.
 * Authorization is the owner check at the top of the transaction plus the
 * `owner`-role gate on the route.
 *
 * Known deferral: object-storage binaries (recordings / file blobs living
 * outside the DB) follow the account-delete precedent — DB rows are the source
 * of truth and blob cleanup is owed separately (see privacy-controls.md).
 *
 * [COMP:api/workspace-flush]
 */

import { getPool } from './client.js'
import { notifyWorkspaceChange } from '../brain-stream/notify.js'

/**
 * Content tables deleted by `workspace_id`, in FK-safe order:
 *   - `saved_views` cascades the whole page tree (documents, page_grants,
 *     page_actions, page_domains, page_slugs, page comment_threads,
 *     doc_notifications).
 *   - `workflows` cascades workflow_runs → workflow_step_runs.
 *   - `transcript_segments` precedes `workspace_files` / `recordings`
 *     (NO ACTION FK).
 *   - `entities` / `entity_links` precede `episodes` (NO ACTION FKs), and
 *     `connector_actions.episode_id` is nulled first (see flushWorkspaceData).
 */
export const WORKSPACE_FLUSH_TABLES = [
  // Automation + approvals
  'pending_approvals',
  'workflows',
  'workflow_runs', // cascade-covered by `workflows`; kept explicit for the classifier
  'sandbox_tasks',
  'browser_sessions',
  // Pages + docs (saved_views cascades the page tree)
  'saved_views',
  'workspace_decks',
  'blueprint_records',
  'entity_instances',
  'comment_threads',
  'doc_notifications',
  'page_actions', // cascade-covered by `saved_views`; kept explicit for the classifier
  'page_send_log',
  'page_domains',
  // Files + media
  'transcript_segments',
  'recording_jobs',
  'recordings',
  'file_segments',
  'file_ingest_jobs',
  'file_cache',
  'workspace_files',
  // Ingest pipeline state
  'pending_ingest_batches',
  'extraction_outbox',
  'pending_classifications',
  // Memory graph derived surfaces (before their parents)
  'sensitivity_reclassifications',
  'memory_verifications',
  'memory_recall_events',
  'retrieval_miss',
  'brain_candidates',
  'brain_verifications',
  // Brain graph — entities/links/connector_actions before episodes (NO ACTION
  // FKs; connector_actions.episode_id is NOT NULL, so the audit rows are
  // hard-bound to their episodes and must go with them)
  'entity_links',
  'entity_merges',
  'entities',
  'memories',
  'consolidation_logs',
  'connector_actions',
  'episodes',
  // Tasks + goals
  'tasks',
  'goals',
  'goal_recipes',
  // Knowledge
  'kb_chunks',
  'kb_gap_candidate',
  'knowledge_entries',
  // Evolution logs (describe the data being deleted)
  'workspace_brain_evolution',
  'workspace_memory_evolution',
  // Conversations — deleted via a special OR-assistant statement (see
  // flushWorkspaceData), listed here for classification completeness.
  'sessions',
] as const

/**
 * Content tables with no `workspace_id` column, scoped by the workspace's
 * assistant ids (`assistant_id = ANY(...)` unless noted). Session-cascaded
 * tables (session_messages, session_state, episodic_memories, plan_steps,
 * tool_result_cache, ...) need no entry — the `sessions` delete takes them.
 */
export const ASSISTANT_SCOPED_FLUSH_TABLES = [
  'scheduled_jobs',
  'domain_summaries',
  'sharing_snapshots',
  'external_entities',
  'deferred_confirmations',
  'distribution_events',
  'episodic_memories',
  'assistant_pending_messages', // target_assistant_id / source_assistant_id
] as const

/**
 * Tables with a `workspace_id` column the flush deliberately PRESERVES.
 * Structure, configuration, capabilities, billing, and audit — the shell the
 * user keeps. (`connector_actions` is NOT here: its `episode_id` is NOT NULL
 * with a NO ACTION FK, so those audit rows are structurally inseparable from
 * the episodes being flushed.)
 */
export const WORKSPACE_FLUSH_PRESERVED_TABLES = [
  // Structure + access
  'assistants',
  'workspace_members',
  'workspace_invitations',
  'workspace_groups',
  'workspace_compartments',
  'member_compartment_grants',
  'teamspaces',
  'brain_keys',
  // Channels + connectors
  'channels',
  'channel_sensitivity_rules',
  'whatsapp_group_bindings',
  'email_domains',
  'connector_instance',
  'oauth_authorizations',
  // Settings + config + authored structure
  'workspace_tool_policy',
  'workspace_memory_sharing',
  'workspace_knowledge_sources',
  'workspace_page_templates',
  'entity_types',
  'doc_themes',
  'home_dock_layouts',
  'model_routing_config',
  'classifier_rule_supersede_counters',
  // Capabilities
  'workspace_skills',
  'browser_skills',
  'browser_skill_grants',
  'browser_profiles',
  'skill_curator_digest',
  // Billing + usage
  'metered_model_profiles',
  'metered_model_surcharges',
  'daily_usage',
  'usage_tracking',
  'usage_sessions',
  'bulk_ingest_surcharges',
  'recording_surcharges',
  'synthesis_surcharges',
  'extra_usage_purchases',
  'promo_code_redemptions',
  // Audit + ops telemetry
  'workspace_audit_log',
  'correction_audit',
  'worker_runs',
] as const

export class WorkspaceFlushNotOwnerError extends Error {
  constructor() {
    super('Only the workspace owner can flush workspace data')
    this.name = 'WorkspaceFlushNotOwnerError'
  }
}

export type WorkspaceFlushResult = {
  /** Rows deleted per table (top-level statements only — cascades not counted). */
  deleted: Record<string, number>
  /** Sum of `deleted` values. */
  total: number
}

export async function flushWorkspaceData(
  userId: string,
  workspaceId: string,
): Promise<WorkspaceFlushResult> {
  const client = await getPool().connect()
  const deleted: Record<string, number> = {}
  try {
    await client.query('BEGIN')

    // Owner check + row lock: serializes concurrent flushes and pins the
    // authorization to this transaction (an ownership transfer committed after
    // this point can't race the deletes).
    const owner = await client.query(
      `SELECT 1 FROM workspaces WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
      [workspaceId, userId],
    )
    if (owner.rowCount === 0) {
      throw new WorkspaceFlushNotOwnerError()
    }

    const assistants = await client.query<{ id: string }>(
      `SELECT id FROM assistants WHERE workspace_id = $1`,
      [workspaceId],
    )
    const assistantIds = assistants.rows.map((r) => r.id)

    for (const table of WORKSPACE_FLUSH_TABLES) {
      const result =
        table === 'sessions'
          ? // Sessions ride the assistant, not the workspace (workspace_id is
            // often NULL on personal-assistant sessions) — match both.
            await client.query(
              `DELETE FROM sessions WHERE workspace_id = $1 OR assistant_id = ANY($2::uuid[])`,
              [workspaceId, assistantIds],
            )
          : await client.query(`DELETE FROM ${table} WHERE workspace_id = $1`, [workspaceId])
      deleted[table] = result.rowCount ?? 0
    }

    for (const table of ASSISTANT_SCOPED_FLUSH_TABLES) {
      if (assistantIds.length === 0) {
        deleted[table] = 0
        continue
      }
      const result =
        table === 'assistant_pending_messages'
          ? await client.query(
              `DELETE FROM assistant_pending_messages
                WHERE target_assistant_id = ANY($1::uuid[])
                   OR source_assistant_id = ANY($1::uuid[])`,
              [assistantIds],
            )
          : await client.query(`DELETE FROM ${table} WHERE assistant_id = ANY($1::uuid[])`, [
              assistantIds,
            ])
      deleted[table] = result.rowCount ?? 0
    }

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }

  // Open brain/workflow surfaces re-fetch on this bus; a flush changes
  // effectively everything, so fan out one delete per broad primitive kind.
  for (const primitive of ['memory', 'task', 'entity', 'file', 'workflow'] as const) {
    notifyWorkspaceChange(workspaceId, primitive, 'delete', workspaceId)
  }

  const total = Object.values(deleted).reduce((a, b) => a + b, 0)
  return { deleted, total }
}
