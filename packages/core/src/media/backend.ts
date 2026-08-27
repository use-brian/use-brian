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
 * | `provider` | full-page distillation through the deployment's own chat model | not supported |
 *
 * Google is one implementation covering both transports because AI Studio and
 * Vertex share a wire format — see `providers/google-transport.ts`.
 *
 * ## The one real asymmetry: PDFs
 *
 * Gemini ingests `application/pdf` natively as `inlineData`, but that output is
 * accepted only when every probed page returns its completion marker. An
 * incomplete native read and every other backend render ALL pages to bounded
 * JPEGs and read them through a vision model (`files/pdf-distill.ts`), which
 * is the same treatment a scan needs anyway. Non-PDF office documents on DashScope still ride the `qwen-long`
 * file-upload flow (`POST /files`, `purpose: "file-extract"`, then
 * `fileid://<id>` in a `qwen-long` system message); images still distill via
 * Qwen-VL inline.
 *
 * The `provider` backend exists so a deployment with no media API key at all —
 * a Codex-only OSS box, where the ChatGPT subscription is the only model
 * credential — still reads PDFs. It distills through the user's own chat
 * provider, which on a subscription plan costs nothing per token.
 *
 * See docs/architecture/engine/provider-abstraction.md → "Adapters".
 */

import type { LLMProvider, TokenUsage } from '../providers/types.js'
import type { GoogleTransport } from '../providers/google-transport.js'
import {
  DASHSCOPE_CHUNK_PAGES,
  DASHSCOPE_RENDER_WIDTH,
  MAX_DISTILL_PAGES,
  PROVIDER_CHUNK_PAGES,
  PROVIDER_RENDER_WIDTH,
  distillPdfViaPages,
  missingPdfPageCompletionMarkers,
  pdfPageCompletionMarker,
  stripPdfPageCompletionMarkers,
  type VisionCaller,
} from '../files/pdf-distill.js'
import { probePdfPageCount } from '../files/pdf-pages.js'
import sharp from 'sharp'

export type MediaBackend =
  | { kind: 'google'; transport: GoogleTransport }
  | {
      kind: 'dashscope'
      apiKey: string
      baseUrl: string
      /** Model id overrides — a deployment's Model Studio catalog varies by
       *  region and over time, so the built-in defaults (`qwen-vl-max` /
       *  `qwen3-asr-flash` / `qwen-long`) are not guaranteed to exist on every
       *  endpoint. Unset ⇒ the default constant. */
      visionModel?: string
      asrModel?: string
      longModel?: string
    }
  /**
   * The deployment's own chat provider, used as a vision model. Document-only:
   * a chat adapter has no transcription endpoint, so audio on this backend is
   * a loud error rather than a silent empty transcript.
   */
  | { kind: 'provider'; provider: LLMProvider; model: string }

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
  /** Per-model usage when one logical operation needs multiple models. */
  usageByModel?: Array<{ model: string; usage: TokenUsage }>
  /** The call stopped at its output ceiling. Drives the distiller's re-split. */
  truncated?: boolean
  /** PDF metadata from the validated document reader. */
  pageCount?: number
  /** The document reader omitted capped or unreadable pages. */
  documentTruncated?: boolean
  failedPages?: number[]
}

/**
 * Run `fn` under a deadline, honouring an outer abort as well. Each transport
 * owns its own AbortController here so one chunk's timeout never cancels its
 * siblings — the distillation engine fans chunks out in parallel.
 */
async function withTimeout<T>(
  timeoutMs: number,
  outer: AbortSignal | undefined,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  outer?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fn(controller.signal)
  } finally {
    clearTimeout(timer)
    outer?.removeEventListener('abort', onAbort)
  }
}

/** DashScope substitutes these — a Gemini model id is meaningless there. */
export const DASHSCOPE_VISION_MODEL = 'qwen-vl-max'
export const DASHSCOPE_ASR_MODEL = 'qwen3-asr-flash'
export const DASHSCOPE_LONG_MODEL = 'qwen-long'

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
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>
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

type GeminiInputPart = { text: string } | { inlineData: { mimeType: string; data: string } }

