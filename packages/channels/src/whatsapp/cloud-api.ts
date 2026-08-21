import { createHmac, timingSafeEqual } from 'node:crypto'
import type { ChannelAdapter, IncomingMessage, OutgoingMessage } from '../types.js'
import { chunkText } from '../chunking.js'
import { markdownToWhatsApp } from './formatter.js'

export const DEFAULT_WHATSAPP_GRAPH_API_VERSION = 'v26.0'

export type WhatsAppCloudApiOptions = {
  accessToken: string
  phoneNumberId: string
  graphApiVersion?: string
  graphApiBaseUrl?: string
  recipientType?: 'individual' | 'group'
}

export type WhatsAppCloudPhoneNumber = {
  id: string
  displayPhoneNumber: string
  verifiedName: string
}

export type WhatsAppCloudMedia = {
  data: Uint8Array
  mimeType: string
}

type CloudMessage = {
  id?: string
  from?: string
  timestamp?: string
  type?: string
  group_id?: string
  context?: { id?: string }
  text?: { body?: string }
  image?: { id?: string; mime_type?: string; caption?: string }
  document?: { id?: string; mime_type?: string; filename?: string; caption?: string }
  audio?: { id?: string; mime_type?: string; voice?: boolean }
  video?: { id?: string; mime_type?: string; filename?: string; caption?: string }
}

type CloudValue = {
  metadata?: { phone_number_id?: string }
  contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>
  messages?: CloudMessage[]
}

export type WhatsAppCloudWebhookPayload = {
  object?: string
  entry?: Array<{ changes?: Array<{ field?: string; value?: CloudValue }> }>
}

function graphBase(options: WhatsAppCloudApiOptions): string {
  const root = (options.graphApiBaseUrl ?? 'https://graph.facebook.com').replace(/\/$/, '')
  const version = options.graphApiVersion ?? DEFAULT_WHATSAPP_GRAPH_API_VERSION
  return `${root}/${version}`
}

async function graphRequest<T>(
  options: WhatsAppCloudApiOptions,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${graphBase(options)}/${path.replace(/^\//, '')}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${options.accessToken}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`WhatsApp Cloud API failed (${response.status}): ${detail || response.statusText}`)
  }
  return await response.json() as T
}

export function verifyWhatsAppCloudSignature(input: {
  appSecret: string
  signature?: string
  body: string
}): boolean {
  const { appSecret, signature, body } = input
  if (!appSecret || !signature?.startsWith('sha256=')) return false
  const expected = Buffer.from(createHmac('sha256', appSecret).update(body).digest('hex'))
  const actual = Buffer.from(signature.slice('sha256='.length))
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export async function validateWhatsAppCloudCredentials(
  options: WhatsAppCloudApiOptions,
): Promise<WhatsAppCloudPhoneNumber> {
  const data = await graphRequest<{
    id?: string
    display_phone_number?: string
    verified_name?: string
  }>(options, `${encodeURIComponent(options.phoneNumberId)}?fields=id,display_phone_number,verified_name`)
  if (!data.id || data.id !== options.phoneNumberId) {
    throw new Error('The access token cannot access that phone number ID')
  }
  return {
    id: data.id,
    displayPhoneNumber: data.display_phone_number ?? data.id,
    verifiedName: data.verified_name ?? 'WhatsApp Business',
  }
}

/** Subscribe the current Meta app to WABA webhook events. Idempotent in Graph. */
export async function subscribeWhatsAppCloudApp(
  options: WhatsAppCloudApiOptions,
  wabaId: string,
): Promise<void> {
  await graphRequest<{ success?: boolean }>(
    options,
    `${encodeURIComponent(wabaId)}/subscribed_apps`,
    { method: 'POST' },
  )
}

function mediaFrom(message: CloudMessage): {
  id?: string
  mime?: string
  name?: string
  type?: IncomingMessage['mediaType']
  caption?: string
} {
  if (message.image) return { id: message.image.id, mime: message.image.mime_type, name: 'image', type: 'photo', caption: message.image.caption }
  if (message.document) return { id: message.document.id, mime: message.document.mime_type, name: message.document.filename, type: 'document', caption: message.document.caption }
  if (message.audio) return { id: message.audio.id, mime: message.audio.mime_type, name: message.audio.voice ? 'voice' : 'audio', type: message.audio.voice ? 'voice' : 'audio' }
  if (message.video) return { id: message.video.id, mime: message.video.mime_type, name: message.video.filename ?? 'video.mp4', type: 'video', caption: message.video.caption }
  return {}
}

/** Normalize every message in a Meta webhook; status-only updates return []. */
export function parseWhatsAppCloudMessages(payload: unknown): IncomingMessage[] {
  const body = payload as WhatsAppCloudWebhookPayload
  if (body?.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) return []
  const incoming: IncomingMessage[] = []
  for (const entry of body.entry) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages') continue
      const value = change.value
      for (const message of value?.messages ?? []) {
        if (!message.id || !message.from) continue
        const media = mediaFrom(message)
        const text = message.text?.body ?? media.caption ?? ''
        const groupId = message.group_id?.trim() || null
        incoming.push({
          userId: message.from,
          channelId: groupId ?? message.from,
          messageId: message.id,
          text,
          ...(media.id ? { mediaUrl: `whatsapp-cloud:${media.id}` } : {}),
          ...(media.type ? { mediaType: media.type } : {}),
          ...(media.mime ? { mediaMime: media.mime } : {}),
          ...(media.name ? { mediaName: media.name } : {}),
          ...(message.context?.id ? { replyToMessageId: message.context.id } : {}),
          isGroupChat: groupId !== null,
          timestamp: Number(message.timestamp ?? 0) || Math.floor(Date.now() / 1000),
          raw: {
            message,
            phoneNumberId: value?.metadata?.phone_number_id,
            groupId,
            senderName: value?.contacts?.find((contact) => contact.wa_id === message.from)?.profile?.name,
          },
        })
      }
    }
  }
  return incoming
}

