import type { Readable, Writable } from 'node:stream'
import { z } from 'zod'
import { assertInputAuthority } from '../input-authority.js'
import {
  InboundRpcMessageSchema,
  type InboundRpcMessage,
  type RpcErrorPayload,
  type RpcId,
} from './protocol.js'

const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024
const DEFAULT_MAX_PENDING_REQUESTS = 128
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

type NotificationHandler = (params: unknown) => void | Promise<void>
type RequestHandler = (params: unknown, signal: AbortSignal) => unknown | Promise<unknown>
type CloseHandler = (reason: Error) => void
type RequestPhase = 'write_queue' | 'input_authority' | 'stdin_write' | 'awaiting_response'
type RequestProgressSnapshot = Readonly<{ phase: RequestPhase; elapsedMs: Readonly<Record<RequestPhase, number>> }>
const diagnosticMethods = ['thread/start', 'thread/inject_items', 'thread/unsubscribe', 'turn/start', 'turn/interrupt'] as const
export type CodexRpcTimeoutDiagnostics = RequestProgressSnapshot & Readonly<{ method: typeof diagnosticMethods[number] | 'other' }>

const timeoutDiagnostics = new WeakMap<object, CodexRpcTimeoutDiagnostics>()

export function readCodexRpcTimeoutDiagnostics(error: unknown): CodexRpcTimeoutDiagnostics | undefined {
  return error !== null && typeof error === 'object' ? timeoutDiagnostics.get(error) : undefined
}

class RequestProgress {
  #phase: RequestPhase = 'write_queue'
  #started = Math.floor(performance.now())
  readonly #elapsed: Record<RequestPhase, number> = { write_queue: 0, input_authority: 0, stdin_write: 0, awaiting_response: 0 }

  enter(next: RequestPhase): void {
    const now = Math.floor(performance.now())
    this.#elapsed[this.#phase] += now - this.#started
    this.#phase = next
    this.#started = now
  }

