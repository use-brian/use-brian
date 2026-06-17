/**
 * Gemini-backed file distillation: a PDF or image's bytes → clean Markdown
 * text, so a non-text file can feed Pipeline B (which ingests text only).
 *
 * Mirrors `media/transcribe.ts` — the one-provider, channel-local pattern (a
 * direct `generateContent` REST call with an `inlineData` part), NOT the
 * framework provider registry. PDFs and images ride Gemini's native inlineData
 * reader; there is deliberately no local text extraction for these (see
 * docs/architecture/engine/file-handling.md → "PDFs are passed natively").
 *
 * The module never reads env (per packages/core/CLAUDE.md) — the caller passes
 * `apiKey` from `env.GEMINI_API_KEY`. Returns token usage so the caller can
 * attribute it as an `overhead:*` row in `usage_tracking`.
 *
 * [COMP:files/distill]
 */

import type { TokenUsage } from '../providers/types.js'

export type DistillOptions = {
  apiKey: string
  /** Gemini model id. Default: `gemini-2.5-flash`. */
  model?: string
  /** Instruction to the model. Default: a faithful full-content extraction directive. */
  prompt?: string
  /** Abort after N ms. Default: 60_000 (documents are larger than voice notes). */
  timeoutMs?: number
  /** Output token ceiling. Default: 8192. */
  maxOutputTokens?: number
  /** Injected for tests. Defaults to global `fetch`. */
  fetchFn?: typeof fetch
}

export type DistillResult = {
  text: string
  usage: TokenUsage | null
  model: string
}

const DEFAULT_MODEL = 'gemini-2.5-flash'
const DEFAULT_PROMPT =
  'Extract the full textual content of the attached document as clean, faithful Markdown. ' +
  'Preserve headings, lists, and tables. Transcribe the real content verbatim — do NOT ' +
  'summarize, add commentary, or invent text. If the document is empty or unreadable, ' +
  'output an empty string and nothing else.'
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_OUTPUT_TOKENS = 8192
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

type GeminiPart = {
  text?: string
  inlineData?: { mimeType: string; data: string }
}

type GeminiUsageMetadata = {
  promptTokenCount?: number
  candidatesTokenCount?: number
  thoughtsTokenCount?: number
  cachedContentTokenCount?: number
}

type GeminiResponse = {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] }
  }>
  usageMetadata?: GeminiUsageMetadata
}

function extractUsage(meta: GeminiUsageMetadata | undefined): TokenUsage | null {
  if (!meta) return null
  const cached = meta.cachedContentTokenCount ?? 0
  const thoughts = meta.thoughtsTokenCount ?? 0
  return {
    inputTokens: (meta.promptTokenCount ?? 0) - cached,
    outputTokens: (meta.candidatesTokenCount ?? 0) + thoughts,
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
  }
}

/**
 * Distill a binary document (PDF / image) to Markdown via Gemini inlineData.
 * Unlike `transcribeAudio`, an empty result is NOT an error — a blank or
 * undecodable document legitimately yields no text, and the caller stores the
 * raw bytes regardless and simply skips decomposition.
 */
export async function distillFileToText(
  input: { buffer: Buffer; mime: string },
  options: DistillOptions,
): Promise<DistillResult> {
  const model = options.model ?? DEFAULT_MODEL
  const prompt = options.prompt ?? DEFAULT_PROMPT
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
  const fetchFn = options.fetchFn ?? fetch

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: prompt },
          { inlineData: { mimeType: input.mime, data: input.buffer.toString('base64') } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens,
    },
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let response: Response
  try {
    response = await fetchFn(`${BASE_URL}/models/${model}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': options.apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(
      `Gemini file distillation failed (HTTP ${response.status}): ${detail.slice(0, 300)}`,
    )
  }

  const payload = (await response.json()) as GeminiResponse
  const parts = payload.candidates?.[0]?.content?.parts ?? []
  const text = parts
    .map((p) => p.text ?? '')
    .join('')
    .trim()

  return { text, usage: extractUsage(payload.usageMetadata), model }
}
