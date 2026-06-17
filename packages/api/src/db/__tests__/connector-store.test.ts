/**
 * Unit tests for the MCP connector store (legacy shim over connector_instance).
 * Component tag: [COMP:api/connector-store].
 *
 * Mocks `query` / `queryWithRLS` and the credential encryption helpers.
 * Verifies createDbConnectorStore: the user-scoped list, the upsert's
 * update-existing vs insert-new branches, the credentials-without-key
 * guard, credential encryption on write, setConnected's row/null result,
 * getCredentials decryption, getConfig's {} default, and delete's
 * rowCount-driven boolean.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
}))
vi.mock('../credential-crypto.js', () => ({
  encryptCredentials: vi.fn(),
  decryptCredentials: vi.fn(),
}))

import { createDbConnectorStore } from '../connector-store.js'
import { queryWithRLS } from '../client.js'
import { encryptCredentials, decryptCredentials } from '../credential-crypto.js'

const mockRls = vi.mocked(queryWithRLS)
const mockEncrypt = vi.mocked(encryptCredentials)
const mockDecrypt = vi.mocked(decryptCredentials)

const KEY = Buffer.from('test-key')

function connectorRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ci-1',
    userId: 'u-1',
    connectorId: 'gmail',
    name: 'Gmail',
    url: null,
    custom: false,
    connected: true,
    createdAt: new Date('2026-05-16T00:00:00Z'),
    updatedAt: new Date('2026-05-16T00:00:00Z'),
    ...over,
  }
}

beforeEach(() => {
  mockRls.mockReset()
  mockEncrypt.mockReset()
  mockDecrypt.mockReset()
})

describe('[COMP:api/connector-store] list', () => {
  it('reads user-scoped connector_instance rows', async () => {
    mockRls.mockResolvedValueOnce({ rows: [connectorRow()], rowCount: 1 } as never)
    const out = await createDbConnectorStore(KEY).list('u-1')
    expect(out).toHaveLength(1)
    const [userId, sql, params] = mockRls.mock.calls[0]
    expect(userId).toBe('u-1')
    expect(sql).toContain("scope = 'user'")
    expect(params).toEqual(['u-1'])
  })
})

describe('[COMP:api/connector-store] upsert', () => {
  it('updates the first matching row when one already exists', async () => {
    mockRls
      .mockResolvedValueOnce({ rows: [{ id: 'ci-1' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [connectorRow()], rowCount: 1 } as never)
    const out = await createDbConnectorStore(KEY).upsert('u-1', { connectorId: 'gmail', name: 'Gmail' })
    expect(out.connectorId).toBe('gmail')
    expect(mockRls.mock.calls[1][1]).toContain('UPDATE connector_instance')
  })

  it('inserts a new user-scoped row when none exists', async () => {
    mockRls
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [connectorRow()], rowCount: 1 } as never)
    await createDbConnectorStore(KEY).upsert('u-1', { connectorId: 'gmail', name: 'Gmail' })
    expect(mockRls.mock.calls[1][1]).toContain('INSERT INTO connector_instance')
  })

  it('throws when credentials are supplied but no encryption key is configured', async () => {
    await expect(
      createDbConnectorStore(null).upsert('u-1', {
        connectorId: 'gmail',
        name: 'Gmail',
        credentials: { client_id: 'x', client_secret: 'y' },
      }),
    ).rejects.toThrow(/CHANNEL_CREDENTIAL_KEY/)
  })

  it('encrypts supplied credentials before storing them', async () => {
    mockEncrypt.mockReturnValueOnce(Buffer.from('encrypted') as never)
    mockRls
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [connectorRow()], rowCount: 1 } as never)
    await createDbConnectorStore(KEY).upsert('u-1', {
      connectorId: 'gmail',
      name: 'Gmail',
      credentials: { client_id: 'x', client_secret: 'y' },
    })
    expect(mockEncrypt).toHaveBeenCalledOnce()
  })

  it('derives credentials_type from the credential blob on insert', async () => {
    mockEncrypt.mockReturnValueOnce(Buffer.from('encrypted') as never)
    mockRls
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [connectorRow()], rowCount: 1 } as never)
    await createDbConnectorStore(KEY).upsert('u-1', {
      connectorId: 'cx-1',
      name: 'Trading',
      custom: true,
      credentials: { type: 'bearer', token: 't' },
    })
    const [, sql, params] = mockRls.mock.calls[1]
    expect(sql).toContain('credentials_type')
    // (scope const, $1 user, $2 provider, $3 label, $4 url, $5 custom,
    //  $6 credentials, $7 credentials_type, $8 connected)
    expect((params as unknown[])[6]).toBe('bearer')
  })

  it('keeps stored credentials and type when an update supplies neither', async () => {
    mockRls
      .mockResolvedValueOnce({ rows: [{ id: 'ci-1' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [connectorRow()], rowCount: 1 } as never)
    await createDbConnectorStore(KEY).upsert('u-1', { connectorId: 'cx-1', name: 'Renamed' })
    const [, sql, params] = mockRls.mock.calls[1]
    // COALESCE keeps the blob; the CASE keeps credentials_type unless
    // clearing or replacing.
    expect(sql).toContain('COALESCE($5, credentials)')
    expect((params as unknown[])[4]).toBeNull()   // no new blob
    expect((params as unknown[])[5]).toBe(false)  // not clearing
  })

  it('clears credentials and resets the type when clearCredentials is set', async () => {
    mockRls
      .mockResolvedValueOnce({ rows: [{ id: 'ci-1' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [connectorRow()], rowCount: 1 } as never)
    await createDbConnectorStore(KEY).upsert('u-1', {
      connectorId: 'cx-1',
      name: 'Trading',
      clearCredentials: true,
    })
    const [, sql, params] = mockRls.mock.calls[1]
    expect(sql).toContain("WHEN $6 THEN 'none'")
    expect((params as unknown[])[5]).toBe(true)
  })
})

describe('[COMP:api/connector-store] setConnected / getCredentials / getConfig / delete', () => {
  it('setConnected returns the updated row, or null when nothing matched', async () => {
    mockRls.mockResolvedValueOnce({ rows: [connectorRow({ connected: false })], rowCount: 1 } as never)
    expect((await createDbConnectorStore(KEY).setConnected('u-1', 'gmail', false))?.connected).toBe(false)

    mockRls.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await createDbConnectorStore(KEY).setConnected('u-1', 'ghost', true)).toBeNull()
  })

  it('getCredentials decrypts the stored buffer for a connected connector', async () => {
    mockRls.mockResolvedValueOnce({ rows: [{ credentials: Buffer.from('enc') }], rowCount: 1 } as never)
    mockDecrypt.mockReturnValueOnce({ client_id: 'cid', client_secret: 'sec' } as never)
    expect(await createDbConnectorStore(KEY).getCredentials('u-1', 'gmail')).toEqual({
      client_id: 'cid',
      client_secret: 'sec',
    })
  })

  it('getCredentials returns null when there is no stored credential row', async () => {
    mockRls.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await createDbConnectorStore(KEY).getCredentials('u-1', 'gmail')).toBeNull()
  })

  it('getAuthCredentials reads without the connected filter and normalizes the blob', async () => {
    mockRls.mockResolvedValueOnce({ rows: [{ credentials: Buffer.from('enc') }], rowCount: 1 } as never)
    mockDecrypt.mockReturnValueOnce({ type: 'bearer', token: 't1' } as never)
    const out = await createDbConnectorStore(KEY).getAuthCredentials('u-1', 'cx-1')
    expect(out).toEqual({ type: 'bearer', token: 't1' })
    // The probe must read creds of a not-yet-connected row.
    expect(mockRls.mock.calls[0][1]).not.toContain('connected = true')
  })

  it('getAuthCredentials stamps a legacy oauth-shaped blob with type oauth', async () => {
    mockRls.mockResolvedValueOnce({ rows: [{ credentials: Buffer.from('enc') }], rowCount: 1 } as never)
    mockDecrypt.mockReturnValueOnce({ client_id: 'cid', client_secret: 'sec' } as never)
    expect(await createDbConnectorStore(KEY).getAuthCredentials('u-1', 'cx-1')).toEqual({
      type: 'oauth',
      client_id: 'cid',
      client_secret: 'sec',
    })
  })

  it('getConfig returns the stored config, or {} when there is no row', async () => {
    mockRls.mockResolvedValueOnce({ rows: [{ config: { region: 'us' } }], rowCount: 1 } as never)
    expect(await createDbConnectorStore(KEY).getConfig('u-1', 'gmail')).toEqual({ region: 'us' })

    mockRls.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await createDbConnectorStore(KEY).getConfig('u-1', 'ghost')).toEqual({})
  })

  it('delete reports whether a row was removed', async () => {
    mockRls.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    expect(await createDbConnectorStore(KEY).delete('u-1', 'gmail')).toBe(true)

    mockRls.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await createDbConnectorStore(KEY).delete('u-1', 'ghost')).toBe(false)
  })
})
