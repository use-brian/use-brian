import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
vi.mock('../db/client.js', () => ({ query: vi.fn() }))
import { query } from '../db/client.js'
import { buildTool, createOpenAICompatProvider, protectNativeImage, queryLoop, NOOP_TURN_LEDGER, type QueryEvent, type ToolContext } from '@use-brian/core'
import { NATIVE_PROTOCOL, type NativeProfileGrant } from '@use-brian/computer-control/protocol.js'
import { createOssNativeAccounting, type NativeAccountingConnection } from '../db/oss-native-accounting.js'
import { createProfileImageAccounting } from './profile-image-accounting.js'
import { NativeComputerService } from './service.js'
import { nativePrice } from './accounting-capability.js'

// Production SQL/migrations on isolated PostgreSQL-in-WASM. No external database,
// mock receipt, fabricated ledger event, task/goal row or publication bypass.
const db = new PGlite()
let tail = Promise.resolve()
const connect = async (): Promise<NativeAccountingConnection> => {
  const prior = tail
  let unlock!: () => void
  tail = new Promise<void>(resolve => { unlock = resolve })
  await prior
  return { query: (sql, params) => db.query(sql, params), release: () => unlock() }
}
const ids = { user: randomUUID(), workspace: randomUUID(), assistant: randomUUID(), chat: randomUUID(), profile: randomUUID(), native: randomUUID() }
const MODEL = 'gemini-3.8-flash'
const validatedUsage = { inputTokens: 100, outputTokens: 20 }
const PRIVATE = Buffer.from('synthetic public fixture').toString('base64')
beforeAll(async () => {
  await db.exec(`CREATE TABLE users(id uuid PRIMARY KEY);
    CREATE TABLE workspaces(id uuid PRIMARY KEY,owner_user_id uuid REFERENCES users(id));
    CREATE TABLE assistants(id uuid PRIMARY KEY,workspace_id uuid REFERENCES workspaces(id),owner_user_id uuid REFERENCES users(id));
    CREATE TABLE sessions(id uuid PRIMARY KEY); CREATE TABLE tasks(id uuid PRIMARY KEY); CREATE TABLE auth_sessions(id uuid PRIMARY KEY);`)
  for (const file of ['476_oss_usage_tracking.sql', '620_native_computer_sessions.sql', '621_native_usage_receipts.sql', '622_computer_profiles.sql']) {
    await db.exec(await readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'))
  }
}, 30000)
beforeEach(async () => {
  await db.exec('TRUNCATE native_computer_billing_intents,oss_usage_tracking,native_computer_sessions,users,workspaces,assistants,sessions,tasks,auth_sessions CASCADE')
  await db.query('INSERT INTO users(id) VALUES ($1)', [ids.user])
  await db.query('INSERT INTO workspaces(id,owner_user_id) VALUES ($1,$2)', [ids.workspace,ids.user])
  await db.query('INSERT INTO assistants(id,workspace_id,owner_user_id) VALUES ($1,$2,$3)', [ids.assistant,ids.workspace,ids.user])
  await db.query('INSERT INTO sessions(id) VALUES ($1)', [ids.chat])
  await db.query("INSERT INTO computer_profiles(id,owner_user_id,workspace_id,name) VALUES ($1,$2,$3,'Public fixture')", [ids.profile,ids.user,ids.workspace])
  await db.query(`INSERT INTO native_computer_sessions(id,user_id,workspace_id,assistant_id,conversation_id,task_id,profile_id,device_id,deployment_id,challenge,epoch,state,expires_at,grant_id)
    VALUES ($1,$2,$3,$4,$5,NULL,$6,'device','deployment','challenge',1,'active',now()+interval '1 hour','grant')`,
    [ids.native,ids.user,ids.workspace,ids.assistant,ids.chat,ids.profile])
  vi.mocked(query).mockImplementation(((sql: string, args: unknown[]) => db.query(sql, args)) as typeof query)
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
afterAll(() => db.close())

async function probe(scenario: 'ok' | 'revoked' | 'revoked_during_settlement' | 'malformed' | 'missing' | 'mismatch' | 'unknown_model' | 'conflict' | 'length' | 'content_filter' | 'missing_finish') {
  let live = true
  const cap = createOssNativeAccounting(connect)
  const service = new NativeComputerService({ relayUrl: 'https://fixture.invalid', relaySecret: 'synthetic', jwtSecret: 'synthetic', deploymentId: 'deployment' })
  vi.spyOn(service, 'assertProfilePublication').mockImplementation(async () => { if (!live) throw new Error('revoked') })
  const accounting = createProfileImageAccounting(service, { ...cap, async reconcile(key) {
    const result = await cap.reconcile(key)
    if (scenario === 'revoked_during_settlement') live = false
    return result
  } })
  const provider = createOpenAICompatProvider({ apiKey: 'synthetic', baseURL: 'https://fixture.invalid', label: 'probe', models: [MODEL] })
  const authorityError = Object.assign(new Error('authority changed'), { reason: 'authority_changed' })
  const context: ToolContext = { userId: ids.user, workspaceId: ids.workspace, assistantId: ids.assistant, sessionId: ids.chat,
    appId: 'chat', channelType: 'web', channelId: ids.chat, abortSignal: new AbortController().signal,
    engineRuntime: { provider, model: MODEL, imageUploads: true },
    authority: { async assertCurrent() { if (!live) throw authorityError }, async execute<T>(fn: () => Promise<T>) { if (!live) throw authorityError; return fn() } } }
  const grant: NativeProfileGrant = { protocol: NATIVE_PROTOCOL, identity: { deploymentId: 'deployment', deviceId: 'device', sessionId: ids.native,
    userId: ids.user, workspaceId: ids.workspace, conversationId: ids.chat, profileId: ids.profile }, grantId: 'grant', epoch: 1,
    expiresAt: Date.now() + 60000, targets: [{ appId: 'com.usebrian.NativeComputerFixture', processId: 1, processInstanceId: 'p', windowId: 'w', windowInstanceId: 'wi' }],
    allowCapture: true, allowControl: true, requester: 'owner', purpose: 'chat-tools' }
  const scope = { userId: ids.user, workspaceId: ids.workspace, assistantId: ids.assistant, conversationId: ids.chat, taskId: null,
    profileId: ids.profile, connectionId: randomUUID(), toolName: 'computerCapture' }
  const observed = vi.fn()
  const ref = protectNativeImage({ mimeType: 'image/png', data: PRIVATE }, context, { expiresAt: Date.now() + 5000,
    assertCurrent: async () => { await context.authority!.assertCurrent() }, reserve: async () => {}, observed,
    beginAttempt: current => accounting(current, grant, scope) })
  const tool = buildTool({ name: 'computerAct', description: 'Locally approved action', inputSchema: z.object({}), execute: vi.fn(async () => ({ data: 'executed' })) })
  const actual = scenario === 'mismatch' ? 'claude-haiku-4-5-20251001' : scenario === 'unknown_model' ? 'unknown-unpriced-model' : MODEL
  const hasTools = ['length', 'content_filter', 'missing_finish'].includes(scenario)
  const fetch = vi.fn(async (_url, init) => {
    expect(String(init.body)).toContain(PRIVATE)
    // Provider was dispatched only after admission committed.
    expect((await db.query('SELECT * FROM native_computer_billing_intents')).rows).toHaveLength(1)
    const frames: object[] = [{ model: actual, choices: [{ delta: hasTools ? { tool_calls: [{ index: 0, id: 'call', function: { name: 'computerAct', arguments: '{}' } }] } : { content: 'Public fixture.' },
      finish_reason: scenario === 'missing_finish' ? undefined : hasTools ? scenario : 'stop' }],
      ...(scenario === 'missing' ? {} : { usage: { prompt_tokens: 100, completion_tokens: scenario === 'malformed' ? -7 : 20 } }) }]
    if (scenario === 'conflict') frames.push({ model: 'different-model', choices: [] })
    if (scenario === 'revoked') {
      live = false
      await db.query("UPDATE native_computer_sessions SET revoked_at=now(),epoch=epoch+1,state='ended' WHERE id=$1", [ids.native])
    }
    return new Response(frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  })
  vi.stubGlobal('fetch', fetch)
  const events: QueryEvent[] = []
  let error: unknown
  try {
    for await (const event of queryLoop({ ledger: NOOP_TURN_LEDGER, provider, model: MODEL, systemPrompt: 'Public fixture only',
      messages: [{ role: 'user', content: [{ type: 'image', ...ref }] }], tools: new Map([[tool.name, tool]]), context, maxTurns: 1 })) events.push(event)
  } catch (e) { error = e }
  const audit = (await db.query<Record<string, unknown>>('SELECT * FROM native_computer_inference_attempts')).rows[0]!
  const intent = (await db.query<Record<string, unknown>>('SELECT * FROM native_computer_billing_intents')).rows[0]!
  const ledger = (await db.query<Record<string, unknown>>('SELECT * FROM oss_usage_tracking')).rows
  expect(JSON.stringify({ audit, intent, ledger, events })).not.toContain(PRIVATE)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(tool.execute).not.toHaveBeenCalled()
  return { events, error, ledger, audit, intent, observed, cap, actual }
}

describe('normal chat screenshot durable accounting boundary', () => {
  it.each(['length', 'content_filter', 'missing_finish'] as const)('rejects %s tool output before observation/actions, but settles consumed validated tokens', async scenario => {
    const p = await probe(scenario)
    expect(p.observed).not.toHaveBeenCalled()
    expect(p.events.some(e => e.type === 'tool_start')).toBe(false)
    expect(p.ledger).toHaveLength(1)
    expect(p.audit).toMatchObject({ outcome: 'failed', usage: validatedUsage, model: MODEL })
  })
  it('persists 100 input / 20 output after authority revocation, before ANY publication and without a live lease', async () => {
    const p = await probe('revoked')
    expect(p.error).toMatchObject({ reason: 'authority_changed' })
    expect(p.events).toEqual([])
    expect(p.observed).not.toHaveBeenCalled()
    expect(p.ledger).toHaveLength(1)
    expect(p.ledger[0]).toMatchObject({ input_tokens: 100, output_tokens: 20, model: MODEL })
    expect(p.audit).toMatchObject({ invocation_state: 'settled', billing_state: 'recorded', interrupted: true, outcome: 'failed' })
    const key = { nativeSessionId: ids.native, invocationId: p.audit.attempt_id as string }
    const receipt = await p.cap.reconcile(key)
    expect(await p.cap.reconcile(key)).toEqual(receipt)
    expect((await db.query('SELECT * FROM oss_usage_tracking')).rows).toHaveLength(1)
    expect((p.intent.admission as { scope: object }).scope).toMatchObject({ taskId: null, profileId: ids.profile })
  })
  it('rechecks publication after durable settlement awaits without double charging', async () => {
    const p = await probe('revoked_during_settlement')
    expect(p.error).toMatchObject({ reason: 'authority_changed' })
    expect(p.events).toEqual([])
    expect(p.observed).not.toHaveBeenCalled()
    expect(p.ledger).toHaveLength(1)
    expect(p.ledger[0]).toMatchObject({ input_tokens: 100, output_tokens: 20, model: MODEL })
  })
  it.each(['malformed', 'missing'] as const)('retains %s usage as NULL/unknown, never forwards legacy counters or invents zero/free usage', async scenario => {
    const p = await probe(scenario)
    expect(p.ledger).toEqual([])
    expect(p.audit).toMatchObject({ usage: null, incurred_cost_usd: null, estimated_billed_cost_usd: null, billed_cost_usd: null, billing_state: 'unknown', model: MODEL })
    expect(p.intent).toMatchObject({ state: 'admitted', intent: null, receipt: null })
    expect(p.events.some(e => ['assistant_turn', 'turn_complete', 'text_delta'].includes(e.type))).toBe(false)
    expect(p.observed).not.toHaveBeenCalled()
  })
  it('prices observed mismatched model, retains requested separately, and never bills the terminal main_response twice', async () => {
    const p = await probe('mismatch')
    expect(p.ledger).toHaveLength(1)
    expect(p.ledger[0]).toMatchObject({ model: p.actual, input_tokens: 100, output_tokens: 20,
      actual_cost_usd: nativePrice(p.actual, validatedUsage, 'platform').price!.amountUsd })
    expect(p.audit).toMatchObject({ requested_model: MODEL, model: p.actual, outcome: 'failed' })
    expect(p.observed).not.toHaveBeenCalled()
    expect(p.events.find(e => e.type === 'turn_complete')).toMatchObject({ response: { model: p.actual, usage: validatedUsage, usageAccounting: 'native_image' }, totalUsage: { inputTokens: 0, outputTokens: 0 } })
  })
  it.each(['unknown_model', 'conflict'] as const)('does not price %s provenance as the request or generic fallback', async scenario => {
    const p = await probe(scenario)
    expect(p.ledger).toEqual([])
    expect(p.audit).toMatchObject({ usage: validatedUsage, model: scenario === 'conflict' ? null : p.actual,
      requested_model: MODEL, billing_state: 'unknown', estimated_billed_cost_usd: null, billed_cost_usd: null })
    expect(p.observed).not.toHaveBeenCalled()
  })
  it('valid exact-model completion retains actual metrics but has no second generic billable usage', async () => {
    const p = await probe('ok')
    expect(p.observed).toHaveBeenCalledTimes(1)
    expect(p.ledger).toHaveLength(1)
    expect(p.events.find(e => e.type === 'turn_complete')).toMatchObject({ response: { usage: validatedUsage, usageAccounting: 'native_image' }, totalUsage: { inputTokens: 0, outputTokens: 0 } })
  })
})
