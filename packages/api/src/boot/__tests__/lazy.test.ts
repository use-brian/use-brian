/**
 * Lazy composition seams (boot/lazy.ts): a lazy router answers its first
 * request through the mount it replaced, keeps the middleware chain and mount
 * order, and answers 503 `route_module_unavailable` (never a 404 or a
 * fall-through) when its module cannot load; a lazy worker loads on start(),
 * never when it is not started, and reports a load failure through the
 * worker's own failure path.
 *
 * Spec: docs/architecture/platform/deployment.md -> "Boot composition" ->
 * "Lazy routers and workers".
 */
import express, { Router, type RequestHandler } from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LAZY_ROUTE_RETRY_AFTER_SECONDS, LAZY_WORKER_RETRY_MS, lazyRoutes, lazyWorker } from '../lazy.js'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

/** A module shaped like routes/<x>.ts: one router factory taking its deps. */
function routeModule(built: { count: number }) {
  return {
    widgetRoutes(deps: { greeting: string }) {
      built.count++
      const router = Router()
      router.get('/hello', (_req, res) => { res.json({ text: deps.greeting }) })
      router.get('/:id', (req, res) => { res.json({ id: req.params.id }) })
      router.post('/boom', async () => { throw new Error('handler failed') })
      return router
    },
  }
}

const guard: RequestHandler = (req, res, next) => {
  if (req.headers.authorization !== 'Bearer ok') { res.status(401).json({ error: 'unauthorized' }); return }
  next()
}

function app(load: () => Promise<ReturnType<typeof routeModule>>) {
  const a = express()
  const widgetRoutes = lazyRoutes(load, 'widgetRoutes')
  a.use('/api/widgets', guard, widgetRoutes({ greeting: 'hi' }))
  // A later mount on an overlapping prefix: reached only through next().
  a.use('/api', guard, (_req, res) => { res.status(418).json({ reached: 'later-mount' }) })
  a.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message })
  })
  return a
}

