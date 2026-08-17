import { randomUUID, timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import type { ChatArchiveLiveMedia } from '../chat-archive/live-media.js'
import { archiveMediaRef, mediaByteLimit } from '../chat-archive/live-media.js'
import { resolveChatArchiveInstanceId } from '../chat-archive/live-writer.js'
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
  /** Stages inbound attachment bytes into the archive. */
  archiveMedia?: ChatArchiveLiveMedia
  connectorSecret: string
  integrationStore: ChannelIntegrationStore
  ingestor: WhatsappIngestor
  bot: WhatsappBot
  filesResolver?: FilesClientResolver
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

  /**
   * Read back media the connector streamed straight to workspace storage.
   *
   * Size is checked with `statBlob` first, which does not download: the archive
   * accepts video up to 512MB and `storeBuffer` takes a Buffer, so reading
   * before looking would let one oversized attachment decide the process's
   * memory ceiling. WhatsApp caps sent video far below this in practice, so the
   * skip is a guard rather than a routine path — but it is the difference
   * between declining an attachment and losing the API.
   *
   * Returns null when the object is missing or too large; the caller records
   * the media as unavailable and the message itself is archived regardless.
   */
  async function readStreamedMedia(
    workspaceId: string,
    ref: { gcsKey: string; storageUri?: string },
    kind: 'image' | 'video' | 'voice' | 'file',
  ): Promise<Buffer | null> {
    if (!opts.filesResolver) return null
    // Prefer the URI the connector echoed back with the bytes: it names the
    // exact bucket they were PUT to, where recomputing the workspace default
    // could resolve elsewhere. `forUri` hands back the client itself;
    // `forWorkspace` wraps it.
    const client = ref.storageUri
      ? await opts.filesResolver.forUri(workspaceId, ref.storageUri)
      : (await opts.filesResolver.forWorkspace(workspaceId)).gcs
    const limit = mediaByteLimit(kind)
    const stat = await client.statBlob(ref.gcsKey)
    if (stat && stat.sizeBytes > limit) {
      console.warn(
        `[whatsapp] streamed ${kind} is ${stat.sizeBytes} bytes, over the ${limit} archive limit — not archived`,
      )
      return null
    }
    const blob = await client.readBlob(ref.gcsKey)
    return blob?.bytes ?? null
  }

  /**
   * A name for the archived attachment.
   *
   * Baileys reports no filename for video or audio messages, so a streamed
   * video would otherwise be archived as `''` — and an attachment with neither
   * caption nor filename gets no segment 0 at all, leaving it findable only
   * once extraction produces frame text. Synthesizing from the provider message
   * id keeps it identifiable in the meantime.
   */
  function archiveFilename(
    input: { mediaFileName?: string; mediaRef?: { fileName?: string }; messageId: string },
    kind: string,
    mime: string,
  ): string {
    const given = input.mediaFileName ?? input.mediaRef?.fileName
    if (given && given.trim()) return given.trim()
    const subtype = mime.split('/')[1]?.split(';')[0]?.trim()
    const extension = subtype && /^[a-z0-9]{1,8}$/i.test(subtype) ? `.${subtype}` : ''
    return `${kind}-${input.messageId}${extension}`
  }

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

    // The connector uploads bytes here through a pre-signed URL, so they never
    // pass through this process. The archive's contract is single-shot —
    // metadata and bytes together, signed with a secret the connector must
    // never hold — which for a while meant streamed media was simply not
    // archived: a video landed as a message row with `availability: 'missing'`,
    // no asset and no segments.
    //
    // Resolved by the platform reading the object back at /inbound and
    // forwarding it under its own signature, rather than by issuing the
    // connector an upload URL into the store. The secret stays here, and the
    // upload path below is unchanged.

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
    // Stage attachment bytes into the archive.
    //
    // Two ways bytes arrive. Small media with a live-turn consumer is inlined as
    // base64 and is simply in hand. Everything else — video and audio files
    // always, anything over the connector's 10MB inline cap — is streamed
    // straight to workspace storage, and only a reference reaches us.
    //
    // The streamed half used to be dropped: the archive's contract is
    // single-shot (metadata and bytes together, signed with a secret the
    // connector must never hold), so a reference had nothing to stage and video
    // was archived as a message row with `availability: 'missing'`, no asset and
    // no segments. The platform can simply read the object back — the connector
    // awaits its PUT before relaying, so the bytes are durably written by the
    // time we run — and forward them under its own signature.
    //
    // This must happen BEFORE the hosted-intake handoff below: that returns from
    // the handler, and anything staged after it never runs.
    if (opts.archiveMedia && (input.mediaBase64 || input.mediaRef)) {
      try {
        const integration = await opts.integrationStore.getByChannelForWebhook(input.channelId, 'whatsapp')
        const channel = await (opts.getChannel ?? getChannelForWebhook)(input.channelId)
        const ownerUserId = channel
          ? await (opts.getWorkspaceOwnerUserId ?? resolveWorkspaceOwnerUserId)(channel.workspaceId)
          : null
        if (channel && ownerUserId) {
          const mime = input.mediaMimeType ?? input.mediaRef?.mimeType ?? 'application/octet-stream'
          const kind = mime.startsWith('image/') ? 'image'
            : mime.startsWith('video/') ? 'video'
              : mime.startsWith('audio/') ? 'voice' : 'file'
          // `connector_instance_id` on the integration row is frequently null;
          // the append path mints the archive instance lazily instead. Reuse
          // that same memoized resolver so bytes and message row share one id
          // (assets key on `(instance_id, provider_message_id)`).
          const instanceId = integration?.connectorInstanceId
            ?? await resolveChatArchiveInstanceId({
              source: 'whatsapp',
              ownerUserId,
              workspaceId: channel.workspaceId,
              assistantId: '',
              assistantName: '',
              conversationId: input.chatJid ?? input.channelId,
            })
          if (!instanceId) throw new Error('whatsapp archive instance could not be resolved')
          const bytes = input.mediaBase64
            ? Buffer.from(input.mediaBase64, 'base64')
            : await readStreamedMedia(channel.workspaceId, input.mediaRef!, kind)
          if (!bytes) throw new Error('streamed media could not be read back for the archive')
          const asset = await opts.archiveMedia.storeBuffer({
            workspaceId: channel.workspaceId,
            instanceId,
            ownerUserId,
            source: 'whatsapp',
            providerMessageId: input.messageId,
            kind,
            filename: archiveFilename(input, kind, mime),
            mime,
            bytes,
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

    // Hosted media intake is mounted as the later closed router. Let it own
    // streamed references; otherwise this BYON router ACKs first and the bytes
    // are uploaded successfully but never become a recording/document artifact.
    // Staging above has already run, so the archive keeps its copy either way.
    if (input.mediaRef && !input.mediaRef.assetId && opts.passUnknownToFallback) {
      next()
      return
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
