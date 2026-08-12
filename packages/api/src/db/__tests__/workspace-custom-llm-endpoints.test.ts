import { randomBytes } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getAppPool: vi.fn(),
  applyRLSGucs: vi.fn(),
  rollbackAndRelease: vi.fn(),
}))

import { getAppPool, query, queryWithRLS } from '../client.js'
import {
  createDbWorkspaceCustomLlmEndpointStore,
  CustomLlmEncryptionKeyRequiredError,
} from '../workspace-custom-llm-endpoints.js'
import { decryptApiKey } from '../workspace-llm-provider-settings.js'

const mockQuery = vi.mocked(query)
const mockQueryWithRLS = vi.mocked(queryWithRLS)
const mockGetAppPool = vi.mocked(getAppPool)

const workspaceId = '00000000-0000-4000-8000-000000000010'
const endpointRow = {
  id: '00000000-0000-4000-8000-000000000001',
  workspaceId,
  name: 'Local gateway',
  baseUrl: 'http://model.example/v1',
  hasApiKey: true,
  createdAt: new Date(),
  updatedAt: new Date(),
}
const profileRow = {
  id: endpointRow.id,
  endpointId: endpointRow.id,
  workspaceId,
  name: 'Balanced',
  modelId: 'local-balanced',
  contextWindow: 32768,
  maxOutputTokens: 4096,
  supportsTools: true,
  verifiedAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
}

function mockCreateTransaction() {
  const clientQuery = vi.fn()
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({ rows: [endpointRow], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [profileRow], rowCount: 1 })
    .mockResolvedValueOnce({})
  mockGetAppPool.mockReturnValue({
    connect: vi.fn().mockResolvedValue({ query: clientQuery }),
  } as never)
  return clientQuery
}

beforeEach(() => vi.clearAllMocks())

