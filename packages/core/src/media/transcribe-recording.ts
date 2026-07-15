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
 * transcript of a long call can exceed one response. While the audio remains
 * uncovered and the last window made forward progress we re-prompt "continue
 * from <last timestamp>" and stitch the windows, de-duplicating the seam —
 * REGARDLESS of finishReason: a MAX_TOKENS cut and a premature STOP (thinking
 * models on hour-long audio emit a few minutes and stop cold — 2026-07-13)
 * both continue; a no-progress window ends the run. A coverage assertion
 * flags a transcript that never reached the audio's end so the caller never
 * bills/ingests a silently truncated result (the `transcribe.ts` silent-fail
 * heritage).
 *
 * The line format `[H:MM:SS] Speaker: text` is deliberately resilient to
 * truncation: a response cut mid-line drops only the trailing partial line, and
 * the next window re-emits from the last COMPLETE line's timestamp.
 *
 * Why STREAMING generate (`streamGenerateContent?alt=sse`), not a plain
 * `generateContent`: transcribing an hour-plus recording keeps the model
 * generating for many minutes, and a non-streaming call sits on a silent
 * socket the whole time — Google's front end (or any middlebox on the path)
 * drops it at ~2 minutes as idle (`UND_ERR_SOCKET: other side closed`,
 * surfaced by undici as the opaque `TypeError: fetch failed` — the
 * 2026-07-10 incident: every worker attempt on a 103-minute recording died
 * at ~2 min). Undici's own 300s headers timeout is a second razor on the
 * same path. Streaming keeps bytes flowing from the first tokens, so
 * neither idle cutoff can fire; the per-window AbortController bounds
 * total stream time instead.
 *
 * Why degeneration detect-and-retry: at temperature 0 (greedy decoding) the
 * model can lock into a repetition loop instead of transcribing — observed on
 * long Cantonese WhatsApp recordings (2026-07-10, both test files) in two
 * distinct shapes, so there are two detectors:
 *   1. Character-level (`stripDegenerateTail`): one line loops a short filler
 *      token forever (「就,就,就,…」). Periodic at the char level; scan each
 *      window's raw text for a short unit repeated past a threshold.
 *   2. Line-level (`stripDegenerateUtterances`): whole lines loop — the same
 *      sentence re-emitted across thousands of utterances with drifting
 *      timestamps and alternating speakers, so no short char period exists.
 *      Detected as a stretch of utterances with (almost) no distinct texts.
 *      That run also hallucinated timestamps to 291 min on a 96-min file, so
 *      utterances past the audio end are dropped BEFORE the coverage math —
 *      otherwise a looping transcript "covers" the audio and gets billed.
 * On detection the looping tail is cut at the last clean utterance and the
 * window is retried (bounded per recording) with a small temperature bump +
 * an anti-repetition prompt note — greedy decoding is exactly the sticky
 * setting, so sampling usually breaks the cycle. An unrecoverable loop stops
 * the run and falls through to the existing coverage math: the transcript is
 * `truncated`, so the caller bills nothing (charge-on-full-coverage).
 *
 * Pure helpers (`parseTranscriptLines`, `mergeUtterances`,
 * `stripDegenerateTail`, `stripDegenerateUtterances`) carry the parsing /
 * seam-dedup / loop-detection logic and unit-test without a network. The
 * network calls take an injectable `fetchFn`.
 *
 * Spec: docs/architecture/media/transcription.md §Architecture(b).
 */

import type { TokenUsage } from '../providers/types.js'

