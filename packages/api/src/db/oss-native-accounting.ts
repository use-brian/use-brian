import { getPool } from './client.js'
import {
  NativeAccountingKeySchema, NativeBillingAdmissionSchema, NativeBillingIntentSchema, NativeBillingSettlementSchema, NativeUsageReceiptSchema,
  intentForSettlement, nativeAccountingHash, parseAccounting,
  type NativeAccountingCapability, type NativeAccountingKey, type NativeBillingAdmission, type NativeBillingIntent,
  type NativePrepareResult, type NativeReconcileResult, type NativeUsageReceipt,
} from '../computer-use/accounting.js'

/** Test seam models a checked-out connection, NOT pool.query. All statements in
 * a transaction, including ledger INSERT and audit ACK, use the same checkout. */
export interface NativeAccountingConnection {
  query<R extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>
  release(error?: Error): void
}
type Connect = () => Promise<NativeAccountingConnection>
type Row = Record<string, unknown>
type Stored = Row & { admission: unknown; admission_hash: string; intent: unknown; intent_hash: string | null; state: string; conflicted: boolean; receipt: unknown }
const keyParams = (key: NativeAccountingKey) => [key.nativeSessionId, key.invocationId]

// One monotonic client deadline includes checkout, all SQL and COMMIT. Server
// timeouts alone cannot bound a lost transport response. No flag extends/reset it.
const TRANSACTION_MAX_MS = 8000
async function transaction<T>(connect: Connect, work: (c: NativeAccountingConnection) => Promise<T>): Promise<T> {
  const deadline = performance.now() + TRANSACTION_MAX_MS
  let expired = false
  const bounded = async <R>(start: () => Promise<R>): Promise<R> => {
    const remaining = deadline - performance.now()
    if (expired || remaining <= 0) { expired = true; throw new Error('Native accounting deadline exceeded') }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([Promise.resolve().then(() => {
        if (expired || performance.now() >= deadline) { expired = true; throw new Error('Native accounting deadline exceeded') }
        return start()
      }), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(new Error('Native accounting deadline exceeded')) }, remaining)
      })])
      if (performance.now() >= deadline) { expired = true; throw new Error('Native accounting deadline exceeded') }
      return result
    } finally { if (timer !== undefined) clearTimeout(timer) }
  }
  const acquiring = Promise.resolve().then(connect)
  let c: NativeAccountingConnection
  try { c = await bounded(() => acquiring) }
  catch (error) {
    // A late checkout must be destroyed, never used to start new work.
    void acquiring.then(late => late.release(new Error('Native accounting checkout expired'))).catch(() => {})
    throw error
  }
  const checked: NativeAccountingConnection = {
    query: (sql, params) => bounded(() => c.query(sql, params)),
    release: error => c.release(error),
  }
  let damaged = false
  try {
    await checked.query('BEGIN')
    await checked.query("SET LOCAL statement_timeout = '5s'")
    await checked.query("SET LOCAL lock_timeout = '1s'")
    const result = await work(checked)
    await checked.query('COMMIT') // Receipt is never returned before this resolves.
    return result
  } catch (error) {
    if (expired) damaged = true
    else { try { await checked.query('ROLLBACK') } catch { damaged = true } }
    throw error
  } finally { c.release(damaged ? new Error('Native accounting connection unavailable') : undefined) }
}
async function stored(c: NativeAccountingConnection, key: NativeAccountingKey): Promise<Stored | undefined> {
  return (await c.query<Stored>('SELECT * FROM native_computer_billing_intents WHERE session_id=$1 AND attempt_id=$2 FOR UPDATE', keyParams(key))).rows[0]
}
function admissionOf(row: Stored): NativeBillingAdmission {
  const admission = parseAccounting(NativeBillingAdmissionSchema, row.admission)
  if (nativeAccountingHash(admission) !== row.admission_hash || admission.key.nativeSessionId !== row.session_id
    || admission.key.invocationId !== row.attempt_id || admission.backend !== row.backend) throw new Error('Native admission integrity failure')
  return admission
}
function intentOf(row: Stored): NativeBillingIntent {
  const intent = parseAccounting(NativeBillingIntentSchema, row.intent)
  if (nativeAccountingHash(intent) !== row.intent_hash || nativeAccountingHash(intent.admission) !== row.admission_hash) throw new Error('Native intent integrity failure')
  return intent
}
async function markConflict(c: NativeAccountingConnection, key: NativeAccountingKey): Promise<{ status: 'conflict' }> {
  await c.query(`UPDATE native_computer_billing_intents SET conflicted=true,updated_at=now(),
    state=CASE WHEN state='prepared' THEN 'blocked' ELSE state END,
    blocked_reason=CASE WHEN state='prepared' THEN 'intent_conflict' ELSE blocked_reason END
    WHERE session_id=$1 AND attempt_id=$2`, keyParams(key))
  return { status: 'conflict' }
}
function sameAdmissionAudit(a: NativeBillingAdmission, row: Row): boolean {
  return row.requested_model === a.requestedModel && row.lane === a.lane && row.stage === a.stage
    && row.operation === a.operation && row.perception_path === a.perceptionPath && row.provider_key_source === a.providerKeySource
}
async function auditRows(c: NativeAccountingConnection, key: NativeAccountingKey) {
  // Session first, then audit, consistently with FK deletion locking.
  const session = (await c.query('SELECT * FROM native_computer_sessions WHERE id=$1 FOR UPDATE', [key.nativeSessionId])).rows[0]
  const audit = (await c.query('SELECT * FROM native_computer_inference_attempts WHERE session_id=$1 AND attempt_id=$2 FOR UPDATE', keyParams(key))).rows[0]
  return { session, audit }
}
function sameScope(a: NativeBillingAdmission, row: Row, initial = false): boolean {
  const pairs = { user_id: a.scope.userId, workspace_id: a.scope.workspaceId, assistant_id: a.scope.assistantId,
    conversation_id: a.scope.conversationId, task_id: a.scope.taskId, ...(a.scope.profileId ? { profile_id: a.scope.profileId } : {}) }
  // After admission, nullable identity FKs may detach on deletion. Original
  // attribution comes from the immutable admission, never a replacement owner.
  return Object.entries(pairs).every(([k, v]) => row[k] === v || (!initial && row[k] === null))
    && row.grant_id === a.scope.grantId && row.deployment_id === a.scope.deploymentId
    && (!initial || row.epoch === a.scope.epoch)
}
function auditMatchesIntent(a: Row, intent: NativeBillingIntent): boolean {
  return sameAdmissionAudit(intent.admission, a) && a.invocation_state === 'settled'
    && a.model === intent.actualModel && a.provider_kind === intent.providerKind
    && nativeAccountingHash(a.usage) === nativeAccountingHash(intent.usage)
    && a.incurred_cost_usd === intent.incurredCostUsd
    && typeof a.estimated_billed_cost_usd === 'number' && a.estimated_billed_cost_usd.toFixed(10) === intent.price.amountUsd
}
function receiptOf(row: Stored): NativeUsageReceipt {
  const receipt = parseAccounting(NativeUsageReceiptSchema, row.receipt), intent = intentOf(row)
  if (receipt.intentHash !== row.intent_hash || receipt.ledgerId !== row.ledger_id || receipt.amountUsd !== String(row.stored_amount_usd)
    || nativeAccountingHash(receipt.key) !== nativeAccountingHash(intent.admission.key)) throw new Error('Native receipt integrity failure')
  return Object.freeze({ ...receipt, key: Object.freeze({ ...receipt.key }) })
}

