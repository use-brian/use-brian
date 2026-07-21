/**
 * Gemini provider using REST API directly (not the SDK).
 *
 * The official @google/generative-ai SDK strips `thoughtSignature` from
 * response parts, which Gemini 3.x models require for multi-turn function
 * calling. We hit the REST API and preserve raw response parts (including
 * thoughtSignature) in session history.
 */
import { providerAliasMap, recordedAliasIds, providerModelIds } from '@use-brian/shared/model-registry'
import type { LLMProvider, ProviderRequest, ProviderSession, SendOptions, SessionOptions, StreamChunk, Message, ContentBlock, ThinkingLevel, ToolDefinition, StopReason, TokenUsage } from './types.js'
import type { GoogleTransport } from './google-transport.js'
import { aiStudioTransport } from './google-transport.js'

/** Alias → real Google model id, derived from the model registry (each
 * gemini row's alias/idAliases vs its `apiModelId`). */
const MODEL_ALIASES: Record<string, string> = providerAliasMap('gemini')

/**
 * Synthetic logical ids that share an underlying Google model with another
 * tier but must stay billable-distinct in `usage_tracking`. They run the real
 * model on the wire (via MODEL_ALIASES above) but we **record** the synthetic
 * id in `message_start` so the row classifies as the right tier:
 *   - `gemini-3-flash-standard` (MODEL_MAP.standard) — Flash 3, vs Pro.
 *   - `gemini-3-pro-research`   (MODEL_MAP.research) — Pro 3.1, vs Max + history.
 * Every other model records its resolved provider id unchanged. Derived from
 * the registry rows flagged `recordAlias`.
 */
const SYNTHETIC_TIER_IDS: ReadonlySet<string> = recordedAliasIds('gemini')

function resolveModel(model: string): string {
  return MODEL_ALIASES[model] ?? model
}

/** The id to stamp on the recorded turn (billing/tier key). Equals the API
 *  model id for everything except a synthetic tier id, which records itself
 *  so it stays distinguishable from the tier that shares its real model. */
function recordedModelId(requestModel: string, apiModelId: string): string {
  return SYNTHETIC_TIER_IDS.has(requestModel) ? requestModel : apiModelId
}

// ── Raw Gemini API types (preserving thoughtSignature) ─────────

type GeminiPart = {
  text?: string
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string }
  functionResponse?: { name: string; response: Record<string, unknown> }
  inlineData?: { mimeType: string; data: string }
  thoughtSignature?: string
  thought?: boolean
}

type GeminiContent = {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

type GroundingChunk = { web?: { uri: string; title: string } }

type GroundingMetadata = {
  webSearchQueries?: string[]
  groundingChunks?: GroundingChunk[]
  groundingSupports?: Array<{
    segment: { text: string }
    groundingChunkIndices: number[]
  }>
}

type GeminiCandidate = {
  content: { role: string; parts: GeminiPart[] }
  finishReason?: string
  groundingMetadata?: GroundingMetadata
}

type GeminiStreamChunk = {
  candidates?: GeminiCandidate[]
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
    /** Subset of promptTokenCount that was served from cache. */
    cachedContentTokenCount?: number
    /** Thinking/reasoning tokens (billed as output). */
    thoughtsTokenCount?: number
  }
  /** Present when Gemini blocks the prompt itself (safety, blocked categories). */
  promptFeedback?: {
    blockReason?: string
    safetyRatings?: Array<{ category: string; probability: string }>
  }
}

type GeminiFunctionDeclaration = {
  name: string
  description: string
  parameters?: Record<string, unknown>
}

type GeminiToolEntry = { functionDeclarations: GeminiFunctionDeclaration[] }

type GeminiRequest = {
  contents: GeminiContent[]
  systemInstruction?: { parts: GeminiPart[] }
  tools?: GeminiToolEntry[]
  toolConfig?: {
    functionCallingConfig?: {
      mode?: 'AUTO' | 'ANY' | 'NONE'
    }
  }
  generationConfig?: {
    maxOutputTokens?: number
    temperature?: number
    responseMimeType?: string
    /** Gemini's OpenAPI-subset JSON Schema — what actually constrains the decoder. */
    responseSchema?: Record<string, unknown>
    thinkingConfig?: { thinkingLevel?: 'LOW' | 'HIGH'; includeThoughts?: boolean }
  }
}

// ── Message conversion ─────────────────────────────────────────

