/**
 * [COMP:api/mcp-inject] Stale "not connected" notice retraction.
 *
 * Regression guard for the 2026-07-29 live finding: a workspace-scoped
 * assistant never loads the owner's personal connectors, so every built-in
 * injector runs against an empty list and pushes a not-connected notice; the
 * team-grant / team-native overlays then inject that same provider from a
 * shared instance. Nothing retracted the notice, so the system prompt claimed
 * the connector was unavailable while the model held its tools — and the model
 * obeyed the prompt and refused the user's request.
 */
import { describe, it, expect } from 'vitest'
import type { Tool } from '@use-brian/core'
import {
  clearStaleNotConnectedNotices,
  NOT_CONNECTED_DISPLAY_NAMES,
  INJECTED_BUILTIN_TOOLS_BY_CONNECTOR,
} from '../inject.js'

const tool = (name: string) => [name, { name } as Tool] as const

/** The exact wording `notConnectedNotice` produces. */
const notice = (displayName: string) =>
  `${displayName}: not connected for this assistant (things)`

describe('[COMP:api/mcp-inject] stale not-connected notice retraction', () => {
  it('retracts the notice for a provider whose tools were injected by an overlay', () => {
    const tools = new Map([tool('shopifyCreateDiscountCode'), tool('shopifyGetShop')])
    const unavailable = [notice('Shopify')]
    clearStaleNotConnectedNotices(tools, unavailable)
    expect(unavailable).toEqual([])
  })

  it('keeps the notice for a provider that genuinely has no tools', () => {
    const tools = new Map([tool('shopifyGetShop')])
    const unavailable = [notice('Shopify'), notice('GitHub')]
    clearStaleNotConnectedNotices(tools, unavailable)
    expect(unavailable).toEqual([notice('GitHub')])
  })

  it('matches multi-instance suffixed tool names', () => {
    // A second store's tools are `<canonical>__<label>`; the provider is still
    // available, so its notice is still stale.
    const tools = new Map([tool('shopifyGetShop__second_store')])
    const unavailable = [notice('Shopify')]
    clearStaleNotConnectedNotices(tools, unavailable)
    expect(unavailable).toEqual([])
  })

  it('leaves unrelated notices untouched', () => {
    const other = 'Company email (IMAP): not connected for this assistant (mail)'
    const tools = new Map([tool('shopifyGetShop')])
    const unavailable = [other]
    clearStaleNotConnectedNotices(tools, unavailable)
    expect(unavailable).toEqual([other])
  })

  it('is a no-op when nothing is injected', () => {
    const unavailable = [notice('Shopify'), notice('Notion')]
    clearStaleNotConnectedNotices(new Map(), unavailable)
    expect(unavailable).toHaveLength(2)
  })

  it('every mapped connector id has a real tool catalog to correlate against', () => {
    // Drift guard: a display name with no INJECTED_BUILTIN_TOOLS_BY_CONNECTOR
    // entry can never retract, so the notice would silently stay stale.
    for (const connectorId of Object.keys(NOT_CONNECTED_DISPLAY_NAMES)) {
      expect(
        INJECTED_BUILTIN_TOOLS_BY_CONNECTOR[connectorId],
        `${connectorId} has no injected-tool catalog`,
      ).toBeDefined()
      expect(INJECTED_BUILTIN_TOOLS_BY_CONNECTOR[connectorId].length).toBeGreaterThan(0)
    }
  })

  it('retracts for every mapped connector using its own first tool', () => {
    for (const [connectorId, displayName] of Object.entries(NOT_CONNECTED_DISPLAY_NAMES)) {
      const first = INJECTED_BUILTIN_TOOLS_BY_CONNECTOR[connectorId][0]
      const unavailable = [notice(displayName)]
      clearStaleNotConnectedNotices(new Map([tool(first)]), unavailable)
      expect(unavailable, `${connectorId} notice was not retracted`).toEqual([])
    }
  })
})