/** OSS-only, COGS-only. No generic UsageStore calls, pricing lookup, credit debit,
 * model/tool invocation, execution lease renewal, or automatic scheduler install.
 * Runtime wiring must opt in explicitly and never combine this with legacy writes. */
export function createOssNativeAccounting(connect: Connect = () => getPool().connect()): NativeAccountingCapability {
  const capability: NativeAccountingCapability = {
    backend: 'oss-native-v1',
    async admit(input) {
      const admission = parseAccounting(NativeBillingAdmissionSchema, input), key = admission.key, hash = nativeAccountingHash(admission)
      try {
        return await transaction(connect, async c => {
          const existing = await stored(c, key)
          if (existing) return existing.admission_hash !== hash ? markConflict(c, key)
            : existing.conflicted ? { status: 'conflict' as const } : { status: 'admitted' as const }
          const { session, audit } = await auditRows(c, key)
          if (!session || !audit || !sameScope(admission, session, true) || !sameAdmissionAudit(admission, audit)) return { status: 'blocked' as const }
          // Never attach a new idempotency key to a possibly unkeyed historical charge.
          if (audit.invocation_state !== 'pending' || audit.billing_state !== 'unclaimed') return { status: 'legacy' as const }
          await c.query(`INSERT INTO native_computer_billing_intents(session_id,attempt_id,version,backend,admission,admission_hash,state)
            VALUES ($1,$2,1,'oss-native-v1',$3::jsonb,$4,'admitted') ON CONFLICT (session_id,attempt_id) DO NOTHING`,
          [...keyParams(key), JSON.stringify(admission), hash])
          const inserted = await stored(c, key)
          if (!inserted) throw new Error('Native admission not inserted')
          return inserted.admission_hash === hash ? { status: 'admitted' as const } : markConflict(c, key)
        })
      } catch { return { status: 'unknown' } }
    },
    async prepare(input): Promise<NativePrepareResult> {
      const settlement = parseAccounting(NativeBillingSettlementSchema, input), key = settlement.key, a = settlement.attempt
      try {
        return await transaction(connect, async c => {
          const existing = await stored(c, key)
          if (!existing) return { status: 'legacy' as const }
          const admission = admissionOf(existing)
          if (a.attemptId !== key.invocationId || !sameAdmissionAudit(admission, {
            requested_model: a.requestedModel, lane: a.lane, stage: a.stage, operation: a.operation,
            perception_path: a.perceptionPath, provider_key_source: a.providerKeySource,
          })) return markConflict(c, key)
          let intent: NativeBillingIntent | null
          try { intent = intentForSettlement(admission, settlement) } catch { return markConflict(c, key) }
          const hash = intent ? nativeAccountingHash(intent) : null
          if (intent && (a.estimatedBilledCostUsd === null || a.estimatedBilledCostUsd.toFixed(10) !== intent.price.amountUsd)) return markConflict(c, key)
          if (existing.intent) {
            // No repricing, scope substitution, or silent first-writer mismatch.
            if (existing.intent_hash !== hash) return markConflict(c, key)
            return existing.conflicted ? { status: 'conflict' as const } : existing.state === 'blocked' ? { status: 'blocked' as const }
              : { status: 'prepared' as const, intentHash: hash! }
          }
          if (existing.conflicted) return { status: 'conflict' as const }
          if (a.invocationState !== 'settled') return { status: 'not_ready' as const }
          const { session, audit } = await auditRows(c, key)
          if (!session || !audit || !sameScope(admission, session)) return { status: 'blocked' as const }
          if (!sameAdmissionAudit(admission, audit)) return markConflict(c, key)
          if (audit.billing_state === 'claimed' || audit.billing_state === 'recorded') return { status: 'legacy' as const }
          if (audit.invocation_state === 'settled' && (audit.model !== a.model || audit.provider_kind !== a.providerKind
            || (audit.usage !== null && nativeAccountingHash(audit.usage) !== nativeAccountingHash(a.usage))
            || (audit.incurred_cost_usd !== null && audit.incurred_cost_usd !== a.incurredCostUsd)
            || (audit.estimated_billed_cost_usd !== null && audit.estimated_billed_cost_usd !== a.estimatedBilledCostUsd))) return markConflict(c, key)
          // Final audit and priced intent become durable together BEFORE any
          // reconcile/ledger call. Jev's central owner must await this boundary.
          const updated = await c.query(`UPDATE native_computer_inference_attempts SET invocation_state='settled',
            model=$3,provider_kind=$4,usage=$5::jsonb,incurred_cost_usd=$6,estimated_billed_cost_usd=$7,
            billing_state=CASE WHEN $13::boolean THEN 'unknown' ELSE billing_state END,
            duration_ms=GREATEST(duration_ms,$8),interrupted=interrupted OR $9,
            outcome=CASE WHEN invocation_state='settled' THEN outcome ELSE $10 END,
            disposition=COALESCE(disposition,$11),fallback_reason=COALESCE(fallback_reason,$12),
            diagnostic_code=CASE WHEN invocation_state='settled' THEN diagnostic_code WHEN $10='failed' THEN 'inference_failed' ELSE NULL END
            WHERE session_id=$1 AND attempt_id=$2 RETURNING id`, [...keyParams(key), a.model, a.providerKind, a.usage === null ? null : JSON.stringify(a.usage),
            a.incurredCostUsd, a.estimatedBilledCostUsd, a.durationMs, a.interrupted, a.outcome, a.disposition, a.fallbackReason, !intent && admission.scope.taskId === null])
          if (updated.rows.length !== 1) throw new Error('Native final audit not persisted')
          if (!intent) return { status: 'not_ready' as const }
          await c.query(`UPDATE native_computer_billing_intents SET intent=$3::jsonb,intent_hash=$4,state='prepared',updated_at=now()
            WHERE session_id=$1 AND attempt_id=$2`, [...keyParams(key), JSON.stringify(intent), hash])
          return { status: 'prepared' as const, intentHash: hash! }
        })
      } catch { return { status: 'unknown' } }
    },
    async reconcile(input): Promise<NativeReconcileResult> {
      const key = parseAccounting(NativeAccountingKeySchema, input)
      try {
        return await transaction(connect, async c => {
          const row = await stored(c, key)
          if (!row) return { status: 'legacy' as const }
          // Historical receipt survives cascade deletion of the COGS row/session.
          // Absence of that row can NEVER authorize another insertion.
          if (row.state === 'recorded') return { status: 'recorded' as const, receipt: receiptOf(row) }
          if (row.conflicted) return { status: 'conflict' as const }
          if (row.state === 'blocked') return { status: 'blocked' as const }
          if (!row.intent) return { status: 'not_ready' as const }
          const intent = intentOf(row), admission = intent.admission, s = admission.scope
          const block = async (reason: 'audit_missing' | 'audit_conflict' | 'attribution_missing'): Promise<{ status: 'blocked' }> => {
            await c.query(`UPDATE native_computer_billing_intents SET state='blocked',blocked_reason=$3,updated_at=now()
              WHERE session_id=$1 AND attempt_id=$2`, [...keyParams(key), reason])
            return { status: 'blocked' }
          }
          const { session, audit } = await auditRows(c, key)
          if (!session || !audit) return block('audit_missing')
          if (!sameScope(admission, session) || !auditMatchesIntent(audit, intent)
            || audit.billing_state === 'claimed' || audit.billing_state === 'recorded') return block('audit_conflict')
          // Lock exact original identities against deletion/movement. No current
          // owner lookup or representative assistant/workspace fallback.
          const attribution = await c.query(`SELECT a.id FROM assistants a JOIN workspaces w ON w.id=a.workspace_id
            JOIN users payer ON payer.id=$3 JOIN users actor ON actor.id=$4
            WHERE a.id=$1 AND w.id=$2 FOR SHARE OF a,w,payer,actor`, [s.assistantId, s.workspaceId, s.userId, s.actorUserId])
          if (attribution.rows.length !== 1) return block('attribution_missing')
          const u = intent.usage
          const inserted = await c.query<{ id: string; amount: string }>(`INSERT INTO oss_usage_tracking
            (user_id,workspace_id,actor_user_id,assistant_id,session_id,model,model_tier,input_tokens,output_tokens,
             cache_read_tokens,cache_write_tokens,actual_cost_usd,source,trigger_key,provider_key_source)
            SELECT $1::uuid,$2::uuid,$3::uuid,a.id,$5,$6,$7,$8,$9,$10,$11,$12::numeric,$13,$14,$15
              FROM assistants a JOIN workspaces w ON w.id=a.workspace_id WHERE a.id=$4 AND w.id=$2
            RETURNING id,actual_cost_usd::text AS amount`, [s.userId,s.workspaceId,s.actorUserId,s.assistantId,s.conversationId,
            intent.ledgerModel,intent.modelTier,u.inputTokens,u.outputTokens,u.cacheReadTokens ?? 0,u.cacheWriteTokens ?? 0,
            intent.price.amountUsd,intent.source,intent.triggerKey,admission.providerKeySource])
          if (inserted.rows.length !== 1) throw new Error('Native ledger insertion unacknowledged')
          const ledger = inserted.rows[0]!
          if (ledger.amount !== intent.price.amountUsd) throw new Error('Native ledger amount mismatch')
          const receipt = parseAccounting(NativeUsageReceiptSchema, { version: 1,kind: 'native_usage_inserted',backend: 'oss-native-v1',
            key,intentHash: row.intent_hash,ledgerId: ledger.id,amountUsd: ledger.amount })
          const acknowledged = await c.query(`UPDATE native_computer_inference_attempts SET billing_state='recorded',billed_cost_usd=$3::numeric
            WHERE session_id=$1 AND attempt_id=$2 AND invocation_state='settled' AND model IS NOT NULL AND usage IS NOT NULL
              AND billing_state IN ('unclaimed','unknown','not_required') RETURNING id`, [...keyParams(key), ledger.amount])
          if (acknowledged.rows.length !== 1) throw new Error('Native ledger audit unacknowledged')
          const saved = await c.query(`UPDATE native_computer_billing_intents SET state='recorded',ledger_id=$3,
            stored_amount_usd=$4::numeric,receipt=$5::jsonb,updated_at=now() WHERE session_id=$1 AND attempt_id=$2 RETURNING attempt_id`,
          [...keyParams(key),ledger.id,ledger.amount,JSON.stringify(receipt)])
          if (saved.rows.length !== 1) throw new Error('Native receipt not persisted')
          return { status: 'recorded' as const, receipt: Object.freeze({ ...receipt, key: Object.freeze({ ...receipt.key }) }) }
        })
      } catch { return { status: 'unknown' } }
    },
    async reconcileBatch(options = {}) {
      const limit = options.limit ?? 25, maxMs = options.maxMs ?? 5000
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isFinite(maxMs) || maxMs < 1 || maxMs > 30000) throw new Error('Invalid native reconciliation bounds')
      const start = performance.now()
      let keys: NativeAccountingKey[]
      try {
        keys = await transaction(connect, async c => (await c.query<{ nativeSessionId: string; invocationId: string }>(
          `SELECT session_id AS "nativeSessionId",attempt_id AS "invocationId" FROM native_computer_billing_intents
           WHERE backend='oss-native-v1' AND state='prepared' AND NOT conflicted ORDER BY updated_at,session_id,attempt_id LIMIT $1`, [limit])).rows)
      } catch { return [{ status: 'unknown' }] }
      const results: NativeReconcileResult[] = []
      for (const key of keys) {
        if (performance.now() - start >= maxMs) break
        results.push(await capability.reconcile(key))
      }
      return Object.freeze(results)
    },
  }
  return Object.freeze(capability)
}
