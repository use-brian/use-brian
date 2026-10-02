import { registerNativeAccounting } from '../computer-use/accounting-capability.js'
import { createOssNativeAccounting, type NativeAccountingConnection } from '../db/oss-native-accounting.js'
import { randomUUID } from 'node:crypto'
import * as nativeModels from '../computer-use/model-runtime.js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import {
  calculateCost, NativeRunTrace, NativeTraceEventSchema, DecisionAdapterRegistry, DecisionProviderError, NATIVE_NEXT_ACTION, NATIVE_VERIFY_PROGRESS, createNativeDecisionOperation, createNativeProgressOperation,
  type DecisionProvider, type LLMProvider, type NativeModelInput, type ToolContext, type UsageStore,
} from '@use-brian/core'
import type { NativeGrant } from '@use-brian/computer-control/protocol.js'
import { createDecisionAttemptUsageRecorder, createDecisionRuntime, type DecisionRuntimeAttempt } from '../decision-runtime.js'
import { createNativeComputerBootRuntimeFactory, createNativeAttemptRecorder } from '../computer-use/boot-runtime.js'
vi.mock('../db/client.js', () => ({ query: vi.fn() }))
import { query } from '../db/client.js'
import { NativeComputerService } from '../computer-use/service.js'

const id = '00000000-0000-4000-8000-000000000001'
const textCost = calculateCost('gpt-5.2', { inputTokens: 30,outputTokens: 4 })
const textBilled = Number(textCost.toFixed(10))
const hydraCost = calculateCost('gpt-5.2', { inputTokens: 20,outputTokens: 5 })
const hydraBilled = Number(hydraCost.toFixed(10))
const db = new PGlite()
const service = new NativeComputerService({ relayUrl: 'http://relay', relaySecret: 'secret', jwtSecret: 'secret', deploymentId: 'deployment' })
const audit = createNativeAttemptRecorder(service)
beforeAll(async () => {
  await db.exec(`CREATE TABLE users(id uuid PRIMARY KEY); CREATE TABLE workspaces(id uuid PRIMARY KEY,owner_user_id uuid);
    CREATE TABLE assistants(id uuid PRIMARY KEY,workspace_id uuid,owner_user_id uuid,created_at timestamptz DEFAULT now());
    CREATE TABLE sessions(id uuid PRIMARY KEY); CREATE TABLE tasks(id uuid PRIMARY KEY); CREATE TABLE auth_sessions(id uuid PRIMARY KEY);`)
  for (const table of ['users','workspaces','assistants','sessions','tasks','auth_sessions']) await db.query(`INSERT INTO ${table}(id) VALUES ($1)`, [id])
  await db.query('UPDATE assistants SET workspace_id=$1,owner_user_id=$1', [id])
  await db.query('UPDATE workspaces SET owner_user_id=$1', [id])
  for (const migration of ['476_oss_usage_tracking.sql','620_native_computer_sessions.sql','621_native_usage_receipts.sql'])
    await db.exec(await readFile(new URL(`../../migrations/${migration}`, import.meta.url), 'utf8'))
  await db.query(`INSERT INTO native_computer_sessions(id,user_id,workspace_id,assistant_id,conversation_id,task_id,device_id,deployment_id,challenge,expires_at,grant_id)
    VALUES ($1,$1,$1,$1,$1,$1,'device','deployment','challenge',now()+interval '1 hour','grant')`, [id])
  vi.mocked(query).mockImplementation(((sql: string, params: unknown[]) => db.query(sql, params)) as typeof query)
}, 30_000)
beforeEach(async () => { loseNativeCommitAck = false; failNativePrepare = false; await db.exec('DELETE FROM native_computer_billing_intents; DELETE FROM oss_usage_tracking; DELETE FROM native_computer_inference_attempts') })
afterAll(async () => { await db.close() })

