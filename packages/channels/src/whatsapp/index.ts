// ⚠️ STALE — The WhatsApp channel is deprecated and unmaintained as of 2026-06-02.
// It is no longer surfaced in the web UI and must not be extended. It is kept only
// so any pre-existing integration keeps functioning. See docs/architecture/channels/whatsapp.md (Status: Stale).
export { createWhatsAppAdapter, type WhatsAppAdapterOptions, type WhatsAppIncomingPayload } from './adapter.js'

/**
 * Lifecycle marker for the WhatsApp channel, mirroring the
 * `SkillLifecycleState` convention in `packages/core/src/skills/loader.ts`.
 * The channel is deprecated and kept functional only for pre-existing
 * integrations — see docs/architecture/channels/whatsapp.md (Status: Stale).
 */
export const WHATSAPP_CHANNEL_LIFECYCLE = 'stale' as const
