import { describe, expect, it, vi } from 'vitest'
import type { ConnectorGrantStore } from '../../db/connector-grant-store.js'
import type { ConnectorInstanceStore } from '../../db/connector-instance-store.js'
import { createSyncCredentialProvider } from '../sync-credentials.js'

function stores(options: { team?: string; granted?: string; credentials?: Record<string, { client_secret: string }> }) {
  const instanceStore = {
    findByWorkspaceProviderSystem: vi.fn(async () => options.team ? ({ id: options.team } as never) : null),
    getCredentialsSystem: vi.fn(async (id: string) => options.credentials?.[id] ?? null),
  } as unknown as ConnectorInstanceStore
  const grantStore = {
    findGrantedInstanceByProviderSystem: vi.fn(async () => options.granted ? ({ id: options.granted } as never) : null),
  } as unknown as ConnectorGrantStore
  return { instanceStore, grantStore }
}

describe('[COMP:api/knowledge-sync-credentials] GitHub PAT resolution', () => {
  it('reads the exact bound connector and never falls back', async () => {
    const deps = stores({ team: 'stale', credentials: { bound: { client_secret: 'bound-pat' } } })
    expect(await createSyncCredentialProvider(deps.instanceStore, deps.grantStore).getPat('ws', 'bound')).toBe('bound-pat')
    expect(deps.instanceStore.findByWorkspaceProviderSystem).not.toHaveBeenCalled()
  })

  it('fails loudly when the bound connector lacks credentials', async () => {
    const deps = stores({})
    await expect(createSyncCredentialProvider(deps.instanceStore, deps.grantStore).getPat('ws', 'bound'))
      .rejects.toThrow(/has no stored credentials/)
  })

  it('uses team-native credentials for a legacy source', async () => {
    const deps = stores({ team: 'team', credentials: { team: { client_secret: 'team-pat' } } })
    expect(await createSyncCredentialProvider(deps.instanceStore, deps.grantStore).getPat('ws', null)).toBe('team-pat')
  })

  it('falls through a disconnected team connector to a granted connector', async () => {
    const deps = stores({ team: 'dead', granted: 'personal', credentials: { personal: { client_secret: 'personal-pat' } } })
    expect(await createSyncCredentialProvider(deps.instanceStore, deps.grantStore).getPat('ws', null)).toBe('personal-pat')
  })

  it('distinguishes missing connectors from missing credentials', async () => {
    const missing = stores({})
    await expect(createSyncCredentialProvider(missing.instanceStore, missing.grantStore).getPat('ws', null))
      .rejects.toThrow(/no GitHub connector exposed/)
    const disconnected = stores({ team: 'dead' })
    await expect(createSyncCredentialProvider(disconnected.instanceStore, disconnected.grantStore).getPat('ws', null))
      .rejects.toThrow(/no stored credentials/)
  })
})