let sqlQueue = Promise.resolve()
let loseNativeCommitAck = false
let failNativePrepare = false
function attachAccounting(store: UsageStore, probe: UsageStore['recordUsage'], supported = true) {
  const connect = async (): Promise<NativeAccountingConnection> => {
    const previous = sqlQueue; let release!: () => void
    sqlQueue = new Promise<void>(r => { release = r }); await previous
    let inserted = false
    return { release, query: async <R extends Record<string, unknown>>(sql: string, params?: unknown[]) => {
      if (failNativePrepare && sql.includes('SET intent=$3::jsonb')) { failNativePrepare = false; throw new Error('synthetic prepare failure') }
      const result = await db.query<R>(sql, params)
      if (sql.includes('INSERT INTO oss_usage_tracking') && result.rows[0]) {
        inserted = true
        const proof = (await db.query<{ intent: { admission: { lane: string } }; state: string }>("SELECT intent,state FROM native_computer_billing_intents WHERE state='prepared'")).rows
        expect(proof.some(r => r.intent.admission.lane === (params![13] as string).replace('computer_use:native_', ''))).toBe(true)
        // Probe the actual native SQL insertion, including transactional failure injection.
        const p = params!
        await probe({ userId: p[0] as string,workspaceId: p[1] as string,actorUserId: p[2] as string,assistantId: p[3] as string,
          sessionId: p[4] as string,model: p[5] as string,modelTier: p[6] as string,inputTokens: p[7] as number,outputTokens: p[8] as number,
          actualCostUsd: Number(p[11]),source: p[12] as string,triggerKey: p[13] as string,providerKeySource: p[14] as 'user' | 'platform' })
      }
      if (sql === 'COMMIT' && inserted && loseNativeCommitAck) { loseNativeCommitAck = false; throw new Error('lost commit response') }
      return result
    } }
  }
  const capability = createOssNativeAccounting(connect)
  if (supported) registerNativeAccounting(store, capability)
  return capability
}
async function fixture(mode: 'hybrid' | 'shadow' | 'llm_only', llmOutcome: 'ok' | 'partial' | 'failed' | 'unknown', primaryFails = false, primaryFast = false, progress = false, billingMode: 'forward' | 'missing' | 'lost' | 'failure' | 'duplicate' | 'mismatch' | 'audit_failure' = 'forward', trace?: NativeRunTrace, nativeMetadata: unknown = { actualModel: 'jev-1.13.0', usage: { inputTokens: 8, outputTokens: 1 } }) {
  const operationRef = progress ? NATIVE_VERIFY_PROGRESS : NATIVE_NEXT_ACTION
  const recordUsage = vi.fn<UsageStore['recordUsage']>(async () => {})
  const usageStore = { recordUsage: vi.fn(async () => { throw new Error('Native unkeyed dispatch forbidden') }) } as unknown as UsageStore
  const capability = attachAccounting(usageStore, recordUsage)
  const traces: DecisionRuntimeAttempt[] = []
  if (billingMode === 'failure') recordUsage.mockRejectedValue(new Error('central store unavailable'))
  const central = createDecisionAttemptUsageRecorder(billingMode === 'missing' ? undefined : usageStore, { nativeAcknowledgements: true })
  const calls: string[] = []
  const provider: LLMProvider = { name: 'openai', models: ['gpt-5.2'], createSession: vi.fn(), stream: async function* (request) {
    calls.push(request.model)
    yield { type: 'message_start', model: request.model }
    yield { type: 'text_delta', text: llmOutcome !== 'partial' && llmOutcome !== 'failed' ? JSON.stringify(progress ? { status: 'abstain', observationId: 'observation', evidence: [] } : { id: 'abstain' }) : 'private output' }
    if (llmOutcome === 'failed') throw new Error('raw secret from provider')
    if (llmOutcome === 'unknown') { yield { type: 'message_end', stopReason: 'end_turn' } as never; return }
    yield { type: 'message_end', nativeMetadata: { actualModel: request.model, usage: { inputTokens: 20, outputTokens: 5, calculatedCostUsd: 0.2 } }, stopReason: llmOutcome === 'ok' ? 'end_turn' : 'max_tokens', usage: { inputTokens: 20, outputTokens: 5, calculatedCostUsd: 0.2 } }
  } }
  let primaryCalls = 0
  const primary: DecisionProvider = {
    id: 'typesafe', supportsNativeStrict: true, capabilities: { primitives: ['choice'], batch: true, maxOptions: 255, maxQuestions: 64, maxRubricLevels: 10, maxInputTokens: 64000, uncertainty: ['native_distribution'] },
    evaluate: async request => {
      primaryCalls++
      if (primaryFails) throw new DecisionProviderError('transport', 'raw Jev secret')
      expect(request.nativeStrict).toBe(true)
      return { nativeMetadata: nativeMetadata as never, providerId: 'typesafe', model: request.model, answers: [{ kind: 'choice', questionId: 'next', value: 'abstain', evidence: { source: 'native_distribution', probabilities: { abstain: 1 } } }], usage: { inputTokens: 8, outputTokens: 1 } }
    },
  }
  const decisionRuntime = createDecisionRuntime({ nativeAccounting: capability, llmProvider: provider, defaultLlmModel: 'not-used',
    adapters: new DecisionAdapterRegistry().register('typesafe', () => primary),
    onAttempt: async attempt => {
      traces.push(attempt)
      const acknowledgement = billingMode === 'duplicate'
        ? (await Promise.all([central(attempt), central(attempt)]))[0] : await central(attempt)
      if (billingMode === 'lost') return // legacy callback forgot/lost the explicit receipt
      if (billingMode === 'mismatch' && acknowledgement) return { ...acknowledgement, invocationId: randomUUID() }
      return acknowledgement
    },
    resolveRoute: () => ({ mode, primaryModelId: 'typesafe-jev-1.13', llm: { provider, modelId: 'gpt-5.2' }, allowSyntheticProfile: true, allowOperationalFailover: true,
      profile: { id: 'profile', version: '1', mode: mode === 'shadow' ? 'shadow' : 'hybrid', operationId: operationRef.id, operationVersion: operationRef.version, stateVersion: operationRef.stateVersion, questionVersion: operationRef.questionVersion, modelCatalogId: 'typesafe-jev-1.13', modelWireId: 'jev-1.13.0', evaluationSegment: 'global', status: mode === 'shadow' ? 'evaluation' : 'approved', evidence: primaryFast ? 'recorded' : 'synthetic', policy: { minProbability: 0.9 }, totalTimeoutMs: 10000, primaryTimeoutMs: 5000, maxAttempts: 2, shadowSampleRate: 1 },
    }),
  })
  const target = { appId: 'com.apple.TextEdit', processId: 1, processInstanceId: 'p', windowId: 'w', windowInstanceId: 'wi' }
  const grant = { identity: { userId: id, workspaceId: id, conversationId: id, sessionId: id, taskId: id, deploymentId: 'deployment' }, epoch: 0, grantId: 'grant', targets: [target], goal: 'private goal' } as NativeGrant
  const context = { userId: id, workspaceActorUserId: id, workspaceId: id, sessionId: id, assistantId: id } as ToolContext
  const input = { goal: grant.goal, signal: new AbortController().signal, deadlineAt: Date.now() + 10000, candidates: [], observation: { target, identity: grant.identity, epoch: 1, foreground: true, completeness: 'complete', nodes: [], id: 'observation', capturedAt: Date.now(), monotonicMs: 1, bounds: { x: 0, y: 0, width: 640, height: 480 }, displayLayoutVersion: 'layout' } } as unknown as NativeModelInput
  const bootReconcile = vi.fn(capability.reconcile)
  let receiptObservations = 0
  const native = (await createNativeComputerBootRuntimeFactory({ provider, configuredProviders: new Set(['gemini']), getWorkspacePlan: async () => 'enterprise', resolveWorkspaceCustomLlm: async () => null, decisionRuntime, usageStore,
    nativeAccounting: { ...capability,reconcile: bootReconcile },
    recordAttempt: r => {
      if (r.primaryBillingAcknowledgement) {
        receiptObservations++
        if (billingMode === 'audit_failure') return Promise.reject(new Error('receipt observer unavailable'))
      }
      return audit(r)
    },
  })(context, grant, trace))!
  const span = trace?.startSpan(progress ? 'verification' : 'selection', 0)
  input.trace = span?.correlation
  let executionError: unknown
  const result = await native.decisionRuntime!.run({
    workspaceId: 'untrusted-workspace',
    request: { runId: span?.correlation.spanId ?? 'run', operation: operationRef, state: { goal: grant.goal, trustedBillingContext: { userId: 'forged' } }, questions: [{ kind: 'choice', id: 'next', prompt: 'private AX', options: [{ value: 'abstain' }, { value: 'ask_user' }] }] },
    operation: progress ? createNativeProgressOperation(input, native.llm, primaryFast) : createNativeDecisionOperation(input, native.llm, primaryFast),
  }).catch(error => {
    if (!(error instanceof Error) || error.message !== 'Native accounting unavailable') throw error
    executionError = error
    return undefined!
  })
  return { calls, primaryCalls, result, executionError, recordUsage, traces, bootReconcile, receiptObservations, rows: (await db.query<Record<string, unknown>>('SELECT * FROM native_computer_inference_attempts ORDER BY id')).rows }
}

