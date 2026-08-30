import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(fileURLToPath(new URL(
  '../../../migrations/490_crm_agent_native_operations.sql',
  import.meta.url,
)), 'utf8')

describe('[COMP:crm/operations-store] CRM operations migration contract', () => {
  it('creates every workspace-owned operations table with RLS classification', () => {
    const tables = [
      'crm_intake_definitions', 'crm_intake_definition_versions',
      'crm_intake_credentials', 'crm_intake_credential_definitions',
      'crm_intake_idempotency', 'crm_consent_purposes', 'crm_suppression_events',
      'crm_segments', 'crm_domain_event_outbox', 'crm_import_jobs',
      'crm_import_chunks', 'crm_import_errors',
    ]
    for (const table of tables) {
      expect(migration).toContain(`CREATE TABLE ${table}`)
      expect(migration).toContain(`'${table}'`)
    }
    expect(migration).toContain('ALTER TABLE %I ENABLE ROW LEVEL SECURITY')
    expect(migration).toContain('workspace_id IN (SELECT workspace_id FROM workspace_members')
  })

  it('stores hashed intake secrets and atomically-scoped committed result ids', () => {
    expect(migration).toContain('secret_hash')
    expect(migration).not.toMatch(/raw_secret|secret_value|one_time_secret/)
    expect(migration).toContain('UNIQUE (workspace_id, actor_scope, definition_id, idempotency_key)')
    expect(migration).toContain("status = 'committed' AND submission_id IS NOT NULL AND contact_id IS NOT NULL")
  })

  it('preserves commerce registration constraints while permitting named non-commerce sources', () => {
    expect(migration).toContain("source_kind = 'commerce' AND order_id IS NOT NULL")
    expect(migration).toContain("source_kind <> 'commerce' AND order_id IS NULL")
    expect(migration).toContain("('commerce','manual','form','workflow','import')")
  })
})
