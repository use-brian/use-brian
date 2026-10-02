import { nativeAccountingFor } from '../../computer-use/accounting-capability.js'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { createOssNativeAccounting, type NativeAccountingConnection } from '../oss-native-accounting.js'
import { freezeNativePrice, nativeAccountingHash, type NativeBillingAdmission, type NativeBillingSettlement } from '../../computer-use/accounting.js'
import { createOssUsageStore } from '../oss-usage-store.js'
vi.mock('../client.js', () => ({ getPool: vi.fn(), query: vi.fn() }))
import { getPool, query } from '../client.js'

// Production migrations and statements on real PostgreSQL-in-WASM. The checkout
// queue reflects PGlite's single backend; NOT multi-connection PG lock acceptance.
const db = new PGlite()
let tail = Promise.resolve(), checkouts = 0, releases = 0
let fault: { match: string; mode: 'before' | 'after' | 'zero' } | undefined
const statements: { connection: number; sql: string }[] = []
const connect = async (): Promise<NativeAccountingConnection> => {
  const previous = tail
  let unlock!: () => void
  tail = new Promise<void>(resolve => { unlock = resolve })
  await previous
  const connection = ++checkouts
  let active = true
  return {
    async query<R extends Record<string, unknown>>(sql: string, params?: unknown[]) {
      if (!active) throw new Error('query outside checkout')
      statements.push({ connection, sql })
      const fail = fault && sql.includes(fault.match) ? fault : undefined
      if (fail) fault = undefined
      if (fail?.mode === 'before') throw new Error('fixture transport unavailable')
      const result = await db.query<R>(sql, params)
      if (fail?.mode === 'after') throw new Error('fixture response lost')
      return fail?.mode === 'zero' ? { rows: [] } : result
    },
    release() { if (active) { active = false; releases++; unlock() } },
  }
}
const ids = { user: randomUUID(), actor: randomUUID(), workspace: randomUUID(), assistant: randomUUID(), conversation: randomUUID(), task: randomUUID() }
const price = (amount = 0.12345678905) => freezeNativePrice(amount, { basis: 'provider_reported', policyVersion: 'provider-usage-v1', rateSnapshotHash: null })
let admission: NativeBillingAdmission, settlement: NativeBillingSettlement
beforeAll(async () => {
  await db.exec(`CREATE TABLE users(id uuid PRIMARY KEY);
    CREATE TABLE workspaces(id uuid PRIMARY KEY, owner_user_id uuid REFERENCES users(id));
    CREATE TABLE assistants(id uuid PRIMARY KEY, workspace_id uuid REFERENCES workspaces(id), owner_user_id uuid REFERENCES users(id), created_at timestamptz DEFAULT now());
    CREATE TABLE sessions(id uuid PRIMARY KEY); CREATE TABLE tasks(id uuid PRIMARY KEY); CREATE TABLE auth_sessions(id uuid PRIMARY KEY);`)
  for (const migration of ['476_oss_usage_tracking.sql','620_native_computer_sessions.sql','621_native_usage_receipts.sql']) {
    await db.exec(await readFile(new URL(`../../../migrations/${migration}`, import.meta.url), 'utf8'))
  }
}, 30_000)
beforeEach(async () => {
  await db.exec('TRUNCATE native_computer_billing_intents,oss_usage_tracking,native_computer_sessions,users,workspaces,assistants,sessions,tasks,auth_sessions CASCADE')
  await db.query('INSERT INTO users(id) VALUES ($1),($2)', [ids.user, ids.actor])
  await db.query('INSERT INTO workspaces(id,owner_user_id) VALUES ($1,$2)', [ids.workspace,ids.user])
  await db.query('INSERT INTO assistants(id,workspace_id,owner_user_id) VALUES ($1,$2,$3)', [ids.assistant,ids.workspace,ids.user])
  await db.query('INSERT INTO sessions(id) VALUES ($1)', [ids.conversation])
  await db.query('INSERT INTO tasks(id) VALUES ($1)', [ids.task])
  admission = { version: 1, backend: 'oss-native-v1', key: { nativeSessionId: randomUUID(), invocationId: randomUUID() },
    scope: { userId: ids.user, actorUserId: ids.actor, workspaceId: ids.workspace, assistantId: ids.assistant, conversationId: ids.conversation,
      taskId: ids.task, deploymentId: 'deployment', grantId: 'grant', epoch: 3 }, owner: 'adapter', requestedModel: 'requested-alias',
    lane: 'text', stage: 'direct', operation: 'plan', perceptionPath: 'ax', providerKeySource: 'platform' }
  settlement = { key: admission.key, ledgerModel: 'actual-wire-model', modelTier: 'standard', price: price(),
    attempt: { attemptId: admission.key.invocationId, invocationState: 'settled', interrupted: false, requestedModel: admission.requestedModel,
      model: 'actual-wire-model', providerKind: 'openai', lane: 'text', outcome: 'ok', operation: 'plan', stage: 'direct', perceptionPath: 'ax',
      fallbackReason: 'none', disposition: null, durationMs: 101, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 4 },
      incurredCostUsd: 0.12345678905, estimatedBilledCostUsd: 0.12345678905, providerKeySource: 'platform' } }
  await db.query(`INSERT INTO native_computer_sessions(id,user_id,workspace_id,assistant_id,conversation_id,task_id,device_id,deployment_id,challenge,epoch,state,expires_at,grant_id)
    VALUES ($1,$2,$3,$4,$5,$6,'device','deployment','challenge',3,'active',now()+interval '1 hour','grant')`,
  [admission.key.nativeSessionId,ids.user,ids.workspace,ids.assistant,ids.conversation,ids.task])
  fault = undefined; statements.length = 0; checkouts = 0; releases = 0
  vi.mocked(getPool).mockReturnValue({ connect, query: () => { throw new Error('pool query forbidden in transaction') } } as never)
  vi.mocked(query).mockImplementation(((sql: string, params: unknown[]) => db.query(sql, params)) as typeof query)
})
afterAll(async () => { await db.close() })
async function initialAudit() {
  const a = admission
  await db.query(`INSERT INTO native_computer_inference_attempts(session_id,attempt_id,invocation_state,interrupted,requested_model,model,provider_kind,lane,outcome,
    operation,stage,perception_path,fallback_reason,duration_ms,provider_key_source)
    VALUES ($1,$2,'pending',false,$3,NULL,'other',$4,'pending',$5,$6,$7,'none',0,$8)`,
  [a.key.nativeSessionId,a.key.invocationId,a.requestedModel,a.lane,a.operation,a.stage,a.perceptionPath,a.providerKeySource])
}
async function admitted() {
  await initialAudit()
  const cap = createOssNativeAccounting()
  expect(await cap.admit(admission)).toEqual({ status: 'admitted' })
  return cap
}
async function prepared() {
  const cap = await admitted()
  expect(await cap.prepare(settlement)).toMatchObject({ status: 'prepared' })
  return cap
}
const ledger = () => db.query<Record<string, unknown>>('SELECT * FROM oss_usage_tracking').then(r => r.rows)
const audit = () => db.query<Record<string, unknown>>('SELECT * FROM native_computer_inference_attempts').then(r => r.rows[0]!)
const intents = () => db.query<Record<string, unknown>>('SELECT * FROM native_computer_billing_intents').then(r => r.rows)

