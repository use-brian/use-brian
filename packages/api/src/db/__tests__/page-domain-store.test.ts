import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getAppPool: vi.fn(),
  rollbackAndRelease: vi.fn(async () => {}),
}))

import { createDbPageDomainStore } from '../page-domain-store.js'
import { getAppPool, query, queryWithRLS } from '../client.js'

const mockQuery = vi.mocked(query)
const mockQueryWithRLS = vi.mocked(queryWithRLS)
const mockGetAppPool = vi.mocked(getAppPool)

beforeEach(() => {
  vi.clearAllMocks()
})

const store = createDbPageDomainStore()

const ROOT_ID = '0a1b2c3d-0000-4000-8000-000000000001'

const DOMAIN_ROW = {
  id: 'd_1',
  workspaceId: 'w_1',
  pageId: ROOT_ID,
  hostname: 'docs.acme.com',
  status: 'live',
  provider: 'manual',
  verificationError: null,
  lastCheckedAt: null,
  createdBy: 'u_1',
  createdAt: 'now',
  updatedAt: 'now',
}

const TARGET_ROW = {
  pageId: ROOT_ID,
  workspaceId: 'w_1',
  title: 'Docs',
  icon: null,
  fullWidth: false,
  role: 'view',
  indexable: true,
  rootPageId: ROOT_ID,
}

const CHILD_ID = '5f0b7c9e-1234-4abc-9def-0123456789ab'

const rows = (r: unknown[]) => ({ rows: r }) as never