describe('actual native DecisionRuntime metering', () => {
  it('records the fast primary decision without inventing a fallback or billing an LLM', async () => {
    const f = await fixture('hybrid', 'ok', false, true)
    expect(f.result.path).toBe('primary_complete')
    expect(f.calls).toEqual([])
    expect(f.recordUsage).toHaveBeenCalledTimes(1)
    expect(f.rows).toHaveLength(1)
    expect(f.rows[0]).toMatchObject({ operation: 'next-action', stage: 'primary_decision', perception_path: 'ax',
      disposition: 'complete', fallback_reason: 'none', model: 'typesafe-jev-1.13' })
  })
  it.each([
    ['absent', null],
    ['unknown', { actualModel: null, usage: { inputTokens: 8, outputTokens: 1 } }],
    ['unregistered', { actualModel: 'unregistered-jev', usage: { inputTokens: 8, outputTokens: 1 } }],
    ['mismatched provider', { actualModel: 'gpt-5.2', usage: { inputTokens: 8, outputTokens: 1 } }],
    ['missing usage', { actualModel: 'jev-1.13.0', usage: null }],
    ['malformed usage', { actualModel: 'jev-1.13.0', usage: { inputTokens: 8 } }],
  ])('registered native primary rejects %s evidence without pricing the request or falling back', async (_label, evidence) => {
    const f = await fixture('hybrid', 'ok', false, true, false, 'forward', undefined, evidence)
    expect(f.executionError).toMatchObject({ message: 'Native accounting unavailable' })
    expect(f.primaryCalls).toBe(1)
    expect(f.calls).toEqual([])
    expect(f.recordUsage).not.toHaveBeenCalled()
    expect(f.rows).toHaveLength(1)
    expect(f.rows[0]).toMatchObject({ invocation_state: 'settled', billing_state: 'unclaimed', billed_cost_usd: null })
  })
  it('native primary transport failure cannot trigger another model attempt', async () => {
    const f = await fixture('hybrid', 'ok', true)
    expect(f.executionError).toMatchObject({ message: 'Native accounting unavailable' })
    expect(f.primaryCalls).toBe(1)
    expect(f.calls).toEqual([])
    expect(f.recordUsage).not.toHaveBeenCalled()
    expect(f.rows).toEqual([expect.objectContaining({ model: null, usage: null, invocation_state: 'settled' })])
  })
  it('native primary explicit zero usage receives one central zero receipt', async () => {
    const f = await fixture('hybrid', 'ok', false, true, false, 'forward', undefined,
      { actualModel: 'jev-1.13.0', usage: { inputTokens: 0, outputTokens: 0 } })
    expect(f.executionError).toBeUndefined()
    expect(f.calls).toEqual([])
    expect(f.recordUsage).toHaveBeenCalledTimes(1)
    expect(f.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ model: 'jev-1.13.0', inputTokens: 0, outputTokens: 0, actualCostUsd: 0 }))
    expect(f.bootReconcile).not.toHaveBeenCalled()
  })
  it('forwards trusted fallback context through progress verification', async () => {
    const f = await fixture('hybrid', 'ok', false, false, true)
    expect(f.recordUsage).toHaveBeenCalledTimes(2)
    expect(f.rows).toHaveLength(2)
    expect(f.rows.find(r => r.lane === 'text')).toMatchObject({ operation: 'verify-progress', stage: 'uncertainty_review', perception_path: 'ax', fallback_reason: 'uncertain', disposition: null })
    expect(f.rows.find(r => r.lane === 'decision')).toMatchObject({ operation: 'verify-progress', stage: 'primary_decision', fallback_reason: 'uncertain', disposition: 'follow_up' })
  })
  it.each([
    ['llm_only', 'ok', false], ['llm_only', 'partial', false], ['llm_only', 'failed', false],
    ['hybrid', 'ok', false], ['hybrid', 'partial', false], ['hybrid', 'failed', false],
      ['shadow', 'ok', false], ['shadow', 'partial', false], ['shadow', 'failed', false], ['llm_only', 'unknown', false],
  ] as const)('%s / LLM %s / primary fails=%s: exactly one bill per known provider attempt', async (mode, outcome, primaryFails) => {
    const f = await fixture(mode, outcome, primaryFails)
    if (outcome === 'unknown' || outcome === 'failed') expect(f.executionError).toMatchObject({ message: 'Native accounting unavailable' })
    const hasPrimary = mode !== 'llm_only'
    const knownLlmUsage = outcome !== 'failed' && outcome !== 'unknown'
    expect(f.calls).toEqual(['gpt-5.2'])
    expect(f.primaryCalls).toBe(hasPrimary ? 1 : 0)
    expect(f.rows).toHaveLength(hasPrimary ? 2 : 1)
    expect(f.recordUsage).toHaveBeenCalledTimes(Number(hasPrimary && !primaryFails) + Number(knownLlmUsage))
    for (const [usage] of f.recordUsage.mock.calls as unknown as [Record<string, unknown>][]) {
      expect(usage).toMatchObject({ userId: id, actorUserId: id, assistantId: id, workspaceId: id, sessionId: id, source: 'included', providerKeySource: 'platform' })
    }
    const text = f.rows.find(r => r.lane === 'text')!
    expect(text).toMatchObject({ operation: 'next-action', perception_path: 'ax', disposition: null,
      stage: mode === 'llm_only' ? 'llm_only' : mode === 'shadow' ? 'shadow_legacy' : primaryFails ? 'operational_failover' : 'uncertainty_review',
      fallback_reason: mode !== 'hybrid' ? 'none' : primaryFails ? null : 'uncertain', session_id: id, model: knownLlmUsage ? 'gpt-5.2' : null, provider_kind: 'openai', outcome: outcome === 'ok' ? 'ok' : 'failed',
      usage: knownLlmUsage ? { inputTokens: 20, outputTokens: 5 } : null, incurred_cost_usd: knownLlmUsage ? hydraCost : null, billed_cost_usd: knownLlmUsage ? hydraBilled : null })
    const bills = f.recordUsage.mock.calls as unknown as [Record<string, unknown>][]
    expect(bills.filter(([b]) => b.model === 'gpt-5.2')).toHaveLength(Number(knownLlmUsage))
    expect(bills.filter(([b]) => b.model === 'jev-1.13.0')).toHaveLength(Number(hasPrimary && !primaryFails))
    if (knownLlmUsage) expect(bills.find(([b]) => b.model === 'gpt-5.2')![0].actualCostUsd).toBe(hydraBilled)
    if (hasPrimary) {
      expect(f.rows.find(r => r.lane === 'decision')).toMatchObject({ model: 'typesafe-jev-1.13', provider_kind: 'typesafe', provider_key_source: 'platform', outcome: primaryFails ? 'failed' : 'ok', usage: primaryFails ? null : { inputTokens: 8, outputTokens: 1 } })
      const primaryAudit = f.rows.find(r => r.lane === 'decision')!
      expect(primaryAudit).toMatchObject({ operation: 'next-action', stage: 'primary_decision', perception_path: 'ax',
        disposition: primaryFails ? null : 'follow_up', fallback_reason: primaryFails ? null : 'uncertain' })
      if (primaryFails) expect(primaryAudit).toMatchObject({ incurred_cost_usd: null, billed_cost_usd: null })
      else expect(primaryAudit.estimated_billed_cost_usd).toBe(bills.find(([b]) => b.model === 'jev-1.13.0')![0].actualCostUsd)
      expect(primaryAudit).toMatchObject({ billing_state: primaryFails ? 'unclaimed' : 'recorded',
        billed_cost_usd: primaryFails ? null : primaryAudit.estimated_billed_cost_usd })
      expect(f.traces.find(t => t.stage === 'primary_decision')).toMatchObject({ workspaceId: id, trustedBillingContext: { userId: id, actorUserId: id, assistantId: id, sessionId: id, taskId: id, nativeSessionId: id } })
    }
    expect(JSON.stringify(f.rows)).not.toMatch(/private goal|private AX|private output|raw secret|raw Jev|forged/)
    expect(JSON.stringify(f.recordUsage.mock.calls)).not.toContain('not-used')
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

async function lateFixture(lane: 'text' | 'vision' | 'fallback' | 'primary', ending: 'success' | 'failure' | 'partial' | 'usage_then_hang' = 'success', streamModel?: string | null, trace?: NativeRunTrace, supported: boolean | 'declined' = true) {
  const gate = deferred<void>(), started = deferred<void>(), abort = new AbortController()
  const recordUsage = vi.fn<UsageStore['recordUsage']>(async () => {})
  const usageStore = { recordUsage: vi.fn(async () => { throw new Error('Native unkeyed dispatch forbidden') }) } as unknown as UsageStore
  const capability = attachAccounting(usageStore, recordUsage, supported !== false)
  const records: import('../computer-use/service.js').NativeAttemptRecord[] = []
  let providerCalls = 0, primaryCalls = 0
  const provider: LLMProvider = { name: 'openai', models: ['gpt-5.2'], createSession: vi.fn(), stream: async function* (request) {
    providerCalls++
    if (lane !== 'primary') { started.resolve(); await gate.promise }
    if (streamModel !== null) yield { type: 'message_start', model: streamModel ?? 'gpt-5.2' }
    if (lane !== 'primary' && ending === 'failure') throw new Error('late raw provider credential')
    yield { type: 'text_delta', text: lane === 'text' ? '{"steps":[]}' : lane === 'vision' ? 'null' : '{"id":"abstain"}' }
    yield { type: 'message_end', nativeMetadata: { actualModel: streamModel === null ? null : streamModel ?? 'gpt-5.2', usage: { inputTokens: 30, outputTokens: 4, calculatedCostUsd: 0.3, userId: 'forged-provider-user', model: 'forged-provider-model', raw: 'private-usage-content' } }, stopReason: ending === 'partial' ? 'max_tokens' : 'end_turn', usage: { inputTokens: 30, outputTokens: 4, calculatedCostUsd: 0.3, userId: 'forged-provider-user', model: 'forged-provider-model', raw: 'private-usage-content' } }
    // Duplicate provider usage notification is still ONE physical invocation.
    yield { type: 'message_end', nativeMetadata: { actualModel: streamModel === null ? null : streamModel ?? 'gpt-5.2', usage: { inputTokens: 30, outputTokens: 4, calculatedCostUsd: 0.3, userId: 'forged-provider-user', model: 'forged-provider-model', raw: 'private-usage-content' } }, stopReason: ending === 'partial' ? 'max_tokens' : 'end_turn', usage: { inputTokens: 30, outputTokens: 4, calculatedCostUsd: 0.3, userId: 'forged-provider-user', model: 'forged-provider-model', raw: 'private-usage-content' } }
    if (ending === 'partial') throw new Error('late partial raw output')
    if (ending === 'usage_then_hang') await new Promise(() => {})
  } }
  const primary: DecisionProvider = { id: 'typesafe', supportsNativeStrict: true, capabilities: { primitives: ['choice'], batch: true, maxOptions: 255, maxQuestions: 64, maxRubricLevels: 10, maxInputTokens: 64000, uncertainty: ['native_distribution'] },
    evaluate: async request => {
      primaryCalls++
      if (lane === 'primary') { started.resolve(); await gate.promise }
      if (lane === 'primary' && ending === 'failure') throw new Error('late Jev raw credential')
      expect(request.nativeStrict).toBe(true)
      return { nativeMetadata: { actualModel: 'jev-1.13.0', usage: { inputTokens: 8, outputTokens: 1 } }, providerId: 'typesafe', model: request.model, answers: [{ kind: 'choice', questionId: 'next', value: 'abstain', evidence: { source: 'native_distribution', probabilities: { abstain: 1 } } }], usage: { inputTokens: 8, outputTokens: 1 } }
    },
  }
  const central = createDecisionAttemptUsageRecorder(usageStore, { nativeAcknowledgements: true })
  const decisionRuntime = createDecisionRuntime({ nativeAccounting: supported ? capability : undefined, llmProvider: provider, defaultLlmModel: 'gpt-5.2',
    adapters: new DecisionAdapterRegistry().register('typesafe', () => primary), onAttempt: central,
    resolveRoute: () => ({ mode: 'hybrid', primaryModelId: 'typesafe-jev-1.13', allowSyntheticProfile: true, allowOperationalFailover: true,
      profile: { id: 'late', version: '1', mode: 'hybrid', operationId: NATIVE_NEXT_ACTION.id, operationVersion: NATIVE_NEXT_ACTION.version, stateVersion: NATIVE_NEXT_ACTION.stateVersion, questionVersion: NATIVE_NEXT_ACTION.questionVersion, modelCatalogId: 'typesafe-jev-1.13', modelWireId: 'jev-1.13.0', evaluationSegment: 'global', status: 'approved', evidence: 'synthetic', totalTimeoutMs: 2000, primaryTimeoutMs: 300, maxAttempts: 2 },
    }),
  })
  const target = { appId: 'com.usebrian.NativeComputerFixture', processId: 1, processInstanceId: 'p', windowId: 'w', windowInstanceId: 'wi' }
  const grant = { identity: { userId: id, workspaceId: id, conversationId: id, sessionId: id, taskId: id, deploymentId: 'deployment' }, epoch: 0, grantId: 'grant', allowCapture: true, targets: [target], goal: 'private late goal' } as NativeGrant
  const context = { userId: id, workspaceActorUserId: id, workspaceId: id, sessionId: id, assistantId: id } as ToolContext
  const input = { goal: grant.goal, signal: abort.signal, deadlineAt: Date.now() + 10000, candidates: [], observation: { target, foreground: true, nodes: [], id: 'observation', frame: { width: 1, height: 1, mimeType: 'image/png', data: 'private pixels' } } } as unknown as NativeModelInput
  const native = (await createNativeComputerBootRuntimeFactory({ provider, configuredProviders: new Set(['gemini']), getWorkspacePlan: async () => 'enterprise', resolveWorkspaceCustomLlm: async () => null, decisionRuntime, usageStore,
    resolveGrounder: async () => ({ provider, model: 'gpt-5.2', nativeGrounding: true, providerKeySource: 'user' }),
    recordAttempt: async r => { records.push(r); return audit(r) },
    nativeAccounting: supported ? { ...capability, admit: supported === 'declined' ? async () => ({ status: 'unsupported' }) : capability.admit, prepare: async settlement => { records.push({ sessionId: id,grantId: 'grant',scope: { userId: id,workspaceId: id,assistantId: id,conversationId: id,taskId: id },attempt: settlement.attempt }); return capability.prepare(settlement) } } : undefined,
  })(context, grant, trace))!
  const span = trace?.startSpan(lane === 'text' ? 'generation' : lane === 'vision' ? 'vision-grounding' : 'selection', 0)
  input.trace = span?.correlation
  const operation = native ? createNativeDecisionOperation(input, native.llm, false) : undefined
  const decide = operation ? vi.spyOn(operation, 'decide') : vi.fn()
  const start = (timeout = false) => {
    if (!native) return Promise.reject(new Error('Native runtime unavailable'))
    if (timeout && (lane === 'text' || lane === 'vision')) input.deadlineAt = Date.now() + 40
    if (lane === 'text') return native.llm.plan!(input)
    if (lane === 'vision') return native.llm.vision!.propose(input)
    return native.decisionRuntime!.run({ workspaceId: id, request: { signal: abort.signal, runId: span?.correlation.spanId ?? 'late-run', operation: NATIVE_NEXT_ACTION, state: {}, questions: [{ kind: 'choice', id: 'next', prompt: 'private question', options: [{ value: 'abstain' }, { value: 'ask_user' }] }] }, operation: operation! })
  }
  const rows = () => db.query<Record<string, unknown>>('SELECT * FROM native_computer_inference_attempts ORDER BY id').then(r => r.rows)
  return { start, started: started.promise, release: () => gate.resolve(), abort, rows, recordUsage, records, decide, span, capability, unkeyedRecordUsage: usageStore.recordUsage, providerCalls: () => providerCalls, primaryCalls: () => primaryCalls, runtimeAvailable: Boolean(native) }
}

describe('native provider invocation settlement after logical return', () => {
  it.each(['text', 'vision', 'fallback'] as const)('%s: Stop stays prompt, late usage reconciles the same attempt once', async lane => {
    const f = await lateFixture(lane)
    const logical = f.start().then(() => 'returned', () => 'cancelled')
    await f.started
    const before = Date.now(); f.abort.abort()
    expect(await logical).toBe('cancelled')
    expect(Date.now() - before).toBeLessThan(500)
    await vi.waitFor(async () => expect((await f.rows()).some(r => r.invocation_state === 'pending' && r.interrupted)).toBe(true))
    const pending = (await f.rows()).find(r => r.invocation_state === 'pending')!
    expect(pending).toMatchObject({ interrupted: true, usage: null, incurred_cost_usd: null, billed_cost_usd: null, billing_state: 'unclaimed' })
    const priorBills = lane === 'fallback' ? 1 : 0
    expect(f.recordUsage).toHaveBeenCalledTimes(priorBills)
    f.release()
    await vi.waitFor(async () => { expect((await f.rows()).every(r => r.invocation_state === 'settled')).toBe(true); expect(f.recordUsage).toHaveBeenCalledTimes(priorBills + 1); expect((await f.rows()).find(r => r.attempt_id === pending.attempt_id)!.billing_state).toBe('recorded') })
    const rows = await f.rows(), reconciled = rows.find(r => r.attempt_id === pending.attempt_id)!
    expect(rows).toHaveLength(lane === 'fallback' ? 2 : 1)
    expect(reconciled).toMatchObject({ invocation_state: 'settled', interrupted: true, outcome: 'failed', usage: { inputTokens: 30, outputTokens: 4 }, incurred_cost_usd: textCost, billed_cost_usd: lane === 'vision' ? 0 : textBilled, billing_state: 'recorded' })
    const final = f.records.find(r => r.attempt.attemptId === pending.attempt_id && r.attempt.invocationState === 'settled')!
    expect(await service.recordAttempt(final)).toBe(false) // duplicate callback cannot claim another charge
    expect(await logical).toBe('cancelled') // never return a late plan/action
    expect(JSON.stringify(rows)).not.toMatch(/private late|private pixels|private question|raw|credential|forged-provider|private-usage-content/)
    expect(JSON.stringify(f.recordUsage.mock.calls)).not.toMatch(/forged-provider|private-usage-content/)
    for (const [usage] of f.recordUsage.mock.calls) expect(usage).toMatchObject({ userId: id, actorUserId: id, assistantId: id, workspaceId: id, sessionId: id })
  })
  it.each(['success', 'failure', 'partial'] as const)('text timeout followed by late %s retains honest usage', async ending => {
    const f = await lateFixture('text', ending)
    await expect(f.start(true)).rejects.toThrow('cancelled')
    const pending = (await f.rows())[0]!
    expect(pending.invocation_state).toBe('pending')
    f.release()
    await vi.waitFor(async () => expect((await f.rows())[0]!.invocation_state).toBe('settled'))
    expect((await f.rows())[0]).toMatchObject({ attempt_id: pending.attempt_id, interrupted: true, outcome: 'failed', usage: ending === 'failure' ? null : { inputTokens: 30, outputTokens: 4 } })
    expect(f.recordUsage).toHaveBeenCalledTimes(ending === 'failure' ? 0 : 1)
  })
  it('a never-settling provider remains explicitly pending/unknown after timeout', async () => {
    const f = await lateFixture('text')
    await expect(f.start(true)).rejects.toThrow('cancelled')
    await vi.waitFor(async () => expect(await f.rows()).toEqual([expect.objectContaining({ invocation_state: 'pending', interrupted: true, usage: null, billed_cost_usd: null })]))
    expect(f.recordUsage).not.toHaveBeenCalled()
    // Intentionally never release: task return must not imply drained invocations.
  })
  it('known late usage is retained even if a broken stream never closes afterward', async () => {
    const f = await lateFixture('text', 'usage_then_hang', 'gpt-5.2')
    await expect(f.start(true)).rejects.toThrow('cancelled')
    const pending = (await f.rows())[0]!
    f.release()
    await vi.waitFor(async () => expect((await f.rows())[0]).toMatchObject({ attempt_id: pending.attempt_id,
      invocation_state: 'pending', interrupted: true, model: 'gpt-5.2', requested_model: pending.requested_model, usage: { inputTokens: 30, outputTokens: 4 }, incurred_cost_usd: textCost,
      estimated_billed_cost_usd: textCost, billed_cost_usd: null, billing_state: 'unclaimed' }))
    // No speculative "final" usage/charge while the provider is still running.
    expect(f.recordUsage).not.toHaveBeenCalled()
  })
  it('Hydra deadline can return while its fallback stream still owes accounting', async () => {
    const f = await lateFixture('fallback')
    expect(await f.start()).toMatchObject({ path: 'safe_default' })
    await vi.waitFor(async () => expect((await f.rows()).find(r => r.lane === 'text')!.interrupted).toBe(true))
    const pending = (await f.rows()).find(r => r.lane === 'text')!
    expect(pending).toMatchObject({ invocation_state: 'pending', interrupted: true, usage: null })
    f.release()
    await vi.waitFor(async () => { expect((await f.rows()).find(r => r.lane === 'text')!.invocation_state).toBe('settled'); expect(f.recordUsage).toHaveBeenCalledTimes(2) })
    expect((await f.rows()).find(r => r.lane === 'text')!.attempt_id).toBe(pending.attempt_id)
  })
  it('Jev Stop has durable pending attribution then settles without running a fallback', async () => {
    const f = await lateFixture('primary')
    const logical = f.start().then(() => 'returned', () => 'cancelled')
    await f.started; f.abort.abort(); expect(await logical).toBe('cancelled')
    await vi.waitFor(async () => expect((await f.rows())[0]!.interrupted).toBe(true))
    const pending = (await f.rows())[0]!
    expect(pending).toMatchObject({ lane: 'decision', invocation_state: 'pending', usage: null, interrupted: true })
    expect(f.recordUsage).not.toHaveBeenCalled()
    f.release()
    await vi.waitFor(async () => { expect((await f.rows())[0]!.invocation_state).toBe('settled'); expect(f.recordUsage).toHaveBeenCalledTimes(1) })
    expect((await f.rows())).toHaveLength(1)
    expect((await f.rows())[0]!.attempt_id).toBe(pending.attempt_id)
    expect(f.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ model: 'jev-1.13.0', userId: id, actorUserId: id, assistantId: id, sessionId: id, workspaceId: id }))
    expect(f.decide).not.toHaveBeenCalled()
  })
  it.each(['success', 'failure'] as const)('primary timeout returns safely then late %s settles accounting without another inference', async ending => {
    const f = await lateFixture('primary', ending)
    // Timeout never authorizes another model invocation.
    const result = await f.start()
    expect(result).toMatchObject({ path: 'safe_default' })
    const pending = (await f.rows()).find(r => r.lane === 'decision')!
    expect(pending).toMatchObject({ invocation_state: 'pending', usage: null, interrupted: true })
    expect(f.decide).not.toHaveBeenCalled()
    f.release()
    await vi.waitFor(async () => {
      const row = (await f.rows()).find(r => r.lane === 'decision')!
      expect(row.invocation_state).toBe('settled')
      expect(row.billing_state).toBe(ending === 'success' ? 'recorded' : 'unclaimed')
    })
    const rows = await f.rows()
    expect(rows).toHaveLength(1)
    expect(rows.find(r => r.lane === 'decision')).toMatchObject({ attempt_id: pending.attempt_id, interrupted: true, outcome: 'failed',
      billing_state: ending === 'success' ? 'recorded' : 'unclaimed', billed_cost_usd: ending === 'success' ? expect.any(Number) : null,
      usage: ending === 'success' ? { inputTokens: 8, outputTokens: 1 } : null })
    expect(f.recordUsage.mock.calls.filter(([r]) => r.model === 'jev-1.13.0')).toHaveLength(ending === 'success' ? 1 : 0)
    expect(f.decide).not.toHaveBeenCalled()
    expect(f.recordUsage.mock.calls.filter(([r]) => r.model === 'gpt-5.2')).toHaveLength(0)
  })
})