const FILES_BASE = 'https://generativelanguage.googleapis.com'
const DEFAULT_MODEL = 'gemini-2.5-flash'
const DEFAULT_MAX_OUTPUT_TOKENS = 32_768
// Bounds one window's whole SSE stream (first byte arrives in seconds; a full
// 32k-token window can legitimately stream for >5 min at model speed).
const DEFAULT_TIMEOUT_MS = 600_000
// Partial-line buffer cap for the SSE parse — same OOM rationale as the
// provider's `streamGeminiSSE` (gemini.ts): fail fast over accumulating an
// unterminated MB-scale line.
const MAX_SSE_BUFFER_BYTES = 8 * 1024 * 1024
// A thinking-family model emits only ~3 audio-minutes of transcript per
// window (2026-07-13: 12 windows covered 34 of 96 min before the old cap of
// 12 ended the run), so the cap must accommodate hour-plus audio at that
// rate. Each window is individually bounded by the AbortController deadline.
const MAX_CONTINUATION_WINDOWS = 40
const COVERAGE_TOLERANCE_MS = 30_000 // last line within 30s of the end = "covered"
// Degeneration guard: a window whose text repeats a short unit (period ≤ 16
// chars) for ≥ 64 consecutive matching chars is looping, not transcribing.
// 64 chars of exact short-period repetition never occurs in real speech text.
const DEGEN_MAX_PERIOD = 16
const DEGEN_MIN_RUN_CHARS = 64
// Line-level loop guard: 8 consecutive identical utterance texts, or a window
// of 16 utterances with ≤ 2 distinct texts (catches two phrases alternating),
// is a loop — real speech never sustains that.
const DEGEN_IDENTICAL_RUN = 8
const DEGEN_UTTERANCE_WINDOW = 16
const DEGEN_MAX_DISTINCT_IN_WINDOW = 2
// Transient-socket retry: undici surfaces a connection reset as an opaque
// `TypeError: fetch failed` (cause ECONNRESET / UND_ERR_SOCKET "other side
// closed"). Observed 2026-07-10 as bursts lasting many minutes with a high
// per-request failure rate — without a per-call retry, one reset kills a
// whole job attempt and the worker re-uploads everything just to roll the
// same dice. Retry only when the fetch call ITSELF rejects (no bytes of the
// response consumed yet) — never mid-stream.
const TRANSIENT_FETCH_ATTEMPTS = 3
const TRANSIENT_FETCH_BACKOFF_MS = 2_000
// A degenerate window is retried from its last clean utterance with this
// temperature (greedy temperature-0 decoding is what makes loops sticky).
const DEGEN_RETRY_TEMPERATURE = 0.3
// Total nudged retries per recording — bounds the extra COGS a pathological
// file can burn.
const MAX_DEGEN_RETRIES = 2
// Stall recovery: a continuation window that adds NOTHING while audio remains
// uncovered is a stall, not completion (2026-07-13: a 96-min recording ended
// at 38.7 min mid-conversation — the model simply failed to advance past one
// spot). Skip the resume point forward and retry, up to MAX_STALL_SKIPS
// consecutive times per stall site (the budget resets on any progress; the
// window cap still bounds total work). The cost is a potential gap of up to
// SKIP * MAX_STALL_SKIPS in the transcript — better than losing the rest.
const STALL_SKIP_MS = 90_000
const MAX_STALL_SKIPS = 3
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
  /** One entry per generate window, for COGS attribution via recordUsage.
   *  Flat-rate (per-audio-hour) providers set `costUsd` directly; token-billed
   *  providers leave it unset and the factory prices `usage` instead. */
  usages: Array<{ usage: TokenUsage | null; model: string; costUsd?: number }>
  /** Number of continuation windows used (1 = no continuation). */
  windows: number
  /** True when the last utterance fell short of the audio end (coverage gap). */
  truncated: boolean
  /** Windows whose output hit the degeneration guard (loop cut + maybe retried). */
  degenerateWindows: number
}

// Accepts `[H:MM:SS]` or `[MM:SS]`, and an ASCII or full-width colon after the
// speaker label — Chinese-mode output drifts to `：`, which silently dropped
// lines under the stricter pre-refactor pattern.
const LINE_RE = /^\[(?:(\d+):)?(\d{1,2}):(\d{2})\]\s*([^:：]+?)[:：]\s*(.+)$/

/** Parse `[H:MM:SS] Speaker: text` (or `[MM:SS]`) lines. Ignores
 *  blank/malformed lines (e.g. a trailing partial line from a MAX_TOKENS cut).
 *  Pure. */