/** One `generateContent` call over arbitrary parts (text + any number of blobs). */
async function googleGenerate(
  fetchFn: typeof fetch,
  transport: GoogleTransport,
  model: string,
  parts: GeminiInputPart[],
  maxOutputTokens: number,
  errorLabel: string,
  signal: AbortSignal,
): Promise<MediaResult> {
  const response = await fetchFn(transport.endpoint(model, 'generateContent'), {
    method: 'POST',
    headers: await transport.headers(),
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0, maxOutputTokens },
    }),
    signal,
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(
      `Gemini ${errorLabel} failed (HTTP ${response.status}, ${transport.kind}): ${detail.slice(0, 300)}`,
    )
  }

  const payload = (await response.json()) as GeminiResponse
  const text = (payload.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? '')
    .join('')
    .trim()

  return {
    text,
    usage: extractGoogleUsage(payload.usageMetadata),
    model,
    truncated: payload.candidates?.[0]?.finishReason === 'MAX_TOKENS',
  }
}

async function runGoogle(
  transport: GoogleTransport,
  req: MediaRequest,
): Promise<MediaResult> {
  const fetchFn = req.fetchFn ?? fetch
  if (req.mime !== 'application/pdf') {
    return withTimeout(req.timeoutMs, undefined, (signal) =>
      googleGenerate(
        fetchFn,
        transport,
        req.model,
        [
          { text: req.prompt },
          { inlineData: { mimeType: req.mime, data: req.buffer.toString('base64') } },
        ],
        req.maxOutputTokens,
        req.errorLabel,
        signal,
      ),
    )
  }

  const pageCount = await probePdfPageCount(req.buffer)
  let native: MediaResult | null = null
  let nativeFailure: unknown
  if (pageCount !== null && pageCount > 0 && pageCount <= MAX_DISTILL_PAGES) {
    const pageNumbers = Array.from({ length: pageCount }, (_, index) => index + 1)
    const markerInstruction =
      `\n\nThis PDF has exactly ${pageCount} pages. Start every page with its exact \`## Page N\` heading. ` +
      'After the COMPLETE transcription of each page, append its exact plain-text marker on its own line. ' +
      'Never emit a marker before the whole page is complete. Required markers: ' +
      pageNumbers.map(pdfPageCompletionMarker).join(' ')
    try {
      native = await withTimeout(req.timeoutMs, undefined, (signal) =>
        googleGenerate(
          fetchFn,
          transport,
          req.model,
          [
            { text: req.prompt + markerInstruction },
            { inlineData: { mimeType: req.mime, data: req.buffer.toString('base64') } },
          ],
          req.maxOutputTokens,
          req.errorLabel,
          signal,
        ),
      )
    } catch (error) {
      nativeFailure = error
      console.warn(`[media/backend] Gemini native PDF read failed; trying rendered pages: ${String(error)}`)
    }
    if (native && missingPdfPageCompletionMarkers(native.text, pageNumbers).length === 0) {
      return {
        ...native,
        text: stripPdfPageCompletionMarkers(native.text),
        truncated: false,
        pageCount,
        documentTruncated: false,
        failedPages: [],
      }
    }
  }

  // Native PDF output is accepted only when every expected page marker is
  // present. Empty output, nominal end-turn truncation, an unknown page count,
  // and the page cap all fall back to the same rendered-page engine used by
  // every other provider.
  let renderedFailure: unknown
  const distilled = await distillPdfViaPages(req.buffer, {
    visionCaller: googleVisionCaller(fetchFn, transport, req.model, req.errorLabel),
    renderWidth: PROVIDER_RENDER_WIDTH,
    chunkPages: PROVIDER_CHUNK_PAGES,
    maxOutputTokensPerChunk: req.maxOutputTokens,
    timeoutMs: req.timeoutMs,
  }).catch((err) => {
    renderedFailure = err
    console.warn(`[media/backend] Gemini page-render fallback failed: ${String(err)}`)
    return null
  })
  if (!distilled?.text) {
    throw renderedFailure ?? nativeFailure ?? new Error(
      `Gemini ${req.errorLabel} could not produce a page-complete PDF transcription.`,
    )
  }
  const usageByModel = new Map<string, TokenUsage>()
  if (native?.usage) usageByModel.set(native.model, native.usage)
  for (const item of distilled.usageByModel) {
    usageByModel.set(item.model, addUsage(usageByModel.get(item.model) ?? null, item.usage)!)
  }
  return {
    text: distilled.text,
    usage: addUsage(native?.usage ?? null, distilled.usage),
    model: distilled.model,
    ...(usageByModel.size > 0
      ? { usageByModel: [...usageByModel].map(([model, usage]) => ({ model, usage })) }
      : {}),
    pageCount: distilled.totalPages,
    documentTruncated: distilled.truncated || distilled.failedPages.length > 0,
    failedPages: distilled.failedPages,
  }
}