describe('[COMP:api/boot-lazy] lazy routers', () => {
  it('builds nothing at mount and answers the first request through the built router', async () => {
    const built = { count: 0 }
    const load = vi.fn(async () => routeModule(built))
    const a = app(load)
    expect(load).not.toHaveBeenCalled()
    expect(built.count).toBe(0)

    const first = await request(a).get('/api/widgets/hello').set('authorization', 'Bearer ok')
    expect(first.status).toBe(200)
    expect(first.body).toEqual({ text: 'hi' })
    const second = await request(a).get('/api/widgets/w-1').set('authorization', 'Bearer ok')
    expect(second.body).toEqual({ id: 'w-1' })
    expect(load).toHaveBeenCalledTimes(1)
    expect(built.count).toBe(1)
  })

  it('shares one load between concurrent first requests', async () => {
    const built = { count: 0 }
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const load = vi.fn(async () => { await gate; return routeModule(built) })
    const a = app(load)
    const pending = Promise.all([1, 2, 3].map((n) => request(a).get(`/api/widgets/w-${n}`).set('authorization', 'Bearer ok').then((r) => r)))
    await new Promise((r) => setTimeout(r, 20))
    release()
    const results = await pending
    expect(results.map((r) => r.body.id)).toEqual(['w-1', 'w-2', 'w-3'])
    expect(load).toHaveBeenCalledTimes(1)
    expect(built.count).toBe(1)
  })

  it('keeps the guard in front: an unauthenticated request never loads the module', async () => {
    const load = vi.fn(async () => routeModule({ count: 0 }))
    const res = await request(app(load)).get('/api/widgets/hello')
    expect(res.status).toBe(401)
    expect(load).not.toHaveBeenCalled()
  })

  it('preserves fall-through and Express error semantics once loaded', async () => {
    const a = app(async () => routeModule({ count: 0 }))
    const miss = await request(a).delete('/api/widgets/hello').set('authorization', 'Bearer ok')
    expect(miss.status).toBe(418)
    expect(miss.body).toEqual({ reached: 'later-mount' })
    const boom = await request(a).post('/api/widgets/boom').set('authorization', 'Bearer ok')
    expect(boom.status).toBe(500)
    expect(boom.body).toEqual({ error: 'handler failed' })
  })

  it('answers 503 route_module_unavailable on a load failure, never 404 or a later mount, then retries', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    let fail = true
    const load = vi.fn(async () => {
      if (fail) throw new Error('Cannot find module routes/widgets.js')
      return routeModule({ count: 0 })
    })
    const a = app(load)
    const res = await request(a).get('/api/widgets/hello').set('authorization', 'Bearer ok')
    expect(res.status).toBe(503)
    expect(res.headers['retry-after']).toBe(String(LAZY_ROUTE_RETRY_AFTER_SECONDS))
    expect(res.body).toMatchObject({ error: 'route_module_unavailable', module: 'widgetRoutes', effect: 'none', retryable: true })
    expect(error).toHaveBeenCalledWith(expect.stringContaining('route module widgetRoutes failed to load'), expect.any(Error))

    // Inside the retry window: 503 again without another load attempt.
    const again = await request(a).get('/api/widgets/hello').set('authorization', 'Bearer ok')
    expect(again.status).toBe(503)
    expect(load).toHaveBeenCalledTimes(1)

    // After the window a request retries the load and succeeds.
    fail = false
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + LAZY_ROUTE_RETRY_AFTER_SECONDS * 1_000 + 1)
    const ok = await request(a).get('/api/widgets/hello').set('authorization', 'Bearer ok')
    expect(ok.status).toBe(200)
    expect(ok.body).toEqual({ text: 'hi' })
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('answers 503 when the factory itself throws or the export is missing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const throwing = express()
    const r1 = lazyRoutes(async () => ({ widgetRoutes: (_d: { greeting: string }): RequestHandler => { throw new Error('bad config') } }), 'widgetRoutes')
    throwing.use('/api/widgets', r1({ greeting: 'x' }))
    expect((await request(throwing).get('/api/widgets/hello')).status).toBe(503)

    const missing = express()
    const r2 = lazyRoutes(async () => ({}) as { widgetRoutes: (d: { greeting: string }) => RequestHandler }, 'widgetRoutes')
    missing.use('/api/widgets', r2({ greeting: 'x' }))
    const res = await request(missing).get('/api/widgets/hello')
    expect(res.status).toBe(503)
    expect(res.body.error).toBe('route_module_unavailable')
  })

  it('serves a real step router lazily on first request', async () => {
    // brandRoutes is a lazy binding of the brain-routes step. A request with
    // no authenticated user is rejected by the router's own handler (before
    // any store read), which proves the request reached the real module
    // through the lazy mount rather than falling through.
    const a = express()
    const brandRoutes = lazyRoutes(() => import('../../routes/brand.js'), 'brandRoutes')
    a.use('/api/workspaces/:workspaceId/brand', brandRoutes({ store: {} as never }))
    a.use((_req, res) => { res.status(404).json({ reached: 'fallthrough' }) })
    const res = await request(a).get('/api/workspaces/w-1/brand')
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Unauthorized' })
  })
})

type FakeWorker = { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }

function workerModule(made: FakeWorker[], stopImpl: () => unknown = () => undefined) {
  return {
    createFakeWorker(_options: { intervalMs: number; onError?: (error: unknown) => void; logger?: Pick<Console, 'error'> }) {
      const w = { start: vi.fn(), stop: vi.fn(stopImpl) }
      made.push(w)
      return w
    },
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))
/** A worker module whose load always fails, typed like the real one. */
const failingLoad = async (): Promise<ReturnType<typeof workerModule>> => { throw new Error('missing') }

