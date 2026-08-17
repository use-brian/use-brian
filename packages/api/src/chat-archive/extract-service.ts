/**
 * Stateless media extraction for the message store.
 *
 * The archive owns the attachment bytes and the extraction queue; this is the
 * function it calls. Nothing here is persisted, claimed or retried — the store
 * decides what needs extracting and what to do when it fails, so a restart on
 * either side costs a retry rather than a job stranded in a process that has
 * gone away.
 *
 * Extraction stayed on the platform for one reason: it is a toolchain, not a
 * function. ffmpeg, an external SILK decoder for WeChat voice notes, a cloud ASR
 * fallback chain, Office and PDF parsing, and a vision model for frames and
 * images. Duplicating that in the store would be a project of its own.
 *
 * Chunking deliberately does NOT happen here. Segmentation belongs to whoever
 * owns the segments, and that is the store now; this returns whole passages with
 * the metadata that locates them.
 *
 * [COMP:integrations/chat-archive-extract]
 */

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import type { RecordingTranscriber } from '@use-brian/core'
import { detectDocumentFormat, parseFileContent } from '@use-brian/core'
import { extractRecordingAudio, probeRecordingDuration } from '../recordings/ffmpeg.js'

const execFileAsync = promisify(execFile)

const MAX_VIDEO_FRAMES = 120
const MAX_MEDIA_DURATION_MS = 180 * 60 * 1000

/**
 * Bytes we are willing to read as plain text when nothing else identifies them.
 *
 * A NUL byte is the classic binary tell, and a run of C0 control characters
 * means the same thing. Sampling the head is enough: a text file that opens
 * with 8KB of clean text and turns binary later is not a case worth serving.
 */
const TEXT_SNIFF_BYTES = 8192

function looksLikeText(buffer: Buffer): boolean {
  const head = buffer.subarray(0, TEXT_SNIFF_BYTES)
  if (head.length === 0) return false
  let suspicious = 0
  for (const byte of head) {
    if (byte === 0) return false
    // Tab, LF, CR and FF are ordinary in text; the rest of C0 is not.
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d) suspicious++
  }
  if (suspicious / head.length > 0.01) return false
  // Reject lone surrogates / invalid sequences rather than indexing U+FFFD soup.
  return !new TextDecoder('utf-8', { fatal: false }).decode(head).includes('\uFFFD')
}

/**
 * Is this `parseFileContent` output a failure notice rather than the document?
 *
 * The parser never throws for an unreadable file; it returns a short bracketed
 * sentence meant for a human reading a chat — "[Document: x.doc. Could not parse
 * this document.]" or "[File: x, type: y. Content type not supported for text
 * extraction.]". That text is non-empty, so indexing it verbatim would embed the
 * apology and rank it against real queries: an archive full of "could not parse"
 * segments matching every question about a document. Exactly the failure the
 * media-stub segments had, where placeholder text displaced real content.
 *
 * Matched on both shape and phrase. `TestUnparseableDocument` drives the real
 * parser rather than a stub, so rewording these notices upstream fails loudly
 * here instead of silently filling the index again.
 */
function isParserFailureNotice(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']') || trimmed.includes('\n')) return false
  return /could not parse|not supported for text extraction/i.test(trimmed)
}

export type ExtractModality = 'ocr' | 'transcript' | 'document' | 'video_frames'

export type ExtractedText = {
  text: string
  metadata?: Record<string, unknown>
}

export type ExtractResult = {
  texts: ExtractedText[]
  /**
   * Terminal, successful answer: there is nothing extractable and never will
   * be. The store records it and stops retrying, rather than burning attempts on
   * a photo of a landscape.
   */
  unsupported?: boolean
}

export type ExtractRequest = {
  modality: ExtractModality
  mime: string
  filename?: string
  /**
   * Language the store wants descriptions written in, derived from the
   * conversation the asset came from. Overrides `deps.language`, which is a
   * deployment-wide default and cannot know that one chat is in Cantonese and
   * the next in English.
   */
  language?: string
  buffer: Buffer
}

export type ExtractServiceDeps = {
  transcriber?: RecordingTranscriber
  distill?: (input: { buffer: Buffer; mime: string; prompt?: string }) => Promise<string>
  language?: string
  logger?: Pick<Console, 'warn'>
}

