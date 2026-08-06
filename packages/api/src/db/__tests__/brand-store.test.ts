/**
 * [COMP:brand/store] — the brand lifecycle store (migration 413).
 *
 * The behavior under test is the D4 approval barrier, which is the whole
 * reason the primitive has two tables. Three properties have to hold or the
 * gate is decorative:
 *
 *   1. Approve is ONE transaction on ONE connection: insert the immutable
 *      version, repoint `active_version_id`, clear the draft, flip status.
 *      A partial approval leaves either an orphan version or an "unapproved
 *      changes" badge over content identical to the approved record.
 *   2. Approving with nothing in flight is a no-op, not a duplicate version.
 *      A double-clicked Approve button must not mint version N+1 of the same
 *      bytes.
 *   3. `workspace_brand_versions` has no UPDATE or DELETE path anywhere in
 *      the module. An approved version is a record of what a workspace
 *      signed off on; a rewritable one is not evidence of anything.
 *
 * No live Postgres: the pool is stubbed and the emitted SQL is asserted, the
 * same shape as `external-principal-scope.test.ts`. Fixture data is invented.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

type Call = { sql: string; params: unknown[] }

const txCalls: Call[] = []
const rlsCalls: Call[] = []

/** Rows the stubbed transaction client hands back, in query order. */
let txRows: unknown[][] = []
let txCursor = 0
const released: string[] = []

const txClient = {
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    txCalls.push({ sql, params })
    const rows = txRows[txCursor] ?? []
    txCursor += 1
    return { rows, rowCount: rows.length }
  }),
  release: vi.fn(),
}

vi.mock('../client.js', () => ({
  getAppPool: vi.fn(() => ({ connect: vi.fn(async () => txClient) })),
  queryWithRLS: vi.fn(async (_userId: string, sql: string, params: unknown[] = []) => {
    rlsCalls.push({ sql, params })
    const rows = txRows[txCursor] ?? []
    txCursor += 1
    return { rows, rowCount: rows.length }
  }),
  rollbackAndRelease: vi.fn(async () => {
    released.push('released')
  }),
}))

const published: Array<Record<string, unknown>> = []
vi.mock('../../brand-event-fanout.js', () => ({
  publishBrandLifecycle: (event: Record<string, unknown>) => {
    published.push(event)
  },
}))

const { createBrandStore } = await import('../brand-store.js')

const USER = '00000000-0000-4000-8000-000000000001'
const WORKSPACE = '00000000-0000-4000-8000-000000000002'
const BRAND = '00000000-0000-4000-8000-000000000003'
const VERSION_ID = '00000000-0000-4000-8000-000000000004'

const RECORD = {
  naming: { name: 'Northwind Ferry', tagline: 'Every crossing, on the hour' },
  messaging: { oneLine: 'Scheduled coastal freight you can plan around.' },
}

function brandRow(overrides: Record<string, unknown> = {}) {
  return {
    id: BRAND,
    workspace_id: WORKSPACE,
    slug: 'northwind',
    name: 'Northwind Ferry',
    is_default: true,
    status: 'active',
    active_version_id: VERSION_ID,
    draft: null,
    sensitivity: 'internal',
    created_by: USER,
    created_at: new Date('2026-08-01T00:00:00Z'),
    updated_at: new Date('2026-08-07T00:00:00Z'),
    active_version: 1,
    active_record: RECORD,
    ...overrides,
  }
}

function versionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: VERSION_ID,
    brand_id: BRAND,
    version: 1,
    record: RECORD,
    approved_by: USER,
    approved_at: new Date('2026-08-07T00:00:00Z'),
    ...overrides,
  }
}

/** Collapse whitespace so assertions read against one flat string. */
const flat = (sql: string) => sql.replace(/\s+/g, ' ')
const txSql = () => txCalls.map((c) => flat(c.sql))

beforeEach(() => {
  txCalls.length = 0
  rlsCalls.length = 0
  released.length = 0
  txRows = []
  txCursor = 0
  published.length = 0
  vi.clearAllMocks()
})

