import { createHash } from 'node:crypto'
import { z } from 'zod'
import { NativeModelIdSchema } from '@use-brian/core'
import { registryRowForPricing } from '@use-brian/shared/model-registry'
import { NativeAttemptSchema } from './service.js'

/** Infrastructure denial, never a provider/semantic uncertainty result. */
export class NativeAccountingUnavailableError extends Error {
  constructor(phase: 'admission' | 'settlement' = 'settlement') {
    super(phase === 'admission' ? 'Native accounting admission unavailable' : 'Native accounting unavailable')
    this.name = 'NativeAccountingUnavailableError'
  }
}

const uuid = z.string().uuid()
const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const usage = z.object({ inputTokens: count, outputTokens: count, cacheReadTokens: count.optional(), cacheWriteTokens: count.optional() }).strict()
/** OSS NUMERIC(18,10), represented exactly on the wire, never a float receipt. */
export const NativeStoredUsdSchema = z.string().regex(/^(?:0|[1-9][0-9]{0,7})\.[0-9]{10}$/)
export const NativeAccountingKeySchema = z.object({ nativeSessionId: uuid, invocationId: uuid }).strict()
export type NativeAccountingKey = Readonly<z.infer<typeof NativeAccountingKeySchema>>

/** A trusted admission snapshot, not a current-membership/lease authorization.
 * Revocation advances the live epoch; late accounting retains this original one.
 * Only IDs and fixed classifications are retained. No ToolContext/grant object. */
export const NativeBillingAdmissionSchema = z.object({
  version: z.literal(1), backend: z.literal('oss-native-v1'),
  key: NativeAccountingKeySchema,
  scope: z.object({ userId: uuid, actorUserId: uuid, workspaceId: uuid, assistantId: uuid, conversationId: uuid, taskId: uuid,
    grantId: identifier, deploymentId: identifier, epoch: z.number().int().nonnegative().max(2147483647) }).strict(),
  owner: z.enum(['adapter', 'central_primary']), requestedModel: NativeModelIdSchema,
  lane: NativeAttemptSchema.shape.lane, stage: NativeAttemptSchema.shape.stage,
  operation: NativeAttemptSchema.shape.operation.unwrap(), perceptionPath: NativeAttemptSchema.shape.perceptionPath,
  providerKeySource: NativeAttemptSchema.shape.providerKeySource,
}).strict().superRefine((a, ctx) => {
  if ((a.owner === 'central_primary') !== (a.lane === 'decision') || (a.lane === 'decision') !== (a.stage === 'primary_decision')
    || (a.lane === 'vision') !== (a.perceptionPath === 'vision') || (a.lane === 'vision') !== (a.operation === 'ground')
    || (a.owner === 'central_primary' && (a.providerKeySource !== 'platform' || !['next-action', 'verify-progress'].includes(a.operation)))) {
    ctx.addIssue({ code: 'custom', message: 'Invalid native billing admission' })
  }
})
export type NativeBillingAdmission = z.infer<typeof NativeBillingAdmissionSchema>

/** No pricing lookup during reconciliation. Registry quotes must identify the
 * exact pricing snapshot; provider-reported cost and BYOK are distinct bases. */
export const NativeBillingPriceSchema = z.object({
  amountUsd: NativeStoredUsdSchema,
  basis: z.enum(['registry', 'provider_reported', 'byok']),
  policyVersion: identifier,
  rateSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  rounding: z.literal('js-to-fixed-10-v1'),
}).strict().superRefine((p, ctx) => {
  if ((p.basis === 'registry') !== (p.rateSnapshotHash !== null) || (p.basis === 'byok' && p.amountUsd !== '0.0000000000')) {
    ctx.addIssue({ code: 'custom', message: 'Invalid native pricing provenance' })
  }
})
export type NativeBillingPrice = z.infer<typeof NativeBillingPriceSchema>

/** Only rounds an explicitly supplied known price; never guesses rates or model. */
export function freezeNativePrice(amountUsd: number, provenance: Omit<NativeBillingPrice, 'amountUsd' | 'rounding'>): NativeBillingPrice {
  if (!Number.isFinite(amountUsd) || amountUsd < 0) throw new Error('Invalid native price')
  return Object.freeze(parseAccounting(NativeBillingPriceSchema, { ...provenance, amountUsd: amountUsd.toFixed(10), rounding: 'js-to-fixed-10-v1' }))
}

export const NativeBillingSettlementSchema = z.object({
  key: NativeAccountingKeySchema,
  // Mutable lifecycle duration/outcome are audited, but excluded from the billing fingerprint.
  attempt: NativeAttemptSchema.extend({ usage: usage.nullable() }).strict(),
  ledgerModel: NativeModelIdSchema.nullable(),
  modelTier: z.enum(['standard', 'pro', 'max', 'research', 'embedding', 'other']),
  price: NativeBillingPriceSchema.nullable(),
}).strict().superRefine(({ attempt: a }, ctx) => {
  if ((a.invocationState === 'settled' && a.outcome === 'pending') || (a.invocationState === 'pending' && a.outcome === 'ok')
    || (a.interrupted && a.outcome === 'ok')) ctx.addIssue({ code: 'custom', message: 'Invalid native lifecycle metadata' })
})
export type NativeBillingSettlement = z.infer<typeof NativeBillingSettlementSchema>

