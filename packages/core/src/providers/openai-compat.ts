/**
 * OpenAI-compatible chat-completions provider.
 *
 * One implementation covers every vendor speaking the chat-completions
 * protocol; the first configured endpoint is Alibaba Cloud Model Studio's
 * **international** deployment (DashScope intl), which hosts the wave-1
 * Qwen / DeepSeek models (docs/plans/model-registry.md §5.1). The endpoint
 * base URL is a constant here by design — availability is registry row +
 * API key presence, never a per-endpoint env var (single-env rule).
 *
 * Protocol mapping (chat-completions SSE → provider-agnostic StreamChunk):
 *   - `delta.content`            → `text_delta`
 *   - `delta.reasoning_content`  → `thinking_delta` (Qwen thinking mode)
 *   - `delta.tool_calls[]`       → `tool_use_start` / `tool_use_delta` /
 *                                  `tool_use_end` (per-index accumulation;
 *                                  ids arrive on the first fragment)
 *   - `finish_reason`            → stop-reason map below; tool calls force
 *                                  `tool_use` (same override as gemini.ts)
 *   - final `usage`              → TokenUsage; `prompt_tokens_details.
 *                                  cached_tokens` decomposes into
 *                                  `cacheReadTokens` + net `inputTokens`
 *                                  (cost-tracker truthfulness depends on it)
 *
 * Spec: docs/architecture/platform/model-registry.md;
 * docs/architecture/engine/provider-abstraction.md.
 */
import { providerAliasMap, providerModelIds, type ModelProvider } from '@use-brian/shared/model-registry'
import type {
  ContentBlock,
  LLMProvider,
  Message,
  ProviderRequest,
  ProviderSession,
  SendOptions,
  SessionOptions,
  StopReason,
  StreamChunk,
  ThinkingLevel,
  TokenUsage,
  ToolDefinition,
} from './types.js'
import { createAccumulator } from './accumulator.js'

/** DashScope international (Singapore) — the wave-1 endpoint. */
export const DASHSCOPE_INTL_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
export const DASHSCOPE_INTL_LABEL = 'dashscope-intl'

// ── Wire types (chat-completions) ──────────────────────────────

type CCContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

type CCToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

type CCMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | CCContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: CCToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

type CCStreamToolCallDelta = {
  index: number
  id?: string
  function?: { name?: string; arguments?: string }
}

type CCStreamEvent = {
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: CCStreamToolCallDelta[] }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  } | null
}

// ── Message conversion (engine → chat-completions) ─────────────

function textOf(blocks: ContentBlock[]): string {
  return blocks.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text).join('')
}

/**
 * Map engine `Message[]` to chat-completions messages. `tool_result` blocks
 * become their own `role: 'tool'` messages (emitted before any user text in
 * the same engine message, preserving block order after the assistant turn
 * that issued the calls). Images ride as data-URL `image_url` parts — the
 * wave-1 models are text-only (the capability gate routes vision turns away
 * before this provider is reached), but the mapping is correct for any
 * future vision-capable compat model.
 */
function toCCMessages(messages: Message[]): CCMessage[] {
  const out: CCMessage[] = []
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      if (msg.content.trim().length === 0) continue
      if (msg.role === 'system') out.push({ role: 'system', content: msg.content })
      else if (msg.role === 'assistant') out.push({ role: 'assistant', content: msg.content })
      else out.push({ role: 'user', content: msg.content })
      continue
    }

    if (msg.role === 'assistant') {
      const toolCalls: CCToolCall[] = msg.content
        .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
        .map((b) => ({ id: b.id, type: 'function' as const, function: { name: b.name, arguments: JSON.stringify(b.input) } }))
      const text = textOf(msg.content)
      if (toolCalls.length === 0 && text.length === 0) continue
      out.push({
        role: 'assistant',
        content: text.length > 0 ? text : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      })
      continue
    }

    // user / system multi-block: tool results first (they must follow the
    // assistant tool_calls turn), then the remaining text/image payload.
    for (const block of msg.content) {
      if (block.type === 'tool_result') {
        out.push({ role: 'tool', tool_call_id: block.toolUseId, content: block.content })
      }
    }
    const parts: CCContentPart[] = []
    for (const block of msg.content) {
      if (block.type === 'text' && block.text.length > 0) parts.push({ type: 'text', text: block.text })
      if (block.type === 'image') {
        // OpenAI-compatible vision (Qwen-VL) decodes ONLY images via image_url.
        // A non-image inline document (e.g. `application/pdf`, which the engine
        // models as an `image` block for Gemini's native inlineData reader)
        // returns HTTP 400 "The image format is illegal and cannot be opened".
        // Content must be distilled to text upstream (chat.ts
        // `inlineDocumentDistill`); this guard degrades an undistilled or
        // history-replayed non-image block to a note so it can't wedge a turn.
        if (block.mimeType.startsWith('image/')) {
          parts.push({ type: 'image_url', image_url: { url: `data:${block.mimeType};base64,${block.data}` } })
        } else {
          parts.push({ type: 'text', text: `[A ${block.mimeType} document was attached but cannot be read inline by this model.]` })
        }
      }
    }
    if (parts.length > 0) {
      if (msg.role === 'system') {
        out.push({ role: 'system', content: parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n') })
      } else {
        out.push({ role: 'user', content: parts.every((p) => p.type === 'text') ? parts.map((p) => (p as { text: string }).text).join('') : parts })
      }
    }
  }
  return out
}

