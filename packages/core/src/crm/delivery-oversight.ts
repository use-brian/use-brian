/** Source-bound client delivery projection. Spec: client-delivery-oversight.md.
 * [COMP:crm/delivery-oversight]
 */
import { z } from 'zod'
import { CrmPageQuerySchema } from './pagination.js'
import type { AccessContext } from '../security/access-context.js'

const Uuid = z.string().uuid()
const Text = z.string().trim().min(1).max(2000)
export const DeliverySourceRefSchema = z.object({
  kind: z.enum(['episode', 'session_message', 'entity', 'file_segment']),
  id: Uuid,
  revision: z.string().min(1).max(160),
  quote: z.string().min(1).max(2000),
  start: z.number().int().min(0),
  end: z.number().int().min(1),
}).strict().refine(v => v.end > v.start && v.end - v.start === v.quote.length, 'Exact source selector is required')
export type DeliverySourceRef = z.infer<typeof DeliverySourceRefSchema>

export const DeliveryProposalSchema = z.object({
  candidateKey: z.string().trim().min(1).max(160),
  source: DeliverySourceRefSchema,
  outcome: Text,
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  companyId: Uuid.nullable().default(null),
  dealId: Uuid.nullable().default(null),
  taskIds: z.array(Uuid).max(20).default([]),
  goalIds: z.array(Uuid).max(20).default([]),
  basis: z.enum(['explicit_agreement', 'accepted_terms', 'ambiguous']),
  agreeingUserId: Uuid.nullable().default(null),
}).strict()
export type DeliveryProposal = z.infer<typeof DeliveryProposalSchema>
export const DeliveryRecognitionStateSchema = z.enum(['recognised', 'needs_review', 'dismissed', 'superseded'])
export type DeliveryRecognitionState = z.infer<typeof DeliveryRecognitionStateSchema>

const Operation = { operationId: Uuid }
export const RecordDeliveryRecognitionSchema = z.object({
  ...Operation, kind: z.literal('record_delivery_recognition'), proposal: DeliveryProposalSchema,
}).strict()
export const ReviewDeliveryRecognitionSchema = z.object({
  ...Operation, kind: z.literal('review_delivery_recognition'), commitmentId: Uuid,
  expectedVersion: z.number().int().positive(),
  decision: z.enum(['recognise', 'correct', 'dismiss']),
  reason: Text,
  outcome: Text.optional(),
}).strict().refine(v => v.decision === 'correct' || v.outcome === undefined, 'Outcome changes require correction')
export const DeliveryObservationInputSchema = z.object({
  source: DeliverySourceRefSchema,
  kind: z.enum(['observed_fact', 'human_report', 'coverage_gap', 'conflict']),
  claim: z.enum(['progress', 'outcome_delivered', 'completed', 'delay', 'blocker', 'unknown']),
  statement: Text,
  workId: Uuid.nullable().default(null),
}).strict()
export type DeliveryObservationInput = z.infer<typeof DeliveryObservationInputSchema>
export const AppendDeliveryObservationSchema = z.object({
  ...Operation, kind: z.literal('append_delivery_observation'), commitmentId: Uuid,
  expectedVersion: z.number().int().positive(), observation: DeliveryObservationInputSchema,
}).strict()
export const WithdrawDeliveryObservationSchema = z.object({
  ...Operation, kind: z.literal('withdraw_delivery_observation'), commitmentId: Uuid,
  expectedVersion: z.number().int().positive(), observationId: Uuid, reason: Text,
}).strict()
export const RefreshDeliveryAssessmentSchema = z.object({
  ...Operation, kind: z.literal('refresh_delivery_assessment'), commitmentId: Uuid,
  expectedVersion: z.number().int().positive(),
}).strict()
export const DeliveryCommandSchema = z.union([RecordDeliveryRecognitionSchema, ReviewDeliveryRecognitionSchema,
  AppendDeliveryObservationSchema, WithdrawDeliveryObservationSchema, RefreshDeliveryAssessmentSchema])
export type DeliveryCommand = z.infer<typeof DeliveryCommandSchema>
export function isDeliveryCommand(value: { kind: string }): value is DeliveryCommand {
  return ['record_delivery_recognition', 'review_delivery_recognition', 'append_delivery_observation',
    'withdraw_delivery_observation', 'refresh_delivery_assessment'].includes(value.kind)
}

export const DeliveryListQuerySchema = CrmPageQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(50).default(50),
  scope: z.enum(['personal', 'project', 'department']).default('personal'),
  scopeId: Uuid.optional(), chatId: Uuid.optional(),
}).strict().refine(v => v.scope === 'personal' ? v.scopeId === undefined : v.scopeId !== undefined, 'Native scope id is required')
export type DeliveryListQuery = z.infer<typeof DeliveryListQuerySchema>
export type DeliveryViewer = { userId: string; access?: AccessContext; chatId?: string }

