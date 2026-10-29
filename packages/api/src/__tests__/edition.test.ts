import { afterEach, describe, expect, it, vi } from 'vitest'
import { deploymentCapabilitiesFor } from '@use-brian/shared/deployment-capabilities'
import { isSelfManagedProviderEnv, usesOpenStandaloneRoutes } from '../edition.js'

afterEach(() => vi.unstubAllEnvs())

describe('[COMP:api/deployment-edition] standalone route ownership', () => {
  it('includes OSS and Outpost but excludes hosted', () => {
    expect(usesOpenStandaloneRoutes('oss')).toBe(true)
    expect(usesOpenStandaloneRoutes('outpost')).toBe(true)
    expect(usesOpenStandaloneRoutes('hosted')).toBe(false)
  })

  it.each(['oss', 'outpost', 'hosted'] as const)('aligns %s provider support with the Settings capability', (profile) => {
    vi.stubEnv('USEBRIAN_EDITION', profile)
    vi.stubEnv('K_SERVICE', '')
    expect(isSelfManagedProviderEnv()).toBe(deploymentCapabilitiesFor(profile).selfManagedProviders)
  })

  it('allows Outpost providers without enabling local-owner authentication', () => {
    vi.stubEnv('USEBRIAN_EDITION', 'outpost')
    vi.stubEnv('K_SERVICE', '')
    expect(isSelfManagedProviderEnv()).toBe(true)
    expect(deploymentCapabilitiesFor('outpost').localOwnerSession).toBe(false)
  })

  it.each(['oss', 'outpost'])('excludes %s local provider runtimes on Cloud Run', (profile) => {
    vi.stubEnv('USEBRIAN_EDITION', profile)
    vi.stubEnv('K_SERVICE', 'brian-api')
    expect(isSelfManagedProviderEnv()).toBe(false)
  })
})
