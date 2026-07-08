/**
 * Long-recording transcription via the Gemini File API (recording-to-brain
 * Phase 2). Replaces the inline-base64 / 30s / 2048-token path in
 * `transcribe.ts` for files too long to single-shot.
 *
 * Why the File API: a 1h45m recording is ~50-150 MB and ~200k audio tokens —
 * past the ~20 MB inline-request limit. The File API (resumable upload on the
 * same `generativelanguage.googleapis.com` host, same `x-goog-api-key`) takes
 * multi-hour audio and returns a `file_uri` referenced from `generateContent`.
 *
 * Why a continuation loop: even with `maxOutputTokens` raised, a full verbatim
 * transcript of a long call can exceed one response. When `finishReason` is
 * `MAX_TOKENS` we re-prompt "continue from <last timestamp>" and stitch the
 * windows, de-duplicating the seam. A coverage assertion flags a transcript
 * that never reached the audio's end so the caller never bills/ingests a
 * silently truncated result (the `transcribe.ts` silent-fail heritage).
 *
 * The line format `[H:MM:SS] Speaker: text` is deliberately resilient to
 * truncation: a response cut mid-line drops only the trailing partial line, and
 * the next window re-emits from the last COMPLETE line's timestamp.
 *
 * Pure helpers (`parseTranscriptLines`, `mergeUtterances`) carry the parsing /
 * seam-dedup logic and unit-test without a network. The network calls take an
 * injectable `fetchFn`.
 *
 * Spec: docs/architecture/media/transcription.md §Architecture(b).
 */

import type { TokenUsage } from '../providers/types.js'

const FILES_BASE = 'https://generativelanguage.googleapis.com'
const DEFAULT_MODEL = 'gemini-2.5-flash'
const DEFAULT_MAX_OUTPUT_TOKENS = 32_768
const DEFAULT_TIMEOUT_MS = 300_000 // 5 min per generate window
const MAX_CONTINUATION_WINDOWS = 12
const COVERAGE_TOLERANCE_MS = 30_000 // last line within 30s of the end = "covered"
const FILE_ACTIVE_POLL_MS = 2_000
const FILE_ACTIVE_MAX_POLLS = 60 // up to 2 min for the file to become ACTIVE

const TRANSCRIBE_PROMPT = [
  'Transcribe the attached audio recording VERBATIM with speaker diarization.',
  'Output ONE line per utterance, each formatted EXACTLY as:',
  '[H:MM:SS] Speaker: spoken text',
  'where H:MM:SS is the start time from the beginning of the recording and',
  'Speaker is a stable label (Speaker 1, Speaker 2, ... or a name if clearly stated).',
  'Do not add commentary, headings, blank lines, or markdown. Do not summarize.',
  'If a stretch is unintelligible, write [inaudible] as the text.',
].join('\n')

export type TranscribedUtterance = {
  startMs: number
  endMs: number
  speaker: string | null
  text: string
}

export type RecordingTranscriptionResult = {
  utterances: TranscribedUtterance[]
  /** One entry per generate window, for COGS attribution via recordUsage. */
  usages: Array<{ usage: TokenUsage | null; model: string }>
  /** Number of continuation windows used (1 = no continuation). */
  windows: number
  /** True when the last utterance fell short of the audio end (coverage gap). */
  truncated: boolean
}

const LINE_RE = /^\[(\d+):(\d{2}):(\d{2})\]\s*([^:]+?):\s*(.+)$/

/** Parse `[H:MM:SS] Speaker: text` lines. Ignores blank/malformed lines (e.g. a
 *  trailing partial line from a MAX_TOKENS cut). Pure. */
export function parseTranscriptLines(text: string): TranscribedUtterance[] {
  const out: TranscribedUtterance[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const m = LINE_RE.exec(line)
    if (!m) continue
    const h = Number(m[1])
    const min = Number(m[2])
    const s = Number(m[3])
    const startMs = (h * 3600 + min * 60 + s) * 1000
    const speakerRaw = m[4].trim()
    const body = m[5].trim()
    if (body.length === 0) continue
    out.push({
      startMs,
      endMs: startMs, // back-filled to the next utterance's start below
      speaker: speakerRaw.length > 0 ? speakerRaw : null,
      text: body,
    })
  }
  // Back-fill endMs = next utterance's startMs (last keeps start == end; the
  // caller can clamp the final endMs to the known audio duration).
  for (let i = 0; i < out.length - 1; i++) {
    out[i].endMs = Math.max(out[i].startMs, out[i + 1].startMs)
  }
  return out
}