export type ExtractService = {
  extract(request: ExtractRequest): Promise<ExtractResult>
}

const OCR_PROMPT =
  'Transcribe every visible word in this image faithfully. Preserve reading order. ' +
  'Return only the transcription.'

const DESCRIPTION_PROMPT =
  'Describe the meaningful visual content of this image for semantic search, including people, ' +
  'objects, setting, actions, charts, and notable details. Do not invent hidden facts.'

const FRAME_PROMPT =
  'Describe this sampled video frame for semantic search. Include visible people, objects, setting, ' +
  'actions, text, and other concrete details. Do not invent context.'

const LANGUAGE_NAMES: Record<string, string> = {
  zh: 'Chinese', ja: 'Japanese', ko: 'Korean',
  en: 'English', es: 'Spanish', fr: 'French', de: 'German',
  pt: 'Portuguese', ru: 'Russian', ar: 'Arabic', hi: 'Hindi', th: 'Thai', vi: 'Vietnamese',
}

/**
 * Ask for the description in the conversation's language.
 *
 * These segments exist to be retrieved, and they are retrieved by the people in
 * that chat typing in their own language. A Chinese-language conversation whose
 * media is described in English produces segments its own participants cannot
 * find: cross-lingual embedding carries an English query into a CJK corpus, but
 * a CJK query into English derived text loses to the genuine CJK messages
 * competing for the same slots. Observed 2026-08-17 — a Cantonese question
 * about a video did not retrieve that video's own English frame description.
 *
 * OCR is deliberately excluded: transcription must reproduce what the image
 * actually says, never translate it.
 */
function withLanguage(prompt: string, language: string | undefined): string {
  const tag = (language ?? '').trim().toLowerCase().split(/[-_]/)[0]
  if (!tag) return prompt
  const name = LANGUAGE_NAMES[tag]
  // An unrecognised tag still names itself well enough for the model, and
  // guessing wrong here costs a description in the wrong language, not a
  // failure — so pass it through rather than silently dropping the hint.
  return `${prompt} Write your response in ${name ?? tag}.`
}

