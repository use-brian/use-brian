/**
 * Assistant MCP endpoint — auth + ceiling gating.
 * Component tag: [COMP:api/assistant-mcp].
 *
 * Mirrors the brain-mcp test posture: the MCP transport itself is the
 * SDK's; these tests cover the auth gate (the pre-transport failure paths)
 * and the authority resolution inputs. Tool bridging/gating logic is shared
 * with the brain MCP and covered in brain-mcp.test.ts + toolset.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { buildTool, type Tool } from '@sidanclaw/core'

vi.mock('../../db/client.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
  queryWithRLS: vi.fn().mockResolvedValue({ rows: [] }),
}))

const findAssistantById = vi.fn()
vi.mock('../../db/users.js', () => ({
  findAssistantById: (...args: unknown[]) => findAssistantById(...args),
}))

import { assistantMcpRoutes } from '../assistant-mcp.js'
import { hashSecret, mintPlaintext, type ApiKeyStore } from '../../db/api-key-store.js'

function stubTool(name: string): Tool {
  return buildTool({
    name,
    description: `${name} stub`,
    inputSchema: z.object({ id: z.string().optional() }),
    async execute() {
      return { data: 'ok' }
    },
  })
}

const capabilityStore = {
  listActive: vi.fn<(id: string) => Promise<string[]>>(async () => []),
  hasActive: vi.fn(),
  listAllActive: vi.fn(),
  listHistoryForAssistant: vi.fn(),
  grant: vi.fn(),
  revoke: vi.fn(),
}

async function fakeApiKey(opts: {
  assistantId: string
  status?: 'active' | 'revoked'
  scope?: 'chat' | 'agent'
}) {
  const id = randomUUID()
  const { plaintext, secret, prefix } = mintPlaintext(id)
  const keyHash = await hashSecret(secret)
  const row = {
    id,
    assistantId: opts.assistantId,
    name: 'test',
    prefix,
    // The MCP door needs 'agent' purpose; default the fixture to it so the
    // auth tests exercise the post-scope path, with explicit 'chat' cases
    // covering the gate below.
    scope: opts.scope ?? ('agent' as const),
    status: opts.status ?? ('active' as const),
    keyHash,
    createdBy: null,
    createdAt: new Date(),
    lastUsedAt: null,
  }
  const store = {
    getByIdSystem: vi.fn(async (lookupId: string) => (lookupId === id ? row : null)),
  } as unknown as ApiKeyStore
  return { id, plaintext, store }
}

function makeApp(store: ApiKeyStore) {
  const app = express()
  app.use(express.json())
  app.use(
    '/api/v1',
    assistantMcpRoutes({
      apiKeyStore: store,
      capabilityStore: capabilityStore as never,
      agentTools: {
        reads: new Map([['listAssistants', stubTool('listAssistants')]]),
        writes: new Map([['runWorkflow', stubTool('runWorkflow')]]),
      },
    }),
  )
  return app
}

beforeEach(() => {
  findAssistantById.mockReset()
  capabilityStore.listActive.mockReset()
  capabilityStore.listActive.mockResolvedValue([])
})

describe('[COMP:api/assistant-mcp] auth gate', () => {
  const ASSISTANT = '22222222-2222-2222-2222-222222222222'

  it('401 without a bearer header', async () => {
    const { store } = await fakeApiKey({ assistantId: ASSISTANT })
    const res = await request(makeApp(store)).post(`/api/v1/assistants/${ASSISTANT}/mcp`).send({})
    expect(res.status).toBe(401)
  })

  it('401 for an sk_brain_ key aimed at the assistant surface', async () => {
    const { store } = await fakeApiKey({ assistantId: ASSISTANT })
    const res = await request(makeApp(store))
      .post(`/api/v1/assistants/${ASSISTANT}/mcp`)
      .set('Authorization', `Bearer sk_brain_${randomUUID()}_secretsecret`)
      .send({})
    expect(res.status).toBe(401)
  })

  it('401 when the key is bound to a DIFFERENT assistant (URL spoofing defence)', async () => {
    const { store, plaintext } = await fakeApiKey({ assistantId: randomUUID() })
    const res = await request(makeApp(store))
      .post(`/api/v1/assistants/${ASSISTANT}/mcp`)
      .set('Authorization', `Bearer ${plaintext}`)
      .send({})
    expect(res.status).toBe(401)
    expect(findAssistantById).not.toHaveBeenCalled()
  })

  it('403 for a revoked key', async () => {
    const { store, plaintext } = await fakeApiKey({ assistantId: ASSISTANT, status: 'revoked' })
    const res = await request(makeApp(store))
      .post(`/api/v1/assistants/${ASSISTANT}/mcp`)
      .set('Authorization', `Bearer ${plaintext}`)
      .send({})
    expect(res.status).toBe(403)
  })

  it('401 for a tampered secret', async () => {
    const { store, plaintext } = await fakeApiKey({ assistantId: ASSISTANT })
    const res = await request(makeApp(store))
      .post(`/api/v1/assistants/${ASSISTANT}/mcp`)
      .set('Authorization', `Bearer ${plaintext}xx`)
      .send({})
    expect(res.status).toBe(401)
  })

  it("403 key_scope_chat_only for a 'chat'-purpose key (the original external story)", async () => {
    const { store, plaintext } = await fakeApiKey({ assistantId: ASSISTANT, scope: 'chat' })
    const res = await request(makeApp(store))
      .post(`/api/v1/assistants/${ASSISTANT}/mcp`)
      .set('Authorization', `Bearer ${plaintext}`)
      .send({})
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('key_scope_chat_only')
    // The gate fires before any authority resolution.
    expect(findAssistantById).not.toHaveBeenCalled()
  })

  it('the scope gate runs AFTER the secret compare — an id-only prober gets a uniform 401, never a scope hint', async () => {
    const { store, plaintext } = await fakeApiKey({ assistantId: ASSISTANT, scope: 'chat' })
    const res = await request(makeApp(store))
      .post(`/api/v1/assistants/${ASSISTANT}/mcp`)
      .set('Authorization', `Bearer ${plaintext}TAMPERED`)
      .send({})
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('invalid_api_key')
  })

  it('404 when the assistant row is gone (key valid)', async () => {
    const { store, plaintext } = await fakeApiKey({ assistantId: ASSISTANT })
    findAssistantById.mockResolvedValueOnce(null)
    const res = await request(makeApp(store))
      .post(`/api/v1/assistants/${ASSISTANT}/mcp`)
      .set('Authorization', `Bearer ${plaintext}`)
      .send({})
    expect(res.status).toBe(404)
  })

  it('resolves the keyed assistant authority before serving (capabilities looked up on its id)', async () => {
    const { store, plaintext } = await fakeApiKey({ assistantId: ASSISTANT })
    findAssistantById.mockResolvedValueOnce({
      id: ASSISTANT,
      name: 'A',
      ownerUserId: 'owner-1',
      workspaceId: '33333333-3333-3333-3333-333333333333',
      clearance: 'internal',
      compartments: null,
      defaultCompartments: [],
      kind: 'standard',
      appType: null,
    })
    // The MCP body is not a valid initialize payload — the transport may
    // 4xx/5xx it; what we assert is that auth + authority resolution ran.
    await request(makeApp(store))
      .post(`/api/v1/assistants/${ASSISTANT}/mcp`)
      .set('Authorization', `Bearer ${plaintext}`)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(findAssistantById).toHaveBeenCalledWith(ASSISTANT)
    expect(capabilityStore.listActive).toHaveBeenCalledWith(ASSISTANT)
  })

  it('GET is 405 (tools-only server, POST-only transport)', async () => {
    const { store } = await fakeApiKey({ assistantId: ASSISTANT })
    const res = await request(makeApp(store)).get(`/api/v1/assistants/${ASSISTANT}/mcp`)
    expect(res.status).toBe(405)
  })
})
