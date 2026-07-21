import type { ChannelAdapter, IncomingFile, IncomingMessage, OutgoingMessage } from '../types.js'
import { chunkText } from '../chunking.js'
import { createMsTeamsApi } from './api.js'
import { markdownToTeams } from './markdown.js'

// Bot Framework messages are ~28KB; chunk well under with markdown headroom.
const MSTEAMS_MAX_MESSAGE_LENGTH = 17000

// ── Bot Framework Activity (inbound subset) ────────────────────

type TeamsAccount = { id?: string; name?: string; aadObjectId?: string }

type TeamsAttachment = {
  contentType?: string
  contentUrl?: string
  name?: string
  content?: { downloadUrl?: string; fileType?: string; uniqueId?: string }
}

type TeamsMention = {
  type?: string
  mentioned?: { id?: string; name?: string }
  text?: string
}

type TeamsActivity = {
  type?: string
  id?: string
  timestamp?: string
  serviceUrl?: string
  text?: string
  from?: TeamsAccount
  recipient?: TeamsAccount
  conversation?: { id?: string; conversationType?: string; tenantId?: string; isGroup?: boolean }
  entities?: TeamsMention[]
  attachments?: TeamsAttachment[]
  replyToId?: string
}

// ── Config ─────────────────────────────────────────────────────

// Only the fields the adapter itself consumes. Access control
// (`userAccessMode` / allow / block lists) is enforced in the webhook route,
// not here — so those config keys are intentionally absent (the route passes
// the wider `ChannelIntegrationConfig`, whose extra keys are ignored).
export type MsTeamsAdapterConfig = {
  replyInThread?: boolean
  ackReaction?: string
  requireMention?: boolean
}

export type MsTeamsAdapterOptions = {
  appId: string
  appPassword: string
  tenantId: string
  /**
   * Bot Connector base URL for THIS conversation, from the inbound Activity's
   * `serviceUrl` (interactive) or `channel_integrations.connection_metadata`
   * (proactive). Omitted for a parse-only adapter; any send then throws.
   */
  serviceUrl?: string
  /** The bot's connector id (`28:<appId>`) — mention-detection fallback. */
  botId?: string
  config?: MsTeamsAdapterConfig
  onMessage?: (msg: IncomingMessage) => void
  fetchImpl?: typeof fetch
  loginBaseUrl?: string
}

// A loose Teams fileType → mime hint. The ingest/media pipeline sniffs bytes
// anyway; this is only a best-effort label for the download.
function mimeFromFileType(fileType?: string): string {
  switch ((fileType ?? '').toLowerCase()) {
    case 'png': return 'image/png'
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'gif': return 'image/gif'
    case 'pdf': return 'application/pdf'
    case 'txt': return 'text/plain'
    case 'md': return 'text/markdown'
    case 'mp3': return 'audio/mpeg'
    case 'wav': return 'audio/wav'
    case 'm4a': return 'audio/mp4'
    case 'mp4': return 'video/mp4'
    default: return 'application/octet-stream'
  }
}

