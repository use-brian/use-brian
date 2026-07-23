import { pipeline } from 'node:stream/promises'
import * as path from 'node:path'
import { Router } from 'express'
import type { Request, Response } from 'express'
import type { LocalFilesClient } from '../files/local-files-client.js'
import {
  verifyLocalFileGrant,
  type LocalFileAction,
  type LocalFileGrant,
} from '../files/local-files-signing.js'

type ByteRange = { start: number; end: number }

function isExpectedClientClose(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'ECONNRESET'
}

function downloadName(key: string, mime: string): string {
  const base = path.basename(key).replace(/[^a-zA-Z0-9._-]/g, '_') || 'file'
  if (path.extname(base)) return base
  const extension = mime === 'video/mp4'
    ? '.mp4'
    : mime === 'audio/aac'
      ? '.aac'
      : mime === 'audio/mpeg'
        ? '.mp3'
        : mime === 'audio/mp4'
          ? '.m4a'
          : ''
  return `${base}${extension}`
}

function parseRange(raw: string | undefined, size: number): ByteRange | null | 'invalid' {
  if (!raw) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(raw.trim())
  if (!match || (!match[1] && !match[2]) || size <= 0) return 'invalid'

  if (!match[1]) {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }

  const start = Number(match[1])
  const requestedEnd = match[2] ? Number(match[2]) : size - 1
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  ) {
    return 'invalid'
  }
  return { start, end: Math.min(requestedEnd, size - 1) }
}

function grantFromRequest(req: Request): (LocalFileGrant & { signature: string }) | null {
  const action = req.query.action
  const key = req.query.key
  const expires = Number(req.query.expires)
  const signature = req.query.signature
  const mime = req.query.mime
  if (
    (action !== 'read' && action !== 'write') ||
    typeof key !== 'string' ||
    !key ||
    !Number.isSafeInteger(expires) ||
    typeof signature !== 'string' ||
    (mime !== undefined && typeof mime !== 'string')
  ) {
    return null
  }
  return {
    action: action as LocalFileAction,
    key,
    expires,
    signature,
    ...(typeof mime === 'string' && mime ? { mime } : {}),
  }
}

export function localFilesTransferRoutes(opts: {
  client: LocalFilesClient
  signingSecret: string
}): Router {
  const router = Router()

  function rejectGrant(req: Request, res: Response, expectedAction: LocalFileAction): void {
    const grant = grantFromRequest(req)
    const now = Math.floor(Date.now() / 1000)
    const reason = !grant
      ? 'malformed'
      : grant.action !== expectedAction
        ? `action_mismatch:${grant.action}`
        : grant.expires < now
          ? 'expired'
          : 'invalid_signature'
    console.warn('[local-files] rejected signed request', {
      method: req.method,
      expectedAction,
      reason,
      key: grant?.key ?? null,
      expires: grant?.expires ?? null,
      now,
      userAgent: req.get('user-agent') ?? null,
    })
    res.setHeader('Cache-Control', 'no-store')
    res.status(403).json({ error: 'Invalid or expired file URL' })
  }

  async function sendBlob(req: Request, res: Response): Promise<void> {
    const grant = grantFromRequest(req)
    if (!grant || grant.action !== 'read' || !verifyLocalFileGrant(grant, grant.signature, opts.signingSecret)) {
      rejectGrant(req, res, 'read')
      return
    }

    try {
      const stat = await opts.client.statBlob(grant.key)
      if (!stat) {
        res.status(404).json({ error: 'File not found' })
        return
      }
      const range = parseRange(req.headers.range, stat.sizeBytes)
      if (range === 'invalid') {
        res.setHeader('Content-Range', `bytes */${stat.sizeBytes}`)
        res.status(416).end()
        return
      }

      const selected = range ?? { start: 0, end: Math.max(0, stat.sizeBytes - 1) }
      const contentLength = stat.sizeBytes === 0 ? 0 : selected.end - selected.start + 1
      res.status(range ? 206 : 200)
      res.setHeader('Accept-Ranges', 'bytes')
      res.setHeader('Content-Type', stat.mime)
      res.setHeader('Content-Length', String(contentLength))
      res.setHeader('Content-Disposition', `inline; filename="${downloadName(grant.key, stat.mime)}"`)
      res.setHeader('Cache-Control', 'private, max-age=3600')
      if (range) res.setHeader('Content-Range', `bytes ${selected.start}-${selected.end}/${stat.sizeBytes}`)
      if (req.method === 'HEAD' || stat.sizeBytes === 0) {
        res.end()
        return
      }
      await pipeline(opts.client.openReadStream(grant.key, selected), res)
    } catch (err) {
      // Media probes and players commonly close a range response once they have
      // enough metadata. The bytes and signature are valid; this is not a
      // storage failure and should not flood OSS logs with stack traces.
      if (isExpectedClientClose(err) && res.headersSent) return
      console.error('[local-files] read failed:', err)
      if (!res.headersSent) res.status(500).json({ error: 'Failed to read file' })
      else res.destroy(err instanceof Error ? err : undefined)
    }
  }

  router.get('/', sendBlob)
  router.head('/', sendBlob)

  router.put('/', async (req, res) => {
    const grant = grantFromRequest(req)
    if (!grant || grant.action !== 'write' || !verifyLocalFileGrant(grant, grant.signature, opts.signingSecret)) {
      rejectGrant(req, res, 'write')
      return
    }
    const requestMime = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
    const expectedMime = grant.mime?.trim().toLowerCase()
    if (expectedMime && requestMime !== expectedMime) {
      res.status(400).json({ error: 'Content-Type does not match signed file URL' })
      return
    }

    const mime = grant.mime ?? requestMime ?? 'application/octet-stream'
    const workspaceId = grant.key.split('/', 1)[0] ?? ''
    try {
      await pipeline(
        req,
        opts.client.writeStream(grant.key, {
          mime,
          metadata: { workspaceId, mime },
        }),
      )
      res.status(204).end()
    } catch (err) {
      await opts.client.deleteBlob(grant.key).catch(() => {})
      console.error('[local-files] write failed:', err)
      if (!res.headersSent) res.status(500).json({ error: 'Failed to write file' })
      else res.destroy(err instanceof Error ? err : undefined)
    }
  })

  return router
}
