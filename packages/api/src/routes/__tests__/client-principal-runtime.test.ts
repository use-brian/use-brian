import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db/users.js', () => ({
  findOrCreateUser: vi.fn(),
  findUserByEmail: vi.fn(),
}))

import { findOrCreateUser, findUserByEmail } from '../../db/users.js'
import {
  applyPublicResearchToolCeiling,
  resolveApiKeyClientPrincipal,
  resolveExternalClientIdentity,
} from '../client-principal-runtime.js'

const API_KEY_ID = '00000000-0000-4000-8000-000000000010'
const ASSISTANT_ID = '00000000-0000-4000-8000-000000000011'

const shadow = {
  id: '00000000-0000-4000-8000-000000000012',
  email: null,
  name: 'api:client-17',
  authProvider: 'channel',
  authProviderId: `api:${API_KEY_ID}:client-17`,
}

const activeKey = {
  id: API_KEY_ID,
  assistantId: ASSISTANT_ID,
  name: 'Studio client key',
  prefix: 'sk_live_0000',
  scope: 'chat' as const,
  audience: 'external' as const,
  anonymousContext: 'thin' as const,
  toolPolicy: 'assistant' as const,
  status: 'active' as const,
  createdBy: null,
  createdAt: new Date(),
  lastUsedAt: null,
  keyHash: 'not-used-by-workflows',
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(findUserByEmail).mockResolvedValue(null)
  vi.mocked(findOrCreateUser).mockResolvedValue({ user: shadow, isNew: false } as never)
})

describe('[COMP:api/client-principal-runtime] reusable external-client authority', () => {
  it('uses the API-key namespace and never recovers stored claims', async () => {
    const result = await resolveExternalClientIdentity({
      identityNamespace: `api:${API_KEY_ID}`,
      externalUserId: 'client-17',
      identified: true,
    })

    expect(findUserByEmail).not.toHaveBeenCalled()
    expect(findOrCreateUser).toHaveBeenCalledWith({
      authProvider: 'channel',
      authProviderId: `api:${API_KEY_ID}:client-17`,
      name: undefined,
    })
    expect(result).toMatchObject({ identified: true, external: true })
  })

  it('revalidates the live key and returns the exact client memory/write compartment', async () => {
    const principal = await resolveApiKeyClientPrincipal({
      apiKeyStore: { getByIdSystem: vi.fn().mockResolvedValue(activeKey) },
      apiKeyId: API_KEY_ID,
      externalUserId: 'client-17',
      assistant: {
        id: ASSISTANT_ID,
        workspaceId: '00000000-0000-4000-8000-000000000013',
        kind: 'standard',
        clearance: 'internal',
      },
    })

    expect(principal.clientSelfMemory).toEqual({ compartment: 'client:client-17' })
    expect(principal.writeCompartments).toEqual(['client:client-17'])
  })

  it.each([
    [{ ...activeKey, status: 'revoked' }, 'client_principal_key_inactive'],
    [{ ...activeKey, audience: 'internal' }, 'client_principal_key_incompatible'],
    [{ ...activeKey, assistantId: '00000000-0000-4000-8000-000000000099' }, 'client_principal_assistant_mismatch'],
  ])('fails closed for an incompatible live key', async (key, reason) => {
    await expect(resolveApiKeyClientPrincipal({
      apiKeyStore: { getByIdSystem: vi.fn().mockResolvedValue(key) },
      apiKeyId: API_KEY_ID,
      externalUserId: 'client-17',
      assistant: {
        id: ASSISTANT_ID,
        workspaceId: '00000000-0000-4000-8000-000000000013',
        kind: 'standard',
        clearance: 'internal',
      },
    })).rejects.toMatchObject({ reason })
  })

  it('applies the same immutable public-research ceiling to background calls', () => {
    const tools = new Map([['webSearch', 1], ['urlReader', 2], ['getContact', 3]])
    const limited = applyPublicResearchToolCeiling({
      tools,
      toolPolicy: 'public_research',
      internalScope: false,
      allowPublicResearch: false,
    })
    expect(limited).toBe(true)
    expect([...tools.keys()]).toEqual([])
  })
})