/**
 * Stitch a continuation window onto the running transcript, dropping any
 * utterances at/<= the seam timestamp that the new window re-emitted (the
 * "continue from X" overlap). Keeps the running list strictly progressing in
 * time. Pure.
 */
export function mergeUtterances(
  prev: TranscribedUtterance[],
  next: TranscribedUtterance[],
): TranscribedUtterance[] {
  if (prev.length === 0) return [...next]
  const lastStart = prev[prev.length - 1].startMs
  // Keep only continuation lines that advance past the last emitted line. A
  // line exactly at `lastStart` is treated as the re-emitted seam and dropped.
  const fresh = next.filter((u) => u.startMs > lastStart)
  if (fresh.length === 0) return [...prev]
  // Fix the boundary endMs so the joined-at utterance ends where the next begins.
  const merged = [...prev]
  merged[merged.length - 1] = { ...merged[merged.length - 1], endMs: Math.max(lastStart, fresh[0].startMs) }
  return [...merged, ...fresh]
}

function lastTimestampMs(utterances: TranscribedUtterance[]): number {
  return utterances.length > 0 ? utterances[utterances.length - 1].startMs : 0
}

// ── Gemini wire types (the slices we read) ──────────────────────────

type GeminiPart = { text?: string; fileData?: { mimeType: string; fileUri: string }; file_data?: { mime_type: string; file_uri: string } }
type GeminiUsageMetadata = {
  promptTokenCount?: number
  candidatesTokenCount?: number
  thoughtsTokenCount?: number
  cachedContentTokenCount?: number
}
type GeminiGenerateResponse = {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>
  usageMetadata?: GeminiUsageMetadata
}
type GeminiFile = { uri?: string; name?: string; state?: string; mimeType?: string }

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

export type TranscribeRecordingOptions = {
  apiKey: string
  /** Raw audio bytes. */
  buffer: Buffer
  mime: string
  /** Known audio duration (from ffprobe) — drives the coverage assertion. */
  durationMs: number
  model?: string
  maxOutputTokens?: number
  /** Per-window generate timeout. */
  timeoutMs?: number
  displayName?: string
  fetchFn?: typeof fetch
}

/**
 * Upload audio to the Gemini File API (resumable protocol) and return the
 * `file_uri`. Polls until the file reaches ACTIVE. Throws on failure.
 */