function toCCTools(tools: ToolDefinition[] | undefined) {
  if (!tools?.length) return undefined
  return tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}

export function mapCCStopReason(reason: string | null | undefined, sawToolCalls: boolean): StopReason {
  // Tool calls force 'tool_use' regardless of the raw finish_reason — the
  // query loop decides whether to execute tools on this signal (same
  // override, and same rationale, as the gemini provider).
  if (sawToolCalls) return 'tool_use'
  switch (reason) {
    case 'stop': return 'end_turn'
    case 'tool_calls': return 'tool_use'
    case 'length': return 'max_tokens'
    case 'content_filter': return 'safety'
    default: return 'incomplete'
  }
}

export function extractCCUsage(u: NonNullable<CCStreamEvent['usage']>): TokenUsage {
  const prompt = u.prompt_tokens ?? 0
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0
  return {
    // Decompose: `prompt_tokens` includes cache hits; our TokenUsage (and
    // the cost tracker) bills `inputTokens` at the full rate and
    // `cacheReadTokens` at the cache rate, so the cached share must move.
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: u.completion_tokens ?? 0,
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
  }
}

// ── SSE ────────────────────────────────────────────────────────

/** Max buffered bytes for one SSE event — same runaway guard class as the
 * gemini provider's cap; a single chat-completions event should be tiny. */
const MAX_SSE_EVENT_BYTES = 8 * 1024 * 1024

async function* sseData(res: Response): AsyncGenerator<string> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      if (buffer.length > MAX_SSE_EVENT_BYTES) {
        throw new Error(`[openai-compat] SSE event exceeded ${MAX_SSE_EVENT_BYTES} bytes — aborting stream`)
      }
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trimEnd()
        buffer = buffer.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') return
        if (payload) yield payload
      }
    }
  } finally {
    reader.releaseLock()
  }
}

// ── Streaming core ─────────────────────────────────────────────

type CompatConfig = { apiKey: string; baseURL: string; label: string }

