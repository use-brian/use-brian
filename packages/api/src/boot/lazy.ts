/**
 * Lazy composition seams of the boot register steps (M4 step 6, D13/D14).
 *
 * A register step that mounts a router whose handlers no chat turn needs, or
 * builds a background worker, can bind the factory through these helpers
 * instead of a static import. The step keeps its exact text: the lazy factory
 * has the factory's own name, the step calls it with the same arguments at the
 * same point (so every dependency is evaluated when it was before), and only
 * the implementation module and the factory call move to first use.
 *
 * - `lazyRoutes(load, key)(...args)` returns the request handler that sits in
 *   the mount where the router used to: mount order, path, the middleware
 *   chain before it (auth guards included) and `route-mount-order` are
 *   unchanged. The first request that reaches it loads the module and builds
 *   the router once; concurrent first requests share that load. A load or
 *   build failure answers `503 route_module_unavailable` (never a 404 or a
 *   fall-through to a later mount), is logged with its cause, and is retried
 *   on a request after `Retry-After` seconds.
 * - `lazyWorker(load, key, failure)(...args)` returns `{ start, stop }`.
 *   `start()` loads the module, builds the worker once and starts it; `stop()`
 *   stops a built worker (synchronously when its own stop is synchronous) or
 *   cancels a pending start. A worker that is never started is never loaded
 *   (`--no-workers`). A load or build failure is reported through the worker's
 *   own failure path (its `onError` option, else its `logger`, else its log
 *   tag) and retried with capped backoff until `stop()`.
 *
 * Holds no module state: every call builds per-boot state, so a second
 * `bootOpenApi` call builds a second graph (the module cache is Node's, as for
 * a static import).
 *
 * Spec: docs/architecture/platform/deployment.md -> "Boot composition" ->
 * "Lazy routers and workers".
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express'

/** Keys of `M` whose value is a factory returning `R`. */
type FactoryKey<M, R> = { [K in keyof M]: M[K] extends (...args: never[]) => R ? K : never }[keyof M]
type FactoryArgs<M, K extends keyof M, R> = Parameters<Extract<M[K], (...args: never[]) => R>>

/** Seconds a failed route module waits before a request retries its load. */
export const LAZY_ROUTE_RETRY_AFTER_SECONDS = 5
/** First and maximum retry delay of a worker whose module failed to load. */
export const LAZY_WORKER_RETRY_MS = { first: 5_000, max: 300_000 } as const

export type LazyRouteHandler = RequestHandler & { readonly lazyRoute: string }

/** Express 5 layer semantics for a handler we call ourselves: a sync throw or a rejected promise goes to `next`. */
function dispatch(handler: RequestHandler, req: Request, res: Response, next: NextFunction): void {
  try {
    const result: unknown = handler(req, res, next)
    if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
      ;(result as Promise<unknown>).then(undefined, (error: unknown) => next(error ?? new Error('Rejected promise')))
    }
  } catch (error) {
    next(error)
  }
}

function unavailable(res: Response, next: NextFunction, name: string): void {
  if (res.headersSent) {
    next(new Error(`route module ${name} unavailable`))
    return
  }
  res.status(503).set('Retry-After', String(LAZY_ROUTE_RETRY_AFTER_SECONDS)).json({
    error: 'route_module_unavailable',
    module: name,
    effect: 'none',
    retryable: true,
    retryAfterSeconds: LAZY_ROUTE_RETRY_AFTER_SECONDS,
    message: `The ${name} routes could not be loaded, so this request was not handled. Retry shortly; if it persists, the API log names the load error.`,
  })
}

/** A request handler that builds `build()` on its first request and then delegates to it. */
export function lazyRouteHandler(name: string, build: () => Promise<RequestHandler>): LazyRouteHandler {
  let ready: RequestHandler | null = null
  let pending: Promise<RequestHandler> | null = null
  let retryAt = 0
  const begin = (): Promise<RequestHandler> => {
    const attempt = build().then(
      (handler) => {
        if (typeof handler !== 'function') throw new Error(`route module ${name} did not build a request handler`)
        ready = handler
        return handler
      },
    ).catch((error: unknown) => {
      pending = null
      retryAt = Date.now() + LAZY_ROUTE_RETRY_AFTER_SECONDS * 1_000
      console.error(`[boot] route module ${name} failed to load; its mount answers 503 route_module_unavailable until a retry succeeds:`, error)
      throw error
    })
    pending = attempt
    return attempt
  }
  const handler: RequestHandler = (req, res, next) => {
    if (ready) return ready(req, res, next)
    if (!pending && Date.now() < retryAt) return unavailable(res, next, name)
    ;(pending ?? begin()).then(
      (built) => dispatch(built, req, res, next),
      () => unavailable(res, next, name),
    )
  }
  return Object.assign(handler, { lazyRoute: name })
}

