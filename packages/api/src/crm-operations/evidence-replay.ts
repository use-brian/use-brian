/** Provider replay identity, shared by canonical and compatibility persistence.
 * [COMP:crm/operations-store]
 */
import { CrmOperationsError, crmOperationsSha256 } from '@use-brian/core/crm/operations-types.js'
import { crmPageInstant } from './pagination.js'

type Common = {
  contactId: string; action: string; source: string
  occurredAt?: string; metadata: Record<string, unknown>
}
export type CrmEvidenceRequest = Common & (
  | { kind: 'consent'; purposeKey: string; wordingVersion?: string; locale?: 'en' | 'zh' | 'zh-CN' | 'ja' }
  | { kind: 'suppression'; channel: string; reasonCode: string }
)

export function crmEvidenceRequestHash(request: CrmEvidenceRequest): string {
  return crmOperationsSha256({
    ...request,
    ...(request.kind === 'consent' ? { wordingVersion: request.wordingVersion ?? null } : {}),
    occurredAt: request.occurredAt === undefined ? null : crmPageInstant(request.occurredAt),
  })
}

/** SELECT the two __ fields internally; never expose integrity implementation fields. */
export function resolveCrmEvidenceReplay(
  row: Record<string, unknown>, request: CrmEvidenceRequest,
): Record<string, unknown> {
  const { __requestHash, __occurredAt, ...record } = row
  const expected = crmEvidenceRequestHash(request)
  if (__requestHash != null) {
    if (__requestHash === expected) return record
  } else {
    if (request.kind === 'consent' && request.locale !== undefined && request.locale !== record.wordingLocale) {
      throw new CrmOperationsError('idempotency_conflict', 'Legacy evidence cannot establish the requested wording locale.')
    }
    if (request.occurredAt === undefined) throw new CrmOperationsError('idempotency_conflict',
      'Legacy provider evidence requires its original occurrence time for replay.',
      { reason: 'legacy_evidence_requires_occurred_at' })
    const common = { contactId: String(record.contactId), action: String(record.action),
      source: String(record.source), metadata: record.metadata as Record<string, unknown>,
      occurredAt: String(__occurredAt) }
    const original: CrmEvidenceRequest = request.kind === 'consent'
      ? { ...common, kind: 'consent', purposeKey: String(record.purpose),
          ...(request.locale !== undefined ? { locale: request.locale } : {}),
          ...(request.wordingVersion !== undefined ? { wordingVersion: String(record.wordingVersion) } : {}) }
      : { ...common, kind: 'suppression', channel: String(record.channel), reasonCode: String(record.reasonCode) }
    if (crmEvidenceRequestHash(original) === expected) return record
  }
  throw new CrmOperationsError('idempotency_conflict', 'Provider event id was already used for different evidence.')
}
