import { z } from 'zod'
import { OfficeFamilySchema, OfficeSensitivitySchema, OfficeUuidSchema } from '@use-brian/office-model'

export const OFFICE_GENERATION_STAGES = [
  'queued',
  'template',
  'grounding',
  'claim_plan',
  'construct',
  'media',
  'fit_render',
  'validate',
  'export_reparse',
  'completed',
] as const
export type OfficeGenerationStage = (typeof OFFICE_GENERATION_STAGES)[number]

export const OfficeGenerationBriefSchema = z.object({
  workspaceId: OfficeUuidSchema,
  actingUserId: OfficeUuidSchema,
  assistantId: OfficeUuidSchema,
  family: OfficeFamilySchema,
  outcome: z.string().min(1).max(4_000),
  audience: z.string().min(1).max(1_000),
  sourceHandles: z.array(z.string().min(1).max(1_000)).max(100),
  requestedSensitivityFloor: OfficeSensitivitySchema,
  templateId: OfficeUuidSchema.optional(),
  canonicalWebsite: z.string().url().refine((url) => url.startsWith('https:'), 'Canonical website must use HTTPS').optional(),
  companyHasNoWebsite: z.boolean().default(false),
  idempotencyKey: z.string().min(8).max(255),
}).strict().refine((brief) => !(brief.canonicalWebsite && brief.companyHasNoWebsite), {
  message: 'canonicalWebsite and companyHasNoWebsite are mutually exclusive',
})
export type OfficeGenerationBrief = z.infer<typeof OfficeGenerationBriefSchema>

export type OfficeAuthorityProjection = {
  sensitivity: 'public' | 'internal' | 'confidential'
  visibilityUserIds: string[]
  compartments: string[]
  sourceHandles: string[]
}

export type OfficeGenerationEventCode =
  | 'office.job.queued'
  | 'office.job.authority_resolved'
  | 'office.job.template_selected'
  | 'office.job.grounding_started'
  | 'office.job.website_inspected'
  | 'office.job.claim_plan_ready'
  | 'office.job.objects_constructed'
  | 'office.job.media_processed'
  | 'office.job.fit_validated'
  | 'office.job.candidate_validated'
  | 'office.job.export_reopened'
  | 'office.job.completed'
  | 'office.job.needs_input'
  | 'office.job.failed'
  | 'office.job.cancelled'
  | 'office.job.steering_applied'

export type OfficeGenerationEvent = {
  stage: OfficeGenerationStage | 'needs_input' | 'failed' | 'cancelled'
  code: OfficeGenerationEventCode
  params: Record<string, string | number | boolean>
}

export type OfficeClaimPlanEntry = {
  objectHint: string
  text: string
  classification: 'evidence_supported' | 'user_attested' | 'derived' | 'creative_proposed' | 'unsupported_conflicted'
  confidence: number
  sourceHandles: string[]
}

export type OfficeEvidencePacket = {
  brain: Array<{ handle: string; excerpt: string; sensitivity: 'public' | 'internal' | 'confidential' }>
  website: Array<{ url: string; excerpt: string }>
  conflicts: string[]
}

export type OfficeGenerationOutcome =
  | { status: 'completed'; artifactId: string; version: number; exportBytes: Uint8Array; semanticHash: string }
  | { status: 'needs_input'; code: 'website_required' | 'template_ambiguous' | 'material_fact_missing'; question: string }
  | { status: 'failed'; code: string; message: string }
  | { status: 'cancelled' }

export type OfficeGenerationFailureCode = 'presentation_fit_failed' | 'presentation_plan_failed'

/** A typed pipeline failure whose code is safe to project to members. */
export class OfficeGenerationFailure extends Error {
  constructor(readonly code: OfficeGenerationFailureCode, message: string) {
    super(message)
    this.name = 'OfficeGenerationFailure'
  }
}
