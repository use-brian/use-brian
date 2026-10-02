import { Router, raw, type RequestHandler, type ErrorRequestHandler } from 'express'
import { z } from 'zod'
import { watchStore, WatchError, sha256, LIMITS, type Grant } from '../recordings/watch-store.js'
import { createWatchUploads, fullUploadInput } from '../recordings/watch-upload.js'
import { validateWatchAudio } from '../recordings/watch-media.js'
import type { WatchService } from '../recordings/watch-service.js'

const uuid = z.string().uuid().transform(s => s.toLowerCase())
const provision = z.object({ deviceId: uuid, workspaceId: uuid, assistantId: uuid, label: z.string().trim().min(1).max(80) }).strict()
const metadata = z.object({ capturedAt: z.string().datetime({ offset: true }), title: z.string().trim().min(1).max(120), source: z.literal('apple-watch') }).strict()
const finalize = z.object({ expectedWindows: z.number().int().min(0).max(LIMITS.windows).default(0), allowIncomplete: z.boolean().default(false), source: z.enum(['windows', 'full']).default('windows') }).strict().refine(v => v.source === 'full' || v.expectedWindows > 0)
const windowQuery = z.object({ sequence: z.coerce.number().int().min(0).max(LIMITS.windows - 1), offsetMs: z.coerce.number().int().min(0), durationMs: z.coerce.number().int().min(1).max(60000), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().refine(v => v.offsetMs + v.durationMs <= LIMITS.durationMs)

export function watchRecordingRoutes(deps: {
  provisioningKey: string; humanAuth: RequestHandler; authorize: (grant: Pick<Grant, 'owner_id' | 'workspace_id' | 'assistant_id'>) => Promise<void>
  service: WatchService; store?: typeof watchStore; validateAudio?: typeof validateWatchAudio
}): Router {
  const router = Router(), store = deps.store ?? watchStore
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next() })
  router.post('/grants', deps.humanAuth, async (req, res) => {
    if (!req.userId) throw new WatchError(401, 'human_auth_required')
    const input = provision.parse(req.body)
    await deps.authorize({ owner_id: req.userId, workspace_id: input.workspaceId, assistant_id: input.assistantId })
    res.status(201).json(await store.provision({ ...input, ownerId: req.userId, provisioningKey: deps.provisioningKey }))
  })
  router.get('/grants', deps.humanAuth, async (req, res) => {
    if (!req.userId) throw new WatchError(401, 'human_auth_required')
    res.json({ grants: await store.list(req.userId) })
  })
  router.delete('/grants/:id', deps.humanAuth, async (req, res) => {
    if (!req.userId) throw new WatchError(401, 'human_auth_required')
    await store.revoke(req.userId, uuid.parse(req.params.id)); res.status(204).end()
  })
  router.post('/renew', async (req, res) => {
    const { renewalToken } = z.object({ renewalToken: z.string().max(100) }).strict().parse(req.body)
    res.json(await store.renew(renewalToken, deps.authorize))
  })
  const uploads = createWatchUploads({ key: deps.provisioningKey, authorize: deps.authorize, store, validateAudio: deps.validateAudio })
  // Signed byte ingress is deliberately before device middleware; its capability is single-capture upload-only.
  router.put('/uploads/:captureId', uploads.receive)
  const sessions = Router()
  sessions.post('/sessions/:clientId/full-upload', async (req, res) => {
    res.json(await uploads.initialize(res.locals.grant, uuid.parse(req.params.clientId), fullUploadInput.parse(req.body)))
  })
  sessions.put('/sessions/:clientId', async (req, res) => {
    const grant = res.locals.grant as Grant
    const capture = await store.create(grant, uuid.parse(req.params.clientId), metadata.parse(req.body))
    await deps.service.prepare(grant, capture)
    res.json(await deps.service.status(grant, capture.client_id))
  })
  sessions.get('/sessions/:clientId', async (req, res) => {
    res.json(await deps.service.status(res.locals.grant, uuid.parse(req.params.clientId)))
  })
  sessions.put('/sessions/:clientId/windows', raw({ type: 'audio/mp4', limit: LIMITS.windowBytes }), async (req, res) => {
    const input = windowQuery.parse(req.query)
    if (!req.is('audio/mp4') || !Buffer.isBuffer(req.body) || !req.body.length) throw new WatchError(400, 'audio_mp4_required')
    if (sha256(req.body) !== input.sha256) throw new WatchError(422, 'checksum_mismatch')
    const grant = res.locals.grant as Grant
    const capture = await store.get(grant, uuid.parse(req.params.clientId))
    if (!await store.hasWindow(capture.id, input.sequence)) await (deps.validateAudio ?? validateWatchAudio)(req.body, input.durationMs)
    await store.receive(grant, capture, { ...input, checksum: input.sha256, audio: req.body })
    // Receipt is independent of model availability. Explicit /retry advances transcription.
    res.json({ received: true, sequence: input.sequence, sha256: input.sha256 })
  })
  sessions.post('/sessions/:clientId/retry', async (req, res) => {
    res.json(await deps.service.retry(res.locals.grant, uuid.parse(req.params.clientId)))
  })
  sessions.post('/sessions/:clientId/finalize', async (req, res) => {
    res.json(await deps.service.finalize(res.locals.grant, uuid.parse(req.params.clientId), finalize.parse(req.body)))
  })
  sessions.use((_req, res) => { res.status(404).json({ error: 'watch_endpoint_not_found' }) })
  // Same router, same immutable grant/session namespace. No device renewal secret on the phone.
  router.use('/relay/:grantId', deps.humanAuth, async (req, res, next) => {
    if (!req.userId) throw new WatchError(401, 'human_auth_required')
    const grant = await store.relay(req.userId, uuid.parse(req.params.grantId))
    await deps.authorize(grant)
    res.locals.grant = grant
    next()
  }, sessions)
  router.use(async (req, res, next) => {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) throw new WatchError(401, 'device_auth_required')
    const grant = await store.authenticate(header.slice(7))
    await deps.authorize(grant)
    res.locals.grant = grant
    next()
  })
  router.use(sessions)
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof z.ZodError) return void res.status(400).json({ error: 'invalid_request' })
    if (error instanceof WatchError) return void res.status(error.status).json({ error: error.message, ...(error.detail ? { detail: error.detail } : {}) })
    if (error?.type === 'entity.too.large') return void res.status(413).json({ error: 'audio_quota' })
    // No provider errors, audio, transcript, or credentials in HTTP/log output.
    res.status(503).json({ error: 'watch_temporarily_unavailable' })
  }
  router.use(errors)
  return router
}
