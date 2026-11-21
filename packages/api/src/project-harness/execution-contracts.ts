/** Persisted review/run contracts. Authority comes from authenticated stores, never these types. */
import { z } from 'zod'
import type { HarnessRevision, HarnessScope } from './contracts.js'
import type { VerificationPreview, VerificationResult } from './verification.js'

export type HarnessHumanActor = { userId: string; authSessionId: string }
export type HarnessApproval = {
  id: string; workspaceId: string; projectId: string; revisionId: string;
  approvedBy: string; approvedAt: string; reason: string;
}
export type HarnessRunStatus = 'pending' | 'running' | 'passed' | 'failed' | 'blocked' | 'inconclusive' | 'cancelled' | 'expired'
export type HarnessRun = {
  id: string; workspaceId: string; projectId: string; approvalId: string; revisionId: string;
  requestedBy: string; executor: 'human' | 'agent'; status: HarnessRunStatus;
  preview: VerificationPreview; result: VerificationResult | null;
  createdAt: string; startedAt: string | null; expiresAt: string; completedAt: string | null;
}
export type HarnessEvidence = {
  id: string; runId: string; criterionKey: string; kind: 'observation' | 'screenshot';
  provenance: 'human_reported' | 'isolated_browser';
  text: string | null; contentType: 'image/png' | null; base64: string | null;
  sha256: string; createdAt: string;
}
export const approveRevisionSchema = z.object({
  expectedRevision: z.number().int().positive(), reason: z.string().trim().min(1).max(1000),
}).strict()
export const createHarnessRunSchema = z.object({
  approvalId: z.string().uuid(), scenarioKey: z.string().regex(/^[a-z][a-z0-9._-]{0,99}$/),
  executor: z.enum(['human', 'agent']),
  build: z.object({ buildId: z.string().trim().min(1).max(200), deploymentId: z.string().trim().min(1).max(200) }).strict(),
  target: z.object({ url: z.string().max(2048), permittedOrigins: z.array(z.string().max(2048)).min(1).max(20) }).strict(),
  environment: z.object({ environmentId: z.string().trim().min(1).max(200), locale: z.string().max(100), timezone: z.string().max(200),
    viewport: z.object({ width: z.number().int().min(1).max(16384), height: z.number().int().min(1).max(16384) }).strict() }).strict(),
}).strict()
export type CreateHarnessRun = z.infer<typeof createHarnessRunSchema>
export const humanEvidenceSchema = z.object({
  criterionKey: z.string().regex(/^[a-z][a-z0-9._-]{0,99}$/), text: z.string().trim().min(1).max(8000),
}).strict()

export interface HarnessExecutionStore {
  approvals(userId: string, workspaceId: string, projectId: string, scope: HarnessScope): Promise<HarnessApproval[]>
  approve(actor: HarnessHumanActor, workspaceId: string, projectId: string, revisionId: string, expectedRevision: number, reason: string): Promise<HarnessApproval>
  createRun(actor: HarnessHumanActor, workspaceId: string, projectId: string, input: CreateHarnessRun): Promise<HarnessRun>
  runs(userId: string, workspaceId: string, projectId: string, scope: HarnessScope): Promise<HarnessRun[]>
  run(userId: string, workspaceId: string, projectId: string, runId: string): Promise<HarnessRun>
  addHumanEvidence(actor: HarnessHumanActor, workspaceId: string, projectId: string, runId: string, input: z.infer<typeof humanEvidenceSchema>): Promise<HarnessEvidence>
  evidence(userId: string, workspaceId: string, projectId: string, runId: string): Promise<HarnessEvidence[]>
  completeHuman(actor: HarnessHumanActor, workspaceId: string, projectId: string, runId: string, result: unknown): Promise<HarnessRun>
  cancel(actor: HarnessHumanActor, workspaceId: string, projectId: string, runId: string): Promise<HarnessRun>
  /** Trusted dispatcher only; claim atomically, recheck pinned head/approval/human session and live scope. */
  claimAgent(userId: string, workspaceId: string, projectId: string, runId: string): Promise<HarnessRun>
  /** Recheck ongoing authority, cancellation, expiry, pinned head and reviewer authority before each action. */
  authorizeAgent(userId: string, workspaceId: string, projectId: string, runId: string): Promise<void>
  addAgentEvidence(userId: string, workspaceId: string, projectId: string, runId: string,
    input: { criterionKey: string; base64: string }): Promise<HarnessEvidence>
  completeAgent(userId: string, workspaceId: string, projectId: string, runId: string, result: unknown): Promise<HarnessRun>
}

export type HarnessRevisionWithApproval = { revision: HarnessRevision; approval: HarnessApproval | null }
