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
import { getScopeReviewCoverage, SCOPE_REVIEW_REGISTRY_REVISION } from '../workspace-access/scope-review-registry.js'
import {
  DEPARTMENT_ISOLATION_REQUIRED_CAPABILITIES,
  departmentIsolationManifestCoverage,
} from '@use-brian/shared'

export const CONTEXT_SCOPE_ENFORCEMENT_VERSION = 2

const COMPILED_MANIFEST_COVERAGE = departmentIsolationManifestCoverage()
const manifestCapability = (id: string) => COMPILED_MANIFEST_COVERAGE.complete
  && DEPARTMENT_ISOLATION_REQUIRED_CAPABILITIES.includes(id as typeof DEPARTMENT_ISOLATION_REQUIRED_CAPABILITIES[number])

export const CONTEXT_SCOPE_CODE_CAPABILITIES = Object.freeze({
  turn_entry_points: manifestCapability('turn_entry_points'),
  write_inheritance: manifestCapability('write_inheritance'),
  connectors: manifestCapability('connectors'),
  background_lanes: manifestCapability('background_lanes'),
  derived_writes: manifestCapability('derived_writes'),
  delegation: manifestCapability('delegation'),
  operation_separation: manifestCapability('operation_separation'),
  replay_delivery: manifestCapability('replay_delivery'),
  grant_expiry: manifestCapability('grant_expiry'),
  org_references: manifestCapability('org_references'),
  scope_review: manifestCapability('scope_review'),
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
  | 'derived_writes'
  | 'delegation'
  | 'operation_separation'
  | 'replay_delivery'
  | 'grant_expiry'
  | 'org_references'
  | 'scope_review'

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
  ['assistants','context_binding_origin'],
  ['sessions','context_binding_origin'],
  ['brain_keys','context_binding_origin'],
  ['connector_instance','context_binding_origin'],
  ['connector_grant','context_binding_origin'],
  ['ingest_rules','scope_binding_origin'],
  ['ingest_rules','scope_binding_mode'],
  ['pending_ingest_batches','scope_binding_origin'],
  ['pending_ingest_batches','scope_held'],
  ['workspace_scope_review_items','content_snapshot'],
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

const REQUIRED_FUNCTIONS = {
  derived_writes: ['advance_canonical_scope_version','hold_scope_descendants'],
  delegation: ['agent_read_scope_allows','agent_mutation_scope_allows'],
  operation_separation: ['member_operation_scope_allows'],
  grant_expiry: ['effective_member_read_compartments'],
  org_references: ['validate_workspace_organization'],
  scope_review: ['read_scope_review_source','scope_review_registry_revision'],
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
  functionNames: Set<string>
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
  const functions = await queryFn<{ name: string }>(
    `SELECT proname AS name
       FROM pg_proc
       JOIN pg_namespace ON pg_namespace.oid=pg_proc.pronamespace
      WHERE pg_namespace.nspname='public'`,
  )
  return {
    missingColumns,
    triggerNames: new Set(triggers.rows.map((row) => row.name)),
    functionNames: new Set(functions.rows.map((row) => row.name)),
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
  const [{ missingColumns, triggerNames, functionNames }, legacyGeneral] = await Promise.all([
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
  const functionMissing=(id:keyof typeof REQUIRED_FUNCTIONS)=>missingTriggers(functionNames,REQUIRED_FUNCTIONS[id])
  const coverage=missingColumns.length===0
    ? await getScopeReviewCoverage({query:queryFn},workspaceId)
    : {registryRevision:String(SCOPE_REVIEW_REGISTRY_REVISION),unresolved:'1',families:[]}
  const reviewedInventoryRevision=missingColumns.length===0
    ? (await queryFn<{revision:string|null}>('SELECT reviewed_inventory_revision::text AS revision FROM workspace_access_policies WHERE workspace_id=$1',[workspaceId])).rows[0]?.revision??null
    : null

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
      'derived_writes',
      CONTEXT_SCOPE_CODE_CAPABILITIES.derived_writes&&functionMissing('derived_writes').length===0,
      'Canonical derived writers retain complete source evidence and current source versions.',
      functionMissing('derived_writes'),
    ),
    check(
      'delegation',
      CONTEXT_SCOPE_CODE_CAPABILITIES.delegation&&functionMissing('delegation').length===0,
      'Delegated execution intersects the authenticated caller, callee and current authority.',
      functionMissing('delegation'),
    ),
    check(
      'operation_separation',
      CONTEXT_SCOPE_CODE_CAPABILITIES.operation_separation&&functionMissing('operation_separation').length===0,
      'Read grants and ordinary mutation authority remain independent.',
      functionMissing('operation_separation'),
    ),
    check(
      'replay_delivery',
      CONTEXT_SCOPE_CODE_CAPABILITIES.replay_delivery,
      'Replay, compaction, generation and recipient delivery renew current authority.',
    ),
    check(
      'grant_expiry',
      CONTEXT_SCOPE_CODE_CAPABILITIES.grant_expiry&&functionMissing('grant_expiry').length===0,
      'Grant expiry and revocation are resolved from current server time and invalidate live leases.',
      functionMissing('grant_expiry'),
    ),
    check(
      'org_references',
      CONTEXT_SCOPE_CODE_CAPABILITIES.org_references&&functionMissing('org_references').length===0,
      'Organization references, cycles and optimistic revisions are guarded in the database.',
      functionMissing('org_references'),
    ),
    check(
      'legacy_data',
      true,
      'Workspace General rows are informational and remain reviewable.',
    ),
    check(
      'scope_review',
      CONTEXT_SCOPE_CODE_CAPABILITIES.scope_review&&functionMissing('scope_review').length===0
        &&coverage.unresolved==='0'&&reviewedInventoryRevision===coverage.registryRevision,
      CONTEXT_SCOPE_CODE_CAPABILITIES.scope_review&&functionMissing('scope_review').length===0
        &&coverage.unresolved==='0'&&reviewedInventoryRevision===coverage.registryRevision
        ? 'Every frozen source, impact, binding, and active-job family has been reviewed or held.'
        : 'The complete scope inventory still has unresolved or unacknowledged rows.',
      [...functionMissing('scope_review'),...coverage.families.filter(family=>family.unresolved!=='0').map(family=>family.family)],
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
