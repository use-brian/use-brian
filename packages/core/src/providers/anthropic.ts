/**
 * Anthropic provider — fallback only, text-first scope.
 *
 * The chat stack remains Gemini-primary; this provider exists so the
 * `wrapFallback` middleware can retry against Claude when Gemini 429s or
 * 5xxs. Tool calls and multimodal inputs from a mid-stream fallback are
 * a known follow-up — initial scope is text-only.
 *
 * Prompt caching is wired by default with 5-minute ephemeral cache_control
 * on the system prompt, matching Anthropic's recommended pattern for
 * latency- and cost-sensitive conversational workloads.
 *
 * Spec: docs/architecture/engine/provider-abstraction.md → "Fallback wrapper".
 */
import Anthropic from '@anthropic-ai/sdk'
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
  TokenUsage,
  ToolDefinition,
} from './types.js'

const MODEL_ALIASES: Record<string, string> = {
  // Per CLAUDE.md / Anthropic latest IDs — alias the abstract name to the
  // dated snapshot so callers don't pin themselves to a deprecated revision.
  'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
}

function resolveModel(model: string): string {
  return MODEL_ALIASES[model] ?? model
}

// ── Message conversion (engine → Anthropic) ────────────────────

type AnthropicTextBlock = { type: 'text'; text: string }
type AnthropicContentBlock = AnthropicTextBlock

type AnthropicMessage = {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

/**
 * Map the engine's `Message[]` into Anthropic's `MessageParam[]`.
 *
 * Text-only scope: every non-text ContentBlock (tool_use, tool_result,
 * image) is dropped with a one-line warning. The fallback wrapper only
 * triggers on full-request failure, so by the time we get here the
 * primary's mid-stream tool turn has already been discarded.
 *
 * System messages are extracted by the caller (they go on the request's
 * `system` field, not `messages`), so we drop them here as well.
 */
function toAnthropicMessages(messages: Message[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = []
  for (const msg of messages) {
    if (msg.role === 'system') continue
    if (typeof msg.content === 'string') {
      if (msg.content.trim().length === 0) continue
      out.push({ role: msg.role, content: msg.content })
      continue
    }
    const texts: AnthropicTextBlock[] = []
    let droppedTypes: Set<string> | null = null
    for (const block of msg.content) {
      if (block.type === 'text') {
        if (block.text.length > 0) texts.push({ type: 'text', text: block.text })
        continue
      }
      if (!droppedTypes) droppedTypes = new Set()
      droppedTypes.add(block.type)
    }
    if (droppedTypes && droppedTypes.size > 0) {
      console.warn(
        `[anthropic] fallback request dropped non-text blocks from a ${msg.role} message: ` +
        `${[...droppedTypes].join(',')}. Text-only fallback — multimodal/tool follow-up pending.`,
      )
    }
    if (texts.length === 0) continue
    // Anthropic accepts an array of text blocks; merging them keeps the
    // wire payload compact for short messages.
    out.push({
      role: msg.role,
      content: texts.length === 1 ? texts[0].text : texts,
    })
  }
  return mergeConsecutiveSameRole(out)
}

/**
 * Anthropic rejects requests where two consecutive messages share a role.
 * Engine history that came through Gemini can produce these (a multi-part
 * user turn that got split). Coalesce them defensively.
 */
function mergeConsecutiveSameRole(messages: AnthropicMessage[]): AnthropicMessage[] {
  if (messages.length <= 1) return messages
  const out: AnthropicMessage[] = []
  for (const msg of messages) {
    const prev = out[out.length - 1]
    if (prev && prev.role === msg.role) {
      const prevText = typeof prev.content === 'string'
        ? prev.content
        : prev.content.map((b) => b.text).join('\n')
      const nextText = typeof msg.content === 'string'
        ? msg.content
        : msg.content.map((b) => b.text).join('\n')
      prev.content = `${prevText}\n${nextText}`
    } else {
      out.push({ ...msg })
    }
  }
  return out
}

// Anthropic also requires the first message to be `role: 'user'`. A
// fallback that fires mid-turn on a model-tool-result pair could land here
// with an `assistant` head — strip it so the API accepts the request.
function ensureUserHead(messages: AnthropicMessage[]): AnthropicMessage[] {
  let i = 0
  while (i < messages.length && messages[i].role !== 'user') i++
  if (i === 0) return messages
  if (i > 0) {
    console.warn(
      `[anthropic] fallback request dropped ${i} leading non-user message(s) — Anthropic requires a user-role head.`,
    )
  }
  return messages.slice(i)
}

// ── Usage extraction ───────────────────────────────────────────

type AnthropicUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

function extractUsage(usage: AnthropicUsage | undefined): TokenUsage {
  const cacheRead = usage?.cache_read_input_tokens ?? 0
  const cacheWrite = usage?.cache_creation_input_tokens ?? 0
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
  }
}

function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'end_turn': return 'end_turn'
    case 'tool_use': return 'tool_use'
    case 'max_tokens': return 'max_tokens'
    case 'stop_sequence': return 'end_turn'
    case 'refusal': return 'safety'
    default: return 'end_turn'
  }
}

