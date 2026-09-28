import { describe, it, expect } from 'vitest'
import {
  currentAgentAccess,
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

  it('nested wraps: a narrower clearance wins, and unwinds correctly', async () => {
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


describe('[COMP:api/agent-access-ceiling] inherited execution ceiling',()=>{
  const parent={workspaceId:'workspace',userId:'actor',clearance:'internal' as const,compartments:['product'],mutationCompartments:['product'],projectIds:['project'],visibilityAssistantIds:['caller']}
  it('does not widen any axis through a more privileged nested context',()=>{
    runWithAgentAccess(parent,()=>runWithAgentAccess({clearance:'confidential',compartments:null,projectIds:null,visibilityAssistantIds:null},()=>{
      expect(currentAgentAccess()).toEqual(parent)
    }))
  })
  it.each(['workspaceId','userId'] as const)('rejects a nested %s substitution',axis=>{
    runWithAgentAccess(parent,()=>expect(()=>runWithAgentAccess({...parent,[axis]:'other'},()=>{})).toThrow('access_actor_mismatch'))
  })
  it('retains the outer ceiling through clearance-only legacy wrappers',()=>{
    runWithAgentAccess(parent,()=>runWithAgentClearance('confidential',()=>expect(currentAgentAccess()).toEqual(parent)))
  })
  it('does not let a returned snapshot mutate the execution context',()=>{
    runWithAgentAccess(parent,()=>{
      currentAgentAccess()!.visibilityAssistantIds!.push('callee')
      currentAgentCompartments()!.push('finance')
      expect(currentAgentAccess()).toEqual(parent)
    })
  })
})
