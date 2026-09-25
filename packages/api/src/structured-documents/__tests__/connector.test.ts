import { describe, expect, it, vi } from 'vitest'
import type { FilesContext, McpSettingsStore } from '@use-brian/core'
import { APP_LEVEL_ASSISTANT_ID } from '@use-brian/shared'
import type { ConnectorInstance } from '../../db/connector-instance-store.js'
import type { GrantWithInstance } from '../../db/connector-grant-store.js'
import type { WorkspaceToolPolicyStore } from '../../db/workspace-tool-policy-store.js'
import type { StructuredOcrClient } from '../client.js'
import { createStructuredOcrConnectorResolver } from '../connector.js'

const ctx: FilesContext = { userId: 'actor', workspaceId: 'workspace', assistantId: 'assistant', compartments: null, projectIds: null }
function fixture() {
  const instance: ConnectorInstance = { id: 'instance', scope: 'workspace', workspaceId: 'workspace', userId: null, provider: 'custom-provider', label: 'OCR\n<label>', custom: true, connected: true, credentialsType: 'bearer', healthStatus: 'ok', url: 'http://localhost:8123/mcp', compartments: [], projectIds: [], config: {}, sensitivity: 'internal', ingestionEnabled: false, ingestWorkspaceId: null, connectedEmail: null, lastError: null, lastCheckedAt: null, createdBy: null, createdAt: new Date(), updatedAt: new Date() }
  const state = { owned: [instance], grants: [] as GrantWithInstance[], token: 'secret-token', enabled: true, policy: 'allow' as 'allow' | 'ask' | 'block' }
  const getAuthCredentialsSystem = vi.fn(async () => ({ type: 'bearer' as const, token: state.token }))
  const isEnabled = vi.fn(async () => state.enabled)
  const getPolicy = vi.fn(async () => ({ policy: state.policy }))
  const personalPolicy = vi.fn(async () => ({ policy: state.policy }))
  const createClient = vi.fn(() => ({} as StructuredOcrClient))
  const resolver = createStructuredOcrConnectorResolver({
    instanceStore: { listByWorkspaceSystem: async () => state.owned, getAuthCredentialsSystem },
    grantStore: { listForTargetSystem: async () => state.grants },
    assistantStore: { isEnabled },
    workspacePolicyStore: { getPolicy } as unknown as WorkspaceToolPolicyStore,
    settingsStore: { getPolicy: personalPolicy } as unknown as McpSettingsStore,
    createClient,
  })
  return { resolver, state, instance, createClient, getAuthCredentialsSystem, getPolicy, personalPolicy, isEnabled }
}

