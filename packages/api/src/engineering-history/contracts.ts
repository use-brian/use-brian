/** Native capture archive contracts. [COMP:api/engineering-history] */
import type { BrainAuth } from '../brain-mcp/auth.js'
import type { ProgrammaticCaptureInput, ProgrammaticCaptureResult } from '../ingest/programmatic-capture.js'
import type { ProgrammaticCaptureRule, ProgrammaticCaptureTarget } from '../db/programmatic-capture-store.js'
export const ARCHIVE_TEXT_LIMIT = 256 * 1024
export type ArchiveSnapshot = {
 processingPurpose: 'archive_only'
 archiveId: string
 serverSequence?: string
 workspaceId: string
 assistantId: string
 profileId: string
 profileRevision: string
 ruleId: string
 ruleSnapshot: Record<string, unknown>
 keyRevision: string
 principalKind: BrainAuth['authKind']
 principalId: string
 actingUserId: string
 sensitivity: 'public' | 'internal' | 'confidential'
 compartments: string[]
 projectIds: string[]
 eventId: string
 content: string
 payloadDigest: string
 contentDigest: string
 occurredAt: string
 receivedAt: string
 role: 'user' | 'assistant'
 provider: string
 sessionId?: string
 subjectId?: string
 turnId?: string
 attributionQuality: string
}
export type ArchiveReceipt = ProgrammaticCaptureResult & {
 contractVersion: 1
 processingPurpose: 'archive_only'
 archiveId?: string
 fileId?: string
 deliveryStatus: 'pending' | 'archived' | 'excluded' | 'deleted' | 'dropped' | 'held'
 indexStatus: 'pending' | 'ready' | 'withheld'
 profileRevision?: string
}
export type ArchiveCapture = (auth: BrainAuth,input: ProgrammaticCaptureInput,target: ProgrammaticCaptureTarget,rule: ProgrammaticCaptureRule,
 scope: {sensitivity: ArchiveSnapshot['sensitivity']; compartments: string[];projectIds: string[];firesAt: Date;realtime: boolean}) => Promise<ArchiveReceipt>
export class EngineeringHistoryError extends Error {
 constructor(readonly code: string,readonly status=409) {super(code);this.name='EngineeringHistoryError'}
}