export function whatsappCloudMediaId(incoming: IncomingMessage): string | null {
  return incoming.mediaUrl?.startsWith('whatsapp-cloud:')
    ? incoming.mediaUrl.slice('whatsapp-cloud:'.length)
    : null
}

export function createWhatsAppCloudApi(options: WhatsAppCloudApiOptions) {
  return {
    async getPhoneNumber(): Promise<WhatsAppCloudPhoneNumber> {
      return validateWhatsAppCloudCredentials(options)
    },

    async subscribeApp(wabaId: string): Promise<void> {
      return subscribeWhatsAppCloudApp(options, wabaId)
    },

    async downloadMedia(mediaId: string, maxBytes = 25 * 1024 * 1024): Promise<WhatsAppCloudMedia> {
      const metadata = await graphRequest<{ url?: string; mime_type?: string; file_size?: number }>(
        options,
        encodeURIComponent(mediaId),
      )
      if (!metadata.url) throw new Error('WhatsApp media response did not contain a download URL')
      if (metadata.file_size && metadata.file_size > maxBytes) {
        throw new Error(`WhatsApp media exceeds the ${maxBytes}-byte download limit`)
      }
      const response = await fetch(metadata.url, {
        headers: { Authorization: `Bearer ${options.accessToken}` },
      })
      if (!response.ok) throw new Error(`WhatsApp media download failed (${response.status})`)
      const data = new Uint8Array(await response.arrayBuffer())
      if (data.byteLength > maxBytes) throw new Error(`WhatsApp media exceeds the ${maxBytes}-byte download limit`)
      return {
        data,
        mimeType: metadata.mime_type ?? response.headers.get('content-type') ?? 'application/octet-stream',
      }
    },
  }
}

export function createWhatsAppCloudAdapter(options: WhatsAppCloudApiOptions): ChannelAdapter {
  async function sendText(to: string, body: string): Promise<string> {
    const recipientType = options.recipientType ?? 'individual'
    const data = await graphRequest<{ messages?: Array<{ id?: string }> }>(
      options,
      `${encodeURIComponent(options.phoneNumberId)}/messages`,
      {
        method: 'POST',
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: recipientType,
          to: recipientType === 'individual' ? to.replace(/^\+/, '') : to,
          type: 'text',
          text: { preview_url: true, body },
        }),
      },
    )
    return data.messages?.[0]?.id ?? ''
  }

  return {
    type: 'whatsapp',
    maxMessageLength: 4096,
    supportsMarkdown: true,
    supportsMessageEdit: false,
    drainDelayMs: 0,

    parseIncoming(payload): IncomingMessage | null {
      return parseWhatsAppCloudMessages(payload)[0] ?? null
    },

    deduplicateId(payload): string | null {
      return parseWhatsAppCloudMessages(payload)[0]?.messageId ?? null
    },

    async sendMessage(channelId: string, response: OutgoingMessage): Promise<string> {
      const text = response.format === 'markdown' ? markdownToWhatsApp(response.text) : response.text
      let lastMessageId = ''
      if (text) {
        for (const chunk of chunkText(text, 4096)) lastMessageId = await sendText(channelId, chunk)
      }
      for (const image of response.images ?? []) {
        lastMessageId = await sendText(channelId, `${image.caption ? `${image.caption}\n` : ''}${image.url}`)
      }
      return lastMessageId
    },

    async editMessage(): Promise<void> {
      // The Cloud API does not support editing sent messages.
    },

    async sendTypingIndicator(channelId: string): Promise<void> {
      // Marking the triggering message read is handled by the webhook route.
      void channelId
    },

    async sendStatus(channelId: string, status: string): Promise<string> {
      return sendText(channelId, status)
    },
  }
}