// ── DashScope (Qwen-VL / Qwen-ASR) ─────────────────────────────

type OpenAIResponse = {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

/**
 * Audio mimes Qwen-ASR accepts inline. Anything else is rejected up front
 * rather than sent and misread.
 */
const SUPPORTED_AUDIO = /^audio\//

/**
 * Qwen-VL takes images only. Non-image documents (PDF, office) ride the
 * `qwen-long` file-upload flow instead — see the module header.
 */
const SUPPORTED_IMAGE = /^image\//

type DashScopeFileUploadResponse = { id?: string }

function addUsage(left: TokenUsage | null, right: TokenUsage | null): TokenUsage | null {
  if (!left) return right
  if (!right) return left
  const cacheReadTokens = (left.cacheReadTokens ?? 0) + (right.cacheReadTokens ?? 0)
  const cacheWriteTokens = (left.cacheWriteTokens ?? 0) + (right.cacheWriteTokens ?? 0)
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
  }
}

async function uploadDashScopeFile(
  backend: Extract<MediaBackend, { kind: 'dashscope' }>,
  buffer: Buffer,
  mime: string,
  fetchFn: typeof fetch,
  signal: AbortSignal,
): Promise<string> {
  const form = new FormData()
  form.append('file', new Blob([buffer], { type: mime }), `document.${mime.split('/')[1] ?? 'bin'}`)
  form.append('purpose', 'file-extract')

  const res = await fetchFn(`${backend.baseUrl}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${backend.apiKey}` },
    body: form,
    signal,
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(
      `DashScope file upload failed (HTTP ${res.status}): ${detail.slice(0, 300)}`,
    )
  }
  const payload = (await res.json()) as DashScopeFileUploadResponse
  if (!payload.id) throw new Error('DashScope file upload: response missing file id')
  return payload.id
}

/**
 * Qwen-VL over a batch of page images, as one OpenAI `image_url` message.
 * DashScope reports `finish_reason` per choice, which is what tells the
 * distillation engine a chunk was cut at its output ceiling.
 */
function dashScopeVisionCaller(
  fetchFn: typeof fetch,
  backend: Extract<MediaBackend, { kind: 'dashscope' }>,
  errorLabel: string,
): VisionCaller {
  const model = backend.visionModel ?? DASHSCOPE_VISION_MODEL
  return async (request) => {
    const prepared = await Promise.all(
      request.images.map((page) => prepareDashScopeImage(page.buffer, page.mime)),
    )
    const content = [
      { type: 'text', text: request.prompt },
      ...prepared.map((image) => ({
        type: 'image_url',
        image_url: { url: `data:${image.mime};base64,${image.buffer.toString('base64')}` },
      })),
    ]
    return withTimeout(request.timeoutMs, request.signal, (signal) =>
      dashScopeChat(
        fetchFn,
        backend,
        model,
        [{ role: 'user', content }],
        { maxOutputTokens: request.maxOutputTokens, errorLabel },
        signal,
      ),
    )
  }
}

/**
 * Gemini over a batch of page images as `inlineData` parts. Its live caller is
 * the completeness fallback in `runGoogle`: when a native read is empty,
 * errors, or omits any required page marker, rendering the pages recovers the
 * document through the provider-neutral validation engine.
 */