async function billingFixture() {
  let meter!: nativeModels.NativeModelRuntimeOptions['meter']
  const original = nativeModels.createNativeComputerModelRuntimeFactory
  const spy = vi.spyOn(nativeModels, 'createNativeComputerModelRuntimeFactory').mockImplementation(options => {
    meter = options.meter
    return original(options)
  })
  try {
    const f = await lateFixture('text')
    const event: Parameters<typeof meter>[0] = { attemptId: randomUUID(), invocationState: 'settled', interrupted: false,
      context: {} as ToolContext, lane: 'text', requestedModel: 'requested-alias', model: 'gpt-5.2', providerId: 'openai',
      operation: 'plan', stage: 'direct', perceptionPath: 'ax', fallbackReason: 'none', disposition: null,
      usage: { inputTokens: 30, outputTokens: 4, calculatedCostUsd: 0.3 }, outcome: 'ok', durationMs: 20 }
    await meter({ ...event, invocationState: 'pending', outcome: 'pending', model: null, usage: undefined })
    return { ...f, meter, event }
  } finally { spy.mockRestore() }
}

describe('native billing acknowledgements, not estimated charges', () => {
  it('concurrent/duplicate callbacks claim once; confirmation waits for UsageStore return', async () => {
    const f = await billingFixture(), acknowledged = deferred<void>()
    f.recordUsage.mockImplementation(async () => acknowledged.promise)
    const writes = Promise.all([f.meter(f.event), f.meter(f.event)])
    await vi.waitFor(() => expect(f.recordUsage).toHaveBeenCalledTimes(1))
    expect(await f.rows()).toEqual([expect.objectContaining({ invocation_state: 'settled', billing_state: 'unclaimed',
      billed_cost_usd: null, estimated_billed_cost_usd: textCost, usage: { inputTokens: 30, outputTokens: 4 } })])
    acknowledged.resolve(); await writes
    expect((await f.rows())[0]).toMatchObject({ billing_state: 'recorded', billed_cost_usd: textBilled })
    await f.meter(f.event)
    expect(f.recordUsage).toHaveBeenCalledTimes(1)
    // A stale pending callback cannot undo confirmed billing or settled inference.
    await f.meter({ ...f.event, invocationState: 'pending', usage: undefined })
    expect((await f.rows())[0]).toMatchObject({ invocation_state: 'settled', billing_state: 'recorded', billed_cost_usd: textBilled })
  })
  it('failed SQL insertion remains prepared and exact-key recovery does not re-invoke models', async () => {
    const f = await billingFixture()
    f.recordUsage.mockRejectedValueOnce(new Error('private SQL failure'))
    await expect(f.meter(f.event)).rejects.toThrow('Native accounting unavailable')
    expect((await f.rows())[0]).toMatchObject({ billing_state: 'unclaimed', billed_cost_usd: null, usage: { inputTokens: 30,outputTokens: 4 } })
    expect((await db.query('SELECT * FROM oss_usage_tracking')).rows).toHaveLength(0)
    expect(await f.capability.reconcile({ nativeSessionId: id,invocationId: f.event.attemptId })).toMatchObject({ status: 'recorded' })
    expect((await db.query('SELECT * FROM oss_usage_tracking')).rows).toHaveLength(1)
    expect(f.decide).not.toHaveBeenCalled()
  })
  it('legacy void acknowledgements cannot promote an ambiguous row', async () => {
    const f = await billingFixture()
    await db.query("UPDATE native_computer_inference_attempts SET billing_state='unknown' WHERE attempt_id=$1", [f.event.attemptId])
    await service.recordAttempt({ sessionId: id,grantId: 'grant',scope: { userId: id,workspaceId: id,assistantId: id,conversationId: id,taskId: id },
      attempt: { ...f.event, providerKind: 'openai',providerKeySource: 'platform',usage: { inputTokens: 30,outputTokens: 4 },incurredCostUsd: textCost,estimatedBilledCostUsd: textCost },billingAcknowledgement: 'recorded' })
    expect((await f.rows())[0]).toMatchObject({ billing_state: 'unknown',billed_cost_usd: null })
    expect(f.recordUsage).not.toHaveBeenCalled()
  })
  it('primary billing ownership stays central and its explicit acknowledgement confirms the native audit', async () => {
    const f = await fixture('hybrid', 'ok', false, true)
    expect(f.recordUsage).toHaveBeenCalledTimes(1)
    expect((await db.query(`SELECT billing_state,billed_cost_usd,estimated_billed_cost_usd FROM native_computer_inference_attempts`)).rows)
      .toEqual([expect.objectContaining({ billing_state: 'recorded', billed_cost_usd: expect.any(Number), estimated_billed_cost_usd: expect.any(Number) })])
  })
})