describe('OSS native exact-key transactions', () => {
  it('durably prepares the final audit and frozen intent before any insertion, then atomically acknowledges the actual row/NUMERIC amount', async () => {
    const cap = await prepared()
    expect(await ledger()).toEqual([])
    expect(await audit()).toMatchObject({ invocation_state: 'settled', billing_state: 'unclaimed', model: 'actual-wire-model', requested_model: 'requested-alias' })
    expect((await intents())[0]).toMatchObject({ state: 'prepared', receipt: null })
    const result = await cap.reconcile(admission.key)
    expect(result.status).toBe('recorded')
    if (result.status !== 'recorded') throw new Error('no receipt')
    const rows = await ledger()
    expect(rows).toHaveLength(1)
    expect(result.receipt).toMatchObject({ ledgerId: rows[0]!.id, amountUsd: price().amountUsd, key: admission.key, backend: 'oss-native-v1' })
    expect(rows[0]).toMatchObject({ user_id: ids.user,actor_user_id: ids.actor,workspace_id: ids.workspace,assistant_id: ids.assistant,
      session_id: ids.conversation,model: 'actual-wire-model',actual_cost_usd: price().amountUsd,source: 'included',trigger_key: 'computer_use:native_text' })
    expect(await audit()).toMatchObject({ billing_state: 'recorded', billed_cost_usd: Number(result.receipt.amountUsd) })
    expect(Object.isFrozen(result.receipt)).toBe(true)
    expect(Object.isFrozen(result.receipt.key)).toBe(true)
    expect(checkouts).toBe(releases)
    const inserts = statements.filter(s => s.sql.includes('INSERT INTO oss_usage_tracking'))
    const connection = inserts[0]!.connection
    expect(statements.filter(s => s.connection === connection).map(s => s.sql).join('\n')).toMatch(/BEGIN[\s\S]*INSERT INTO oss_usage_tracking[\s\S]*billing_state='recorded'[\s\S]*COMMIT/)
  })
  it('same-intent duplicate and fresh capability reconciliation return the same receipt and only one insertion', async () => {
    const cap = await prepared(), first = await cap.reconcile(admission.key)
    expect(await cap.prepare({ ...settlement, attempt: { ...settlement.attempt, durationMs: 999, interrupted: true, outcome: 'failed' } })).toMatchObject({ status: 'prepared' })
    const results = await Promise.all(Array.from({ length: 8 }, () => createOssNativeAccounting().reconcile(admission.key)))
    for (const result of results) expect(result).toEqual(first)
    expect(await ledger()).toHaveLength(1)
    expect(statements.filter(s => s.sql.includes('INSERT INTO oss_usage_tracking'))).toHaveLength(1)
  })
  it.each(['usage','actualModel','requestedModel','scope','owner','price','estimate','tier','keySource'] as const)('rejects conflicting %s for a prepared key, retains original immutable intent and prevents automatic charge', async conflict => {
    const cap = await prepared(), original = (await intents())[0]!.intent
    let result
    if (conflict === 'scope' || conflict === 'owner') {
      result = await cap.admit(conflict === 'scope' ? { ...admission, scope: { ...admission.scope, actorUserId: randomUUID() } }
        : { ...admission, owner: 'central_primary',lane: 'decision',stage: 'primary_decision',operation: 'next-action' })
    } else {
      const changed = structuredClone(settlement)
      if (conflict === 'usage') changed.attempt.usage!.inputTokens++
      if (conflict === 'actualModel') { changed.attempt.model = 'different-wire'; changed.ledgerModel = 'different-wire' }
      if (conflict === 'requestedModel') changed.attempt.requestedModel = 'different-request'
      if (conflict === 'price') { changed.price = price(1); changed.attempt.estimatedBilledCostUsd = 1 }
      if (conflict === 'estimate') changed.attempt.estimatedBilledCostUsd = 99
      if (conflict === 'tier') changed.modelTier = 'max'
      if (conflict === 'keySource') changed.attempt.providerKeySource = 'user'
      result = await cap.prepare(changed)
    }
    expect(result).toEqual({ status: 'conflict' })
    expect((await intents())[0]).toMatchObject({ state: 'blocked', conflicted: true, intent: original })
    expect(await cap.reconcile(admission.key)).toEqual({ status: 'conflict' })
    expect(await ledger()).toEqual([])
  })
  it('does not lose a committed receipt when a later duplicate conflicts', async () => {
    const cap = await prepared(), first = await cap.reconcile(admission.key)
    expect(await cap.prepare({ ...settlement, price: price(2) })).toEqual({ status: 'conflict' })
    expect(await cap.reconcile(admission.key)).toEqual(first)
    expect(await ledger()).toHaveLength(1)
  })
  it.each(['after-insert','zero-insert-ack','zero-audit-ack','before-receipt','before-commit'] as const)('rolls back ledger and acknowledgement for %s and can safely retry the same persisted intent', async point => {
    const cap = await prepared()
    fault = point === 'after-insert' ? { match: 'INSERT INTO oss_usage_tracking', mode: 'after' }
      : point === 'zero-insert-ack' ? { match: 'INSERT INTO oss_usage_tracking', mode: 'zero' }
      : point === 'zero-audit-ack' ? { match: "SET billing_state='recorded'", mode: 'zero' }
      : point === 'before-receipt' ? { match: "SET state='recorded',ledger_id", mode: 'before' }
      : { match: 'COMMIT', mode: 'before' }
    expect(await cap.reconcile(admission.key)).toEqual({ status: 'unknown' })
    expect(await ledger()).toEqual([])
    expect(await audit()).toMatchObject({ billing_state: 'unclaimed', billed_cost_usd: null })
    expect((await intents())[0]).toMatchObject({ state: 'prepared', receipt: null })
    expect(await createOssNativeAccounting().reconcile(admission.key)).toMatchObject({ status: 'recorded' })
    expect(await ledger()).toHaveLength(1)
  })
  it.each(['insert','audit'] as const)('real SQL suppressing the %s row cannot produce a receipt or leave an orphan ledger insertion', async suppressed => {
    const cap = await prepared()
    const table = suppressed === 'insert' ? 'oss_usage_tracking' : 'native_computer_inference_attempts'
    const operation = suppressed === 'insert' ? 'INSERT' : 'UPDATE'
    await db.exec(`CREATE FUNCTION fixture_suppress_native_row() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
      CREATE TRIGGER fixture_suppress_native_row BEFORE ${operation} ON ${table} FOR EACH ROW EXECUTE FUNCTION fixture_suppress_native_row();`)
    try {
      expect(await cap.reconcile(admission.key)).toEqual({ status: 'unknown' })
      expect(await ledger()).toEqual([])
      expect(await audit()).toMatchObject({ billing_state: 'unclaimed', billed_cost_usd: null })
      expect((await intents())[0]).toMatchObject({ state: 'prepared',receipt: null })
    } finally {
      await db.exec(`DROP TRIGGER fixture_suppress_native_row ON ${table}; DROP FUNCTION fixture_suppress_native_row();`)
    }
    expect(await createOssNativeAccounting().reconcile(admission.key)).toMatchObject({ status: 'recorded' })
    expect(await ledger()).toHaveLength(1)
  })
  it('lost COMMIT response is unknown, but a fresh reconciler recovers the committed receipt without another insertion', async () => {
    const cap = await prepared()
    fault = { match: 'COMMIT', mode: 'after' }
    expect(await cap.reconcile(admission.key)).toEqual({ status: 'unknown' })
    expect(await ledger()).toHaveLength(1)
    const receipt = (await intents())[0]!.receipt
    expect(await createOssNativeAccounting().reconcile(admission.key)).toEqual({ status: 'recorded', receipt })
    expect(await ledger()).toHaveLength(1)
  })
  it('failed preparation rolls back final audit together with the intent', async () => {
    const cap = await admitted()
    fault = { match: 'SET intent=$3', mode: 'before' }
    expect(await cap.prepare(settlement)).toEqual({ status: 'unknown' })
    expect(await audit()).toMatchObject({ invocation_state: 'pending', usage: null })
    expect((await intents())[0]).toMatchObject({ state: 'admitted', intent: null })
    expect(await cap.reconcile(admission.key)).toEqual({ status: 'not_ready' })
    expect(await cap.prepare(settlement)).toMatchObject({ status: 'prepared' })
  })
  it('strict metadata rejects content and non-finite prices before any storage call', async () => {
    const cap = await admitted(), before = statements.length
    await expect(cap.prepare({ ...settlement, goal: 'private raw context' } as NativeBillingSettlement)).rejects.toThrow('Invalid native accounting metadata')
    await expect(cap.prepare({ ...settlement, attempt: { ...settlement.attempt, usage: { ...settlement.attempt.usage!, raw: 'private AX' } } } as NativeBillingSettlement)).rejects.toThrow('Invalid native accounting metadata')
    expect(() => freezeNativePrice(Infinity, { basis: 'provider_reported',policyVersion: 'v1',rateSnapshotHash: null })).toThrow('Invalid native price')
    expect(statements).toHaveLength(before)
    expect(JSON.stringify(await intents())).not.toMatch(/private raw context|private AX/)
    expect(await ledger()).toEqual([])
  })
  it('SQL independently rejects rewriting admission, sealed intent or receipt', async () => {
    const cap = await prepared()
    await expect(db.exec("UPDATE native_computer_billing_intents SET admission='{}'::jsonb")).rejects.toThrow('immutable')
    await expect(db.exec("UPDATE native_computer_billing_intents SET intent='{}'::jsonb")).rejects.toThrow('immutable')
    await cap.reconcile(admission.key)
    await expect(db.exec('UPDATE native_computer_billing_intents SET stored_amount_usd=2')).rejects.toThrow('immutable')
    await expect(db.exec("UPDATE native_computer_billing_intents SET receipt='{}'::jsonb")).rejects.toThrow('immutable')
  })
})