describe('[COMP:brand/store] approve', () => {
  /** Query order inside `approve`: SELECT FOR UPDATE → next version → INSERT → UPDATE. */
  function seedApproveRows() {
    txRows = [
      [], // BEGIN
      [], // SET LOCAL
      [{ draft: RECORD, prior_version: null }], // SELECT ... FOR UPDATE
      [{ next_version: 1 }], // next version number
      [versionRow()], // INSERT INTO workspace_brand_versions
      [brandRow()], // UPDATE workspace_brands
      [], // COMMIT
    ]
  }

  it('runs the whole approval as one transaction on one connection', async () => {
    seedApproveRows()
    const store = createBrandStore()
    const result = await store.approve(USER, WORKSPACE, BRAND, USER)

    expect(result).not.toBeNull()
    const sql = txSql()
    expect(sql[0]).toBe('BEGIN')
    expect(sql[1]).toContain('SET LOCAL app.current_user_id')
    expect(sql[sql.length - 1]).toBe('COMMIT')
    // Every statement went through the SAME client — a second connection
    // would put the version insert outside the transaction.
    expect(txClient.query).toHaveBeenCalledTimes(sql.length)
    expect(rlsCalls).toHaveLength(0)
  })

  it('inserts the immutable version, repoints active_version_id, and clears the draft', async () => {
    seedApproveRows()
    const store = createBrandStore()
    const result = await store.approve(USER, WORKSPACE, BRAND, USER)

    const insert = txCalls.find((c) => /INSERT INTO workspace_brand_versions/i.test(c.sql))
    expect(insert).toBeDefined()
    expect(insert!.params).toContain(BRAND)
    expect(insert!.params).toContain(1)

    const update = txCalls.find((c) => /UPDATE workspace_brands/i.test(c.sql))
    expect(update).toBeDefined()
    const updateSql = flat(update!.sql)
    // All three state changes ride the same statement, so there is no window
    // where the pointer moved but the draft is still sitting there.
    expect(updateSql).toContain('active_version_id = $3')
    expect(updateSql).toContain('draft = NULL')
    expect(updateSql).toContain("status = 'active'")

    expect(result!.version.version).toBe(1)
    expect(result!.brand.hasDraft).toBe(false)
    expect(result!.brand.activeVersionId).toBe(VERSION_ID)
  })

  it('locks the row before reading the draft', async () => {
    seedApproveRows()
    const store = createBrandStore()
    await store.approve(USER, WORKSPACE, BRAND, USER)
    const select = txCalls.find((c) => /FROM workspace_brands b/i.test(c.sql))
    // Without FOR UPDATE two approvers both read draft N and both try to
    // insert version N+1; the unique index rejects one with a constraint
    // error instead of the honest "nothing to approve".
    // `FOR UPDATE OF b` (not a bare FOR UPDATE): the statement LEFT JOINs the
    // versions table, and locking an immutable row would be both pointless and
    // a contention source.
    expect(flat(select!.sql)).toContain('FOR UPDATE OF b')
  })

  it('emits approved, and superseded only when a version was actually retired', async () => {
    seedApproveRows()
    await createBrandStore().approve(USER, WORKSPACE, BRAND, USER)
    // First approval: nothing was retired, so a `superseded` event here would
    // fire "the brand's positioning changed" subscriptions on a brand that had
    // no prior positioning.
    expect(published.map((e) => e.action)).toEqual(['approved'])
    expect(published[0].writtenBy).toBe('user')

    published.length = 0
    txCalls.length = 0
    txCursor = 0
    txRows = [
      [], [],
      [{ draft: RECORD, prior_version: 1 }],
      [{ next_version: 2 }],
      [versionRow({ version: 2 })],
      [brandRow({ active_version: 2 })],
      [],
    ]
    await createBrandStore().approve(USER, WORKSPACE, BRAND, USER)
    // Superseded first: the retirement of v1 precedes the activation of v2.
    expect(published.map((e) => e.action)).toEqual(['superseded', 'approved'])
    expect(published[0].version).toBe(1)
    expect(published[1].version).toBe(2)
  })

  it('is a no-op when there is no draft in flight', async () => {
    txRows = [
      [], // BEGIN
      [], // SET LOCAL
      [{ draft: null, prior_version: null }], // SELECT ... FOR UPDATE
    ]
    const store = createBrandStore()
    const result = await store.approve(USER, WORKSPACE, BRAND, USER)

    expect(result).toBeNull()
    expect(txSql()).toContain('ROLLBACK')
    expect(txCalls.some((c) => /INSERT INTO workspace_brand_versions/i.test(c.sql))).toBe(false)
  })

  it('returns null when the brand is not visible to the caller', async () => {
    txRows = [[], [], []] // BEGIN, SET LOCAL, empty SELECT
    const store = createBrandStore()
    expect(await store.approve(USER, WORKSPACE, BRAND, USER)).toBeNull()
    expect(txCalls.some((c) => /INSERT INTO workspace_brand_versions/i.test(c.sql))).toBe(false)
  })

  it('releases the connection even when the brand is missing', async () => {
    txRows = [[], [], []]
    const store = createBrandStore()
    await store.approve(USER, WORKSPACE, BRAND, USER)
    expect(released).toHaveLength(1)
  })
})