/**
 * Bind a router factory lazily: `lazyRoutes(() => import('../routes/x.js'), 'xRoutes')`
 * has the type of `xRoutes` but returns a {@link LazyRouteHandler}.
 */
export function lazyRoutes<M, K extends FactoryKey<M, RequestHandler>>(load: () => Promise<M>, key: K) {
  const name = String(key)
  return (...args: FactoryArgs<M, K, RequestHandler>): LazyRouteHandler => lazyRouteHandler(name, async () => {
    const factory = (await load())[key] as unknown
    if (typeof factory !== 'function') throw new Error(`route module does not export ${name}`)
    return (factory as (...a: FactoryArgs<M, K, RequestHandler>) => RequestHandler)(...args)
  })
}

interface StartStop { start(): unknown; stop(): unknown }

export type LazyWorkerState = 'idle' | 'loading' | 'running' | 'stopped'

export interface LazyWorker {
  readonly lazyWorker: string
  readonly state: LazyWorkerState
  /** Load, build (once) and start the worker; a no-op while a start is pending. */
  start(): void
  /** Stop the built worker, or cancel a pending start. */
  stop(): Promise<void>
}

/** How a worker reports a failure today, so a load failure takes the same path. */
type FailureOptions = { onError?: unknown; logger?: { error?: unknown } } | undefined

/**
 * Bind a worker factory lazily:
 * `lazyWorker(() => import('../workers/x.js'), 'createXWorker', '[x-worker]')`
 * has the type of `createXWorker` but returns a {@link LazyWorker}. `tag` is the
 * worker's own log prefix, used when its options carry no `onError`/`logger`.
 */
export function lazyWorker<M, K extends FactoryKey<M, StartStop>>(load: () => Promise<M>, key: K, tag: string) {
  const name = String(key)
  return (...args: FactoryArgs<M, K, StartStop>): LazyWorker => {
    let state: LazyWorkerState = 'idle'
    let worker: StartStop | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let failures = 0
    const options = args[0] as FailureOptions
    const report = (error: unknown, delayMs: number) => {
      const onError = options?.onError
      const logError = options?.logger?.error
      const line = `${tag} ${name} failed to load; retrying in ${Math.round(delayMs / 1_000)}s:`
      if (typeof onError === 'function') {
        console.error(`[boot] ${line}`, error)
        try { (onError as (e: unknown) => void)(error) } catch { /* the worker's own reporter */ }
      } else if (typeof logError === 'function') {
        try { (logError as (...a: unknown[]) => void).call(options?.logger, line, error) } catch { console.error(line, error) }
      } else {
        console.error(line, error)
      }
    }
    const attempt = () => {
      load().then((module) => {
        if (state !== 'loading') return
        const factory = module[key] as unknown
        if (typeof factory !== 'function') throw new Error(`worker module does not export ${name}`)
        const built = (factory as (...a: FactoryArgs<M, K, StartStop>) => StartStop)(...args)
        built.start()
        worker = built
        state = 'running'
      }).catch((error: unknown) => {
        if (state !== 'loading') return
        failures++
        const delayMs = Math.min(LAZY_WORKER_RETRY_MS.first * 2 ** (failures - 1), LAZY_WORKER_RETRY_MS.max)
        report(error, delayMs)
        retry = setTimeout(() => { retry = null; if (state === 'loading') attempt() }, delayMs)
        retry.unref?.()
      })
    }
    return {
      lazyWorker: name,
      get state() { return state },
      start() {
        if (worker) {
          state = 'running'
          worker.start()
          return
        }
        if (state === 'loading') return
        state = 'loading'
        attempt()
      },
      stop() {
        if (retry) { clearTimeout(retry); retry = null }
        if (!worker) {
          if (state === 'loading') state = 'stopped'
          return Promise.resolve()
        }
        state = 'stopped'
        return Promise.resolve(worker.stop()).then(() => undefined)
      },
    }
  }
}