export const NativeBillingIntentSchema = z.object({
  version: z.literal(1), admission: NativeBillingAdmissionSchema,
  actualModel: NativeModelIdSchema, ledgerModel: NativeModelIdSchema,
  providerKind: NativeAttemptSchema.shape.providerKind,
  usage, incurredCostUsd: NativeAttemptSchema.shape.incurredCostUsd,
  modelTier: z.enum(['standard', 'pro', 'max', 'research', 'embedding', 'other']),
  price: NativeBillingPriceSchema,
  source: z.literal('included'), triggerKey: z.enum(['computer_use:native_text', 'computer_use:native_vision', 'computer_use:native_decision']),
}).strict()
export type NativeBillingIntent = z.infer<typeof NativeBillingIntentSchema>
export const NativeUsageReceiptSchema = z.object({
  version: z.literal(1), kind: z.literal('native_usage_inserted'), backend: z.literal('oss-native-v1'),
  key: NativeAccountingKeySchema, intentHash: z.string().regex(/^[a-f0-9]{64}$/),
  ledgerId: uuid, amountUsd: NativeStoredUsdSchema,
}).strict()
export type NativeUsageReceipt = Readonly<z.infer<typeof NativeUsageReceiptSchema>>
export type NativeAccountingFailure = { status: 'not_ready' | 'conflict' | 'blocked' | 'legacy' | 'unknown' | 'unsupported' }
export type NativePrepareResult = { status: 'prepared'; intentHash: string } | NativeAccountingFailure
/** Pre-dispatch admission is distinct from an incomplete/unknown settlement. */
export type NativeAttemptPreparation = { status: 'admitted' } | NativePrepareResult
export type NativeReconcileResult = { status: 'recorded'; receipt: NativeUsageReceipt } | NativeAccountingFailure

/** Separate capability: generic UsageStore.recordUsage remains untouched.
 * Admission MUST precede provider dispatch. Prepare MUST durably finalize the
 * audit and intent before the central Jev owner calls reconcile. Neither method
 * is permission to invoke models/actions. Unsupported stores have no fallback. */
export interface NativeAccountingCapability {
  readonly backend: 'oss-native-v1'
  admit(admission: NativeBillingAdmission): Promise<{ status: 'admitted' } | NativeAccountingFailure>
  prepare(settlement: NativeBillingSettlement): Promise<NativePrepareResult>
  reconcile(key: NativeAccountingKey): Promise<NativeReconcileResult>
  reconcileBatch(options?: { limit?: number; maxMs?: number }): Promise<readonly NativeReconcileResult[]>
}

export function parseAccounting<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new Error('Invalid native accounting metadata')
  return result.data
}
/** Sorted structural canonicalization: JSONB does not preserve insertion order. */
export function nativeAccountingHash(value: unknown): string {
  const canonical = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
    if (v !== null && typeof v === 'object') return `{${Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('Invalid native accounting value')
    if (v === undefined || typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') throw new Error('Invalid native accounting value')
    return JSON.stringify(v)
  }
  return createHash('sha256').update(canonical(value)).digest('hex')
}
export function intentForSettlement(admission: NativeBillingAdmission, settlement: NativeBillingSettlement): NativeBillingIntent | null {
  const a = settlement.attempt
  if (a.invocationState !== 'settled' || !a.model || !a.usage || !settlement.price || !settlement.ledgerModel) return null
  if (nativeAccountingHash(admission.key) !== nativeAccountingHash(settlement.key) || a.attemptId !== admission.key.invocationId
    || (['requestedModel', 'lane', 'stage', 'operation', 'perceptionPath', 'providerKeySource'] as const).some(k => a[k] !== admission[k])) throw new Error('Native billing conflict')
  // Primary catalog and wire IDs may differ, but must denote the same registry
  // model. Adapters MUST bill their observed actual model, not the request alias.
  if (settlement.ledgerModel !== a.model) {
    const row = registryRowForPricing(a.model), wire = registryRowForPricing(settlement.ledgerModel)
    if (admission.owner !== 'central_primary' || !row || !wire || row.alias !== wire.alias || a.providerKind !== 'typesafe') throw new Error('Native billing conflict')
  }
  if ((admission.providerKeySource === 'user') !== (settlement.price.basis === 'byok')) throw new Error('Native billing conflict')
  return parseAccounting(NativeBillingIntentSchema, { version: 1, admission, actualModel: a.model, ledgerModel: settlement.ledgerModel,
    providerKind: a.providerKind, usage: a.usage, incurredCostUsd: a.incurredCostUsd,
    modelTier: settlement.modelTier, price: settlement.price, source: 'included', triggerKey: `computer_use:native_${admission.lane}` })
}