function messagesToGeminiParts(messages: Message[]): GeminiPart[] {
  const parts: GeminiPart[] = []
  for (const msg of messages) {
    if (msg.role === 'system') continue
    const blocks = typeof msg.content === 'string'
      ? [{ type: 'text' as const, text: msg.content }]
      : msg.content

    for (const block of blocks) {
      switch (block.type) {
        case 'text':
          parts.push({ text: block.text })
          break
        case 'image':
          parts.push({ inlineData: { mimeType: block.mimeType, data: block.data } })
          break
        case 'tool_use': {
          // Gemini 3.x requires `thoughtSignature` on every functionCall that
          // reappears in conversation history. Restore it from the block's
          // persisted signature — without this the API rejects the request
          // with "Function call is missing a thought_signature in
          // functionCall parts".
          const part: GeminiPart = { functionCall: { name: block.name, args: block.input } }
          if (block.providerSignature) part.thoughtSignature = block.providerSignature
          parts.push(part)
          break
        }
        case 'tool_result':
          parts.push({
            functionResponse: {
              name: block.name,
              response: { result: block.content },
            },
          })
          break
      }
    }
  }
  return parts
}

function toGeminiContents(messages: Message[]): GeminiContent[] {
  const contents: GeminiContent[] = []
  for (const msg of messages) {
    if (msg.role === 'system') continue
    const parts = messagesToGeminiParts([msg])
    if (parts.length > 0) {
      contents.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts,
      })
    }
  }
  return normalizeGeminiContents(contents)
}

/**
 * Drop leading contents that would produce a Gemini 400
 * "Please ensure that function call turn comes immediately after a user turn
 * or after a function response turn." Gemini requires the first content to be
 * a user text/image turn, never a bare `functionCall` (model tool_use) or a
 * `functionResponse` (user tool_result with no preceding call).
 *
 * This is a safety net — the boundary of valid history is maintained by the
 * compaction / message-pairing layers. When this function drops anything we
 * log a warning so the upstream bug is visible in Cloud Run logs. Root-cause
 * fixes belong in the persistence layer; this keeps a single in-flight turn
 * from bricking a session if that layer misses an edge case.
 *
 * Exported for unit testing.
 */
export function normalizeGeminiContents(contents: GeminiContent[]): GeminiContent[] {
  let dropIdx = 0
  while (dropIdx < contents.length && !isValidHead(contents[dropIdx])) {
    dropIdx++
  }
  if (dropIdx === 0) return contents
  const dropped = contents.slice(0, dropIdx)
  const droppedSummary = dropped
    .map((c) => `${c.role}:[${c.parts.map(describePart).join(',')}]`)
    .join(' ')
  console.warn(
    `[gemini] normalized orphan head — dropped ${dropIdx} content(s): ${droppedSummary}. ` +
    `Upstream persistence layer produced a history that does not start with a user text/image turn.`,
  )
  return contents.slice(dropIdx)
}

function isValidHead(content: GeminiContent): boolean {
  // Valid: a user turn that carries at least one text or inlineData part.
  // Invalid: any model turn (functionCall / text) — model turns must follow a
  // user turn. Invalid: a user turn made solely of functionResponse parts —
  // that's a tool_result whose preceding functionCall was trimmed.
  if (content.role !== 'user') return false
  return content.parts.some((p) => p.text !== undefined || p.inlineData !== undefined)
}

function describePart(p: GeminiPart): string {
  if (p.functionCall) return `functionCall(${p.functionCall.name})`
  if (p.functionResponse) return `functionResponse(${p.functionResponse.name})`
  if (p.text !== undefined) return 'text'
  if (p.inlineData) return 'inlineData'
  return 'unknown'
}

/** A Gemini INPUT part is only valid if it carries content the API recognizes. */
function hasInputCarrier(p: GeminiPart): boolean {
  return (
    p.text !== undefined ||
    p.inlineData !== undefined ||
    p.functionCall !== undefined ||
    p.functionResponse !== undefined
  )
}

/**
 * Enforce Gemini's INPUT part contract at the request boundary. Two shapes
 * must never be sent, and this drops both:
 *
 *   - A reasoning part (`thought: true`). Thinking is response-only — replaying
 *     it violates the "reasoning is never re-sent to the model" invariant, and
 *     a body-stripped thought part is content-less, which the API rejects with
 *     400 "Unsupported input part type: go/debugproto \nthought: true". That
 *     bare `{ thought: true }` part is exactly what bricked multi-round-trip
 *     turns before the rawHistory-side drop in `createSession()`.
 *   - Any content-less part (no carrier field) — defensive against any other
 *     code path that assembles a malformed part.
 *
 * The `thoughtSignature` Gemini 3.x requires rides ON a carrier part (the
 * `functionCall`), so it survives — only thought/empty parts are dropped.
 *
 * Same philosophy as `normalizeGeminiContents`: the root fix is to not
 * manufacture the bad part, but every request funnels through `buildRequest`,
 * so this choke point keeps one stray part from 400-ing a live turn and
 * `console.warn`s to keep the upstream bug visible. Pure + exported so it is
 * unit-testable WITHOUT a network round-trip — closing the exact gap (a mocked
 * `fetch` that only checked what we built, not what the API accepts) that let
 * the original bug ship.
 */