  snapshot(): RequestProgressSnapshot {
    const elapsed = { ...this.#elapsed }
    elapsed[this.#phase] += Math.floor(performance.now()) - this.#started
    return { phase: this.#phase, elapsedMs: elapsed }
  }
}

type PendingRequest<T = unknown> = {
  schema: z.ZodType<T>
  resolve: (value: T) => void
  reject: (reason: Error) => void
  timeout: ReturnType<typeof setTimeout>
  deadline: number
  timeoutError: () => Error
  cancelAdmission: () => void
  removeAbortListener?: () => void
}

type InputProof = () => Promise<void | (() => void)>
type WriteOptions = {
  check?: InputProof
  authorityOwner?: object
  signal?: AbortSignal
  assertCurrent?: () => void
  progress?: RequestProgress
}

/** Wake everyone when the current writer or authority owner is free. */
class WriteBarrier {
  #waiters = new Set<() => void>()

  wait(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError())
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.#waiters.delete(release)
        signal?.removeEventListener('abort', abort)
      }
      const release = () => { cleanup(); resolve() }
      const abort = () => { cleanup(); reject(abortError()) }
      this.#waiters.add(release)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  release(): void {
    for (const waiter of this.#waiters) waiter()
  }
}

export type CodexRpcPeerOptions = {
  input: Readable
  output: Writable
  maxFrameBytes?: number
  maxPendingRequests?: number
  requestTimeoutMs?: number
  /** Optional process-level gate for client-initiated request methods. */
  allowedRequestMethods?: ReadonlySet<string>
  /** Optional process-level gate for client-initiated notifications. */
  allowedNotificationMethods?: ReadonlySet<string>
}

export type CodexRpcRequestOptions = {
  timeoutMs?: number
  signal?: AbortSignal
  /** Host-only proof, optionally returning a synchronous submission fence. */
  assertInputAuthority?: InputProof
  /** Protected writes for one owner share one in-flight proof. */
  authorityOwner?: object
}

export class CodexProtocolError extends Error {
  readonly retrySafe = false

  constructor(message: string) {
    super(message)
    this.name = 'CodexProtocolError'
  }
}

export class CodexRpcTimeoutError extends CodexProtocolError {
  constructor(method: string, { phase, elapsedMs }: RequestProgressSnapshot) {
    const durations = Object.entries(elapsedMs).map(([name, ms]) => `${name}_ms=${ms}`)
    super(`Codex app-server RPC request timed out: ${method} (${[`phase=${phase}`, ...durations].join(', ')})`)
    timeoutDiagnostics.set(this, Object.freeze({ method: diagnosticMethods.find(name => name === method) ?? 'other',
      phase, elapsedMs: Object.freeze({ ...elapsedMs }) }))
  }
}

export class CodexRpcClosedError extends Error {
  readonly retrySafe = false

  constructor(message = 'Codex app-server RPC peer is closed') {
    super(message)
    this.name = 'CodexRpcClosedError'
  }
}

export class CodexRpcRemoteError extends Error {
  readonly code: number
  readonly data: unknown

  constructor(payload: RpcErrorPayload) {
    super(payload.message)
    this.name = 'CodexRpcRemoteError'
    this.code = payload.code
    this.data = payload.data
  }
}

export class CodexRpcPeer {
  readonly #input: Readable
  readonly #output: Writable
  readonly #maxFrameBytes: number
  readonly #maxPendingRequests: number
  readonly #requestTimeoutMs: number
  readonly #allowedRequestMethods: ReadonlySet<string> | undefined
  readonly #allowedNotificationMethods: ReadonlySet<string> | undefined

  #nextRequestId = 1
  #frameParts: Buffer[] = []
  #frameBytes = 0
  #pending = new Map<RpcId, PendingRequest>()
  #notifications = new Map<string, Set<NotificationHandler>>()
  #requestHandlers = new Map<string, RequestHandler>()
  #activeServerRequests = new Set<AbortController>()
  #closeHandlers = new Set<CloseHandler>()
  #writer: WriteBarrier | undefined
  #lastSubmission: WriteBarrier | undefined
  readonly #authorizing = new Map<object, WriteBarrier>()
  #closedReason: Error | undefined
  readonly #guardedResponses = new WeakMap<object, { value: unknown; check: InputProof; authorityOwner?: object }>()

  constructor(options: CodexRpcPeerOptions) {
    this.#input = options.input
    this.#output = options.output
    this.#maxFrameBytes = positiveInteger(options.maxFrameBytes, DEFAULT_MAX_FRAME_BYTES, 'maxFrameBytes')
    this.#maxPendingRequests = positiveInteger(
      options.maxPendingRequests,
      DEFAULT_MAX_PENDING_REQUESTS,
      'maxPendingRequests',
    )
    this.#requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      'requestTimeoutMs',
    )
    this.#allowedRequestMethods = options.allowedRequestMethods
      ? new Set(options.allowedRequestMethods)
      : undefined
    this.#allowedNotificationMethods = options.allowedNotificationMethods
      ? new Set(options.allowedNotificationMethods)
      : undefined

    this.#input.on('data', this.#onData)
    this.#input.once('end', this.#onInputEnd)
    this.#input.once('error', this.#onInputError)
    this.#output.once('error', this.#onOutputError)
  }

  get closed(): boolean {
    return this.#closedReason !== undefined
  }

  get pendingRequestCount(): number {
    return this.#pending.size
  }

  /** Opaque host value: only this peer can unwrap it at a response write. */
  guardResponse(value: unknown, check: InputProof, authorityOwner?: object): object {
    const token = Object.freeze({})
    this.#guardedResponses.set(token, { value, check, authorityOwner })
    return token
  }

  onNotification(method: string, handler: NotificationHandler): () => void {
    assertMethod(method)
    const handlers = this.#notifications.get(method) ?? new Set<NotificationHandler>()
    handlers.add(handler)
    this.#notifications.set(method, handlers)
    return () => {
      handlers.delete(handler)
      if (handlers.size === 0) this.#notifications.delete(method)
    }
  }

