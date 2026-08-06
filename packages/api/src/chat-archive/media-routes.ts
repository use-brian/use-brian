/** Loopback-only HMAC staging routes for brian-message-store backfill media. */

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Readable } from 'node:stream'
import { Router, type Request } from 'express'
import { z } from 'zod'
import { INGEST_APPEND_SIGNATURE_HEADER } from '@use-brian/shared'
import { verifyIngestAppendSignature } from '../ingest/append-signing.js'
import type { ChatArchiveMediaService } from './media-service.js'
import { ChatArchiveMediaTooLargeError, archiveMediaRef } from './media-service.js'

const initSchema = z.object({
  workspace_id: z.string().uuid(),
  instance_id: z.string().uuid(),
  owner_user_id: z.string().uuid(),
  source: z.string().min(1),
  provider_message_id: z.string().min(1),
  kind: z.enum(['image', 'video', 'voice', 'file']),
  filename: z.string(),
  mime: z.string().min(1),
  size_bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
})

function isLoopback(req: Request): boolean {
  const remote = req.socket.remoteAddress ?? ''
  return remote === '::1' || remote.startsWith('127.') || remote.startsWith('::ffff:127.')
}

function uploadToken(secret: string, assetId: string, expires: number): string {
  return createHmac('sha256', secret).update(`${assetId}\n${expires}`).digest('base64url')
}

export function signedChatArchiveMediaUploadUrl(input: {
  secret: string
  baseUrl: string
  assetId: string
  ttlSec?: number
}): string {
  const expires = Math.floor(Date.now() / 1000) + (input.ttlSec ?? 3600)
  const url = new URL(`/internal/chat-archive/media/${input.assetId}/content`, input.baseUrl)
  url.searchParams.set('expires', String(expires))
  url.searchParams.set('token', uploadToken(input.secret, input.assetId, expires))
  return url.toString()
}

function tokenMatches(secret: string, assetId: string, expires: number, provided: unknown): boolean {
  if (!Number.isSafeInteger(expires) || expires < Math.floor(Date.now() / 1000)) return false
  if (typeof provided !== 'string') return false
  const expected = Buffer.from(uploadToken(secret, assetId, expires))
  const actual = Buffer.from(provided)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function authenticatedJson(req: Request, secret: string): boolean {
  const raw = (req as Request & { rawBody?: string }).rawBody
  const signature = req.headers[INGEST_APPEND_SIGNATURE_HEADER]
  return typeof raw === 'string'
    && typeof signature === 'string'
    && verifyIngestAppendSignature(raw, secret, signature)
}

export function chatArchiveMediaRoutes(deps: {
  service: ChatArchiveMediaService
  hmacSecret: string
  baseUrl: string
  uploadTtlSec?: number
}): Router {
  const router = Router()
  const ttl = deps.uploadTtlSec ?? 3600

  router.use((req, res, next) => {
    if (!isLoopback(req)) {
      res.status(403).json({ error: 'loopback_only' })
      return
    }
    next()
  })

  router.post('/media/init', async (req, res) => {
    if (!authenticatedJson(req, deps.hmacSecret)) {
      res.status(401).json({ error: 'invalid_signature' })
      return
    }
    const parsed = initSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_media_init', details: parsed.error.flatten() })
      return
    }
    try {
      const value = parsed.data
      const initialized = await deps.service.init({
        workspaceId: value.workspace_id,
        instanceId: value.instance_id,
        ownerUserId: value.owner_user_id,
        source: value.source,
        providerMessageId: value.provider_message_id,
        kind: value.kind,
        filename: value.filename,
        mime: value.mime,
        sizeBytes: value.size_bytes,
        sha256: value.sha256,
      })
      res.json({
        asset_id: initialized.asset.id,
        upload_url: signedChatArchiveMediaUploadUrl({
          secret: deps.hmacSecret,
          baseUrl: deps.baseUrl,
          assetId: initialized.asset.id,
          ttlSec: ttl,
        }),
        already_stored: initialized.alreadyStored,
      })
    } catch (err) {
      if (err instanceof ChatArchiveMediaTooLargeError) {
        res.status(413).json({ error: 'media_too_large', max_bytes: err.maxBytes })
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      res.status(message.includes('binding') ? 403 : 500).json({ error: message })
    }
  })

  router.put('/media/:assetId/content', async (req, res) => {
    const expires = Number(req.query.expires)
    if (!tokenMatches(deps.hmacSecret, req.params.assetId, expires, req.query.token)) {
      res.status(401).json({ error: 'invalid_upload_token' })
      return
    }
    const declared = req.headers['content-length'] ? Number(req.headers['content-length']) : null
    try {
      const asset = await deps.service.upload({
        assetId: req.params.assetId,
        stream: req as unknown as Readable,
        contentLength: declared != null && Number.isFinite(declared) ? declared : null,
      })
      res.json({ asset_id: asset.id, size_bytes: asset.sizeBytes, sha256: asset.sha256 })
    } catch (err) {
      if (err instanceof ChatArchiveMediaTooLargeError) {
        res.status(413).json({ error: 'media_too_large', max_bytes: err.maxBytes })
        return
      }
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  router.post('/media/:assetId/complete', async (req, res) => {
    if (!authenticatedJson(req, deps.hmacSecret)) {
      res.status(401).json({ error: 'invalid_signature' })
      return
    }
    try {
      const asset = await deps.service.complete(req.params.assetId)
      res.json({ asset_id: asset.id, media_ref: archiveMediaRef(asset) })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      res.status(message.includes('not found') ? 404 : message.includes('SHA-256') ? 422 : 409).json({ error: message })
    }
  })

  return router
}
