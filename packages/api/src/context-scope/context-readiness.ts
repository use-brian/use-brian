/**
 * Runtime activation proof for strict Team/Project contexts.
 *
 * Build-time path coverage is represented by a versioned manifest whose
 * entries are guarded by the context-scope invariant and security-matrix
 * suites. Database-dependent rows are probed live so a partially migrated
 * deployment cannot activate a scope merely because its server binary is new.
 * Legacy Workspace General counts are informational and never block.
 *
 * [COMP:api/context-scope-routes]
 */

import { query } from '../db/client.js'

export const CONTEXT_SCOPE_ENFORCEMENT_VERSION = 1

export const CONTEXT_SCOPE_CODE_CAPABILITIES = Object.freeze({
  turn_entry_points: true,
  write_inheritance: true,
  connectors: true,
  background_lanes: true,
} as const)

export type ContextReadinessCheckId =
  | 'row_store_coverage'
  | 'turn_entry_points'
  | 'write_inheritance'
  | 'session_isolation'
  | 'teamspace_agent_access'
  | 'connectors'
  | 'ingest'
  | 'background_lanes'
  | 'legacy_data'

export type ContextReadinessCheck = {
  id: ContextReadinessCheckId
  ready: boolean
  blocking: boolean
  detail: string
  missing?: string[]
}

export type ContextReadiness = {
  enforcementVersion: number
  readyForActivation: boolean
  checks: ContextReadinessCheck[]
  legacyGeneral: Record<string, number>
}

export type ReadinessQuery = <T extends Record<string, unknown>>(
  text: string,
  values?: unknown[],
) => Promise<{ rows: T[] }>

const REQUIRED_SCOPE_COLUMNS = [
  ['memories', 'project_ids'],
  ['tasks', 'project_ids'],
  ['workspace_files', 'project_ids'],
  ['entities', 'project_ids'],
  ['entity_links', 'project_ids'],
  ['episodes', 'project_ids'],
  ['file_cache', 'project_ids'],
  ['knowledge_entries', 'project_ids'],
  ['kb_chunks', 'project_ids'],
  ['file_segments', 'project_ids'],
  ['transcript_segments', 'project_ids'],
  ['recordings', 'project_ids'],
  ['entity_instances', 'project_ids'],
  ['blueprint_records', 'project_ids'],
  ['office_artifacts', 'project_ids'],
  ['sessions', 'context_group_id'],
  ['sessions', 'context_project_id'],
  ['brain_keys', 'context_group_id'],
  ['brain_keys', 'context_project_id'],
  ['connector_instance', 'project_ids'],
  ['connector_grant', 'project_ids'],
  ['ingest_rules', 'project_ids'],
  ['pending_ingest_batches', 'project_ids'],
] as const

const REQUIRED_TRIGGERS = {
  session_isolation: [
    'sessions_context_binding_valid',
    'sessions_context_immutable_after_lock',
    'session_messages_lock_context',
  ],
  teamspace_agent_access: [
    'teamspaces_context_group_valid',
    'teamspace_members_linked_roster_immutable',
  ],
  ingest: [
    'episodes_context_ingest_inherit',
    'pending_ingest_batches_context_scope_valid',
  ],
  write_inheritance: [
    'file_cache_context_scope_inherit',
    'recordings_context_scope_inherit',
    'transcript_segments_context_scope_inherit',
    'file_segments_context_scope_inherit',
  ],
} as const

const LEGACY_GENERAL_TABLES = [
  'memories',
  'tasks',
  'workspace_files',
  'entities',
  'entity_links',
  'episodes',
  'knowledge_entries',
  'recordings',
  'entity_instances',
  'blueprint_records',
  'office_artifacts',
] as const

function check(
  id: ContextReadinessCheckId,
  ready: boolean,
  detail: string,
  missing?: string[],
): ContextReadinessCheck {
  return {
    id,
    ready,
    blocking: id !== 'legacy_data',
    detail,
    ...(missing && missing.length > 0 ? { missing } : {}),
  }
}

async function schemaEvidence(queryFn: ReadinessQuery): Promise<{
  missingColumns: string[]
  triggerNames: Set<string>
}> {
  const columns = await queryFn<{ tableName: string; columnName: string }>(
    `SELECT table_name AS "tableName", column_name AS "columnName"
       FROM information_schema.columns
      WHERE table_schema = 'public'`,
  )
  const presentColumns = new Set(
    columns.rows.map((row) => `${row.tableName}.${row.columnName}`),
  )
  const missingColumns = REQUIRED_SCOPE_COLUMNS
    .map(([table, column]) => `${table}.${column}`)
    .filter((column) => !presentColumns.has(column))

  const triggers = await queryFn<{ name: string }>(
    `SELECT tgname AS name
       FROM pg_trigger
      WHERE NOT tgisinternal`,
  )
  return {
    missingColumns,
    triggerNames: new Set(triggers.rows.map((row) => row.name)),
  }
}