  onRequest(method: string, handler: RequestHandler): () => void {
    assertMethod(method)
    if (this.#requestHandlers.has(method)) {
      throw new Error(`Codex app-server request handler already registered for ${method}`)
    }
    this.#requestHandlers.set(method, handler)
    return () => {
      if (this.#requestHandlers.get(method) === handler) {
        this.#requestHandlers.delete(method)
      }
    }
  }

  onClose(handler: CloseHandler): () => void {
    this.#closeHandlers.add(handler)
    if (this.#closedReason) handler(this.#closedReason)
    return () => this.#closeHandlers.delete(handler)
  }

  async notify(method: string, params: unknown): Promise<void> {
    assertMethod(method)
    this.#assertMethodAllowed(method, this.#allowedNotificationMethods)
    this.#assertOpen()
    await this.#write({ method, params })
  }

  async request<T>(
    method: string,
    params: unknown,
    resultSchema: z.ZodType<T>,
    options: CodexRpcRequestOptions = {},
  ): Promise<T> {
    assertMethod(method)
    this.#assertMethodAllowed(method, this.#allowedRequestMethods)
    this.#assertOpen()
    if (this.#pending.size >= this.#maxPendingRequests) {
      throw new CodexProtocolError(
        `Codex app-server RPC pending request limit exceeded (${this.#maxPendingRequests})`,
      )
    }
    if (options.signal?.aborted) throw abortError()

    const id = this.#nextRequestId++
    const timeoutMs = positiveInteger(options.timeoutMs, this.#requestTimeoutMs, 'timeoutMs')
    const progress = new RequestProgress()
    const deadline = performance.now() + timeoutMs
    const timeoutError = () => new CodexRpcTimeoutError(method, progress.snapshot())
    const admission = new AbortController()

    const result = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => this.#rejectPending(id, timeoutError()), timeoutMs)
      const pending: PendingRequest<T> = { schema: resultSchema, resolve, reject, timeout, deadline, timeoutError,
        cancelAdmission: () => admission.abort() }

      if (options.signal) {
        const onAbort = () => this.#rejectPending(id, abortError())
        options.signal.addEventListener('abort', onAbort, { once: true })
        pending.removeAbortListener = () => options.signal?.removeEventListener('abort', onAbort)
      }

      this.#pending.set(id, pending as PendingRequest)
    })

    void this.#write({ method, id, params }, {
      check: options.assertInputAuthority,
      authorityOwner: options.authorityOwner,
      signal: admission.signal,
      assertCurrent: () => {
        if (admission.signal.aborted || options.signal?.aborted) throw abortError()
        if (performance.now() >= deadline) throw timeoutError()
      },
      progress,
    }).catch(error => this.#rejectPending(id, asError(error)))

    return result
  }

  close(reason: Error = new CodexRpcClosedError()): void {
    if (this.#closedReason) return
    this.#closedReason = reason

    this.#input.off('data', this.#onData)
    this.#input.off('end', this.#onInputEnd)
    this.#input.off('error', this.#onInputError)
    this.#output.off('error', this.#onOutputError)

    for (const [id] of this.#pending) this.#rejectPending(id, reason)
    for (const controller of this.#activeServerRequests) controller.abort()
    this.#activeServerRequests.clear()
    this.#writer?.release()
    for (const barrier of this.#authorizing.values()) barrier.release()
    this.#frameParts = []
    this.#frameBytes = 0

    for (const handler of this.#closeHandlers) {
      try {
        handler(reason)
      } catch {
        // Close is best-effort fan-out. One observer cannot prevent cleanup.
      }
    }
    this.#closeHandlers.clear()
  }

  readonly #onData = (chunk: Buffer | string): void => {
    if (this.closed) return
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    let cursor = 0

    while (cursor < buffer.length) {
      const newline = buffer.indexOf(0x0a, cursor)
      if (newline === -1) {
        this.#appendFramePart(buffer.subarray(cursor))
        return
      }

      this.#appendFramePart(buffer.subarray(cursor, newline))
      if (this.closed) return
      this.#consumeFrame()
      if (this.closed) return
      cursor = newline + 1
    }
  }

  readonly #onInputEnd = (): void => {
    if (this.#frameBytes > 0) {
      this.close(new CodexProtocolError('Codex app-server closed with an incomplete JSONL frame'))
      return
    }
    this.close(new CodexRpcClosedError('Codex app-server stdout closed'))
  }

  readonly #onInputError = (error: Error): void => {
    this.close(new CodexRpcClosedError(`Codex app-server stdout failed: ${error.message}`))
  }

  readonly #onOutputError = (error: Error): void => {
    this.close(new CodexRpcClosedError(`Codex app-server stdin failed: ${error.message}`))
  }

  #appendFramePart(part: Buffer): void {
    if (part.length === 0) return
    if (this.#frameBytes + part.length > this.#maxFrameBytes) {
      this.close(
        new CodexProtocolError(
          `Codex app-server JSONL frame exceeded ${this.#maxFrameBytes} bytes`,
        ),
      )
      return
    }
    this.#frameParts.push(part)
    this.#frameBytes += part.length
  }

  #consumeFrame(): void {
    let frame = Buffer.concat(this.#frameParts, this.#frameBytes)
    this.#frameParts = []
    this.#frameBytes = 0
    if (frame.at(-1) === 0x0d) frame = frame.subarray(0, -1)
    if (frame.length === 0) return

    let decoded: unknown
    try {
      decoded = JSON.parse(frame.toString('utf8'))
    } catch {
      this.close(new CodexProtocolError('Codex app-server emitted malformed JSON'))
      return
    }

    const parsed = InboundRpcMessageSchema.safeParse(decoded)
    if (!parsed.success) {
      this.close(new CodexProtocolError('Codex app-server emitted an invalid RPC envelope'))
      return
    }

    // Zod owns the runtime boundary. The explicit union restores useful
    // discriminants that Zod v3's passthrough index signature erases.
    const message = parsed.data as InboundRpcMessage
    if ('method' in message && 'id' in message) {
      void this.#handleServerRequest(message.id, message.method, message.params).catch((error) => {
        this.close(asError(error))
      })
      return
    }
    if ('method' in message) {
      this.#handleNotification(message.method, message.params)
      return
    }
    const pending = this.#takePending(message.id)
    if (!pending) {
      this.close(new CodexProtocolError('Codex app-server replied with an unknown request id'))
      return
    }
    if (performance.now() >= pending.deadline) {
      pending.reject(pending.timeoutError())
      return
    }
    if ('error' in message) {
      pending.reject(new CodexRpcRemoteError(message.error))
      return
    }
    const result = pending.schema.safeParse(message.result)
    if (!result.success) {
      pending.reject(new CodexProtocolError('Codex app-server returned an invalid method result'))
      return
    }
    pending.resolve(result.data)
  }

  #handleNotification(method: string, params: unknown): void {
    const handlers = this.#notifications.get(method)
    if (!handlers) return
    for (const handler of handlers) {
      void Promise.resolve()
        .then(() => handler(params))
        .catch(() => {
        // Notification consumers own their errors. A failed observer must not
        // tear down transport or expose notification payloads through logging.
        })
    }
  }

  async #handleServerRequest(id: RpcId, method: string, params: unknown): Promise<void> {
    if (this.#activeServerRequests.size >= this.#maxPendingRequests) {
      await this.#writeError(id, -32001, 'Server request limit exceeded')
      return
    }

    const handler = this.#requestHandlers.get(method)
    if (!handler) {
      await this.#writeError(id, -32601, 'Method not found')
      return
    }

    const controller = new AbortController()
    this.#activeServerRequests.add(controller)
    try {
      const result = await handler(params, controller.signal)
      const guarded = result && typeof result === 'object' ? this.#guardedResponses.get(result) : undefined
      if (!this.closed) await this.#write({ id, result: (guarded ? guarded.value : result) ?? null }, {
        check: guarded?.check, authorityOwner: guarded?.authorityOwner, signal: controller.signal,
      })
    } catch (error) {
      if (!this.closed) await this.#writeError(id, -32603, safeErrorMessage(error))
    } finally {
      this.#activeServerRequests.delete(controller)
    }
  }

  async #writeError(id: RpcId, code: number, message: string): Promise<void> {
    if (this.closed) return
    await this.#write({ id, error: { code, message } })
  }

  #takePending(id: RpcId): PendingRequest | undefined {
    const pending = this.#pending.get(id)
    if (!pending) return undefined
    this.#pending.delete(id)
    clearTimeout(pending.timeout)
    pending.removeAbortListener?.()
    pending.cancelAdmission()
    return pending
  }

  #rejectPending(id: RpcId, reason: Error): void {
    const pending = this.#takePending(id)
    pending?.reject(reason)
  }

  #assertOpen(): void {
    if (this.#closedReason) throw this.#closedReason
  }

  #assertMethodAllowed(method: string, allowlist: ReadonlySet<string> | undefined): void {
    if (allowlist && !allowlist.has(method)) {
      throw new CodexProtocolError(`Codex app-server RPC method is not enabled: ${method}`)
    }
  }

  async #write(message: unknown, { check, authorityOwner = check, signal, assertCurrent, progress }: WriteOptions = {}): Promise<void> {
    this.#assertOpen()
    let frame: string
    try {
      frame = `${JSON.stringify(message)}\n`
    } catch {
      const reason = new CodexProtocolError('Codex app-server outbound RPC message is not JSON serializable')
      this.close(reason)
      throw reason
    }
    if (Buffer.byteLength(frame) > this.#maxFrameBytes) {
      const reason = new CodexProtocolError(
        `Codex app-server outbound JSONL frame exceeded ${this.#maxFrameBytes} bytes`,
      )
      this.close(reason)
      throw reason
    }
    for (;;) {
      this.#assertOpen()
      assertCurrent?.()
      if (this.#writer) {
        progress?.enter('write_queue')
        await this.#writer.wait(signal)
        continue
      }
      if (!check || !authorityOwner) return this.#submitFrame(frame, progress)

      progress?.enter('input_authority')
      const previous = this.#authorizing.get(authorityOwner)
      if (previous) {
        await previous.wait(signal)
        continue
      }
      // A timed-out caller can leave an unsettled proof. Keep those proofs in
      // the cap until they actually settle, so repeated requests cannot pile up.
      if (this.#authorizing.size >= this.#maxPendingRequests) {
        throw new CodexProtocolError(`Codex app-server RPC authority check limit exceeded (${this.#maxPendingRequests})`)
      }
      const barrier = new WriteBarrier()
      this.#authorizing.set(authorityOwner, barrier)
      const lastSubmission = this.#lastSubmission
      try {
        let fence: (() => void) | undefined
        await assertInputAuthority(async () => { fence = (await check()) ?? undefined })
        this.#assertOpen()
        assertCurrent?.()
        if (this.#lastSubmission !== lastSubmission) continue
        // No await between the binding fence and handing the frame to stdin.
        fence?.()
        return this.#submitFrame(frame, progress)
      } finally {
        this.#authorizing.delete(authorityOwner)
        barrier.release()
      }
    }
  }

  async #submitFrame(frame: string, progress?: RequestProgress): Promise<void> {
    const writer = new WriteBarrier()
    this.#writer = writer
    this.#lastSubmission = writer
    try {
      progress?.enter('stdin_write')
      await new Promise<void>((resolve, reject) => {
        this.#output.write(frame, (error?: Error | null) => {
          if (error) reject(error)
          else {
            progress?.enter('awaiting_response')
            resolve()
          }
        })
      })
    } catch (error) {
      this.close(new CodexRpcClosedError(`Codex app-server stdin write failed: ${asError(error).message}`))
      throw this.#closedReason ?? error
    } finally {
      this.#writer = undefined
      writer.release()
    }
  }
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive integer`)
  }
  return resolved
}

function assertMethod(method: string): void {
  if (method.length === 0 || method.length > 256) {
    throw new TypeError('RPC method must contain between 1 and 256 characters')
  }
}

function abortError(): Error {
  const error = new Error('Codex app-server RPC request aborted')
  error.name = 'AbortError'
  return error
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error && error.name === 'AbortError'
    ? 'Request handler aborted'
    : 'Request handler failed'
}
