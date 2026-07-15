/**
 * Email canonical source adapter — public surface (assistant inboxes,
 * docs/architecture/integrations/agentmail.md → "Ingest source").
 *
 * Pure TypeScript — no vendor API calls, no signature verification, no DB
 * (per packages/core/CLAUDE.md). Webhook receiving + the sender gate live
 * downstream in the platform's agentmail route; the producer feeding this
 * adapter is `packages/api-platform/src/ingest/email-webhook-ingest.ts`.
 *
 * [COMP:brain/source-adapters/email]
 */

export { normalizeEmailMessage, emailEpisodeText } from './normalize.js'
export type {
  EmailAttachmentInput,
  EmailIngestContext,
  EmailMessageInput,
} from './types.js'
export { emailFilterImplementations } from './filters.js'
