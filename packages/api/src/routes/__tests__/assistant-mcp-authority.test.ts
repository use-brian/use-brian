/** Real MCP HTTP transport and native executor; DB identity is the mocked boundary. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { z } from 'zod'
import {
  buildTool, createExecutionContext, type ToolContext,
} from '@use-brian/core'
import { createAuthorityLease } from '../../context-scope/authority-lease.js'
import type { ResolveExecutionContextInput } from '../../context-scope/execution-context.js'
import { currentAgentAccess } from '../../db/agent-access-context.js'
import { hashSecret, mintPlaintext, type ApiKeyStore } from '../../db/api-key-store.js'
import { assistantMcpRoutes } from '../assistant-mcp.js'
import { manageBriefSchema } from '../../briefs/tools.js'

const state = vi.hoisted(() => ({ member: true, contextInputs: [] as unknown[] }))
const ASSISTANT = '22222222-2222-4222-8222-222222222222'
const KEY = '33333333-3333-4333-8333-333333333333'
const WORKSPACE = '44444444-4444-4444-8444-444444444444'
vi.mock('../../db/users.js', () => ({ findAssistantById: async (id: string) => ({
  id, workspaceId: '44444444-4444-4444-8444-444444444444', ownerUserId: 'owner',
  kind: 'standard', clearance: 'internal', compartments: [], defaultCompartments: [],
}) }))
vi.mock('../../db/workspace-store.js', () => ({ getWorkspaceRoleSystem: vi.fn(async () => state.member ? 'member' : null) }))
vi.mock('../../context-scope/execution-context.js', () => ({
  resolveExecutionContextSystem: async (input: ResolveExecutionContextInput) => {
    state.contextInputs.push(input)
    const access = {
      workspaceId: input.workspaceId!, userId: input.userId, assistantId: input.assistant.id,
      assistantKind: 'standard' as const, clearance: 'internal' as const,
      compartments: [], mutationCompartments: [], projectIds: [], visibilityAssistantIds: [input.assistant.id],
    }
    const authority = createAuthorityLease(access, async () => await input.credentialCurrent!() ? access : null)
    return { executionContext: createExecutionContext({ ...input, access, authority,
      writeDefaults: { compartments: [], projectIds: [] },
    }), turnScope: { access, writeCompartments: [], writeProjectIds: [] } }
  },
}))

async function fixture(options: { issuer?: string | null; ask?: boolean; onExecute?: () => void; inputSchema?: z.ZodTypeAny } = {}) {
  const minted = mintPlaintext(KEY)
  const key = {
    id: KEY, assistantId: ASSISTANT, name: 'Test integration', prefix: minted.prefix,
    scope: 'agent' as const, audience: 'external' as const, anonymousContext: 'thin' as const,
    toolPolicy: 'assistant' as const, status: 'active' as 'active' | 'revoked',
    issuerUserId: options.issuer === undefined ? 'issuer' : options.issuer,
    createdBy: options.issuer === undefined ? 'issuer' : options.issuer,
    keyHash: await hashSecret(minted.secret), createdAt: new Date(), lastUsedAt: null,
  }
  const capabilities = new Set(['tasks', 'home_app:tasks:read', 'configure'])
  const contexts: ToolContext[] = []
  const inputs: unknown[] = []
  const execute = vi.fn(async (_input: unknown, ctx: ToolContext) => {
    contexts.push(ctx)
    inputs.push(_input)
    expect(currentAgentAccess()?.userId).toBe(ctx.userId)
    options.onExecute?.()
    return { data: { result: 'protected-output', actor: ctx.userId } }
  })
  const common = { description: 'An example operation', inputSchema: options.inputSchema ?? z.object({}), execute }
  const read = buildTool({ ...common, name: 'readExample', isReadOnly: true, requiresCapability: 'tasks' })
  const write = buildTool({ ...common, name: 'writeExample', requiresConfirmation: options.ask === true })
  const app = express()
  app.use(express.json())
  app.use('/api/v1', assistantMcpRoutes({
    apiKeyStore: { getByIdSystem: async () => key } as unknown as ApiKeyStore,
    capabilityStore: { listActive: async () => [...capabilities] } as never,
    agentTools: { reads: new Map([[read.name, read]]), writes: new Map([[write.name, write]]) },
  }))
  async function call(method = 'tools/call', params: unknown = { name: 'readExample', arguments: {} }) {
    const response = await request(app).post(`/api/v1/assistants/${ASSISTANT}/mcp`)
      .set('Authorization', `Bearer ${minted.plaintext}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method, params })
    const data = response.text.split('\n').find(line => line.startsWith('data: '))
    const body = data ? JSON.parse(data.slice(6)) : response.body
    return { response, body }
  }
  return { key, capabilities, execute, contexts, inputs, call }
}

beforeEach(() => { state.member = true; state.contextInputs = [] })

describe('[COMP:api/assistant-mcp] admitted HTTP execution', () => {
  it('executes as the actual issuer through the native policy boundary', async () => {
    const f = await fixture()
    const { response, body } = await f.call()
    expect(response.status).toBe(200)
    expect(body.result).toMatchObject({ isError: false,
      structuredContent: { status: 'succeeded', data: { actor: 'issuer' } } })
    expect(f.contexts[0]).toMatchObject({ userId: 'issuer', sessionPersisted: false, attended: false })
    expect(f.contexts[0]?.workspaceActorUserId).toBeUndefined()
    expect(state.contextInputs[0]).toMatchObject({ userId: 'issuer', workspaceId: WORKSPACE,
      identity: { kind: 'programmatic', principal: { kind: 'assistant_key', credentialId: KEY } },
      attribution: { billingUserId: 'owner' },
    })
  })


  it('discovers the real native Brief union and validates branch-specific arguments', async () => {
    const f = await fixture({ inputSchema: manageBriefSchema })
    const { response, body } = await f.call('tools/list', {})
    expect(response.status).toBe(200)
    const schema = body.result.tools.find((tool: { name: string }) => tool.name === 'readExample').inputSchema
    expect(schema.type).toBe('object')
    expect(schema.anyOf).toHaveLength(8)
    expect(schema.anyOf[2]).toMatchObject({ required: ['action', 'proposalId'], additionalProperties: false })
    // Every JSON Pointer resolves within the schema published to the client.
    function checkRefs(node: unknown): void {
      if (!node || typeof node !== 'object') return
      for (const [key, value] of Object.entries(node)) {
        if (key === '$ref' && typeof value === 'string' && value.startsWith('#/')) {
          let target: unknown = schema
          for (const part of value.slice(2).split('/')) target = (target as Record<string, unknown>)[part.replace(/~1/g, '/').replace(/~0/g, '~')]
          expect(target).toBeDefined()
        } else checkRefs(value)
      }
    }
    checkRefs(schema)
    expect((await f.call('tools/call', { name: 'readExample', arguments: { action: 'dismiss' } })).body.result.isError).toBe(true)
    expect(f.execute).not.toHaveBeenCalled()
    const args = { action: 'dismiss', proposalId: KEY }
    expect((await f.call('tools/call', { name: 'readExample', arguments: args })).body.result.isError).toBe(false)
    expect(f.inputs).toEqual([args])
  })

  it('retains native refinements and does not double-apply input transforms', async () => {
    const f = await fixture({ inputSchema: z.object({ amount: z.number().transform(n => n + 1) }).strict()
      .refine(value => value.amount > 1, { message: 'Amount must be positive' }) })
    expect((await f.call('tools/list', {})).body.result.tools[0].inputSchema).toMatchObject({
      type: 'object', properties: { amount: { type: 'number' } }, additionalProperties: false,
    })
    expect((await f.call('tools/call', { name: 'readExample', arguments: { amount: 0 } })).body.result.isError).toBe(true)
    expect(f.execute).not.toHaveBeenCalled()
    expect((await f.call('tools/call', { name: 'readExample', arguments: { amount: 1 } })).body.result.isError).toBe(false)
    expect(f.inputs).toEqual([{ amount: 2 }])
  })

  it('refuses a departed issuer instead of falling back to the owner', async () => {
    const f = await fixture()
    state.member = false
    expect((await f.call()).response.status).toBe(401)
    expect(f.execute).not.toHaveBeenCalled()
    expect(state.contextInputs).toHaveLength(0)
  })

  it('preserves owner binding only for a legacy key with no recorded issuer', async () => {
    const f = await fixture({ issuer: null })
    expect((await f.call()).body.result.structuredContent.data.actor).toBe('owner')
  })

  it('keeps configuration writes out of discovery when configure is absent', async () => {
    const f = await fixture()
    f.capabilities.delete('configure')
    const { body } = await f.call('tools/list', {})
    expect(body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['readExample'])
  })

  it('uses native Ask policy instead of directly executing a write', async () => {
    const f = await fixture({ ask: true })
    expect((await f.call('tools/call', { name: 'writeExample', arguments: {} })).body.result.isError).toBe(true)
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('withholds results when the key is revoked during execution', async () => {
    const f = await fixture({ onExecute: () => { f.key.status = 'revoked' } })
    const { body } = await f.call()
    expect(f.execute).toHaveBeenCalledOnce()
    expect(body.result.isError).toBe(true)
    expect(JSON.stringify(body)).not.toContain('protected-output')
  })
})