describe('trusted central primary billing receipts', () => {
  it.each(['missing', 'lost', 'failure', 'mismatch'] as const)('%s observer acknowledgement cannot manufacture or undo a committed native receipt', async mode => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const f = await fixture('hybrid', 'ok', false, true, false, mode)
      expect(f.result).toBeUndefined()
      expect(f.executionError).toMatchObject({ message: 'Native accounting unavailable' })
      expect(f.primaryCalls).toBe(1)
      expect(f.calls).toEqual([]) // Accounting failure must not authorize fallback.
      expect(f.bootReconcile).not.toHaveBeenCalled()
      expect(f.recordUsage).toHaveBeenCalledTimes(mode === 'missing' ? 0 : 1)
      expect(f.rows).toHaveLength(1)
      expect(f.rows[0]).toMatchObject({ invocation_state: 'settled', lane: 'decision', billing_state: mode === 'missing' || mode === 'failure' ? 'unclaimed' : 'recorded',
        billed_cost_usd: mode === 'missing' || mode === 'failure' ? null : expect.any(Number), estimated_billed_cost_usd: expect.any(Number), usage: { inputTokens: 8, outputTokens: 1 } })
      expect(JSON.stringify(f.rows)).not.toContain('central store unavailable')
    } finally { log.mockRestore() }
  })
  it('concurrent duplicate settlement callbacks receive one bound receipt from one central write', async () => {
    const f = await fixture('hybrid', 'ok', false, true, false, 'duplicate')
    expect(f.recordUsage).toHaveBeenCalledTimes(1)
    expect(f.rows).toHaveLength(1)
    expect(f.rows[0]).toMatchObject({ invocation_state: 'settled', lane: 'decision', billing_state: 'recorded',
      billed_cost_usd: f.recordUsage.mock.calls[0]![0]!.actualCostUsd })
  })
})