describe('native attribution, tombstones, unknowns and bounded recovery', () => {
  it.each(['assistant','workspace','payer','actor','moved-assistant','session'] as const)('%s removal/change before insertion cannot silently bill another identity', async deleted => {
    const cap = await prepared()
    if (deleted === 'assistant') await db.query('DELETE FROM assistants WHERE id=$1', [ids.assistant])
    if (deleted === 'workspace') { await db.query('UPDATE assistants SET workspace_id=NULL WHERE id=$1', [ids.assistant]); await db.query('DELETE FROM workspaces WHERE id=$1', [ids.workspace]) }
    if (deleted === 'payer') { await db.query('UPDATE assistants SET owner_user_id=NULL'); await db.query('UPDATE workspaces SET owner_user_id=NULL'); await db.query('DELETE FROM users WHERE id=$1', [ids.user]) }
    if (deleted === 'actor') await db.query('DELETE FROM users WHERE id=$1', [ids.actor])
    if (deleted === 'session') await db.query('DELETE FROM native_computer_sessions WHERE id=$1', [admission.key.nativeSessionId])
    if (deleted === 'moved-assistant') {
      const other = randomUUID(); await db.query('INSERT INTO workspaces(id) VALUES ($1)', [other])
      await db.query('UPDATE assistants SET workspace_id=$1 WHERE id=$2', [other,ids.assistant])
    }
    expect(await cap.reconcile(admission.key)).toEqual({ status: 'blocked' })
    expect(await ledger()).toEqual([])
    expect((await intents())[0]).toMatchObject({ state: 'blocked', receipt: null })
  })
  it.each(['assistant','workspace','payer','session'] as const)('committed receipt survives %s deletion; missing ledger never authorizes re-insertion', async deleted => {
    const cap = await prepared(), first = await cap.reconcile(admission.key)
    if (deleted === 'assistant') await db.query('DELETE FROM assistants WHERE id=$1', [ids.assistant])
    if (deleted === 'workspace') { await db.query('UPDATE assistants SET workspace_id=NULL'); await db.query('DELETE FROM workspaces WHERE id=$1', [ids.workspace]) }
    if (deleted === 'payer') { await db.exec('UPDATE assistants SET owner_user_id=NULL; UPDATE workspaces SET owner_user_id=NULL'); await db.query('DELETE FROM users WHERE id=$1', [ids.user]) }
    if (deleted === 'session') await db.query('DELETE FROM native_computer_sessions WHERE id=$1', [admission.key.nativeSessionId])
    expect(await createOssNativeAccounting().reconcile(admission.key)).toEqual(first)
    expect((await intents())[0]).toMatchObject({ state: 'recorded' })
    expect(await ledger()).toHaveLength(deleted === 'session' ? 1 : 0)
    expect(statements.filter(s => s.sql.includes('INSERT INTO oss_usage_tracking'))).toHaveLength(1)
  })
  it.each(['unclaimed','claimed','unknown','recorded'] as const)('legacy %s rows without admission cannot be replayed or upgraded', async state => {
    await initialAudit()
    await db.query(`UPDATE native_computer_inference_attempts SET invocation_state='settled',model='actual-wire-model',usage='{"inputTokens":100,"outputTokens":20}'::jsonb,
      billing_state=$1,billed_cost_usd=CASE WHEN $1='recorded' THEN 1 ELSE NULL END`, [state])
    const cap = createOssNativeAccounting()
    expect(await cap.admit(admission)).toEqual({ status: 'legacy' })
    expect(await cap.prepare(settlement)).toEqual({ status: 'legacy' })
    expect(await cap.reconcile(admission.key)).toEqual({ status: 'legacy' })
    expect(await cap.reconcileBatch()).toEqual([])
    expect(await ledger()).toEqual([])
  })
  it.each(['model','ledgerModel','usage','price','pending'] as const)('unknown %s cannot become a charge or requested-model fallback', async missing => {
    const cap = await admitted()
    if (missing === 'model') settlement.attempt.model = null
    if (missing === 'ledgerModel') settlement.ledgerModel = null
    if (missing === 'usage') settlement.attempt.usage = null
    if (missing === 'price') settlement.price = null
    if (missing === 'pending') { settlement.attempt.invocationState = 'pending'; settlement.attempt.outcome = 'pending' }
    expect(await cap.prepare(settlement)).toEqual({ status: 'not_ready' })
    expect(await cap.reconcile(admission.key)).toEqual({ status: 'not_ready' })
    expect(await cap.reconcileBatch()).toEqual([])
    expect(await ledger()).toEqual([])
    expect((await intents())[0]).toMatchObject({ intent: null, state: 'admitted' })
    if (missing === 'model') expect((await audit()).model).toBeNull()
  })
  it('BYOK zero is an explicit policy, not fabricated provider-incurred cost', async () => {
    admission.providerKeySource = 'user'; settlement.attempt.providerKeySource = 'user'
    settlement.attempt.incurredCostUsd = null; settlement.attempt.estimatedBilledCostUsd = 0
    settlement.price = freezeNativePrice(0, { basis: 'byok', policyVersion: 'native-byok-v1', rateSnapshotHash: null })
    const cap = await prepared()
    expect(await cap.reconcile(admission.key)).toMatchObject({ status: 'recorded', receipt: { amountUsd: '0.0000000000' } })
    expect(await audit()).toMatchObject({ incurred_cost_usd: null,billed_cost_usd: 0 })
    expect((await ledger())[0]).toMatchObject({ actual_cost_usd: '0.0000000000',provider_key_source: 'user' })
  })
  it('registry pricing snapshot and tier are frozen; reconciliation has no mutable pricing lookup', async () => {
    settlement.price = freezeNativePrice(0.12345678905, { basis: 'registry',policyVersion: 'registry-v1',rateSnapshotHash: nativeAccountingHash({ input: 1,output: 2 }) })
    const cap = await prepared(), original = structuredClone(settlement.price)
    // Mutating the caller's quote after preparation cannot alter stored intent.
    settlement.price = { ...settlement.price, amountUsd: '42.0000000000' }; settlement.modelTier = 'max'
    expect(await cap.reconcile(admission.key)).toMatchObject({ status: 'recorded',receipt: { amountUsd: original.amountUsd } })
    expect((await ledger())[0]).toMatchObject({ model_tier: 'standard',actual_cost_usd: original.amountUsd })
  })
  it('late final metadata after revocation retains original epoch/attribution without renewing authority', async () => {
    const cap = await admitted()
    await db.exec("UPDATE native_computer_sessions SET epoch=epoch+1,revoked_at=now(),state='ended',run_state='finished'")
    settlement.attempt.interrupted = true; settlement.attempt.outcome = 'failed'
    expect(await cap.prepare(settlement)).toMatchObject({ status: 'prepared' })
    expect(await cap.reconcile(admission.key)).toMatchObject({ status: 'recorded' })
    const row = (await db.query('SELECT epoch,state,run_state FROM native_computer_sessions')).rows[0]
    expect(row).toEqual({ epoch: 4,state: 'ended',run_state: 'finished' })
    expect((await intents())[0]).toMatchObject({ admission: { scope: { epoch: 3 } } })
  })
  it('centrally owned Jev uses the same storage contract without creating another owner', async () => {
    admission.owner = 'central_primary'; admission.lane = 'decision'; admission.stage = 'primary_decision'; admission.operation = 'next-action'
    settlement.attempt.lane = 'decision'; settlement.attempt.stage = 'primary_decision'; settlement.attempt.operation = 'next-action'
    settlement.attempt.model = 'typesafe-jev-1.13'; settlement.attempt.providerKind = 'typesafe'; settlement.ledgerModel = 'jev-1.13.0'
    const cap = await prepared()
    expect(await cap.reconcile(admission.key)).toMatchObject({ status: 'recorded' })
    expect((await ledger())[0]).toMatchObject({ model: 'jev-1.13.0',trigger_key: 'computer_use:native_decision' })
  })
  it('vision uses its original reviewed key source and actual model', async () => {
    admission.lane = 'vision'; admission.operation = 'ground'; admission.perceptionPath = 'vision'
    settlement.attempt.lane = 'vision'; settlement.attempt.operation = 'ground'; settlement.attempt.perceptionPath = 'vision'
    const cap = await prepared()
    expect(await cap.reconcile(admission.key)).toMatchObject({ status: 'recorded' })
    expect((await ledger())[0]).toMatchObject({ model: 'actual-wire-model',trigger_key: 'computer_use:native_vision' })
  })
  it('bounded recovery processes at most its explicit number of prepared keys', async () => {
    const cap = await prepared()
    const originalKey = admission.key
    admission = { ...admission, key: { ...originalKey, invocationId: randomUUID() } }
    settlement = { ...settlement, key: admission.key, attempt: { ...settlement.attempt, attemptId: admission.key.invocationId } }
    await initialAudit(); await cap.admit(admission); await cap.prepare(settlement)
    expect(await cap.reconcileBatch({ limit: 1, maxMs: 30000 })).toHaveLength(1)
    expect(await ledger()).toHaveLength(1)
    expect((await intents()).filter(r => r.state === 'prepared')).toHaveLength(1)
    expect(await cap.reconcileBatch({ limit: 1, maxMs: 30000 })).toHaveLength(1)
    expect(await ledger()).toHaveLength(2)
  })
  it('rejects requested aliases as replacement ledger models for adapters', async () => {
    const cap = await admitted()
    settlement.ledgerModel = admission.requestedModel
    expect(await cap.prepare(settlement)).toEqual({ status: 'conflict' })
    expect(await ledger()).toEqual([])
  })
  it('a pending stream with known provisional usage still cannot create a priced intent', async () => {
    const cap = await admitted()
    settlement.attempt.invocationState = 'pending'; settlement.attempt.interrupted = true; settlement.attempt.outcome = 'failed'
    expect(await cap.prepare(settlement)).toEqual({ status: 'not_ready' })
    expect(await cap.reconcileBatch()).toEqual([])
    expect(await ledger()).toEqual([])
  })
  it('bounded recovery only visits native prepared intents and never calls a UsageStore or models', async () => {
    const cap = await prepared()
    expect(await cap.reconcileBatch({ limit: 1, maxMs: 30000 })).toEqual([expect.objectContaining({ status: 'recorded' })])
    expect(await cap.reconcileBatch({ limit: 1 })).toEqual([])
    await expect(cap.reconcileBatch({ limit: 101 })).rejects.toThrow('bounds')
    await expect(cap.reconcileBatch({ maxMs: Infinity })).rejects.toThrow('bounds')
    expect(await ledger()).toHaveLength(1)
  })
})

