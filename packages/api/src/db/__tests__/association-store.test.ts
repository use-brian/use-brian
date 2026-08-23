import type { Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { associationFingerprint } from '../../association/domain.js'
import { createAssociationStore } from '../association-store.js'

const WID = '11111111-1111-4111-8111-111111111111'
const CONTACT_ID = '22222222-2222-4222-8222-222222222222'
const RECORD_ID = '33333333-3333-4333-8333-333333333333'
const ORDER_ID = '44444444-4444-4444-8444-444444444444'

function fakePool(
  resolve: (sql: string, params: unknown[] | undefined) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number }>,
) {
  const statements: string[] = []
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    statements.push(normalized)
    if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
      return { rows: [], rowCount: 0 }
    }
    return resolve(normalized, params)
  })
  const release = vi.fn()
  const pool = {
    connect: vi.fn().mockResolvedValue({ query, release }),
    query,
  } as unknown as Pool
  return { pool, query, release, statements }
}

describe('[COMP:crm/association-store] transactional evidence', () => {
  it('commits an enquiry only with both notification intents and its audit row', async () => {
    const fake = fakePool(async (sql) => {
      if (sql.includes('FROM association_enquiries') && sql.includes('FOR UPDATE')) return { rows: [] }
      if (sql.includes("FROM entities") && sql.includes("kind = 'person'")) return { rows: [{ one: 1 }], rowCount: 1 }
      if (sql.startsWith('INSERT INTO association_enquiries')) {
        return { rows: [{ id: RECORD_ID, workspaceId: WID, contactId: CONTACT_ID, status: 'new' }], rowCount: 1 }
      }
      if (sql.startsWith('INSERT INTO association_notification_outbox')) return { rows: [], rowCount: 2 }
      if (sql.startsWith('INSERT INTO association_audit_log')) return { rows: [], rowCount: 1 }
      throw new Error(`unexpected SQL: ${sql}`)
    })
    const result = await createAssociationStore(fake.pool).createEnquiry(WID, {
      contactId: CONTACT_ID,
      source: 'website',
      sourceSubmissionId: 'submission-1',
      subject: 'Question',
      message: 'Please contact me',
      queueKey: 'general',
      submittedData: {},
    }, {
      credentialKind: 'api_key',
      credentialId: 'key-1',
    })

    expect(result.created).toBe(true)
    expect(fake.statements.at(0)).toBe('BEGIN')
    expect(fake.statements.at(-1)).toBe('COMMIT')
    expect(fake.statements.some((sql) => sql.startsWith('INSERT INTO association_notification_outbox'))).toBe(true)
    expect(fake.statements.some((sql) => sql.startsWith('INSERT INTO association_audit_log'))).toBe(true)
    expect(fake.release).toHaveBeenCalledOnce()
  })

  it('rolls back the enquiry when notification intent creation fails', async () => {
    const fake = fakePool(async (sql) => {
      if (sql.includes('FROM association_enquiries') && sql.includes('FOR UPDATE')) return { rows: [] }
      if (sql.includes('FROM entities')) return { rows: [{ one: 1 }], rowCount: 1 }
      if (sql.startsWith('INSERT INTO association_enquiries')) {
        return { rows: [{ id: RECORD_ID, workspaceId: WID, contactId: CONTACT_ID }], rowCount: 1 }
      }
      if (sql.startsWith('INSERT INTO association_notification_outbox')) throw new Error('outbox unavailable')
      throw new Error(`unexpected SQL: ${sql}`)
    })

    await expect(createAssociationStore(fake.pool).createEnquiry(WID, {
      contactId: CONTACT_ID,
      source: 'website',
      sourceSubmissionId: 'submission-2',
      subject: 'Question',
      message: 'Please contact me',
      queueKey: 'general',
      submittedData: {},
    }, { credentialKind: 'api_key', credentialId: 'key-1' })).rejects.toThrow('outbox unavailable')
    expect(fake.statements).toContain('ROLLBACK')
    expect(fake.statements).not.toContain('COMMIT')
  })

  it('returns the winning enquiry when simultaneous retries race', async () => {
    const input = {
      contactId: CONTACT_ID,
      source: 'website',
      sourceSubmissionId: 'submission-race',
      subject: 'Question',
      message: 'Please contact me',
      queueKey: 'general',
      submittedData: {},
    }
    const fake = fakePool(async (sql) => {
      if (sql.includes('FROM entities')) return { rows: [{ one: 1 }], rowCount: 1 }
      if (sql.startsWith('INSERT INTO association_enquiries')) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM association_enquiries')) {
        return {
          rows: [{
            id: RECORD_ID,
            workspaceId: WID,
            contactId: CONTACT_ID,
            status: 'new',
            requestFingerprint: associationFingerprint(input),
          }],
          rowCount: 1,
        }
      }
      throw new Error(`unexpected SQL: ${sql}`)
    })
    const result = await createAssociationStore(fake.pool).createEnquiry(
      WID,
      input,
      { credentialKind: 'api_key', credentialId: 'key-1' },
    )
    expect(result).toMatchObject({ created: false, record: { id: RECORD_ID } })
    expect(result.record).not.toHaveProperty('requestFingerprint')
    expect(fake.statements.some((sql) => sql.startsWith('INSERT INTO association_notification_outbox'))).toBe(false)
    expect(fake.statements.at(-1)).toBe('COMMIT')
  })

  it('refuses reuse of an order idempotency key with a changed request', async () => {
    const original = {
      contactId: CONTACT_ID,
      idempotencyKey: 'checkout-1',
      reservationMinutes: 20,
      lines: [{
        ticketId: RECORD_ID,
        quantity: 1,
        useMemberPrice: false,
        attendees: [{ name: 'First Attendee', metadata: {} }],
      }],
      metadata: {},
    }
    const fake = fakePool(async (sql) => {
      if (sql.includes('FROM association_orders') && sql.includes('FOR UPDATE')) {
        return { rows: [{ id: ORDER_ID, requestFingerprint: associationFingerprint(original) }], rowCount: 1 }
      }
      throw new Error(`unexpected SQL: ${sql}`)
    })
    const changed = {
      ...original,
      lines: [{ ...original.lines[0], attendees: [{ name: 'Different Attendee', metadata: {} }] }],
    }

    await expect(createAssociationStore(fake.pool).createOrder(
      WID,
      changed,
      { credentialKind: 'api_key', credentialId: 'key-1' },
    )).rejects.toMatchObject({ code: 'conflict' })
    expect(fake.statements).toContain('ROLLBACK')
    expect(fake.statements.some((sql) => sql.startsWith('INSERT INTO association_orders'))).toBe(false)
  })

  it('rolls back an invalid provider transition before recording the event', async () => {
    const fake = fakePool(async (sql) => {
      if (sql.includes('FROM association_provider_events')) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM association_orders') && sql.includes('FOR UPDATE')) {
        return { rows: [{ status: 'paid' }], rowCount: 1 }
      }
      throw new Error(`unexpected SQL: ${sql}`)
    })
    await expect(createAssociationStore(fake.pool).reconcileProviderEvent(
      WID,
      ORDER_ID,
      {
        provider: 'stripe',
        eventId: 'evt_1',
        targetStatus: 'failed',
        occurredAt: '2027-02-02T10:00:00.000Z',
        metadata: {},
      },
      { credentialKind: 'api_key', credentialId: 'key-1' },
    )).rejects.toMatchObject({ code: 'invalid_transition' })
    expect(fake.statements).toContain('ROLLBACK')
    expect(fake.statements.some((sql) => sql.startsWith('INSERT INTO association_provider_events'))).toBe(false)
  })

  it('refuses a late paid event after its inventory reservation expired', async () => {
    const fake = fakePool(async (sql) => {
      if (sql.includes('FROM association_provider_events')) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM association_orders') && sql.includes('FOR UPDATE')) {
        return {
          rows: [{ status: 'pending', reservation_expires_at: new Date(Date.now() - 60_000) }],
          rowCount: 1,
        }
      }
      throw new Error(`unexpected SQL: ${sql}`)
    })
    await expect(createAssociationStore(fake.pool).reconcileProviderEvent(
      WID,
      ORDER_ID,
      {
        provider: 'stripe',
        eventId: 'evt_late',
        targetStatus: 'paid',
        occurredAt: '2027-02-02T10:00:00.000Z',
        metadata: {},
      },
      { credentialKind: 'api_key', credentialId: 'key-1' },
    )).rejects.toMatchObject({ code: 'not_available' })
    expect(fake.statements).toContain('ROLLBACK')
    expect(fake.statements.some((sql) => sql.startsWith('INSERT INTO association_provider_events'))).toBe(false)
  })
})
