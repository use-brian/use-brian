// The WhatsApp channel is ACTIVE as a read-only group ingest source
// (Bring-Your-Own-Number): a workspace links its own number and the assistant
// silently reads owner-enabled team groups into the brain, never sending.
// The legacy RESPONDER path stays dormant (stale since 2026-06-02) — kept
// functional only for pre-existing integrations, never extended. See
// docs/architecture/channels/whatsapp.md (§Read-only group ingest).
export { createWhatsAppAdapter, type WhatsAppAdapterOptions, type WhatsAppIncomingPayload } from './adapter.js'
export {
  createWhatsAppCloudAdapter,
  createWhatsAppCloudApi,
  parseWhatsAppCloudMessages,
  subscribeWhatsAppCloudApp,
  whatsappCloudMediaId,
  validateWhatsAppCloudCredentials,
  verifyWhatsAppCloudSignature,
  DEFAULT_WHATSAPP_GRAPH_API_VERSION,
  type WhatsAppCloudApiOptions,
  type WhatsAppCloudMedia,
  type WhatsAppCloudPhoneNumber,
  type WhatsAppCloudWebhookPayload,
} from './cloud-api.js'

/**
 * Lifecycle marker for the WhatsApp channel, mirroring the
 * `SkillLifecycleState` convention in `packages/core/src/skills/loader.ts`.
 * `'active'` as of the Bring-Your-Own-Number ingest reactivation: the channel
 * is live as a read-only ingest source. The legacy responder remains dormant
 * (disabled for BYON channels; untouched for pre-existing integrations) — see
 * docs/architecture/channels/whatsapp.md and
 * docs/architecture/channels/whatsapp.md.
 */
export const WHATSAPP_CHANNEL_LIFECYCLE = 'active' as const