describe('generic OSS behavior remains deliberately unchanged', () => {
  it('reproduces void success on zero inserted rows, without converting it into a native receipt', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(createOssUsageStore().recordUsage({ userId: ids.user,assistantId: randomUUID(),workspaceId: ids.workspace,
        sessionId: ids.conversation,model: 'actual-wire-model',inputTokens: 1,outputTokens: 1,actualCostUsd: 0.1,source: 'included' })).resolves.toBeUndefined()
      expect(await ledger()).toEqual([])
      expect(await intents()).toEqual([])
      expect(warn).toHaveBeenCalled()
    } finally { warn.mockRestore() }
  })
  it('OSS factory explicitly registers the transactional native capability without changing generic recordUsage', async () => {
    await initialAudit()
    const store = createOssUsageStore(), cap = nativeAccountingFor(store)!
    expect(cap.backend).toBe('oss-native-v1')
    const generic = vi.spyOn(store, 'recordUsage')
    expect(await cap.admit(admission)).toEqual({ status: 'admitted' })
    expect(await cap.prepare(settlement)).toMatchObject({ status: 'prepared' })
    expect(await cap.reconcile(admission.key)).toMatchObject({ status: 'recorded' })
    expect(generic).not.toHaveBeenCalled()
    expect(await ledger()).toHaveLength(1)
    expect(nativeAccountingFor({ recordUsage: async () => {} } as never)).toBeUndefined()
  })
  it('non-native unkeyed calls retain existing behavior, with no native receipt side effects', async () => {
    const store = createOssUsageStore(), params = { userId: ids.user,assistantId: ids.assistant,sessionId: ids.conversation,
      model: 'gemini-flash',inputTokens: 1,outputTokens: 1,actualCostUsd: 0.01,source: 'included' }
    await store.recordUsage(params); await store.recordUsage(params)
    expect(await ledger()).toHaveLength(2)
    expect(await intents()).toEqual([])
  })
})

