/**
 * Multimodal understanding backend — the seam behind file distillation and
 * short-audio transcription.
 *
 * Both callers do structurally the same thing: hand a model one prompt plus one
 * inline media blob and read back text. They previously each hardcoded the AI
 * Studio host and took a raw `apiKey: string`, which is what made them look
 * un-portable. They aren't — the capability exists on every adapter, it just
 * had nowhere to plug in. This module is that plug.
 *
 * ## Per-adapter mapping
 *
 * | Adapter | Documents | Audio |
 * |---|---|---|
 * | `google` (AI Studio + Vertex) | `inlineData` → `:generateContent` | same |
 * | `dashscope` | Qwen-VL via OpenAI `image_url` data URI | Qwen-ASR via OpenAI `input_audio` |
 *
 * Google is one implementation covering both transports because AI Studio and
 * Vertex share a wire format — see `providers/google-transport.ts`.
 *
 * ## The one real asymmetry: PDFs on DashScope
 *
 * Gemini ingests `application/pdf` natively as `inlineData`. Qwen-VL is
 * image-oriented and does not; Alibaba's documented path for documents is the
 * separate `qwen-long` file-upload flow, not an inline data URI. Rather than
 * silently send a PDF that comes back as garbage, `dashscope` rejects non-image
 * document mimes with an actionable error. Images distill normally.
 *
 * See docs/architecture/engine/provider-abstraction.md → "Adapters".
 */

import type { TokenUsage } from '../providers/types.js'
import type { GoogleTransport } from '../providers/google-transport.js'
import sharp from 'sharp'

export type MediaBackend =
  | { kind: 'google'; transport: GoogleTransport }
  | { kind: 'dashscope'; apiKey: string; baseUrl: string }

/** Which sense the model is being asked to use — selects the DashScope model + content part. */
export type MediaModality = 'document' | 'audio'

export type MediaRequest = {
  buffer: Buffer
  mime: string
  prompt: string
  modality: MediaModality
  /** Wire model. Callers pass their own default; DashScope substitutes its own. */
  model: string
  maxOutputTokens: number
  timeoutMs: number
  fetchFn?: typeof fetch
  /**
   * Prefix for HTTP-failure messages ("file distillation" / "voice
   * transcription"). Callers own their own wording — existing error contracts
   * (and the tests asserting them) key off these strings.
   */
  errorLabel: string
}

export type MediaResult = {
  text: string
  usage: TokenUsage | null
  model: string
}

/** DashScope substitutes these — a Gemini model id is meaningless there. */
export const DASHSCOPE_VISION_MODEL = 'qwen-vl-max'
export const DASHSCOPE_ASR_MODEL = 'qwen3-asr-flash'

// DashScope's OpenAI-compatible endpoint rejects request bodies around 10 MB.
// Leave room for base64 expansion and JSON/prompt overhead rather than relying
// on the provider's edge to reject an otherwise valid camera image.
const DASHSCOPE_MAX_INLINE_IMAGE_BYTES = 6 * 1024 * 1024

async function prepareDashScopeImage(buffer: Buffer, mime: string): Promise<{ buffer: Buffer; mime: string }> {
  if (buffer.length <= DASHSCOPE_MAX_INLINE_IMAGE_BYTES) return { buffer, mime }

  const resized = await sharp(buffer, { failOn: 'warning' })
    .rotate()
    .resize({ width: 4096, height: 4096, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer()

  if (resized.length > DASHSCOPE_MAX_INLINE_IMAGE_BYTES) {
    throw new Error(
      `DashScope image remains too large after downscaling (${resized.length} bytes; ` +
      `limit ${DASHSCOPE_MAX_INLINE_IMAGE_BYTES}). Resize or compress the image and try again.`,
    )
  }
  return { buffer: resized, mime: 'image/jpeg' }
}

// ── Google (AI Studio + Vertex) ────────────────────────────────

type GeminiPart = { text?: string }
type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    cachedContentTokenCount?: number
    thoughtsTokenCount?: number
  }
}

/**
 * Billing-accurate usage. Two adjustments that are easy to drop and cost real
 * money if you do: cached tokens are SUBTRACTED from input (Gemini reports them
 * inside promptTokenCount, so counting both double-bills the cache), and
 * thinking tokens are ADDED to output (they are billed as output but reported
 * separately). Mirrors the extraction these two callers each had inline.
 */
function extractGoogleUsage(meta: GeminiResponse['usageMetadata']): TokenUsage | null {
  if (!meta) return null
  const cached = meta.cachedContentTokenCount ?? 0
  const thoughts = meta.thoughtsTokenCount ?? 0
  return {
    inputTokens: (meta.promptTokenCount ?? 0) - cached,
    outputTokens: (meta.candidatesTokenCount ?? 0) + thoughts,
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
  }
}

