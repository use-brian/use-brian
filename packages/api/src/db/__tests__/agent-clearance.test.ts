import { describe, it, expect } from 'vitest'
import {
  currentAgentClearance,
  currentAgentCompartments,
  runWithAgentAccess,
  runWithAgentClearance,
} from '../client.js'

/**
 * The agent-principal clearance context (teamspaces — assistant access).
 * Spec: docs/architecture/features/teamspaces.md → "Agent access".
 *
 * The ALS wrap is the trust boundary for the `saved_views` policy's agent
 * leg (migration 415): present → `applyRLSGucs` sets `app.agent_clearance`
 * and teamspace pages resolve by clearance vs sensitivity; absent → the
 * membership model applies unchanged. These tests pin the fail-closed
 * semantics the SQL relies on.
 */
describe('[COMP:api/agent-clearance] runWithAgentClearance / currentAgentClearance', () => {
  it('has no agent context by default', () => {
    expect(currentAgentClearance()).toBeUndefined()
    expect(currentAgentCompartments()).toBeUndefined()
  })

  it('carries the canonical Team grant and preserves null as universe', async () => {
    await runWithAgentAccess(
      { clearance: 'internal', compartments: ['team:sales', 'team:sales', 'team:strategy'] },
      async () => {
        await Promise.resolve()
        expect(currentAgentClearance()).toBe('internal')
        expect(currentAgentCompartments()).toEqual(['team:sales', 'team:strategy'])
      },
    )
    await runWithAgentAccess(
      { clearance: 'confidential', compartments: null },
      async () => expect(currentAgentCompartments()).toBeNull(),
    )
    expect(currentAgentCompartments()).toBeUndefined()
  })

  it('keeps a legacy clearance-only wrap distinguishable so linked Teams fail closed', () => {
    runWithAgentClearance('internal', () => {
      expect(currentAgentClearance()).toBe('internal')
      expect(currentAgentCompartments()).toBeUndefined()
    })
  })

  it('carries the clearance across awaits inside the wrap, and not outside it', async () => {
    const seen: Array<string | undefined> = []
    await runWithAgentClearance('internal', async () => {
      seen.push(currentAgentClearance())
      await Promise.resolve()
      seen.push(currentAgentClearance())
    })
    expect(seen).toEqual(['internal', 'internal'])
    expect(currentAgentClearance()).toBeUndefined()
  })

  it('accepts exactly the three sensitivity tiers', async () => {
    for (const tier of ['public', 'internal', 'confidential'] as const) {
      await runWithAgentClearance(tier, async () => {
        expect(currentAgentClearance()).toBe(tier)
      })
    }
  })

  it('fails closed on an unknown or absent clearance (runs WITHOUT agent context)', async () => {
    for (const bogus of ['CONFIDENTIAL', 'secret', '', null, undefined]) {
      await runWithAgentClearance(bogus as never, async () => {
        expect(currentAgentClearance()).toBeUndefined()
      })
    }
  })

  it('nested wraps: the innermost clearance wins, and unwinds correctly', async () => {
    await runWithAgentClearance('confidential', async () => {
      expect(currentAgentClearance()).toBe('confidential')
      await runWithAgentClearance('public', async () => {
        expect(currentAgentClearance()).toBe('public')
        expect(currentAgentCompartments()).toBeUndefined()
      })
      expect(currentAgentClearance()).toBe('confidential')
    })
  })

  it('does not leak between sibling async branches', async () => {
    const results = await Promise.all([
      runWithAgentClearance('internal', async () => {
        await new Promise((r) => setTimeout(r, 5))
        return currentAgentClearance()
      }),
      (async () => {
        await new Promise((r) => setTimeout(r, 1))
        return currentAgentClearance()
      })(),
    ])
    expect(results).toEqual(['internal', undefined])
  })
})
