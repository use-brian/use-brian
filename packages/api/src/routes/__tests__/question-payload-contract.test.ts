/**
 * askQuestion payload contract: every `askQuestionSchema` field the model sends
 * reaches every boundary of a suspended question (engine hook, direct stream
 * frame, durability marker, stored `arguments` and `approval_payload`, and the
 * `GET /api/sessions/:id/pending` read), on the web hook shape and on the
 * workspace MCP run hook. The fixture must name every schema key,
 * so a new schema field fails here until it is carried end to end.
 * Spec: docs/architecture/engine/askquestion-suspend-resume.md → "Question payload contract".
 * Component tag: [COMP:api/pending-questions-resume].
 */
import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ inserts: [] as unknown[][] }))
vi.mock('../../db/client.js', () => ({
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('INSERT INTO pending_approvals')) {
      db.inserts.push(params)
      return { rows: [{ id: 'fictional-approval', workspaceId: params[0], kind: 'question', blockingSessionId: params[1],
        originatingAssistantId: params[2], approverUserId: params[3], toolName: 'askQuestion',
        arguments: JSON.parse(params[4] as string), approvalPayload: JSON.parse(params[5] as string),
        deliveryChannelType: params[6], deliveryChannelId: params[7], expiresAt: params[8], status: 'pending',
        createdAt: new Date('2026-11-17T00:00:00Z') }] }
    }
    // Session read gate stand-in for the route half.
    return { rows: [{ workspaceId: 'fictional-workspace', allowed: true }] }
  }),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))
vi.mock('../../brain-stream/notify.js', () => ({ notifyWorkspaceChange: vi.fn(), notifyBrainWriteIfMatch: vi.fn() }))
vi.mock('../../db/workspace-store.js', () => ({
  getWorkspaceMembershipWithReadScopeSystem: vi.fn(async () => ({ clearance: 'internal', compartments: null, projectIds: null })),
}))
vi.mock('../../db/sessions.js', () => ({
  findSessionById: vi.fn(async () => ({ id: 'fictional-session', assistantId: 'fictional-assistant', userId: 'fictional-user' })),
  findSessionTurnLeaseState: vi.fn(async () => null),
  readSessionById: vi.fn(),
}))
vi.mock('../../db/users.js', () => ({ findAssistantById: vi.fn(async () => ({ workspaceId: 'fictional-workspace' })),
  getUserAssistant: vi.fn(async () => ({ id: 'fictional-assistant' })) }))

import { askQuestionSchema, askQuestionTool } from '@use-brian/agent-runtime/tools/base/ask-question.js'
import { queryLoop, type QueryEvent } from '@use-brian/agent-runtime/engine/query-loop.js'
import { NOOP_TURN_LEDGER } from '@use-brian/agent-runtime/engine/turn-ledger.js'
import type { LLMProvider, StreamChunk } from '@use-brian/agent-runtime/providers/types.js'
import type { ToolContext } from '@use-brian/agent-runtime/tools/types.js'
import { createPendingApprovalsStore, type PendingApproval } from '../../db/pending-approvals-store.js'
import { sessionQuestionRoutes } from '../sessions-questions.js'

/** One valid value per schema key. Adding a schema field without a value here fails the first assertion. */
const MODEL_INPUT = {
  question: 'Which fictional colour should the report use?',
  allowCustom: false,
  actionId: 'fictional_palette_choice',
  version: 2,
  context: 'Fictional style guide, section 3',
  options: ['Blue', 'Green', 'Amber'],
}

function provider(): LLMProvider {
  const chunks: StreamChunk[] = [
    { type: 'message_start', model: 'fixture' },
    { type: 'tool_use_start', id: 'call_contract', name: 'askQuestion' },
    { type: 'tool_use_delta', id: 'call_contract', input: JSON.stringify(MODEL_INPUT) },
    { type: 'tool_use_end', id: 'call_contract' },
    { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 2, outputTokens: 2 } },
  ]
  const send = () => (async function* () { yield* chunks })()
  return { name: 'fictional-contract', models: ['fixture'], stream: send, createSession: () => ({ send }) }
}