export function stripNonInputParts(contents: GeminiContent[]): GeminiContent[] {
  const dropped: string[] = []
  const cleaned: GeminiContent[] = []
  for (const content of contents) {
    const keptParts = content.parts.filter((p) => {
      const ok = !p.thought && hasInputCarrier(p)
      if (!ok) dropped.push(`${content.role}:${p.thought ? 'thought' : describePart(p)}`)
      return ok
    })
    // A content whose parts are all dropped becomes `parts: []`, itself invalid
    // — drop the whole content rather than send an empty turn.
    if (keptParts.length > 0) cleaned.push({ role: content.role, parts: keptParts })
  }
  if (dropped.length > 0) {
    console.warn(
      `[gemini] stripped ${dropped.length} non-input part(s) before send: ${dropped.join(', ')}. ` +
      `Reasoning / content-less parts must never reach the API — an upstream layer produced one.`,
    )
  }
  return cleaned
}

function toToolDeclarations(tools: ToolDefinition[]): GeminiFunctionDeclaration[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }))
}

/**
 * Extract TokenUsage from Gemini's usageMetadata, decomposing cached
 * and thinking tokens so they are priced at the correct rates.
 *
 * See docs/architecture/platform/cost-and-pricing.md → "Token extraction from
 * Gemini usageMetadata".
 */
function extractUsage(meta: NonNullable<GeminiStreamChunk['usageMetadata']>): TokenUsage {
  const cached = meta.cachedContentTokenCount ?? 0
  const thoughts = meta.thoughtsTokenCount ?? 0
  return {
    inputTokens: (meta.promptTokenCount ?? 0) - cached,
    outputTokens: (meta.candidatesTokenCount ?? 0) + thoughts,
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
  }
}

function mapFinishReason(reason?: string): StopReason {
  switch (reason) {
    case 'STOP': return 'end_turn'
    case 'MAX_TOKENS': return 'max_tokens'
    case 'SAFETY': return 'safety'
    default: return 'end_turn'
  }
}

/**
 * Resolve the final `stopReason` for a Gemini response.
 *
 * When the response contains tool calls, always return `'tool_use'` regardless
 * of Gemini's raw finishReason. Gemini occasionally emits `MAX_TOKENS` (or
 * other non-`STOP` reasons) alongside complete tool calls, and the query loop
 * uses `stopReason === 'tool_use'` to decide whether to execute tools and
 * continue. Without this override, tool_use turns with a non-end_turn
 * finishReason exit the loop silently without running the tools.
 */
export function resolveStopReason(finishReason: StopReason, hasToolCalls: boolean): StopReason {
  if (hasToolCalls) return 'tool_use'
  return finishReason
}

/**
 * Strip a leaked turn role-label token from the start of a Gemini turn's text.
 *
 * Gemini's chat format labels the assistant turn with the role token `model`
 * (the counterpart to OpenAI's `assistant`). Occasionally — observed ~1 turn in
 * 120 days of production, typically on a post-tool-call continuation — gemini-3.x
 * echoes that label as the first text part of the turn, so the reply begins with
 * a literal `model\n` glued ahead of the real body in a single `part.text`. That
 * token then streams to the user and, on the stateful session path, gets
 * accumulated into persisted history (so it also re-enters context next turn).
 *
 * Apply this to the FIRST text part of a turn only. Matching is deliberately
 * narrow — the exact role token alone on the opening line — so a legitimate reply
 * that merely discusses "models" is never touched. Returns the text unchanged
 * when no leading token is present.
 */
export function stripLeadingRoleToken(firstTurnText: string): string {
  return firstTurnText.replace(/^model\r?\n/, '')
}

// ── SSE streaming via REST API ─────────────────────────────────

