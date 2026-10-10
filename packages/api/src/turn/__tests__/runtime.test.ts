import { afterEach, describe, expect, it } from 'vitest'
import { configureTurnKernel, resetTurnKernelForTests, turnInference, withTurnInference } from '../runtime.js'

describe('[COMP:api/turn-kernel] boot-registered inference wiring', () => {
  afterEach(() => resetTurnKernelForTests())

  const resolver = async () => null
  const providers = new Set(['gemini']) as never

  it('falls back to the boot registration when a route did not thread the wiring', () => {
    configureTurnKernel({ resolveWorkspaceCustomLlm: resolver, configuredProviders: providers })
    const wired = withTurnInference({ name: 'route' } as { name: string; resolveWorkspaceCustomLlm?: typeof resolver; configuredProviders?: never })
    expect(wired.resolveWorkspaceCustomLlm).toBe(resolver)
    expect(wired.configuredProviders).toBe(providers)
    expect(wired.name).toBe('route')
  })

  it('prefers an explicitly threaded value', () => {
    configureTurnKernel({ resolveWorkspaceCustomLlm: resolver, configuredProviders: providers })
    const own = async () => null
    expect(turnInference({ resolveWorkspaceCustomLlm: own }).resolveWorkspaceCustomLlm).toBe(own)
  })

  it('is empty without a registration (unit tests, no boot)', () => {
    expect(turnInference()).toEqual({ resolveWorkspaceCustomLlm: null, configuredProviders: undefined })
  })
})
