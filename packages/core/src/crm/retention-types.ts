/** Reviewable, explicitly approved CRM retention. [COMP:crm/retention] */
import { z } from 'zod'
import type { CrmOperationsContext, CrmPrivacyDomainReview, CrmPrivacyBlocker } from './operations-types.js'

const seconds = z.number().int().min(1).max(2147483647)
export const CrmRetentionPolicySchema = z.object({
  scheduled: z.boolean(),
  intervalSeconds: z.number().int().min(60).max(86400),
  resolvedSubmissionsSeconds: seconds.nullable(),
  openSubmissions: z.object({
    afterSeconds: seconds,
    fields: z.array(z.enum(['subject', 'message', 'metadata', 'notes'])).min(1).max(4)
      .refine(fields => new Set(fields).size === fields.length, 'Fields must be distinct.'),
  }).strict().nullable(),
  importReceiptsSeconds: seconds.nullable(),
  deliveryReceiptsSeconds: seconds.nullable(),
  auditSeconds: seconds.nullable(),
  financialRecordsSeconds: seconds.nullable(),
  holds: z.array(z.object({domain: z.enum(['contact', 'submission', 'order', 'file']), id: z.string().uuid()}).strict()).max(500)
    .refine(holds => new Set(holds.map(h => `${h.domain}:${h.id.toLowerCase()}`)).size === holds.length, 'Holds must be distinct.'),
}).strict()
export type CrmRetentionPolicy = z.infer<typeof CrmRetentionPolicySchema>
export const PreviewCrmRetentionCommandSchema = z.object({
  kind: z.literal('preview_retention'), before: z.string().datetime({ offset: true }),
}).strict()
export const ExecuteCrmRetentionCommandSchema = z.object({
  kind: z.literal('execute_retention'), previewId: z.string().uuid(),
  previewHash: z.string().regex(/^[a-f0-9]{64}$/), confirmed: z.literal(true),
}).strict()
export type CrmRetentionReview = {
  id: string; workspaceId: string; policyVersion: number; before: string; capturedAt: string;
  expiresAt: string; previewHash: string; status: 'ready' | 'blocked';
  domains: CrmPrivacyDomainReview[]; blockers: CrmPrivacyBlocker[]; hasMore: boolean;
  cutoffs: Record<string, string | null>; scope: 'crm_retention'; retainedCopies: string[];
}
export interface CrmRetentionServicePort {
  preview(context: CrmOperationsContext, command: z.infer<typeof PreviewCrmRetentionCommandSchema>): Promise<CrmRetentionReview>
  execute(context: CrmOperationsContext, command: z.infer<typeof ExecuteCrmRetentionCommandSchema>): Promise<{receipt: Record<string, unknown>; duplicate: boolean}>
  /** Read-only renewal of a saved manual review under its saved floor and the caller's current authority. */
  read?(context: CrmOperationsContext, previewId: string): Promise<CrmRetentionReview>
}