describe('[COMP:api/pending-questions-resume] askQuestion payload contract', () => {
  it('round-trips every schema field from the model call to the pending read', async () => {
    const keys = Object.keys(askQuestionSchema.shape).sort()
    expect(Object.keys(MODEL_INPUT).sort()).toEqual(keys)

    // Engine: the hook, the direct stream frame and the durability marker.
    const store = createPendingApprovalsStore()
    let stored: PendingApproval | undefined
    const context: ToolContext = { userId: 'fictional-user', assistantId: 'fictional-assistant', sessionId: 'fictional-session',
      appId: 'fixture', channelType: 'web', channelId: 'fictional-channel', abortSignal: new AbortController().signal,
      // The web route's port shape: the hook params go to the store as they are.
      createPendingQuestion: async ({ expiresAt, ...params }) => {
        stored = await store.createQuestion({ ...params, workspaceId: 'fictional-workspace', blockingSessionId: 'fictional-session',
          originatingAssistantId: 'fictional-assistant', approverUserId: 'fictional-user', deliveryChannelType: 'web', expiresAt })
        return stored.id
      } }
    const events: QueryEvent[] = []
    for await (const event of queryLoop({ ledger: NOOP_TURN_LEDGER, provider: provider(), model: 'fixture', systemPrompt: 'Fictional.',
      messages: [{ role: 'user', content: 'Draft the fictional report.' }], tools: new Map([['askQuestion', askQuestionTool]]),
      context, maxTurns: 3, questionResumeEnabled: true })) events.push(event)
    const frame = events.find(event => event.type === 'tool_confirmation_required')
    const marker = events.find(event => event.type === 'awaiting_approval')
    expect(frame?.type === 'tool_confirmation_required' && frame.request.input).toEqual(MODEL_INPUT)
    expect(marker?.type === 'awaiting_approval' && marker.toolInput).toEqual(MODEL_INPUT)
    expect(events.some(event => event.type === 'turn_complete')).toBe(false)

    // Store: the insert's `arguments` and `approval_payload` carry every field.
    expect(db.inserts).toHaveLength(1)
    const [insert] = db.inserts
    expect(JSON.parse(insert![4] as string)).toEqual(MODEL_INPUT)
    expect(JSON.parse(insert![5] as string)).toEqual({ ...MODEL_INPUT, toolUseId: 'call_contract' })

    // Read: GET /pending serves every field of the stored row.
    const app = express()
    app.use((req, _res, next) => { (req as { userId?: string }).userId = 'fictional-user'; next() })
    app.use('/api/sessions', sessionQuestionRoutes({
      approvalsStore: { listPendingForWorkspace: vi.fn(async () => [stored!]) } as never,
      resumeDeps: { sessionResumeStore: { getBySessionId: vi.fn(async () => null) } } as never,
    }))
    const res = await request(app).get('/api/sessions/fictional-session/pending').expect(200)
    expect(res.body.pending).toEqual({ approvalId: 'fictional-approval', ...MODEL_INPUT,
      expiresAt: expect.any(String), createdAt: '2026-11-17T00:00:00.000Z', action: null })
    for (const key of keys) expect(res.body.pending, `pending read drops ${key}`).toHaveProperty(key)
    expect(JSON.stringify(res.body)).not.toContain('call_contract')
  })

  it('carries every schema field through the workspace MCP run hook, never a connector authorization action', async () => {
    const { workspaceMcpQuestionParams } = await import('../../workspace-mcp/runs.js')
    const store = createPendingApprovalsStore()
    const run = { workspaceId: 'fictional-workspace', sessionId: 'fictional-session', assistantId: 'fictional-assistant',
      userId: 'fictional-user', runId: 'fictional-run' }
    const expiresAt = new Date('2026-11-18T00:00:00Z')
    db.inserts.length = 0
    // The engine hands the hook its payload plus the engine idents.
    const stored = await store.createQuestion(workspaceMcpQuestionParams({ ...MODEL_INPUT, toolUseId: 'call_mcp', expiresAt }, run))
    expect(JSON.parse(db.inserts[0]![4] as string)).toEqual(MODEL_INPUT)
    expect(JSON.parse(db.inserts[0]![5] as string)).toEqual({ ...MODEL_INPUT, toolUseId: 'call_mcp', workspaceMcpRunId: 'fictional-run' })
    expect(stored.approvalPayload).toMatchObject(MODEL_INPUT)
    // The lane cannot admit a connector action (no capability check, and a machine answer never completes one).
    await store.createQuestion(workspaceMcpQuestionParams({ ...MODEL_INPUT, actionId: 'connector_authorization:gcal',
      toolUseId: 'call_mcp_connector', expiresAt }, run))
    const { actionId: _dropped, ...withoutAction } = MODEL_INPUT
    expect(JSON.parse(db.inserts[1]![4] as string)).toEqual(withoutAction)
    expect(JSON.parse(db.inserts[1]![5] as string)).not.toHaveProperty('actionId')
  })
})
