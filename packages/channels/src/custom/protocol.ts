/**
 * Custom channel bridge protocol (v1) — wire types + limits.
 *
 * A custom channel is driven by an operator-run bridge process. The API is
 * always the server: the bridge publishes state (`PUT /state`), pushes
 * inbound messages (`POST /inbound`) and pulls outbound work from an outbox
 * (`GET /outbox` long-poll + `POST /outbox/ack`). These are the shapes that
 * cross that boundary, shared by the adapter (this package) and the bridge
 * route (`packages/api/src/routes/custom-channel-bridge.ts`). This package is
 * dependency-free, so the zod schemas that validate these shapes at the HTTP
 * boundary live beside the route (`custom-channel-bridge.ts`), typed against
 * the types exported here.
 *
 * Limits: inbound `text` ≤ 64 KB, ≤ 4 media items per message, each inline
 * media item ≤ 25 MB after base64 decoding.
 *
 * See docs/architecture/channels/custom-channel.md → "Bridge protocol (v1)".
 * Component tag: [COMP:channels/custom-adapter].
 */

export const CUSTOM_CHANNEL_PROTOCOL_VERSION = 1

export const BRIDGE_INBOUND_TEXT_MAX_BYTES = 64 * 1024
export const BRIDGE_INBOUND_MEDIA_MAX_ITEMS = 4
export const BRIDGE_INBOUND_MEDIA_MAX_BYTES = 25 * 1024 * 1024

// ── State (PUT /state) ─────────────────────────────────────────

export type BridgeStatus = 'connecting' | 'needs_action' | 'connected' | 'disconnected' | 'error'

export type BridgeAction =
  | { kind: 'qr'; imageDataUrl?: string; url?: string; text?: string; expiresAt?: string }
  | { kind: 'input'; prompt: string; inputKind: 'numeric' | 'text'; requestId: string }
  | { kind: 'confirm_on_device'; message: string }

export type BridgeState = {
  status: BridgeStatus
  /** One human sentence for the Studio card ("Scan the QR with WeChat on your phone"). */
  message?: string
  /** The platform account this bridge is signed in as — displayed, never used for auth. */
  accountLabel?: string
  /** Present only while status = needs_action. */
  action?: BridgeAction
  /** Bridge build / version string for the Studio card. */
  bridgeVersion?: string
  /**
   * What this bridge can actually put on the wire. Additive (v1.1): an older
   * bridge that never reports it is treated as text-only, so `sendFile`
   * refuses honestly instead of the adapter enqueueing documents the bridge
   * would silently drop. Declare `documents: true` ONLY when the bridge's
   * outbox worker performs a real file send for `payload.documents`.
   */
  capabilities?: {
    documents?: boolean
  }
}

// ── Inbound (POST /inbound) ────────────────────────────────────

export type BridgeInboundMediaKind = 'image' | 'document' | 'voice' | 'audio' | 'video'

export type BridgeInboundMedia = {
  kind: BridgeInboundMediaKind
  mime: string
  name: string
  /** Exactly one of dataBase64 / url. url must be fetchable from the API with no auth. */
  dataBase64?: string
  url?: string
  sizeBytes?: number
  durationSec?: number
}

export type BridgeInboundMessage = {
  /** Conversation id on the platform — a DM peer id or a group id. Becomes the session key. */
  peerId: string
  peerName?: string
  /** Author of the message. In a DM this equals peerId unless isSelf. */
  senderId: string
  senderName?: string
  messageId: string
  text: string
  /** ms epoch */
  timestamp: number
  isGroupChat: boolean
  /** The bridge's own account was addressed (group @-mention). Drives requireMention. */
  isMentioned?: boolean
  /** Sent BY the bridge's own account (e.g. from the phone). Archived as outbound; never answered. */
  isSelf?: boolean
  replyToMessageId?: string
  media?: BridgeInboundMedia[]
}

export type BridgeInbound = { message: BridgeInboundMessage }

/** Byte length of a base64 payload after decoding (ignores padding). */
export function base64DecodedLength(b64: string): number {
  const len = b64.length
  if (len === 0) return 0
  let padding = 0
  if (b64.endsWith('==')) padding = 2
  else if (b64.endsWith('=')) padding = 1
  return Math.floor((len * 3) / 4) - padding
}

/**
 * Payload-size check the schema cannot express cheaply: UTF-8 byte length of
 * the text and the DECODED size of each inline media item. Returns the first
 * violation or null. Callers answer 413 on a violation.
 */
export function bridgeInboundOversize(inbound: BridgeInbound): string | null {
  const m = inbound.message
  if (Buffer.byteLength(m.text, 'utf8') > BRIDGE_INBOUND_TEXT_MAX_BYTES) {
    return `text exceeds ${BRIDGE_INBOUND_TEXT_MAX_BYTES} bytes`
  }
  for (const item of m.media ?? []) {
    if (item.dataBase64 && base64DecodedLength(item.dataBase64) > BRIDGE_INBOUND_MEDIA_MAX_BYTES) {
      return `media item "${item.name}" exceeds ${BRIDGE_INBOUND_MEDIA_MAX_BYTES} bytes`
    }
    if (item.sizeBytes != null && item.sizeBytes > BRIDGE_INBOUND_MEDIA_MAX_BYTES) {
      return `media item "${item.name}" exceeds ${BRIDGE_INBOUND_MEDIA_MAX_BYTES} bytes`
    }
  }
  return null
}

// ── Outbox (GET /outbox, POST /outbox/ack) ─────────────────────

export type OutboxDocument = { filename: string; mime: string; dataBase64: string; caption?: string }

export type OutboxMessagePayload = {
  text: string
  format: 'plain' | 'markdown'
  documents?: OutboxDocument[]
  replyToMessageId?: string
}

export type OutboxItem =
  | { id: string; type: 'message'; peerId: string; createdAt: string; payload: OutboxMessagePayload }
  | { id: string; type: 'typing'; peerId: string; createdAt: string; payload: { on: boolean } }
  | { id: string; type: 'input'; peerId: null; createdAt: string; payload: { requestId: string; value: string } }
  | { id: string; type: 'disconnect'; peerId: null; createdAt: string; payload: Record<string, never> }

export type OutboxAckResult = { id: string; ok: boolean; error?: string; providerMessageId?: string }
export type OutboxAck = { results: OutboxAckResult[] }

// ── Hello (GET /hello) ─────────────────────────────────────────

export type BridgeHello = {
  channelId: string
  workspaceId: string
  displayName: string | null
  kind: string | null
  config: { requireMention: boolean; userAccessMode: string }
  protocol: typeof CUSTOM_CHANNEL_PROTOCOL_VERSION
  serverTime: string
}