/** Materialises the request body so ffmpeg, which works on paths, can read it. */
async function withTempFile<T>(
  buffer: Buffer,
  filename: string,
  run: (path: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'chat-extract-'))
  const path = join(dir, filename || 'input.bin')
  try {
    await writeFile(path, buffer)
    return await run(path)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** WeChat voice notes arrive as SILK, which nothing downstream understands. */
async function decodeWechatSilk(
  data: Buffer,
  decoderBin = process.env.WECHAT_SILK_DECODER_BIN?.trim() || 'silk_v3_decoder',
): Promise<{ buffer: Buffer; mime: string; durationMs: number }> {
  const dir = await mkdtemp(join(tmpdir(), 'wechat-silk-'))
  const input = join(dir, 'input.silk')
  const pcm = join(dir, 'output.pcm')
  const output = join(dir, 'output.m4a')
  try {
    await writeFile(input, data)
    try {
      await execFileAsync(decoderBin, [input, pcm, '-quiet'], { timeout: 120_000, maxBuffer: 1 << 20 })
    } catch (err) {
      throw new Error(
        `WeChat SILK decoder prerequisite failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    await execFileAsync('ffmpeg', [
      '-v', 'error', '-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', pcm,
      '-ar', '16000', '-c:a', 'aac', '-b:a', '24k', output,
    ], { timeout: 120_000, maxBuffer: 1 << 20 })
    const durationMs = await probeRecordingDuration(output)
    return { buffer: await readFile(output), mime: 'audio/mp4', durationMs }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function sampleVideoFrames(input: string): Promise<Array<{ data: Buffer; timeStartMs: number }>> {
  const dir = await mkdtemp(join(tmpdir(), 'chat-video-'))
  try {
    const pattern = join(dir, 'frame-%03d.jpg')
    const filter = [
      'select=gt(scene\\,0.30)+isnan(prev_selected_t)+gte(t-prev_selected_t\\,10)',
      'mpdecimate',
      "scale='min(1280,iw)':-2",
      'showinfo',
    ].join(',')
    const { stderr } = await execFileAsync('ffmpeg', [
      '-v', 'info', '-y', '-i', input, '-vf', filter, '-vsync', 'vfr',
      '-frames:v', String(MAX_VIDEO_FRAMES), '-q:v', '3', pattern,
    ], { timeout: 900_000, maxBuffer: 8 << 20 })
    const times = [...stderr.matchAll(/pts_time:([0-9.]+)/g)].map((match) => Math.round(Number(match[1]) * 1000))
    const files = (await readdir(dir)).filter((name) => /^frame-\d+\.jpg$/.test(name)).sort()
    return Promise.all(files.slice(0, MAX_VIDEO_FRAMES).map(async (name, index) => ({
      data: await readFile(join(dir, name)),
      timeStartMs: Number.isFinite(times[index]) ? times[index]! : index * 10_000,
    })))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export function createExtractService(deps: ExtractServiceDeps): ExtractService {
  const logger = deps.logger ?? console

  async function transcribe(
    request: ExtractRequest,
    modality: 'audio_transcript' | 'video_transcript',
  ): Promise<ExtractedText[]> {
    if (!deps.transcriber) throw new Error('chat archive media transcription prerequisite missing')

    let audio: { buffer: Buffer; mime: string }
    let durationMs: number
    const isSilk = request.mime === 'audio/silk' || (request.filename ?? '').toLowerCase().endsWith('.silk')
    if (isSilk) {
      const decoded = await decodeWechatSilk(request.buffer)
      audio = decoded
      durationMs = decoded.durationMs
    } else {
      const probed = await withTempFile(request.buffer, request.filename ?? 'input.media', async (path) => ({
        durationMs: await probeRecordingDuration(path),
        audio: await extractRecordingAudio(path),
      }))
      durationMs = probed.durationMs
      audio = probed.audio
    }
    if (durationMs > MAX_MEDIA_DURATION_MS) {
      throw new Error('chat archive media exceeds the 180 minute limit')
    }

    // No sourceUrl: the bytes travel in the request, so URL-submit providers
    // simply fall through to the next transcriber in the chain.
    const result = await deps.transcriber.transcribe({
      buffer: audio.buffer,
      mime: audio.mime,
      durationMs,
      displayName: request.filename || basename(request.filename ?? 'audio'),
      // Per-request hint wins over the deployment default: transcription
      // language is a property of the conversation, not the installation.
      ...((request.language ?? deps.language) ? { language: (request.language ?? deps.language)! } : {}),
    })

    return result.utterances.flatMap((utterance, index) => {
      const text = `${utterance.speaker ? `${utterance.speaker}: ` : ''}${utterance.text}`.trim()
      if (!text) return []
      return [{
        text,
        metadata: {
          modality,
          utterance: index,
          time_start_ms: utterance.startMs,
          time_end_ms: utterance.endMs,
          ...(utterance.speaker ? { speaker: utterance.speaker } : {}),
        },
      }]
    })
  }

  async function extractImage(request: ExtractRequest): Promise<ExtractedText[]> {
    if (!deps.distill) throw new Error('chat archive image distillation prerequisite missing')
    // OCR and description are separate passages, not one blob: a screenshot's
    // words and what it depicts answer different questions.
    const [ocr, description] = await Promise.all([
      deps.distill({ buffer: request.buffer, mime: request.mime, prompt: OCR_PROMPT }),
      deps.distill({ buffer: request.buffer, mime: request.mime, prompt: withLanguage(DESCRIPTION_PROMPT, request.language ?? deps.language) }),
    ])
    const texts: ExtractedText[] = []
    if (ocr.trim()) texts.push({ text: ocr.trim(), metadata: { modality: 'image_ocr' } })
    if (description.trim()) texts.push({ text: description.trim(), metadata: { modality: 'image_description' } })
    return texts
  }

  async function extractVideo(request: ExtractRequest): Promise<ExtractedText[]> {
    const texts: ExtractedText[] = []
    try {
      texts.push(...await transcribe(request, 'video_transcript'))
    } catch (err) {
      // A silent video is ordinary, not a failure. Frames still carry meaning.
      logger.warn(`[chat-archive-extract] video audio track unavailable: ${err instanceof Error ? err.message : err}`)
    }
    if (!deps.distill) throw new Error('chat archive video vision prerequisite missing')

    const { durationMs, frames } = await withTempFile(
      request.buffer,
      request.filename ?? 'input.video',
      async (path) => {
        const probed = await probeRecordingDuration(path)
        if (probed > MAX_MEDIA_DURATION_MS) {
          throw new Error('chat archive media exceeds the 180 minute limit')
        }
        return { durationMs: probed, frames: await sampleVideoFrames(path) }
      },
    )

    for (const frame of frames) {
      const description = (await deps.distill({
        buffer: frame.data, mime: 'image/jpeg', prompt: withLanguage(FRAME_PROMPT, request.language ?? deps.language),
      })).trim()
      if (!description) continue
      texts.push({
        text: description,
        metadata: {
          modality: 'video_frame',
          time_start_ms: frame.timeStartMs,
          time_end_ms: Math.min(durationMs, frame.timeStartMs + 10_000),
        },
      })
    }
    if (texts.length === 0) {
      throw new Error('chat archive video produced no transcript or visual description')
    }
    return texts
  }

  /**
   * Decide what a document IS before deciding whether we can read it.
   *
   * This used to gate on the declared MIME against a hand-written allowlist,
   * which failed twice over: it rejected formats `parseFileContent` can already
   * read (ODF, RTF, EPUB, the legacy Office binaries), and it treated
   * `application/octet-stream` as proof of unreadability — when in practice it
   * is what a provider sends whenever it cannot be bothered to classify. WeChat
   * labels every document that way, so real `.docx` files were parked as
   * unsupported without a parser ever seeing them.
   *
   * So identify by evidence, strongest first: the bytes themselves, then the
   * filename extension, then the declared MIME (see `detectDocumentFormat`).
   * `unsupported` is reserved for the case where all three come up empty — it
   * is a terminal verdict in the store, excluded from the extraction claim
   * query, so it must mean "no reader exists" and never "nobody looked".
   */
  async function extractDocument(request: ExtractRequest): Promise<ExtractResult> {
    const filename = request.filename ?? ''

    // XML and YAML are text on the wire and have no registry entry; passing
    // them through the parser would only round-trip them.
    if (request.mime === 'application/xml' || request.mime === 'application/yaml') {
      return { texts: [{ text: request.buffer.toString('utf8'), metadata: { modality: 'document' } }] }
    }

    const format = await detectDocumentFormat(request.buffer, request.mime, filename)

    // PDFs go to the vision distiller rather than the text parser:
    // `parseFileContent` deliberately hands PDFs back as base64 so callers can
    // render scanned pages, which is not text we can index.
    if (format === 'pdf') {
      if (!deps.distill) throw new Error('chat archive PDF distillation prerequisite missing')
      const text = await deps.distill({ buffer: request.buffer, mime: 'application/pdf' })
      return { texts: text.trim() ? [{ text, metadata: { modality: 'document' } }] : [] }
    }

    // A registry hit, or a text-ish MIME, means `parseFileContent` has a lane.
    if (format !== undefined || request.mime.startsWith('text/') || request.mime === 'application/json') {
      const parsed = await parseFileContent(request.buffer, request.mime, filename)
      // A reader exists but could not read this one — a corrupt file, an
      // encrypted one, or a format the library only partly supports. Report it
      // as unsupported rather than indexing the notice: the text is not the
      // document, and the verdict leaves the asset re-queueable if the parser
      // later gains the ability.
      if (isParserFailureNotice(parsed.text)) return { texts: [], unsupported: true }
      return { texts: parsed.text.trim() ? [{ text: parsed.text, metadata: { modality: 'document' } }] : [] }
    }

    // Nothing identified it, but it reads as text — e.g. .txt/.md/.log under a
    // generic MIME, the same blind spot that lost the Office formats. Decode it
    // here rather than calling `parseFileContent`, which has no lane for this
    // and would hand back its "type not supported" placeholder: non-empty
    // filler that would be embedded and ranked as if it were the document.
    if (looksLikeText(request.buffer)) {
      const text = request.buffer.toString('utf8')
      return { texts: text.trim() ? [{ text, metadata: { modality: 'document' } }] : [] }
    }

    return { texts: [], unsupported: true }
  }

  return {
    async extract(request) {
      switch (request.modality) {
        case 'ocr':
          return { texts: await extractImage(request) }
        case 'transcript':
          return { texts: await transcribe(request, 'audio_transcript') }
        case 'video_frames':
          return { texts: await extractVideo(request) }
        case 'document':
          return extractDocument(request)
        default:
          return { texts: [], unsupported: true }
      }
    },
  }
}
