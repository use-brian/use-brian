/**
 * Use Brian custom-channel bridge protocol (v1) wire types.
 *
 * Copied verbatim from docs/architecture/channels/custom-channel.md so the
 * bridge stays standalone (it imports nothing from use-brian packages and can
 * run on a box that only has its own package installed). If the protocol
 * changes, update the doc, the open `packages/channels/src/custom/protocol.ts`,
 * and this file together.
 */

type BridgeStatus = 'connecting' | 'needs_action' | 'connected' | 'disconnected' | 'error'

type BridgeAction =
  | { kind: 'qr'; imageDataUrl?: string; url?: string; text?: string; expiresAt?: string }
  | { kind: 'input'; prompt: string; inputKind: 'numeric' | 'text'; requestId: string }
  | { kind: 'confirm_on_device'; message: string }

export type BridgeState = {
  status: BridgeStatus
  /** One human sentence for the Studio card. */
  message?: string
  /** The platform account this bridge is signed in as, once known. Displayed, never used for auth. */
  accountLabel?: string
  /** Present only while status = needs_action. */
  action?: BridgeAction
  /** Bridge build / version string for the Studio card. */
  bridgeVersion?: string
}

export type BridgeMediaKind = 'image' | 'document' | 'voice' | 'audio' | 'video'

export type BridgeInboundMedia = {
  kind: BridgeMediaKind
  mime: string
  name: string
  /** Exactly one of dataBase64 / url. */
  dataBase64?: string
  url?: string
  sizeBytes?: number
  durationSec?: number
}

export type BridgeInboundMessage = {
  /** Conversation id on the platform (DM peer id or group id). Becomes the session key. */
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
  /** The bridge's own account was addressed (group @-mention). */
  isMentioned?: boolean
  /** Sent BY the bridge's own account (e.g. from the phone). Archived as outbound; never answered. */
  isSelf?: boolean
  replyToMessageId?: string
  media?: BridgeInboundMedia[]
}

export type BridgeInbound = { message: BridgeInboundMessage }

type OutboxDocument = { filename: string; mime: string; dataBase64: string; caption?: string }

export type OutboxItem =
  | {
      id: string
      type: 'message'
      peerId: string
      createdAt: string
      payload: {
        text: string
        format: 'plain' | 'markdown'
        documents?: OutboxDocument[]
        replyToMessageId?: string
      }
    }
  | { id: string; type: 'typing'; peerId: string; createdAt: string; payload: { on: boolean } }
  | { id: string; type: 'input'; peerId: null; createdAt: string; payload: { requestId: string; value: string } }
  | { id: string; type: 'disconnect'; peerId: null; createdAt: string; payload: Record<string, never> }

export type OutboxAckResult = { id: string; ok: boolean; error?: string; providerMessageId?: string }

export type HelloResponse = {
  channelId: string
  workspaceId: string
  displayName: string
  kind: string | null
  config: { requireMention?: boolean; userAccessMode?: string }
  protocol: number
  serverTime: string
}
