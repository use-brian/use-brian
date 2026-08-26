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
] as const

const triggers = [
  'sessions_context_binding_valid', 'sessions_context_immutable_after_lock',
  'session_messages_lock_context', 'teamspaces_context_group_valid',
  'teamspace_members_linked_roster_immutable', 'episodes_context_ingest_inherit',
  'pending_ingest_batches_context_scope_valid', 'file_cache_context_scope_inherit',
  'recordings_context_scope_inherit', 'transcript_segments_context_scope_inherit',
  'file_segments_context_scope_inherit',
]

function readinessQuery(opts: { withoutColumn?: string; withoutTrigger?: string } = {}): ReadinessQuery {
  return async <T extends Record<string, unknown>>(sql: string) => {
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
    return { rows: [{ count: '3' }] as unknown as T[] }
  }
}

describe('[COMP:api/context-scope-routes] activation readiness', () => {
  it('allows activation when every blocking capability is proven', async () => {
    const result = await getContextReadinessSystem('workspace', readinessQuery())
    expect(result.readyForActivation).toBe(true)
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
})
