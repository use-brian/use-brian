import type {
  ChannelAdapter,
  IncomingFile,
  IncomingMessage,
  OutgoingMessage,
} from '../types.js'
import { chunkText } from '../chunking.js'
import { buildFeishuCard } from './card.js'
import { feishuResourceRef } from './resource-ref.js'
import type {
  FeishuApi,
  FeishuNormalizedMessage,
  FeishuResourceDescriptor,
  FeishuSendOptions,
} from './types.js'

// Feishu text messages allow more, but 4,000 leaves headroom for converted
// markdown/card payloads and keeps status/edit behavior predictable.
export const FEISHU_MAX_MESSAGE_LENGTH = 4000

export type FeishuAdapterConfig = {
  replyInThread?: boolean
  requireMention?: boolean
}

export type FeishuAdapterOptions = {
  api: FeishuApi
  botOpenId?: string
  config?: FeishuAdapterConfig
  /** Route-owned gate lets live DB config decide group addressing. */
  deferMentionGate?: boolean
}

function isNormalizedMessage(value: unknown): value is FeishuNormalizedMessage {
  if (!value || typeof value !== 'object') return false
  const msg = value as Partial<FeishuNormalizedMessage>
  return typeof msg.messageId === 'string'
    && typeof msg.chatId === 'string'
    && (msg.chatType === 'p2p' || msg.chatType === 'group')
    && typeof msg.senderId === 'string'
    && typeof msg.content === 'string'
    && typeof msg.rawContentType === 'string'
    && Array.isArray(msg.resources)
    && Array.isArray(msg.mentions)
    && typeof msg.mentionedBot === 'boolean'
    && typeof msg.createTime === 'number'
}

function mimeForResource(resource: FeishuResourceDescriptor): string {
  switch (resource.type) {
    case 'image':
    case 'sticker':
      return 'image/*'
    case 'audio':
      return 'audio/*'
    case 'video':
      return 'video/*'
    case 'file':
      return 'application/octet-stream'
  }
}

function mediaTypeForResource(
  resource: FeishuResourceDescriptor,
): IncomingMessage['mediaType'] {
  switch (resource.type) {
    case 'image':
    case 'sticker':
      return 'photo'
    case 'audio':
      return 'voice'
    case 'video':
      return 'video'
    case 'file':
      return 'document'
  }
}

const UNICODE_EMOJI_TYPES: Record<string, string> = {
  '👍': 'THUMBSUP',
  '👎': 'THUMBSDOWN',
  '❤️': 'HEART',
  '❤': 'HEART',
  '🔥': 'FIRE',
  '👀': 'EYES',
  '✅': 'DONE',
  '🎉': 'PARTY',
  '🤔': 'THINKING',
  '💡': 'EA',
}

/** Feishu reactions use symbolic emoji types rather than unicode glyphs. */
export function toFeishuEmojiType(value: string): string {
  const trimmed = value.trim()
  return UNICODE_EMOJI_TYPES[trimmed]
    ?? trimmed.replace(/^:|:$/g, '').replace(/[\s-]+/g, '_').toUpperCase()
}

