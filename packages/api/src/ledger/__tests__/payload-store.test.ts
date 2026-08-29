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
    reset() {
      payloads.clear()
    },
  }
})

vi.mock('../../db/turn-ledger-store.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../db/turn-ledger-store.js')>()
  return {
    ...orig,
    payloadExists: vi.fn(async (ws: string | null | undefined, hash: string) =>
      db.payloads.has(`${ws ?? 'global'}:${hash}`),
    ),
    insertPayloadIndex: vi.fn(async (p: { workspaceId?: string | null; hash: string; storageRef: string; mediaType: string }) => {
      db.payloads.set(`${p.workspaceId ?? 'global'}:${p.hash}`, {
        storageRef: p.storageRef,
        erasedAt: null,
        mediaType: p.mediaType,
      })
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