/** Trusted native read, never populated from transport/model attribution. */
export type DeliverySource = DeliverySourceRef & {
  workspaceId: string; text: string; authorUserId: string | null;
  role: 'human' | 'assistant' | 'document' | 'governed' | 'unknown';
  occurredAt: string; readAt: string; archive: boolean; governedAccepted: boolean;
  userId: string | null; assistantId: string | null;
  sensitivity: 'public' | 'internal' | 'confidential'; compartments: string[]; projectIds: string[];
  originChatId: string | null;
}
export function deliveryQuoteMatches(ref: DeliverySourceRef, source: DeliverySource): boolean {
  return !source.archive && ref.kind === source.kind && ref.id === source.id && ref.revision === source.revision
    && source.text.slice(ref.start, ref.end) === ref.quote
}
export function classifyDeliveryRecognition(proposal: DeliveryProposal, source: DeliverySource): {
  state: 'recognised' | 'needs_review'; reason: string; agreeingUserId: string | null
} {
  const candidate = (reason: string) => ({ state: 'needs_review' as const, reason, agreeingUserId: source.authorUserId })
  if (!deliveryQuoteMatches(proposal.source, source)) return candidate('source_mismatch')
  if (!proposal.companyId && !proposal.dealId) return candidate('unresolved_client')
  if (proposal.basis === 'accepted_terms' && source.role === 'governed' && source.governedAccepted) {
    return { state: 'recognised', reason: 'accepted_native_terms', agreeingUserId: source.authorUserId }
  }
  if (source.role !== 'human' || !source.authorUserId) return candidate('unverified_agreeing_actor')
  if (proposal.agreeingUserId !== source.authorUserId) return candidate('agreeing_actor_mismatch')
  if (proposal.basis !== 'explicit_agreement') return candidate('ambiguous_acceptance')
  // Conservative automatic acceptance. Third-party quotation, drafts and
  // hedged proposals are reviewable even if a model labels them explicit.
  if (/\b(maybe|might|suggest|draft|propos|said|could|should)\w*\b/i.test(source.quote)
    || /^[\s>"“]/.test(source.quote)
    || !/\b(agreed|agree|accepted|confirm(?:ed)?|will deliver)\b|同意|承諾|承诺|合意|了承/i.test(source.quote)) {
    return candidate('acceptance_requires_review')
  }
  return { state: 'recognised', reason: 'authenticated_explicit_agreement', agreeingUserId: source.authorUserId }
}

export type DeliveryCommitment = {
  id: string; workspaceId: string; candidateKey: string; source: DeliverySourceRef;
  outcome: string; dueDate: string | null; companyId: string | null; dealId: string | null;
  taskIds: string[]; goalIds: string[]; agreeingUserId: string | null;
  recognitionState: DeliveryRecognitionState; recognitionReason: string; version: number;
  originChatId: string | null; createdAt: string; updatedAt: string;
}
export type DeliveryObservation = DeliveryObservationInput & {
  id: string; commitmentId: string; reporterUserId: string | null; occurredAt: string; readAt: string;
}
export type DeliveryAssessment = {
  recognition: DeliveryRecognitionState;
  coverage: 'observed' | 'reported' | 'partial' | 'conflicting' | 'unobserved';
  outcome: 'verified_delivery' | 'reported_completion' | 'unknown';
  issue: { kind: 'delay' | 'blocker'; observationId: string; statement: string; occurredAt: string; reported: boolean } | null;
  nextAction: { kind: 'inspect_work'; workId: string; observationId: string } | null;
  lastKnownAt: string | null; evaluatedAt: string; partial: boolean; reasonCodes: string[];
}
/** Pure bounded policy: no ports that can execute work, send, chase or renew. */
export function assessDelivery(commitment: DeliveryCommitment, admitted: DeliveryObservation[], evaluatedAt: string,
  partial = false): DeliveryAssessment {
  const evidence = admitted.slice(0, 20)
  partial ||= admitted.length > 20
  const reports = evidence.filter(v => v.kind === 'human_report')
  const facts = evidence.filter(v => v.kind === 'observed_fact')
  const conflict = evidence.some(v => v.kind === 'conflict')
  const recognised = commitment.recognitionState === 'recognised'
  const issueEvidence = recognised && !conflict ? evidence.find(v => (v.kind === 'observed_fact' || v.kind === 'human_report')
    && (v.claim === 'delay' || v.claim === 'blocker')) : undefined
  const verified = recognised && !conflict && !partial && facts.some(v => v.claim === 'outcome_delivered')
  const completed = recognised && !conflict && reports.some(v => v.claim === 'completed')
  return {
    recognition: commitment.recognitionState,
    coverage: conflict ? 'conflicting' : partial && (facts.length || reports.length) ? 'partial'
      : facts.length ? 'observed' : reports.length ? 'reported' : 'unobserved',
    outcome: verified ? 'verified_delivery' : completed ? 'reported_completion' : 'unknown',
    issue: issueEvidence ? { kind: issueEvidence.claim as 'delay' | 'blocker', observationId: issueEvidence.id,
      statement: issueEvidence.statement, occurredAt: issueEvidence.occurredAt, reported: issueEvidence.kind === 'human_report' } : null,
    nextAction: issueEvidence?.workId ? { kind: 'inspect_work', workId: issueEvidence.workId, observationId: issueEvidence.id } : null,
    lastKnownAt: evidence.filter(v => v.kind !== 'coverage_gap').map(v => v.occurredAt).sort().at(-1) ?? null,
    evaluatedAt, partial, reasonCodes: [!recognised ? 'recognition_review_required' : null,
      !facts.length && !reports.length ? 'no_observation' : null, partial ? 'incomplete_coverage' : null,
      conflict ? 'conflicting_evidence' : null].filter((v): v is string => Boolean(v)),
  }
}
export type DeliveryDetail = { commitment: DeliveryCommitment; observations: DeliveryObservation[]; assessment: DeliveryAssessment; evidenceCursor: string | null }
export type DeliveryReadPort = {
  list(viewer: DeliveryViewer, workspaceId: string, query: DeliveryListQuery): Promise<{ commitments: DeliveryCommitment[]; nextCursor: string | null }>;
  get(viewer: DeliveryViewer, workspaceId: string, id: string): Promise<DeliveryDetail | null>;
}