describe('[COMP:doc/page-domains] Page domain + slug store', () => {
  describe('resolveSitePath', () => {
    it('returns null for an unknown hostname', async () => {
      mockQuery.mockResolvedValueOnce(rows([]))
      expect(await store.resolveSitePath('nope.acme.com', null)).toBeNull()
    })

    it('serves the domain root at "/" when the publish gate passes', async () => {
      mockQuery
        .mockResolvedValueOnce(rows([DOMAIN_ROW])) // domain lookup
        .mockResolvedValueOnce(rows([TARGET_ROW])) // gated target
      const out = await store.resolveSitePath('docs.acme.com', '')
      expect(out).toMatchObject({ kind: 'page', canonicalPath: '/' })
      // target === root → no rootPageId tag
      expect((out as { target: { rootPageId?: string } }).target.rootPageId).toBeUndefined()
    })

    it('404s the root when the publish gate fails (unpublished / clearance raised)', async () => {
      mockQuery
        .mockResolvedValueOnce(rows([DOMAIN_ROW]))
        .mockResolvedValueOnce(rows([])) // gate query returns nothing
      expect(await store.resolveSitePath('docs.acme.com', null)).toBeNull()
    })

    it('301s /p/<id> to the slug when a current slug exists', async () => {
      mockQuery
        .mockResolvedValueOnce(rows([DOMAIN_ROW]))
        .mockResolvedValueOnce(rows([{ ...TARGET_ROW, pageId: CHILD_ID, rootPageId: ROOT_ID }])) // gate
        .mockResolvedValueOnce(rows([{ pageId: CHILD_ID, slug: 'getting-started' }])) // listCurrentSlugs
      const out = await store.resolveSitePath('docs.acme.com', `p/${CHILD_ID}`)
      expect(out).toEqual({ kind: 'redirect', location: '/getting-started' })
    })

    it('301s /p/<rootId> to "/"', async () => {
      mockQuery
        .mockResolvedValueOnce(rows([DOMAIN_ROW]))
        .mockResolvedValueOnce(rows([TARGET_ROW])) // gate
      const out = await store.resolveSitePath('docs.acme.com', `p/${ROOT_ID}`)
      expect(out).toEqual({ kind: 'redirect', location: '/' })
    })

    it('does NOT redirect /p/<id> when the publish gate fails (dead sites serve nothing)', async () => {
      mockQuery
        .mockResolvedValueOnce(rows([DOMAIN_ROW]))
        .mockResolvedValueOnce(rows([])) // gate fails — no slug lookup happens
      expect(await store.resolveSitePath('docs.acme.com', `p/${CHILD_ID}`)).toBeNull()
      expect(mockQuery).toHaveBeenCalledTimes(2)
    })

    it('404s a /p/<id> whose id is not a UUID', async () => {
      mockQuery.mockResolvedValueOnce(rows([DOMAIN_ROW]))
      expect(await store.resolveSitePath('docs.acme.com', 'p/not-a-uuid')).toBeNull()
    })

    it('serves /p/<id> directly when the page has no slug', async () => {
      mockQuery
        .mockResolvedValueOnce(rows([DOMAIN_ROW]))
        .mockResolvedValueOnce(
          rows([{ ...TARGET_ROW, pageId: CHILD_ID, rootPageId: ROOT_ID }]),
        ) // gate
        .mockResolvedValueOnce(rows([])) // no current slug
      const out = await store.resolveSitePath('docs.acme.com', `p/${CHILD_ID}`)
      expect(out).toMatchObject({ kind: 'page', canonicalPath: `/p/${CHILD_ID}` })
      expect((out as { target: { rootPageId?: string } }).target.rootPageId).toBe(ROOT_ID)
    })

    it('serves a current slug and reports its canonical path', async () => {
      mockQuery
        .mockResolvedValueOnce(rows([DOMAIN_ROW]))
        .mockResolvedValueOnce(rows([{ pageId: CHILD_ID, isCurrent: true }])) // slug row
        .mockResolvedValueOnce(
          rows([{ ...TARGET_ROW, pageId: CHILD_ID, rootPageId: ROOT_ID }]),
        )
      const out = await store.resolveSitePath('docs.acme.com', 'getting-started')
      expect(out).toMatchObject({ kind: 'page', canonicalPath: '/getting-started' })
    })

    it('301s a historical slug to the current one', async () => {
      mockQuery
        .mockResolvedValueOnce(rows([DOMAIN_ROW]))
        .mockResolvedValueOnce(rows([{ pageId: CHILD_ID, isCurrent: false }])) // historical
        .mockResolvedValueOnce(rows([{ ...TARGET_ROW, pageId: CHILD_ID, rootPageId: ROOT_ID }])) // gate
        .mockResolvedValueOnce(rows([{ pageId: CHILD_ID, slug: 'new-name' }])) // current
      const out = await store.resolveSitePath('docs.acme.com', 'old-name')
      expect(out).toEqual({ kind: 'redirect', location: '/new-name' })
    })

    it('does NOT redirect a historical slug when the publish gate fails', async () => {
      mockQuery
        .mockResolvedValueOnce(rows([DOMAIN_ROW]))
        .mockResolvedValueOnce(rows([{ pageId: CHILD_ID, isCurrent: false }])) // historical
        .mockResolvedValueOnce(rows([])) // gate fails
      expect(await store.resolveSitePath('docs.acme.com', 'old-name')).toBeNull()
    })

    it('404s unknown slugs and multi-segment paths', async () => {
      mockQuery
        .mockResolvedValueOnce(rows([DOMAIN_ROW]))
        .mockResolvedValueOnce(rows([])) // slug miss
      expect(await store.resolveSitePath('docs.acme.com', 'nope')).toBeNull()

      mockQuery.mockResolvedValueOnce(rows([DOMAIN_ROW]))
      expect(await store.resolveSitePath('docs.acme.com', 'a/b')).toBeNull()
    })
  })

  describe('setSlug', () => {
    function mockTx(responses: Array<{ rows: unknown[] } | undefined>) {
      const calls: string[] = []
      const client = {
        query: vi.fn((sql: string) => {
          calls.push(typeof sql === 'string' ? sql : '')
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql.startsWith('SET LOCAL')) {
            return Promise.resolve(undefined)
          }
          const next = responses.shift()
          return Promise.resolve(next ?? { rows: [] })
        }),
        release: vi.fn(),
      }
      mockGetAppPool.mockReturnValue({ connect: vi.fn().mockResolvedValue(client) } as never)
      return { client, calls }
    }

    it('rejects a slug on the domain root', async () => {
      mockTx([{ rows: [{ pageId: ROOT_ID }] }])
      const out = await store.setSlug({ userId: 'u_1', domainId: 'd_1', pageId: ROOT_ID, slug: 'x' })
      expect(out).toEqual({ ok: false, reason: 'root_has_no_slug' })
    })

    it('rejects a page outside the domain subtree', async () => {
      mockTx([
        { rows: [{ pageId: ROOT_ID }] }, // domain
        { rows: [] }, // containment miss
      ])
      const out = await store.setSlug({ userId: 'u_1', domainId: 'd_1', pageId: 'p_x', slug: 'x' })
      expect(out).toEqual({ ok: false, reason: 'not_in_subtree' })
    })

    it("rejects a slug held by another page", async () => {
      mockTx([
        { rows: [{ pageId: ROOT_ID }] },
        { rows: [{ ok: 1 }] }, // contained
        { rows: [{ id: 's_1', pageId: 'p_other', isCurrent: true }] }, // holder
      ])
      const out = await store.setSlug({ userId: 'u_1', domainId: 'd_1', pageId: 'p_1', slug: 'x' })
      expect(out).toEqual({ ok: false, reason: 'slug_taken' })
    })

    it('is a no-op when the page already holds the slug', async () => {
      mockTx([
        { rows: [{ pageId: ROOT_ID }] },
        { rows: [{ ok: 1 }] },
        { rows: [{ id: 's_1', pageId: 'p_1', isCurrent: true }] },
      ])
      const out = await store.setSlug({ userId: 'u_1', domainId: 'd_1', pageId: 'p_1', slug: 'x' })
      expect(out).toEqual({ ok: true, slug: 'x', previousSlug: null })
    })

    it('demotes the previous slug and inserts the new one', async () => {
      const { client } = mockTx([
        { rows: [{ pageId: ROOT_ID }] },
        { rows: [{ ok: 1 }] },
        { rows: [] }, // no holder
        { rows: [{ slug: 'old-name' }] }, // demoted
        { rows: [] }, // insert
      ])
      const out = await store.setSlug({
        userId: 'u_1',
        domainId: 'd_1',
        pageId: 'p_1',
        slug: 'new-name',
      })
      expect(out).toEqual({ ok: true, slug: 'new-name', previousSlug: 'old-name' })
      const sqls = client.query.mock.calls.map((c) => String(c[0]))
      expect(sqls.some((s) => s.includes('INSERT INTO page_slugs'))).toBe(true)
      expect(sqls).toContain('COMMIT')
    })

    it("re-promotes the page's own historical slug instead of inserting", async () => {
      const { client } = mockTx([
        { rows: [{ pageId: ROOT_ID }] },
        { rows: [{ ok: 1 }] },
        { rows: [{ id: 's_old', pageId: 'p_1', isCurrent: false }] }, // own historical
        { rows: [{ slug: 'current-name' }] }, // demoted
        { rows: [] }, // re-promote UPDATE
      ])
      const out = await store.setSlug({
        userId: 'u_1',
        domainId: 'd_1',
        pageId: 'p_1',
        slug: 'old-name',
      })
      expect(out).toEqual({ ok: true, slug: 'old-name', previousSlug: 'current-name' })
      const sqls = client.query.mock.calls.map((c) => String(c[0]))
      expect(sqls.some((s) => s.includes('SET is_current = true'))).toBe(true)
      expect(sqls.some((s) => s.includes('INSERT INTO page_slugs'))).toBe(false)
    })
  })

  describe('createDomain', () => {
    it('maps a unique-violation to hostname_taken', async () => {
      mockQueryWithRLS.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }))
      const out = await store.createDomain({
        userId: 'u_1',
        workspaceId: 'w_1',
        pageId: ROOT_ID,
        hostname: 'docs.acme.com',
        provider: 'manual',
      })
      expect(out).toEqual({ error: 'hostname_taken' })
    })
  })

  describe('listCurrentSlugs', () => {
    it('short-circuits on an empty id list', async () => {
      const out = await store.listCurrentSlugs('d_1', [])
      expect(out.size).toBe(0)
      expect(mockQuery).not.toHaveBeenCalled()
    })
  })
})
