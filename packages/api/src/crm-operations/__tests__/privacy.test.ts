import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
  getPool: vi.fn(),
}))

vi.mock('../../db/client.js', () => ({ query: mocks.query, getPool: mocks.getPool }))

vi.mock('../privacy-admission.js',()=>({acquireCrmPrivacyAdmission:vi.fn(async()=>{})}))

import {
  CRM_OPERATIONS_PRIVACY_TABLES,
  exportCrmOperationsPrivacy,
  pruneCrmOperationsRetention,
  redactCrmOperationsForContact,
} from '../privacy.js'

const workspaceId = '11111111-1111-4111-8111-111111111111'
const contactId = '22222222-2222-4222-8222-222222222222'

describe('[COMP:crm/operations-privacy] CRM operations privacy lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.query.mockImplementation(async () => ({ rows: [], rowCount: 0 }))
    mocks.clientQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }))
    mocks.getPool.mockReturnValue({
      query: mocks.clientQuery,
      connect: async () => ({ query: mocks.clientQuery, release: mocks.release }),
    })
  })

  it('exports every operations table without credential secret hashes', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => ({ rows: sql.includes('SELECT role FROM workspace_members') ? [{role:'owner'}] : sql.includes('SELECT department_read_v2') ? [{department_read_v2:false}] : [], rowCount: 0 }))
    const exported = await exportCrmOperationsPrivacy({workspaceId,actor:{kind:'user',userId:contactId},authority:{role:'owner',canWrite:true,canConfigure:true,trustedIdentitySources:[]}})
    expect(Object.keys(exported.tables)).toEqual([...CRM_OPERATIONS_PRIVACY_TABLES])
    expect(mocks.clientQuery.mock.calls.filter(([sql]) => String(sql).startsWith('SELECT ') && !String(sql).includes('SELECT role ') && !String(sql).includes('SELECT department_read_v2'))).toHaveLength(CRM_OPERATIONS_PRIVACY_TABLES.length)
    const credentialSql = mocks.clientQuery.mock.calls.map(([sql]) => String(sql))
      .find((sql) => sql.includes('FROM crm_intake_credentials '))
    expect(credentialSql).toContain('secret_prefix')
    expect(credentialSql).not.toContain('secret_hash')
    expect(mocks.clientQuery).toHaveBeenCalledWith('COMMIT')
    expect(mocks.release).toHaveBeenCalled()
  })

  it('redacts personal operation payloads before the entity hard delete', async () => {
    mocks.clientQuery.mockResolvedValueOnce({ rows: [{ isPerson: true }], rowCount: 1 })
    await redactCrmOperationsForContact({ query: mocks.clientQuery } as never, workspaceId, contactId)

    const sql = mocks.clientQuery.mock.calls.map(([statement]) => String(statement)).join('\n')
    expect(sql).toContain("attendee_name='Erased participant'")
    expect(sql).toContain("row_snapshot='{}'::jsonb")
    expect(sql).toContain("payload=jsonb_build_object('erased',true")
    expect(sql).toContain("metadata=jsonb_build_object('erased',true)")
    expect(sql).toContain('UPDATE workspace_audit_log')
    expect(sql).not.toContain('DELETE FROM crm_segments')
    expect(sql).toContain('DELETE FROM association_consent_events')
    expect(sql).toContain('SELECT id,replay_policy_version FROM crm_intake_idempotency')
    expect(sql).not.toContain('DELETE FROM crm_intake_idempotency WHERE workspace_id=$1 AND contact_id=$2')
  })

  it('retains append-only evidence while pruning only configured terminal data', async () => {
    mocks.clientQuery.mockImplementation(async (statement: string) => ({
      rows: statement.includes('SELECT role FROM workspace_members') ? [{role:'owner'}] : statement.includes('SELECT department_read_v2') ? [{department_read_v2:false}] : [],
      rowCount: String(statement).startsWith('DELETE') ? 2 : 0,
    }))
    const result = await pruneCrmOperationsRetention({workspaceId,actor:{kind:'user',userId:contactId},authority:{role:'owner',canWrite:true,canConfigure:true,trustedIdentitySources:[]}}, new Date('2026-01-01T00:00:00Z'))
    const sql = mocks.clientQuery.mock.calls.map(([statement]) => String(statement)).join('\n')

    expect(result.total).toBe(12)
    expect(sql).toContain('DELETE FROM crm_import_sources')
    expect(sql).toContain('replay_expires_at<=clock_timestamp()')
    expect(sql).toContain('source_id=ANY($3::uuid[])')
    expect(sql).toContain('DELETE FROM crm_import_jobs')
    expect(sql).toContain('DELETE FROM crm_domain_event_outbox')
    expect(sql).toContain("status='delivered'")
    expect(sql).not.toContain("status IN ('delivered','failed')")
    expect(sql).toContain('DELETE FROM crm_intake_idempotency')
    expect(sql).toContain('DELETE FROM association_submission_attachments')
    expect(sql).toContain('DELETE FROM association_enquiries')
    expect(sql).not.toContain('DELETE FROM association_consent_events')
    expect(sql).not.toContain('DELETE FROM association_audit_log')
    expect(mocks.clientQuery).toHaveBeenCalledWith('COMMIT')
    expect(mocks.release).toHaveBeenCalled()
  })
})
