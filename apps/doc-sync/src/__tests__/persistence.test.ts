import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import {
  loadPageUpdate,
  notifyPageUpdated,
  storePageSnapshot,
  type SysQuery,
} from '../persistence.js'
import { pageToYDoc, snapshotFromUpdate } from '@sidanclaw/doc-model'

describe('[COMP:doc-sync/persistence] loadPageUpdate', () => {
  it('returns the stored ydoc bytes when present', async () => {
    const ydoc = pageToYDoc({ blocks: [{ kind: 'text', id: 't1', text: 'hi' }] } as never, 'T')
    const bytes = Buffer.from(Y.encodeStateAsUpdate(ydoc))
    const query: SysQuery = async (sql) =>
      (sql.includes('documents') ? [{ ydoc: bytes }] : []) as never[]
    const update = await loadPageUpdate({ pageId: 'p', query })
    expect(update).toBeInstanceOf(Uint8Array)
    expect(snapshotFromUpdate(update!).title).toBe('T')
  })

  it('falls back to encoding from saved_views.page when no stored ydoc', async () => {
    const query: SysQuery = async (sql) =>
      (sql.includes('documents')
        ? [{ ydoc: null }]
        : [{ page: { blocks: [{ kind: 'text', id: 'x', text: 'fallback' }] }, name: 'Legacy' }]) as never[]
    const update = await loadPageUpdate({ pageId: 'p', query })
    expect(update).not.toBeNull()
    expect(snapshotFromUpdate(update!).title).toBe('Legacy')
  })

  it('returns null when the page row is gone', async () => {
    const query: SysQuery = async () => [] as never[]
    expect(await loadPageUpdate({ pageId: 'p', query })).toBeNull()
  })
})

describe('[COMP:doc-sync/persistence] storePageSnapshot', () => {
  it('writes ydoc + derived snapshot_json, then mirrors the title to saved_views', async () => {
    const ydoc = pageToYDoc(
      { blocks: [{ kind: 'heading', id: 'h', level: 1, text: 'Doc' }] } as never,
      'My Title',
    )
    const calls: { sql: string; params: unknown[] }[] = []
    const query: SysQuery = async (sql, params) => {
      calls.push({ sql, params })
      return [] as never[]
    }
    await storePageSnapshot({ pageId: 'p1', ydoc, query })

    expect(calls).toHaveLength(2)
    const insert = calls[0]
    expect(insert.sql).toContain('INSERT INTO documents')
    expect(insert.params[0]).toBe('p1')
    expect(insert.params[1]).toBeInstanceOf(Buffer)
    const snapshot = JSON.parse(insert.params[3] as string)
    expect(snapshot.blocks[0]).toMatchObject({ kind: 'heading', text: 'Doc' })
    expect(insert.params[4]).toBe('My Title')
    // The title mirror is scoped to placeholder names (migration 218) so it
    // can't clobber an 'auto'/'user' name with a stale Y.Doc seed.
    const mirrorSql = calls[1].sql.replace(/\s+/g, ' ').trim()
    expect(mirrorSql).toContain('UPDATE saved_views SET name = $2')
    expect(mirrorSql).toContain("name_origin = 'placeholder'")
    expect(calls[1].params).toEqual(['p1', 'My Title'])
  })

  // Editor-created nodes carry `blockId: null`; without stamping, every
  // persist re-minted a fresh id for them in snapshot_json, so the AI's
  // outline rotated ids between reads and every id-keyed op missed (prod
  // 2026-06-11, page c4b01fe2 / session 81a56d8b). storePageSnapshot must
  // stamp the id INTO the doc before deriving the snapshot.
  it('stamps missing blockIds into the doc so snapshot ids are stable', async () => {
    const ydoc = pageToYDoc(
      { blocks: [{ kind: 'text', id: 't1', text: 'typed by a human' }] } as never,
      'T',
    )
    const frag = ydoc.getXmlFragment('default')
    ;(frag.get(0) as Y.XmlElement).removeAttribute('blockId')

    const snapshots: string[] = []
    const query: SysQuery = async (sql, params) => {
      if (sql.includes('INSERT INTO documents')) snapshots.push(params[3] as string)
      return [] as never[]
    }
    await storePageSnapshot({ pageId: 'p1', ydoc, query })
    await storePageSnapshot({ pageId: 'p1', ydoc, query })

    const id1 = JSON.parse(snapshots[0]).blocks[0].id
    const id2 = JSON.parse(snapshots[1]).blocks[0].id
    expect(id1).toBeTruthy()
    expect(id1).toBe(id2) // stable across persists
    // ...because the id was written into the doc, not fabricated per read.
    expect((frag.get(0) as Y.XmlElement).getAttribute('blockId')).toBe(id1)
  })
})

describe('[COMP:doc-sync/persistence] notifyPageUpdated', () => {
  it('POSTs an `updated` page-event with the secret header and isSystem flag', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const doFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return { status: 202 } as Response
    }) as unknown as typeof fetch

    const out = await notifyPageUpdated({
      pageId: 'p1',
      isSystem: true,
      config: { apiBaseUrl: 'http://api:8080/', syncSecret: 'shhh', doFetch },
    })

    expect(out).toBe('dispatched')
    expect(calls).toHaveLength(1)
    // Trailing slash on the base is trimmed before joining the path.
    expect(calls[0].url).toBe('http://api:8080/internal/page-event')
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers['x-doc-sync-secret']).toBe('shhh')
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      pageId: 'p1',
      action: 'updated',
      isSystem: true,
    })
  })

  it('swallows a fetch error so a page write is never affected', async () => {
    const doFetch = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const out = await notifyPageUpdated({
      pageId: 'p1',
      isSystem: false,
      config: { apiBaseUrl: 'http://api', syncSecret: 's', doFetch },
    })
    expect(out).toBe('error')
  })
})
