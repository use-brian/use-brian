/**
 * xAI (Grok) HTTP helper — a tool backend, not a chat provider.
 *
 * Calls xAI's OpenAI-Responses-compatible endpoint to power the `xSearch`
 * tool and the x.com URL redirect in `urlReader`. Does not implement the
 * `LLMProvider` interface — sidanclaw's chat stack is Gemini-only today.
 *
 * Spec: docs/architecture/integrations/xai.md.
 * Pattern ported from openclaw/extensions/xai/src/responses-tool-shared.ts.
 */

export const XAI_RESPONSES_ENDPOINT = 'https://api.x.ai/v1/responses'

/**
 * Model for `xSearch` tool — reasoning on. Same per-token price as the
 * non-reasoning variant ($0.20/$0.50 per Mtok), so reasoning is a free
 * upgrade for queries where it helps (compare/summarise multiple posts).
 */
export const XAI_X_SEARCH_MODEL = 'grok-4-1-fast'

/**
 * Model for the x.com URL redirect in `urlReader` — reasoning off. The
 * task is "quote the post verbatim"; reasoning tokens would be wasted.
 */
export const XAI_X_URL_QUOTE_MODEL = 'grok-4-1-fast-non-reasoning'

/** @deprecated prefer the path-specific constants above. */
export const XAI_DEFAULT_X_SEARCH_MODEL = XAI_X_URL_QUOTE_MODEL

// ── Request ──────────────────────────────────────────────────────

export type XaiResponsesRequest = {
  apiKey: string
  model: string
  inputText: string
  tools: Array<Record<string, unknown>>
  timeoutMs: number
  maxTurns?: number
  signal?: AbortSignal
}

/**
 * Token usage reported by xAI's Responses API. Shape mirrors OpenAI's —
 * `input_tokens`, `output_tokens`, optional cache hit count. We map to
 * sidanclaw's `TokenUsage` shape at the tool layer so the billing
 * pipeline (cost-tracker + usageStore) can consume it generically.
 */
export type XaiUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
}

export async function postXaiResponses(req: XaiResponsesRequest): Promise<XaiResponsesData> {
  const body: Record<string, unknown> = {
    model: req.model,
    input: [{ role: 'user', content: req.inputText }],
    tools: req.tools,
  }
  if (req.maxTurns) body.max_turns = req.maxTurns

  // Stack a caller-provided signal on top of our own timeout so whichever
  // fires first aborts the request. AbortSignal.any avoids the older "wrap
  // controllers manually" pattern — Node 20+ supports it natively.
  const timeoutSignal = AbortSignal.timeout(req.timeoutMs)
  const signal = req.signal ? AbortSignal.any([req.signal, timeoutSignal]) : timeoutSignal

  const res = await fetch(XAI_RESPONSES_ENDPOINT, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${req.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  })

  if (!res.ok) {
    const snippet = (await res.text().catch(() => '')).slice(0, 500)
    throw new Error(`xAI HTTP ${res.status}: ${snippet || res.statusText}`)
  }
  return (await res.json()) as XaiResponsesData
}

// ── Response parsing ─────────────────────────────────────────────

/** Subset of the xAI /v1/responses payload we read. Extra fields ignored. */
export type XaiResponsesData = {
  output?: Array<XaiResponsesOutputItem>
  output_text?: string
  citations?: string[]
  usage?: {
    input_tokens?: number
    output_tokens?: number
    /** xAI reports cached-input tokens here on the Responses API. */
    input_tokens_cached?: number
    /** Some shapes surface a nested details object; tolerate it. */
    input_token_details?: { cached_tokens?: number }
  }
}

/**
 * Normalise xAI's reported usage into sidanclaw's `TokenUsage` shape.
 * Returns zeros when the API omits the field — never throws, because a
 * partial response should still be billable at whatever was reported.
 */
export function extractXaiUsage(data: XaiResponsesData): XaiUsage {
  const u = data.usage ?? {}
  const cached =
    typeof u.input_tokens_cached === 'number'
      ? u.input_tokens_cached
      : u.input_token_details?.cached_tokens
  return {
    inputTokens: typeof u.input_tokens === 'number' ? u.input_tokens : 0,
    outputTokens: typeof u.output_tokens === 'number' ? u.output_tokens : 0,
    cacheReadTokens: typeof cached === 'number' ? cached : 0,
  }
}

type XaiResponsesOutputItem = {
  type?: string
  text?: string
  content?: Array<XaiResponsesOutputBlock>
  annotations?: Array<XaiResponsesAnnotation>
}

type XaiResponsesOutputBlock = {
  type?: string
  text?: string
  annotations?: Array<XaiResponsesAnnotation>
}

type XaiResponsesAnnotation = {
  type?: string
  url?: string
}

export type XaiExtractedText = {
  content: string
  citations: string[]
}

/**
 * Walk the Responses-shape output for the first text block with annotations,
 * collect URL citations. Mirrors openclaw/extensions/xai/src/responses-tool-shared.ts.
 *
 * Falls back to the top-level `output_text` / `citations` fields so legacy
 * response shapes still work.
 */
export function extractXaiResponseText(data: XaiResponsesData): XaiExtractedText {
  for (const output of data.output ?? []) {
    if (output.type === 'message') {
      for (const block of output.content ?? []) {
        if (block.type === 'output_text' && typeof block.text === 'string' && block.text) {
          return {
            content: block.text,
            citations: collectUrlAnnotations(block.annotations),
          }
        }
      }
      continue
    }
    if (output.type === 'output_text' && typeof output.text === 'string' && output.text) {
      return {
        content: output.text,
        citations: collectUrlAnnotations(output.annotations),
      }
    }
  }

  const topLevelCitations = Array.isArray(data.citations) ? data.citations : []
  return {
    content: typeof data.output_text === 'string' ? data.output_text : '',
    citations: topLevelCitations,
  }
}

function collectUrlAnnotations(annotations: Array<XaiResponsesAnnotation> | undefined): string[] {
  if (!annotations) return []
  const urls = annotations
    .filter((a) => a.type === 'url_citation' && typeof a.url === 'string')
    .map((a) => a.url as string)
  return [...new Set(urls)]
}
