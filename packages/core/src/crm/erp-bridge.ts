/**
 * ERP bridge contracts: a provider binding owns writer state for the migrated
 * record classes; legacy identities map one-to-one to canonical companies,
 * deals and enrolled viewers; imports are staged as a dry-run report and
 * confirmed against that exact report; retained domain applications consume a
 * versioned, fee-free projection feed and acknowledge it with receipts; an
 * explicit cutover freezes legacy writes, reconciles and commits once.
 * Spec: docs/architecture/features/crm-commercial-operations.md -> ERP bridge
 *
 * [COMP:crm/erp-bridge]
 */

import { z } from 'zod'
import { CrmDecimalStringSchema } from './commercial-context.js'

const Uuid = z.string().uuid()
const StableKey = z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_-]{0,62}$/)
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const LegacyId = z.string().trim().min(1).max(200)
const Code = z.string().trim().min(1).max(128)
const Money = z.object({ amount: CrmDecimalStringSchema, currency: z.string().regex(/^[A-Z]{3}$/) }).strict()

export const CRM_ERP_RECORD_CLASSES = ['client', 'engagement'] as const
export const CrmErpRecordClassSchema = z.enum(CRM_ERP_RECORD_CLASSES)

/** Retained journeys the bridge supports; the capability catalog lists them explicitly. */
export const CRM_ERP_CAPABILITIES = [
  'client_master', 'engagement_master', 'change_requests', 'protected_fees', 'billing_handoff',
  'recurring_successors', 'imports_exports', 'engagement_projection',
] as const

export const CrmErpClientRecordSchema = z.object({
  legacyId: LegacyId, name: z.string().trim().min(1).max(512), domain: z.string().trim().min(1).max(253).nullable().default(null),
  code: Code.nullable().default(null), formerCodes: z.array(Code).max(20).default([]),
}).strict()
export const CrmErpEngagementRecordSchema = z.object({
  legacyId: LegacyId, clientLegacyId: LegacyId, name: z.string().trim().min(1).max(512),
  code: Code.nullable().default(null), formerCodes: z.array(Code).max(20).default([]),
  serviceCategory: StableKey.nullable().default(null), workStatus: StableKey.nullable().default(null),
  periodStart: IsoDate.nullable().default(null), periodEnd: IsoDate.nullable().default(null),
  financialPeriod: z.string().trim().min(1).max(40).nullable().default(null),
  quotedFee: Money.nullable().default(null), confirmedFee: Money.nullable().default(null),
}).strict()
export const CrmErpImportRecordsSchema = z.object({
  clients: z.array(CrmErpClientRecordSchema).max(2000).default([]),
  engagements: z.array(CrmErpEngagementRecordSchema).max(5000).default([]),
}).strict()
export type CrmErpImportRecords = z.infer<typeof CrmErpImportRecordsSchema>