async function* streamGeminiSSE(
  transport: GoogleTransport,
  modelId: string,
  request: GeminiRequest,
  signal?: AbortSignal,
): AsyncGenerator<GeminiStreamChunk> {
  // AI Studio and Vertex speak the same wire format; only host + auth differ,
  // and the injected transport owns both. Everything below here is identical.
  const url = transport.endpoint(modelId, 'streamGenerateContent', { alt: 'sse' })
  const headers = await transport.headers()

  // `signal` is plumbed all the way to `fetch` and survives onto the response
  // body's reader. Without this, a hung upstream call (Gemini taking >5min on
  // a thinking-heavy turn) leaks past the chat route's `req.on('close')`
  // abort, and Cloud Run truncates the response at the 300s cap with the
  // session still in `status='running'`. See docs/architecture/feed/
  // stuck-session-sweeper.md for the recovery path.
  const send = (body: GeminiRequest) =>
    fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    })

  let response = await send(request)

  // Fail-open on a rejected responseSchema. Gemini accepts only a subset of
  // JSON Schema, and a schema it dislikes comes back as a 400 for the WHOLE
  // request — which would take every caller that uses one offline rather than
  // merely un-constraining it. A schema is an output-quality optimisation; it
  // must never be a liveness dependency. So: strip it, retry once, and be loud
  // about it. The caller still validates the output, exactly as it did before
  // schemas existed.
  if (
    response.status === 400 &&
    request.generationConfig &&
    'responseSchema' in request.generationConfig
  ) {
    const detail = await response.text()
    console.error(
      `[gemini] responseSchema REJECTED (400) for model=${modelId} — retrying without it. ` +
      `Output is no longer decoder-constrained for this call; fix the schema to restore the guarantee. ` +
      `Detail: ${detail.slice(0, 500)}`,
    )
    const { responseSchema: _dropped, ...generationConfig } = request.generationConfig
    response = await send({ ...request, generationConfig })
  }

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Gemini API error ${response.status}: ${body}`)
  }

  if (!response.body) {
    throw new Error('No response body from Gemini API')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  // Hard ceiling on the partial-line buffer. SSE events normally arrive
  // delimited by `\n\n`, so `buffer` should never exceed one event's size
  // (a few KB to ~1 MB on huge thinking responses). If we exceed this
  // ceiling, something is wrong — Gemini may be sending unterminated data
  // or we're decoding faster than parsing, accumulating MB-scale strings.
  // Better to fail fast than OOM the process. Production 5/26 OOM traces
  // showed heap going from 78 MB to 4 GB during streams; an unbounded
  // buffer was a plausible vector. 8 MB is generous for any real SSE event.
  const MAX_SSE_BUFFER_BYTES = 8 * 1024 * 1024

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    if (buffer.length > MAX_SSE_BUFFER_BYTES) {
      throw new Error(
        `Gemini SSE buffer exceeded ${MAX_SSE_BUFFER_BYTES} bytes without a newline ` +
        `(actual: ${buffer.length}) — aborting to avoid OOM.`,
      )
    }

    // Parse SSE events
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? '' // keep incomplete line

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim()
        if (data) {
          try {
            yield JSON.parse(data) as GeminiStreamChunk
          } catch {
            // skip malformed JSON
          }
        }
      }
    }
  }

  // Process any remaining buffer
  if (buffer.startsWith('data: ')) {
    const data = buffer.slice(6).trim()
    if (data) {
      try {
        yield JSON.parse(data) as GeminiStreamChunk
      } catch {
        // skip
      }
    }
  }
}

// Note: the stateful session path used to do a non-streaming `generateContent`
// here (to grab the complete raw response with thoughtSignature in one shot).
// It now streams via `streamGeminiSSE` and accumulates the raw parts as they
// arrive — see `createSession().send()`. `streamGeminiSSE`'s 8 MB per-event
// cap subsumes the old reader's 50 MB whole-body cap.

// ── Stream chunks conversion ───────────────────────────────────

/**
 * Map our abstract `ThinkingLevel` to the Gemini API's thinkingConfig value
 * for a given model id. Returns `undefined` when the model family does not
 * support an explicit thinking level (we omit the field entirely in that
 * case, preserving Gemini's default behavior).
 *
 * Gemini 3 Pro supports only LOW | HIGH. Gemini 3 Flash also accepts
 * MINIMAL and MEDIUM, but we don't surface those — our only caller is the
 * empty-response retry which needs binary "default vs downshift." Keeping
 * this 2-level is intentional; extend only when a caller actually needs it.
 */
export function resolveGeminiThinkingLevel(
  modelId: string,
  level: ThinkingLevel | undefined,
): 'LOW' | 'HIGH' | undefined {
  if (!level) return undefined
  const m = modelId.toLowerCase()
  const isGemini3 = /(^|\/)gemini-3(?:\.\d+)?-(?:pro|flash)/.test(m)
  if (!isGemini3) return undefined
  return level === 'high' ? 'HIGH' : 'LOW'
}

function buildRequest(
  contents: GeminiContent[],
  options: { systemPrompt: string; tools?: ToolDefinition[]; maxTokens?: number; temperature?: number; thinkingLevel?: ThinkingLevel; responseFormat?: 'json'; responseSchema?: Record<string, unknown> },
  modelId: string,
): GeminiRequest {
  // Universal choke point: every request (stateless stream() AND stateful
  // session path) is assembled here, so enforce the input-part contract once,
  // for all of them. Drops reasoning / content-less parts that would 400.
  const safeContents = stripNonInputParts(contents)

  const toolEntries: GeminiToolEntry[] = []
  if (options.tools?.length) {
    toolEntries.push({ functionDeclarations: toToolDeclarations(options.tools) })
  }
  // Google Search grounding is removed entirely. The explicit webSearch +
  // urlReader tools handle all web search via a Brave/Serper/Tavily/DDG
  // provider stack. Grounding was problematic: no query control, commerce
  // site failures, mandatory widget display (incompatible with messaging
  // channels), extra cost (~$35/1K requests on Vertex), and can't cache
  // results. See docs/architecture/integrations/search-and-fetch.md.

  return {
    contents: safeContents,
    systemInstruction: { parts: [{ text: options.systemPrompt }] },
    ...(toolEntries.length > 0 ? { tools: toolEntries } : {}),
    // AUTO mode: model decides when to call tools and can emit multiple
    // function calls in a single response (parallel tool calling). This
    // is critical for the search→fetch loop — the model should call
    // urlReader on 2-3 URLs simultaneously, not one per turn.
    ...(toolEntries.length > 0 ? {
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    } : {}),
    generationConfig: {
      maxOutputTokens: options.maxTokens,
      temperature: options.temperature,
      // JSON output. Only when the caller asked for it AND no tools are
      // declared — Gemini rejects responseMimeType together with function
      // declarations.
      //
      // `responseMimeType` alone is a HINT, not a constraint: it asks for JSON
      // and the model usually complies, but nothing at the decoder enforces it.
      // This was documented as "decoder-constrained… eliminating the
      // malformed-output class" and that was simply wrong — production kept
      // producing unparseable extraction output (2026-07-20). What actually
      // engages Gemini's constrained decoder is `responseSchema`, so a caller
      // that supplies one gets the real guarantee; a caller that doesn't is
      // unchanged. Callers schema-validate either way.
      ...(options.responseFormat === 'json' && toolEntries.length === 0
        ? {
            responseMimeType: 'application/json',
            ...(options.responseSchema ? { responseSchema: options.responseSchema } : {}),
          }
        : {}),
      ...(() => {
        // Gemini 3 thinks on every turn regardless; `includeThoughts: true`
        // asks it to also return a streamable SUMMARY of that reasoning (a
        // few extra output tokens, not extra thinking) so the engine can
        // surface it as `thinking_delta` → SSE `reasoning`. Without it, the
        // reasoning stream is empty even though the plumbing exists. Only
        // gemini-3 supports `thinkingConfig`; older models get nothing.
        // See docs/architecture/engine/live-streaming.md.
        const isGemini3 = /(^|\/)gemini-3(?:\.\d+)?-(?:pro|flash)/.test(modelId.toLowerCase())
        if (!isGemini3) return {}
        const tl = resolveGeminiThinkingLevel(modelId, options.thinkingLevel)
        return {
          thinkingConfig: {
            ...(tl ? { thinkingLevel: tl } : {}),
            includeThoughts: true,
          },
        }
      })(),
    },
  }
}

async function* convertStreamChunks(
  sseStream: AsyncGenerator<GeminiStreamChunk>,
  modelId: string,
  toolCallCounter: { value: number },
): AsyncGenerator<{ chunk: StreamChunk; rawParts?: GeminiPart[] }> {
  yield { chunk: { type: 'message_start', model: modelId } }

  // Starts as `'incomplete'`, NOT `'end_turn'`. Gemini states the finish reason
  // on the final chunk; a stream that ends without ever supplying one did not
  // tell us it finished cleanly, and defaulting to `'end_turn'` asserted
  // something the provider never said. That silently disguised cut-off turns as
  // complete ones — invisible to the truncation detector, which only looks for
  // `'max_tokens'`, and a standing way for "the model stopped early" to be
  // misread downstream as "the model produced bad output" (the 2026-07-20
  // extraction-parse misdiagnosis). Overwritten below the moment a real finish
  // reason arrives, which is the overwhelmingly common path.
  let finishReason: StopReason = 'incomplete'
  let sawFinishReason = false
  let usage = { inputTokens: 0, outputTokens: 0 }
  let hasToolCalls = false
  let hasAnyContent = false
  let chunkCount = 0
  let firstTextSeen = false  // strip a leaked `model\n` role token from the turn's first text part

  for await (const data of sseStream) {
    chunkCount++
    const candidate = data.candidates?.[0]
    if (!candidate) {
      // Log the raw response when no candidates — this captures safety blocks,
      // prompt feedback, and other API-level rejections that produce empty turns.
      console.warn(
        `[gemini] Chunk #${chunkCount} has no candidate. promptFeedback=${JSON.stringify(data.promptFeedback ?? null)}, ` +
        `usageMetadata=${JSON.stringify(data.usageMetadata ?? null)}, ` +
        `keys=${Object.keys(data).join(',')}`,
      )
      // Capture usage even from candidate-less chunks (Gemini sometimes
      // sends usage in the final chunk with no candidate)
      if (data.usageMetadata) {
        usage = extractUsage(data.usageMetadata)
      }
      continue
    }

    const rawParts = candidate.content?.parts ?? []
    if (rawParts.length > 0) hasAnyContent = true

    for (const part of rawParts) {
      if (part.thought) {
        // Verbatim reasoning — stream live so the user can watch the model
        // think. Body is never persisted (stateless path keeps no history).
        if (part.text) yield { chunk: { type: 'thinking_delta', text: part.text } }
      } else if (part.text) {
        let text = part.text
        if (!firstTextSeen) {
          firstTextSeen = true
          text = stripLeadingRoleToken(text)
        }
        if (text) yield { chunk: { type: 'text_delta', text } }
      }
      if (part.functionCall) {
        hasToolCalls = true
        const id = `call_${++toolCallCounter.value}`
        yield { chunk: { type: 'tool_use_start', id, name: part.functionCall.name } }
        yield { chunk: { type: 'tool_use_delta', id, input: JSON.stringify(part.functionCall.args ?? {}) } }
        yield {
          chunk: {
            type: 'tool_use_end',
            id,
            ...(part.thoughtSignature ? { providerSignature: part.thoughtSignature } : {}),
          },
          rawParts,
        }
      }
    }

    // Surface grounding citations if present
    if (candidate.groundingMetadata?.groundingChunks?.length) {
      const sources = candidate.groundingMetadata.groundingChunks
        .filter((c): c is GroundingChunk & { web: { uri: string; title: string } } => !!c.web)
        .map((c) => ({ url: c.web.uri, title: c.web.title }))
      if (sources.length > 0) {
        yield { chunk: { type: 'grounding_metadata', sources } }
      }
    }

    if (candidate.finishReason) {
      finishReason = mapFinishReason(candidate.finishReason)
      sawFinishReason = true
    }
    if (data.usageMetadata) {
      usage = extractUsage(data.usageMetadata)
    }
  }

  if (!sawFinishReason && !hasToolCalls) {
    // Loud on purpose: this is the shape that used to be indistinguishable from
    // a clean stop. Whatever consumed this turn got a partial answer.
    console.error(
      `[gemini] Stream ended with NO finishReason after ${chunkCount} chunk(s) ` +
      `(model=${modelId}, hasContent=${hasAnyContent}) — reporting stopReason='incomplete'. ` +
      `The turn may be cut mid-output; do not treat it as a completed answer.`,
    )
  }
  finishReason = resolveStopReason(finishReason, hasToolCalls)

  if (!hasAnyContent && chunkCount > 0) {
    console.error(
      `[gemini] Stream completed with ${chunkCount} chunk(s) but ZERO content. ` +
      `Model=${modelId}, finishReason=${finishReason}, usage=${JSON.stringify(usage)}. ` +
      `This typically means Gemini's safety filter blocked the response.`,
    )
  }

  yield { chunk: { type: 'message_end', stopReason: finishReason, usage } }
}

