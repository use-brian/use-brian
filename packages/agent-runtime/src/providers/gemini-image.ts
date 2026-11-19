/** Gemini native images over the deployment's existing transport. [COMP:core/gemini-image] */
import { FEED_IMAGE_CAPABILITY, feedImageCost } from '@use-brian/shared'
import { loadSharp } from './sharp-loader.js'
import { authorizeGoogleRequest, type GoogleTransport } from './google-transport.js'
import { isDefinitelyUndispatchedGoogleRequest, retryGooglePreDispatch } from './google-auth.js'
export type GeneratedImageReceipt = {
  image?: { data: string; mimeType: 'image/png' | 'image/jpeg' | 'image/webp' };
  error?: 'image_provider_rejected' | 'image_refused' | 'image_missing' | 'image_malformed' | 'image_tool_not_invoked' | 'image_tool_incomplete';
  status?: number; responseId?: string;
  providerError?: { code?: string; message?: string; fields?: string[] };
  providerDiagnostics?: {
    provider: 'openai-codex';
    events: Array<{ method: 'item/started' | 'item/completed' | 'turn/completed'; itemType?: string; status?: string }>;
    process?: { stderrBytes: number; stderrTruncated: boolean };
  };
  usage: { inputTokens: number; outputTokens: number; imageTokens?: number; measured: boolean };
}
export type GeminiImageReceipt = GeneratedImageReceipt
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const tokens = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
const boundedText = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) || undefined : undefined
async function parseGeminiProviderError(response: Response): Promise<GeneratedImageReceipt['providerError']> {
  try {
    if (!response.body) return undefined
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.length
      if (size > 32 * 1024) { await reader.cancel(); return undefined }
      chunks.push(part.value)
    }
    const error = record(record(JSON.parse(Buffer.concat(chunks).toString('utf8'))).error)
    const details = Array.isArray(error.details) ? error.details.map(record) : []
    const fields = details.flatMap(detail => Array.isArray(detail.fieldViolations) ? detail.fieldViolations.map(record) : [])
      .map(violation => boundedText(violation.field, 160))
      .filter((field): field is string => Boolean(field && /^[A-Za-z0-9_.\[\]-]+$/.test(field)))
      .slice(0, 8)
    const code = boundedText(error.status, 64); const message = boundedText(error.message, 512)
    return code || message || fields.length ? { ...(code ? { code } : {}), ...(message ? { message } : {}), ...(fields.length ? { fields } : {}) } : undefined
  } catch { return undefined }
}
export function parseGeminiImageReceipt(raw: unknown): GeminiImageReceipt {
  const root = record(raw); const usage = record(root.usageMetadata)
  const imageDetail = Array.isArray(usage.candidatesTokensDetails) ? usage.candidatesTokensDetails.map(record).find(item => item.modality === 'IMAGE') : undefined
  const measured = tokens(usage.promptTokenCount) !== undefined && tokens(usage.candidatesTokenCount) !== undefined
  const receipt: GeminiImageReceipt = { usage: { inputTokens: tokens(usage.promptTokenCount) ?? FEED_IMAGE_CAPABILITY.inputCharacters, outputTokens: (tokens(usage.candidatesTokenCount) ?? FEED_IMAGE_CAPABILITY.outputTokens) + (tokens(usage.thoughtsTokenCount) ?? 0), imageTokens: tokens(imageDetail?.tokenCount), measured }, ...(typeof root.responseId === 'string' ? { responseId: root.responseId.slice(0, 256) } : {}) }
  if (record(root.promptFeedback).blockReason) return { ...receipt, error: 'image_refused' }
  const candidates = Array.isArray(root.candidates) ? root.candidates.map(record) : []
  if (candidates.some(candidate => candidate.finishReason && !['STOP', 'MAX_TOKENS'].includes(String(candidate.finishReason)))) return { ...receipt, error: 'image_refused' }
  const parts = candidates.flatMap(candidate => { const parts = record(candidate.content).parts; return Array.isArray(parts) ? parts.map(record) : [] }).filter(part => part.thought !== true)
  const images = parts.filter(part => part.inlineData !== undefined)
  if (!images.length) return { ...receipt, error: 'image_missing' }
  if (images.length !== 1 || candidates.length !== 1) return { ...receipt, error: 'image_malformed' }
  const image = record(images[0]!.inlineData)
  if (typeof image.data !== 'string' || !image.data.length || image.data.length > Math.ceil(FEED_IMAGE_CAPABILITY.maxImageBytes / 3) * 4 || Buffer.from(image.data, 'base64').toString('base64') !== image.data) return { ...receipt, error: 'image_malformed' }
  const bytes = Buffer.from(image.data, 'base64')
  const valid = image.mimeType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : image.mimeType === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : image.mimeType === 'image/webp' ? bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' : false
  if (!valid || bytes.length > FEED_IMAGE_CAPABILITY.maxImageBytes) return { ...receipt, error: 'image_malformed' }
  return { ...receipt, image: { data: image.data, mimeType: image.mimeType as NonNullable<GeminiImageReceipt['image']>['mimeType'] } }
}
export function createGeminiImageProvider(transport: GoogleTransport | undefined, fetcher: typeof fetch = fetch) {
  return { async generate(input: { model: string; prompt: string; aspectRatio?: string; sourceImage?: NonNullable<GeneratedImageReceipt['image']>; signal: AbortSignal }): Promise<GeminiImageReceipt> {
    if (!transport) throw new Error('image_generation_unavailable')
    // Before dispatch: an unavailable codec must not cost a generation, and is
    // never reported as a malformed image.
    const sharp = await loadSharp()
    const authorization = await authorizeGoogleRequest(transport)
    const headers = authorization.headers
    if (transport.kind === 'ai-studio' && !headers['x-goog-api-key']) throw new Error('image_generation_unavailable')
    const endpoint = transport.endpoint(input.model, 'generateContent')
    const request: RequestInit = { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, signal: input.signal, body: JSON.stringify({ contents: [{ role: 'user', parts: [...(input.sourceImage ? [{ inlineData: input.sourceImage }] : []), { text: input.prompt }] }], generationConfig: { candidateCount: 1, responseModalities: ['IMAGE'], maxOutputTokens: FEED_IMAGE_CAPABILITY.outputTokens, imageConfig: { imageSize: FEED_IMAGE_CAPABILITY.size, aspectRatio: input.aspectRatio ?? '1:1' }, thinkingConfig: { thinkingLevel: 'MINIMAL', includeThoughts: false } } }) }
    const response = await retryGooglePreDispatch(() => fetcher(endpoint, request), {
      signal: input.signal,
      shouldRetry: isDefinitelyUndispatchedGoogleRequest,
      onRetry: details => console.warn('[gemini-image] connection failed before provider dispatch; retrying', details),
    })
    if (!response.ok) return { error: 'image_provider_rejected', status: response.status, providerError: await parseGeminiProviderError(response), usage: { inputTokens: 0, outputTokens: 0, measured: false } }
    if (!response.body) return { error: 'image_malformed', usage: { inputTokens: 0, outputTokens: 0, measured: false } }
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > FEED_IMAGE_CAPABILITY.maxImageBytes * 1.5) { await reader.cancel(); return { error: 'image_malformed', usage: { inputTokens: input.prompt.length, outputTokens: FEED_IMAGE_CAPABILITY.outputTokens, measured: false } } } chunks.push(part.value) }
    let receipt: GeminiImageReceipt
    try { receipt = parseGeminiImageReceipt(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { return { error: 'image_malformed', usage: { inputTokens: input.prompt.length, outputTokens: FEED_IMAGE_CAPABILITY.outputTokens, measured: false } } }
    if (receipt.image) {
      try { await sharp(Buffer.from(receipt.image.data, 'base64'), { failOn: 'error', limitInputPixels: FEED_IMAGE_CAPABILITY.maxImagePixels }).raw().toBuffer() }
      catch { const { image: _image, ...retained } = receipt; return { ...retained, error: 'image_malformed' } }
    }
    if (authorization.recordSpend) {
      const costUsd = feedImageCost(
        FEED_IMAGE_CAPABILITY.rates,
        receipt.usage.inputTokens,
        receipt.usage.outputTokens,
        receipt.usage.imageTokens,
      )
      await authorization.recordSpend(input.model, {
        inputTokens: receipt.usage.inputTokens,
        outputTokens: receipt.usage.outputTokens,
        calculatedCostUsd: costUsd,
      }).catch(() => {})
    }
    return receipt
  } }
}

/** Validate an authorized edit source before any provider dispatch. */
export async function validateFeedImageSource(bytes: Uint8Array, mimeType: string): Promise<{ image: NonNullable<GeneratedImageReceipt['image']>; inputTokens: number }> {
  if (!bytes.length || bytes.length > FEED_IMAGE_CAPABILITY.maxSourceImageBytes) throw new Error('image_source_invalid')
  const sharp = await loadSharp()
  const image = sharp(bytes, { failOn: 'error', limitInputPixels: FEED_IMAGE_CAPABILITY.maxImagePixels })
  const metadata = await image.metadata()
  const expected = ({ png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as const)[metadata.format as 'png' | 'jpeg' | 'webp']
  if (!expected || mimeType !== expected || !metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1) throw new Error('image_source_invalid')
  await image.raw().toBuffer()
  // Flash Image charges 1,120 tokens per input image; retain a conservative
  // tiled allowance above that floor for larger supported sources.
  const inputTokens = Math.max(FEED_IMAGE_CAPABILITY.rates.imageTokens, Math.ceil(metadata.width / 384) * Math.ceil(metadata.height / 384) * 258)
  return { image: { data: Buffer.from(bytes).toString('base64'), mimeType: expected }, inputTokens }
}
