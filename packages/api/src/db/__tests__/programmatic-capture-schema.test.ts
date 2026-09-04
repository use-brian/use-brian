import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const migration = () => readFile(
  new URL('../../../migrations/494_programmatic_capture_profiles.sql', import.meta.url),
  'utf8',
)

describe('[COMP:api/programmatic-capture] migration contract', () => {
  it('adds reusable profiles, assistant/connection bindings, pooled dimensions, and receipts', async () => {
    const sql = await migration()
    expect(sql).toContain('CREATE TABLE public.programmatic_capture_profiles')
    expect(sql).toContain('ADD COLUMN capture_profile_id uuid')
    expect(sql).toContain('ADD COLUMN capture_assistant_id uuid')
    expect(sql).toContain('ADD COLUMN assistant_id uuid')
    expect(sql).toContain('ADD COLUMN partition_key text')
    expect(sql).toContain('CREATE TABLE public.programmatic_capture_receipts')
    expect(sql).toContain('UNIQUE (principal_kind, principal_id, event_id)')
    expect(sql).toContain('pending_ingest_batches(id) ON DELETE CASCADE')
  })

  it('enforces one rule parent and one concurrent-safe programmatic batch pool', async () => {
    const sql = await migration()
    expect(sql).toContain('num_nonnulls(connector_instance_id, capture_profile_id) = 1')
    expect(sql).toContain('pending_programmatic_batch_pool_key')
    expect(sql).toContain('(rule_id, assistant_id, partition_key, fires_at)')
    expect(sql).toContain("WHERE source = 'programmatic' AND processed_at IS NULL")
  })
})