it('receipt observer failure cannot undo an atomic central insertion, invoke NativeBoot primary reconcile, or trigger fallback', async () => {
  const f = await fixture('hybrid', 'ok', false, true, false, 'audit_failure')
  expect(f.result.path).toBe('primary_complete')
  expect(f.calls).toEqual([])
  expect(f.primaryCalls).toBe(1)
  expect(f.receiptObservations).toBe(1)
  expect(f.bootReconcile).not.toHaveBeenCalled()
  expect(f.recordUsage).toHaveBeenCalledTimes(1)
  expect(f.rows).toEqual([expect.objectContaining({ billing_state: 'recorded', billed_cost_usd: expect.any(Number), invocation_state: 'settled' })])
})


describe('native requested versus provider-resolved model attribution', () => {
  it('resolves the same pending row, retains its requested alias, and bills the actual model once', async () => {
    const f = await lateFixture('text', 'success', 'gpt-5.2')
    const result = f.start(); await f.started
    const pending = (await f.rows())[0]!
    expect(pending).toMatchObject({ model: null, requested_model: expect.any(String), invocation_state: 'pending' })
    expect(pending.requested_model).not.toBe('gpt-5.2')
    f.release(); await result
    expect(await f.rows()).toEqual([expect.objectContaining({ attempt_id: pending.attempt_id, requested_model: pending.requested_model,
      model: 'gpt-5.2', provider_kind: 'openai', invocation_state: 'settled', billing_state: 'recorded' })])
    expect(f.recordUsage).toHaveBeenCalledTimes(1)
    expect(f.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-5.2', actualCostUsd: textBilled }))
  })
  it('keeps actual identity null and billing unconfirmed when message_start is absent', async () => {
    const f = await lateFixture('text', 'success', null)
    const result = f.start(); await f.started; f.release(); await expect(result).rejects.toThrow('Native accounting unavailable')
    expect(await f.rows()).toEqual([expect.objectContaining({ model: null, requested_model: expect.any(String),
      invocation_state: 'settled', usage: { inputTokens: 30, outputTokens: 4 }, incurred_cost_usd: null,
      billing_state: 'unclaimed', billed_cost_usd: null })])
    const settled = f.records.find(r => r.attempt.invocationState === 'settled')!
    await expect(audit({ ...settled, attempt: { ...settled.attempt, model: 'invented-after-settlement' } })).rejects.toThrow('scope denied')
    expect((await f.rows())[0]!.model).toBeNull()
    expect(f.recordUsage).not.toHaveBeenCalled()
  })
  it('late model and usage metadata after Stop reconcile without resuming the cancelled call', async () => {
    const f = await lateFixture('text', 'success', 'gpt-5.2')
    const result = f.start().then(() => 'returned', () => 'cancelled')
    await f.started; f.abort.abort(); expect(await result).toBe('cancelled')
    const pending = (await f.rows())[0]!
    expect(pending.model).toBeNull()
    f.release()
    await vi.waitFor(async () => expect((await f.rows())[0]!.billing_state).toBe('recorded'))
    expect(await f.rows()).toEqual([expect.objectContaining({ attempt_id: pending.attempt_id, requested_model: pending.requested_model,
      model: 'gpt-5.2', invocation_state: 'settled', interrupted: true, outcome: 'failed', usage: { inputTokens: 30, outputTokens: 4 } })])
    expect(f.recordUsage).toHaveBeenCalledTimes(1)
    expect(f.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-5.2' }))
    expect(await result).toBe('cancelled')
    expect(f.decide).not.toHaveBeenCalled()
  })
  it('SQL freezes requested identity at admission and actual identity at settlement; conflicts never charge', async () => {
    const f = await billingFixture()
    const pending = { ...f.event, invocationState: 'pending' as const, model: null, usage: undefined }
    await f.meter(pending)
    await expect(f.meter({ ...pending, requestedModel: 'forged-alias' })).rejects.toThrow('Native accounting admission unavailable')
    await expect(f.meter({ ...f.event, invocationState: 'pending' })).rejects.toThrow('Native accounting unavailable')
    expect((await f.rows())[0]).toMatchObject({ requested_model: f.event.requestedModel, model: null, billing_state: 'unclaimed' })
    // Known settlement may still account incurred work, but cannot clear the
    // run's denial or authorize more inference/effects.
    await expect(f.meter(f.event)).rejects.toThrow('Native accounting unavailable')
    for (const conflict of [{ ...f.event, model: 'another-model' }, { ...f.event, requestedModel: 'another-alias' }, { ...f.event, providerId: 'anthropic' }]) {
      await expect(f.meter(conflict)).rejects.toThrow('Native accounting unavailable')
    }
    await expect(f.meter(f.event)).rejects.toThrow('Native accounting unavailable')
    await expect(f.meter(pending)).rejects.toThrow('Native accounting unavailable') // poisoned evidence cannot be re-admitted
    expect(f.recordUsage).toHaveBeenCalledTimes(1)
    expect(await f.rows()).toEqual([expect.objectContaining({ requested_model: f.event.requestedModel, model: f.event.model,
      provider_kind: 'openai', invocation_state: 'settled', billing_state: 'recorded', billed_cost_usd: textBilled })])
  })
})


describe('shared trace from actual lifecycle accounting', () => {
  it.each(['text', 'vision', 'primary', 'fallback'] as const)('%s correlates real attempt IDs and late source metadata, never resumes work or bills twice', async lane => {
    const trace = new NativeRunTrace()
    const f = await lateFixture(lane, 'success', undefined, trace)
    const logical = f.start().then(() => 'returned', () => 'cancelled')
    await f.started; f.abort.abort(); expect(await logical).toBe('cancelled')
    await vi.waitFor(() => expect(trace.snapshot().invocations.some(v => v.inference.interrupted)).toBe(true))
    f.span!.interrupt(); trace.terminal('cancelled', 0)
    expect(trace.snapshot()).toMatchObject({ pendingInvocations: 1, logicalTerminal: true, drain: 'not_observed', evidence: 'valid' })
    const pending = trace.snapshot().invocations.find(v => v.inference.invocationState === 'pending')!
    expect(pending.inference).toMatchObject({ usage: null, incurredCostUsd: null, estimatedBilledCostUsd: null })
    f.release()
    await vi.waitFor(() => expect(trace.snapshot().pendingInvocations).toBe(0))
    await vi.waitFor(() => expect(f.recordUsage).toHaveBeenCalledTimes(lane === 'fallback' ? 2 : 1))
    const final = [...trace.snapshot().events].reverse().find(e => e.inference?.attemptId === pending.inference.attemptId)!
    expect(final).toMatchObject({ kind: 'inference-update', late: true, scope: 'adapter-lifecycle', atMs: null, drain: 'not_observed',
      spanId: f.span!.correlation.spanId, inference: { invocationState: 'settled', interrupted: true, outcome: 'failed' } })
    const record = f.records.find(r => r.attempt.attemptId === pending.inference.attemptId && r.attempt.invocationState === 'settled')!
    expect(final.inference).toEqual(record.attempt)
    expect(final.durationMs).toBe(record.attempt.durationMs)
    expect(trace.snapshot().evidence).toBe('valid')
    expect(trace.snapshot().invocations).toHaveLength(lane === 'fallback' ? 2 : 1)
    for (const event of trace.snapshot().events) expect(NativeTraceEventSchema.safeParse(event).success).toBe(true)
    expect(JSON.stringify(trace.snapshot())).not.toMatch(/private|credential|forged|raw/)
    expect(await logical).toBe('cancelled')
    if (lane === 'primary') expect(f.decide).not.toHaveBeenCalled()
  })
  it.each(['hybrid', 'shadow', 'llm_only'] as const)('%s verify-progress uses its real verification phase for primary and adapter accounting', async mode => {
    const trace = new NativeRunTrace()
    const f = await fixture(mode, 'ok', false, false, true, 'forward', trace)
    await vi.waitFor(() => expect(trace.snapshot().pendingInvocations).toBe(0))
    expect(trace.snapshot()).toMatchObject({ evidence: 'valid', drain: 'not_observed' })
    expect(trace.snapshot().invocations).toHaveLength(mode === 'llm_only' ? 1 : 2)
    for (const { inference } of trace.snapshot().invocations) {
      expect(inference.operation).toBe('verify-progress')
      expect(f.rows.some(row => row.attempt_id === inference.attemptId)).toBe(true)
    }
    const updates = trace.snapshot().events.filter(e => e.inference)
    expect(updates.every(e => e.phase === 'verification' && e.scope === 'adapter-lifecycle')).toBe(true)
    expect(f.recordUsage).toHaveBeenCalledTimes(mode === 'llm_only' ? 1 : 2)
  })
  it('a hung stream retains provisional usage and actual identity without claiming invocation drain', async () => {
    const trace = new NativeRunTrace(), f = await lateFixture('text', 'usage_then_hang', 'gpt-5.2', trace)
    await expect(f.start(true)).rejects.toThrow()
    f.span!.interrupt(); trace.terminal('cancelled', 0); f.release()
    await vi.waitFor(() => expect(trace.snapshot().invocations[0]!.inference.usage).not.toBeNull())
    expect(trace.snapshot()).toMatchObject({ logicalTerminal: true, pendingInvocations: 1, drain: 'not_observed', evidence: 'valid' })
    expect(trace.snapshot().invocations[0]!.inference).toMatchObject({ model: 'gpt-5.2', incurredCostUsd: textCost, invocationState: 'pending' })
    expect(f.recordUsage).not.toHaveBeenCalled()
  })
})


describe('runtime native capability boundaries', () => {
  it.each(['text','vision','primary','fallback'] as const)('%s unsupported hosted store denies task runtime before any inference or effects', async lane => {
    const f = await lateFixture(lane, 'success', undefined, undefined, false)
    expect(f.runtimeAvailable).toBe(false)
    await expect(f.start()).rejects.toThrow('Native runtime unavailable')
    expect(f.providerCalls()).toBe(0)
    expect(f.primaryCalls()).toBe(0)
    expect(f.decide).not.toHaveBeenCalled()
    expect(await f.rows()).toEqual([])
    expect(f.unkeyedRecordUsage).not.toHaveBeenCalled()
    expect(f.recordUsage).not.toHaveBeenCalled()
    expect((await f.rows()).every(r => r.billing_state !== 'recorded' && r.billed_cost_usd === null)).toBe(true)
    expect((await db.query('SELECT * FROM native_computer_billing_intents')).rows).toEqual([])
    expect((await db.query('SELECT * FROM oss_usage_tracking')).rows).toEqual([])
  })
  it.each(['text','vision','primary','fallback'] as const)('%s explicit unsupported admission is not successful metering and cannot dispatch', async lane => {
    const f = await lateFixture(lane, 'success', undefined, undefined, 'declined')
    f.release() // Avoid a hung fake provider masking an accidental dispatch.
    await expect(f.start()).rejects.toThrow()
    expect(f.providerCalls()).toBe(0)
    expect(f.primaryCalls()).toBe(0)
    expect(f.unkeyedRecordUsage).not.toHaveBeenCalled()
    expect(f.recordUsage).not.toHaveBeenCalled()
    expect((await f.rows()).every(r => r.usage === null && r.incurred_cost_usd === null && r.billed_cost_usd === null)).toBe(true)
    expect((await db.query('SELECT * FROM native_computer_billing_intents')).rows).toEqual([])
  })
  it('a lost adapter COMMIT response is recoverable by exact key without provider re-invocation', async () => {
    const f = await lateFixture('text')
    const logical = f.start(); await f.started; loseNativeCommitAck = true; f.release(); await expect(logical).rejects.toThrow('Native accounting unavailable')
    const row = (await f.rows())[0]!
    expect(row.billing_state).toBe('recorded') // Transaction committed despite lost transport acknowledgement.
    expect(f.providerCalls()).toBe(1)
    const result = await f.capability.reconcile({ nativeSessionId: id, invocationId: row.attempt_id as string })
    expect(result).toMatchObject({ status: 'recorded', receipt: { amountUsd: textCost.toFixed(10) } })
    expect(f.recordUsage).toHaveBeenCalledTimes(1)
    expect(f.providerCalls()).toBe(1)
    expect(f.unkeyedRecordUsage).not.toHaveBeenCalled()
  })
  it('assistant deletion during inference blocks insertion, never reports a successful no-op as recorded', async () => {
    const f = await lateFixture('text')
    const logical = f.start(); await f.started
    await db.query('DELETE FROM assistants WHERE id=$1', [id])
    try {
      f.release(); await expect(logical).rejects.toThrow('Native accounting unavailable')
      expect((await f.rows())[0]).toMatchObject({ invocation_state: 'settled',usage: { inputTokens: 30,outputTokens: 4 },billing_state: 'unclaimed',billed_cost_usd: null })
      expect((await db.query('SELECT state,blocked_reason FROM native_computer_billing_intents')).rows).toEqual([{ state: 'blocked',blocked_reason: 'attribution_missing' }])
      expect((await db.query('SELECT * FROM oss_usage_tracking')).rows).toEqual([])
      expect(f.unkeyedRecordUsage).not.toHaveBeenCalled()
    } finally {
      await db.query('INSERT INTO assistants(id,workspace_id,owner_user_id) VALUES ($1,$1,$1)', [id])
      await db.query('UPDATE native_computer_sessions SET assistant_id=$1', [id])
    }
  })
})

describe('post-return accounting is a hard effect gate, not semantic uncertainty', () => {
  it('unknown actual model plus calculatedCostUsd stays unpriced despite a known requested model', async () => {
    const f = await lateFixture('text','success','unknown-native-model'), effect = vi.fn()
    const logical = f.start().then(effect)
    await f.started; f.release()
    await expect(logical).rejects.toThrow('Native accounting unavailable')
    expect(effect).not.toHaveBeenCalled()
    const row = (await f.rows())[0]!
    expect(row).toMatchObject({ model: 'unknown-native-model',usage: { inputTokens: 30,outputTokens: 4 },incurred_cost_usd: null,estimated_billed_cost_usd: null,billed_cost_usd: null })
    expect(row.requested_model).not.toBe(row.model)
    expect(f.recordUsage).not.toHaveBeenCalled()
    expect((await db.query('SELECT intent,receipt FROM native_computer_billing_intents')).rows).toEqual([{ intent: null,receipt: null }])
  })
  it.each(['text','vision','fallback','primary'] as const)('%s ledger failure rejects the result, blocks effects and cannot reset the run denial', async lane => {
    const f = await lateFixture(lane), effect = vi.fn()
    const logical = f.start().then(effect)
    await f.started
    f.recordUsage.mockRejectedValueOnce(new Error('synthetic ledger failure'))
    f.release()
    await expect(logical).rejects.toThrow('Native accounting unavailable')
    expect(effect).not.toHaveBeenCalled()
    const calls = f.providerCalls(), primaryCalls = f.primaryCalls()
    await expect(f.start()).rejects.toThrow('Native accounting unavailable')
    expect(f.providerCalls()).toBe(calls)
    expect(f.primaryCalls()).toBe(primaryCalls)
    expect(f.unkeyedRecordUsage).not.toHaveBeenCalled()
    const unresolved = (await f.rows()).find(r => r.billing_state !== 'recorded')!
    expect(unresolved).toMatchObject({ invocation_state: 'settled',billed_cost_usd: null })
    expect(unresolved.usage).not.toBeNull()
    expect(await f.capability.reconcile({ nativeSessionId: id,invocationId: unresolved.attempt_id as string })).toMatchObject({ status: 'recorded' })
    expect(effect).not.toHaveBeenCalled() // Recovery never replays the model/task.
    await expect(f.start()).rejects.toThrow('Native accounting unavailable')
    expect(f.providerCalls()).toBe(calls)
  })
  it.each(['text','vision','fallback'] as const)('%s failed final preparation never releases a provider result or effects', async lane => {
    const f = await lateFixture(lane), effect = vi.fn()
    const logical = f.start().then(effect)
    await f.started; failNativePrepare = true; f.release()
    await expect(logical).rejects.toThrow('Native accounting unavailable')
    expect(effect).not.toHaveBeenCalled()
    const pending = (await f.rows()).find(r => r.invocation_state === 'pending')!
    expect(pending).toMatchObject({ usage: { inputTokens: 30, outputTokens: 4 },billed_cost_usd: null })
    expect(await f.capability.reconcile({ nativeSessionId: id,invocationId: pending.attempt_id as string })).toEqual({ status: 'not_ready' })
    const calls = f.providerCalls()
    await expect(f.start()).rejects.toThrow('Native accounting unavailable')
    expect(f.providerCalls()).toBe(calls)
  })
  it.each([false,true])('primary receipt failure blocks both semantic follow-up and fast=%s completion without a second primary charge', async fast => {
    const f = await fixture('hybrid','ok',false,fast,false,'failure')
    expect(f.executionError).toMatchObject({ name: 'NativeAccountingUnavailableError' })
    expect(f.result).toBeUndefined()
    expect(f.primaryCalls).toBe(1)
    expect(f.calls).toEqual([])
    expect(f.recordUsage).toHaveBeenCalledTimes(1)
    expect(f.bootReconcile).not.toHaveBeenCalled()
  })
})