export async function uploadAudioToGeminiFiles(
  opts: { apiKey: string; buffer: Buffer; mime: string; displayName?: string; fetchFn?: typeof fetch },
): Promise<{ fileUri: string; name: string }> {
  const fetchFn = opts.fetchFn ?? fetch
  const numBytes = opts.buffer.length

  // 1. Start resumable upload — returns the upload URL in a response header.
  const startRes = await fetchFn(`${FILES_BASE}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': opts.apiKey,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(numBytes),
      'X-Goog-Upload-Header-Content-Type': opts.mime,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: opts.displayName ?? 'recording' } }),
  })
  if (!startRes.ok) {
    throw new Error(`Gemini File API start failed (HTTP ${startRes.status}): ${(await startRes.text().catch(() => '')).slice(0, 300)}`)
  }
  const uploadUrl = startRes.headers.get('x-goog-upload-url') ?? startRes.headers.get('X-Goog-Upload-URL')
  if (!uploadUrl) throw new Error('Gemini File API start: missing upload URL header')

  // 2. Upload + finalize the bytes in one command.
  const uploadRes = await fetchFn(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(numBytes),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: opts.buffer,
  })
  if (!uploadRes.ok) {
    throw new Error(`Gemini File API upload failed (HTTP ${uploadRes.status}): ${(await uploadRes.text().catch(() => '')).slice(0, 300)}`)
  }
  const uploaded = (await uploadRes.json()) as { file?: GeminiFile }
  let file = uploaded.file
  if (!file?.uri || !file?.name) throw new Error('Gemini File API upload: response missing file uri/name')

  // 3. Poll until ACTIVE (audio is transcoded server-side before it can be used).
  let polls = 0
  while ((file.state ?? 'PROCESSING') !== 'ACTIVE') {
    if (file.state === 'FAILED') throw new Error('Gemini File API: file processing FAILED')
    if (polls++ >= FILE_ACTIVE_MAX_POLLS) throw new Error('Gemini File API: file did not become ACTIVE in time')
    await new Promise((r) => setTimeout(r, FILE_ACTIVE_POLL_MS))
    const pollRes = await fetchFn(`${FILES_BASE}/v1beta/${file.name}`, {
      headers: { 'x-goog-api-key': opts.apiKey },
    })
    if (!pollRes.ok) throw new Error(`Gemini File API poll failed (HTTP ${pollRes.status})`)
    file = (await pollRes.json()) as GeminiFile
  }
  return { fileUri: file.uri!, name: file.name! }
}

async function generateWindow(
  opts: TranscribeRecordingOptions,
  fileUri: string,
  continueFromMs: number | null,
): Promise<{ text: string; finishReason: string; usage: TokenUsage | null }> {
  const fetchFn = opts.fetchFn ?? fetch
  const model = opts.model ?? DEFAULT_MODEL
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const prompt =
    continueFromMs === null
      ? TRANSCRIBE_PROMPT
      : `${TRANSCRIBE_PROMPT}\n\nThis continues a transcript already produced up to ${formatTimestamp(continueFromMs)}. Resume from the next utterance AFTER ${formatTimestamp(continueFromMs)}. Do NOT repeat earlier lines.`

  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }, { file_data: { mime_type: opts.mime, file_uri: fileUri } }],
      },
    ],
    generationConfig: { temperature: 0, maxOutputTokens: opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS },
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetchFn(`${FILES_BASE}/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': opts.apiKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    throw new Error(`Gemini transcription failed (HTTP ${res.status}): ${(await res.text().catch(() => '')).slice(0, 300)}`)
  }
  const payload = (await res.json()) as GeminiGenerateResponse
  const cand = payload.candidates?.[0]
  const text = (cand?.content?.parts ?? []).map((p) => p.text ?? '').join('')
  return {
    text,
    finishReason: cand?.finishReason ?? 'STOP',
    usage: extractUsage(payload.usageMetadata),
  }
}

function formatTimestamp(ms: number): string {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/**
 * Transcribe a long recording end-to-end: upload to the File API, then run the
 * bounded continuation loop, stitching windows until `STOP`, the window cap, or
 * coverage is reached. The caller records each `usages[]` entry via
 * `usageStore.recordUsage` (COGS) and checks `truncated` before billing.
 */
export async function transcribeRecording(
  opts: TranscribeRecordingOptions,
): Promise<RecordingTranscriptionResult> {
  const { fileUri } = await uploadAudioToGeminiFiles({
    apiKey: opts.apiKey,
    buffer: opts.buffer,
    mime: opts.mime,
    displayName: opts.displayName,
    fetchFn: opts.fetchFn,
  })

  let utterances: TranscribedUtterance[] = []
  const usages: Array<{ usage: TokenUsage | null; model: string }> = []
  const model = opts.model ?? DEFAULT_MODEL
  let windows = 0
  let continueFrom: number | null = null

  while (windows < MAX_CONTINUATION_WINDOWS) {
    const win = await generateWindow(opts, fileUri, continueFrom)
    windows++
    usages.push({ usage: win.usage, model })

    const parsed = parseTranscriptLines(win.text)
    const before = utterances.length
    utterances = mergeUtterances(utterances, parsed)
    const added = utterances.length - before

    const reachedEnd = lastTimestampMs(utterances) >= opts.durationMs - COVERAGE_TOLERANCE_MS
    const hitMaxTokens = win.finishReason === 'MAX_TOKENS'

    // Stop when the model said it's done, when we've covered the audio, or when
    // a continuation window made no forward progress (guards an infinite loop).
    if (!hitMaxTokens || reachedEnd || added === 0) break
    continueFrom = lastTimestampMs(utterances)
  }

  // Clamp the final utterance's endMs to the known audio duration.
  if (utterances.length > 0) {
    const last = utterances[utterances.length - 1]
    last.endMs = Math.max(last.startMs, opts.durationMs)
  }

  const truncated = utterances.length === 0 || lastTimestampMs(utterances) < opts.durationMs - COVERAGE_TOLERANCE_MS
  return { utterances, usages, windows, truncated }
}
