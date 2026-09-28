/**
 * [COMP:agent-surface/connector-authorization]
 */
import { describe, expect, it, vi } from 'vitest'
import { CONFIGURE_CAPABILITY, type ToolContext } from '@use-brian/core'
import { bandOf } from '../banding.js'
import {
  availableOfficialConnectorRows,
  connectorAuthorizationEntry,
  connectorAuthorizationPath,
} from '../connector-authorization.js'
import { createAgentWriteTools } from '../write-tools.js'

const WS = '33333333-3333-4333-8333-333333333333'

function context(): ToolContext {
  return {
    userId: 'user-1',
    assistantId: '22222222-2222-4222-8222-222222222222',
    sessionId: '11111111-1111-4111-8111-111111111111',
    appId: 'app-1',
    channelType: 'programmatic',
    channelId: 'key-1',
    workspaceId: WS,
    abortSignal: new AbortController().signal,
  }
}

function makeTool(input: { connected?: boolean } = {}) {
  const instance = input.connected
    ? [{ id: '44444444-4444-4444-8444-444444444444', provider: 'gcal', connected: true }]
    : []
  const tools = createAgentWriteTools({
    approvalsStore: {} as never,
    enablementStore: {} as never,
    workspaceSkillStore: {} as never,
    mcpSettingsStore: {} as never,
    connectorInstanceStore: {
      listByWorkspace: vi.fn(async () => instance),
    } as never,
    connectorGrantStore: {
      listForTargetSystem: vi.fn(async () => []),
    } as never,
    appOrigin: 'https://app.example.test/',
    resolveApprover: vi.fn(async () => 'user-1'),
  })
  return tools.find((tool) => tool.name === 'requestConnectorAuthorization')!
}

describe('[COMP:agent-surface/connector-authorization] preparation tool', () => {
  it('is configure-gated and Auto-band', () => {
    const tool = makeTool()
    expect(tool.requiresCapability).toBe(CONFIGURE_CAPABILITY)
    expect(bandOf(tool.name)).toBe('auto')
  })

  it('returns the canonical one-click action for a disconnected supported provider', async () => {
    const result = await makeTool().execute({ provider: 'gcal' }, context())
    expect(result.isError).not.toBe(true)
    expect(result.data).toMatchObject({
      status: 'human_authorization_required',
      provider: 'gcal',
      name: 'Google Calendar',
      actionId: 'connector_authorization:gcal',
      connectPath: `/w/${WS}/studio/connectors?connect=gcal`,
      connectUrl: `https://app.example.test/w/${WS}/studio/connectors?connect=gcal`,
    })
  })

  it('reports an already-connected instance without asking for consent again', async () => {
    const result = await makeTool({ connected: true }).execute({ provider: 'gcal' }, context())
    expect(result.data).toMatchObject({
      status: 'already_connected',
      provider: 'gcal',
      instanceId: '44444444-4444-4444-8444-444444444444',
    })
  })

  it('fails loudly for a connector without the registry handoff', async () => {
    const result = await makeTool().execute({ provider: 'github' }, context())
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('does not support the resumable OAuth handoff')
  })

  it('derives action parsing and continuation paths from the same contract', () => {
    expect(connectorAuthorizationEntry('connector_authorization:gcal')?.id).toBe('gcal')
    expect(connectorAuthorizationEntry('connector_authorization:github')).toBeNull()
    expect(connectorAuthorizationPath({
      workspaceId: WS,
      provider: 'gcal',
      sessionId: '11111111-1111-4111-8111-111111111111',
      approvalId: '55555555-5555-4555-8555-555555555555',
    })).toContain('setupApproval=55555555-5555-4555-8555-555555555555')
  })

  it('projects unconfigured official connectors as available, never connected', () => {
    const rows = availableOfficialConnectorRows(new Set(['gmail']), WS)
    const calendar = rows.find((row) => row.provider === 'gcal')
    expect(calendar).toMatchObject({
      name: 'Google Calendar',
      instanceId: null,
      connected: false,
      availability: 'available',
      authorizationHandoff: true,
      scope: 'available',
    })
    expect(calendar?.connectPath).toBe(`/w/${WS}/studio/connectors?connect=gcal`)
    expect(rows.some((row) => row.provider === 'gmail')).toBe(false)
  })
})
