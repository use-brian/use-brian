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
    listChannels: vi.fn(async () => [{
      id: '55555555-5555-4555-8555-555555555555',
      integrationId: '66666666-6666-4666-8666-666666666666',
      integrationStatus: 'active',
      channelType: 'whatsapp',
      displayName: 'Support',
      clearance: 'internal' as const,
      enabledCapabilities: ['chat'],
      status: 'active',
    }]),
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

  it('the workspace gate names the tool, diagnoses the CREDENTIAL, gives the admin remedy, and forbids the retry', async () => {
    // These reads are reachable only from the agent surfaces (brain MCP,
    // assistant MCP, public-api chat), so "no workspace" is always a property
    // of the key. The old copy stated the condition and stopped, which leaves
    // retrying as the model's only move (tool-executor.md → "Failure copy").
    const tools = createControlPlaneTools(makeReader())
    for (const [name, tool] of Object.entries(tools)) {
      const result = await tool.execute({ assistantId: ASSISTANT } as never, ctx({ workspaceId: null }))
      expect(result.isError, name).toBe(true)
      const text = String(result.data)
      expect(text, name).toContain(`\`${name}\` cannot run`)
      expect(text, name).toContain('not bound to a workspace')
      expect(text, name).toContain('re-issue or re-scope the key')
      expect(text, name).toContain('will fail identically')
    }
  })

  it('getAssistant returns an error result for an unknown id', async () => {
    const tools = createControlPlaneTools(makeReader())
    const parsed = tools.getAssistant.inputSchema.parse({
      assistantId: '99999999-9999-9999-9999-999999999999',
    })
    const result = await tools.getAssistant.execute(parsed, ctx())
    expect(result.isError).toBe(true)
  })

  it('an assistant-id miss ships the discovery pointer, not a bare "No such assistant"', async () => {
    const tools = createControlPlaneTools(makeReader())
    const missing = '99999999-9999-9999-9999-999999999999'
    const result = await tools.getAssistant.execute(
      tools.getAssistant.inputSchema.parse({ assistantId: missing }),
      ctx(),
    )
    const text = String(result.data)
    expect(text).toContain(missing)
    expect(text).toContain('listAssistants')
    expect(text).toContain('Do NOT retry this exact id')
    // The two reasons an id can miss are different diagnoses; say both.
    expect(text).toContain('not visible to the acting principal')
  })

  it('listConnectors surfaces the oauthRequired flag the agent uses for connect-link handoff', async () => {
    const tools = createControlPlaneTools(makeReader())
    const result = await tools.listConnectors.execute({}, ctx())
    const rows = (result.data as { connectors: Array<{ oauthRequired: boolean }> }).connectors
    expect(rows[0].oauthRequired).toBe(false)
  })

  it('listChannels exposes the integration id used by workflow event sources', async () => {
    const tools = createControlPlaneTools(makeReader())
    const result = await tools.listChannels.execute({}, ctx())
    const rows = (result.data as {
      channels: Array<{ id: string; integrationId: string | null }>
    }).channels
    expect(rows[0]).toMatchObject({
      id: '55555555-5555-4555-8555-555555555555',
      integrationId: '66666666-6666-4666-8666-666666666666',
    })
  })
})