describe('[COMP:brand/store] versions are immutable', () => {
  it('exposes no UPDATE or DELETE path against workspace_brand_versions', async () => {
    // A source-level assertion on purpose: the property is "this statement
    // does not exist anywhere in the module", which no call-level test can
    // prove. Adding an update path must fail loudly here, not in review.
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../brand-store.ts', import.meta.url), 'utf-8'),
    )
    const statements = source.match(/(UPDATE|DELETE\s+FROM)\s+workspace_brand_versions/gi)
    expect(statements).toBeNull()
  })

  it('omits version bodies from the history listing', async () => {
    txRows = [[versionRow({ record: null }), versionRow({ id: 'v0', version: 2, record: null })]]
    const store = createBrandStore()
    const versions = await store.listVersions(USER, WORKSPACE, BRAND)
    expect(versions).toHaveLength(2)
    // History is a list of pointers; bodies come from `getVersion`, so a
    // 40-version brand does not ship 40 JSONB blobs to render a sidebar.
    expect(flat(rlsCalls[0].sql)).toContain('NULL::jsonb AS record')
    expect(flat(rlsCalls[0].sql)).toContain('ORDER BY version DESC')
  })
})

describe('[COMP:brand/store] draft writes', () => {
  it('saveDraft touches only the draft column', async () => {
    txRows = [[brandRow({ draft: RECORD, status: 'draft', active_version_id: null, active_version: null, active_record: null })]]
    const store = createBrandStore()
    const detail = await store.saveDraft(USER, WORKSPACE, BRAND, RECORD as never)

    const sql = flat(rlsCalls[0].sql)
    expect(sql).toContain('SET draft = $3::jsonb')
    // The write path an assistant can reach must not be able to approve.
    expect(sql).not.toContain('active_version_id =')
    expect(sql).not.toMatch(/INSERT INTO workspace_brand_versions/i)
    expect(detail!.hasDraft).toBe(true)
  })

  it('returns null when the brand does not exist', async () => {
    txRows = [[]]
    const store = createBrandStore()
    expect(await store.saveDraft(USER, WORKSPACE, BRAND, RECORD as never)).toBeNull()
  })
})

