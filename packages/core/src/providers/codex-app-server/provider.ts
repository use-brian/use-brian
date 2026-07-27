import { Buffer } from 'node:buffer'
import { z } from 'zod'
import type {
  ContentBlock,
  LLMProvider,
  Message,
  ProviderRequest,
  ProviderSession,
  SendOptions,
  SessionOptions,
  StreamChunk,
  TokenUsage,
  ToolDefinition,
} from '../types.js'
import type { CodexRpcPeer } from './rpc.js'
import { CodexRpcRemoteError } from './rpc.js'
import {
  AgentMessageDeltaNotificationSchema,
  DynamicToolCallParamsSchema,
  DynamicToolCallResponseSchema,
  ReasoningSummaryTextDeltaNotificationSchema,
  ReasoningTextDeltaNotificationSchema,
  ThreadInjectItemsResponseSchema,
  ThreadStartResponseSchema,
  ThreadTokenUsageUpdatedNotificationSchema,
  ThreadUnsubscribeResponseSchema,
  TurnCompletedNotificationSchema,
  TurnStartResponseSchema,
  type DynamicToolCallParams,
  type DynamicToolCallResponse,
  type ThreadTokenUsageUpdatedNotification,
  type TurnCompletedNotification,
} from './protocol.js'

const MAX_SYSTEM_PROMPT_BYTES = 512 * 1024
const MAX_HISTORY_ITEM_BYTES = 256 * 1024
const MAX_HISTORY_BATCH_BYTES = 512 * 1024
const MAX_HISTORY_ITEMS = 2_000
const MAX_TOOL_CALLS_PER_BATCH = 64
const MAX_TOOL_OUTPUT_BYTES = 1024 * 1024
const TOOL_BATCH_QUIET_MS = 10
const TOOL_RESULT_TIMEOUT_MS = 2 * 60 * 1000
const SESSION_IDLE_UNSUBSCRIBE_MS = 5 * 60 * 1000
const TRUNCATION_MARKER = '\n\n[truncated by Brian at the provider boundary]'

const ToolArgumentsSchema = z.record(z.unknown())

type CodexProviderTransport = {
  rpc: CodexRpcPeer
  cwd: string
}

export type CreateCodexAppServerProviderOptions = {
  transport: CodexProviderTransport
  /** Exact account-scoped model ids returned by Codex model/list. */
  models: readonly string[]
  toolBatchQuietMs?: number
  toolResultTimeoutMs?: number
  sessionIdleUnsubscribeMs?: number
}

type CodexSessionInit = SessionOptions & {
  outputSchema?: Record<string, unknown>
}

type ParkedToolCall = {
  call: DynamicToolCallParams
  resolve: (response: DynamicToolCallResponse) => void
  timeout: ReturnType<typeof setTimeout>
}

type UserInput =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string }
  | { type: 'audio'; url: string }

/**
 * ChatGPT-subscription provider backed by the pinned Codex app-server.
 *
 * The provider never receives OAuth tokens. It speaks only to a process that
 * was started with the hardened inference surface from process.ts.
 */
export function createCodexAppServerProvider(
  options: CreateCodexAppServerProviderOptions,
): LLMProvider {
  const models = uniqueModelIds(options.models)
  const runtime = new CodexProviderRuntime(options.transport, {
    toolBatchQuietMs: positiveInteger(
      options.toolBatchQuietMs,
      TOOL_BATCH_QUIET_MS,
      'toolBatchQuietMs',
    ),
    toolResultTimeoutMs: positiveInteger(
      options.toolResultTimeoutMs,
      TOOL_RESULT_TIMEOUT_MS,
      'toolResultTimeoutMs',
    ),
    sessionIdleUnsubscribeMs: positiveInteger(
      options.sessionIdleUnsubscribeMs,
      SESSION_IDLE_UNSUBSCRIBE_MS,
      'sessionIdleUnsubscribeMs',
    ),
  })

  const createSession = (sessionOptions: CodexSessionInit): CodexProviderSession => {
    if (!models.includes(sessionOptions.model)) {
      throw new Error(
        `[openai-codex] model '${sessionOptions.model}' is not in the authenticated Codex catalog`,
      )
    }
    return runtime.createSession(sessionOptions)
  }

  return {
    name: 'openai-codex',
    models,

    async *stream(request: ProviderRequest): AsyncIterable<StreamChunk> {
      const session = createSession({
        model: request.model,
        systemPrompt: request.systemPrompt,
        tools: request.tools,
        maxTokens: request.maxTokens,
        temperature: request.temperature,
        thinkingLevel: request.thinkingLevel,
        signal: request.signal,
        ...(request.responseFormat === 'json' && request.responseSchema
          ? { outputSchema: request.responseSchema }
          : {}),
      })
      try {
        yield* session.send(request.messages, {
          ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}),
        })
      } finally {
        await session.dispose()
      }
    },

    createSession,
  }
}

