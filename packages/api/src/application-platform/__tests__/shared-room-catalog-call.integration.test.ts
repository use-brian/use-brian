/**
 * Shared-room catalog call at the real boundary (POST /chat on a workspace
 * room): the connector runtime authority pins and renews the actor's native
 * floor under the same scope, so the room audience that narrows the tool call
 * is not mistaken for revocation, and an actual authority change during the
 * call still fails closed with the result withheld. [COMP:api/connector-context]
 */
import { randomBytes } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterAll, describe, expect, it } from 'vitest'
import type { LLMProvider, Message, StreamChunk } from '@use-brian/agent-runtime/providers/types.js'
import { chatRoutes } from '../../routes/chat.js'
import { getAppPool, getPool } from '../../db/client.js'
import { authSessionStore } from '../../db/auth-session-store.js'
import { createDbMemoryStore } from '../../db/memory-store.js'
import { createDbCapabilityStore } from '../../db/capability-store.js'
import { createPendingApprovalsStore } from '../../db/pending-approvals-store.js'
import { createDbConnectorStore } from '../../db/connector-store.js'
import { createDbMcpSettingsStore } from '../../db/mcp-settings-store.js'
import { createIntrospectionTools } from '@use-brian/core/introspection/tools.js'
import { persistentContextFixture } from './fixtures/persistent-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

const CALL = { id: 'fictional-room-lookup', server: 'introspection', tool: 'listPendingApprovals' } as const
const RESULT = 'No approvals are pending in this workspace.'
const REPLY = 'The fictional room has nothing waiting.'

type Fixture = Awaited<ReturnType<typeof persistentContextFixture>>

async function roomTurn(f: Fixture, during?: () => Promise<void>) {
  const approvals = createPendingApprovalsStore()
  let lookups = 0
  const unused = () => { throw new Error('Only listPendingApprovals is offered') }
  const introspectionTools = createIntrospectionTools({
    pendingApprovals: { async listPendingForWorkspace(userId: string, workspaceId: string) {
      lookups++
      const rows = await approvals.listPendingForWorkspace(userId, workspaceId)
      await during?.()
      return rows
    } },
    scheduledJobs: { search: unused }, workerRuns: { listRecentForWorkspace: unused },
    sessionHistory: { listSessionsForWorkspaceSystem: unused, getSessionTranscriptForWorkspaceSystem: unused },
  } as unknown as Parameters<typeof createIntrospectionTools>[0]).filter(tool => tool.name === CALL.tool)
  const rounds: Message[][] = []
  const callChunks: StreamChunk[] = [{ type: 'message_start', model: 'fixture' }, { type: 'tool_use_start', id: CALL.id, name: 'mcp_call' },
    { type: 'tool_use_delta', id: CALL.id, input: JSON.stringify({ server: CALL.server, tool: CALL.tool, args: {} }) },
    { type: 'tool_use_end', id: CALL.id }, { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } }]
  const replyChunks: StreamChunk[] = [{ type: 'message_start', model: 'fixture' }, { type: 'text_delta', text: REPLY },
    { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } }]
  const provider: LLMProvider = { name: 'fictional-room', models: ['fixture'],
    stream: async function* () { yield* replyChunks },
    createSession() { return { send(messages) {
      rounds.push(structuredClone(messages))
      const chunks = rounds.length === 1 ? callChunks : replyChunks
      return (async function* () { yield* chunks })()
    } } },
  }
  const device = (await authSessionStore.create(f.ownerId, { deviceLabel: 'Fictional room browser', userAgent: null, ipAddress: null }))!
  const app = express(); app.use(express.json()); app.use((req, _res, next) => {
    req.userId = f.ownerId; req.authSessionId = device.id; req.authVersion = device.authVersion; next()
  })
  app.use('/chat', chatRoutes({ provider, systemPrompt: 'Answer in the fictional room.', tools: new Map(),
    memoryStore: createDbMemoryStore(), capabilityStore: createDbCapabilityStore(), pendingApprovalsStore: approvals,
    connectorStore: createDbConnectorStore(randomBytes(32)), mcpSettingsStore: createDbMcpSettingsStore(), introspectionTools }))
  const response = await request(app).post('/chat').send({ sessionId: f.session.id, assistantId: f.assistantId, workspaceId: f.workspaceId,
    message: 'Is anything waiting for approval?', mode: 'default', model: 'pro' }).buffer(true).parse((res, done) => {
    let body = ''; res.on('data', (chunk: Buffer) => { body += chunk.toString() }); res.on('end', () => done(null, body)); res.on('error', done)
  })
  return { status: response.status, body: response.body as string, rounds, lookups }
}

describe('[COMP:api/connector-context] shared-room catalog call authority', () => {
  afterAll(async () => { await getAppPool().end(); await getPool().end() })

  it.each([false, true])('one catalog call in a shared room succeeds (department v2: %s)', async v2 => {
    const f = await persistentContextFixture('confidential')
    try {
      await f.pool.query("UPDATE workspaces SET department_read_v2=$2,plan='pro' WHERE id=$1", [f.workspaceId, v2])
      const turn = await roomTurn(f)
      expect(turn.status).toBe(200)
      expect(turn.body).not.toContain('event: error')
      expect(turn.lookups).toBe(1)
      expect(turn.rounds).toHaveLength(2)
      expect(JSON.stringify(turn.rounds[1])).toContain(CALL.id)
      expect(JSON.stringify(turn.rounds[1])).toContain(RESULT)
      expect(turn.body).toContain(REPLY)
    } finally { await f.cleanup() }
  }, 120_000)

  it('an actual authority change during the call still fails closed and withholds the result', async () => {
    const f = await persistentContextFixture('confidential')
    try {
      await f.pool.query("UPDATE workspaces SET plan='pro' WHERE id=$1", [f.workspaceId])
      // Another administrator lowers the answering assistant's clearance while
      // the lookup runs: the room's own audience did not change, its authority did.
      const turn = await roomTurn(f, async () => {
        await f.pool.query("UPDATE assistants SET clearance='public' WHERE id=$1", [f.assistantId])
      })
      expect(turn.status).toBe(200)
      expect(turn.lookups).toBe(1)
      expect(turn.body).toContain('event: error')
      expect(turn.body).toContain('"code":"authority_changed"')
      expect(turn.body).toContain('"operationMayHaveExecuted":true')
      // The stale result never reaches the model.
      expect(turn.rounds).toHaveLength(1)
      expect(turn.body).not.toContain(REPLY)
    } finally { await f.cleanup() }
  }, 120_000)
})
