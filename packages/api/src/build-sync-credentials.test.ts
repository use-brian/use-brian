import { describe, it, expect, vi } from 'vitest'
import { buildOpenSyncCredentials } from './build-sync-credentials.js'

// Minimal store doubles — only the methods the resolver touches.
function makeDeps(overrides?: {
  getCredentialsSystem?: (id: string) => Promise<{ client_secret?: string } | null>
  findByWorkspaceProviderSystem?: (workspaceId: string, provider: string) => Promise<{ id: string } | null>
  findGrantedInstanceByProviderSystem?: (t: string, id: string, provider: string) => Promise<{ id: string } | null>
}) {
  const getCredentialsSystem = vi.fn(overrides?.getCredentialsSystem ?? (async () => ({ client_secret: 'pat-default' })))
  const findByWorkspaceProviderSystem = vi.fn(overrides?.findByWorkspaceProviderSystem ?? (async () => null))
  const findGrantedInstanceByProviderSystem = vi.fn(overrides?.findGrantedInstanceByProviderSystem ?? (async () => null))
  const deps = {
    connectorInstanceStore: { getCredentialsSystem, findByWorkspaceProviderSystem } as never,
    connectorGrantStore: { findGrantedInstanceByProviderSystem } as never,
  }
  return { deps, getCredentialsSystem, findByWorkspaceProviderSystem, findGrantedInstanceByProviderSystem }
}

describe('[COMP:knowledge/sync-credentials] Open sync-credential resolver', () => {
  it('reads the bound instance credentials directly when connectorInstanceId is set', async () => {
    const { deps, getCredentialsSystem, findByWorkspaceProviderSystem } = makeDeps({
      getCredentialsSystem: async (id) => ({ client_secret: `pat-${id}` }),
    })
    const creds = buildOpenSyncCredentials(deps)

    const pat = await creds.getPat('ws-1', 'inst-9')

    expect(pat).toBe('pat-inst-9')
    expect(getCredentialsSystem).toHaveBeenCalledWith('inst-9')
    // No by-workspace lookup when the source carries its bound instance.
    expect(findByWorkspaceProviderSystem).not.toHaveBeenCalled()
  })

  it('falls back to the team-native instance for a legacy source (null connectorInstanceId)', async () => {
    const { deps, getCredentialsSystem } = makeDeps({
      findByWorkspaceProviderSystem: async () => ({ id: 'team-native' }),
      getCredentialsSystem: async (id) => ({ client_secret: `pat-${id}` }),
    })
    const creds = buildOpenSyncCredentials(deps)

    const pat = await creds.getPat('ws-1', null)

    expect(pat).toBe('pat-team-native')
    expect(getCredentialsSystem).toHaveBeenCalledWith('team-native')
  })

  it('falls back to a granted personal instance when no team-native instance exists', async () => {
    const { deps, findGrantedInstanceByProviderSystem } = makeDeps({
      findByWorkspaceProviderSystem: async () => null,
      findGrantedInstanceByProviderSystem: async () => ({ id: 'granted' }),
      getCredentialsSystem: async (id) => ({ client_secret: `pat-${id}` }),
    })
    const creds = buildOpenSyncCredentials(deps)

    const pat = await creds.getPat('ws-1', null)

    expect(pat).toBe('pat-granted')
    expect(findGrantedInstanceByProviderSystem).toHaveBeenCalledWith('workspace', 'ws-1', 'github')
  })

  it('throws a connect-prompt error when no GitHub connector resolves for a legacy source', async () => {
    const { deps } = makeDeps({ findByWorkspaceProviderSystem: async () => null, findGrantedInstanceByProviderSystem: async () => null })
    const creds = buildOpenSyncCredentials(deps)

    await expect(creds.getPat('ws-1', null)).rejects.toThrow(/No GitHub connector/)
  })

  it('throws when the resolved instance has no stored credentials', async () => {
    const { deps } = makeDeps({ getCredentialsSystem: async () => null })
    const creds = buildOpenSyncCredentials(deps)

    await expect(creds.getPat('ws-1', 'inst-9')).rejects.toThrow(/no stored credentials/)
  })
})
