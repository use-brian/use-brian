import { randomBytes } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getAppPool: vi.fn(),
  applyRLSGucs: vi.fn(),
  rollbackAndRelease: vi.fn(),
}))

import { query, queryWithRLS } from '../client.js'
import {
  createDbWorkspaceCustomLlmEndpointStore,
  CustomLlmEncryptionKeyRequiredError,
} from '../workspace-custom-llm-endpoints.js'
import { decryptApiKey } from '../workspace-llm-provider-settings.js'

const mockQuery = vi.mocked(query)
const mockQueryWithRLS = vi.mocked(queryWithRLS)

const publicRow = {
  id: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000010',
  name: 'Local',
  baseUrl: 'http://model.example/v1',
  modelId: 'llama-local',
  contextWindow: 32768,
  maxOutputTokens: 4096,
  supportsTools: true,
  verifiedAt: new Date(),
  isDefault: true,
  hasApiKey: true,
  createdAt: new Date(),
  updatedAt: new Date(),
}

beforeEach(() => vi.clearAllMocks())

describe('[COMP:api/custom-llm-endpoints] custom endpoint store', () => {
  it('encrypts a bearer key and never returns it from the administrative row', async () => {
    const key = randomBytes(32)
    const store = createDbWorkspaceCustomLlmEndpointStore(key)
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [publicRow], rowCount: 1 } as never)
    const result = await store.create({
      actingUserId: 'user-1',
      workspaceId: publicRow.workspaceId,
      input: {
        name: 'Local',
        baseUrl: 'http://model.example/v1',
        apiKey: 'private-token-1234',
        modelId: 'llama-local',
        contextWindow: 32768,
        maxOutputTokens: 4096,
        supportsTools: true,
        verifiedAt: new Date(),
        isDefault: false,
      },
    })
    const params = mockQueryWithRLS.mock.calls[0]![2] as unknown[]
    const encrypted = params[3] as Buffer
    expect(decryptApiKey(encrypted, key)).toBe('private-token-1234')
    expect(result).toEqual(publicRow)
    expect(JSON.stringify(result)).not.toContain('private-token-1234')
  })

  it('allows an unauthenticated local endpoint without an encryption key', async () => {
    const store = createDbWorkspaceCustomLlmEndpointStore()
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [{ ...publicRow, hasApiKey: false }], rowCount: 1 } as never)
    await store.create({
      actingUserId: 'user-1',
      workspaceId: publicRow.workspaceId,
      input: {
        name: 'Local', baseUrl: publicRow.baseUrl, apiKey: null, modelId: publicRow.modelId,
        contextWindow: 32768, maxOutputTokens: 4096, supportsTools: true,
        verifiedAt: new Date(),
      },
    })
    expect((mockQueryWithRLS.mock.calls[0]![2] as unknown[])[3]).toBeNull()
  })

  it('fails closed when a bearer key cannot be encrypted', async () => {
    const store = createDbWorkspaceCustomLlmEndpointStore()
    await expect(store.create({
      actingUserId: 'user-1',
      workspaceId: publicRow.workspaceId,
      input: {
        name: 'Local', baseUrl: publicRow.baseUrl, apiKey: 'secret', modelId: publicRow.modelId,
        contextWindow: 32768, maxOutputTokens: 4096, supportsTools: true,
        verifiedAt: new Date(),
      },
    })).rejects.toBeInstanceOf(CustomLlmEncryptionKeyRequiredError)
    expect(mockQueryWithRLS).not.toHaveBeenCalled()
  })

  it('decrypts a credential only through the system runtime accessor', async () => {
    const key = randomBytes(32)
    const store = createDbWorkspaceCustomLlmEndpointStore(key)
    // Capture a real encrypted blob through create.
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [publicRow], rowCount: 1 } as never)
    await store.create({
      actingUserId: 'user-1', workspaceId: publicRow.workspaceId,
      input: {
        name: 'Local', baseUrl: publicRow.baseUrl, apiKey: 'system-only', modelId: publicRow.modelId,
        contextWindow: 32768, maxOutputTokens: 4096, supportsTools: true,
        verifiedAt: new Date(),
      },
    })
    const encrypted = (mockQueryWithRLS.mock.calls[0]![2] as unknown[])[3] as Buffer
    mockQuery.mockResolvedValueOnce({ rows: [{ ...publicRow, apiKeyEncrypted: encrypted }], rowCount: 1 } as never)
    await expect(store.getRuntimeSystem({ workspaceId: publicRow.workspaceId, endpointId: publicRow.id }))
      .resolves.toMatchObject({ apiKey: 'system-only', id: publicRow.id })
  })
})
