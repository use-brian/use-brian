import { describe, it, expect, vi } from 'vitest'
import { buildSitePaths } from '../public-sites.js'
import type { PageDomain, PageDomainStore } from '../../db/page-domain-store.js'

const ROOT_ID = '0a1b2c3d-0000-4000-8000-000000000001'
const SLUGGED = '0a1b2c3d-0000-4000-8000-000000000002'
const UNSLUGGED = '0a1b2c3d-0000-4000-8000-000000000003'

const domain = { id: 'd_1', pageId: ROOT_ID } as PageDomain

function storeWith(slugs: Record<string, string>): PageDomainStore {
  return {
    listCurrentSlugs: vi.fn(async (_domainId: string, ids: string[]) => {
      return new Map(ids.filter((id) => slugs[id]).map((id) => [id, slugs[id]]))
    }),
  } as unknown as PageDomainStore
}

describe('[COMP:doc/public-site-route] Site paths map', () => {
  it('maps root to /, slugged pages to /<slug>, unslugged to /p/<id>', async () => {
    const store = storeWith({ [SLUGGED]: 'getting-started' })
    const paths = await buildSitePaths(
      store,
      domain,
      [
        { kind: 'child_page', childPageId: SLUGGED },
        { kind: 'child_page', childPageId: UNSLUGGED },
        { kind: 'text' },
      ],
      [{ pageId: ROOT_ID }, { pageId: SLUGGED }],
    )
    expect(paths[ROOT_ID]).toBe('/')
    expect(paths[SLUGGED]).toBe('/getting-started')
    expect(paths[UNSLUGGED]).toBe(`/p/${UNSLUGGED}`)
  })

  it('never queries for the root id (it is always /)', async () => {
    const store = storeWith({})
    await buildSitePaths(store, domain, [], [{ pageId: ROOT_ID }])
    const queried = vi.mocked(store.listCurrentSlugs).mock.calls[0][1]
    expect(queried).not.toContain(ROOT_ID)
  })

  it('handles a page with no references (root-only map)', async () => {
    const store = storeWith({})
    const paths = await buildSitePaths(store, domain, [], [])
    expect(paths).toEqual({ [ROOT_ID]: '/' })
  })
})
