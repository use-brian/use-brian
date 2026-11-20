import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { BrainAuth } from '../auth.js'
import type { BrainTool } from '../tools.js'
import { readWorkspaceMcpConsent } from '../../workspace-mcp/consent.js'
import { brainMcpRoutes } from '../server.js'

const state = vi.hoisted(() => ({
  authenticate: vi.fn(),
  buildTools: vi.fn(),
}))

vi.mock('../auth.js', () => ({
  authenticateBrainRequest: state.authenticate,
  // These fixtures authenticate Home apps, not rotatable Brain credentials.
  getAuthenticatedBrainCredentialCurrent: () => undefined,
  getAuthenticatedCrmCredentialParent: () => undefined,
}))
vi.mock('../tools.js', () => ({
  buildBrainTools: state.buildTools,
  resolveAgentCapabilities: async () => new Set(),
}))
describe('[COMP:api/brain-mcp] Home-app consult authority', () => {
  const auth: BrainAuth = {
    keyId: 'app-fixture', workspaceId: 'workspace-fixture', scope: 'read',
    authKind: 'home_app', storeScope: 'read', agentScope: 'ask',
    actingUserId: 'viewer-fixture', maxClearance: 'public',
  }
  beforeEach(() => {
    vi.clearAllMocks()
    state.authenticate.mockResolvedValue({ ...auth })
    state.buildTools.mockReturnValue([])
  })

  async function build() {
    const agentTask = vi.fn().mockResolvedValue('bounded result')
    const app = express().use(express.json())
    // No resource tool runs in this route-boundary test. Capture the closure
    // passed to the real tool builder, after the authenticated principal gate.
    app.use('/', brainMcpRoutes({ agentTask, brainKeyStore: {} as never,
      memoryTools: {} as never, taskTools: {} as never, crmTools: {} as never,
      retrievalTools: {} as never }))
    await request(app).post('/').set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list',
        params: { actingUserId: 'owner-fixture', maxClearance: 'confidential' } }).expect(200)
    return { agentTask, toolOptions: state.buildTools.mock.calls[0]![0] }
  }

  it('forwards the authenticated viewer and credential cap, ignoring body authority', async () => {
    const { agentTask, toolOptions } = await build()
    await expect(toolOptions.agentTask('Summarize this store')).resolves.toBe('bounded result')
    expect(agentTask).toHaveBeenCalledExactlyOnceWith({
      workspaceId: auth.workspaceId, appId: auth.keyId,
      storeScope: 'read', actingUserId: auth.actingUserId,
      maxClearance: 'public', task: 'Summarize this store',
    })
  })

  it.each([
    { actingUserId: undefined },
    { agentScope: 'none' },
    { authKind: 'api_key' },
    { authKind: 'oauth_token' },
  ])('does not expose delegated execution without a bound Home-app actor/grant: %j', async (override) => {
    state.authenticate.mockResolvedValue({ ...auth, ...override })
    const { agentTask, toolOptions } = await build()
    expect(toolOptions.agentTask).toBeUndefined()
    expect(agentTask).not.toHaveBeenCalled()
  })

  describe('hosted context-only workspace admission', () => {
    function fixture(restricted = true) {
      const memoryHandler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'Fictional memory' }] }))
      const inferenceHandler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'Fictional model answer' }] }))
      const tool = (name: string, handler: BrainTool['handler'] = inferenceHandler): BrainTool => ({
        name, handler, inputSchema: {}, description: 'Fixture tool',
      })
      state.buildTools.mockReturnValue([
        tool('getMemory', memoryHandler), tool('saveMemory', memoryHandler), tool('ingestToBrain'), tool('askAssistant'),
      ])
      const workspaceId = auth.workspaceId
      const application = { homeAppId: auth.keyId, workspaceId, buildTools: vi.fn(async () => [tool('applicationCommand')]) }
      const applicationProfile = vi.fn(async () => application)
      const consumeBudget = vi.fn(async () => ({ allowed: true }))
      const policy = { contextOnly: vi.fn(async () => restricted), consume: vi.fn(async () => 'allowed' as const), recordRead: vi.fn() }
      const app = express().use(express.json())
      app.use('/', brainMcpRoutes({ memoryAllowance: policy, brainKeyStore: {} as never,
        memoryTools: {} as never, taskTools: {} as never, crmTools: {} as never, retrievalTools: {} as never,
        homeApps: { secret: 'fictional', getApp: vi.fn(), applicationProfile, consumeBudget } }))
      const rpc = (method: string, params?: object) => request(app).post('/').set('Accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: 1, method, params })
      const result = (response: Awaited<ReturnType<typeof rpc>>) => {
        const data = response.text.split('\n').find(line => line.startsWith('data: '))
        return (data ? JSON.parse(data.slice(6)) : response.body).result
      }
      return { rpc, result, application, applicationProfile, consumeBudget, policy, memoryHandler, inferenceHandler }
    }

    const assistantId = '6b6b28ab-0508-4121-8aef-37e6c8c11f93'
    const consent = readWorkspaceMcpConsent({ version: 1, assistantId, operationNames: ['askAssistant'],
      maxClearance: 'internal', compartments: [], mutationCompartments: [], projectIds: [], visibilityAssistantIds: [assistantId],
      contextGroupId: null, contextProjectId: null, expiresAt: new Date(Date.now() + 3600000).toISOString() })!

    it.each<Partial<BrainAuth>>([
      { authKind: 'api_key' }, { authKind: 'home_app' }, { authKind: 'oauth_token', workspaceMcpConsent: consent },
      { authKind: 'oauth_token', actingUserId: undefined },
    ])('refuses alternate credentials before registering or calling tools: %j', async overrides => {
      const f = fixture()
      state.authenticate.mockResolvedValue({ ...auth, ...overrides })
      await f.rpc('tools/list').expect(403)
      const denied = await f.rpc('tools/call', { name: 'askAssistant', arguments: {}, workspaceId: 'body-workspace' }).expect(403)
      expect(denied.body.error).toBe('memory_connection_required')
      expect(f.policy.contextOnly).toHaveBeenLastCalledWith(auth.workspaceId)
      expect(state.buildTools).not.toHaveBeenCalled()
      expect(f.application.buildTools).not.toHaveBeenCalled()
      expect(f.consumeBudget).not.toHaveBeenCalled()
      expect(f.inferenceHandler).not.toHaveBeenCalled()
    })

    it('uses the signed application workspace and preserves application-only access on an eligible workspace', async () => {
      state.authenticate.mockResolvedValue(null)
      const f = fixture()
      const denied = await f.rpc('tools/call', { name: 'applicationCommand', arguments: {} }).expect(403)
      expect(denied.body.error).toBe('memory_connection_required')
      expect(f.policy.contextOnly).toHaveBeenCalledExactlyOnceWith(auth.workspaceId)
      expect(f.application.buildTools).not.toHaveBeenCalled()
      expect(f.consumeBudget).not.toHaveBeenCalled()
      f.policy.contextOnly.mockResolvedValue(false)
      const allowed = await f.rpc('tools/call', { name: 'applicationCommand', arguments: {} }).expect(200)
      expect(f.result(allowed).content[0].text).toBe('Fictional model answer')
      expect(f.consumeBudget).toHaveBeenCalledExactlyOnceWith(auth.keyId)
    })

    it('keeps hosted memory OAuth metered and independent from every application catalog', async () => {
      const f = fixture()
      state.authenticate.mockResolvedValue({ ...auth, authKind: 'oauth_token' })
      const list = await f.rpc('tools/list').expect(200)
      expect(f.result(list).tools.map((item: BrainTool) => item.name)).toEqual([
        'getConnectedWorkspace', 'getMemory', 'saveMemory', 'searchBrain',
      ])
      const search = await f.rpc('tools/call', { name: 'searchBrain', arguments: { query: 'Fictional decision' } }).expect(200)
      expect(f.result(search).content[0].text).toBe('Fictional memory')
      expect(f.policy.consume).toHaveBeenCalledOnce()
      expect(f.applicationProfile).not.toHaveBeenCalled()
      expect(f.inferenceHandler).not.toHaveBeenCalled()
    })

    it('keeps the eligible Home catalog and refuses an unavailable policy lookup', async () => {
      const f = fixture(false)
      const list = await f.rpc('tools/list').expect(200)
      expect(f.result(list).tools.map((item: BrainTool) => item.name)).toEqual([
        'applicationCommand', 'askAssistant', 'getMemory', 'ingestToBrain', 'saveMemory',
      ])
      expect(f.consumeBudget).toHaveBeenCalledOnce()
      f.policy.contextOnly.mockRejectedValueOnce(new Error('fictional policy outage'))
      const unavailable = await f.rpc('tools/call', { name: 'askAssistant', arguments: {} }).expect(503)
      expect(unavailable.body).toEqual({ error: 'memory_connection_unavailable', retrySafe: true })
      expect(f.inferenceHandler).not.toHaveBeenCalled()
    })
  })
})