describe('[COMP:api/boot-lazy] lazy workers', () => {
  it('loads nothing until start(); a never-started worker never loads and stops as a no-op', async () => {
    const made: FakeWorker[] = []
    const load = vi.fn(async () => workerModule(made))
    const worker = lazyWorker(load, 'createFakeWorker', '[fake-worker]')({ intervalMs: 10 })
    await expect(worker.stop()).resolves.toBeUndefined()
    expect(load).not.toHaveBeenCalled()
    expect(worker.state).toBe('idle')
  })

  it('start() loads, builds once and starts; stop() stops the built worker synchronously', async () => {
    const made: FakeWorker[] = []
    const load = vi.fn(async () => workerModule(made))
    const worker = lazyWorker(load, 'createFakeWorker', '[fake-worker]')({ intervalMs: 10 })
    worker.start()
    worker.start() // a second start while loading is a no-op
    expect(worker.state).toBe('loading')
    await flush()
    expect(load).toHaveBeenCalledTimes(1)
    expect(made).toHaveLength(1)
    expect(made[0].start).toHaveBeenCalledTimes(1)
    expect(worker.state).toBe('running')
    const stopped = worker.stop()
    expect(made[0].stop).toHaveBeenCalledTimes(1) // before the promise settles
    await stopped
    expect(worker.state).toBe('stopped')
  })

  it('awaits an asynchronous stop', async () => {
    const made: FakeWorker[] = []
    let drained = false
    const worker = lazyWorker(async () => workerModule(made, async () => { await flush(); drained = true }), 'createFakeWorker', '[fake-worker]')({ intervalMs: 10 })
    worker.start()
    await flush()
    await worker.stop()
    expect(drained).toBe(true)
  })

  it('stop() during the load cancels the start: the worker is never built', async () => {
    const made: FakeWorker[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const worker = lazyWorker(async () => { await gate; return workerModule(made) }, 'createFakeWorker', '[fake-worker]')({ intervalMs: 10 })
    worker.start()
    await worker.stop()
    release()
    await flush()
    expect(made).toHaveLength(0)
    expect(worker.state).toBe('stopped')
  })

  it('reports a load failure through the worker onError option and retries with backoff until stop()', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const made: FakeWorker[] = []
    let fail = 2
    const load = vi.fn(async () => {
      if (fail-- > 0) throw new Error('worker module missing')
      return workerModule(made)
    })
    const onError = vi.fn()
    const worker = lazyWorker(load, 'createFakeWorker', '[fake-worker]')({ intervalMs: 10, onError })
    worker.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error)
    expect(made).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(LAZY_WORKER_RETRY_MS.first)
    expect(onError).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(LAZY_WORKER_RETRY_MS.first * 2)
    expect(load).toHaveBeenCalledTimes(3)
    expect(made).toHaveLength(1)
    expect(made[0].start).toHaveBeenCalledTimes(1)
    await worker.stop()
  })

  it('stop() cancels a pending retry', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const load = vi.fn(failingLoad)
    const worker = lazyWorker(load, 'createFakeWorker', '[fake-worker]')({ intervalMs: 10, onError: () => {} })
    worker.start()
    await vi.advanceTimersByTimeAsync(0)
    await worker.stop()
    await vi.advanceTimersByTimeAsync(LAZY_WORKER_RETRY_MS.max * 2)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('without onError, reports through the worker logger, else its log tag', async () => {
    const logger = { error: vi.fn() }
    const viaLogger = lazyWorker(failingLoad, 'createFakeWorker', '[fake-worker]')({ intervalMs: 10, logger })
    viaLogger.start()
    await flush()
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('[fake-worker] createFakeWorker failed to load'), expect.any(Error))
    await viaLogger.stop()

    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const viaTag = lazyWorker(failingLoad, 'createFakeWorker', '[fake-worker]')({ intervalMs: 10 })
    viaTag.start()
    await flush()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('[fake-worker] createFakeWorker failed to load'), expect.any(Error))
    await viaTag.stop()
  })
})