export function createFeishuAdapter(options: FeishuAdapterOptions): ChannelAdapter {
  const config = options.config ?? {}
  const requireMention = config.requireMention ?? true

  function sendOptions(threadTs?: string): FeishuSendOptions | undefined {
    if (!threadTs) return undefined
    return {
      replyTo: threadTs,
      replyInThread: config.replyInThread ?? true,
      resolveMentionsInText: true,
    }
  }

  return {
    type: 'feishu',
    maxMessageLength: FEISHU_MAX_MESSAGE_LENGTH,
    supportsMarkdown: true,
    supportsMessageEdit: true,
    drainDelayMs: 1000,

    parseIncoming(payload: unknown): IncomingMessage | null {
      if (!isNormalizedMessage(payload)) return null
      if (payload.senderIsBot || payload.senderType === 'bot') return null
      if (options.botOpenId && payload.senderId === options.botOpenId) return null

      const isGroup = payload.chatType === 'group'
      if (
        isGroup
        && requireMention
        && !payload.mentionedBot
        && !options.deferMentionGate
      ) return null

      const text = payload.content.trim()
      const files: IncomingFile[] = payload.resources.map((resource) => ({
        url: feishuResourceRef(payload.messageId, resource.fileKey, resource.type),
        mimeType: mimeForResource(resource),
        name: resource.fileName ?? `${resource.type}-${resource.fileKey}`,
      }))
      if (!text && files.length === 0) return null

      const first = payload.resources[0]
      const replyTarget = payload.threadId ?? payload.rootId ?? payload.replyToMessageId
      return {
        userId: payload.senderId,
        senderDisplay: payload.senderName,
        channelId: payload.chatId,
        messageId: payload.messageId,
        text,
        mediaUrl: first
          ? feishuResourceRef(payload.messageId, first.fileKey, first.type)
          : undefined,
        mediaType: first ? mediaTypeForResource(first) : undefined,
        mediaMime: first ? mimeForResource(first) : undefined,
        mediaName: first?.fileName,
        mediaDurationSec: first?.durationMs != null
          ? Math.max(0, Math.round(first.durationMs / 1000))
          : undefined,
        files: files.length > 0 ? files : undefined,
        replyToMessageId: replyTarget,
        isGroupChat: isGroup,
        isMentioned: payload.mentionedBot,
        timestamp: payload.createTime,
        raw: payload,
      }
    },

    deduplicateId(payload: unknown): string | null {
      return isNormalizedMessage(payload) ? payload.messageId : null
    },

    async sendMessage(channelId, response, opts) {
      if (!response.text.trim() && !response.documents?.length && !response.images?.length) {
        return ''
      }
      const apiOpts = sendOptions(opts?.threadTs)
      let lastMessageId = ''

      if (response.actions?.length) {
        const card = buildFeishuCard(response.text, response.actions)
        lastMessageId = (await options.api.send(channelId, { card }, apiOpts)).messageId
      } else {
        const chunks = chunkText(response.text, FEISHU_MAX_MESSAGE_LENGTH)
        for (const chunk of chunks) {
          if (!chunk.trim()) continue
          const input = response.format === 'markdown'
            ? { markdown: chunk }
            : { text: chunk }
          lastMessageId = (await options.api.send(channelId, input, apiOpts)).messageId
        }
      }

      for (const image of response.images ?? []) {
        try {
          lastMessageId = (
            await options.api.send(channelId, { image: { source: image.url } }, apiOpts)
          ).messageId
        } catch (err) {
          console.warn('[feishu] image send failed:', err instanceof Error ? err.message : String(err))
        }
      }

      for (const document of response.documents ?? []) {
        try {
          lastMessageId = (
            await options.api.send(channelId, {
              file: { source: Buffer.from(document.data), fileName: document.filename },
            }, apiOpts)
          ).messageId
        } catch (err) {
          console.warn(
            `[feishu] file upload failed for ${document.filename}:`,
            err instanceof Error ? err.message : String(err),
          )
          lastMessageId = (
            await options.api.send(
              channelId,
              { text: `Could not attach ${document.filename}.` },
              apiOpts,
            )
          ).messageId
        }
      }

      return lastMessageId
    },

    async editMessage(channelId, messageId, response, opts) {
      if (response.actions?.length) {
        await options.api.updateCard(messageId, buildFeishuCard(response.text, response.actions))
        return
      }
      const chunks = chunkText(response.text, FEISHU_MAX_MESSAGE_LENGTH)
        .filter((chunk) => chunk.trim())
      if (chunks.length === 0) return
      await options.api.editMessage(messageId, chunks[0])
      const apiOpts = sendOptions(opts?.threadTs)
      for (const chunk of chunks.slice(1)) {
        const input = response.format === 'markdown'
          ? { markdown: chunk }
          : { text: chunk }
        await options.api.send(channelId, input, apiOpts)
      }
    },

    async sendTypingIndicator() {
      // Feishu has no general bot typing endpoint. Status uses an editable
      // message so users still get visible progress.
    },

    async sendStatus(channelId, status, opts) {
      const result = await options.api.send(channelId, { text: status }, sendOptions(opts?.threadTs))
      return result.messageId
    },

    async clearStatus(_channelId, opts) {
      if (opts?.messageId) await options.api.recallMessage(opts.messageId)
    },

    async reactToMessage(_channelId, messageId, emoji) {
      await options.api.addReaction(messageId, toFeishuEmojiType(emoji))
    },

    async deleteMessage(_channelId, messageId) {
      await options.api.recallMessage(messageId)
    },
  }
}
