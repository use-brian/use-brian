import { randomUUID, timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import type { ChannelIntegrationStore } from '../db/channel-integrations.js'
import type { WhatsappIngestor } from '../ingest/whatsapp-ingest.js'
import type { WhatsappBot } from './whatsapp-bot-handler.js'
import { buildWhatsappListenerHandler } from './whatsapp-listener-handler.js'
import { runHandlers, selectHandlers } from './whatsapp-dispatcher.js'
import { getChannelForWebhook } from '../db/channels-store.js'
import type { FilesClientResolver } from '../files/files-api.js'
import { buildStorageKey, buildStorageUri } from '../files/gcs-client.js'

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
}).passthrough()

function secretMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || !expected) return false
  const actual = Buffer.from(provided)
  const wanted = Buffer.from(expected)
  return actual.length === wanted.length && timingSafeEqual(actual, wanted)
}

export type WhatsappByonRoutesOptions = {
  connectorSecret: string
  integrationStore: ChannelIntegrationStore
  ingestor: WhatsappIngestor
  bot: WhatsappBot
  filesResolver?: FilesClientResolver
  getChannel?: typeof getChannelForWebhook
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
      mime: z.string().min(1),
      fileName: z.string().nullable().optional(),
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
    const input = parsed.data
    // Hosted media intake is mounted as the later closed router. Let it own
    // streamed references; otherwise this BYON router ACKs first and the bytes
    // are uploaded successfully but never become a recording/document artifact.
    if (input.mediaRef && opts.passUnknownToFallback) {
      next()
      return
    }
    if (!input.text.trim() || input.text.trim() === '<media:sticker>') {
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

    res.json({ ok: true })
    const listener = buildWhatsappListenerHandler(opts.ingestor, input)
    void runHandlers(selectHandlers(
      { listener: listenerActive, bot: bot !== null },
      { listener, bot },
    ))
  })

  return router
}
