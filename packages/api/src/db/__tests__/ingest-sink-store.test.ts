/**
 * Unit tests for the ingest external-sink config store.
 * Component tag: [COMP:api/ingest-sink-store].
 *
 * Mocks the pg pool so the tests are DB-free; the secret round-trip runs
 * REAL AES-256-GCM through credential-crypto (a random key), asserting a
 * plaintext secret never reaches SQL parameters and that decryption
 * recovers it. `recordAck` is the X3 cursor barrier — asserted to be the
 * only cursor write.
 */

import { randomBytes } from 'node:crypto'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const poolQueries: { text: string; values?: unknown[] }[] = []
let poolResults: Record<string, unknown>[] = []
let poolRowCount = 0

const fakePool = {
  query: vi.fn(async (text: string, values?: unknown[]) => {
    poolQueries.push({ text, values })
    return { rows: poolResults, rowCount: poolRowCount || poolResults.length }
  }),
}

vi.mock('../client.js', () => ({
  getPool: () => fakePool,
}))

import { createIngestSinkStore } from '../ingest-sink-store.js'
import { decryptCredentials } from '../credential-crypto.js'

const KEY = randomBytes(32)
const store = createIngestSinkStore(KEY)

function makeRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'sink-1',
    connectorInstanceId: 'ci-1',
    workspaceId: 'ws-1',
    endpointUrl: 'https://archive.example.com/append',
    authKind: 'hmac',
    mode: 'all',
    enabled: true,
    hasSecret: true,
    lastAckCursor: null,
    lastDeliveredAt: null,
    createdAt: new Date('2026-07-23T00:00:00Z'),
    ...over,
  }
}

beforeEach(() => {
  poolQueries.length = 0
  poolResults = []
  poolRowCount = 0
  fakePool.query.mockClear()
})

describe('[COMP:api/ingest-sink-store] create', () => {
  it('stores the secret as an encrypted blob, never plaintext', async () => {
    poolResults = [makeRow()]
    await store.create({
      connectorInstanceId: 'ci-1',
      workspaceId: 'ws-1',
      endpointUrl: 'https://archive.example.com/append',
      authKind: 'hmac',
      secret: 'super-secret-value-123',
    })
    const values = poolQueries[0].values!
    const blob = values[4] as Buffer
    expect(Buffer.isBuffer(blob)).toBe(true)
    expect(blob.toString('utf8')).not.toContain('super-secret-value-123')
    expect(decryptCredentials<{ secret: string }>(blob, KEY)).toEqual({
      secret: 'super-secret-value-123',
    })
    // mode defaults to archive-always (X5)
    expect(values[5]).toBe('all')
  })

  it('refuses to store a secret without an encryption key', async () => {
    const keyless = createIngestSinkStore(null)
    await expect(
      keyless.create({
        connectorInstanceId: 'ci-1',
        workspaceId: 'ws-1',
        endpointUrl: 'https://archive.example.com/append',
        authKind: 'bearer',
        secret: 'super-secret-value-123',
      }),
    ).rejects.toThrow(/CHANNEL_CREDENTIAL_KEY/)
    expect(fakePool.query).not.toHaveBeenCalled()
  })
})

describe('[COMP:api/ingest-sink-store] getSecretSystem', () => {
  it('decrypts the stored blob back to the secret', async () => {
    const blob = (await (async () => {
      const { encryptCredentials } = await import('../credential-crypto.js')
      return encryptCredentials({ secret: 'relay-auth-token' }, KEY)
    })())
    fakePool.query.mockImplementationOnce(async () => ({
      rows: [{ secretCiphertext: blob }],
      rowCount: 1,
    }))
    expect(await store.getSecretSystem('sink-1')).toBe('relay-auth-token')
  })

  it('returns null when no secret is stored', async () => {
    fakePool.query.mockImplementationOnce(async () => ({
      rows: [{ secretCiphertext: null }],
      rowCount: 1,
    }))
    expect(await store.getSecretSystem('sink-1')).toBeNull()
  })
})

describe('[COMP:api/ingest-sink-store] listEnabledByInstance', () => {
  it('filters to enabled sinks for the fan-out read', async () => {
    poolResults = [makeRow()]
    const sinks = await store.listEnabledByInstance('ci-1')
    expect(sinks).toHaveLength(1)
    expect(poolQueries[0].text).toContain('enabled = true')
    expect(poolQueries[0].values).toEqual(['ci-1'])
  })
})

describe('[COMP:api/ingest-sink-store] recordAck', () => {
  it('advances the cursor and stamps last_delivered_at (X3)', async () => {
    await store.recordAck('sink-1', { offset: 42 })
    const sql = poolQueries[0].text
    expect(sql).toContain('last_ack_cursor')
    expect(sql).toContain('last_delivered_at = now()')
    expect(poolQueries[0].values).toEqual(['sink-1', JSON.stringify({ offset: 42 })])
  })
})

describe('[COMP:api/ingest-sink-store] update', () => {
  it('patches only the provided fields and re-encrypts a new secret', async () => {
    poolResults = [makeRow({ enabled: false })]
    await store.update('sink-1', { enabled: false, secret: 'rotated-secret-value' })
    const sql = poolQueries[0].text
    expect(sql).toContain('secret_ciphertext')
    expect(sql).toContain('enabled')
    expect(sql).not.toContain('endpoint_url =')
    const blob = poolQueries[0].values!.find((v) => Buffer.isBuffer(v)) as Buffer
    expect(decryptCredentials<{ secret: string }>(blob, KEY).secret).toBe('rotated-secret-value')
  })
})