function googleVisionCaller(
  fetchFn: typeof fetch,
  transport: GoogleTransport,
  model: string,
  errorLabel: string,
): VisionCaller {
  return async (request) =>
    withTimeout(request.timeoutMs, request.signal, (signal) =>
      googleGenerate(
        fetchFn,
        transport,
        model,
        [
          { text: request.prompt },
          ...request.images.map((page) => ({
            inlineData: { mimeType: page.mime, data: page.buffer.toString('base64') },
          })),
        ],
        request.maxOutputTokens,
        errorLabel,
        signal,
      ),
    )
}

/**
 * The deployment's own chat model as the vision model. This is what unblocks a
 * box with no media API key: the pages ride ordinary `image` ContentBlocks, so
 * any adapter that accepts them works, and a ChatGPT subscription pays nothing
 * per token.
 */
function providerVisionCaller(provider: LLMProvider, model: string): VisionCaller {
  return async (request) => {
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    request.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), request.timeoutMs)
    try {
      let text = ''
      let usage: TokenUsage | null = null
      let truncated = false
      const stream = provider.stream({
        model,
        systemPrompt: 'You transcribe document pages into faithful Markdown.',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: request.prompt },
              ...request.images.map((page) => ({
                type: 'image' as const,
                mimeType: page.mime,
                data: page.buffer.toString('base64'),
              })),
            ],
          },
        ],
        maxTokens: request.maxOutputTokens,
        temperature: 0,
        signal: controller.signal,
      })
      for await (const chunk of stream) {
        if (chunk.type === 'text_delta') text += chunk.text
        else if (chunk.type === 'message_end') {
          usage = chunk.usage
          truncated = chunk.stopReason === 'max_tokens'
        }
      }
      return { text, usage, model, truncated }
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', onAbort)
    }
  }
}

/**
 * Every page of a PDF, transcribed by Qwen-VL in chunks.
 *
 * This replaced two parallel tracks: a `qwen-long` file-upload text extraction
 * AND a page-per-call Qwen-VL loop capped at 10 pages. The vision track
 * subsumes the text track (it transcribes the same body text plus everything
 * the text layer misses), so running both paid twice for one document and
 * still truncated it at page 10. Non-PDF office documents keep `qwen-long` —
 * they have no pages to render.
 */
async function runDashScopePdf(
  fetchFn: typeof fetch,
  backend: Extract<MediaBackend, { kind: 'dashscope' }>,
  req: MediaRequest,
  signal: AbortSignal,
): Promise<MediaResult> {
  const result = await distillPdfViaPages(req.buffer, {
    visionCaller: dashScopeVisionCaller(fetchFn, backend, req.errorLabel),
    renderWidth: DASHSCOPE_RENDER_WIDTH,
    chunkPages: DASHSCOPE_CHUNK_PAGES,
    maxOutputTokensPerChunk: req.maxOutputTokens,
    timeoutMs: req.timeoutMs,
    signal,
  })
  return {
    text: result.text,
    usage: result.usage,
    model: result.model,
    ...(result.usageByModel.length > 0 ? { usageByModel: result.usageByModel } : {}),
    pageCount: result.totalPages,
    documentTruncated: result.truncated || result.failedPages.length > 0,
    failedPages: result.failedPages,
  }
}

