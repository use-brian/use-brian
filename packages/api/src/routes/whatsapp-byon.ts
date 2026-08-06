import { randomUUID, timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import type { ChannelIntegrationStore } from '../db/channel-integrations.js'
import type { WhatsappIngestor } from '../ingest/whatsapp-ingest.js'
import type { WhatsappBot, WhatsappBotInput } from './whatsapp-bot-handler.js'
import { buildWhatsappListenerHandler } from './whatsapp-listener-handler.js'
import { runHandlers, selectHandlers } from './whatsapp-dispatcher.js'
import { getChannelForWebhook } from '../db/channels-store.js'
import type { FilesClientResolver } from '../files/files-api.js'
import { buildStorageKey, buildStorageUri } from '../files/gcs-client.js'
import { query } from '../db/client.js'
import type { ChatArchiveMediaService } from '../chat-archive/media-service.js'
import { archiveMediaRef } from '../chat-archive/media-service.js'
import { signedChatArchiveMediaUploadUrl } from '../chat-archive/media-routes.js'
import type { IncomingMessage } from '@use-brian/channels'

const inboundSchema = z.object({
  channelId: z.string().min(1),
  chatJid: z.string().min(1),
  senderJid: z.string().min(1),
  senderPnJid: z.string().optional(),
  senderName: z.string().optional(),
  messageId: z.string().min(1),
  text: z.string().default(''),
  timestamp: z.number(),
  isGroup: z.boolean(),
  mediaBase64: z.string().optional(),
  mediaMimeType: z.string().optional(),
  mediaFileName: z.string().optional(),
  mediaRef: z.object({
    assetId: z.string().uuid().optional(),
    gcsKey: z.string(),
    storageUri: z.string().optional(),
    mimeType: z.string(),
    fileName: z.string().optional(),
    sizeBytes: z.number().optional(),
  }).optional(),
}).passthrough()

function secretMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || !expected) return false
  const actual = Buffer.from(provided)
  const wanted = Buffer.from(expected)
  return actual.length === wanted.length && timingSafeEqual(actual, wanted)
}

async function resolveWorkspaceOwnerUserId(workspaceId: string): Promise<string | null> {
  const owner = await query<{ ownerUserId: string }>(
    `SELECT owner_user_id AS "ownerUserId" FROM workspaces WHERE id = $1`,
    [workspaceId],
  )
  return owner.rows[0]?.ownerUserId ?? null
}

export type WhatsappByonRoutesOptions = {
  connectorSecret: string
  integrationStore: ChannelIntegrationStore
  ingestor: WhatsappIngestor
  bot: WhatsappBot
  filesResolver?: FilesClientResolver
  archiveMedia?: ChatArchiveMediaService
  archiveMediaHmacSecret?: string
  archiveMediaBaseUrl?: string
  archiveIncoming?: (input: {
    workspaceId: string
    ownerUserId: string
    connectorInstanceId?: string | null
    message: IncomingMessage
  }) => Promise<void>
  getChannel?: typeof getChannelForWebhook
  getWorkspaceOwnerUserId?: (workspaceId: string) => Promise<string | null>
  /** Let a later closed router handle the shared official number. */
  passUnknownToFallback?: boolean
}

/**
 * Internal BYON relay routes. Unknown channels call `next()` so a hosted
 * deployment can mount its closed official-number router at the same prefix.
 */
