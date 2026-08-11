/**
 * [COMP:api/home-app-store-tools] — what a sandboxed Home app may reach in a
 * live commerce store.
 *
 * These are security assertions, not behaviour tests. The thing being
 * defended is that third-party code in an iframe cannot refund a customer,
 * cancel an order, or overwrite the theme template a storefront is served
 * from — no matter what its manifest asked for or what an admin clicked.
 */

import { describe, it, expect } from 'vitest'
import { OFFICIAL_CONNECTOR_TOOLS } from '@use-brian/shared'
import type { AppStoreScope } from '@use-brian/brian-app'
import { agentAllowedToolsFor, filterStoreTools, storeToolNamesFor } from '../store-tools.js'

const ALL_TIERS: AppStoreScope[] = ['none', 'read', 'write']

const DESTRUCTIVE = OFFICIAL_CONNECTOR_TOOLS.shopify
  .filter((t) => t.classification === 'destructive')
  .map((t) => t.name)

describe('[COMP:api/home-app-store-tools] destructive tools are unreachable', () => {
  it('has destructive Shopify tools to defend against (guards the guard)', () => {
    // If the registry stops classifying anything destructive, every assertion
    // below passes vacuously. Fail loudly instead.
    expect(DESTRUCTIVE.length).toBeGreaterThan(0)
    expect(DESTRUCTIVE).toEqual(
      expect.arrayContaining([
        'shopifyRefundOrder',
        'shopifyCancelOrder',
        'shopifyCompleteDraftOrder',
        'shopifyCreateProductTemplate',
      ]),
    )
  })

  it('excludes every destructive tool at EVERY tier', () => {
    for (const tier of ALL_TIERS) {
      const names = storeToolNamesFor('shopify', tier)
      for (const destructive of DESTRUCTIVE) {
        expect(names.has(destructive)).toBe(false)
      }
    }
  })

  it('excludes them even when passed in as real tool instances', () => {
    const tools = DESTRUCTIVE.map((name) => ({ name }))
    for (const tier of ALL_TIERS) {
      expect(filterStoreTools(tools, { connectorId: 'shopify', storeScope: tier })).toEqual([])
    }
  })

  it('excludes a destructive tool under an instance suffix too', () => {
    // The suffixed variant is the same capability against a second store.
    const tools = [{ name: 'shopifyRefundOrder__mystore_1a2b3c4d' }]
    expect(filterStoreTools(tools, { connectorId: 'shopify', storeScope: 'write' })).toEqual([])
  })
})

describe('[COMP:api/home-app-store-tools] tier boundaries', () => {
  it("'none' reaches nothing", () => {
    expect(storeToolNamesFor('shopify', 'none').size).toBe(0)
  })

  it("'read' reaches only read-classified tools", () => {
    const names = storeToolNamesFor('shopify', 'read')
    expect(names.size).toBeGreaterThan(0)
    for (const name of names) {
      const entry = OFFICIAL_CONNECTOR_TOOLS.shopify.find((t) => t.name === name)
      expect(entry?.classification).toBe('read')
    }
  })

  it("'write' adds write tools but never widens past them", () => {
    const read = storeToolNamesFor('shopify', 'read')
    const write = storeToolNamesFor('shopify', 'write')
    for (const name of read) expect(write.has(name)).toBe(true)
    expect(write.size).toBeGreaterThan(read.size)
    for (const name of write) {
      const entry = OFFICIAL_CONNECTOR_TOOLS.shopify.find((t) => t.name === name)
      expect(['read', 'write']).toContain(entry?.classification)
    }
  })

  it('accounts for every registry tool exactly once — none silently ungoverned', () => {
    const write = storeToolNamesFor('shopify', 'write')
    const unreachable = OFFICIAL_CONNECTOR_TOOLS.shopify
      .map((t) => t.name)
      .filter((n) => !write.has(n))
    // Everything not reachable at the widest tier must be destructive. A tool
    // that is neither reachable nor destructive means a classification this
    // build does not understand — which is a real finding, not a pass.
    expect([...unreachable].sort()).toEqual([...DESTRUCTIVE].sort())
  })
})