async function legacyInventory(
  workspaceId: string,
  queryFn: ReadinessQuery,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const table of LEGACY_GENERAL_TABLES) {
    const result = await queryFn<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM ${table}
        WHERE workspace_id = $1
          AND cardinality(compartments) = 0
          AND cardinality(project_ids) = 0`,
      [workspaceId],
    )
    counts[table] = Number(result.rows[0]?.count ?? '0')
  }
  return counts
}

function missingTriggers(
  evidence: Set<string>,
  names: readonly string[],
): string[] {
  return names.filter((name) => !evidence.has(name))
}

export async function getContextReadinessSystem(
  workspaceId: string,
  queryFn: ReadinessQuery = query,
): Promise<ContextReadiness> {
  const [{ missingColumns, triggerNames }, legacyGeneral] = await Promise.all([
    schemaEvidence(queryFn),
    legacyInventory(workspaceId, queryFn),
  ])
  const sessionMissing = missingTriggers(
    triggerNames,
    REQUIRED_TRIGGERS.session_isolation,
  )
  const teamspaceMissing = missingTriggers(
    triggerNames,
    REQUIRED_TRIGGERS.teamspace_agent_access,
  )
  const ingestMissing = missingTriggers(triggerNames, REQUIRED_TRIGGERS.ingest)
  const inheritanceMissing = missingTriggers(
    triggerNames,
    REQUIRED_TRIGGERS.write_inheritance,
  )

  const checks: ContextReadinessCheck[] = [
    check(
      'row_store_coverage',
      missingColumns.length === 0,
      missingColumns.length === 0
        ? 'Every scoped row family carries Team and Project requirements.'
        : 'One or more scoped row families are not migrated.',
      missingColumns,
    ),
    check(
      'turn_entry_points',
      CONTEXT_SCOPE_CODE_CAPABILITIES.turn_entry_points,
      'The versioned execution-entrypoint manifest is covered by the invariant suite.',
    ),
    check(
      'write_inheritance',
      CONTEXT_SCOPE_CODE_CAPABILITIES.write_inheritance
        && inheritanceMissing.length === 0,
      inheritanceMissing.length === 0
        ? 'Successor writers and database-derived rows preserve scope.'
        : 'One or more database inheritance guards are missing.',
      inheritanceMissing,
    ),
    check(
      'session_isolation',
      sessionMissing.length === 0,
      sessionMissing.length === 0
        ? 'Session bindings are validated and lock on the first message.'
        : 'One or more session isolation guards are missing.',
      sessionMissing,
    ),
    check(
      'teamspace_agent_access',
      teamspaceMissing.length === 0,
      teamspaceMissing.length === 0
        ? 'Linked Teamspaces derive membership and reject direct roster mutation.'
        : 'One or more linked Teamspace guards are missing.',
      teamspaceMissing,
    ),
    check(
      'connectors',
      CONTEXT_SCOPE_CODE_CAPABILITIES.connectors
        && missingColumns.every((column) => !column.startsWith('connector_')),
      'Connector exposure is scope-gated; unbound private connectors are withheld.',
    ),
    check(
      'ingest',
      ingestMissing.length === 0,
      ingestMissing.length === 0
        ? 'Ingest rules and batches stamp their immutable Team/Project scope.'
        : 'One or more ingest scope guards are missing.',
      ingestMissing,
    ),
    check(
      'background_lanes',
      CONTEXT_SCOPE_CODE_CAPABILITIES.background_lanes
        && inheritanceMissing.length === 0,
      'Compaction, consolidation, chunking, synthesis, and jobs preserve root scope.',
      inheritanceMissing,
    ),
    check(
      'legacy_data',
      true,
      'Workspace General rows are informational and remain reviewable.',
    ),
  ]

  return {
    enforcementVersion: CONTEXT_SCOPE_ENFORCEMENT_VERSION,
    readyForActivation: checks
      .filter((item) => item.blocking)
      .every((item) => item.ready),
    checks,
    legacyGeneral,
  }
}

export class ContextActivationBlockedError extends Error {
  readonly code = 'context_activation_blocked'

  constructor(readonly failedChecks: ContextReadinessCheckId[]) {
    super(`Strict context activation is blocked by: ${failedChecks.join(', ')}`)
    this.name = 'ContextActivationBlockedError'
  }
}

export async function assertContextActivationReady(
  workspaceId: string,
  readiness?: (
    workspaceId: string,
  ) => Promise<ContextReadiness>,
): Promise<ContextReadiness> {
  const result = await (readiness ?? getContextReadinessSystem)(workspaceId)
  if (!result.readyForActivation) {
    throw new ContextActivationBlockedError(
      result.checks
        .filter((item) => item.blocking && !item.ready)
        .map((item) => item.id),
    )
  }
  return result
}
