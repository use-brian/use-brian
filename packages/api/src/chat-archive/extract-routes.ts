/**
 * The extraction endpoint the message store calls.
 *
 * Direction matters here: the store drives, this responds. It owns the bytes and
 * the queue, so this route holds no state, claims nothing and retries nothing.
 * A restart on either side costs a retry rather than leaving a job stranded in a
 * process that has gone away.
 *
 * [COMP:integrations/chat-archive-extract]
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { Router, type Request } from 'express'
import type { ExtractModality, ExtractService } from './extract-service.js'

const SIGNATURE_HEADER = 'x-ub-signature'

/**
 * Attachments run to hundreds of megabytes, so the signature covers the request
 * line rather than the body — buffering a video to authenticate it would be
 * self-defeating. Every parameter that matters travels in the URI.
 */
function verifyRequestSignature(req: Request, secret: string): boolean {
  const header = String(req.headers[SIGNATURE_HEADER] ?? '').trim()
  if (!header || !secret) return false
  const provided = header.toLowerCase().startsWith('sha256=') ? header.slice(7) : header
  const canonical = `${req.method.toUpperCase()}\n${req.originalUrl}`
  const expected = createHmac('sha256', secret).update(canonical).digest('hex')
  const a = Buffer.from(provided, 'hex')
  const b = Buffer.from(expected, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

function isLoopback(req: Request): boolean {
  const remote = req.socket.remoteAddress ?? ''
  return remote === '::1' || remote.startsWith('127.') || remote.startsWith('::ffff:127.')
}

const MODALITIES: ReadonlySet<string> = new Set(['ocr', 'transcript', 'document', 'video_frames'])

export type ChatArchiveExtractRoutesDeps = {
  service: ExtractService
  secret: string
  /**
   * Largest attachment accepted. Extraction holds the whole payload in memory,
   * so this bounds peak usage per concurrent request.
   */
  maxBytes?: number
  /** Set when the store runs on another host in the deployment. */
  allowRemote?: boolean
  logger?: Pick<Console, 'warn' | 'error'>
}

export function chatArchiveExtractRoutes(deps: ChatArchiveExtractRoutesDeps): Router {
  const router = Router()
  const maxBytes = deps.maxBytes ?? 512 * 1024 * 1024
  const logger = deps.logger ?? console

  router.post('/extract', async (req, res) => {
    if (!deps.allowRemote && !isLoopback(req)) {
      res.status(403).json({ error: 'loopback only' })
      return
    }
    if (!verifyRequestSignature(req, deps.secret)) {
      res.status(401).json({ error: 'invalid signature' })
      return
    }

    const modality = String(req.query.modality ?? '')
    if (!MODALITIES.has(modality)) {
      res.status(400).json({ error: 'modality must be one of ocr, transcript, document, video_frames' })
      return
    }
    const mime = String(req.query.mime ?? '').trim() || 'application/octet-stream'
    const filename = String(req.query.filename ?? '').trim()
    // Optional: an older store simply omits it and the service falls back to
    // the deployment default. Bounded and charset-restricted because it is
    // interpolated into a model prompt — a language tag has no business
    // carrying arbitrary text.
    const languageRaw = String(req.query.language ?? '').trim()
    const language = /^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{2,8})?$/.test(languageRaw) ? languageRaw : ''

    const chunks: Buffer[] = []
    let total = 0
    let aborted = false
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) {
        aborted = true
        res.status(413).json({ error: 'attachment exceeds maximum size' })
        req.destroy()
        return
      }
      chunks.push(chunk)
    })

    await new Promise<void>((resolve) => {
      req.on('end', resolve)
      req.on('error', resolve)
      req.on('close', resolve)
    })
    if (aborted || res.headersSent) return

    const buffer = Buffer.concat(chunks)
    if (buffer.length === 0) {
      res.status(400).json({ error: 'request body is empty' })
      return
    }

    try {
      const result = await deps.service.extract({
        modality: modality as ExtractModality,
        mime,
        filename,
        ...(language ? { language } : {}),
        buffer,
      })
      if (result.unsupported) {
        // 415 is the store's terminal signal: nothing to extract, do not retry.
        res.status(415).json({ texts: [], unsupported: true })
        return
      }
      res.json({ texts: result.texts })
    } catch (err) {
      // Never echo attachment content into a log line; these are personal files.
      const reason = err instanceof Error ? err.message : String(err)
      logger.warn(`[chat-archive-extract] ${modality} extraction failed: ${reason}`)
      res.status(500).json({ error: reason })
    }
  })

  return router
}