describe('[COMP:api/home-app-store-tools] the named widening', () => {
  // `alsoAllow` is the ONE way past the destructive exclusion, and it exists
  // for the first-party native app surface (`apps-shopify.ts`), never for a
  // bundle. What is being defended here is that it can only ever admit what it
  // NAMES: not a class, not a tier, and nothing the registry does not know.
  const NATIVE = ['shopifyCreateProductTemplate']

  it('admits exactly the named tool and no other destructive one', () => {
    const names = storeToolNamesFor('shopify', 'write', NATIVE)
    expect(names.has('shopifyCreateProductTemplate')).toBe(true)
    for (const destructive of DESTRUCTIVE.filter((d) => !NATIVE.includes(d))) {
      expect(names.has(destructive)).toBe(false)
    }
    // Exactly one more than the plain tier reaches.
    expect(names.size).toBe(storeToolNamesFor('shopify', 'write').size + 1)
  })

  it('changes nothing for a caller that does not pass it', () => {
    // The bundle bridge omits the argument entirely. The default must be the
    // old behaviour, so a new caller has to opt IN rather than remember to
    // opt out.
    for (const tier of ALL_TIERS) {
      expect([...storeToolNamesFor('shopify', tier)].sort())
        .toEqual([...storeToolNamesFor('shopify', tier, [])].sort())
    }
  })

  it('still grants nothing at the "none" tier', () => {
    // A surface that has no store scope has no store, named tool or not.
    expect(storeToolNamesFor('shopify', 'none', NATIVE).size).toBe(0)
  })

  it('cannot mint reach for a name the registry has never heard of', () => {
    // A typo here must fail closed, not invent a tool.
    const names = storeToolNamesFor('shopify', 'write', ['shopifyCreateProductTemplat'])
    expect(names.has('shopifyCreateProductTemplat')).toBe(false)
    expect(names.size).toBe(storeToolNamesFor('shopify', 'write').size)
  })

  it('carries through filterStoreTools, instance suffixes included', () => {
    const tools = [
      { name: 'shopifyCreateProductTemplate' },
      { name: 'shopifyRefundOrder' },
    ]
    expect(
      filterStoreTools(tools, { connectorId: 'shopify', storeScope: 'write', alsoAllow: NATIVE })
        .map((x) => x.name),
    ).toEqual(['shopifyCreateProductTemplate'])

    expect(
      filterStoreTools([{ name: 'shopifyCreateProductTemplate__mystore_1a2b3c4d' }], {
        connectorId: 'shopify',
        storeScope: 'write',
        alsoAllow: NATIVE,
      }),
    ).toHaveLength(1)
  })

  it('does NOT widen the assistant consult', () => {
    // `agentAllowedToolsFor` takes no such argument on purpose: a model
    // choosing to write a theme file is a different decision from a merchant
    // clicking a confirm, and `/ask` keeps the ceiling it has always had.
    for (const tier of ALL_TIERS) {
      expect(agentAllowedToolsFor('shopify', tier)).not.toContain('shopifyCreateProductTemplate')
    }
  })
})

describe('[COMP:api/home-app-store-tools] fails closed on the unknown', () => {
  it('drops a tool the registry has never heard of', () => {
    // Opposite of gateToolsOnActionGrants, on purpose: there the caller is a
    // first-party assistant, here it is third-party code in a sandbox.
    const tools = [{ name: 'shopifyDoSomethingUnregistered' }]
    expect(filterStoreTools(tools, { connectorId: 'shopify', storeScope: 'write' })).toEqual([])
  })

  it('returns nothing for a connector with no registry entry', () => {
    expect(storeToolNamesFor('not-a-connector', 'write').size).toBe(0)
  })

  it('keeps a legitimate read tool under an instance suffix', () => {
    const tools = [{ name: 'shopifyListOrders__mystore_1a2b3c4d' }]
    expect(filterStoreTools(tools, { connectorId: 'shopify', storeScope: 'read' })).toHaveLength(1)
  })
})

describe('[COMP:api/home-app-store-tools] the agent is not a privilege ladder', () => {
  it('caps an app-triggered assistant turn at the app\'s OWN ceiling', () => {
    // The whole safety story for `scopes.agent`. The turn runs on the
    // workspace assistant, which normally holds far more than a Home app —
    // so "ask the assistant to refund order 1042" must not reach what the
    // direct gate refused.
    for (const tier of ALL_TIERS) {
      const allowed = agentAllowedToolsFor('shopify', tier)
      const direct = storeToolNamesFor('shopify', tier)
      expect([...allowed].sort()).toEqual([...direct].sort())
      for (const destructive of DESTRUCTIVE) {
        expect(allowed).not.toContain(destructive)
      }
    }
  })

  it('grants nothing at all when the app has no store scope', () => {
    expect(agentAllowedToolsFor('shopify', 'none')).toEqual([])
  })

  it('never returns an unbounded list — an empty allow-list must mean empty', () => {
    // An `allowedTools: []` that the executor read as "no filter" would hand
    // the app the assistant's entire tool set. Assert the shape explicitly so
    // that contract is visible here, where the cap is decided.
    const allowed = agentAllowedToolsFor('shopify', 'none')
    expect(Array.isArray(allowed)).toBe(true)
    expect(allowed).toHaveLength(0)
  })
})