export const StageCrmErpImportCommandSchema = z.object({
  kind: z.literal('stage_erp_import'), operationId: Uuid,
  bindingKey: StableKey, label: z.string().trim().min(1).max(200).optional(),
  /** Reference definitions that carry the legacy client and engagement codes. */
  referenceDefinitions: z.object({ client: StableKey.optional(), engagement: StableKey.optional() }).strict().default({}),
  records: CrmErpImportRecordsSchema,
}).strict()
export const ConfirmCrmErpImportCommandSchema = z.object({
  kind: z.literal('confirm_erp_import'), operationId: Uuid, importId: Uuid,
  /** The confirmation is bound to the exact dry-run report that was reviewed. */
  expectedReportHash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict()
export const RecordCrmProjectionReceiptCommandSchema = z.object({
  kind: z.literal('record_projection_receipt'), operationId: Uuid, bindingKey: StableKey,
  receipts: z.array(z.object({ eventSeq: z.string().regex(/^\d{1,18}$/), subjectId: Uuid, version: z.number().int().min(1) }).strict()).max(500).default([]),
  /** After a resync read, the consumer records the full-state version it now holds. */
  resynced: z.array(z.object({ subjectId: Uuid, version: z.number().int().min(1) }).strict()).max(500).default([]),
}).strict().refine((value) => value.receipts.length + value.resynced.length > 0, 'Send receipts or resynced subjects')
const SourceSnapshot = z.object({
  counts: z.object({ client: z.number().int().min(0), engagement: z.number().int().min(0) }).strict(),
  exportHash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict()
export const PrepareCrmErpCutoverCommandSchema = z.object({
  kind: z.literal('prepare_erp_cutover'), operationId: Uuid, bindingKey: StableKey,
  recordClasses: z.array(CrmErpRecordClassSchema).min(1).max(2), source: SourceSnapshot,
}).strict()
export const CommitCrmErpCutoverCommandSchema = z.object({
  kind: z.literal('commit_erp_cutover'), operationId: Uuid, cutoverId: Uuid, expectedVersion: z.number().int().min(1),
  /** The final legacy snapshot after the write freeze and the delta replay. */
  finalSource: SourceSnapshot,
}).strict()
export const EnrollCrmErpViewerCommandSchema = z.object({
  kind: z.literal('enroll_erp_viewer'), operationId: Uuid, bindingKey: StableKey, legacyUserId: LegacyId,
}).strict()

export const CRM_ERP_COMMAND_KINDS = ['stage_erp_import', 'confirm_erp_import', 'record_projection_receipt', 'prepare_erp_cutover', 'commit_erp_cutover', 'enroll_erp_viewer'] as const
export const CrmErpCommandSchema = z.union([
  StageCrmErpImportCommandSchema, ConfirmCrmErpImportCommandSchema, RecordCrmProjectionReceiptCommandSchema,
  PrepareCrmErpCutoverCommandSchema, CommitCrmErpCutoverCommandSchema, EnrollCrmErpViewerCommandSchema,
])
export type CrmErpCommand = z.infer<typeof CrmErpCommandSchema>
export function isCrmErpCommand(command: { kind: string }): command is CrmErpCommand {
  return (CRM_ERP_COMMAND_KINDS as readonly string[]).includes(command.kind)
}

/** Deterministic hash input for a legacy export: records sorted by legacy id. */
export function crmErpCanonicalRecords(records: CrmErpImportRecords): CrmErpImportRecords {
  const byId = <T extends { legacyId: string }>(rows: readonly T[]) => [...rows].sort((a, b) => a.legacyId.localeCompare(b.legacyId))
  return { clients: byId(records.clients), engagements: byId(records.engagements) }
}

/** Consumer receipt rule: only the next version advances; a gap requires a resync, a repeat is a duplicate. */
export function crmProjectionReceiptOutcome(lastApplied: number, version: number): 'applied' | 'duplicate' | 'resync_required' {
  if (version <= lastApplied) return 'duplicate'
  return version === lastApplied + 1 ? 'applied' : 'resync_required'
}

// ── Reads ───────────────────────────────────────────────────────────

export const CrmProjectionEventQuerySchema = z.object({
  bindingKey: StableKey, cursor: z.string().regex(/^\d{1,18}$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
}).strict()
export const CrmLegacyMappingQuerySchema = z.object({
  bindingKey: StableKey, legacyType: z.enum(['client', 'engagement']), legacyId: LegacyId.optional(), targetId: Uuid.optional(),
}).strict().refine((value) => value.legacyId !== undefined || value.targetId !== undefined, 'Supply legacyId or targetId')

export type CrmErpViewer = { userId: string }
export type CrmErpReadPort = {
  getBinding(workspaceId: string, viewer: CrmErpViewer, bindingKey: string): Promise<Record<string, unknown> | null>
  getImport(workspaceId: string, viewer: CrmErpViewer, importId: string): Promise<Record<string, unknown> | null>
  getCutover(workspaceId: string, viewer: CrmErpViewer, cutoverId: string): Promise<Record<string, unknown> | null>
  lookupMapping(workspaceId: string, viewer: CrmErpViewer, query: z.infer<typeof CrmLegacyMappingQuerySchema>): Promise<Record<string, unknown> | null>
  listProjectionEvents(workspaceId: string, viewer: CrmErpViewer, query: z.infer<typeof CrmProjectionEventQuerySchema>): Promise<{ schemaVersion: 1; events: Array<Record<string, unknown>>; nextCursor: string | null }>
}
