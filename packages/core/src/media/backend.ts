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
 * image-oriented and does not; non-image documents ride the `qwen-long`
 * file-upload flow instead: the buffer is uploaded via the OpenAI-compatible
 * Files API (`POST /files`, `purpose: "file-extract"`), and the returned
 * `file-id` is referenced as `fileid://<id>` in the system message of a
 * `qwen-long` chat completion. For PDFs, each page is additionally rendered
 * to a bounded JPEG and sent to Qwen-VL; page-numbered visual descriptions are
 * appended to the text extraction. Images still distill via Qwen-VL inline.
 *
 * See docs/architecture/engine/provider-abstraction.md → "Adapters".
 */

import type { TokenUsage } from '../providers/types.js'
import type { GoogleTransport } from '../providers/google-transport.js'
import { renderPdfPages } from '../files/pdf-pages.js'
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
}

/** DashScope substitutes these — a Gemini model id is meaningless there. */
export const DASHSCOPE_VISION_MODEL = 'qwen-vl-max'
export const DASHSCOPE_ASR_MODEL = 'qwen3-asr-flash'
export const DASHSCOPE_LONG_MODEL = 'qwen-long'

// DashScope's OpenAI-compatible endpoint rejects request bodies around 10 MB.
// Leave room for base64 expansion and JSON/prompt overhead rather than relying
// on the provider's edge to reject an otherwise valid camera image.
const DASHSCOPE_MAX_INLINE_IMAGE_BYTES = 6 * 1024 * 1024
const DASHSCOPE_MAX_PDF_VISUAL_PAGES = 10
const DASHSCOPE_PDF_PAGE_OUTPUT_TOKENS = 1024

const PDF_PAGE_VISUAL_PROMPT =
  'Analyze this rendered PDF page for visual information that plain text extraction can miss: ' +
  'photographs, charts, diagrams, signatures, stamps, handwriting, and layout-dependent relationships. ' +
  'Transcribe text that is part of those visuals. Return concise, faithful Markdown only. ' +
  'Do not repeat ordinary body text. If there is no meaningful visual information, return an empty string.'

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

async function runDashScopePdfVisuals(
  fetchFn: typeof fetch,
  backend: Extract<MediaBackend, { kind: 'dashscope' }>,
  req: MediaRequest,
  signal: AbortSignal,
): Promise<MediaResult> {
  const rendered = await renderPdfPages(req.buffer, { maxPages: DASHSCOPE_MAX_PDF_VISUAL_PAGES })
  const visionModel = backend.visionModel ?? DASHSCOPE_VISION_MODEL
  const visualSections: string[] = []
  const failedPages: number[] = []
  let visualUsage: TokenUsage | null = null
  let successfulPages = 0
  let firstFailure: unknown

  for (const page of rendered.pages) {
    try {
      const image = await prepareDashScopeImage(page.buffer, page.mime)
      const content = [
        { type: 'text', text: `${PDF_PAGE_VISUAL_PROMPT}\n\nPage ${page.pageNumber} of ${rendered.totalPages}.` },
        { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.buffer.toString('base64')}` } },
      ]
      const pageResult = await dashScopeChat(
        fetchFn,
        backend,
        visionModel,
        [{ role: 'user', content }],
        { ...req, maxOutputTokens: Math.min(req.maxOutputTokens, DASHSCOPE_PDF_PAGE_OUTPUT_TOKENS) },
        signal,
      )
      successfulPages++
      if (pageResult.text) visualSections.push(`### Page ${page.pageNumber}\n\n${pageResult.text}`)
      visualUsage = addUsage(visualUsage, pageResult.usage)
    } catch (err) {
      firstFailure ??= err
      failedPages.push(page.pageNumber)
      if (signal.aborted) break
    }
  }

  if (successfulPages === 0 && firstFailure) throw firstFailure
  if (failedPages.length > 0) {
    visualSections.push(`> Visual analysis could not process page${failedPages.length === 1 ? '' : 's'} ${failedPages.join(', ')}.`)
  }
  if (rendered.truncated && visualSections.length > 0) {
    visualSections.push(
      `> Visual analysis was limited to the first ${DASHSCOPE_MAX_PDF_VISUAL_PAGES} of ${rendered.totalPages} pages.`,
    )
  }

  return {
    text: visualSections.length > 0 ? `## Visual content\n\n${visualSections.join('\n\n')}` : '',
    usage: visualUsage,
    model: visionModel,
  }
}

async function runDashScopePdf(
  fetchFn: typeof fetch,
  backend: Extract<MediaBackend, { kind: 'dashscope' }>,
  req: MediaRequest,
  signal: AbortSignal,
): Promise<MediaResult> {
  const textPromise = (async () => {
    const fileId = await uploadDashScopeFile(backend, req.buffer, req.mime, fetchFn, signal)
    return dashScopeChat(
      fetchFn,
      backend,
      backend.longModel ?? DASHSCOPE_LONG_MODEL,
      [
        { role: 'system', content: `fileid://${fileId}` },
        { role: 'user', content: req.prompt },
      ],
      req,
      signal,
    )
  })()
  const [textOutcome, visualOutcome] = await Promise.allSettled([
    textPromise,
    runDashScopePdfVisuals(fetchFn, backend, req, signal),
  ])

  if (textOutcome.status === 'rejected' && visualOutcome.status === 'rejected') {
    throw textOutcome.reason
  }
  const textResult = textOutcome.status === 'fulfilled' ? textOutcome.value : undefined
  const visualResult = visualOutcome.status === 'fulfilled' ? visualOutcome.value : undefined
  if (!textResult) {
    console.warn(`[media/backend] DashScope PDF text extraction skipped: ${String(textOutcome.status === 'rejected' ? textOutcome.reason : 'no result')}`)
    return visualResult!
  }
  if (!visualResult) {
    console.warn(`[media/backend] DashScope PDF visual analysis skipped: ${String(visualOutcome.status === 'rejected' ? visualOutcome.reason : 'no result')}`)
    return textResult
  }

  const usageByModel = [
    ...(textResult.usage ? [{ model: textResult.model, usage: textResult.usage }] : []),
    ...(visualResult.usage ? [{ model: visualResult.model, usage: visualResult.usage }] : []),
  ]
  return {
    text: [textResult.text, visualResult.text].filter(Boolean).join('\n\n'),
    usage: addUsage(textResult.usage, visualResult.usage),
    model: `${textResult.model}+${visualResult.model}`,
    ...(usageByModel.length > 0 ? { usageByModel } : {}),
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
  req: MediaRequest,
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