async function runDashScope(
  backend: Extract<MediaBackend, { kind: 'dashscope' }>,
  req: MediaRequest,
): Promise<MediaResult> {
  const fetchFn = req.fetchFn ?? fetch

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), req.timeoutMs)
  try {
    if (req.modality === 'audio') {
      if (!SUPPORTED_AUDIO.test(req.mime)) {
        throw new Error(`DashScope transcription expects an audio/* mime, got "${req.mime}".`)
      }
      const base64 = req.buffer.toString('base64')
      const content = [
        {
          type: 'input_audio',
          input_audio: { data: `data:${req.mime};base64,${base64}`, format: req.mime.split('/')[1] ?? 'wav' },
        },
      ]
      return await dashScopeChat(fetchFn, backend, backend.asrModel ?? DASHSCOPE_ASR_MODEL, [{ role: 'user', content }], req, controller.signal)
    }

    if (SUPPORTED_IMAGE.test(req.mime)) {
      const image = await prepareDashScopeImage(req.buffer, req.mime)
      const base64 = image.buffer.toString('base64')
      const content = [
        { type: 'text', text: req.prompt },
        { type: 'image_url', image_url: { url: `data:${image.mime};base64,${base64}` } },
      ]
      return await dashScopeChat(fetchFn, backend, backend.visionModel ?? DASHSCOPE_VISION_MODEL, [{ role: 'user', content }], req, controller.signal)
    }

    if (req.mime === 'application/pdf') {
      return await runDashScopePdf(fetchFn, backend, req, controller.signal)
    }

    const fileId = await uploadDashScopeFile(backend, req.buffer, req.mime, fetchFn, controller.signal)
    return await dashScopeChat(
      fetchFn,
      backend,
      backend.longModel ?? DASHSCOPE_LONG_MODEL,
      [
        { role: 'system', content: `fileid://${fileId}` },
        { role: 'user', content: req.prompt },
      ],
      req,
      controller.signal,
    )
  } finally {
    clearTimeout(timer)
  }
}

type DashScopeMessage = { role: string; content: unknown }

async function dashScopeChat(
  fetchFn: typeof fetch,
  backend: Extract<MediaBackend, { kind: 'dashscope' }>,
  model: string,
  messages: DashScopeMessage[],
  req: { maxOutputTokens: number; errorLabel: string },
  signal?: AbortSignal,
): Promise<MediaResult> {
  const response = await fetchFn(`${backend.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${backend.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: req.maxOutputTokens,
      temperature: 0,
    }),
    ...(signal ? { signal } : {}),
  })

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

  return { text, usage, model, truncated: payload.choices?.[0]?.finish_reason === 'length' }
}

/**
 * The deployment's chat model as a document reader. PDFs render to pages and
 * distill; a single image rides one `image` block; audio has no path here —
 * a chat adapter has no transcription endpoint, and returning empty text
 * would read to the caller as "this recording is silent".
 */
async function runProviderBacked(
  backend: Extract<MediaBackend, { kind: 'provider' }>,
  req: MediaRequest,
): Promise<MediaResult> {
  if (req.modality === 'audio') {
    throw new Error(
      `${req.errorLabel} is not available: this deployment has no media backend, and a chat ` +
      `provider cannot transcribe audio. Configure a Google or DashScope credential.`,
    )
  }
  const caller = providerVisionCaller(backend.provider, backend.model)

  if (req.mime === 'application/pdf') {
    const result = await distillPdfViaPages(req.buffer, {
      visionCaller: caller,
      renderWidth: PROVIDER_RENDER_WIDTH,
      chunkPages: PROVIDER_CHUNK_PAGES,
      maxOutputTokensPerChunk: req.maxOutputTokens,
      timeoutMs: req.timeoutMs,
    })
    return {
      text: result.text,
      usage: result.usage,
      model: result.model,
      ...(result.usageByModel.length > 0 ? { usageByModel: result.usageByModel } : {}),
      pageCount: result.totalPages,
      documentTruncated: result.truncated || result.failedPages.length > 0,
      failedPages: result.failedPages,
    }
  }

  if (!SUPPORTED_IMAGE.test(req.mime)) {
    throw new Error(
      `${req.errorLabel} on a chat-provider backend supports PDFs and images only, got "${req.mime}".`,
    )
  }
  return caller({
    images: [{ pageNumber: 1, buffer: req.buffer, mime: req.mime }],
    prompt: req.prompt,
    maxOutputTokens: req.maxOutputTokens,
    timeoutMs: req.timeoutMs,
  })
}

/** Dispatch one media-understanding call to the configured adapter. */
export async function runMediaUnderstanding(
  backend: MediaBackend,
  req: MediaRequest,
): Promise<MediaResult> {
  if (backend.kind === 'dashscope') return runDashScope(backend, req)
  if (backend.kind === 'provider') return runProviderBacked(backend, req)
  return runGoogle(backend.transport, req)
}
