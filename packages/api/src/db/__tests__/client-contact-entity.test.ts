/**
 * [COMP:brain/client-contact-entity] — the D11 row shape, asserted at the
 * mint site.
 *
 * The failure this exists to catch is a well-meaning refactor that "unifies"
 * `getOrCreateClientContactEntity` with `getOrCreateSelfEntity`. They differ in
 * exactly one column and that column inverts who can see the row: a self entity
 * is `user_id` SET (visible only to that principal), a client contact is
 * `user_id` NULL (visible to the team, which is the whole deliverable). Merging
 * them back together silently deletes the feature while every test that only
 * checks "an entity was created" stays green.
 *
 * DB-free: the pool is stubbed and the emitted SQL + params are asserted.
 * See `docs/plans/client-principal.md` §8.1 and `docs/architecture/brain/crm.md`
 * → "Client contacts".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const captured: Array<{ sql: string; params: unknown[] }> = []
let selectEntityIdRows: Array<{ entityId: string | null }> = []
let selectEntityRows: unknown[] = []

vi.mock('../client.js', () => ({
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    captured.push({ sql, params })
    const flat = sql.replace(/\s+/g, ' ')
    if (flat.includes('SELECT entity_id')) return { rows: selectEntityIdRows, rowCount: selectEntityIdRows.length }
    if (flat.startsWith(' SELECT id,') || /^\s*SELECT\s+id,/.test(sql)) {
      return { rows: selectEntityRows, rowCount: selectEntityRows.length }
    }
    if (flat.includes('INSERT INTO entities')) {
      return {
        rows: [{
          id: 'ent-client-1',
          kind: 'person',
          displayName: 'Ada Lovelace',
          sensitivity: 'internal',
          userId: null,
          workspaceId: 'ws-1',
          attributes: { client: true, externalUserId: 'cust_8812' },
        }],
        rowCount: 1,
      }
    }
    return { rows: [], rowCount: 0 }
  }),
  queryWithRLS: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  getAppPool: vi.fn(() => { throw new Error('getAppPool must not be reached') }),
  rollbackAndRelease: vi.fn(),
}))

const store = await import('../entities-store.js')

function find(fragment: string) {
  return captured.find((c) => c.sql.replace(/\s+/g, ' ').includes(fragment))
}

beforeEach(() => {
  captured.length = 0
  selectEntityIdRows = []
  selectEntityRows = []
})

describe('[COMP:brain/client-contact-entity] client contact entity', () => {
  it('mints the team-visible shape: user_id NULL, internal, client-compartmented', async () => {
    const entity = await store.getOrCreateClientContactEntity({
      userId: 'shadow-a',
      workspaceId: 'ws-1',
      displayName: 'Ada Lovelace',
      externalUserId: 'cust_8812',
      email: 'ada@example.com',
    })

    const insert = find('INSERT INTO entities')
    expect(insert).toBeDefined()
    const sql = insert!.sql.replace(/\s+/g, ' ')

    // The two literals that carry the whole decision. `user_id` NULL is what
    // lets the team see the row at all (D11); `internal` is what keeps a
    // `public`-ceiling client from reading it back.
    expect(sql).toContain("'person', $1, $2::jsonb, 'internal'")
    expect(sql).toContain('$3, NULL, NULL')
    // Not `user_id = $n` — a partitioned client contact is the bug D11 names.
    expect(sql).not.toMatch(/VALUES[\s\S]*\$3, \$4, NULL/)

    // The compartment is the client-vs-client wall once user_id stops
    // partitioning (D12), so it must be on the row itself, not only on the
    // rows the client later authors.
    expect(insert!.params[4]).toEqual(['client:cust_8812'])

    // `attributes.self` stays the teammate self-entity discriminator and must
    // never answer for a client contact.
    const attributes = JSON.parse(insert!.params[1] as string)
    expect(attributes).toEqual({ client: true, externalUserId: 'cust_8812', email: 'ada@example.com' })
    expect('self' in attributes).toBe(false)

    // Anchored on the shadow user, so the client has a durable contact.
    const update = find('UPDATE users SET entity_id')
    expect(update?.params).toEqual(['ent-client-1', 'shadow-a'])
    expect(entity.id).toBe('ent-client-1')
  })

  it('omits an absent email rather than writing a null attribute', async () => {
    await store.getOrCreateClientContactEntity({
      userId: 'shadow-a',
      workspaceId: 'ws-1',
      displayName: 'cust_8812',
      externalUserId: 'cust_8812',
      email: null,
    })
    const insert = find('INSERT INTO entities')!
    expect(JSON.parse(insert.params[1] as string)).toEqual({
      client: true,
      externalUserId: 'cust_8812',
    })
  })

  it('reuses the anchored entity instead of minting a second one', async () => {
    selectEntityIdRows = [{ entityId: 'ent-client-1' }]
    selectEntityRows = [{ id: 'ent-client-1', kind: 'person', displayName: 'Ada', sensitivity: 'internal', userId: null }]

    const entity = await store.getOrCreateClientContactEntity({
      userId: 'shadow-a',
      workspaceId: 'ws-1',
      displayName: 'Ada Lovelace',
      externalUserId: 'cust_8812',
    })

    expect(entity.id).toBe('ent-client-1')
    expect(find('INSERT INTO entities')).toBeUndefined()
    expect(find('UPDATE users SET entity_id')).toBeUndefined()
  })

  it('re-mints when the anchor points outside this workspace', async () => {
    selectEntityIdRows = [{ entityId: 'ent-elsewhere' }]
    selectEntityRows = [] // not found in ws-1

    await store.getOrCreateClientContactEntity({
      userId: 'shadow-a',
      workspaceId: 'ws-1',
      displayName: 'Ada Lovelace',
      externalUserId: 'cust_8812',
    })

    expect(find('INSERT INTO entities')).toBeDefined()
  })

  it('still writes the self-entity shape for a teammate — the sibling is unchanged', async () => {
    await store.getOrCreateSelfEntity({
      userId: 'member-1',
      workspaceId: 'ws-1',
      displayName: 'Team Member',
    })
    const insert = find('INSERT INTO entities')!
    const sql = insert.sql.replace(/\s+/g, ' ')
    // `$4` in the user_id slot: SET, not NULL. This is the shape a client
    // contact must NOT have.
    expect(sql).toContain('$3, $4, NULL')
    expect(JSON.parse(insert.params[1] as string)).toEqual({ self: true })
  })
})
