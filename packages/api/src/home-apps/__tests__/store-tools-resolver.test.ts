/**
 * [COMP:api/home-app-store-tools] — the workspace connector boundary.
 *
 * `store-tools.test.ts` covers the tier gate: WHICH of a connector's tools a
 * granted app may reach. This file covers the prior question, WHOSE connectors
 * it reaches at all — a boundary that lives one argument away from being lost
 * and is invisible to every tier assertion, because the tier gate filters the
 * same tool names either way.
 *
 * That is not hypothetical. The resolver shipped without `assistantTeamId`,
 * which in `injectMcpTools` does not skip an overlay but flips
 * `loadOwnerPersonalConnectors` ON — handing a sandboxed third-party bundle
 * the workspace owner's PERSONAL connectors. Same tool names, same tier, same
 * count; different owner. See docs/architecture/integrations/mcp.md →
 * "Workspace connector scoping" (incidents 2026-06-01, 2026-07-14).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'
import type { Tool } from '@use-brian/core'

const injectMcpTools = vi.fn(async (_opts: Record<string, unknown>) => ({
  enrichConfirmation: async (_t: unknown, i: unknown) => i,
  unavailable: [],
  searchableSources: [],
}))
const resolveWriteTarget = vi.fn(async () => ({
  ownerUserId: 'owner-1',
  assistantId: 'assistant-1',
}))

const contextScope = { effectiveCompartments: ['team:department-a'], effectiveProjectIds: null }
const resolveTurnScopeSystem = vi.fn(async () => contextScope)
vi.mock('../../context-scope/resolve-turn-scope.js', () => ({ resolveTurnScopeSystem }))
vi.mock('../../db/users.js', () => ({ findAssistantById: vi.fn(async () => ({ id: 'assistant-1' })) }))

vi.mock('../../mcp/inject.js', () => ({ injectMcpTools, baseToolName: (name: string) => name.split('__')[0] }))
vi.mock('../../brain-mcp/tools.js', () => ({ resolveWriteTarget }))

const { createStoreToolResolver } = await import('../store-tools-resolver.js')

const WORKSPACE = 'workspace-42'

function resolver() {
  return createStoreToolResolver({} as never)
}

beforeEach(() => {
  injectMcpTools.mockClear()
  resolveWriteTarget.mockClear()
})

describe('[COMP:api/home-app-store-tools] whose connectors the app reaches', () => {
  it('scopes injection to the workspace, never the owner\'s personal set', async () => {
    await resolver()({ workspaceId: WORKSPACE, actingUserId: 'viewer-1', storeScope: 'read' })

    expect(injectMcpTools).toHaveBeenCalledTimes(1)
    const args = injectMcpTools.mock.calls[0][0]

    // The assertion that matters. `undefined`/`null` here is the defect:
    // inject.ts reads `loadOwnerPersonalConnectors = !assistantTeamId`, so a
    // missing value is not a no-op, it is the owner's private credentials.
    expect(args.assistantTeamId).toBe(WORKSPACE)
  })

  it('holds the boundary at every scope that reaches the store', async () => {
    for (const storeScope of ['read', 'write'] as const) {
      injectMcpTools.mockClear()
      await resolver()({ workspaceId: WORKSPACE, actingUserId: 'viewer-1', storeScope })
      const args = injectMcpTools.mock.calls[0][0]
      expect(args.assistantTeamId).toBe(WORKSPACE)
    }
  })

  it('keeps credential ownership separate from viewer department authority', async () => {
    // `userId` is the OWNER — that is correct and deliberate (it is how the
    // owner's action grants apply). It is also precisely what makes a missing
    // `assistantTeamId` dangerous rather than merely wrong.
    await resolver()({ workspaceId: WORKSPACE, actingUserId: 'viewer-1', storeScope: 'read' })
    const args = injectMcpTools.mock.calls[0][0]
    expect(args.userId).toBe('owner-1')
    expect(args.contextScope).toBe(contextScope)
    expect(resolveTurnScopeSystem).toHaveBeenCalledWith({ userId: 'viewer-1', workspaceId: WORKSPACE, assistant: { id: 'assistant-1' } })
    expect(args.assistantId).toBe('assistant-1')
  })

  it('does not touch the connector layer at all when store scope is none', async () => {
    const out = await resolver()({ workspaceId: WORKSPACE, actingUserId: 'viewer-1', storeScope: 'none' })
    expect(out).toEqual([])
    expect(injectMcpTools).not.toHaveBeenCalled()
    expect(resolveWriteTarget).not.toHaveBeenCalled()
  })

  it('returns nothing when the workspace has no assistant to bind to', async () => {
    resolveWriteTarget.mockResolvedValueOnce(null as never)
    const out = await resolver()({ workspaceId: WORKSPACE, actingUserId: 'viewer-1', storeScope: 'write' })
    expect(out).toEqual([])
    expect(injectMcpTools).not.toHaveBeenCalled()
  })

  it('keeps built-ins direct, or the tier gate has no names to classify', async () => {
    // Not a style choice: the gate resolves classification from tool NAMES,
    // and behind `mcp_call` there are none. Without this the filter drops
    // everything and a granted app silently sees no store.
    await resolver()({ workspaceId: WORKSPACE, actingUserId: 'viewer-1', storeScope: 'read' })
    const args = injectMcpTools.mock.calls[0][0]
    expect(args.keepBuiltinsDirect).toBe(true)
  })
  it('fails closed without an authenticated viewer', async () => {
    expect(await resolver()({ workspaceId: WORKSPACE, storeScope: 'read' })).toEqual([])
    expect(injectMcpTools).not.toHaveBeenCalled()
  })
  it('does not inject tools after viewer authority resolution fails', async () => {
    resolveTurnScopeSystem.mockRejectedValueOnce(new Error('context_not_available'))
    await expect(resolver()({ workspaceId: WORKSPACE, actingUserId: 'viewer-1', storeScope: 'read' })).rejects.toThrow('context_not_available')
    expect(injectMcpTools).not.toHaveBeenCalled()
  })

})


describe('[COMP:api/home-app-store-tools] execution-time authority', () => {
  function offer(execute: Tool['execute'], name = 'shopifyListProducts') {
    injectMcpTools.mockImplementationOnce(async (opts) => {
      (opts.tools as Map<string, Tool>).set(name, {
        name, description: 'Fixture product read', isConcurrencySafe: true, isReadOnly: true, requiresConfirmation: false, inputSchema: z.object({ limit: z.number().default(5) }), execute,
      })
      return { enrichConfirmation: async (_t: unknown, i: unknown) => i, unavailable: [], searchableSources: [] }
    })
  }

  it('uses a fresh authorized provider closure and reparses the current schema', async () => {
    const old = vi.fn(async () => ({ data: 'old' }))
    const fresh = vi.fn(async () => ({ data: 'current' }))
    offer(old)
    const [tool] = await resolver()({ workspaceId: WORKSPACE, actingUserId: 'viewer-1', storeScope: 'read' })
    offer(fresh)
    expect(await tool.execute({}, {} as never)).toEqual({ data: 'current' })
    expect(old).not.toHaveBeenCalled()
    expect(fresh).toHaveBeenCalledWith({ limit: 5 }, {})
  })

  it('refuses a previously visible tool after current discovery removes it', async () => {
    const provider = vi.fn(async () => ({ data: 'protected' }))
    offer(provider)
    const [tool] = await resolver()({ workspaceId: WORKSPACE, actingUserId: 'viewer-1', storeScope: 'read' })
    expect(await tool.execute({}, {} as never)).toMatchObject({ isError: true })
    expect(provider).not.toHaveBeenCalled()
  })

  it('fails closed if current viewer or assistant authority cannot be resolved', async () => {
    const provider = vi.fn(async () => ({ data: 'protected' }))
    offer(provider)
    const [tool] = await resolver()({ workspaceId: WORKSPACE, actingUserId: 'viewer-1', storeScope: 'read' })
    resolveTurnScopeSystem.mockRejectedValueOnce(new Error('Hidden department detail'))
    const result = await tool.execute({}, {} as never)
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).not.toContain('Hidden department detail')
    expect(provider).not.toHaveBeenCalled()
  })

  it('never substitutes another connector instance with the same base tool', async () => {
    const provider = vi.fn(async () => ({ data: 'protected' }))
    const other = vi.fn(async () => ({ data: 'other store' }))
    offer(provider, 'shopifyListProducts__first_12345678')
    const [tool] = await resolver()({ workspaceId: WORKSPACE, actingUserId: 'viewer-1', storeScope: 'read' })
    offer(other, 'shopifyListProducts__second_87654321')
    expect(await tool.execute({}, {} as never)).toMatchObject({ isError: true })
    expect(provider).not.toHaveBeenCalled()
    expect(other).not.toHaveBeenCalled()
  })
})