// ── Streaming helper ───────────────────────────────────────────

type SystemBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }

/**
 * Build the `system` field with prompt caching enabled. Anthropic charges
 * full input rate on the first call and the discounted cache_read rate on
 * subsequent calls within the 5-minute TTL window.
 *
 * We only mark the prompt with `cache_control` when it's long enough to
 * actually benefit (Anthropic's documented minimum cacheable size is
 * 1024 tokens for Haiku; we approximate with character count to avoid
 * pulling in a tokenizer).
 */
function buildSystem(systemPrompt: string): SystemBlock[] | string {
  if (!systemPrompt) return ''
  // Rough rule of thumb: 1 token ≈ 4 chars. Below ~4 KB the cache write
  // overhead can outweigh the discount, so send as plain string.
  const CACHE_MIN_CHARS = 4096
  if (systemPrompt.length < CACHE_MIN_CHARS) return systemPrompt
  return [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
}

async function* streamAnthropic(
  client: Anthropic,
  modelId: string,
  systemPrompt: string,
  messages: AnthropicMessage[],
  options: {
    maxTokens?: number
    temperature?: number
    tools?: ToolDefinition[]
    signal?: AbortSignal
  },
): AsyncGenerator<StreamChunk> {
  // Text-only fallback. Tools are intentionally omitted — see file header
  // comment. We warn at call-time if the caller passed any so the dropped
  // capability is visible.
  if (options.tools?.length) {
    console.warn(
      `[anthropic] fallback called with ${options.tools.length} tool(s); ` +
      `text-only scope drops them. Tool fallback is a follow-up.`,
    )
  }

  const sanitized = ensureUserHead(messages)
  if (sanitized.length === 0) {
    yield { type: 'message_start', model: modelId }
    yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } }
    return
  }

  yield { type: 'message_start', model: modelId }

  // Use the streaming `.create` form so we can yield text deltas as they
  // arrive. The SDK forwards `signal` to the underlying fetch — a
  // chat-route disconnect aborts the call without leaking a request.
  const stream = await client.messages.create(
    {
      model: modelId,
      // Anthropic requires max_tokens (no implicit default). Cap to a
      // sane mid-range when caller didn't supply one — too low truncates
      // the recovery answer, too high gives the model rope.
      max_tokens: options.maxTokens ?? 4096,
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      system: buildSystem(systemPrompt),
      messages: sanitized,
      stream: true,
    },
    { signal: options.signal },
  )

  let stopReason: StopReason = 'end_turn'
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }

  for await (const event of stream) {
    switch (event.type) {
      case 'message_start': {
        usage = extractUsage(event.message.usage as AnthropicUsage)
        break
      }
      case 'content_block_delta': {
        const delta = event.delta
        if (delta.type === 'text_delta') {
          yield { type: 'text_delta', text: delta.text }
        }
        break
      }
      case 'message_delta': {
        if (event.delta.stop_reason) {
          stopReason = mapStopReason(event.delta.stop_reason)
        }
        // `message_delta.usage` carries the final output_tokens count.
        const u = event.usage as AnthropicUsage | undefined
        if (u) {
          const merged = extractUsage(u)
          usage = {
            inputTokens: merged.inputTokens || usage.inputTokens,
            outputTokens: merged.outputTokens || usage.outputTokens,
            ...(merged.cacheReadTokens || usage.cacheReadTokens
              ? { cacheReadTokens: merged.cacheReadTokens ?? usage.cacheReadTokens }
              : {}),
            ...(merged.cacheWriteTokens || usage.cacheWriteTokens
              ? { cacheWriteTokens: merged.cacheWriteTokens ?? usage.cacheWriteTokens }
              : {}),
          }
        }
        break
      }
      // message_stop, content_block_start/stop carry no fields we map.
    }
  }

  yield { type: 'message_end', stopReason, usage }
}

