/**
 * Gemini-backed audio transcription.
 *
 * One function: buffer + mime → transcript + usage. Uses Gemini's
 * `generateContent` REST endpoint with an `inlineData` audio part, matching
 * the wire format already used for image inputs in `providers/gemini.ts`.
 *
 * The module never reads env directly (per packages/core/CLAUDE.md) — the
 * caller passes `apiKey` from `env.GEMINI_API_KEY`.
 *
 * Pattern reference: OpenClaw `extensions/qqbot/src/stt.ts:49-82` — the
 * one-provider channel-local pattern, not the framework registry pattern.
 *
 * Returns token usage so the caller can attribute it as an `overhead:*` row
 * in `usage_tracking`.
 */

import type { TokenUsage } from '../providers/types.js'

export type TranscribeOptions = {
  apiKey: string
  /** Gemini model id. Default: `gemini-2.5-flash`. */
  model?: string
  /** Instruction to the model. Default: a terse verbatim-transcript directive. */
  prompt?: string
  /** Abort after N ms. Default: 30_000. */
  timeoutMs?: number
  /** Injected for tests. Defaults to global `fetch`. */
  fetchFn?: typeof fetch
}

export type TranscribeResult = {
  text: string
  usage: TokenUsage | null
  model: string
}

const DEFAULT_MODEL = 'gemini-2.5-flash'
const DEFAULT_PROMPT =
  'Transcribe the attached audio verbatim. Output ONLY the transcript text — no commentary, no timestamps, no speaker labels. If the audio is silent or unintelligible, output an empty string.'
const DEFAULT_TIMEOUT_MS = 30_000
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

export async function transcribeAudio(
  input: { buffer: Buffer; mime: string },
  options: TranscribeOptions,
): Promise<TranscribeResult> {
  const model = options.model ?? DEFAULT_MODEL
  const prompt = options.prompt ?? DEFAULT_PROMPT
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
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
      maxOutputTokens: 2048,
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
      `Gemini transcription failed (HTTP ${response.status}): ${detail.slice(0, 300)}`,
    )
  }

  const payload = (await response.json()) as GeminiResponse
  const parts = payload.candidates?.[0]?.content?.parts ?? []
  const text = parts
    .map((p) => p.text ?? '')
    .join('')
    .trim()

  if (!text) {
    throw new Error('Gemini transcription response missing text')
  }
  return { text, usage: extractUsage(payload.usageMetadata), model }
}
