/**
 * Lazy implementations (M4 step 5, D13): what a registered tool, adapter or
 * exported function needs only to execute (a sandbox SDK, a renderer, a
 * parser, a mail client, an execute-only authority adapter) loads on its first
 * call instead of at module evaluation, so it leaves the eager boot graph.
 *
 * The registered object stays eager: a `Tool` keeps its name, schema, safety,
 * confirmation and capability metadata; an exported function keeps its name
 * and signature. The load runs inside the first call, so it runs under
 * whatever wrapper the caller already holds (the owner-bound tool, the turn's
 * runtime-authority `wrapTool`, the executor). Declared here, below core and
 * api, so leaf modules in both can bind their heavy packages the same way.
 *
 * - `lazyImplementation(name, load)` returns a memoized loader. Concurrent
 *   first calls share one load. A load failure is logged once with its cause
 *   and rejects with {@link ImplementationUnavailableError} (no effect,
 *   retryable); calls inside the next {@link LAZY_IMPLEMENTATION_RETRY_MS}
 *   fail the same way without reloading, and the next call after it retries.
 * - `lazyFunction(name, load)` is an async function with the loaded
 *   function's signature.
 * - `lazyAdapter(name, build, methods)` is an object whose listed async
 *   methods build the adapter once (`build` may load a module and call its
 *   factory) and delegate to it.
 *
 * The capability catalog maps the error to its existing `unavailable`
 * activation outcome (`packages/api/src/mcp/catalog.ts`), so a failed load is
 * never a silent skip, a missing tool or a fall-through.
 *
 * [COMP:tools/lazy-implementation]
 * Spec: docs/architecture/platform/deployment.md -> "Boot composition" ->
 * "Lazy tool implementations"; docs/architecture/integrations/mcp.md ->
 * "Provider activation" (implementation loads on activation).
 */

/** Milliseconds a failed implementation waits before a call retries its load. */
export const LAZY_IMPLEMENTATION_RETRY_MS = 5_000

/**
 * A tool implementation could not be loaded, so the call did nothing. The
 * message is written for the model: what failed, that nothing ran, that the
 * request is not at fault, and the retry verdict.
 */
export class ImplementationUnavailableError extends Error {
  readonly code = 'implementation_unavailable' as const
  readonly effect = 'none' as const
  readonly retryable = true as const
  readonly implementation: string

  constructor(implementation: string, options?: { cause?: unknown }) {
    super(
      `${implementation} could not be loaded on this server, so nothing ran and nothing was changed. ` +
        'This is a temporary server-side availability problem, not a problem with the request: do not retry with ' +
        'different arguments. Tell the user this capability is unavailable right now; a later attempt may succeed.',
      options,
    )
    this.name = 'ImplementationUnavailableError'
    this.implementation = implementation
  }
}

export function isImplementationUnavailable(error: unknown): error is ImplementationUnavailableError {
  return error instanceof ImplementationUnavailableError
}

/** Memoized loader of an implementation. See the module comment for failure semantics. */
export function lazyImplementation<M>(name: string, load: () => Promise<M>): () => Promise<M> {
  let ready: { value: M } | null = null
  let pending: Promise<M> | null = null
  let retryAt = 0
  let lastError: unknown
  return () => {
    if (ready) return Promise.resolve(ready.value)
    if (pending) return pending
    if (Date.now() < retryAt) return Promise.reject(new ImplementationUnavailableError(name, { cause: lastError }))
    const attempt = (async () => load())().then(
      (value) => {
        ready = { value }
        pending = null
        return value
      },
      (error: unknown) => {
        pending = null
        retryAt = Date.now() + LAZY_IMPLEMENTATION_RETRY_MS
        lastError = error
        console.error(
          `[lazy] implementation ${name} failed to load; calls that need it fail as unavailable until a retry after ${LAZY_IMPLEMENTATION_RETRY_MS / 1_000}s succeeds:`,
          error,
        )
        throw new ImplementationUnavailableError(name, { cause: error })
      },
    )
    pending = attempt
    return attempt
  }
}

type AsyncFunction = (...args: never[]) => Promise<unknown>

/** An async function that loads its implementation on first call and delegates to it. */
export function lazyFunction<F extends AsyncFunction>(name: string, load: () => Promise<F>): F {
  const get = lazyImplementation(name, async () => {
    const fn: unknown = await load()
    if (typeof fn !== 'function') throw new Error(`${name} did not load a function`)
    return fn as F
  })
  return (async (...args: Parameters<F>) => (await get())(...args)) as unknown as F
}

/** Keys of `T` whose value is an async method. */
type AsyncMethodKey<T> = { [K in keyof T]: T[K] extends AsyncFunction ? K : never }[keyof T]

/**
 * An adapter whose listed async methods build the real adapter on first call
 * and delegate to it (same `this`, same arguments, same result).
 */
export function lazyAdapter<T, K extends AsyncMethodKey<T>>(name: string, build: () => Promise<T>, methods: readonly K[]): Pick<T, K> {
  const get = lazyImplementation(name, build)
  const adapter = {} as Pick<T, K>
  for (const method of methods) {
    adapter[method] = (async (...args: never[]) => {
      const target = await get()
      const fn = target[method] as unknown
      if (typeof fn !== 'function') throw new ImplementationUnavailableError(name, { cause: new Error(`${String(method)} is not implemented`) })
      return (fn as AsyncFunction).apply(target, args)
    }) as Pick<T, K>[K]
  }
  return adapter
}