// ── Provider ───────────────────────────────────────────────────

export type AnthropicProviderOptions = {
  apiKey: string
  /** Override base URL — useful for staging/proxy. */
  baseURL?: string
}

/**
 * Construct an Anthropic-backed `LLMProvider`. Caller is responsible for
 * gating on `ANTHROPIC_API_KEY` availability — this constructor does NOT
 * accept an empty key (it would 401 every call).
 */
export function createAnthropicProvider(options: AnthropicProviderOptions): LLMProvider {
  if (!options.apiKey) {
    throw new Error('createAnthropicProvider: apiKey is required')
  }
  const client = new Anthropic({
    apiKey: options.apiKey,
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
  })

  return {
    name: 'anthropic',
    models: ['claude-haiku-4-5'],

    async *stream(request: ProviderRequest): AsyncIterable<StreamChunk> {
      const modelId = resolveModel(request.model)
      const messages = toAnthropicMessages(request.messages)
      yield* streamAnthropic(client, modelId, request.systemPrompt, messages, {
        maxTokens: request.maxTokens,
        temperature: request.temperature,
        tools: request.tools,
        signal: request.signal,
      })
    },

    createSession(opts: SessionOptions): ProviderSession {
      const modelId = resolveModel(opts.model)
      // Fallback scope: each `send()` reissues the full transcript. We
      // don't carry provider-specific state (Anthropic has no signature
      // round-trip), so this is correct and free of leaks.
      const history: AnthropicMessage[] = []

      return {
        async *send(messages: Message[], sendOpts?: SendOptions): AsyncIterable<StreamChunk> {
          // Suppress unused-var warning while preserving the SendOptions
          // signature — Anthropic has no per-call thinking-level toggle.
          void sendOpts
          const incoming = toAnthropicMessages(messages)
          if (history.length === 0) {
            history.push(...incoming)
          } else {
            // Subsequent turns: append just the new user content.
            history.push(...incoming)
          }
          const consolidated = mergeConsecutiveSameRole(history)
          yield* streamAnthropic(client, modelId, opts.systemPrompt, consolidated, {
            maxTokens: opts.maxTokens,
            temperature: opts.temperature,
            tools: opts.tools,
            signal: opts.signal,
          })
        },
      }
    },
  }
}

// ── Error classification (re-exported for wrapFallback) ────────

/**
 * Classify whether a thrown error came from a rate limit (429) or
 * server-side issue (5xx). Used by `wrapFallback` to decide whether to
 * retry on the fallback provider.
 */
export function classifyAnthropicError(err: unknown): { status: number | null } {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as { status: unknown }).status
    if (typeof status === 'number') return { status }
  }
  return { status: null }
}