describe('[COMP:api/custom-llm-endpoints] custom connection/profile store', () => {
  it('stores the bearer key once on the connection and creates its first profile atomically', async () => {
    const key = randomBytes(32)
    const store = createDbWorkspaceCustomLlmEndpointStore(key)
    const clientQuery = mockCreateTransaction()
    const result = await store.create({
      actingUserId: 'user-1',
      workspaceId,
      input: {
        name: 'Local gateway',
        baseUrl: endpointRow.baseUrl,
        apiKey: 'private-token-1234',
        modelId: profileRow.modelId,
        contextWindow: 32768,
        maxOutputTokens: 4096,
        supportsTools: true,
        verifiedAt: new Date(),
      },
    })
    const endpointParams = clientQuery.mock.calls[1]![1] as unknown[]
    expect(decryptApiKey(endpointParams[4] as Buffer, key)).toBe('private-token-1234')
    expect(result).toMatchObject({ name: endpointRow.name, profiles: [profileRow] })
    expect(JSON.stringify(result)).not.toContain('private-token-1234')
  })

  it('allows a no-auth connection without an encryption key', async () => {
    const store = createDbWorkspaceCustomLlmEndpointStore()
    const clientQuery = mockCreateTransaction()
    await store.create({
      actingUserId: 'user-1', workspaceId,
      input: {
        name: endpointRow.name, baseUrl: endpointRow.baseUrl, apiKey: null,
        modelId: profileRow.modelId, contextWindow: 32768, maxOutputTokens: 4096,
        supportsTools: true, verifiedAt: new Date(),
      },
    })
    expect((clientQuery.mock.calls[1]![1] as unknown[])[4]).toBeNull()
  })

  it('fails closed before opening a transaction when a bearer key cannot be encrypted', async () => {
    const store = createDbWorkspaceCustomLlmEndpointStore()
    await expect(store.create({
      actingUserId: 'user-1', workspaceId,
      input: {
        name: endpointRow.name, baseUrl: endpointRow.baseUrl, apiKey: 'secret',
        modelId: profileRow.modelId, contextWindow: 32768, maxOutputTokens: 4096,
        supportsTools: true, verifiedAt: new Date(),
      },
    })).rejects.toBeInstanceOf(CustomLlmEncryptionKeyRequiredError)
    expect(mockGetAppPool).not.toHaveBeenCalled()
  })

  it('groups profiles under their reusable endpoint on administrative reads', async () => {
    const store = createDbWorkspaceCustomLlmEndpointStore()
    mockQueryWithRLS
      .mockResolvedValueOnce({ rows: [endpointRow], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [profileRow], rowCount: 1 } as never)
    await expect(store.list({ actingUserId: 'user-1', workspaceId }))
      .resolves.toEqual([{ ...endpointRow, profiles: [profileRow] }])
  })

  it('updates a verified profile in place without changing its selector identity', async () => {
    const store = createDbWorkspaceCustomLlmEndpointStore()
    const verifiedAt = new Date('2026-08-12T00:00:00Z')
    const updated = {
      ...profileRow,
      name: 'High context',
      modelId: 'terra-high',
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      verifiedAt,
    }
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [updated], rowCount: 1 } as never)

    await expect(store.updateProfile({
      actingUserId: 'user-1',
      workspaceId,
      endpointId: endpointRow.id,
      profileId: profileRow.id,
      input: {
        name: updated.name,
        modelId: updated.modelId,
        contextWindow: updated.contextWindow,
        maxOutputTokens: updated.maxOutputTokens,
        supportsTools: true,
        verifiedAt,
      },
    })).resolves.toEqual(updated)

    expect(mockQueryWithRLS.mock.calls[0]![1]).toContain('UPDATE workspace_custom_llm_profiles')
    expect(mockQueryWithRLS.mock.calls[0]![2]).toEqual([
      workspaceId,
      endpointRow.id,
      profileRow.id,
      'High context',
      'terra-high',
      1_048_576,
      65_536,
      verifiedAt,
    ])
  })

  it('decrypts connection auth only through a profile runtime accessor', async () => {
    const key = randomBytes(32)
    const store = createDbWorkspaceCustomLlmEndpointStore(key)
    const encrypted = Buffer.concat([Buffer.alloc(12), Buffer.alloc(16), Buffer.from('unused')])
    // Use a real encrypted value captured through the public helper path.
    const clientQuery = mockCreateTransaction()
    await store.create({
      actingUserId: 'user-1', workspaceId,
      input: {
        name: endpointRow.name, baseUrl: endpointRow.baseUrl, apiKey: 'system-only',
        modelId: profileRow.modelId, contextWindow: 32768, maxOutputTokens: 4096,
        supportsTools: true, verifiedAt: new Date(),
      },
    })
    const realEncrypted = (clientQuery.mock.calls[1]![1] as unknown[])[4] as Buffer
    expect(encrypted).not.toEqual(realEncrypted)
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...profileRow, endpointName: endpointRow.name, baseUrl: endpointRow.baseUrl, apiKeyEncrypted: realEncrypted }],
      rowCount: 1,
    } as never)
    await expect(store.getRuntimeSystem({ workspaceId, profileId: profileRow.id }))
      .resolves.toMatchObject({ apiKey: 'system-only', id: profileRow.id, endpointId: endpointRow.id })
  })

  it('persists one independent custom profile assignment per Brian tier', async () => {
    const store = createDbWorkspaceCustomLlmEndpointStore()
    const setting = { workspaceId, tier: 'max', profileId: profileRow.id, updatedAt: new Date() }
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [setting], rowCount: 1 } as never)
    await expect(store.setTierDefault({
      actingUserId: 'user-1', workspaceId, tier: 'max', profileId: profileRow.id,
    })).resolves.toEqual(setting)
    expect(mockQueryWithRLS.mock.calls[0]![2]).toEqual([workspaceId, 'max', profileRow.id, 'user-1'])
  })
})