export function parseTranscriptLines(text: string): TranscribedUtterance[] {
  const out: TranscribedUtterance[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const m = LINE_RE.exec(line)
    if (!m) continue
    const h = m[1] !== undefined ? Number(m[1]) : 0
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

/**
 * Detect a degeneration loop — a short unit (≤ `DEGEN_MAX_PERIOD` chars, e.g.
 * 「就,」) repeated consecutively for ≥ `DEGEN_MIN_RUN_CHARS` matching chars —
 * and cut the text at the start of the earliest loop. Everything before the
 * cut is real transcript (a loop that starts mid-line leaves the line's clean
 * prefix parseable). Pure; linear scan per period.
 */
export function stripDegenerateTail(text: string): { text: string; degenerate: boolean } {
  let cutAt = -1
  for (let p = 1; p <= DEGEN_MAX_PERIOD; p++) {
    const need = Math.max(DEGEN_MIN_RUN_CHARS, p * 6)
    let run = 0 // consecutive positions where text[i] repeats text[i - p]
    for (let i = p; i < text.length; i++) {
      run = text[i] === text[i - p] ? run + 1 : 0
      if (run >= need) {
        const start = i - run - p + 1 // include the template unit itself
        if (cutAt === -1 || start < cutAt) cutAt = start
        break // earliest hit for this period; smaller periods may still cut earlier
      }
    }
  }
  if (cutAt === -1) return { text, degenerate: false }
  return { text: text.slice(0, cutAt), degenerate: true }
}

/**
 * Detect a line-level loop — the model re-emitting the same sentence(s) as
 * fresh utterances (timestamps drift, speakers alternate, so the char-level
 * scan can't see it). Two triggers: `DEGEN_IDENTICAL_RUN` consecutive
 * identical texts, or `DEGEN_UTTERANCE_WINDOW` consecutive utterances with
 * ≤ `DEGEN_MAX_DISTINCT_IN_WINDOW` distinct texts. Cuts at the loop's start
 * (dropping the whole run — the retry re-covers from the last clean line).
 * Pure.
 */
export function stripDegenerateUtterances(
  utterances: TranscribedUtterance[],
): { utterances: TranscribedUtterance[]; degenerate: boolean } {
  let cutAt = -1
  let run = 1
  for (let i = 1; i < utterances.length; i++) {
    run = utterances[i].text === utterances[i - 1].text ? run + 1 : 1
    if (run >= DEGEN_IDENTICAL_RUN) {
      cutAt = i - run + 1
      break
    }
  }
  if (cutAt === -1) {
    for (let i = 0; i + DEGEN_UTTERANCE_WINDOW <= utterances.length; i++) {
      const distinct = new Set(utterances.slice(i, i + DEGEN_UTTERANCE_WINDOW).map((u) => u.text))
      if (distinct.size <= DEGEN_MAX_DISTINCT_IN_WINDOW) {
        cutAt = i
        break
      }
    }
  }
  if (cutAt === -1) return { utterances, degenerate: false }
  return { utterances: utterances.slice(0, cutAt), degenerate: true }
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

function isTransientFetchError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.message} ${String((err as { cause?: unknown }).cause ?? '')}` : String(err)
  return /fetch failed|ECONNRESET|UND_ERR_SOCKET|other side closed/i.test(msg)
}

/** Gemini overload / rate-limit / gateway statuses worth replaying. A 503 on
 *  the File-API upload killed a chunk of a 96-min recording (2026-07-14) even
 *  though the very next attempt would have succeeded. */
const RETRYABLE_HTTP_STATUS = new Set([429, 500, 502, 503, 504])

/**
 * `fetchFn` with a bounded retry on transient failures — both a rejected fetch
 * (socket reset: undici surfaces it as an opaque `TypeError: fetch failed`) and
 * a retryable HTTP status (429/5xx: Gemini overload). Never replays a request
 * that got a usable response, never resumes mid-stream, and never retries an
 * abort (the caller's deadline stands).
 */
async function fetchWithTransientRetry(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  backoffMs: number = TRANSIENT_FETCH_BACKOFF_MS,
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const backoff = (): Promise<void> => new Promise((r) => setTimeout(r, backoffMs * attempt))
    try {
      const res = await fetchFn(url, init)
      if (RETRYABLE_HTTP_STATUS.has(res.status) && attempt < TRANSIENT_FETCH_ATTEMPTS) {
        await backoff()
        continue
      }
      return res
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError'
      if (aborted || !isTransientFetchError(err) || attempt >= TRANSIENT_FETCH_ATTEMPTS) throw err
      await backoff()
    }
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
  /** Base backoff between retry attempts (chunk + transient-fetch). Tests set 0. */
  retryBackoffMs?: number
  /** Per-window progress hook (observability — the worker logs it). */
  onWindow?: (info: {
    window: number
    finishReason: string
    added: number
    degenerate: boolean
    coveredMs: number
  }) => void
}

/**
 * Upload audio to the Gemini File API (resumable protocol) and return the
 * `file_uri`. Polls until the file reaches ACTIVE. Throws on failure.
 */
export async function uploadAudioToGeminiFiles(
  opts: {
    apiKey: string
    buffer: Buffer
    mime: string
    displayName?: string
    fetchFn?: typeof fetch
    retryBackoffMs?: number
  },
): Promise<{ fileUri: string; name: string }> {
  const fetchFn = opts.fetchFn ?? fetch
  const backoffMs = opts.retryBackoffMs ?? TRANSIENT_FETCH_BACKOFF_MS
  const numBytes = opts.buffer.length

  // 1. Start resumable upload — returns the upload URL in a response header.
  const startRes = await fetchWithTransientRetry(fetchFn, `${FILES_BASE}/upload/v1beta/files`, {
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
  }, backoffMs)
  if (!startRes.ok) {
    throw new Error(`Gemini File API start failed (HTTP ${startRes.status}): ${(await startRes.text().catch(() => '')).slice(0, 300)}`)
  }
  const uploadUrl = startRes.headers.get('x-goog-upload-url') ?? startRes.headers.get('X-Goog-Upload-URL')
  if (!uploadUrl) throw new Error('Gemini File API start: missing upload URL header')

  // 2. Upload + finalize the bytes in one command. (Replaying after a reset is
  // safe: if the first attempt actually finalized, the single-use upload URL
  // rejects the replay and we throw — same outcome as not retrying.)
  const uploadRes = await fetchWithTransientRetry(fetchFn, uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(numBytes),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: opts.buffer,
  }, backoffMs)
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
    const pollRes = await fetchWithTransientRetry(fetchFn, `${FILES_BASE}/v1beta/${file.name}`, {
      headers: { 'x-goog-api-key': opts.apiKey },
    }, backoffMs)
    if (!pollRes.ok) throw new Error(`Gemini File API poll failed (HTTP ${pollRes.status})`)
    file = (await pollRes.json()) as GeminiFile
  }
  return { fileUri: file.uri!, name: file.name! }
}

async function generateWindow(
  opts: TranscribeRecordingOptions,
  fileUri: string,
  continueFromMs: number | null,
  degenNudge: boolean,
): Promise<{ text: string; finishReason: string; usage: TokenUsage | null }> {
  const fetchFn = opts.fetchFn ?? fetch
  const model = opts.model ?? DEFAULT_MODEL
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  let prompt =
    continueFromMs === null
      ? TRANSCRIBE_PROMPT
      : `${TRANSCRIBE_PROMPT}\n\nThis continues a transcript already produced up to ${formatTimestamp(continueFromMs)}. Resume from the next utterance AFTER ${formatTimestamp(continueFromMs)}. Do NOT repeat earlier lines.`
  if (degenNudge) {
    prompt += `\n\nIMPORTANT: a previous attempt got stuck repeating a filler word over and over. Never repeat a word or phrase more than three times in a row; if a passage is repetitive filler or unclear, write [inaudible] as the text and move on to the next utterance.`
  }

  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }, { file_data: { mime_type: opts.mime, file_uri: fileUri } }],
      },
    ],
    generationConfig: {
      // Greedy (0) is the fidelity default, but it is exactly what makes a
      // repetition loop sticky — the retry samples its way out of the cycle.
      temperature: degenNudge ? DEGEN_RETRY_TEMPERATURE : 0,
      maxOutputTokens: opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      // Do NOT suppress thinking (`thinkingConfig: { thinkingBudget: 0 }`)
      // even though thoughts consume most of each window's output tokens on
      // thinking-family models: with thinking off, gemini-3-flash-preview
      // REFUSES continuation windows outright ("I am prohibited from
      // transcribing...") and cannot seek to the resume timestamp — measured
      // 2026-07-13, side by side on the same file. Thinking is what makes
      // seek-and-resume work; its token cost is the price of coverage.
    },
  }

  // Stream (SSE) so the socket carries bytes from the first tokens — see the
  // module docstring for why a non-streaming generateContent dies at ~2 min
  // on long recordings. The AbortController bounds the WHOLE stream, and its
  // signal survives onto the body reader (a mid-stream hang aborts too).
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchWithTransientRetry(
      fetchFn,
      `${FILES_BASE}/v1beta/models/${model}:streamGenerateContent?alt=sse`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': opts.apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    )
    if (!res.ok) {
      throw new Error(`Gemini transcription failed (HTTP ${res.status}): ${(await res.text().catch(() => '')).slice(0, 300)}`)
    }
    return await consumeGeminiSSE(res)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Read a Gemini SSE response to completion: text concatenates across events;
 * `finishReason` + `usageMetadata` ride the last one (usage totals are
 * cumulative — last wins). Shared by the whole-file window loop and the
 * per-chunk loop, so both get the same OOM guard and parse stance.
 */
async function consumeGeminiSSE(
  res: Response,
): Promise<{ text: string; finishReason: string; usage: TokenUsage | null }> {
  if (!res.body) throw new Error('Gemini transcription: no response body')
  let text = ''
  let finishReason = 'STOP'
  let usageMeta: GeminiUsageMetadata | undefined

  const consume = (data: string): void => {
    if (!data) return
    let chunk: GeminiGenerateResponse
    try {
      chunk = JSON.parse(data) as GeminiGenerateResponse
    } catch {
      return // skip malformed JSON (same stance as streamGeminiSSE)
    }
    const cand = chunk.candidates?.[0]
    text += (cand?.content?.parts ?? []).map((p) => p.text ?? '').join('')
    if (cand?.finishReason) finishReason = cand.finishReason
    if (chunk.usageMetadata) usageMeta = chunk.usageMetadata
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    if (buffer.length > MAX_SSE_BUFFER_BYTES) {
      throw new Error(
        `Gemini transcription SSE buffer exceeded ${MAX_SSE_BUFFER_BYTES} bytes without a newline — aborting to avoid OOM.`,
      )
    }
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.startsWith('data: ')) consume(line.slice(6).trim())
    }
  }
  if (buffer.startsWith('data: ')) consume(buffer.slice(6).trim())
  return { text, finishReason, usage: extractUsage(usageMeta) }
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
  let degenerateWindows = 0
  let degenRetriesLeft = MAX_DEGEN_RETRIES
  let nudge = false
  let stallSkipsLeft = MAX_STALL_SKIPS

  while (windows < MAX_CONTINUATION_WINDOWS) {
    const win = await generateWindow(opts, fileUri, continueFrom, nudge)
    windows++
    usages.push({ usage: win.usage, model })

    // Cut a char-level loop before parsing: the clean prefix (including a
    // looping line's clean head) is real transcript and is kept.
    const scan = stripDegenerateTail(win.text)
    const parsed = parseTranscriptLines(scan.text)
    // Drop hallucinated timestamps — a line-level loop has drifted timestamps
    // far past the audio end (291 min claimed on a 96-min file, 2026-07-10);
    // left in, they satisfy the coverage check and the garbage gets billed.
    const inRange = parsed.filter((u) => u.startMs <= opts.durationMs + COVERAGE_TOLERANCE_MS)
    // Then cut a line-level loop (same sentence re-emitted as fresh utterances).
    const lineScan = stripDegenerateUtterances(inRange)
    const degenerate = scan.degenerate || lineScan.degenerate
    const before = utterances.length
    utterances = mergeUtterances(utterances, lineScan.utterances)
    const added = utterances.length - before

    const reachedEnd = lastTimestampMs(utterances) >= opts.durationMs - COVERAGE_TOLERANCE_MS
    opts.onWindow?.({
      window: windows,
      finishReason: win.finishReason,
      added,
      degenerate,
      coveredMs: lastTimestampMs(utterances),
    })

    if (degenerate) {
      degenerateWindows++
      if (reachedEnd) break
      // Retry from the last clean utterance with the temperature nudge — but
      // only while the retry budget lasts AND we are not spinning in place (a
      // nudged retry that added nothing hit the same wall; give up and let the
      // coverage math mark the transcript truncated → billed 0).
      if (degenRetriesLeft > 0 && (added > 0 || !nudge)) {
        degenRetriesLeft--
        nudge = true
        continueFrom = lastTimestampMs(utterances)
        continue
      }
      break
    }
    nudge = false

    // Continue while audio remains uncovered and the window made forward
    // progress — regardless of finishReason. A premature STOP is continued
    // exactly like a MAX_TOKENS cut: thinking models on hour-long audio can
    // emit a few minutes of transcript and stop cold (2026-07-13: window 1
    // STOPped at 3.4 min of a 96-min recording; the old MAX_TOKENS-only rule
    // ended the run there). MAX_CONTINUATION_WINDOWS bounds the loop.
    if (reachedEnd) break
    if (added === 0) {
      // Stall: no forward progress with audio uncovered. Skip the resume
      // point forward past the stuck spot and retry (bounded); only give up
      // once the skip budget for this site is spent.
      if (stallSkipsLeft <= 0) break
      stallSkipsLeft--
      continueFrom = (continueFrom ?? lastTimestampMs(utterances)) + STALL_SKIP_MS
      continue
    }
    stallSkipsLeft = MAX_STALL_SKIPS // progress resets the stall budget
    continueFrom = lastTimestampMs(utterances)
  }

  // Clamp the final utterance's endMs to the known audio duration.
  if (utterances.length > 0) {
    const last = utterances[utterances.length - 1]
    last.endMs = Math.max(last.startMs, opts.durationMs)
  }

  const truncated = utterances.length === 0 || lastTimestampMs(utterances) < opts.durationMs - COVERAGE_TOLERANCE_MS
  return { utterances, usages, windows, truncated, degenerateWindows }
}

// ── Chunked mode (cantonese-transcription-refactor Phase 2) ─────────────
//
// The continuation loop above is structurally drift-prone on long audio:
// model-emitted timestamps compound across windows, and conditioning each
// window on prior output increases hallucination (WhisperX, Interspeech 2023
// — see the plan §2). Chunked mode transcribes silence-split chunks
// INDEPENDENTLY — no cross-chunk conditioning, timestamps offset by the
// chunk's known start, coverage derived from chunks completed rather than
// model stamps. Thinking is disabled on models that accept a budget: it only
// eats the output window on a verbatim task.

export type RecordingAudioChunk = {
  buffer: Buffer
  mime: string
  /** Chunk start relative to the recording start. */
  offsetMs: number
  durationMs: number
}

const CHUNK_TRANSCRIBE_PROMPT = [
  'Transcribe this audio segment VERBATIM, in the language(s) actually spoken.',
  'If the speech is Cantonese (廣東話), write it as spoken written Cantonese',
  '(粵文 — 嘅/咗/係/唔, traditional characters). Do NOT convert it into',
  'Standard Written Chinese or Mandarin phrasing, and do NOT translate.',
  'If the speaker mixes English words into a sentence, keep them exactly as spoken.',
  'Output ONE line per utterance, formatted EXACTLY as:',
  '[MM:SS] Speaker N: spoken text',
  'where MM:SS counts from the start of THIS segment.',
  'No commentary, no headings, no markdown, no summaries.',
  'If the segment is silence or music with no speech, output nothing.',
].join('\n')

/** Chunks are transcribed with bounded parallelism — enough to matter on a
 *  3 h file (~18 chunks), low enough to stay clear of TPM limits. */
const CHUNK_CONCURRENCY = 3
/** Attempts per chunk (upload + generate), with backoff between them. Each
 *  attempt already runs its own continuation loop, so 2 is enough — 3 made a
 *  stubborn chunk a 24-call worst case. */
const CHUNK_ATTEMPTS = 2
const CHUNK_RETRY_BACKOFF_MS = 5_000
const CHUNK_MAX_OUTPUT_TOKENS = 16_384
// A chunk is ONE model call today, but the model routinely stops after the
// first minutes of a ~10-minute chunk (a premature STOP, exactly as on the
// whole-file path). Unchecked, that shipped a 96-min recording with five
// 8-10 min HOLES, counted as complete, and billed it (2026-07-14). So each
// chunk continues from its last line until the chunk is covered.
const MAX_CHUNK_WINDOWS = 8
/** Chunks are split at silence, so allow a quiet tail before continuing. This
 *  drives the CONTINUATION decision (keep transcribing this chunk), NOT the
 *  truncation verdict — chunks legitimately end in silence, so a short tail is
 *  not a hole. Holes are judged on the merged transcript (`MAX_TRANSCRIPT_GAP_MS`). */
const CHUNK_COVERAGE_TOLERANCE_MS = 45_000
/** A stretch of audio this long with NO transcript is a hole, not a pause: the
 *  chunked path once shipped five 8-10 min holes as a complete transcript and
 *  billed it (2026-07-14). Real conversation silence never runs this long. */
const MAX_TRANSCRIPT_GAP_MS = 180_000
/** Stall recovery INSIDE a chunk: when a continuation window adds nothing, jump
 *  the resume point forward rather than abandoning the rest of the chunk. */
const CHUNK_STALL_SKIP_MS = 60_000
const MAX_CHUNK_STALL_SKIPS = 3
/** After a chunk's continuation loop, any interior stretch this long with no
 *  transcript gets a TARGETED re-ask ("transcribe only MM:SS-MM:SS"). Skipping
 *  past a stall is what leaves these; without the fill, the skip itself becomes
 *  the hole that truncates the whole recording (2026-07-14). Set BELOW the hole
 *  threshold (3 min) but well above a natural pause, so ordinary conversational
 *  silence never buys an extra model call. */
const MIN_GAP_FILL_MS = 120_000
const MAX_GAP_FILLS = 4

/** thinkingBudget is a 2.5-family knob; gen-3 models reject it (they take
 *  thinkingLevel, whose default is fine here). */
function thinkingConfigFor(model: string): Record<string, unknown> {
  return /gemini-2\.5/.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {}
}

/** One generate call over a chunk, optionally resuming after `continueFromMs`
 *  (chunk-relative). Returns the raw text + usage. */
async function generateChunkWindow(
  opts: TranscribeRecordingOptions,
  chunk: RecordingAudioChunk,
  fileUri: string,
  continueFromMs: number | null,
  /** Gap-fill: transcribe ONLY this window of the chunk (chunk-relative ms). */
  range?: { fromMs: number; toMs: number },
): Promise<{ text: string; usage: TokenUsage | null }> {
  const fetchFn = opts.fetchFn ?? fetch
  const model = opts.model ?? DEFAULT_MODEL
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const prompt = range
    ? `${CHUNK_TRANSCRIBE_PROMPT}\n\nTranscribe ONLY the audio between ${formatChunkTimestamp(range.fromMs)} and ${formatChunkTimestamp(range.toMs)} of this segment. Output nothing for any other part. Keep timestamps relative to the START of the segment, as always.`
    : continueFromMs === null
      ? CHUNK_TRANSCRIBE_PROMPT
      : `${CHUNK_TRANSCRIBE_PROMPT}\n\nThis segment is already transcribed up to ${formatChunkTimestamp(continueFromMs)}. Resume from the next utterance AFTER ${formatChunkTimestamp(continueFromMs)} and continue to the END of the segment. Do NOT repeat earlier lines.`

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: prompt },
          { file_data: { mime_type: chunk.mime, file_uri: fileUri } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: opts.maxOutputTokens ?? CHUNK_MAX_OUTPUT_TOKENS,
      ...thinkingConfigFor(model),
    },
  }

  // STREAM the chunk, exactly as the whole-file path does. A chunk is ~10
  // minutes of audio and the model thinks for minutes before emitting: a
  // non-streaming `generateContent` sits on a silent socket and gets dropped
  // (`fetch failed` / UND_ERR_SOCKET) or runs past the abort deadline — which
  // is precisely how the chunked path failed on a 96-min recording
  // (2026-07-14), the same incident the whole-file path was fixed for on
  // 2026-07-10. Streaming keeps bytes flowing from the first tokens.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchWithTransientRetry(
      fetchFn,
      `${FILES_BASE}/v1beta/models/${model}:streamGenerateContent?alt=sse`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': opts.apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
      opts.retryBackoffMs ?? TRANSIENT_FETCH_BACKOFF_MS,
    )
    if (!res.ok) {
      throw new Error(`Gemini chunk transcription failed (HTTP ${res.status}): ${(await res.text().catch(() => '')).slice(0, 300)}`)
    }
    const out = await consumeGeminiSSE(res)
    return { text: out.text, usage: out.usage }
  } finally {
    clearTimeout(timer)
  }
}

/** The first interior stretch (chunk-relative) with no transcript at all, at
 *  least `minMs` long. Pure. Returns null when the chunk has no such hole. */
function firstInteriorGap(
  utterances: TranscribedUtterance[],
  durationMs: number,
  minMs: number,
): { fromMs: number; toMs: number } | null {
  if (utterances.length === 0) return null
  // START-to-START (endMs is back-filled and would hide every interior hole).
  const starts = utterances.map((u) => u.startMs).sort((a, b) => a - b)
  if (starts[0] >= minMs) return { fromMs: 0, toMs: starts[0] }
  for (let i = 1; i < starts.length; i++) {
    if (starts[i] - starts[i - 1] >= minMs) return { fromMs: starts[i - 1], toMs: starts[i] }
  }
  const last = starts[starts.length - 1]
  return durationMs - last >= minMs ? { fromMs: last, toMs: durationMs } : null
}

/** `M:SS` / `MM:SS` — the chunk prompt's clock (relative to the chunk start). */
function formatChunkTimestamp(ms: number): string {
  const total = Math.floor(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * Transcribe ONE chunk to its end: generate, and while the transcript falls
 * short of the chunk's duration and the last window made progress, resume from
 * the last line. `covered` reports whether the chunk was actually transcribed
 * end to end — the caller turns a short chunk into `truncated`, so a holed
 * transcript is never billed or synthesized as complete.
 */
async function transcribeOneChunk(
  opts: TranscribeRecordingOptions,
  chunk: RecordingAudioChunk,
  index: number,
): Promise<{
  utterances: TranscribedUtterance[]
  usages: Array<TokenUsage | null>
  covered: boolean
  /** Absolute span this chunk covers WITHOUT per-line timestamps (the
   *  format-ignoring fallback). Hole detection must not scan inside it. */
  opaqueRange?: { fromMs: number; toMs: number }
}> {
  const { fileUri } = await uploadAudioToGeminiFiles({
    apiKey: opts.apiKey,
    buffer: chunk.buffer,
    mime: chunk.mime,
    displayName: `${opts.displayName ?? 'recording'}-chunk-${index}`,
    fetchFn: opts.fetchFn,
    ...(opts.retryBackoffMs != null ? { retryBackoffMs: opts.retryBackoffMs } : {}),
  })

  // Work in CHUNK-RELATIVE ms; offset to absolute once, at the end.
  let rel: TranscribedUtterance[] = []
  const usages: Array<TokenUsage | null> = []
  let continueFrom: number | null = null
  let firstText = ''

  let stallSkipsLeft = MAX_CHUNK_STALL_SKIPS
  for (let win = 0; win < MAX_CHUNK_WINDOWS; win++) {
    const out = await generateChunkWindow(opts, chunk, fileUri, continueFrom)
    usages.push(out.usage)
    if (win === 0) firstText = out.text

    const scan = stripDegenerateTail(out.text)
    const parsed = parseTranscriptLines(scan.text).filter((u) => u.startMs <= chunk.durationMs)
    const before = rel.length
    rel = mergeUtterances(rel, parsed)
    const added = rel.length - before

    const lastMs = rel.length > 0 ? rel[rel.length - 1].startMs : 0
    if (lastMs >= chunk.durationMs - CHUNK_COVERAGE_TOLERANCE_MS) break
    if (added === 0) {
      // Stall INSIDE a chunk: the model will not advance past this spot (it
      // left a 4.4-min hole at ~47 min of a 96-min recording, 2026-07-14).
      // Skip the resume point forward and try again — the same recovery the
      // whole-file loop uses — rather than abandoning the rest of the chunk.
      if (stallSkipsLeft <= 0) break
      stallSkipsLeft--
      continueFrom = Math.min((continueFrom ?? lastMs) + CHUNK_STALL_SKIP_MS, chunk.durationMs)
      continue
    }
    stallSkipsLeft = MAX_CHUNK_STALL_SKIPS // progress resets the skip budget
    continueFrom = lastMs
  }

  // Fill the holes the stall-skips left: ask for each missing stretch directly.
  for (let fill = 0; fill < MAX_GAP_FILLS; fill++) {
    const gap = firstInteriorGap(rel, chunk.durationMs, MIN_GAP_FILL_MS)
    if (!gap) break
    const out = await generateChunkWindow(opts, chunk, fileUri, null, gap)
    usages.push(out.usage)
    // Keep only lines that land INSIDE the hole (a fill that re-emits the
    // bracketing lines would duplicate them), and never re-add one we have.
    const seen = new Set(rel.map((u) => `${u.startMs}|${u.text}`))
    const parsed = parseTranscriptLines(stripDegenerateTail(out.text).text).filter(
      (u) =>
        u.startMs >= Math.max(0, gap.fromMs - 5_000) &&
        u.startMs < gap.toMs &&
        !seen.has(`${u.startMs}|${u.text}`),
    )
    if (parsed.length === 0) break // the model has nothing more to give here
    rel = [...rel, ...parsed].sort((a, b) => a.startMs - b.startMs)
  }

  let utterances = rel.map((u) => ({
    ...u,
    startMs: Math.min(u.startMs, chunk.durationMs) + chunk.offsetMs,
    endMs: Math.min(Math.max(u.endMs, u.startMs), chunk.durationMs) + chunk.offsetMs,
  }))
  let coveredByFallback = false
  if (utterances.length === 0 && firstText.trim().length > 0) {
    // The model ignored the line format — keep the text, spanning the chunk.
    // It is assigned the chunk's whole span, so it covers the chunk by
    // construction; only a chunk with NO text at all is a hole.
    utterances = [
      {
        startMs: chunk.offsetMs,
        endMs: chunk.offsetMs + chunk.durationMs,
        speaker: null,
        text: firstText.trim(),
      },
    ]
    coveredByFallback = true
  }
  if (utterances.length > 0) {
    const last = utterances[utterances.length - 1]
    last.endMs = Math.max(last.startMs, Math.min(last.endMs, chunk.offsetMs + chunk.durationMs))
  }
  const lastRelMs = rel.length > 0 ? rel[rel.length - 1].startMs : 0
  const covered =
    coveredByFallback ||
    (utterances.length > 0 && lastRelMs >= chunk.durationMs - CHUNK_COVERAGE_TOLERANCE_MS)
  return {
    utterances,
    usages,
    covered,
    ...(coveredByFallback
      ? { opaqueRange: { fromMs: chunk.offsetMs, toMs: chunk.offsetMs + chunk.durationMs } }
      : {}),
  }
}

/**
 * Transcribe pre-split chunks independently (bounded parallelism, bounded
 * retries with backoff). Each chunk is transcribed to ITS end (see
 * `transcribeOneChunk` — a single generate call routinely stops after the
 * first minutes of a ~10-min chunk). `truncated` is true iff any chunk came
 * back short or empty, so a transcript with holes is ingested for recall but
 * never billed or synthesized as complete (the coverage contract).
 */
export async function transcribeRecordingChunks(
  opts: TranscribeRecordingOptions,
  chunks: RecordingAudioChunk[],
): Promise<RecordingTranscriptionResult> {
  const model = opts.model ?? DEFAULT_MODEL
  const usages: Array<{ usage: TokenUsage | null; model: string; costUsd?: number }> = []
  const perChunk: TranscribedUtterance[][] = new Array(chunks.length)
  const opaqueRanges: Array<{ fromMs: number; toMs: number }> = []
  let failedChunks = 0

  let next = 0
  const worker = async () => {
    while (true) {
      const i = next++
      if (i >= chunks.length) return
      // Retry with BACKOFF, not instantly: the failures that kill a chunk are
      // Gemini overload (503) and socket resets, and an immediate re-hit lands
      // in the same overloaded window (2026-07-14: chunk 3 of a 96-min
      // recording "failed twice" in the same second). An empty result is
      // retried too — a chunk that silently returns nothing punched 8-19 min
      // holes in the transcript that no error surfaced.
      let out: Awaited<ReturnType<typeof transcribeOneChunk>> | null = null
      let lastErr: unknown
      for (let attempt = 1; attempt <= CHUNK_ATTEMPTS; attempt++) {
        try {
          const got = await transcribeOneChunk(opts, chunks[i], i)
          for (const u of got.usages) usages.push({ usage: u, model })
          // Keep the best attempt: a covered chunk wins; otherwise the longest.
          if (!out || got.covered || got.utterances.length > out.utterances.length) out = got
          if (got.covered) break
          lastErr = new Error(
            got.utterances.length === 0
              ? 'chunk returned no utterances'
              : 'chunk transcript stopped short of the chunk end',
          )
        } catch (err) {
          lastErr = err
        }
        if (attempt < CHUNK_ATTEMPTS) {
          const base = opts.retryBackoffMs ?? CHUNK_RETRY_BACKOFF_MS
          if (base > 0) await new Promise((r) => setTimeout(r, base * attempt))
        }
      }
      perChunk[i] = out?.utterances ?? []
      if (out?.opaqueRange) opaqueRanges.push(out.opaqueRange)
      // A chunk that produced NOTHING (threw, or came back empty every attempt)
      // is a hard failure. A chunk that merely ended quiet is not — chunks are
      // silence-split, so a short tail is expected; holes are judged on the
      // merged transcript below.
      if (!out || out.utterances.length === 0) {
        failedChunks++
        console.warn(
          `[transcribe-recording] chunk ${i}/${chunks.length} produced nothing after ${CHUNK_ATTEMPTS} attempts:`,
          lastErr instanceof Error ? lastErr.message : lastErr,
        )
      } else if (!out.covered) {
        console.warn(
          `[transcribe-recording] chunk ${i}/${chunks.length} ended early (quiet tail or short transcript) — coverage judged on the merged transcript`,
        )
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CHUNK_CONCURRENCY, Math.max(1, chunks.length)) }, worker),
  )

  const utterances = perChunk.flat()
  return {
    utterances,
    usages,
    windows: chunks.length,
    // Judge truncation on the MERGED transcript, not per chunk: a chunk that
    // ends quiet is normal (they are split at silence), but a multi-minute
    // stretch of audio with no transcript at all is a hole. `failedChunks`
    // still counts a chunk that threw or returned nothing.
    truncated:
      failedChunks > 0 ||
      utterances.length === 0 ||
      hasTranscriptHole(utterances, opts.durationMs, opaqueRanges),
    // Chunk-parallel mode has no per-window degeneration guard (that runs on the
    // continuation-window path only), so nothing degenerates to count here.
    degenerateWindows: 0,
  }
}

/**
 * True when the transcript leaves a `MAX_TRANSCRIPT_GAP_MS`+ stretch of the
 * audio with nothing at all — at the start, between utterances, or at the end.
 * This is the honest coverage test for chunk-parallel mode: it measures the
 * holes a user would actually notice, instead of trusting each chunk's tail.
 * Pure.
 */
export function hasTranscriptHole(
  utterances: TranscribedUtterance[],
  durationMs: number,
  /** Spans known to be covered without per-line stamps (format-ignoring chunks). */
  opaqueRanges: Array<{ fromMs: number; toMs: number }> = [],
): boolean {
  if (utterances.length === 0) return opaqueRanges.length === 0
  const inOpaque = (a: number, b: number): boolean =>
    opaqueRanges.some((r) => r.fromMs <= a + 1 && r.toMs >= b - 1)
  const starts = utterances.map((u) => u.startMs).sort((a, b) => a - b)
  // START-to-START, never endMs: `endMs` is BACK-FILLED to the next line's
  // start (see parseTranscriptLines/mergeUtterances), so an interior hole
  // computes as a zero gap and hides. No single spoken line spans minutes.
  if (starts[0] > MAX_TRANSCRIPT_GAP_MS && !inOpaque(0, starts[0])) return true
  for (let i = 1; i < starts.length; i++) {
    if (starts[i] - starts[i - 1] > MAX_TRANSCRIPT_GAP_MS && !inOpaque(starts[i - 1], starts[i])) return true
  }
  const last = starts[starts.length - 1]
  return durationMs - last > MAX_TRANSCRIPT_GAP_MS && !inOpaque(last, durationMs)
}
