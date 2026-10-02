/** Explicit opt-in, never a shared/production DB integration suite.
 * From repo root (Nix package must be locally available):
 * nix shell --offline nixpkgs#postgresql --command sh -c 'exec env -i PATH="$PATH" HOME=/nonexistent-native-test-home LANG=C NODE_ENV=test node --import tsx packages/api/src/db/__tests__/oss-native-accounting.postgres-acceptance.ts'
 * PostgreSQL has no TCP listener. All identities, schemas and data are synthetic.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, lstat } from 'node:fs/promises'
import type pg from 'pg'
import { createOssNativeAccounting, type NativeAccountingConnection } from '../oss-native-accounting.js'
import { freezeNativePrice, nativeAccountingHash, type NativeAccountingCapability, type NativeAccountingKey, type NativeBillingAdmission, type NativeBillingSettlement, type NativeReconcileResult } from '../../computer-use/accounting.js'
import { OwnedNativePostgres, waitExit } from './fixtures/owned-native-postgres.js'

type SubmissionResult = Awaited<ReturnType<NativeAccountingCapability['admit' | 'prepare' | 'reconcile']>>
const price = (amount = 0.12345678905) => freezeNativePrice(amount, { basis: 'provider_reported', policyVersion: 'synthetic-test-v1', rateSnapshotHash: null })
async function seed(db: pg.Pool) {
  const ids = { user: randomUUID(),actor: randomUUID(),workspace: randomUUID(),assistant: randomUUID(),conversation: randomUUID(),task: randomUUID() }
  await db.query('INSERT INTO users(id) VALUES ($1),($2)', [ids.user,ids.actor])
  await db.query('INSERT INTO workspaces(id,owner_user_id) VALUES ($1,$2)', [ids.workspace,ids.user])
  await db.query('INSERT INTO assistants(id,workspace_id,owner_user_id) VALUES ($1,$2,$3)', [ids.assistant,ids.workspace,ids.user])
  await db.query('INSERT INTO sessions(id) VALUES ($1)', [ids.conversation])
  await db.query('INSERT INTO tasks(id) VALUES ($1)', [ids.task])
  const admission: NativeBillingAdmission = { version: 1,backend: 'oss-native-v1',key: { nativeSessionId: randomUUID(),invocationId: randomUUID() },
    scope: { userId: ids.user,actorUserId: ids.actor,workspaceId: ids.workspace,assistantId: ids.assistant,conversationId: ids.conversation,
      taskId: ids.task,deploymentId: 'synthetic-deployment',grantId: 'synthetic-grant',epoch: 3 },
    owner: 'adapter',requestedModel: 'synthetic-requested-alias',lane: 'text',stage: 'direct',operation: 'plan',perceptionPath: 'ax',providerKeySource: 'platform' }
  const settlement: NativeBillingSettlement = { key: admission.key,ledgerModel: 'synthetic-actual-model',modelTier: 'standard',price: price(),
    attempt: { attemptId: admission.key.invocationId,invocationState: 'settled',interrupted: false,requestedModel: admission.requestedModel,
      model: 'synthetic-actual-model',providerKind: 'openai',lane: 'text',outcome: 'ok',operation: 'plan',stage: 'direct',perceptionPath: 'ax',
      fallbackReason: 'none',disposition: null,durationMs: 101,usage: { inputTokens: 100,outputTokens: 20,cacheReadTokens: 4 },
      incurredCostUsd: 0.12345678905,estimatedBilledCostUsd: 0.12345678905,providerKeySource: 'platform' } }
  await db.query(`INSERT INTO native_computer_sessions(id,user_id,workspace_id,assistant_id,conversation_id,task_id,device_id,deployment_id,challenge,epoch,state,expires_at,grant_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'synthetic-deployment','synthetic-challenge',3,'active',now()+interval '1 hour','synthetic-grant')`,
  [admission.key.nativeSessionId,ids.user,ids.workspace,ids.assistant,ids.conversation,ids.task,`synthetic-device-${admission.key.nativeSessionId}`])
  await db.query(`INSERT INTO native_computer_inference_attempts(session_id,attempt_id,invocation_state,interrupted,requested_model,model,provider_kind,lane,outcome,
    operation,stage,perception_path,fallback_reason,duration_ms,provider_key_source)
    VALUES ($1,$2,'pending',false,$3,NULL,'other','text','pending','plan','direct','ax','none',0,'platform')`,
  [admission.key.nativeSessionId,admission.key.invocationId,admission.requestedModel])
  return { ids,admission,settlement,key: admission.key }
}
function capability(db: pg.Pool, pids = new Set<number>(), errors: string[] = []) {
  return createOssNativeAccounting(async (): Promise<NativeAccountingConnection> => {
    const c = await db.connect()
    pids.add(Number((await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid))
    return {
      async query<R extends Record<string, unknown>>(sql: string, params?: unknown[]) {
        try { return await c.query<R>(sql, params) }
        catch (error) { errors.push((error as { code?: string }).code ?? 'unknown'); throw error }
      },
      release(error?: Error) { c.release(error) },
    }
  })
}
async function prepare(db: pg.Pool, fixture: Awaited<ReturnType<typeof seed>>) {
  const cap = capability(db)
  assert.equal((await cap.admit(fixture.admission)).status, 'admitted')
  assert.equal((await cap.prepare(fixture.settlement)).status, 'prepared')
  return cap
}
const keyValues = (key: NativeAccountingKey) => [key.nativeSessionId,key.invocationId]
async function state(db: pg.Pool, key: NativeAccountingKey) {
  return (await db.query(`SELECT i.*,a.billing_state,a.billed_cost_usd,a.invocation_state FROM native_computer_billing_intents i
    LEFT JOIN native_computer_inference_attempts a ON (a.session_id=i.session_id AND a.attempt_id=i.attempt_id)
    WHERE i.session_id=$1 AND i.attempt_id=$2`, keyValues(key))).rows[0]
}
async function ledgerCount(db: pg.Pool, assistant: string) {
  return Number((await db.query('SELECT count(*) AS n FROM oss_usage_tracking WHERE assistant_id=$1', [assistant])).rows[0].n)
}
async function waitForBlocked(db: pg.Pool, pids: Set<number>, count: number, blocker?: number) {
  const deadline = Date.now() + 750
  do {
    const rows = (await db.query(`SELECT pid,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
      WHERE pid=ANY($1::int[]) AND wait_event_type='Lock'`, [[...pids]])).rows
    if (pids.size === count && rows.length === count && rows.every(r => r.blockers.length > 0)
      && (blocker === undefined || rows.every(r => r.blockers.includes(blocker)))) return
    await new Promise(resolve => setTimeout(resolve, 5))
  } while (Date.now() < deadline)
  assert.fail('Expected distinct PostgreSQL backends actually waiting on locks, not just Promise concurrency')
}
async function lockRow(db: pg.Pool, sql: string, params: string[]) {
  const c = await db.connect()
  await c.query('BEGIN')
  await c.query(sql, params)
  return c
}
async function raceBehindLock<T>(db: pg.Pool, gate: pg.PoolClient, pids: Set<number>, operations: Promise<T>[]): Promise<T[]> {
  // Observe all server-side waiters while the owner holds a real PostgreSQL
  // row lock, then release. No fake serialized checkout queue.
  const all = Promise.all(operations)
  try { await waitForBlocked(db, pids, operations.length) }
  finally { await gate.query('COMMIT'); gate.release() }
  return all
}
function worker(cluster: OwnedNativePostgres, mode: 'lose-commit' | 'recover', key: NativeAccountingKey) {
  const child = fork(new URL('./fixtures/native-accounting-pg-worker.ts', import.meta.url), [cluster.root,cluster.token,mode,JSON.stringify(key)],
    { execArgv: ['--import','tsx'],env: cluster.environment(),stdio: ['ignore','pipe','pipe','ipc'] })
  cluster.workers.add(child)
  let output = ''
  for (const stream of [child.stdout,child.stderr]) stream?.on('data', (part: Buffer) => {
    output += part.toString()
    if (output.length > 131072) child.kill('SIGKILL')
  })
  const message = new Promise<{ kind: string; result?: NativeReconcileResult; pid: number; backendPid: number }>((resolve, reject) => {
    // Fresh TS/module loading is not an accounting transaction. Bound startup
    // separately, then allow 10s for the production transaction's fixed 8s cap.
    let ready = false
    const fail = () => { child.kill('SIGKILL'); reject(new Error(`Owned worker ${ready ? 'operation' : 'startup'} deadline exceeded: ${output}`)) }
    let timer = setTimeout(fail, 45000)
    child.on('message', value => {
      if ((value as { kind?: string }).kind === 'ready') {
        if (ready) { clearTimeout(timer); fail(); return }
        ready = true; clearTimeout(timer); timer = setTimeout(fail, 10000)
        return
      }
      clearTimeout(timer)
      if (!ready) reject(new Error('Owned worker result preceded readiness'))
      else resolve(value as never)
    })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`Owned worker exited before result (${code}/${signal}): ${output}`)) })
  })
  return { child,message }
}
async function expectOneReceipt(db: pg.Pool, fixture: Awaited<ReturnType<typeof seed>>, result: NativeReconcileResult) {
  assert.equal(result.status, 'recorded')
  if (result.status !== 'recorded') throw new Error('Receipt missing')
  const row = await state(db, fixture.key)
  assert.equal(row.state, 'recorded')
  assert.equal(row.billing_state, 'recorded')
  assert.equal(row.invocation_state, 'settled')
  assert.equal(row.intent_hash, nativeAccountingHash(row.intent))
  assert.deepEqual(row.receipt, result.receipt)
  assert.equal(result.receipt.amountUsd, fixture.settlement.price!.amountUsd)
  assert.equal(row.stored_amount_usd, result.receipt.amountUsd)
  const ledger = (await db.query('SELECT id,actual_cost_usd,model,user_id,actor_user_id FROM oss_usage_tracking WHERE assistant_id=$1', [fixture.ids.assistant])).rows
  assert.equal(ledger.length, 1)
  assert.equal(ledger[0].id, result.receipt.ledgerId)
  assert.equal(ledger[0].actual_cost_usd, result.receipt.amountUsd)
  assert.equal(ledger[0].model, fixture.settlement.ledgerModel)
  assert.equal(ledger[0].user_id, fixture.ids.user)
  assert.equal(ledger[0].actor_user_id, fixture.ids.actor)
  return result.receipt
}

test('production native accounting on isolated multi-connection PostgreSQL', { timeout: 180000 }, async t => {
  // Fail closed if someone invokes this manually with DB configuration instead
  // of the sanitized opt-in command above. Never display environment values.
  assert(!Object.keys(process.env).some(k => /^(PG|DATABASE_URL$)/.test(k)), 'Run with the documented clean environment')
  const cluster = await OwnedNativePostgres.allocate()
  const interrupt = () => { void cluster.close().then(() => process.exit(130), () => process.exit(1)) }
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt)
  t.after(async () => {
    await cluster.close()
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt)
    await assert.rejects(lstat(cluster.root), { code: 'ENOENT' })
    t.diagnostic('Owned PostgreSQL server/workers stopped; private cluster/socket directory removed')
  })
  const db = await cluster.start()
  t.diagnostic((await db.query('SELECT version() AS version')).rows[0].version)
  await db.query(`CREATE TABLE users(id uuid PRIMARY KEY);
    CREATE TABLE workspaces(id uuid PRIMARY KEY,owner_user_id uuid REFERENCES users(id));
    CREATE TABLE assistants(id uuid PRIMARY KEY,workspace_id uuid REFERENCES workspaces(id),owner_user_id uuid REFERENCES users(id),created_at timestamptz DEFAULT now());
    CREATE TABLE sessions(id uuid PRIMARY KEY); CREATE TABLE tasks(id uuid PRIMARY KEY); CREATE TABLE auth_sessions(id uuid PRIMARY KEY);`)
  for (const migration of ['476_oss_usage_tracking.sql','620_native_computer_sessions.sql','621_native_usage_receipts.sql']) {
    await db.query(await readFile(new URL(`../../../migrations/${migration}`, import.meta.url), 'utf8'))
  }
  // Independent synthetic insertion witness survives assistant/ledger cascades;
  // its rows also roll back if the production transaction does not commit.
  await db.query(`CREATE TABLE acceptance_insertions(id uuid PRIMARY KEY,assistant_id uuid);
    CREATE FUNCTION acceptance_witness() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      INSERT INTO acceptance_insertions VALUES (NEW.id,NEW.assistant_id); RETURN NEW; END $$;
    CREATE TRIGGER acceptance_witness AFTER INSERT ON oss_usage_tracking FOR EACH ROW EXECUTE FUNCTION acceptance_witness();`)

  await t.test('concurrent same-key admissions, preparations and reconciliations use distinct waiting backends and insert once', async () => {
    const f = await seed(db)
    for (const stage of ['admit','prepare','reconcile'] as const) {
      const pids = new Set<number>()
      const gate = await lockRow(db, stage === 'admit'
        ? 'SELECT id FROM native_computer_sessions WHERE id=$1 FOR UPDATE'
        : 'SELECT attempt_id FROM native_computer_billing_intents WHERE session_id=$1 AND attempt_id=$2 FOR UPDATE',
      stage === 'admit' ? [f.key.nativeSessionId] : keyValues(f.key))
      const results = await raceBehindLock<SubmissionResult>(db, gate, pids, Array.from({ length: 4 }, () => {
        const cap = capability(db, pids)
        return stage === 'admit' ? cap.admit(f.admission) : stage === 'prepare' ? cap.prepare(f.settlement) : cap.reconcile(f.key)
      }))
      assert.equal(pids.size, 4)
      for (const result of results) assert.deepEqual(result, results[0])
      assert.equal(results[0].status, stage === 'admit' ? 'admitted' : stage === 'prepare' ? 'prepared' : 'recorded')
      if (stage !== 'reconcile') assert.equal(await ledgerCount(db, f.ids.assistant), 0)
      else await expectOneReceipt(db, f, results[0] as NativeReconcileResult)
    }
  })

  await t.test('concurrent conflicting immutable intents poison the key without overwriting the winner or inserting', async () => {
    const f = await seed(db), pids = new Set<number>()
    assert.equal((await capability(db).admit(f.admission)).status, 'admitted')
    const changed: NativeBillingSettlement = { ...f.settlement,price: price(0.25),
      attempt: { ...f.settlement.attempt,usage: { inputTokens: 222,outputTokens: 33 },incurredCostUsd: 0.25,estimatedBilledCostUsd: 0.25 } }
    const gate = await lockRow(db, 'SELECT attempt_id FROM native_computer_billing_intents WHERE session_id=$1 AND attempt_id=$2 FOR UPDATE', keyValues(f.key))
    const results = await raceBehindLock(db, gate, pids, [capability(db,pids).prepare(f.settlement),capability(db,pids).prepare(changed)])
    assert.deepEqual(results.map(r => r.status).sort(), ['conflict','prepared'])
    const winner = results[0].status === 'prepared' ? f.settlement : changed
    const row = await state(db, f.key)
    assert.equal(row.conflicted, true); assert.equal(row.state, 'blocked'); assert.equal(row.receipt, null)
    assert.deepEqual(row.intent.usage, winner.attempt.usage)
    assert.deepEqual(row.intent.price, winner.price)
    assert.equal(row.intent_hash, nativeAccountingHash(row.intent))
    assert.equal((await capability(db).reconcile(f.key)).status, 'conflict')
    assert.equal(await ledgerCount(db, f.ids.assistant), 0)
  })

  await t.test('deletion holding original attribution locks first blocks charging after commit', async () => {
    const f = await seed(db); await prepare(db, f)
    const gate = await lockRow(db, 'DELETE FROM assistants WHERE id=$1', [f.ids.assistant])
    const pids = new Set<number>()
    const result = await raceBehindLock(db, gate, pids, [capability(db,pids).reconcile(f.key)])
    assert.equal(result[0].status, 'blocked')
    const row = await state(db, f.key)
    assert.equal(row.receipt, null); assert.equal(row.ledger_id, null)
    assert.notEqual(row.billing_state, 'recorded')
    assert.equal(await ledgerCount(db, f.ids.assistant), 0)
    assert.equal((await capability(db).reconcile(f.key)).status, 'blocked')
  })

  await t.test('reconciliation holding attribution locks first commits once; deletion waits and cannot erase the receipt tombstone', async () => {
    const f = await seed(db); await prepare(db, f)
    const gate = await db.connect(), deletion = await db.connect(), pids = new Set<number>()
    let deleteWork: Promise<pg.QueryResult> | undefined
    let reconcileWork: Promise<NativeReconcileResult> | undefined
    try {
      const gatePid = Number((await gate.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      const deletionPid = Number((await deletion.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      await gate.query('SELECT pg_advisory_lock(7193,1)')
      await db.query(`CREATE FUNCTION acceptance_insert_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        PERFORM pg_advisory_xact_lock(7193,1); RETURN NEW; END $$;
        CREATE TRIGGER acceptance_insert_gate BEFORE INSERT ON oss_usage_tracking FOR EACH ROW EXECUTE FUNCTION acceptance_insert_gate();`)
      reconcileWork = capability(db,pids).reconcile(f.key)
      await waitForBlocked(db, pids, 1, gatePid)
      await deletion.query('BEGIN')
      deleteWork = deletion.query('DELETE FROM assistants WHERE id=$1', [f.ids.assistant])
      await waitForBlocked(db, new Set([deletionPid]), 1, [...pids][0])
      await gate.query('SELECT pg_advisory_unlock(7193,1)')
      const result = await reconcileWork
      assert.equal(result.status, 'recorded')
      assert.equal((await deleteWork).rowCount, 1)
      await deletion.query('COMMIT')
      assert.equal(await ledgerCount(db, f.ids.assistant), 0)
      assert.deepEqual(await capability(db).reconcile(f.key), result)
      const witnesses = (await db.query('SELECT id FROM acceptance_insertions WHERE assistant_id=$1', [f.ids.assistant])).rows
      assert.equal(witnesses.length, 1)
      if (result.status === 'recorded') assert.equal(witnesses[0].id, result.receipt.ledgerId)
      assert.equal((await state(db, f.key)).billing_state, 'recorded')
    } finally {
      await gate.query('SELECT pg_advisory_unlock_all()')
      await Promise.allSettled([reconcileWork,deleteWork])
      await deletion.query('ROLLBACK'); deletion.release(); gate.release()
      await db.query('DROP TRIGGER IF EXISTS acceptance_insert_gate ON oss_usage_tracking; DROP FUNCTION IF EXISTS acceptance_insert_gate()')
    }
  })

  await t.test('crossed assistant/session locks resolve a real deadlock without partial billing or unsafe replay', async () => {
    const f = await seed(db); await prepare(db, f)
    // Deletion owns the assistant first; reconciliation owns session/audit and
    // waits for that assistant. DELETE then needs the session's FK update lock.
    const deletion = await lockRow(db, 'SELECT id FROM assistants WHERE id=$1 FOR UPDATE', [f.ids.assistant])
    const pids = new Set<number>(), errors: string[] = []
    let reconciling: Promise<NativeReconcileResult> | undefined
    try {
      const deletionPid = Number((await deletion.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      reconciling = capability(db,pids,errors).reconcile(f.key)
      await waitForBlocked(db, pids, 1, deletionPid)
      const [accounting, deleting] = await Promise.allSettled([
        reconciling, deletion.query('DELETE FROM assistants WHERE id=$1', [f.ids.assistant]),
      ])
      assert.equal(accounting.status, 'fulfilled')
      if (deleting.status === 'rejected') {
        assert.equal((deleting.reason as { code: string }).code, '40P01')
        await deletion.query('ROLLBACK')
        await deletion.query('DELETE FROM assistants WHERE id=$1', [f.ids.assistant])
      } else {
        assert(errors.includes('40P01'), 'Must observe an actual PostgreSQL deadlock victim')
        assert.equal(deleting.value.rowCount, 1)
        await deletion.query('COMMIT')
      }
      assert.equal(await ledgerCount(db, f.ids.assistant), 0)
      const replay = await capability(db).reconcile(f.key)
      const witnessCount = Number((await db.query('SELECT count(*) AS n FROM acceptance_insertions WHERE assistant_id=$1', [f.ids.assistant])).rows[0].n)
      if (accounting.value.status === 'recorded') {
        assert.deepEqual(replay, accounting.value)
        assert.equal(witnessCount, 1)
      } else {
        assert.equal(accounting.value.status, 'unknown')
        assert.equal(replay.status, 'blocked')
        assert.equal(witnessCount, 0)
        assert.equal((await state(db, f.key)).receipt, null)
      }
    } finally {
      await deletion.query('ROLLBACK'); deletion.release()
      await reconciling
    }
  })

  await t.test('real lock timeout yields no receipt or partial charge; exact-key retry succeeds', async () => {
    const f = await seed(db); await prepare(db, f)
    const gate = await lockRow(db, 'SELECT attempt_id FROM native_computer_billing_intents WHERE session_id=$1 AND attempt_id=$2 FOR UPDATE', keyValues(f.key))
    const pids = new Set<number>(), errors: string[] = []
    const start = performance.now()
    const pending = capability(db,pids,errors).reconcile(f.key)
    try {
      await waitForBlocked(db, pids, 1)
      assert.equal((await pending).status, 'unknown')
      assert(errors.includes('55P03'), 'Must observe PostgreSQL lock_timeout, not a simulated failure')
      assert(performance.now() - start < 6000)
      assert.equal(await ledgerCount(db, f.ids.assistant), 0)
      assert.equal((await state(db, f.key)).receipt, null)
    } finally { await gate.query('ROLLBACK'); gate.release() }
    await expectOneReceipt(db, f, await capability(db).reconcile(f.key))
  })

  await t.test('client dies after real COMMIT but before capability acknowledgement; fresh processes recover the identical receipt without reinsertion', { timeout: 120000 }, async () => {
    const f = await seed(db); await prepare(db, f)
    const lost = worker(cluster, 'lose-commit', f.key)
    const committed = await lost.message
    assert.equal(committed.kind, 'committed-before-ack')
    assert.equal(committed.pid, lost.child.pid)
    lost.child.kill('SIGKILL'); await waitExit(lost.child)
    assert.equal(lost.child.signalCode, 'SIGKILL')
    const durable = (await state(db, f.key)).receipt
    assert(durable, 'Receipt transaction must already be committed despite no client acknowledgement')
    const recovered = worker(cluster, 'recover', f.key), replayed = worker(cluster, 'recover', f.key)
    const results = await Promise.all([recovered.message,replayed.message])
    await Promise.all([waitExit(recovered.child),waitExit(replayed.child)])
    assert.equal(recovered.child.exitCode, 0); assert.equal(replayed.child.exitCode, 0)
    assert.equal(new Set([committed.pid,...results.map(r => r.pid)]).size, 3)
    assert.equal(new Set([committed.backendPid,...results.map(r => r.backendPid)]).size, 3)
    for (const message of results) {
      assert.equal(message.kind, 'result')
      assert.deepEqual(await expectOneReceipt(db, f, message.result!), durable)
    }
    assert.equal(Number((await db.query('SELECT count(*) AS n FROM acceptance_insertions WHERE assistant_id=$1', [f.ids.assistant])).rows[0].n), 1)
  })
})