export function whatsappByonRoutes(opts: WhatsappByonRoutesOptions): Router {
  const router = Router()

  router.post('/media-upload-url', async (req, res, next) => {
    if (!secretMatches(req.headers['x-connector-secret'], opts.connectorSecret)) {
      res.status(401).end()
      return
    }
    const parsed = z.object({
      channelId: z.string().min(1),
      providerMessageId: z.string().min(1).optional(),
      kind: z.enum(['image', 'video', 'voice', 'file']).optional(),
      mime: z.string().min(1),
      fileName: z.string().nullable().optional(),
      sizeBytes: z.number().int().nonnegative().optional(),
    }).safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'channelId and mime required' })
      return
    }
    if (!opts.filesResolver) {
      if (opts.passUnknownToFallback) next()
      else res.status(503).json({ error: 'media ingest not configured' })
      return
    }
    const channel = await (opts.getChannel ?? getChannelForWebhook)(parsed.data.channelId)
    if (!channel) {
      if (opts.passUnknownToFallback) next()
      else res.status(404).json({ error: 'channel not resolvable' })
      return
    }

    if (
      opts.archiveMedia
      && opts.archiveMediaHmacSecret
      && opts.archiveMediaBaseUrl
      && parsed.data.providerMessageId
      && parsed.data.kind
    ) {
      const integration = await opts.integrationStore.getByChannelForWebhook(parsed.data.channelId, 'whatsapp')
      const ownerUserId = await (opts.getWorkspaceOwnerUserId ?? resolveWorkspaceOwnerUserId)(channel.workspaceId)
      if (ownerUserId) {
        try {
          const instanceId = await opts.archiveMedia.resolveBinding({
            workspaceId: channel.workspaceId,
            ownerUserId,
            source: 'whatsapp',
            instanceId: integration?.connectorInstanceId,
          })
          const initialized = await opts.archiveMedia.init({
            workspaceId: channel.workspaceId,
            instanceId,
            ownerUserId,
            source: 'whatsapp',
            providerMessageId: parsed.data.providerMessageId,
            kind: parsed.data.kind,
            filename: parsed.data.fileName ?? '',
            mime: parsed.data.mime,
            sizeBytes: parsed.data.sizeBytes ?? 0,
          })
          res.json({
            assetId: initialized.asset.id,
            alreadyStored: initialized.alreadyStored,
            gcsKey: initialized.asset.storageKey,
            storageUri: initialized.asset.storageUri,
            sizeBytes: initialized.asset.sizeBytes,
            uploadUrl: signedChatArchiveMediaUploadUrl({
              secret: opts.archiveMediaHmacSecret,
              baseUrl: opts.archiveMediaBaseUrl,
              assetId: initialized.asset.id,
            }),
          })
          return
        } catch (err) {
          console.error('[whatsapp] archive media init failed; using generic storage:', err)
        }
      }
    }

    const fileId = `channel-media/${randomUUID()}`
    const key = buildStorageKey(channel.workspaceId, fileId)
    const resolved = await opts.filesResolver.forWorkspace(channel.workspaceId)
    const uploadUrl = await resolved.gcs.signedWriteUrl(key, { contentType: parsed.data.mime, ttlSec: 3600 })
    res.json({
      gcsKey: key,
      uploadUrl,
      storageUri: buildStorageUri(resolved.bucket, channel.workspaceId, fileId, resolved.uriScheme),
    })
  })

  router.post('/disconnected', async (req, res, next) => {
    if (!secretMatches(req.headers['x-connector-secret'], opts.connectorSecret)) {
      res.status(401).end()
      return
    }
    const channelId = z.string().min(1).safeParse(req.body?.channelId)
    if (!channelId.success) {
      res.status(400).json({ error: 'channelId required' })
      return
    }
    const integration = await opts.integrationStore.getByChannelForWebhook(channelId.data, 'whatsapp')
    if (!integration) {
      if (opts.passUnknownToFallback) next()
      else res.json({ ok: true })
      return
    }
    await opts.integrationStore.setStatusByChannelSystem(channelId.data, 'whatsapp', 'revoked')
    res.json({ ok: true })
  })

  router.post('/inbound', async (req, res, next) => {
    if (!secretMatches(req.headers['x-connector-secret'], opts.connectorSecret)) {
      res.status(401).end()
      return
    }
    const parsed = inboundSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid inbound payload' })
      return
    }
    const input = parsed.data as typeof parsed.data & WhatsappBotInput
    const inboundMime = input.mediaMimeType ?? input.mediaRef?.mimeType
    if (inboundMime) {
      const inboundKind = inboundMime.startsWith('image/') ? 'image'
        : inboundMime.startsWith('video/') ? 'video'
          : inboundMime.startsWith('audio/') ? 'voice' : 'file'
      input.archiveMediaType = inboundKind === 'image' ? 'photo'
        : inboundKind === 'video' ? 'video' : inboundKind === 'voice' ? 'voice' : 'document'
      input.archiveMediaMime = inboundMime
      input.archiveMediaName = input.mediaFileName ?? input.mediaRef?.fileName ?? ''
      input.archiveMediaSizeBytes = input.mediaRef?.sizeBytes ?? 0
      input.archiveMediaAvailability = input.mediaBase64 || input.mediaRef ? 'missing' : 'failed'
    }
    // Hosted media intake is mounted as the later closed router. Let it own
    // streamed references; otherwise this BYON router ACKs first and the bytes
    // are uploaded successfully but never become a recording/document artifact.
    if (input.mediaRef && !input.mediaRef.assetId && opts.passUnknownToFallback) {
      next()
      return
    }

    if (opts.archiveMedia && (input.mediaBase64 || input.mediaRef?.assetId)) {
      try {
        const integration = await opts.integrationStore.getByChannelForWebhook(input.channelId, 'whatsapp')
        const channel = await (opts.getChannel ?? getChannelForWebhook)(input.channelId)
        const ownerUserId = channel
          ? await (opts.getWorkspaceOwnerUserId ?? resolveWorkspaceOwnerUserId)(channel.workspaceId)
          : null
        if (channel && ownerUserId) {
          const instanceId = await opts.archiveMedia.resolveBinding({
            workspaceId: channel.workspaceId,
            ownerUserId,
            source: 'whatsapp',
            instanceId: integration?.connectorInstanceId,
          })
          const mime = input.mediaMimeType ?? input.mediaRef?.mimeType ?? 'application/octet-stream'
          const kind = mime.startsWith('image/') ? 'image'
            : mime.startsWith('video/') ? 'video'
              : mime.startsWith('audio/') ? 'voice' : 'file'
          const asset = input.mediaRef?.assetId
            ? await opts.archiveMedia.complete(input.mediaRef.assetId)
            : await opts.archiveMedia.storeBuffer({
              workspaceId: channel.workspaceId,
              instanceId,
              ownerUserId,
              source: 'whatsapp',
              providerMessageId: input.messageId,
              kind,
              filename: input.mediaFileName ?? '',
              mime,
              sizeBytes: 0,
              bytes: Buffer.from(input.mediaBase64!, 'base64'),
            })
          const ref = archiveMediaRef(asset)
          input.archiveMediaRef = {
            assetId: ref.asset_id!, sha256: ref.sha256!, filename: ref.filename,
            mime: ref.mime, sizeBytes: ref.size_bytes,
          }
          input.archiveMediaType = kind === 'image' ? 'photo'
            : kind === 'video' ? 'video' : kind === 'voice' ? 'voice' : 'document'
          input.archiveMediaMime = ref.mime
          input.archiveMediaName = ref.filename
          input.archiveMediaSizeBytes = ref.size_bytes
        }
      } catch (err) {
        input.archiveMediaAvailability = 'failed'
        console.error('[whatsapp] archive media completion failed:', err)
      }
    }

    if (!input.text.trim() && !input.mediaBase64 && !input.mediaRef) {
      res.json({ ok: true })
      return
    }

    const [listenerActive, bot] = await Promise.all([
      opts.ingestor.isIngestChannel(input.channelId),
      opts.bot.resolveHandler(input),
    ])
    if (!listenerActive && !bot) {
      if (opts.passUnknownToFallback) next()
      else res.json({ ok: true })
      return
    }

    if (opts.archiveIncoming) {
      try {
        const [channel, integration] = await Promise.all([
          (opts.getChannel ?? getChannelForWebhook)(input.channelId),
          opts.integrationStore.getByChannelForWebhook(input.channelId, 'whatsapp'),
        ])
        const ownerUserId = channel
          ? await (opts.getWorkspaceOwnerUserId ?? resolveWorkspaceOwnerUserId)(channel.workspaceId)
          : null
        if (channel && ownerUserId) {
          await opts.archiveIncoming({
            workspaceId: channel.workspaceId,
            ownerUserId,
            connectorInstanceId: integration?.connectorInstanceId,
            message: {
              userId: input.senderPnJid ?? input.senderJid,
              channelId: input.chatJid,
              messageId: input.messageId,
              text: /^<media:[^>]+>$/.test(input.text.trim()) ? '' : input.text,
              mediaType: input.archiveMediaType,
              mediaMime: input.archiveMediaMime,
              mediaName: input.archiveMediaName,
              mediaSizeBytes: input.archiveMediaSizeBytes,
              archiveMediaRef: input.archiveMediaRef,
              archiveMediaAvailability: input.archiveMediaAvailability,
              isGroupChat: input.isGroup,
              timestamp: input.timestamp,
              raw: null,
            },
          })
          input.archiveInboundPersisted = true
        }
      } catch (err) {
        console.error('[whatsapp] inbound archive enqueue failed:', err)
      }
    }

    res.json({ ok: true })
    const listener = buildWhatsappListenerHandler(opts.ingestor, input)
    void runHandlers(selectHandlers(
      { listener: listenerActive, bot: bot !== null },
      { listener, bot },
    ))
  })

  return router
}
