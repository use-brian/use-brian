import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import {
  loadPageUpdate,
  notifyPageUpdated,
  notifyOfficeCheckpoint,
  storePageSnapshot,
  type SysQuery,
} from '../persistence.js'
import { DrawingCollaboration, pageToYDoc, snapshotFromUpdate } from '@use-brian/doc-model'

describe('[COMP:doc-sync/persistence] loadPageUpdate', () => {
  it('returns the stored ydoc bytes when present', async () => {
    const ydoc = pageToYDoc({ blocks: [{ kind: 'text', id: 't1', text: 'hi' }] } as never, 'T')
    const bytes = Buffer.from(Y.encodeStateAsUpdate(ydoc))
    const query: SysQuery = async (sql) =>
      (sql.includes('documents') ? [{ ydoc: bytes }] : []) as never[]
    const loaded = await loadPageUpdate({ pageId: 'p', query })
    expect(loaded!.update).toBeInstanceOf(Uint8Array)
    expect(loaded!.origin).toBe('persisted')
    expect(snapshotFromUpdate(loaded!.update).title).toBe('T')
  })

  it('falls back to encoding from saved_views.page when no stored ydoc', async () => {
    const query: SysQuery = async (sql) =>
      (sql.includes('documents')
        ? [{ ydoc: null }]
        : [{ page: { blocks: [{ kind: 'text', id: 'x', text: 'fallback' }] }, name: 'Legacy' }]) as never[]
    const loaded = await loadPageUpdate({ pageId: 'p', query })
    expect(loaded).not.toBeNull()
    // Tagged so `onLoadDocument` can refuse to stack it onto a populated doc —
    // the 2026-07-21 whole-body duplication.
    expect(loaded!.origin).toBe('legacy-seed')
    expect(snapshotFromUpdate(loaded!.update).title).toBe('Legacy')
  })

  it('returns null when the page row is gone', async () => {
    const query: SysQuery = async () => [] as never[]
    expect(await loadPageUpdate({ pageId: 'p', query })).toBeNull()
  })
})

describe('[COMP:doc-sync/persistence] storePageSnapshot', () => {
  it('persists a peer image duplicate after the inserting peer undoes, and isolates later malformed registers', async () => {
    const block = { kind: 'drawing' as const, id: 'drawing', scene: { version: 1 as const, elements: [], files: {}, appState: { viewBackgroundColor: '#fff' } } }
    const a = pageToYDoc({ blocks: [block, { kind: 'text', id: 'text', text: 'Neighbor' }] }, 'Page'), b = new Y.Doc()
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    const left = new DrawingCollaboration(a, block, () => true), right = new DrawingCollaboration(b, block, () => true)
    const file = { id: 'file', mimeType: 'image/png' as const, dataURL: 'data:image/png;base64,YQ==', created: 1 }
    const image = { id: 'original', type: 'image' as const, fileId: 'file', x: 0, y: 0, width: 20, height: 20 }
    left.write(block.scene, { ...block.scene, elements: [image], files: { file } })
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    const seen = right.read().scene
    right.write(seen, { ...seen, elements: [...seen.elements, { ...image, id: 'duplicate' }] })
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b)); left.undo.undo()
    const calls: unknown[][] = []
    const query: SysQuery = async (_sql, params) => { calls.push(params); return [] as never[] }
    await storePageSnapshot({ pageId: 'p', ydoc: a, query })
    const canonical = JSON.parse(calls[0][3] as string)
    expect(canonical.blocks[0].scene.elements).toEqual([{ ...image, id: 'duplicate' }])
    expect(canonical.blocks[0].scene.files.file).toEqual(file)
    expect(snapshotFromUpdate(calls[0][1] as Uint8Array).page).toEqual(canonical)
    left.registers.set('element:duplicate', null)
    calls.length = 0
    await storePageSnapshot({ pageId: 'p', ydoc: a, query })
    expect(JSON.parse(calls[0][3] as string).blocks).toMatchObject([
      { kind: 'drawing', collaborationError: 'invalid-registers' }, { kind: 'text', text: 'Neighbor' },
    ])
    left.dispose(); right.dispose(); a.destroy(); b.destroy()
  })
  it('stores live drawing edits in both the binary and canonical snapshot_json, not only a side map', async () => {
    const block = { kind: 'drawing' as const, id: 'drawing', scene: { version: 1 as const, elements: [], files: {}, appState: { viewBackgroundColor: '#fff' } } }
    const doc = pageToYDoc({ blocks: [block] }, 'Page')
    const live = new DrawingCollaboration(doc, block, () => true)
    live.write(block.scene, { ...block.scene, elements: [{ id: 'shape', type: 'rectangle', x: 12, y: 24, width: 80, height: 60 }] })
    const calls: unknown[][] = []
    const query: SysQuery = async (_sql, params) => { calls.push(params); return [] as never[] }
    await storePageSnapshot({ pageId: 'p', ydoc: doc, query })
    const canonical = JSON.parse(calls[0][3] as string)
    expect(canonical.blocks[0].scene.elements[0]).toMatchObject({ id: 'shape', x: 12 })
    expect(snapshotFromUpdate(calls[0][1] as Uint8Array).page).toEqual(canonical)
    live.dispose(); doc.destroy()
  })
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

describe('[COMP:doc-sync/office-collab] Office checkpoint handoff', () => {
  it('sends only the canonical CAS tuple through the shared-secret route', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const doFetch = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return { status: 201, ok: true, json: async () => ({ version: 5 }) } as Response }) as unknown as typeof fetch
    await expect(notifyOfficeCheckpoint({ artifactId: 'a1', expectedVersion: 4, canonicalHash: 'a'.repeat(64), config: { apiBaseUrl: 'http://api/', syncSecret: 'secret', doFetch } })).resolves.toEqual({ status: 'checkpointed', version: 5 })
    expect(calls[0].url).toBe('http://api/internal/office-checkpoint')
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ artifactId: 'a1', expectedVersion: 4, canonicalHash: 'a'.repeat(64) })
  })
})