class CodexProviderRuntime {
  readonly #transport: CodexProviderTransport
  readonly #toolBatchQuietMs: number
  readonly #toolResultTimeoutMs: number
  readonly #sessionIdleUnsubscribeMs: number
  readonly #sessions = new Map<string, CodexProviderSession>()
  readonly #removers: Array<() => void> = []
  #closedReason: Error | undefined

  constructor(
    transport: CodexProviderTransport,
    options: {
      toolBatchQuietMs: number
      toolResultTimeoutMs: number
      sessionIdleUnsubscribeMs: number
    },
  ) {
    this.#transport = transport
    this.#toolBatchQuietMs = options.toolBatchQuietMs
    this.#toolResultTimeoutMs = options.toolResultTimeoutMs
    this.#sessionIdleUnsubscribeMs = options.sessionIdleUnsubscribeMs

    this.#removers.push(
      transport.rpc.onRequest('item/tool/call', (params) => this.#handleToolCall(params)),
      transport.rpc.onNotification('item/agentMessage/delta', (params) => {
        this.#handleNotification(params, AgentMessageDeltaNotificationSchema, (session, parsed) => {
          session.onTextDelta(parsed.turnId, parsed.delta)
        })
      }),
      transport.rpc.onNotification('item/reasoning/textDelta', (params) => {
        this.#handleNotification(params, ReasoningTextDeltaNotificationSchema, (session, parsed) => {
          session.onThinkingDelta(parsed.turnId, parsed.delta)
        })
      }),
      transport.rpc.onNotification('item/reasoning/summaryTextDelta', (params) => {
        this.#handleNotification(
          params,
          ReasoningSummaryTextDeltaNotificationSchema,
          (session, parsed) => {
            session.onThinkingDelta(parsed.turnId, parsed.delta)
          },
        )
      }),
      transport.rpc.onNotification('thread/tokenUsage/updated', (params) => {
        this.#handleNotification(
          params,
          ThreadTokenUsageUpdatedNotificationSchema,
          (session, parsed) => {
            session.onUsage(parsed)
          },
        )
      }),
      transport.rpc.onNotification('turn/completed', (params) => {
        this.#handleNotification(params, TurnCompletedNotificationSchema, (session, parsed) => {
          session.onTurnCompleted(parsed)
        })
      }),
      transport.rpc.onClose((reason) => {
        this.#closedReason = reason
        for (const session of this.#sessions.values()) session.onRuntimeClosed(reason)
        this.#sessions.clear()
        for (const remove of this.#removers.splice(0)) remove()
      }),
    )
  }

  createSession(options: CodexSessionInit): CodexProviderSession {
    if (this.#closedReason) throw this.#closedReason
    return new CodexProviderSession(
      this,
      this.#transport,
      options,
      this.#toolBatchQuietMs,
      this.#toolResultTimeoutMs,
      this.#sessionIdleUnsubscribeMs,
    )
  }

  register(threadId: string, session: CodexProviderSession): void {
    if (this.#closedReason) throw this.#closedReason
    if (this.#sessions.has(threadId)) {
      throw new CodexProviderProtocolError('Codex returned a duplicate thread id')
    }
    this.#sessions.set(threadId, session)
  }

  unregister(threadId: string, session: CodexProviderSession): void {
    if (this.#sessions.get(threadId) === session) this.#sessions.delete(threadId)
  }

  async #handleToolCall(params: unknown): Promise<DynamicToolCallResponse> {
    const parsed = DynamicToolCallParamsSchema.safeParse(params)
    if (!parsed.success) {
      throw new CodexProviderProtocolError('Codex emitted an invalid dynamic tool call')
    }
    const session = this.#sessions.get(parsed.data.threadId)
    if (!session) {
      return DynamicToolCallResponseSchema.parse({
        success: false,
        contentItems: [{ type: 'inputText', text: 'Brian session is no longer available.' }],
      })
    }
    return session.onToolCall(parsed.data)
  }

  #handleNotification<T extends { threadId: string }>(
    params: unknown,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    apply: (session: CodexProviderSession, parsed: T) => void,
  ): void {
    const parsed = schema.safeParse(params)
    if (!parsed.success) {
      const error = new CodexProviderProtocolError('Codex emitted an invalid inference notification')
      for (const session of this.#sessions.values()) session.onRuntimeClosed(error)
      return
    }
    const session = this.#sessions.get(parsed.data.threadId)
    if (session) {
      // JSONL frames can contain the turn/start response and the first
      // notification in one stream chunk. Wait on the explicit turn-start
      // barrier; a single microtask is insufficient because rpc.request()
      // itself adopts the correlated response promise.
      void session.whenTurnReady().then(() => {
        if (this.#sessions.get(parsed.data.threadId) === session) {
          apply(session, parsed.data)
        }
      })
    }
  }
}

class CodexProviderSession implements ProviderSession {
  readonly #runtime: CodexProviderRuntime
  readonly #transport: CodexProviderTransport
  readonly #options: CodexSessionInit
  readonly #allowedTools: ReadonlyMap<string, ToolDefinition>
  readonly #toolBatchQuietMs: number
  readonly #toolResultTimeoutMs: number
  readonly #sessionIdleUnsubscribeMs: number

  #threadId: string | undefined
  #activeTurnId: string | undefined
  #turnStartReady: Promise<void> | undefined
  #releaseTurnStart: (() => void) | undefined
  #activeQueue: AsyncStreamQueue<StreamChunk> | undefined
  #parked = new Map<string, ParkedToolCall>()
  #toolBatchTimer: ReturnType<typeof setTimeout> | undefined
  #idleTimer: ReturnType<typeof setTimeout> | undefined
  #abortListener: (() => void) | undefined
  #lastUsage: TokenUsage = emptyUsage()
  #sendActive = false
  #disposed = false
  #closedReason: Error | undefined

  constructor(
    runtime: CodexProviderRuntime,
    transport: CodexProviderTransport,
    options: CodexSessionInit,
    toolBatchQuietMs: number,
    toolResultTimeoutMs: number,
    sessionIdleUnsubscribeMs: number,
  ) {
    this.#runtime = runtime
    this.#transport = transport
    this.#options = {
      ...options,
      systemPrompt: truncateUtf8(options.systemPrompt, MAX_SYSTEM_PROMPT_BYTES),
    }
    this.#allowedTools = validateTools(options.tools ?? [])
    this.#toolBatchQuietMs = toolBatchQuietMs
    this.#toolResultTimeoutMs = toolResultTimeoutMs
    this.#sessionIdleUnsubscribeMs = sessionIdleUnsubscribeMs

    if (options.signal) {
      const onAbort = () => {
        const error = abortError('Codex app-server turn aborted')
        this.#closedReason = error
        this.#activeQueue?.fail(error)
        this.#failParked('Brian cancelled the tool call.')
        void this.#interruptActiveTurn()
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
      this.#abortListener = () => options.signal?.removeEventListener('abort', onAbort)
    }
  }

  send(messages: Message[], opts: SendOptions = {}): AsyncIterable<StreamChunk> {
    return this.#send(messages, opts)
  }

  async *#send(messages: Message[], opts: SendOptions): AsyncIterable<StreamChunk> {
    if (this.#sendActive) {
      throw new CodexProviderProtocolError('Concurrent sends are not supported in one Codex session')
    }
    if (this.#disposed) throw new Error('Codex provider session is disposed')
    if (this.#closedReason) throw this.#closedReason
    if (this.#options.signal?.aborted) throw abortError('Codex app-server turn aborted')

    this.#sendActive = true
    this.#cancelIdleTimer()
    const queue = new AsyncStreamQueue<StreamChunk>()
    this.#activeQueue = queue
    queue.push({ type: 'message_start', model: this.#options.model })

    try {
      if (this.#parked.size > 0) {
        this.#resumeParkedTools(messages)
      } else {
        await this.#startFreshTurn(messages, opts)
      }
      yield* queue
    } catch (error) {
      this.#failParked('Brian could not resume the tool call.')
      queue.fail(asError(error))
      throw error
    } finally {
      if (this.#activeQueue === queue) this.#activeQueue = undefined
      this.#sendActive = false
    }
  }

  async #startFreshTurn(messages: Message[], opts: SendOptions): Promise<void> {
    if (this.#activeTurnId) {
      throw new CodexProviderProtocolError(
        'Cannot start a new Codex turn while the previous turn is still active',
      )
    }

    let currentMessages = messages
    if (!this.#threadId) {
      if (messages.length === 0) {
        throw new TypeError('The first Codex provider send requires at least one message')
      }
      await this.#startThread()
      const history = messages.slice(0, -1)
      currentMessages = messages.slice(-1)
      await this.#injectHistory(history)
    }

    const input = messagesToUserInput(currentMessages)
    if (input.length === 0) {
      throw new TypeError('Codex provider turn input cannot be empty')
    }
    const thinkingLevel = opts.thinkingLevel ?? this.#options.thinkingLevel
    const params = {
      threadId: this.#threadId,
      input,
      environments: [],
      ...(thinkingLevel ? { effort: mapThinkingLevel(thinkingLevel) } : {}),
    }
    this.#turnStartReady = new Promise<void>((resolve) => {
      this.#releaseTurnStart = resolve
    })
    let response
    try {
      try {
        response = await this.#transport.rpc.request(
          'turn/start',
          {
            ...params,
            ...(this.#options.outputSchema ? { outputSchema: this.#options.outputSchema } : {}),
          },
          TurnStartResponseSchema,
          { signal: this.#options.signal },
        )
      } catch (error) {
        // Structured-output schemas are advisory at the provider boundary.
        // Only an invalid-params rejection is retried, once, without the schema;
        // auth, quota, transport, and model errors retain their real failure.
        if (!(this.#options.outputSchema && isInvalidParamsError(error))) throw error
        response = await this.#transport.rpc.request(
          'turn/start',
          params,
          TurnStartResponseSchema,
          { signal: this.#options.signal },
        )
      }
    } catch (error) {
      this.#releaseTurnStart?.()
      this.#releaseTurnStart = undefined
      this.#turnStartReady = undefined
      throw error
    }
    if (response.turn.status !== 'inProgress') {
      this.#releaseTurnStart?.()
      this.#releaseTurnStart = undefined
      this.#turnStartReady = undefined
      throw new CodexProviderProtocolError('Codex did not start the requested turn')
    }
    this.#activeTurnId = response.turn.id
    this.#releaseTurnStart?.()
    this.#releaseTurnStart = undefined
    this.#turnStartReady = undefined
  }

  async #startThread(): Promise<void> {
    const response = await this.#transport.rpc.request(
      'thread/start',
      {
        model: this.#options.model,
        baseInstructions: this.#options.systemPrompt,
        developerInstructions: null,
        dynamicTools: Array.from(this.#allowedTools.values(), (tool) => ({
          type: 'function',
          name: tool.name,
          description: tool.description,
          inputSchema: tool.parameters,
        })),
        cwd: this.#transport.cwd,
        ephemeral: true,
        allowProviderModelFallback: false,
        approvalPolicy: {
          granular: {
            mcp_elicitations: false,
            request_permissions: false,
            rules: false,
            sandbox_approval: false,
            skill_approval: false,
          },
        },
        approvalsReviewer: 'user',
        sandbox: 'read-only',
        environments: [],
        runtimeWorkspaceRoots: [],
        selectedCapabilityRoots: [],
      },
      ThreadStartResponseSchema,
      { signal: this.#options.signal },
    )
    if (response.model !== this.#options.model) {
      throw new CodexProviderProtocolError('Codex silently substituted the requested model')
    }
    this.#threadId = response.thread.id
    this.#runtime.register(response.thread.id, this)
  }

  async #injectHistory(messages: Message[]): Promise<void> {
    if (messages.length === 0) return
    if (!this.#threadId) throw new CodexProviderProtocolError('Codex thread is not initialized')

    const items = messages.flatMap(messageToInjectedItems)
    if (items.length > MAX_HISTORY_ITEMS) {
      throw new CodexProviderProtocolError(
        `Codex history exceeds the ${MAX_HISTORY_ITEMS}-item provider boundary`,
      )
    }
    const batches = batchJsonItems(items, MAX_HISTORY_BATCH_BYTES)
    for (const batch of batches) {
      await this.#transport.rpc.request(
        'thread/inject_items',
        { threadId: this.#threadId, items: batch },
        ThreadInjectItemsResponseSchema,
        { signal: this.#options.signal },
      )
    }
  }

  async onToolCall(call: DynamicToolCallParams): Promise<DynamicToolCallResponse> {
    await this.whenTurnReady()
    if (this.#disposed || this.#closedReason) {
      return failedToolResponse('Brian session is no longer available.')
    }
    if (!this.#threadId || call.threadId !== this.#threadId) {
      throw new CodexProviderProtocolError('Codex dynamic tool call targeted the wrong thread')
    }
    if (!this.#activeTurnId || call.turnId !== this.#activeTurnId) {
      throw new CodexProviderProtocolError('Codex dynamic tool call targeted the wrong turn')
    }
    if (call.namespace != null) {
      throw new CodexProviderProtocolError('Codex emitted an unexpected tool namespace')
    }
    if (!this.#allowedTools.has(call.tool)) {
      throw new CodexProviderProtocolError('Codex called a tool outside the Brian allowlist')
    }
    if (this.#parked.has(call.callId)) {
      throw new CodexProviderProtocolError('Codex emitted a duplicate dynamic tool call id')
    }
    if (this.#parked.size >= MAX_TOOL_CALLS_PER_BATCH) {
      throw new CodexProviderProtocolError('Codex dynamic tool batch exceeded its hard limit')
    }
    const args = ToolArgumentsSchema.safeParse(call.arguments)
    if (!args.success) {
      throw new CodexProviderProtocolError('Codex dynamic tool arguments must be an object')
    }
    if (!this.#activeQueue) {
      throw new CodexProviderProtocolError('Codex emitted a tool call outside an active send')
    }

    const response = new Promise<DynamicToolCallResponse>((resolve) => {
      const timeout = setTimeout(() => {
        const parked = this.#parked.get(call.callId)
        if (!parked) return
        this.#parked.delete(call.callId)
        parked.resolve(failedToolResponse('Brian timed out waiting for the tool result.'))
      }, this.#toolResultTimeoutMs)
      timeout.unref?.()
      this.#parked.set(call.callId, { call: { ...call, arguments: args.data }, resolve, timeout })
    })

    const serializedArgs = JSON.stringify(args.data)
    this.#activeQueue.push({ type: 'tool_use_start', id: call.callId, name: call.tool })
    this.#activeQueue.push({
      type: 'tool_use_delta',
      id: call.callId,
      input: serializedArgs,
    })
    this.#activeQueue.push({ type: 'tool_use_end', id: call.callId })
    this.#scheduleToolBatchEnd()

    return response
  }

  async whenTurnReady(): Promise<void> {
    await this.#turnStartReady
  }

  #scheduleToolBatchEnd(): void {
    if (this.#toolBatchTimer) clearTimeout(this.#toolBatchTimer)
    this.#toolBatchTimer = setTimeout(() => {
      this.#toolBatchTimer = undefined
      const queue = this.#activeQueue
      if (!queue || queue.ended) return
      queue.push({
        type: 'message_end',
        stopReason: 'tool_use',
        usage: this.#takeUsage(),
      })
      queue.end()
      if (this.#activeQueue === queue) this.#activeQueue = undefined
    }, this.#toolBatchQuietMs)
    this.#toolBatchTimer.unref?.()
  }

  #resumeParkedTools(messages: Message[]): void {
    const results = new Map<string, Extract<ContentBlock, { type: 'tool_result' }>>()
    const guidance: string[] = []
    for (const message of messages) {
      const blocks: ContentBlock[] =
        typeof message.content === 'string'
          ? [{ type: 'text', text: message.content }]
          : message.content
      for (const block of blocks) {
        if (block.type === 'tool_result') {
          if (results.has(block.toolUseId)) {
            throw new CodexProviderProtocolError('Duplicate Brian tool result id')
          }
          results.set(block.toolUseId, block)
        } else if (block.type === 'text' && block.text.trim().length > 0) {
          guidance.push(block.text)
        } else if (block.type !== 'text') {
          throw new CodexProviderProtocolError(
            'Only tool results and text guidance may resume a parked Codex turn',
          )
        }
      }
    }

    const pendingIds = new Set(this.#parked.keys())
    const missing = Array.from(pendingIds).filter((id) => !results.has(id))
    const extra = Array.from(results.keys()).filter((id) => !pendingIds.has(id))
    if (missing.length > 0 || extra.length > 0) {
      throw new CodexProviderProtocolError(
        `Codex tool-result batch mismatch (missing=${missing.length}, extra=${extra.length})`,
      )
    }

    const parked = Array.from(this.#parked.values())
    this.#parked.clear()
    parked.forEach((entry, index) => {
      clearTimeout(entry.timeout)
      const result = results.get(entry.call.callId)
      if (!result) {
        entry.resolve(failedToolResponse('Brian did not return a matching tool result.'))
        return
      }
      if (result.name !== entry.call.tool) {
        entry.resolve(failedToolResponse('Brian returned a result for the wrong tool.'))
        return
      }
      const contentItems: DynamicToolCallResponse['contentItems'] = [
        {
          type: 'inputText',
          text: truncateUtf8(result.content, MAX_TOOL_OUTPUT_BYTES),
        },
      ]
      if (index === parked.length - 1 && guidance.length > 0) {
        contentItems.push({
          type: 'inputText',
          text: truncateUtf8(`Brian guidance:\n${guidance.join('\n\n')}`, MAX_TOOL_OUTPUT_BYTES),
        })
      }
      entry.resolve(
        DynamicToolCallResponseSchema.parse({
          success: result.isError !== true,
          contentItems,
        }),
      )
    })
  }

  onTextDelta(turnId: string, delta: string): void {
    if (turnId === this.#activeTurnId) {
      this.#activeQueue?.push({ type: 'text_delta', text: delta })
    }
  }

  onThinkingDelta(turnId: string, delta: string): void {
    if (turnId === this.#activeTurnId) {
      this.#activeQueue?.push({ type: 'thinking_delta', text: delta })
    }
  }

  onUsage(notification: ThreadTokenUsageUpdatedNotification): void {
    if (notification.turnId !== this.#activeTurnId) return
    const usage = notification.tokenUsage.last
    this.#lastUsage = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cachedInputTokens,
      cacheWriteTokens: usage.cacheWriteInputTokens,
    }
  }

  onTurnCompleted(notification: TurnCompletedNotification): void {
    if (notification.turn.id !== this.#activeTurnId) return
    const queue = this.#activeQueue
    this.#activeTurnId = undefined

    if (notification.turn.status === 'failed') {
      const error = new CodexTurnError()
      queue?.fail(error)
      this.#failParked('The Codex turn failed.')
      this.#scheduleIdleUnsubscribe()
      return
    }
    if (notification.turn.status === 'interrupted') {
      const error = this.#options.signal?.aborted
        ? abortError('Codex app-server turn aborted')
        : new CodexTurnError('Codex app-server turn was interrupted')
      queue?.fail(error)
      this.#failParked('The Codex turn was interrupted.')
      this.#scheduleIdleUnsubscribe()
      return
    }
    if (notification.turn.status !== 'completed') {
      queue?.fail(new CodexProviderProtocolError('Codex completed a turn with an invalid status'))
      return
    }

    if (queue && !queue.ended) {
      queue.push({
        type: 'message_end',
        stopReason: 'end_turn',
        usage: this.#takeUsage(),
      })
      queue.end()
    }
    if (this.#activeQueue === queue) this.#activeQueue = undefined
    this.#scheduleIdleUnsubscribe()
  }

  onRuntimeClosed(reason: Error): void {
    if (this.#closedReason) return
    this.#closedReason = reason
    this.#activeQueue?.fail(reason)
    this.#failParked('Codex app-server stopped before the tool completed.')
    this.#cancelIdleTimer()
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#abortListener?.()
    this.#cancelIdleTimer()
    if (this.#toolBatchTimer) clearTimeout(this.#toolBatchTimer)
    this.#toolBatchTimer = undefined
    this.#failParked('Brian closed the Codex session.')
    await this.#interruptActiveTurn()
    await this.#unsubscribe()
  }

  async #interruptActiveTurn(): Promise<void> {
    if (!this.#threadId || !this.#activeTurnId || this.#transport.rpc.closed) return
    const threadId = this.#threadId
    const turnId = this.#activeTurnId
    this.#activeTurnId = undefined
    try {
      await this.#transport.rpc.request(
        'turn/interrupt',
        { threadId, turnId },
        z.object({}).passthrough(),
        { timeoutMs: 5_000 },
      )
    } catch {
      // Best-effort cancellation; process shutdown remains the outer fallback.
    }
  }

  #scheduleIdleUnsubscribe(): void {
    this.#cancelIdleTimer()
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = undefined
      void this.#unsubscribe()
    }, this.#sessionIdleUnsubscribeMs)
    this.#idleTimer.unref?.()
  }

  #cancelIdleTimer(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer)
    this.#idleTimer = undefined
  }

  async #unsubscribe(): Promise<void> {
    if (!this.#threadId) return
    const threadId = this.#threadId
    this.#threadId = undefined
    this.#runtime.unregister(threadId, this)
    if (this.#transport.rpc.closed) return
    try {
      await this.#transport.rpc.request(
        'thread/unsubscribe',
        { threadId },
        ThreadUnsubscribeResponseSchema,
        { timeoutMs: 5_000 },
      )
    } catch {
      // Ephemeral thread cleanup is best effort and never hides turn output.
    }
  }

  #failParked(message: string): void {
    for (const parked of this.#parked.values()) {
      clearTimeout(parked.timeout)
      parked.resolve(failedToolResponse(message))
    }
    this.#parked.clear()
  }

  #takeUsage(): TokenUsage {
    const usage = this.#lastUsage
    this.#lastUsage = emptyUsage()
    return usage
  }
}

export class CodexProviderProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexProviderProtocolError'
  }
}

