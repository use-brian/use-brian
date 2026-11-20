/**
 * Ledger payload store — content addressing, dedup, tombstones, and both
 * storage drivers: the REAL local-disk client (self-host) and an
 * in-memory GcsFilesClient fake standing in for the hosted GCS driver
 * (same interface the boot-time selection hands over either way).
 *
 * Spec: docs/architecture/engine/turn-ledger.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const db = vi.hoisted(() => {
  const payloads = new Map<string, { storageRef: string; erasedAt: Date | null; mediaType: string }>()
  return {
    payloads,
    reads: [] as string[][],
    inserts: [] as string[][],
    reset() {
      payloads.clear()
      this.reads.length = 0
      this.inserts.length = 0
    },
  }
})

vi.mock('../../db/turn-ledger-store.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../db/turn-ledger-store.js')>()
  return {
    ...orig,
    getPayloadIndexStates: vi.fn(async (ws: string | null | undefined, hashes: string[]) => {
      db.reads.push(hashes)
      return hashes.flatMap((hash) => {
        const row = db.payloads.get(`${ws ?? 'global'}:${hash}`)
        return row ? [{ hash, erasedAt: row.erasedAt }] : []
      })
    }),
    insertPayloadIndexes: vi.fn(async (payloads: Array<{ workspaceId?: string | null; hash: string; storageRef: string; mediaType: string }>) => {
      db.inserts.push(payloads.map((p) => p.hash))
      const inserted: string[] = []
      for (const p of payloads) {
        const key = `${p.workspaceId ?? 'global'}:${p.hash}`
        if (db.payloads.has(key)) continue
        db.payloads.set(key, { storageRef: p.storageRef, erasedAt: null, mediaType: p.mediaType })
        inserted.push(p.hash)
      }
      return inserted
    }),
    getPayloadIndexRow: vi.fn(async (ws: string | null | undefined, hash: string) => {
      const row = db.payloads.get(`${ws ?? 'global'}:${hash}`)
      if (!row) return null
      return {
        scope: ws ?? 'global',
        hash,
        workspaceId: ws ?? null,
        byteSize: 1,
        mediaType: row.mediaType,
        storageRef: row.storageRef,
        sensitivity: 'internal',
        erasedAt: row.erasedAt,
      }
    }),
    markPayloadsErased: vi.fn(async (ws: string | null | undefined, hashes: string[]) => {
      const refs: string[] = []
      for (const h of hashes) {
        const row = db.payloads.get(`${ws ?? 'global'}:${h}`)
        if (row && !row.erasedAt) {
          row.erasedAt = new Date()
          refs.push(row.storageRef)
        }
      }
      return refs
    }),
  }
})

import { createLedgerPayloadStore, hashPayload, ledgerStorageKey } from '../payload-store.js'
import { createLocalFilesClient } from '../../files/local-files-client.js'
import type { GcsFilesClient, GcsBlob, GcsObjectMetadata } from '../../files/gcs-client.js'

function fakeGcsClient(): { client: GcsFilesClient; objects: Map<string, GcsBlob>; writes: number } {
  const objects = new Map<string, GcsBlob>()
  const state = { writes: 0 }
  const client: GcsFilesClient = {
    async writeBlob(key: string, bytes: Buffer, metadata: GcsObjectMetadata) {
      state.writes++
      objects.set(key, { bytes, mime: metadata.mime, metadata })
    },
    async appendBlob() {
      throw new Error('unused')
    },
    async readBlob(key: string) {
      return objects.get(key) ?? null
    },
    async statBlob() {
      return null
    },
    async deleteBlob(key: string) {
      objects.delete(key)
    },
    async signedReadUrl() {
      return 'unused'
    },
    async signedWriteUrl() {
      return 'unused'
    },
    writeStream() {
      throw new Error('unused')
    },
  }
  return {
    client,
    objects,
    get writes() {
      return state.writes
    },
  }
}

describe('[COMP:api/ledger-payload-store] content addressing', () => {
  beforeEach(() => db.reset())

  it('hashes deterministically (sha256 hex)', () => {
    expect(hashPayload('abc')).toBe(hashPayload('abc'))
    expect(hashPayload('abc')).toMatch(/^[0-9a-f]{64}$/)
    expect(hashPayload('abc')).not.toBe(hashPayload('abd'))
  })

  it('scopes keys per workspace (privacy over dedup)', () => {
    expect(ledgerStorageKey('ws1', 'h')).toBe('ledger/ws1/h')
    expect(ledgerStorageKey(null, 'h')).toBe('ledger/global/h')
  })
})

describe('[COMP:api/ledger-payload-store] GCS-interface driver (fake)', () => {
  beforeEach(() => db.reset())

  it('batches unique hashes while retaining duplicates, order, scope and tombstones', async () => {
    const gcs = fakeGcsClient()
    const store = createLedgerPayloadStore(gcs.client)
    const old = await store.put({ workspaceId: 'ws1', content: 'erased' })
    await store.erase('ws1', [old])
    db.reads.length = 0
    const refs = await store.putMany!([
      { workspaceId: 'ws1', content: 'new' }, { workspaceId: 'ws1', content: 'erased' },
      { workspaceId: 'ws1', content: 'new' }, { workspaceId: 'ws2', content: 'new' },
    ])
    expect(refs).toEqual(['new', 'erased', 'new', 'new'].map(hashPayload))
    expect(gcs.writes).toBe(3)
    expect(await store.get('ws1', old)).toEqual({ erased: true })
    expect(gcs.objects.has(ledgerStorageKey('ws1', old))).toBe(false)
    expect(db.reads.map((r) => r.length)).toEqual([2, 1])
    await store.putMany!([{ workspaceId: 'ws1', content: 'new' }])
    expect(gcs.writes).toBe(3)
  })

  it('indexes the confirmed prefix before reporting a later blob failure', async () => {
    const gcs = fakeGcsClient()
    const write = gcs.client.writeBlob.bind(gcs.client)
    gcs.client.writeBlob = async (...args) => {
      if (args[0].endsWith(hashPayload('fails'))) throw new Error('blob unavailable')
      return write(...args)
    }
    const store = createLedgerPayloadStore(gcs.client)
    await expect(store.putMany!(['first', 'fails', 'last'].map((content) => ({ workspaceId: 'ws1', content })))).rejects.toThrow('blob unavailable')
    expect(await store.get('ws1', hashPayload('first'))).toMatchObject({ content: 'first' })
    expect(await store.get('ws1', hashPayload('fails'))).toBeNull()
    expect(await store.get('ws1', hashPayload('last'))).toBeNull()
    expect(db.inserts).toEqual([[hashPayload('first')]])
  })

  it('does not resurrect bytes when a concurrent erased row wins the insert', async () => {
    const gcs = fakeGcsClient()
    const write = gcs.client.writeBlob.bind(gcs.client)
    gcs.client.writeBlob = async (...args) => {
      await write(...args)
      db.payloads.set(`ws1:${hashPayload('raced')}`, { storageRef: args[0], erasedAt: new Date(), mediaType: 'application/json' })
    }
    const store = createLedgerPayloadStore(gcs.client)
    await store.putMany!([{ workspaceId: 'ws1', content: 'raced' }])
    expect(await store.get('ws1', hashPayload('raced'))).toEqual({ erased: true })
    expect(gcs.objects.size).toBe(0)
  })

  it('bounds set-wise reads and inserts for a thousand distinct messages', async () => {
    const gcs = fakeGcsClient()
    const store = createLedgerPayloadStore(gcs.client)
    const inputs = Array.from({ length: 1000 }, (_, n) => ({ workspaceId: 'ws1', content: `message ${n}` }))
    expect(await store.putMany!(inputs)).toEqual(inputs.map((p) => hashPayload(p.content)))
    expect(db.reads.map((r) => r.length)).toEqual([512, 488])
    expect(db.inserts.map((r) => r.length)).toEqual([512, 488])
    expect(gcs.writes).toBe(1000)
  })

  it('put writes the object then the index row, and dedups by hash', async () => {
    const gcs = fakeGcsClient()
    const store = createLedgerPayloadStore(gcs.client)
    const h1 = await store.put({ workspaceId: 'ws1', content: 'same-content' })
    const h2 = await store.put({ workspaceId: 'ws1', content: 'same-content' })
    expect(h1).toBe(h2)
    expect(gcs.writes).toBe(1)
    expect(gcs.objects.has(`ledger/ws1/${h1}`)).toBe(true)
  })

  it('identical content in two workspaces gets two objects', async () => {
    const gcs = fakeGcsClient()
    const store = createLedgerPayloadStore(gcs.client)
    const h1 = await store.put({ workspaceId: 'ws1', content: 'shared' })
    const h2 = await store.put({ workspaceId: 'ws2', content: 'shared' })
    expect(h1).toBe(h2)
    expect(gcs.objects.has(`ledger/ws1/${h1}`)).toBe(true)
    expect(gcs.objects.has(`ledger/ws2/${h1}`)).toBe(true)
  })

  it('get round-trips content and resolves erased to an explicit marker', async () => {
    const gcs = fakeGcsClient()
    const store = createLedgerPayloadStore(gcs.client)
    const h = await store.put({ workspaceId: 'ws1', content: 'secret payload' })
    const got = await store.get('ws1', h)
    expect(got && 'content' in got ? got.content : null).toBe('secret payload')

    const erased = await store.erase('ws1', [h])
    expect(erased).toBe(1)
    expect(gcs.objects.size).toBe(0)
    const after = await store.get('ws1', h)
    expect(after).toEqual({ erased: true })
  })

  it('unknown hash resolves to null (a miss, not an erasure)', async () => {
    const store = createLedgerPayloadStore(fakeGcsClient().client)
    expect(await store.get('ws1', 'deadbeef')).toBeNull()
  })
})

describe('[COMP:api/ledger-payload-store] local-disk driver (real)', () => {
  beforeEach(() => db.reset())

  it('put + get round-trip on the real self-host client', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'ledger-test-'))
    const client = createLocalFilesClient({
      baseDir,
      apiUrl: 'http://localhost:3001',
      signingSecret: 'test-secret',
    })
    const store = createLedgerPayloadStore(client)
    const h = await store.put({ workspaceId: 'ws-local', content: JSON.stringify({ role: 'user', content: 'hi' }) })
    const got = await store.get('ws-local', h)
    expect(got && 'content' in got ? JSON.parse(got.content) : null).toEqual({ role: 'user', content: 'hi' })
  })

  it('erase deletes the local object and tombstones the row', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'ledger-test-'))
    const client = createLocalFilesClient({
      baseDir,
      apiUrl: 'http://localhost:3001',
      signingSecret: 'test-secret',
    })
    const store = createLedgerPayloadStore(client)
    const h = await store.put({ workspaceId: 'ws-local', content: 'to be erased' })
    await store.erase('ws-local', [h])
    expect(await store.get('ws-local', h)).toEqual({ erased: true })
  })
})