async function runGoogle(
  transport: GoogleTransport,
  req: MediaRequest,
): Promise<MediaResult> {
  const fetchFn = req.fetchFn ?? fetch
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: req.prompt },
          { inlineData: { mimeType: req.mime, data: req.buffer.toString('base64') } },
        ],
      },
    ],
    generationConfig: { temperature: 0, maxOutputTokens: req.maxOutputTokens },
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), req.timeoutMs)
  let response: Response
  try {
    response = await fetchFn(transport.endpoint(req.model, 'generateContent'), {
      method: 'POST',
      headers: await transport.headers(),
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(
      `Gemini ${req.errorLabel} failed (HTTP ${response.status}, ${transport.kind}): ${detail.slice(0, 300)}`,
    )
  }

  const payload = (await response.json()) as GeminiResponse
  const text = (payload.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? '')
    .join('')
    .trim()

  return { text, usage: extractGoogleUsage(payload.usageMetadata), model: req.model }
}

// ── DashScope (Qwen-VL / Qwen-ASR) ─────────────────────────────

type OpenAIResponse = {
  choices?: Array<{ message?: { content?: string | null } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

/**
 * Audio mimes Qwen-ASR accepts inline. Anything else is rejected up front
 * rather than sent and misread.
 */
const SUPPORTED_AUDIO = /^audio\//

/**
 * Qwen-VL takes images only. `application/pdf` and office mimes need the
 * `qwen-long` upload flow instead — see the module header.
 */
const SUPPORTED_IMAGE = /^image\//

async function runDashScope(
  backend: Extract<MediaBackend, { kind: 'dashscope' }>,
  req: MediaRequest,
): Promise<MediaResult> {
  const fetchFn = req.fetchFn ?? fetch
  let model: string
  let content: unknown[]

  if (req.modality === 'audio') {
    if (!SUPPORTED_AUDIO.test(req.mime)) {
      throw new Error(`DashScope transcription expects an audio/* mime, got "${req.mime}".`)
    }
    model = DASHSCOPE_ASR_MODEL
    const base64 = req.buffer.toString('base64')
    // `qwen3-asr-flash` is a DEDICATED ASR task model, not a chat model with
    // ears: any text part in the same message is rejected outright with
    // `InternalError.Algo.InvalidParameter: The dedicated task 'asr' ... does
    // not support this input`, whatever the audio is. So `req.prompt` is
    // deliberately dropped here — there is no prompt channel to honour, and
    // sending one fails 100% of transcriptions (verified 2026-07-21: audio-only
    // 200, text+audio 400, at both 8s and 5min, `format` irrelevant).
    content = [
      // OpenAI-compatible audio part. `format` is the bare subtype
      // (`audio/ogg` → `ogg`), which is what the API expects.
      {
        type: 'input_audio',
        input_audio: { data: `data:${req.mime};base64,${base64}`, format: req.mime.split('/')[1] ?? 'wav' },
      },
    ]
  } else {
    if (!SUPPORTED_IMAGE.test(req.mime)) {
      throw new Error(
        `DashScope document distillation supports image/* only (got "${req.mime}"). ` +
        `Qwen-VL cannot ingest PDFs or office documents as inline data — those need the ` +
        `qwen-long upload flow, which is not implemented. Use LLM_ADAPTER=google-ai-studio ` +
        `or vertex for this file type, or convert it to images first.`,
      )
    }
    model = DASHSCOPE_VISION_MODEL
    const image = await prepareDashScopeImage(req.buffer, req.mime)
    const base64 = image.buffer.toString('base64')
    content = [
      { type: 'text', text: req.prompt },
      { type: 'image_url', image_url: { url: `data:${image.mime};base64,${base64}` } },
    ]
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), req.timeoutMs)
  let response: Response
  try {
    response = await fetchFn(`${backend.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${backend.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content }],
        max_tokens: req.maxOutputTokens,
        temperature: 0,
      }),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(
      `DashScope ${req.errorLabel} failed (HTTP ${response.status}): ${detail.slice(0, 300)}`,
    )
  }

  const payload = (await response.json()) as OpenAIResponse
  const text = (payload.choices?.[0]?.message?.content ?? '').trim()
  const usage = payload.usage
    ? { inputTokens: payload.usage.prompt_tokens ?? 0, outputTokens: payload.usage.completion_tokens ?? 0 }
    : null

  return { text, usage, model }
}

/** Dispatch one media-understanding call to the configured adapter. */
export async function runMediaUnderstanding(
  backend: MediaBackend,
  req: MediaRequest,
): Promise<MediaResult> {
  return backend.kind === 'dashscope'
    ? runDashScope(backend, req)
    : runGoogle(backend.transport, req)
}
