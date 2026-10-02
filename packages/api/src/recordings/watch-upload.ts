import { createHmac, timingSafeEqual } from 'node:crypto'
import { raw, type Request, type Response } from 'express'
import { z } from 'zod'
import { validateWatchAudio } from './watch-media.js'
import { LIMITS, sha256, WatchError, watchStore, withCaptureLock, type Grant } from './watch-store.js'

export const fullUploadInput = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().min(1).max(LIMITS.captureBytes),
  durationMs: z.number().int().min(1).max(LIMITS.durationMs),
}).strict()
const claimsSchema = fullUploadInput.extend({
  audience: z.literal('watch-full-upload-v1'), captureId: z.string().uuid(), clientId: z.string().uuid(),
  grantId: z.string().uuid(), ownerId: z.string().uuid(), mode: z.enum(['device', 'relay']), expires: z.number().int(),
}).strict()
export type UploadClaims = z.infer<typeof claimsSchema>
export function signWatchUpload(claims: UploadClaims, key: string) {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const signature = createHmac('sha256', key).update(`watch-full-upload-v1.${body}`).digest('base64url')
  return `${body}.${signature}`
}
export function verifyWatchUpload(token: unknown, key: string, captureId: string): UploadClaims {
  if (typeof token !== 'string' || token.length > 2048) throw new WatchError(401, 'invalid_upload_token')
  const parts = token.split('.')
  if (parts.length !== 2) throw new WatchError(401, 'invalid_upload_token')
  const expected = createHmac('sha256', key).update(`watch-full-upload-v1.${parts[0]}`).digest()
  const signature = Buffer.from(parts[1], 'base64url')
  if (signature.length !== expected.length || !timingSafeEqual(expected, signature)) throw new WatchError(401, 'invalid_upload_token')
  let claims: UploadClaims
  try { claims = claimsSchema.parse(JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))) }
  catch { throw new WatchError(401, 'invalid_upload_token') }
  if (claims.captureId !== captureId || claims.expires <= Date.now()) throw new WatchError(401, 'invalid_upload_token')
  return claims
}

/** API-owned staging: bounded bytes/checksum are verified BEFORE durable receipt.
 * No cloud write URL is issued, and a staged snapshot can never be overwritten.
 */
export function createWatchUploads(deps: {
  key: string; authorize: (g: Grant) => Promise<void>; store?: typeof watchStore
  validateAudio?: typeof validateWatchAudio
}) {
  const store = deps.store ?? watchStore
  return {
    async initialize(grant: Grant, clientId: string, input: z.infer<typeof fullUploadInput>) {
      const c = await store.get(grant, clientId)
      return withCaptureLock(c.id, async () => {
        await deps.authorize(grant)
        const descriptor = await store.initializeUpload(grant, c, input)
        const claims: UploadClaims = { ...input, audience: 'watch-full-upload-v1',
          captureId: c.id, clientId, grantId: grant.id, ownerId: grant.owner_id, mode: grant.authMode === 'relay' ? 'relay' : 'device', expires: Date.now() + 300000 }
        return { uploadUrl: `/api/watch/v1/uploads/${c.id}?token=${signWatchUpload(claims, deps.key)}`, method: 'PUT',
          uploadHeaders: { 'Content-Type': 'audio/mp4', 'Content-Length': String(input.bytes) }, expiresAt: new Date(claims.expires).toISOString(),
          sessionId: c.id, received: descriptor.received === true }
      })
    },
    async receive(req: Request, res: Response) {
      const claims = verifyWatchUpload(req.query.token, deps.key, String(req.params.captureId))
      const grant = await store.relay(claims.ownerId, claims.grantId)
      grant.authMode = claims.mode === 'relay' ? 'relay' : undefined
      await deps.authorize(grant) // Rechecks revocation, membership, destination and (device-mode) grant expiry.
      await withCaptureLock(claims.captureId, async db => {
        const c = await store.get(grant, claims.clientId)
        if (c.id !== claims.captureId) throw new WatchError(404, 'capture_not_found')
        const descriptor = await store.upload(c.id)
        if (!descriptor || descriptor.checksum !== claims.sha256 || descriptor.bytes !== claims.bytes || descriptor.duration_ms !== claims.durationMs) throw new WatchError(409, 'full_upload_conflict')
        if (!descriptor.received && c.state !== 'open') throw new WatchError(409, 'capture_sealed')
        if (!req.is('audio/mp4')) throw new WatchError(415, 'audio_mp4_required')
        if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new WatchError(415, 'encoded_upload_not_supported')
        if (req.headers['content-length'] !== String(claims.bytes)) throw new WatchError(411, 'exact_content_length_required')
        const timer = setTimeout(() => req.destroy(new Error('watch_upload_timeout')), 300000)
        timer.unref()
        try {
          await new Promise<void>((resolve, reject) => raw({ type: 'audio/mp4', limit: claims.bytes, inflate: false })(req, res, error => error ? reject(error) : resolve()))
          if (!Buffer.isBuffer(req.body) || req.body.length !== claims.bytes || sha256(req.body) !== claims.sha256) throw new WatchError(422, 'checksum_or_length_mismatch')
          if (!descriptor.received) await (deps.validateAudio ?? validateWatchAudio)(req.body, claims.durationMs, LIMITS.durationMs)
          verifyWatchUpload(req.query.token, deps.key, claims.captureId) // Expiry also checked at receipt.
          await deps.authorize(grant)
          await store.receiveFull(grant, c.id, req.body, db)
          res.json({ received: true, sessionId: c.id, sha256: claims.sha256, bytes: claims.bytes })
        } finally { clearTimeout(timer) }
      })
    },
  }
}
