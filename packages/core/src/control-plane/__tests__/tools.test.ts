/**
 * Control-plane read tools — Tier-1 agent capability surface.
 * Component tag: [COMP:control-plane/read-tools].
 */

import { describe, it, expect, vi } from 'vitest'
import type { ToolContext } from '../../tools/types.js'
import { createControlPlaneTools } from '../tools.js'
import type { ControlPlaneReader } from '../types.js'

const WS = '33333333-3333-3333-3333-333333333333'
const ASSISTANT = '22222222-2222-2222-2222-222222222222'

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: 'u-1',
    assistantId: ASSISTANT,
    sessionId: 's-1',
    appId: ASSISTANT,
    channelType: 'programmatic',
    channelId: 'k-1',
    workspaceId: WS,
    abortSignal: new AbortController().signal,
    ...overrides,
  }
}

function makeReader(): ControlPlaneReader {
  return {
    listAssistants: vi.fn(async () => [
      {
        id: ASSISTANT,
        name: 'Primary',
        kind: 'primary' as const,
        clearance: 'internal' as const,
        appType: null,
        capabilities: ['tasks', 'crm'],
      },
    ]),
    getAssistant: vi.fn(async (_u, _w, id) =>
      id === ASSISTANT
        ? {
            id: ASSISTANT,
            name: 'Primary',
            kind: 'primary' as const,
            clearance: 'internal' as const,
            appType: null,
            capabilities: ['tasks'],
          }
        : null,
    ),
    listConnectors: vi.fn(async () => [
      {
        provider: 'github',
        instanceId: '44444444-4444-4444-4444-444444444444',
        label: 'GitHub',
        connected: true,
        oauthRequired: false,
        authType: 'api_key' as const,
        scope: 'team-native' as const,
        sensitivity: 'internal' as const,
      },
    ]),
    listSkills: vi.fn(async () => []),
    listChannels: vi.fn(async () => []),
    listModes: vi.fn(async () => []),
  }
}

describe('[COMP:control-plane/read-tools] createControlPlaneTools', () => {
  it('every tool is a concurrency-safe read with no capability requirement (Tier-1 is ungated)', () => {
    const tools = createControlPlaneTools(makeReader())
    for (const tool of Object.values(tools)) {
      expect(tool.isReadOnly).toBe(true)
      expect(tool.isConcurrencySafe).toBe(true)
      expect(tool.requiresConfirmation).toBe(false)
      expect(tool.requiresCapability).toBeUndefined()
    }
  })

  it('listAssistants scopes the read to the context principal (userId + workspaceId)', async () => {
    const reader = makeReader()
    const tools = createControlPlaneTools(reader)
    const result = await tools.listAssistants.execute({}, ctx())
    expect(result.isError).toBeFalsy()
    expect(reader.listAssistants).toHaveBeenCalledWith('u-1', WS)
    expect((result.data as { assistants: unknown[] }).assistants).toHaveLength(1)
  })

  it('errors cleanly when the surface has no workspace binding', async () => {
    const tools = createControlPlaneTools(makeReader())
    const result = await tools.listConnectors.execute({}, ctx({ workspaceId: null }))
    expect(result.isError).toBe(true)
  })

  it('getAssistant returns an error result for an unknown id', async () => {
    const tools = createControlPlaneTools(makeReader())
    const parsed = tools.getAssistant.inputSchema.parse({
      assistantId: '99999999-9999-9999-9999-999999999999',
    })
    const result = await tools.getAssistant.execute(parsed, ctx())
    expect(result.isError).toBe(true)
  })

  it('listModes passes the target assistant through', async () => {
    const reader = makeReader()
    const tools = createControlPlaneTools(reader)
    const parsed = tools.listModes.inputSchema.parse({ assistantId: ASSISTANT })
    await tools.listModes.execute(parsed, ctx())
    expect(reader.listModes).toHaveBeenCalledWith('u-1', WS, ASSISTANT)
  })

  it('listConnectors surfaces the oauthRequired flag the agent uses for connect-link handoff', async () => {
    const tools = createControlPlaneTools(makeReader())
    const result = await tools.listConnectors.execute({}, ctx())
    const rows = (result.data as { connectors: Array<{ oauthRequired: boolean }> }).connectors
    expect(rows[0].oauthRequired).toBe(false)
  })
})
