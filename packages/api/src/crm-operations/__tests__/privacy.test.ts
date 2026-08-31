import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
  getPool: vi.fn(),
}))

vi.mock('../../db/client.js', () => ({ query: mocks.query, getPool: mocks.getPool }))

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
      connect: async () => ({ query: mocks.clientQuery, release: mocks.release }),
    })
  })

  it('exports every operations table without credential secret hashes', async () => {
    const exported = await exportCrmOperationsPrivacy(workspaceId)
    expect(Object.keys(exported.tables)).toEqual([...CRM_OPERATIONS_PRIVACY_TABLES])
    expect(mocks.query).toHaveBeenCalledTimes(CRM_OPERATIONS_PRIVACY_TABLES.length)
    const credentialSql = mocks.query.mock.calls.map(([sql]) => String(sql))
      .find((sql) => sql.includes('FROM crm_intake_credentials '))
    expect(credentialSql).toContain('secret_prefix')
    expect(credentialSql).not.toContain('secret_hash')
    expect(mocks.query.mock.calls.every(([, params]) => (params as unknown[])[0] === workspaceId)).toBe(true)
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
    expect(sql).toContain('DELETE FROM crm_segments')
    expect(sql).toContain('DELETE FROM association_consent_events')
    expect(sql).toContain('DELETE FROM crm_intake_idempotency')
  })

  it('retains append-only evidence while pruning only configured terminal data', async () => {
    mocks.clientQuery.mockImplementation(async (statement: string) => ({
      rows: [],
      rowCount: String(statement).startsWith('DELETE') ? 2 : 0,
    }))
    const result = await pruneCrmOperationsRetention(workspaceId, new Date('2026-01-01T00:00:00Z'))
    const sql = mocks.clientQuery.mock.calls.map(([statement]) => String(statement)).join('\n')

    expect(result.total).toBe(8)
    expect(sql).toContain('DELETE FROM crm_import_jobs')
    expect(sql).toContain('DELETE FROM crm_domain_event_outbox')
    expect(sql).toContain('DELETE FROM crm_intake_idempotency')
    expect(sql).toContain('DELETE FROM association_enquiries')
    expect(sql).not.toContain('DELETE FROM association_consent_events')
    expect(sql).not.toContain('DELETE FROM association_audit_log')
    expect(mocks.clientQuery).toHaveBeenCalledWith('COMMIT')
    expect(mocks.release).toHaveBeenCalled()
  })
})