async function* streamCompat(
  cfg: CompatConfig,
  wireModel: string,
  recordedModel: string,
  systemPrompt: string,
  messages: Message[],
  options: {
    tools?: ToolDefinition[]
    maxTokens?: number
    temperature?: number
    thinkingLevel?: ThinkingLevel
    responseFormat?: 'json'
    signal?: AbortSignal
  },
): AsyncGenerator<StreamChunk> {
  const ccMessages: CCMessage[] = [
    ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
    ...toCCMessages(messages),
  ]
  const tools = toCCTools(options.tools)
  const body: Record<string, unknown> = {
    model: wireModel,
    messages: ccMessages,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools ? { tools, tool_choice: 'auto' } : {}),
    ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    // DashScope thinking switch (Qwen); vendors without it ignore the field.
    ...(options.thinkingLevel !== undefined ? { enable_thinking: options.thinkingLevel === 'high' } : {}),
    // JSON mode and tools are mutually exclusive (same rule as Gemini).
    ...(options.responseFormat === 'json' && !tools ? { response_format: { type: 'json_object' } } : {}),
  }

  const res = await fetch(`${cfg.baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: options.signal,
  })
  if (!res.ok || !res.body) {
    const detail = (await res.text().catch(() => '')).slice(0, 500)
    const err = new Error(`[openai-compat:${cfg.label}] HTTP ${res.status}: ${detail}`) as Error & { status?: number }
    err.status = res.status
    throw err
  }

  yield { type: 'message_start', model: recordedModel }

  // Per-index tool-call accumulation: the first fragment carries id+name,
  // later fragments append argument text. tool_use_end is emitted for every
  // open call once the stream finishes (chat-completions has no per-call
  // terminator event).
  const openCalls = new Map<number, { id: string; started: boolean }>()
  let finishReason: string | null | undefined
  let sawToolCalls = false
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }

  for await (const payload of sseData(res)) {
    let event: CCStreamEvent
    try {
      event = JSON.parse(payload) as CCStreamEvent
    } catch {
      console.warn(`[openai-compat:${cfg.label}] unparseable SSE payload (${payload.slice(0, 120)}…) — skipped`)
      continue
    }
    if (event.usage) usage = extractCCUsage(event.usage)
    const choice = event.choices?.[0]
    if (!choice) continue
    if (choice.finish_reason) finishReason = choice.finish_reason
    const delta = choice.delta
    if (!delta) continue
    if (delta.reasoning_content) yield { type: 'thinking_delta', text: delta.reasoning_content }
    if (delta.content) yield { type: 'text_delta', text: delta.content }
    for (const tc of delta.tool_calls ?? []) {
      sawToolCalls = true
      let call = openCalls.get(tc.index)
      if (!call) {
        call = { id: tc.id ?? `call_${tc.index}`, started: false }
        openCalls.set(tc.index, call)
      }
      if (!call.started && tc.function?.name) {
        call.started = true
        yield { type: 'tool_use_start', id: call.id, name: tc.function.name }
      }
      if (tc.function?.arguments) {
        yield { type: 'tool_use_delta', id: call.id, input: tc.function.arguments }
      }
    }
  }

  for (const call of openCalls.values()) {
    if (call.started) yield { type: 'tool_use_end', id: call.id }
  }
  yield { type: 'message_end', stopReason: mapCCStopReason(finishReason, sawToolCalls), usage }
}

// ── Provider ───────────────────────────────────────────────────

export type OpenAICompatProviderOptions = {
  apiKey: string
  baseURL: string
  /** Registry provider suffix: rows with `provider: 'openai-compat:<label>'` dispatch here. */
  label: string
}

export function createOpenAICompatProvider(options: OpenAICompatProviderOptions): LLMProvider {
  if (!options.apiKey) throw new Error('createOpenAICompatProvider: apiKey is required')
  if (!options.baseURL) throw new Error('createOpenAICompatProvider: baseURL is required')
  const providerKey = `openai-compat:${options.label}` as ModelProvider
  const aliases = providerAliasMap(providerKey)
  const cfg: CompatConfig = { apiKey: options.apiKey, baseURL: options.baseURL.replace(/\/$/, ''), label: options.label }

  const resolveWireModel = (model: string) => aliases[model] ?? model

  return {
    name: providerKey,
    models: [...providerModelIds(providerKey)],

    stream(request: ProviderRequest): AsyncIterable<StreamChunk> {
      return streamCompat(cfg, resolveWireModel(request.model), request.model, request.systemPrompt, request.messages, {
        tools: request.tools,
        maxTokens: request.maxTokens,
        temperature: request.temperature,
        thinkingLevel: request.thinkingLevel,
        responseFormat: request.responseFormat,
        signal: request.signal,
      })
    },

    createSession(sessionOpts: SessionOptions): ProviderSession {
      // Chat-completions is stateless — the session accumulates engine
      // messages and replays the full history each send. The history only
      // advances after a SUCCESSFUL stream (a failed first send leaves it
      // untouched), so the context-budget wrapper's trim-and-retry can
      // re-send safely without duplicating turns — same contract as gemini.
      const history: Message[] = []
      return {
        send: (messages: Message[], sendOpts?: SendOptions): AsyncIterable<StreamChunk> => {
          const attempt: Message[] = [...history, ...messages]
          const inner = streamCompat(cfg, resolveWireModel(sessionOpts.model), sessionOpts.model, sessionOpts.systemPrompt, attempt, {
            tools: sessionOpts.tools,
            maxTokens: sessionOpts.maxTokens,
            temperature: sessionOpts.temperature,
            thinkingLevel: sendOpts?.thinkingLevel ?? sessionOpts.thinkingLevel,
            signal: sessionOpts.signal,
          })
          async function* run(): AsyncGenerator<StreamChunk> {
            const acc = createAccumulator()
            for await (const chunk of inner) {
              acc.push(chunk)
              yield chunk
            }
            const response = acc.finish()
            history.length = 0
            history.push(...attempt)
            if (response.content.length > 0) {
              history.push({ role: 'assistant', content: response.content })
            }
          }
          return run()
        },
      }
    },
  }
}
