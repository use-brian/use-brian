/** [COMP:api/context-scope-routes] Runtime activation evidence. */
import { describe, expect, it } from 'vitest'
import {
  assertContextActivationReady,
  ContextActivationBlockedError,
  getContextReadinessSystem,
  type ReadinessQuery,
} from '../context-readiness.js'

const columns = [
  ['memories', 'project_ids'], ['tasks', 'project_ids'],
  ['workspace_files', 'project_ids'], ['entities', 'project_ids'],
  ['entity_links', 'project_ids'], ['episodes', 'project_ids'],
  ['file_cache', 'project_ids'], ['knowledge_entries', 'project_ids'],
  ['kb_chunks', 'project_ids'], ['file_segments', 'project_ids'],
  ['transcript_segments', 'project_ids'], ['recordings', 'project_ids'],
  ['entity_instances', 'project_ids'], ['blueprint_records', 'project_ids'],
  ['office_artifacts', 'project_ids'], ['sessions', 'context_group_id'],
  ['sessions', 'context_project_id'], ['brain_keys', 'context_group_id'],
  ['brain_keys', 'context_project_id'], ['connector_instance', 'project_ids'],
  ['connector_grant', 'project_ids'], ['ingest_rules', 'project_ids'],
  ['pending_ingest_batches', 'project_ids'],
  ['assistants','context_binding_origin'],['sessions','context_binding_origin'],
  ['brain_keys','context_binding_origin'],['connector_instance','context_binding_origin'],
  ['connector_grant','context_binding_origin'],['ingest_rules','scope_binding_origin'],
  ['ingest_rules','scope_binding_mode'],['pending_ingest_batches','scope_binding_origin'],
  ['pending_ingest_batches','scope_held'],['workspace_scope_review_items','content_snapshot'],
] as const

const triggers = [
  'sessions_context_binding_valid', 'sessions_context_immutable_after_lock',
  'session_messages_lock_context', 'teamspaces_context_group_valid',
  'teamspace_members_linked_roster_immutable', 'episodes_context_ingest_inherit',
  'pending_ingest_batches_context_scope_valid', 'file_cache_context_scope_inherit',
  'recordings_context_scope_inherit', 'transcript_segments_context_scope_inherit',
  'file_segments_context_scope_inherit',
]

const functions = [
  'advance_canonical_scope_version','hold_scope_descendants','agent_read_scope_allows',
  'agent_mutation_scope_allows','member_operation_scope_allows',
  'effective_member_read_compartments','validate_workspace_organization',
  'read_scope_review_source','scope_review_registry_revision',
]

function readinessQuery(opts: { withoutColumn?: string; withoutTrigger?: string; withoutFunction?: string; reviewed?: string | null; seen?: string[] } = {}): ReadinessQuery {
  return async <T extends Record<string, unknown>>(sql: string) => {
    opts.seen?.push(sql)
    if (sql.includes('information_schema.columns')) {
      return {
        rows: columns
          .filter(([table, column]) => `${table}.${column}` !== opts.withoutColumn)
          .map(([tableName, columnName]) => ({ tableName, columnName })) as unknown as T[],
      }
    }
    if (sql.includes('pg_trigger')) {
      return {
        rows: triggers
          .filter((name) => name !== opts.withoutTrigger)
          .map((name) => ({ name })) as unknown as T[],
      }
    }
    if (sql.includes('pg_proc')) {
      return {rows:functions.filter(name=>name!==opts.withoutFunction).map(name=>({name})) as unknown as T[]}
    }
    if(sql.includes('reviewed_inventory_revision'))return {rows:[{revision:opts.reviewed===undefined?'2':opts.reviewed}] as unknown as T[]}
    if(sql.includes(' AS total')||sql.includes(' total,'))return {rows:[{total:'0',unresolved:'0',held:'0'}] as unknown as T[]}
    return { rows: [{ count: '3' }] as unknown as T[] }
  }
}

describe('[COMP:api/context-scope-routes] activation readiness', () => {
  it('allows activation when every blocking capability is proven', async () => {
    const result = await getContextReadinessSystem('workspace', readinessQuery())
    expect(result.readyForActivation).toBe(true)
    expect(result.enforcementVersion).toBe(2)
    expect(result.checks.filter(check=>check.blocking)).toHaveLength(15)
    expect(result.legacyGeneral.memories).toBe(3)
    expect(result.checks.find((check) => check.id === 'legacy_data')).toMatchObject({
      ready: true,
      blocking: false,
    })
  })

  it('blocks activation on a partially migrated schema', async () => {
    const result = await getContextReadinessSystem(
      'workspace',
      readinessQuery({ withoutColumn: 'connector_grant.project_ids' }),
    )
    expect(result.readyForActivation).toBe(false)
    expect(result.checks.find((check) => check.id === 'row_store_coverage')?.missing)
      .toContain('connector_grant.project_ids')
    await expect(assertContextActivationReady('workspace', async () => result))
      .rejects.toEqual(expect.objectContaining<Partial<ContextActivationBlockedError>>({
        code: 'context_activation_blocked',
        failedChecks: expect.arrayContaining(['row_store_coverage', 'connectors']),
      }))
  })

  it('names a missing database guard instead of guessing readiness', async () => {
    const result = await getContextReadinessSystem(
      'workspace',
      readinessQuery({ withoutTrigger: 'session_messages_lock_context' }),
    )
    expect(result.checks.find((check) => check.id === 'session_isolation')).toMatchObject({
      ready: false,
      missing: ['session_messages_lock_context'],
    })
  })

  it('blocks a missing v2 operation-separation function independently',async()=>{
    const result=await getContextReadinessSystem('workspace',readinessQuery({withoutFunction:'member_operation_scope_allows'}))
    expect(result.checks.find(check=>check.id==='operation_separation')).toMatchObject({ready:false,missing:['member_operation_scope_allows']})
    expect(result.readyForActivation).toBe(false)
  })

  it('skips the per-row inventory walk until the inventory is acknowledged', async () => {
    const seen: string[] = []
    const result = await getContextReadinessSystem('workspace', readinessQuery({ reviewed: null, seen }))
    expect(seen.some((sql) => sql.includes('read_scope_review_source'))).toBe(false)
    expect(result.readyForActivation).toBe(false)
    expect(result.checks.find((check) => check.id === 'scope_review')).toMatchObject({
      ready: false,
      missing: ['reviewed_inventory_revision'],
    })
  })

  it('walks the inventory once it is acknowledged at the current registry revision', async () => {
    const seen: string[] = []
    await getContextReadinessSystem('workspace', readinessQuery({ seen }))
    expect(seen.some((sql) => sql.includes('read_scope_review_source'))).toBe(true)
  })

  it('omits the informational Workspace General counts when asked', async () => {
    const seen: string[] = []
    const result = await getContextReadinessSystem('workspace', readinessQuery({ seen }), { legacyInventory: false })
    expect(result.legacyGeneral).toEqual({})
    expect(seen.some((sql) => sql.includes('cardinality(compartments)'))).toBe(false)
    expect(result.readyForActivation).toBe(true)
  })
})
