import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { BrainAuth } from '../auth.js'
import { brainMcpRoutes } from '../server.js'

const state = vi.hoisted(() => ({
  authenticate: vi.fn(),
  buildTools: vi.fn(),
}))

vi.mock('../auth.js', () => ({
  authenticateBrainRequest: state.authenticate,
  // These fixtures authenticate Home apps, not rotatable Brain credentials.
  getAuthenticatedBrainCredentialCurrent: () => undefined,
}))
vi.mock('../tools.js', () => ({
  buildBrainTools: state.buildTools,
  resolveAgentCapabilities: async () => new Set(),
}))
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    async connect() {}
    async close() {}
  },
}))
vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: class {
    async handleRequest(_req: unknown, res: express.Response) { res.status(200).json({ ok: true }) }
    async close() {}
  },
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
    await request(app).post('/').send({ actingUserId: 'owner-fixture', maxClearance: 'confidential' }).expect(200)
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
})
