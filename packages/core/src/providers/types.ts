/**
 * Provider-agnostic types for LLM streaming.
 *
 * Every provider adapter normalises its SDK output into StreamChunk.
 * Composable wrappers and the query loop consume only these types.
 */

// ── Stream chunks (provider-agnostic) ──────────────────────────

export type StreamChunk =
  | { type: 'message_start'; model: string }
  | { type: 'text_delta'; text: string }
  /**
   * Verbatim model reasoning ("thinking") streamed live as the model
   * produces it. Display-only: the accumulator never folds it into the
   * persisted `AssistantResponse` content, and providers never push the
   * body back into history (Gemini keeps only the `thoughtSignature`
   * stub — see `gemini.ts`). The query loop re-emits it as a
   * `thinking_delta` QueryEvent; the chat route forwards it over SSE as
   * the `reasoning` event. See docs/architecture/engine/live-streaming.md.
   */
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; id: string; input: string }
  /**
   * `providerSignature` carries Gemini 3.x `thoughtSignature` (or any other
   * opaque per-tool-call provenance token the provider needs to send back on
   * the next turn). The accumulator attaches it to the resulting `tool_use`
   * ContentBlock so the chat route can persist it to JSONB and the provider
   * can restore it when rebuilding the request on a later HTTP request.
   */
  | { type: 'tool_use_end'; id: string; providerSignature?: string }
  | { type: 'grounding_metadata'; sources: Array<{ url: string; title: string }> }
  | { type: 'message_end'; stopReason: StopReason; usage: TokenUsage }

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'safety'

export type TokenUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

// ── Messages (internal representation) ─────────────────────────

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string } // base64-encoded inline media (image/* or application/pdf) — mapped to Gemini `inlineData` parts
  /**
   * `providerSignature` is opaque provenance the provider needs to re-send
   * when this tool_use reappears in conversation history on a later HTTP
   * request. For Gemini 3.x this is the `thoughtSignature`; for other
   * providers it's unused. Persisted to the session_messages JSONB so it
   * survives process restarts.
   */
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; providerSignature?: string }
  | { type: 'tool_result'; toolUseId: string; name: string; content: string; isError?: boolean }

export type Message = {
  role: 'user' | 'assistant' | 'system'
  content: ContentBlock[] | string
}

// ── Tool definitions ───────────────────────────────────────────

export type ToolParameter = {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array'
  description?: string
  enum?: string[]
  items?: ToolParameter
  properties?: Record<string, ToolParameter>
  required?: string[]
}

export type ToolDefinition = {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, ToolParameter>
    required?: string[]
  }
}

// ── Provider interface ─────────────────────────────────────────

/**
 * Provider-agnostic thinking intensity. Two levels: `'high'` lets the model
 * reason aggressively; `'low'` forces it to commit to output quickly.
 * Undefined = provider default (no explicit thinkingConfig sent).
 *
 * Used by the query loop's empty-response recovery to downshift to `'low'`
 * on retry when the model produced only thinking tokens. See
 * `docs/architecture/engine/query-loop.md` ("Empty-response recovery") and
 * the per-model mapping in `providers/gemini.ts`.
 */
export type ThinkingLevel = 'low' | 'high'

export type SessionOptions = {
  model: string
  systemPrompt: string
  tools?: ToolDefinition[]
  maxTokens?: number
  temperature?: number
  /** Session default thinking level; may be overridden per `send()` call. */
  thinkingLevel?: ThinkingLevel
  /**
   * Cancels every in-flight HTTP call this session makes, including the
   * underlying `fetch` and its body reader. The chat route fires `abort()`
   * on client disconnect — without this plumbed all the way to `fetch`,
   * a hung upstream call holds the request open until Cloud Run's 300s cap
   * truncates it and leaves the session stuck in `status='running'`.
   */
  signal?: AbortSignal
}

export type SendOptions = {
  /** Per-call thinking-level override. Falls back to the session default. */
  thinkingLevel?: ThinkingLevel
}

/**
 * A stateful conversation session with an LLM provider.
 * Maintains internal state (e.g., Gemini's thought_signature) across turns.
 */
export type ProviderSession = {
  /**
   * Send messages and stream the response.
   * First call: send initial user message(s).
   * Subsequent calls: send tool results for the previous turn.
   */
  send(messages: Message[], opts?: SendOptions): AsyncIterable<StreamChunk>
}

/** Legacy stateless interface — still useful for single-turn calls */
export type ProviderRequest = {
  model: string
  messages: Message[]
  systemPrompt: string
  tools?: ToolDefinition[]
  maxTokens?: number
  temperature?: number
  thinkingLevel?: ThinkingLevel
  signal?: AbortSignal
}

export type StreamFn = (request: ProviderRequest) => AsyncIterable<StreamChunk>

export type LLMProvider = {
  name: string
  models: string[]
  /** Stateless single-shot streaming (for simple calls) */
  stream: StreamFn
  /** Create a stateful session for multi-turn tool use */
  createSession(options: SessionOptions): ProviderSession
}

// ── Assembled response (after stream completes) ────────────────

export type AssistantResponse = {
  content: ContentBlock[]
  stopReason: StopReason
  usage: TokenUsage
  model: string
}