describe('[COMP:brand/store] reads', () => {
  it('resolves the workspace default when no ref is given', async () => {
    txRows = [[brandRow()]]
    const store = createBrandStore()
    const detail = await store.get(USER, WORKSPACE)
    expect(flat(rlsCalls[0].sql)).toContain('b.is_default')
    expect(detail!.activeRecord?.naming.name).toBe('Northwind Ferry')
  })

  it('resolves by id in preference to slug', async () => {
    txRows = [[brandRow()]]
    const store = createBrandStore()
    await store.get(USER, WORKSPACE, { id: BRAND, slug: 'other' })
    expect(flat(rlsCalls[0].sql)).toContain('b.id = $2')
    expect(rlsCalls[0].params).toEqual([WORKSPACE, BRAND])
  })

  it('resolves by slug when no id is given', async () => {
    txRows = [[brandRow()]]
    const store = createBrandStore()
    await store.get(USER, WORKSPACE, { slug: 'northwind' })
    expect(flat(rlsCalls[0].sql)).toContain('b.slug = $2')
  })

  it('treats an unparseable stored record as absent rather than throwing', async () => {
    // The schema can tighten after rows exist. A legacy row must degrade to
    // "no digest block", never take down prompt assembly on every turn.
    txRows = [[brandRow({ active_record: { naming: {} }, draft: { bogus: true } })]]
    const store = createBrandStore()
    const detail = await store.get(USER, WORKSPACE)
    expect(detail!.activeRecord).toBeNull()
    expect(detail!.draft).toBeNull()
  })

  it('lists brands default-first', async () => {
    txRows = [[brandRow(), brandRow({ id: 'b2', slug: 'other', is_default: false })]]
    const store = createBrandStore()
    const rows = await store.list(USER, WORKSPACE)
    expect(rows).toHaveLength(2)
    expect(flat(rlsCalls[0].sql)).toContain('ORDER BY b.is_default DESC, b.updated_at DESC')
  })
})

describe('[COMP:brand/store] create', () => {
  it('makes the first brand the workspace default', async () => {
    txRows = [
      [], // BEGIN
      [], // SET LOCAL
      [{ count: '0' }], // existing count
      [brandRow({ is_default: true, status: 'draft', active_version_id: null, active_version: null, active_record: null, draft: RECORD })],
      [], // COMMIT
    ]
    const store = createBrandStore()
    const created = await store.create(USER, WORKSPACE, { slug: 'northwind', name: 'Northwind Ferry' })
    expect(created.isDefault).toBe(true)
    // No demotion statement when there was nothing to demote.
    expect(txCalls.some((c) => /SET is_default = false/i.test(c.sql))).toBe(false)
  })

  it('demotes the incumbent default inside the same transaction', async () => {
    txRows = [
      [], // BEGIN
      [], // SET LOCAL
      [{ count: '2' }], // existing count
      [], // demote
      [brandRow({ slug: 'second', is_default: true, status: 'draft', active_version_id: null, active_version: null, active_record: null, draft: RECORD })],
      [], // COMMIT
    ]
    const store = createBrandStore()
    await store.create(USER, WORKSPACE, { slug: 'second', name: 'Second Brand', isDefault: true })
    const demote = txCalls.find((c) => /SET is_default = false/i.test(c.sql))
    expect(demote).toBeDefined()
    // Demote and insert must share the transaction, or the partial unique
    // index trips between them and the create fails for the wrong reason.
    expect(txSql()[0]).toBe('BEGIN')
    expect(txSql()[txSql().length - 1]).toBe('COMMIT')
  })

  it('seeds a draft from the name when none is supplied', async () => {
    txRows = [
      [], [], [{ count: '0' }],
      [brandRow({ status: 'draft', active_version_id: null, active_version: null, active_record: null, draft: { naming: { name: 'Northwind Ferry' } } })],
      [],
    ]
    const store = createBrandStore()
    await store.create(USER, WORKSPACE, { slug: 'northwind', name: 'Northwind Ferry' })
    const insert = txCalls.find((c) => /INSERT INTO workspace_brands/i.test(c.sql))!
    const draftParam = insert.params.find((p) => typeof p === 'string' && p.includes('naming')) as string
    expect(JSON.parse(draftParam)).toEqual({
      naming: { name: 'Northwind Ferry', domains: [], handles: [], restrictedTerms: [] },
      colors: [], typography: [], logoVariants: [], applications: [], claims: [], rights: [], sources: [],
    })
  })
})