export function createMsTeamsAdapter(options: MsTeamsAdapterOptions): ChannelAdapter & {
  handleActivity(payload: unknown): void
} {
  const api = createMsTeamsApi({
    appId: options.appId,
    appPassword: options.appPassword,
    tenantId: options.tenantId,
    serviceUrl: options.serviceUrl,
    fetchImpl: options.fetchImpl,
    loginBaseUrl: options.loginBaseUrl,
  })
  const config = options.config ?? {}
  const requireMention = config.requireMention ?? true

  /** Strip Teams `<at>Name</at>` mention tags from text. */
  function stripMentions(text: string): string {
    return text.replace(/<at>.*?<\/at>/gi, '').replace(/\s{2,}/g, ' ').trim()
  }

  return {
    type: 'msteams',
    maxMessageLength: MSTEAMS_MAX_MESSAGE_LENGTH,
    supportsMarkdown: true,
    supportsMessageEdit: true,
    drainDelayMs: 2000,

    parseIncoming(webhookPayload: unknown): IncomingMessage | null {
      const activity = webhookPayload as TeamsActivity
      if (!activity || activity.type !== 'message') return null

      const fromId = activity.from?.id
      const conversationId = activity.conversation?.id
      if (!fromId || !conversationId) return null

      // Loop protection: never answer our own outbound activity.
      const botId = options.botId ?? activity.recipient?.id
      if (botId && fromId === botId) return null

      // 'personal' = 1:1 DM (always respond); 'groupChat' / 'channel' = group
      // surfaces that respect requireMention. Fall back to conversation.isGroup.
      const convType = activity.conversation?.conversationType
      const isGroupChat = convType ? convType !== 'personal' : !!activity.conversation?.isGroup

      // Mention: a Teams @mention arrives as an entity whose `mentioned.id`
      // matches the bot (== recipient.id on inbound).
      const mentioned = (activity.entities ?? []).some(
        (e) => e?.type === 'mention' && !!botId && e.mentioned?.id === botId,
      )

      // File attachments: Teams personal/group uploads carry a
      // `file.download.info` attachment with a pre-authorized `downloadUrl`
      // (no extra token needed to fetch it).
      const files: IncomingFile[] = (activity.attachments ?? [])
        .filter((a) => a.contentType === 'application/vnd.microsoft.teams.file.download.info' && a.content?.downloadUrl)
        .map((a) => ({
          url: a.content!.downloadUrl!,
          mimeType: mimeFromFileType(a.content?.fileType),
          name: a.name ?? 'file',
        }))

      const text = stripMentions(activity.text ?? '')
      const hasText = !!text.trim()
      if (!hasText && files.length === 0) return null

      // In group surfaces, gate on the mention requirement (DMs always answer).
      if (isGroupChat && requireMention && !mentioned) return null

      return {
        userId: fromId,
        channelId: conversationId,
        messageId: activity.id,
        text,
        files: files.length ? files : undefined,
        isGroupChat,
        isMentioned: mentioned,
        timestamp: activity.timestamp ? Date.parse(activity.timestamp) || Date.now() : Date.now(),
        replyToMessageId: activity.replyToId,
        raw: webhookPayload,
      }
    },

    deduplicateId(webhookPayload: unknown): string | null {
      return (webhookPayload as TeamsActivity)?.id ?? null
    },

    handleActivity(payload: unknown): void {
      const msg = this.parseIncoming(payload)
      if (msg && options.onMessage) options.onMessage(msg)
    },

    async sendMessage(channelId: string, response: OutgoingMessage): Promise<string> {
      if (!response.text.trim() && !response.documents?.length) return ''
      const text = response.format === 'markdown' ? markdownToTeams(response.text) : response.text
      const chunks = chunkText(text, MSTEAMS_MAX_MESSAGE_LENGTH)
      let lastId = ''
      for (const chunk of chunks) {
        if (!chunk.trim()) continue
        const { id } = await api.sendActivity(channelId, {
          type: 'message',
          text: chunk,
          textFormat: 'markdown',
        })
        lastId = id ?? lastId
      }

      // Outbound files on Teams need the file-consent round trip (deferred —
      // see msteams.md § "Outbound documents"). Mirror Slack's per-document
      // degradation contract: the text already landed, so a document we can't
      // deliver posts a short pointer instead of failing the send.
      if (response.documents?.length) {
        for (const doc of response.documents) {
          await api
            .sendActivity(channelId, {
              type: 'message',
              text: `Could not attach ${doc.filename} here - open it in the web app.`,
              textFormat: 'plain',
            })
            .catch(() => {})
        }
      }

      return lastId
    },

    async editMessage(channelId: string, messageId: string, response: OutgoingMessage): Promise<void> {
      const text = (response.format === 'markdown' ? markdownToTeams(response.text) : response.text).slice(
        0,
        MSTEAMS_MAX_MESSAGE_LENGTH,
      )
      try {
        await api.updateActivity(channelId, messageId, { type: 'message', text, textFormat: 'markdown' })
      } catch {
        // Edit failed (activity too old / not found) — send as a new message.
        await api.sendActivity(channelId, { type: 'message', text, textFormat: 'markdown' }).catch(() => {})
      }
    },

    async sendTypingIndicator(channelId: string): Promise<void> {
      await api.sendTyping(channelId).catch(() => {})
    },

    async sendStatus(channelId: string, status: string): Promise<string> {
      // Teams has no native "thinking" indicator (unlike Slack's
      // assistant.threads.setStatus). Post the status as a real message and
      // return its id so the caller edits it in place into the final reply —
      // the Telegram / Discord one-notification-per-turn pattern. Fire a typing
      // activity alongside for the interim animation.
      await api.sendTyping(channelId).catch(() => {})
      const { id } = await api.sendActivity(channelId, { type: 'message', text: status, textFormat: 'plain' })
      return id ?? ''
    },
  }
}