describe('native accounting deadlines are not renewed by progress or retries', () => {
  it('bounds a lost checkout and destroys its late connection without issuing SQL', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout','clearTimeout','performance'] })
    try {
      const query = vi.fn(async () => ({ rows: [] })), release = vi.fn()
      const cap = createOssNativeAccounting(async () => {
        await new Promise(resolve => setTimeout(resolve, 9000))
        return { query,release }
      })
      const pending = cap.admit(admission)
      await vi.advanceTimersByTimeAsync(8001)
      expect(await pending).toEqual({ status: 'unknown' })
      expect(query).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1000)
      expect(release).toHaveBeenCalledExactlyOnceWith(expect.any(Error))
      expect(query).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })
  it('uses one deadline across checkout and SQL, discarding late responses without resetting or continuing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout','clearTimeout','performance'] })
    try {
      const query = vi.fn(async (_sql: string) => {
        await new Promise(resolve => setTimeout(resolve, 3000))
        return { rows: [] }
      }), release = vi.fn()
      const cap = createOssNativeAccounting(async () => {
        await new Promise(resolve => setTimeout(resolve, 6000))
        return { query,release }
      })
      const pending = cap.admit(admission)
      await vi.advanceTimersByTimeAsync(8001)
      expect(await pending).toEqual({ status: 'unknown' })
      expect(query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN'])
      expect(release).toHaveBeenCalledExactlyOnceWith(expect.any(Error))
      await vi.advanceTimersByTimeAsync(3000)
      expect(query).toHaveBeenCalledTimes(1)
      expect(release).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })
  it('does not reset the batch elapsed budget for the next prepared key', async () => {
    const cap = await prepared()
    admission = { ...admission,key: { ...admission.key,invocationId: randomUUID() } }
    settlement = { ...settlement,key: admission.key,attempt: { ...settlement.attempt,attemptId: admission.key.invocationId } }
    await initialAudit(); await cap.admit(admission); await cap.prepare(settlement)
    let elapsed = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed)
    try {
      const bounded = createOssNativeAccounting(async () => {
        const c = await connect()
        return {
          async query<R extends Record<string, unknown>>(sql: string, params?: unknown[]) {
            const result = await c.query<R>(sql, params)
            if (sql.includes('INSERT INTO oss_usage_tracking')) elapsed = 6
            return result
          },release: c.release,
        }
      })
      expect(await bounded.reconcileBatch({ limit: 2,maxMs: 5 })).toHaveLength(1)
    } finally { clock.mockRestore() }
    expect(await ledger()).toHaveLength(1)
    expect((await intents()).filter(r => r.state === 'prepared')).toHaveLength(1)
  })
})
