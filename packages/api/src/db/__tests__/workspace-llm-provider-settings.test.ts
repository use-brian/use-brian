import { randomBytes } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
}))

import {
  createDbWorkspaceLlmProviderSettingsStore,
  decryptApiKey,
} from '../workspace-llm-provider-settings.js'
import { query, queryWithRLS } from '../client.js'

const mockQuery = vi.mocked(query)
const mockQueryWithRLS = vi.mocked(queryWithRLS)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('[COMP:api/workspace-llm-provider-settings] Workspace LLM provider settings store', () => {
  it('round-trips a stored encrypted key through the system decrypt accessor', async () => {
    const key = randomBytes(32)
    const store = createDbWorkspaceLlmProviderSettingsStore(key)
    const apiKey = 'AIzaSyD-workspace-secret-key'

    mockQueryWithRLS.mockResolvedValueOnce({
      rows: [{
        id: 'setting_1',
        workspaceId: 'workspace_1',
        provider: 'gemini',
        isByok: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      }],
      rowCount: 1,
    } as never)

    await store.set({
      actingUserId: 'user_1',
      workspaceId: 'workspace_1',
      apiKey,
    })

    const [, , setParams] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    const encrypted = setParams[2] as Buffer
    expect(encrypted.equals(Buffer.from(apiKey, 'utf8'))).toBe(false)
    expect(decryptApiKey(encrypted, key)).toBe(apiKey)

    mockQuery.mockResolvedValueOnce({
      rows: [{ api_key_encrypted: encrypted }],
      rowCount: 1,
    } as never)

    await expect(
      store.getPlaintextKeySystem({ workspaceId: 'workspace_1' }),
    ).resolves.toBe(apiKey)
  })

  it('masked accessor exposes only presence and last4, never the full plaintext key', async () => {
    const key = randomBytes(32)
    const store = createDbWorkspaceLlmProviderSettingsStore(key)
    const apiKey = 'AIzaSyD-do-not-return-this-full-key'

    mockQueryWithRLS.mockResolvedValueOnce({
      rows: [{
        id: 'setting_1',
        workspaceId: 'workspace_1',
        provider: 'gemini',
        isByok: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      }],
      rowCount: 1,
    } as never)
    await store.set({
      actingUserId: 'user_1',
      workspaceId: 'workspace_1',
      apiKey,
    })

    const [, , setParams] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    const encrypted = setParams[2] as Buffer

    mockQueryWithRLS.mockResolvedValueOnce({
      rows: [{ api_key_encrypted: encrypted }],
      rowCount: 1,
    } as never)

    const masked = await store.getMasked({
      actingUserId: 'user_1',
      workspaceId: 'workspace_1',
    })

    expect(masked).toEqual({
      provider: 'gemini',
      isSet: true,
      last4: '-key',
    })
    expect(JSON.stringify(masked)).not.toContain(apiKey)
  })
})
