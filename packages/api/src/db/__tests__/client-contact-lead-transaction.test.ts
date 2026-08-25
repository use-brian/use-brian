/**
 * [COMP:brain/client-contact-entity] — verified application handoffs create
 * the team contact and idempotent lead in one serialized transaction.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: Array<{ sql: string; params: unknown[] }> = []
let anchoredContactId: string | null = null
let persistedLead = false

function entityRow(kind: 'person' | 'deal') {
  const person = kind === 'person'
  return {
    id: person ? 'ent-contact-1' : 'ent-lead-1',
    kind,
    displayName: person ? 'Ada Lovelace' : 'Ada - Studio consultation',
    canonicalId: null,
    aliases: [],
    attributes: person
      ? { client: true, externalUserId: 'cust_a', email: 'ada@example.com' }
      : {
          stage: 'lead',
          contact_id: 'ent-contact-1',
          external_ref: { provider: 'api:key-1', id: 'studio-consultation:session-1' },
        },
    sensitivity: 'internal',
    workspaceId: 'ws-1',
    userId: null,
    assistantId: null,
    createdByUserId: 'shadow-a',
    createdByAssistantId: 'asst-1',
    sourceEpisodeId: null,
    sourceSessionId: null,
    source: 'user',
    verifiedByUserId: null,
    verifiedAt: null,
    validFrom: new Date('2026-08-25T00:00:00Z'),
    validTo: null,
    supersededBy: null,
    retractedAt: null,
    retractedReason: null,
    retractedBy: null,
    centrality: 0,
    centralityComputedAt: null,
    createdAt: new Date('2026-08-25T00:00:00Z'),
    updatedAt: new Date('2026-08-25T00:00:00Z'),
  }
}

const client = {
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params })
    const flat = sql.replace(/\s+/g, ' ').trim()
    if (flat.startsWith('BEGIN') || flat.startsWith('COMMIT') || flat.startsWith('ROLLBACK')) {
      return { rows: [], rowCount: 0 }
    }
    if (flat.includes('SELECT entity_id AS "entityId"')) {
      return { rows: [{ entityId: anchoredContactId }], rowCount: 1 }
    }
    if (flat.startsWith('SELECT id,') && flat.includes("kind = 'person'")) {
      return { rows: anchoredContactId ? [entityRow('person')] : [], rowCount: anchoredContactId ? 1 : 0 }
    }
    if (flat.startsWith('SELECT id,') && flat.includes("kind = 'deal'")) {
      return { rows: persistedLead ? [entityRow('deal')] : [], rowCount: persistedLead ? 1 : 0 }
    }
    if (flat.includes('INSERT INTO entities') && flat.includes("'person'")) {
      anchoredContactId = 'ent-contact-1'
      return { rows: [entityRow('person')], rowCount: 1 }
    }
    if (flat.includes('INSERT INTO entities') && flat.includes("'deal'")) {
      persistedLead = true
      return { rows: [entityRow('deal')], rowCount: 1 }
    }
    return { rows: [], rowCount: 1 }
  }),
  release: vi.fn(),
}

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getAppPool: vi.fn(),
  getPool: vi.fn(() => ({ connect: async () => client })),
  rollbackAndRelease: vi.fn(),
}))

const store = await import('../entities-store.js')

beforeEach(() => {
  calls.length = 0
  anchoredContactId = null
  persistedLead = false
  client.query.mockClear()
  client.release.mockClear()
})

const input = {
  userId: 'shadow-a',
  workspaceId: 'ws-1',
  assistantId: 'asst-1',
  displayName: 'Ada Lovelace',
  externalUserId: 'cust_a',
  identityNamespace: 'api:key-1',
  email: 'ada@example.com',
  lead: { key: 'studio-consultation:session-1', name: 'Ada - Studio consultation' },
}

describe('[COMP:brain/client-contact-entity] contact + lead transaction', () => {
  it('locks the client anchor and commits the exact compartmented CRM pair', async () => {
    const result = await store.getOrCreateClientContactAndLeadEntities(input)

    expect(result.contact.id).toBe('ent-contact-1')
    expect(result.lead.id).toBe('ent-lead-1')
    expect(calls[0].sql).toBe('BEGIN')
    expect(calls.some((call) => call.sql.includes('FOR UPDATE'))).toBe(true)
    expect(calls.at(-1)?.sql).toBe('COMMIT')

    const dealInsert = calls.find(
      (call) => call.sql.includes('INSERT INTO entities') && call.sql.includes("'deal'"),
    )
    expect(dealInsert?.params[5]).toEqual(['client:cust_a'])
    expect(JSON.parse(dealInsert?.params[1] as string)).toEqual({
      stage: 'lead',
      contact_id: 'ent-contact-1',
      external_ref: { provider: 'api:key-1', id: 'studio-consultation:session-1' },
    })
  })

  it('reuses both records when the same handoff key is retried', async () => {
    await store.getOrCreateClientContactAndLeadEntities(input)
    calls.length = 0

    const retried = await store.getOrCreateClientContactAndLeadEntities(input)

    expect(retried.contact.id).toBe('ent-contact-1')
    expect(retried.lead.id).toBe('ent-lead-1')
    expect(calls.filter((call) => call.sql.includes('INSERT INTO entities'))).toHaveLength(0)
    expect(calls.some((call) => call.sql.includes("attributes->'external_ref'->>'id'"))).toBe(true)
  })
})