describe('[COMP:api/structured-documents] structured OCR connector resolver', () => {
  it('lists exact instances without secrets or network, preserving same-URL instances', async () => {
    const f = fixture()
    f.state.owned.push({ ...f.instance, id: 'second' })
    expect(await f.resolver.list(ctx)).toEqual([{ connectorInstanceId: 'instance', label: 'OCRlabel' }, { connectorInstanceId: 'second', label: 'OCRlabel' }])
    expect(f.getAuthCredentialsSystem).not.toHaveBeenCalled()
    expect(f.createClient).not.toHaveBeenCalled()
    expect(f.isEnabled).toHaveBeenCalledWith('assistant', 'custom-provider:instance', 'custom-provider')
  })
  it('pins credentials, endpoint and policies and derives document/actor-specific secret scope', async () => {
    const f = fixture()
    const first = await f.resolver.resolve(ctx, 'file', 'instance')
    const config = f.createClient.mock.calls[0] as unknown as [{ scope: string; token: string; baseUrl: string }]
    expect(config[0]).toMatchObject({ token: 'secret-token', baseUrl: f.instance.url, scope: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(JSON.stringify(first.binding)).not.toContain('secret-token')
    expect(JSON.stringify(first.binding)).not.toContain('localhost')
    await f.resolver.resolve(ctx, 'file', 'instance', first.binding)
    await f.resolver.resolve(ctx, 'other-file', 'instance')
    expect((f.createClient.mock.calls[2] as unknown as typeof config)[0].scope).not.toBe(config[0].scope)
    expect(f.getPolicy).toHaveBeenCalledTimes(30)
  })
  for (const change of ['revoked', 'workspace', 'disabled', 'disconnected', 'credentials', 'endpoint', 'block', 'fingerprint'] as const) {
    it(`rejects resumed jobs after ${change}`, async () => {
      const f = fixture()
      const { binding } = await f.resolver.resolve(ctx, 'file', 'instance')
      if (change === 'revoked') f.state.owned = []
      if (change === 'workspace') f.instance.workspaceId = 'elsewhere'
      if (change === 'disabled') f.state.enabled = false
      if (change === 'disconnected') f.instance.connected = false
      if (change === 'credentials') f.state.token = 'rotated'
      if (change === 'endpoint') f.instance.url = 'http://localhost:9000/mcp'
      if (change === 'block') f.state.policy = 'block'
      if (change === 'fingerprint') f.getPolicy.mockImplementation(async (...args: unknown[]) => ({ policy: args[2] === 'ocr_status' ? 'ask' : 'allow' }))
      await expect(f.resolver.resolve(ctx, 'file', 'instance', binding)).rejects.toMatchObject({ code: expect.stringMatching(/^connector_/) })
      expect(f.createClient).toHaveBeenCalledTimes(1)
    })
  }
  it('uses current grant restrictions and owner/label L1+L2 principals', async () => {
    const f = fixture()
    f.state.owned = []
    f.instance.scope = 'user'; f.instance.workspaceId = null; f.instance.userId = 'owner'
    f.state.grants = [{ id: 'grant', connectorInstanceId: 'instance', targetType: 'workspace', targetId: 'workspace', grantedByUserId: 'owner', grantedAt: new Date(), compartments: ['finance'], projectIds: ['project'], instance: f.instance }]
    const limited = { ...ctx, compartments: ['finance'], projectIds: ['project'] }
    const { binding } = await f.resolver.resolve(limited, 'file', 'instance')
    expect(f.personalPolicy).toHaveBeenCalledWith({ assistantId: APP_LEVEL_ASSISTANT_ID, userId: 'owner', serverName: f.instance.label, toolName: 'ocr_capabilities' })
    expect(f.personalPolicy).toHaveBeenCalledWith({ assistantId: 'assistant', userId: 'owner', serverName: f.instance.label, toolName: 'ocr_start' })
    f.state.grants[0].compartments = [] // Unbounded exposure is NOT a finite grant.
    await expect(f.resolver.resolve(limited, 'file', 'instance', binding)).rejects.toMatchObject({ code: 'connector_unavailable' })
    f.state.grants = []
    expect(await f.resolver.list(ctx)).toEqual([])
  })
  it('requires ALLOW for capabilities; unknown tools default ASK only within confirmed start', async () => {
    const f = fixture()
    f.getPolicy.mockImplementation(async (...args: unknown[]) => args[2] === 'ocr_capabilities' ? { policy: 'allow' } : null as never)
    await expect(f.resolver.resolve(ctx, 'file', 'instance')).resolves.toBeDefined()
    f.getPolicy.mockResolvedValue(null as never)
    await expect(f.resolver.resolve(ctx, 'file', 'instance')).rejects.toMatchObject({ code: 'connector_health_approval_required' })
  })
  it.each([APP_LEVEL_ASSISTANT_ID, 'assistant'])('requires health approval for ASK at policy layer %s', async assistantId => {
    const f = fixture()
    f.state.owned = []
    f.instance.scope = 'user'; f.instance.workspaceId = null; f.instance.userId = 'owner'
    f.state.grants = [{ id: 'grant', connectorInstanceId: 'instance', targetType: 'workspace', targetId: 'workspace', grantedByUserId: 'owner', grantedAt: new Date(), compartments: [], projectIds: [], instance: f.instance }]
    f.personalPolicy.mockImplementation(async (...args: unknown[]) => {
      const input = args[0] as { assistantId: string; toolName: string }
      return { policy: input.assistantId === assistantId && input.toolName === 'ocr_capabilities' ? 'ask' : 'allow' }
    })
    await expect(f.resolver.resolve(ctx, 'file', 'instance')).rejects.toMatchObject({ code: 'connector_health_approval_required' })
    expect(f.createClient).not.toHaveBeenCalled()
    expect(f.getAuthCredentialsSystem).not.toHaveBeenCalled()
  })
  it.each(['ocr_capabilities', 'ocr_start', 'ocr_status', 'ocr_records', 'ocr_source_page'])('does not weaken BLOCK on %s', async tool => {
    const f = fixture()
    f.getPolicy.mockImplementation(async (...args: unknown[]) => ({ policy: args[2] === tool ? 'block' : 'allow' }))
    await expect(f.resolver.resolve(ctx, 'file', 'instance')).rejects.toMatchObject({ code: 'connector_policy_blocked' })
    expect(f.createClient).not.toHaveBeenCalled()
    expect(f.getAuthCredentialsSystem).not.toHaveBeenCalled()
  })
  it('fails closed on missing trusted context, oversized catalogs, and store errors', async () => {
    const f = fixture()
    for (const bad of [{ ...ctx, assistantId: null }, { ...ctx, compartments: undefined }, { ...ctx, projectIds: undefined }, { ...ctx, workspaceId: '' }]) {
      await expect(f.resolver.list(bad)).rejects.toMatchObject({ code: 'connector_context_missing' })
    }
    f.state.owned = Array.from({ length: 101 }, (_, i) => ({ ...f.instance, id: `${i}` }))
    await expect(f.resolver.list(ctx)).rejects.toMatchObject({ code: 'connector_limit_exceeded' })
    f.state.owned = [f.instance]
    f.getAuthCredentialsSystem.mockRejectedValue(new Error('secret http://private'))
    await expect(f.resolver.resolve(ctx, 'file', 'instance')).rejects.toMatchObject({ code: 'connector_unavailable', message: 'Structured OCR request failed (connector_unavailable).' })
  })
})
