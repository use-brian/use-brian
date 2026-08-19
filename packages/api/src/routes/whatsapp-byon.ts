import { randomUUID, timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import type { ChatArchiveLiveMedia } from '../chat-archive/live-media.js'
import { archiveMediaRef, mediaByteLimit } from '../chat-archive/live-media.js'
import type { StagedArchiveMedia } from '../chat-archive/live-media.js'
import { resolveChatArchiveInstanceId, appendOutboundChatArchive } from '../chat-archive/live-writer.js'
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
  // The owner sent this from their own phone (Baileys key.fromMe).
  fromMe: z.boolean().optional(),
  mediaBase64: z.string().optional(),
  mediaMimeType: z.string().optional(),
  mediaFileName: z.string().optional(),
  mediaRef: z.object({
    assetId: z.string().uuid().optional(),
    // Set when the connector uploaded straight to the archive; the bytes are
    // already stored under this asset and there is nothing to fetch back.
    archiveAssetId: z.string().uuid().optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
    // Absent on the archive-direct path — there is no workspace object.
    gcsKey: z.string().optional(),
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
  function synthesizeFilename(
    given: string | undefined | null,
    kind: string,
    providerMessageId: string,
    mime: string,
  ): string {
    if (given && given.trim()) return given.trim()
    const subtype = mime.split('/')[1]?.split(';')[0]?.trim()
    const extension = subtype && /^[a-z0-9]{1,8}$/i.test(subtype) ? `.${subtype}` : ''
    return `${kind}-${providerMessageId}${extension}`
  }

  function archiveFilename(
    input: { mediaFileName?: string; mediaRef?: { fileName?: string }; messageId: string },
    kind: string,
    mime: string,
  ): string {
    return synthesizeFilename(input.mediaFileName ?? input.mediaRef?.fileName, kind, input.messageId, mime)
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
      // Present once the connector has hashed the file. The archive's signature
      // covers the digest, so a target cannot be minted without it.
      sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
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

    // Where should these bytes go?
    //
    // With an archive configured, straight into it. The connector cannot hold
    // the archive's secret, but it does not need to: the signature covers the
    // whole request URI, and owner, workspace, instance, provider message id
    // and content digest all live there. So a minted target authorizes storing
    // exactly these bytes for exactly this owner against exactly this message,
    // and nothing else. That is why the digest is required here.
    //
    // The alternative — upload to workspace storage, then have this process
    // read the object back and forward it — works, and is still the path for
    // inline media, but it leaves a second copy of every attachment on the
    // operator's disk with nothing to consume it. The archive is on-premise
    // only, so hosted keeps the workspace path below untouched: it has no
    // archive to send bytes to.
    if (opts.archiveMedia && parsed.data.providerMessageId) {
      try {
        const integration = await opts.integrationStore.getByChannelForWebhook(parsed.data.channelId, 'whatsapp')
        const ownerUserId = await (opts.getWorkspaceOwnerUserId ?? resolveWorkspaceOwnerUserId)(channel.workspaceId)
        if (ownerUserId) {
          const mime = parsed.data.mime
          const kind = parsed.data.kind ?? (mime.startsWith('image/') ? 'image'
            : mime.startsWith('video/') ? 'video'
              : mime.startsWith('audio/') ? 'voice' : 'file')
          // Same lazily-minted instance the append path uses; assets key on
          // `(instance_id, provider_message_id)`, so a different id here would
          // orphan the bytes from their message.
          const instanceId = integration?.connectorInstanceId
            ?? await resolveChatArchiveInstanceId({
              source: 'whatsapp',
              ownerUserId,
              workspaceId: channel.workspaceId,
              assistantId: '',
              assistantName: '',
              conversationId: parsed.data.channelId,
            })
          if (instanceId) {
            // Two-step by necessity. The signature commits to the digest, and
            // the connector cannot know it until it has read the attachment —
            // so the first call only says where the bytes belong. Answering
            // with a workspace URL here instead would send it down the old
            // path and quietly keep the duplicate copy.
            if (!parsed.data.sha256) {
              res.json({ target: 'archive' })
              return
            }
            const target = opts.archiveMedia.uploadTarget({
              workspaceId: channel.workspaceId,
              instanceId,
              ownerUserId,
              source: 'whatsapp',
              providerMessageId: parsed.data.providerMessageId,
              kind,
              // Named here because the connector's upload is what creates the
              // asset row. Leaving it blank strips the extension the extractor
              // uses to identify a format when the MIME is generic — the very
              // signal that rescues documents sent as application/octet-stream.
              filename: synthesizeFilename(
                parsed.data.fileName,
                kind,
                parsed.data.providerMessageId!,
                mime,
              ),
              mime,
              sha256: parsed.data.sha256!,
            })
            res.json({ target: 'archive', uploadUrl: target.url, headers: target.headers })
            return
          }
        }
      } catch (err) {
        // Fall through to workspace storage rather than dropping the
        // attachment: /inbound still reads it back from there.
        console.error('[whatsapp] archive upload target failed, falling back to workspace storage:', err)
      }
    }

    const fileId = `channel-media/${randomUUID()}`
    const key = buildStorageKey(channel.workspaceId, fileId)
    const resolved = await opts.filesResolver.forWorkspace(channel.workspaceId)
    const uploadUrl = await resolved.gcs.signedWriteUrl(key, { contentType: parsed.data.mime, ttlSec: 3600 })
    res.json({
      target: 'workspace',
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
          // Two ways the bytes get here. The connector may have uploaded them
          // straight to the archive under a per-asset signature this process
          // minted, in which case they are already stored and there is nothing
          // to fetch or re-send. Otherwise we hold them (inline base64) or can
          // read them back from workspace storage.
          const staged: StagedArchiveMedia = input.mediaRef?.archiveAssetId && input.mediaRef.sha256
            ? {
                assetId: input.mediaRef.archiveAssetId,
                sha256: input.mediaRef.sha256.toLowerCase(),
                filename: archiveFilename(input, kind, mime),
                mime,
                sizeBytes: input.mediaRef.sizeBytes ?? 0,
              }
            : await (async () => {
                const bytes = input.mediaBase64
                  ? Buffer.from(input.mediaBase64, 'base64')
                  : input.mediaRef?.gcsKey
                    ? await readStreamedMedia(
                        channel.workspaceId,
                        input.mediaRef as { gcsKey: string; storageUri?: string },
                        kind,
                      )
                    : null
                if (!bytes) throw new Error('streamed media could not be read back for the archive')
                return opts.archiveMedia!.storeBuffer({
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
              })()
          const ref = archiveMediaRef(staged)
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
    if (input.mediaRef?.gcsKey && !input.mediaRef.assetId && opts.passUnknownToFallback) {
      next()
      return
    }

    if (!input.text.trim() && !input.mediaBase64 && !input.mediaRef) {
      res.json({ ok: true })
      return
    }

    // The owner's OWN message, typed from the connected phone (Baileys
    // key.fromMe). Archive it as OUTBOUND and never run a turn — the assistant
    // must not answer the user's own outgoing messages, and the archive is a
    // record of the account's history, not only what it received. Mirrors the
    // custom channel's isSelf path (docs/architecture/channels/custom-channel.md).
    if (input.fromMe) {
      try {
        const channel = await (opts.getChannel ?? getChannelForWebhook)(input.channelId)
        const ownerUserId = channel
          ? await (opts.getWorkspaceOwnerUserId ?? resolveWorkspaceOwnerUserId)(channel.workspaceId)
          : null
        if (channel && ownerUserId) {
          const integration = await opts.integrationStore.getByChannelForWebhook(input.channelId, 'whatsapp')
          await appendOutboundChatArchive({
            source: 'whatsapp',
            ownerUserId,
            workspaceId: channel.workspaceId,
            connectorInstanceId: integration?.connectorInstanceId,
            assistantId: input.senderPnJid ?? input.senderJid,
            assistantName: input.senderName ?? input.senderPnJid ?? input.senderJid,
            conversationId: input.chatJid,
            sessionMessageId: `wa-self:${input.messageId}`,
            providerMessageId: input.messageId,
            text: /^<media:[^>]+>$/.test(input.text.trim()) ? '' : input.text,
            replyToProviderId: null,
          })
        }
      } catch (err) {
        console.error('[whatsapp] self-message outbound archive failed:', err)
      }
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