export class CodexTurnError extends Error {
  constructor(message = 'Codex app-server turn failed') {
    super(message)
    this.name = 'CodexTurnError'
  }
}

class AsyncStreamQueue<T> implements AsyncIterable<T> {
  #values: T[] = []
  #waiters: Array<() => void> = []
  #ended = false
  #error: Error | undefined

  get ended(): boolean {
    return this.#ended
  }

  push(value: T): void {
    if (this.#ended) return
    this.#values.push(value)
    this.#wake()
  }

  end(): void {
    if (this.#ended) return
    this.#ended = true
    this.#wake()
  }

  fail(error: Error): void {
    if (this.#ended) return
    this.#error = error
    this.#ended = true
    this.#wake()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      while (this.#values.length > 0) yield this.#values.shift()!
      if (this.#error) throw this.#error
      if (this.#ended) return
      await new Promise<void>((resolve) => this.#waiters.push(resolve))
    }
  }

  #wake(): void {
    for (const resolve of this.#waiters.splice(0)) resolve()
  }
}

function validateTools(tools: readonly ToolDefinition[]): ReadonlyMap<string, ToolDefinition> {
  const result = new Map<string, ToolDefinition>()
  for (const tool of tools) {
    if (!/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(tool.name)) {
      throw new TypeError(`Invalid Brian dynamic tool name: ${tool.name}`)
    }
    if (result.has(tool.name)) throw new TypeError(`Duplicate Brian dynamic tool: ${tool.name}`)
    if (tool.description.length === 0 || tool.description.length > 16_384) {
      throw new TypeError(`Invalid Brian dynamic tool description: ${tool.name}`)
    }
    result.set(tool.name, tool)
  }
  return result
}

function uniqueModelIds(models: readonly string[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const model of models) {
    if (model.length === 0 || model.length > 256) throw new TypeError('Invalid Codex model id')
    if (seen.has(model)) throw new TypeError(`Duplicate Codex model id: ${model}`)
    seen.add(model)
    result.push(model)
  }
  if (result.length === 0) throw new TypeError('Codex provider requires at least one catalog model')
  return result
}

function mapThinkingLevel(level: 'low' | 'high' | undefined): 'low' | 'high' | undefined {
  return level
}

function messagesToUserInput(messages: readonly Message[]): UserInput[] {
  const input: UserInput[] = []
  for (const message of messages) {
    const blocks: ContentBlock[] =
      typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : message.content
    for (const block of blocks) {
      if (block.type === 'text') {
        input.push({ type: 'text', text: truncateUtf8(block.text, MAX_HISTORY_ITEM_BYTES) })
      } else if (block.type === 'image') {
        input.push({
          type: block.mimeType.startsWith('audio/') ? 'audio' : 'image',
          url: `data:${block.mimeType};base64,${block.data}`,
        })
      } else if (block.type === 'tool_result') {
        input.push({
          type: 'text',
          text: truncateUtf8(
            `[Brian tool result: ${block.name}${block.isError ? ' (error)' : ''}]\n${block.content}`,
            MAX_HISTORY_ITEM_BYTES,
          ),
        })
      } else {
        input.push({
          type: 'text',
          text: truncateUtf8(
            `[Prior Brian tool call: ${block.name}]\n${JSON.stringify(block.input)}`,
            MAX_HISTORY_ITEM_BYTES,
          ),
        })
      }
    }
  }
  return input
}

function messageToInjectedItems(message: Message): unknown[] {
  const blocks: ContentBlock[] =
    typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content
  const items: unknown[] = []
  const content: unknown[] = []

  for (const block of blocks) {
    if (block.type === 'text') {
      content.push({
        type: message.role === 'assistant' ? 'output_text' : 'input_text',
        text: truncateUtf8(block.text, MAX_HISTORY_ITEM_BYTES),
        ...(message.role === 'assistant' ? { annotations: [] } : {}),
      })
    } else if (block.type === 'image') {
      if (message.role === 'assistant') {
        content.push({
          type: 'output_text',
          text: `[Prior assistant image: ${block.mimeType}]`,
          annotations: [],
        })
      } else {
        content.push({
          type: 'input_image',
          image_url: `data:${block.mimeType};base64,${block.data}`,
        })
      }
    }
  }

  if (content.length > 0) {
    items.push({
      type: 'message',
      role: message.role === 'system' ? 'developer' : message.role,
      content,
    })
  }
  for (const block of blocks) {
    if (block.type === 'tool_use') {
      items.push({
        type: 'function_call',
        call_id: block.id,
        name: block.name,
        arguments: truncateUtf8(JSON.stringify(block.input), MAX_HISTORY_ITEM_BYTES),
      })
    } else if (block.type === 'tool_result') {
      items.push({
        type: 'function_call_output',
        call_id: block.toolUseId,
        output: truncateUtf8(block.content, MAX_HISTORY_ITEM_BYTES),
      })
    }
  }
  return items
}

function batchJsonItems(items: readonly unknown[], maxBytes: number): unknown[][] {
  const batches: unknown[][] = []
  let current: unknown[] = []
  let currentBytes = 2
  for (const item of items) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item)) + (current.length > 0 ? 1 : 0)
    if (itemBytes > maxBytes) {
      throw new CodexProviderProtocolError('One Codex history item exceeds the RPC boundary')
    }
    if (current.length > 0 && currentBytes + itemBytes > maxBytes) {
      batches.push(current)
      current = []
      currentBytes = 2
    }
    current.push(item)
    currentBytes += itemBytes
  }
  if (current.length > 0) batches.push(current)
  return batches
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value)
  if (bytes.length <= maxBytes) return value
  const marker = Buffer.from(TRUNCATION_MARKER)
  const available = Math.max(0, maxBytes - marker.length)
  return `${bytes.subarray(0, available).toString('utf8')}${TRUNCATION_MARKER}`
}

function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
}

function failedToolResponse(message: string): DynamicToolCallResponse {
  return DynamicToolCallResponseSchema.parse({
    success: false,
    contentItems: [{ type: 'inputText', text: message }],
  })
}

function abortError(message: string): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive integer`)
  }
  return resolved
}

function isInvalidParamsError(error: unknown): boolean {
  return error instanceof CodexRpcRemoteError && error.code === -32602
}
