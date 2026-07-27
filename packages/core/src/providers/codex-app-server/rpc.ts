import type { Readable, Writable } from 'node:stream'
import { z } from 'zod'
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

type PendingRequest<T = unknown> = {
  schema: z.ZodType<T>
  resolve: (value: T) => void
  reject: (reason: Error) => void
  timeout: ReturnType<typeof setTimeout>
  removeAbortListener?: () => void
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
}

export class CodexProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexProtocolError'
  }
}

export class CodexRpcClosedError extends Error {
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
  #writeChain: Promise<void> = Promise.resolve()
  #closedReason: Error | undefined

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

    let pending!: PendingRequest<T>
    const result = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id)
        pending.removeAbortListener?.()
        reject(new CodexProtocolError(`Codex app-server RPC request timed out: ${method}`))
      }, timeoutMs)

      pending = { schema: resultSchema, resolve, reject, timeout }

      if (options.signal) {
        const onAbort = () => {
          this.#pending.delete(id)
          clearTimeout(timeout)
          reject(abortError())
        }
        options.signal.addEventListener('abort', onAbort, { once: true })
        pending.removeAbortListener = () => options.signal?.removeEventListener('abort', onAbort)
      }

      this.#pending.set(id, pending as PendingRequest)
    })

    try {
      await this.#write({ method, id, params })
    } catch (error) {
      this.#rejectPending(id, asError(error))
    }

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
    if ('error' in message) {
      const pending = this.#takePending(message.id)
      if (!pending) {
        this.close(new CodexProtocolError('Codex app-server replied with an unknown request id'))
        return
      }
      pending.reject(new CodexRpcRemoteError(message.error))
      return
    }

    const pending = this.#takePending(message.id)
    if (!pending) {
      this.close(new CodexProtocolError('Codex app-server replied with an unknown request id'))
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
      if (!this.closed) await this.#write({ id, result: result ?? null })
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

  #write(message: unknown): Promise<void> {
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
    this.#writeChain = this.#writeChain
      .then(
        () =>
          new Promise<void>((resolve, reject) => {
            if (this.closed) {
              reject(this.#closedReason)
              return
            }
            this.#output.write(frame, (error?: Error | null) => {
              if (error) reject(error)
              else resolve()
            })
          }),
      )
      .catch((error) => {
        const reason = new CodexRpcClosedError(
          `Codex app-server stdin write failed: ${asError(error).message}`,
        )
        this.close(reason)
        throw reason
      })
    return this.#writeChain
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