// ── Provider ───────────────────────────────────────────────────

/**
 * Gemini-family provider over either Google transport.
 *
 * Accepts a bare AI Studio key (the default, unchanged for every existing
 * caller) or an explicit `GoogleTransport` for Vertex. Both speak the same
 * Gemini wire format, so the whole body below is shared — the registry still
 * names this provider `gemini`, and a Vertex-backed instance serves the same
 * `provider: 'gemini'` registry rows. The `undefined` case keeps construction
 * total (boot may build before deciding a feature is on).
 */
export function createGeminiProvider(keyOrTransport: string | GoogleTransport | undefined): LLMProvider {
  const transport: GoogleTransport =
    typeof keyOrTransport === 'object' && keyOrTransport !== null
      ? keyOrTransport
      : aiStudioTransport(keyOrTransport)
  const toolCallCounter = { value: 0 }

  return {
    name: 'gemini',
    models: [...providerModelIds('gemini')],

    // Stateless single-shot
    async *stream(request: ProviderRequest): AsyncIterable<StreamChunk> {
      const modelId = resolveModel(request.model)           // real Google model name (URL + thinking config)
      const recordId = recordedModelId(request.model, modelId) // billing/tier key recorded on the turn
      const contents = toGeminiContents(request.messages)
      const geminiRequest = buildRequest(contents, request, modelId)
      const sseStream = streamGeminiSSE(transport, modelId, geminiRequest, request.signal)

      for await (const { chunk } of convertStreamChunks(sseStream, recordId, toolCallCounter)) {
        yield chunk
      }
    },

    // Stateful session preserving raw Gemini parts (incl. thoughtSignature)
    createSession(options: SessionOptions): ProviderSession {
      const modelId = resolveModel(options.model)              // real Google model name (URL + thinking config)
      const recordId = recordedModelId(options.model, modelId) // billing/tier key recorded on each turn
      // Raw history preserving thoughtSignature — NOT converted from our format
      const rawHistory: GeminiContent[] = []

      return {
        async *send(messages: Message[], sendOpts?: SendOptions): AsyncIterable<StreamChunk> {
          // First call: `messages` is the full prior transcript from the DB
          // (potentially multi-turn with user/assistant alternation). Convert
          // per-message via `toGeminiContents` so role structure is preserved
          // — never collapse into a single user-role content, which was a
          // latent bug that reduced multi-turn chats to one malformed turn.
          //
          // Subsequent calls within the same session receive just the new
          // user message (typically tool_results), which gets appended to
          // the in-memory rawHistory preserved from the previous response.
          let contentsToAppend: GeminiContent[]
          if (rawHistory.length === 0) {
            contentsToAppend = toGeminiContents(messages)
            // Nothing to send is a programmer error — surface it loudly.
            if (contentsToAppend.length === 0) {
              yield { type: 'message_start', model: recordId }
              yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } }
              return
            }
          } else {
            const newParts = messagesToGeminiParts(messages)
            contentsToAppend = [{ role: 'user', parts: newParts }]
          }

          const contents = [...rawHistory, ...contentsToAppend]
          const effectiveOptions = {
            ...options,
            thinkingLevel: sendOpts?.thinkingLevel ?? options.thinkingLevel,
          }
          const geminiRequest = buildRequest(contents, effectiveOptions, modelId)

          // True SSE streaming so text + reasoning surface token-by-token as
          // the model produces them (the user watches the page get built),
          // while we accumulate the complete raw model-turn parts — including
          // `thoughtSignature` — so multi-turn history stays byte-identical to
          // the prior non-streaming path. `streamGeminiSSE` carries its own
          // 8 MB per-event OOM cap, so this is no riskier for memory than the
          // chunked non-streaming reader it replaces. `options.signal` is set
          // once at session creation and forwarded on every send — a
          // chat-route disconnect aborts the in-flight fetch instead of
          // letting it run to Cloud Run's 300s timeout.
          yield { type: 'message_start', model: recordId }

          const sseStream = streamGeminiSSE(transport, modelId, geminiRequest, options.signal)

          let stopReason: StopReason = 'end_turn'
          let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
          let hasToolCalls = false
          let modelRole: string | undefined
          let firstTextSeen = false  // strip a leaked `model\n` role token from the turn's first text part
          // Accumulated model-turn parts in arrival order. Consecutive text and
          // thought deltas are merged into one part each so the assembled turn
          // mirrors the non-streaming `generateContent` shape exactly.
          const accumulatedParts: GeminiPart[] = []

          for await (const data of sseStream) {
            const candidate = data.candidates?.[0]
            if (!candidate) {
              // Usage sometimes rides a final candidate-less chunk.
              if (data.usageMetadata) usage = extractUsage(data.usageMetadata)
              continue
            }
            modelRole = candidate.content?.role ?? modelRole

            for (const part of candidate.content?.parts ?? []) {
              if (part.thought) {
                // Verbatim reasoning — stream the body live for display; merge
                // it into the trailing thought part (stubbed before the
                // rawHistory push below, so the body never re-enters history).
                if (part.text) yield { type: 'thinking_delta', text: part.text }
                const tail = accumulatedParts[accumulatedParts.length - 1]
                if (tail?.thought && !tail.functionCall) {
                  if (part.text) tail.text = (tail.text ?? '') + part.text
                  if (part.thoughtSignature) tail.thoughtSignature = part.thoughtSignature
                } else {
                  accumulatedParts.push({
                    thought: true,
                    ...(part.text ? { text: part.text } : {}),
                    ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
                  })
                }
              } else if (part.text) {
                let text = part.text
                if (!firstTextSeen) {
                  firstTextSeen = true
                  text = stripLeadingRoleToken(text)
                }
                if (text) {
                  yield { type: 'text_delta', text }
                  const tail = accumulatedParts[accumulatedParts.length - 1]
                  if (tail && tail.text !== undefined && !tail.thought && !tail.functionCall) {
                    tail.text += text
                  } else {
                    accumulatedParts.push({ text })
                  }
                }
              }
              if (part.functionCall) {
                hasToolCalls = true
                const id = `call_${++toolCallCounter.value}`
                yield { type: 'tool_use_start', id, name: part.functionCall.name }
                yield { type: 'tool_use_delta', id, input: JSON.stringify(part.functionCall.args ?? {}) }
                // Carry thoughtSignature through to the accumulator → tool_use
                // ContentBlock → DB → next HTTP request's messagesToGeminiParts,
                // which restores it onto the functionCall part. This is the
                // round-trip that satisfies Gemini 3.x's signature requirement.
                yield {
                  type: 'tool_use_end',
                  id,
                  ...(part.thoughtSignature ? { providerSignature: part.thoughtSignature } : {}),
                }
                const fcPart: GeminiPart = { functionCall: part.functionCall }
                if (part.thoughtSignature) fcPart.thoughtSignature = part.thoughtSignature
                accumulatedParts.push(fcPart)
              }
            }

            // Surface grounding citations if present
            if (candidate.groundingMetadata?.groundingChunks?.length) {
              const sources = candidate.groundingMetadata.groundingChunks
                .filter((c): c is GroundingChunk & { web: { uri: string; title: string } } => !!c.web)
                .map((c) => ({ url: c.web.uri, title: c.web.title }))
              if (sources.length > 0) {
                yield { type: 'grounding_metadata', sources }
              }
            }

            if (candidate.finishReason) stopReason = mapFinishReason(candidate.finishReason)
            if (data.usageMetadata) usage = extractUsage(data.usageMetadata)
          }

          stopReason = resolveStopReason(stopReason, hasToolCalls)
          yield { type: 'message_end', stopReason, usage }

          // A candidate-less / empty stream contributes nothing to history —
          // mirror the prior early-return (don't push the user turn either, so
          // a retry re-sends it cleanly).
          if (accumulatedParts.length === 0) return

          // Preserve raw parts (with thoughtSignature) in history for the
          // rest of this in-memory session. On subsequent `send()` calls we
          // append the next user turn here and stream another response.
          //
          // DROP THOUGHT PARTS before pushing to rawHistory — reasoning is
          // display-only (it streams to the client as `thinking_delta` and is
          // never persisted) and must never re-enter the model's history:
          //   1. API validity. Once a thought part's body is stripped it has
          //      no content carrier, and Gemini rejects a bare
          //      `{ thought: true }` input part with 400 "Unsupported input
          //      part type: go/debugproto \nthought: true". Not every thought
          //      part carries a thoughtSignature either, so a "signature-only
          //      stub" is frequently just `{ thought: true }` — the rejected
          //      shape. This bricked multi-round-trip turns (e.g. a tool call
          //      followed by a continuation) the moment a thought part rode
          //      along in rawHistory.
          //   2. Memory. Thought bodies are 100-500 KB/turn at HIGH thinking;
          //      replaying them is the single largest OOM growth vector
          //      (5/26 prod trace: 206MB → 4GB on a multi-wave research turn).
          // The thoughtSignature Gemini 3.x actually requires for multi-turn
          // continuity rides on the `functionCall` part (captured above as
          // `fcPart.thoughtSignature`), not on the thought summary — so
          // dropping thought parts loses nothing the API needs. Keeps the
          // documented invariant that reasoning is never re-sent to the model
          // (docs/architecture/engine/live-streaming.md → Invariants).
          rawHistory.push(...contentsToAppend)
          const replayParts = accumulatedParts.filter((p) => !p.thought)
          // A pure-reasoning turn (only thought parts) leaves nothing to
          // replay — skip rather than push a `{ role: 'model', parts: [] }`
          // Gemini would reject. The query loop's empty-turn recovery
          // re-prompts in that case.
          if (replayParts.length > 0) {
            rawHistory.push({
              role: (modelRole as 'model') ?? 'model',
              parts: replayParts,
            })
          }
        },
      }
    },
  }
}
