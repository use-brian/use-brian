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

/**
 * `fetchFn` with a bounded retry on transient socket resets. Retries ONLY when
 * the fetch call itself rejects — once a response object exists (even a non-OK
 * one) the request reached the server and is never replayed. Abort errors are
 * not retried (the caller's deadline stands).
 */
async function fetchWithTransientRetry(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchFn(url, init)
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError'
      if (aborted || !isTransientFetchError(err) || attempt >= TRANSIENT_FETCH_ATTEMPTS) throw err
      await new Promise((r) => setTimeout(r, TRANSIENT_FETCH_BACKOFF_MS * attempt))
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
  opts: { apiKey: string; buffer: Buffer; mime: string; displayName?: string; fetchFn?: typeof fetch },
): Promise<{ fileUri: string; name: string }> {
  const fetchFn = opts.fetchFn ?? fetch
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
  })
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
    const pollRes = await fetchWithTransientRetry(fetchFn, `${FILES_BASE}/v1beta/${file.name}`, {
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
    if (!res.body) throw new Error('Gemini transcription: no response body')

    // Accumulate across chunks: text concatenates; finishReason + usage come
    // on the final chunk (usageMetadata totals are cumulative — last wins).
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
  } finally {
    clearTimeout(timer)
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
const CHUNK_MAX_OUTPUT_TOKENS = 16_384

/** thinkingBudget is a 2.5-family knob; gen-3 models reject it (they take
 *  thinkingLevel, whose default is fine here). */
function thinkingConfigFor(model: string): Record<string, unknown> {
  return /gemini-2\.5/.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {}
}

async function transcribeOneChunk(
  opts: TranscribeRecordingOptions,
  chunk: RecordingAudioChunk,
  index: number,
): Promise<{ utterances: TranscribedUtterance[]; usage: TokenUsage | null }> {
  const fetchFn = opts.fetchFn ?? fetch
  const model = opts.model ?? DEFAULT_MODEL
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const { fileUri } = await uploadAudioToGeminiFiles({
    apiKey: opts.apiKey,
    buffer: chunk.buffer,
    mime: chunk.mime,
    displayName: `${opts.displayName ?? 'recording'}-chunk-${index}`,
    fetchFn: opts.fetchFn,
  })

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: CHUNK_TRANSCRIBE_PROMPT },
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
    throw new Error(`Gemini chunk transcription failed (HTTP ${res.status}): ${(await res.text().catch(() => '')).slice(0, 300)}`)
  }
  const payload = (await res.json()) as GeminiGenerateResponse
  const text = (payload.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('')

  let utterances = parseTranscriptLines(text).map((u) => ({
    ...u,
    startMs: Math.min(u.startMs, chunk.durationMs) + chunk.offsetMs,
    endMs: Math.min(Math.max(u.endMs, u.startMs), chunk.durationMs) + chunk.offsetMs,
  }))
  if (utterances.length === 0 && text.trim().length > 0) {
    // The model ignored the line format — keep the text, spanning the chunk.
    utterances = [
      {
        startMs: chunk.offsetMs,
        endMs: chunk.offsetMs + chunk.durationMs,
        speaker: null,
        text: text.trim(),
      },
    ]
  }
  // Clamp the chunk's final utterance to the chunk end.
  if (utterances.length > 0) {
    const last = utterances[utterances.length - 1]
    last.endMs = Math.max(last.startMs, Math.min(last.endMs, chunk.offsetMs + chunk.durationMs))
  }
  return { utterances, usage: extractUsage(payload.usageMetadata) }
}

/**
 * Transcribe pre-split chunks independently (bounded parallelism, one retry
 * per chunk). `truncated` is true iff any chunk failed both attempts — a
 * silent chunk that transcribes to nothing is legitimately covered. Failed
 * chunks contribute no text; everything that succeeded is still returned so
 * the caller can ingest the partial (unbilled, per the coverage contract).
 */
export async function transcribeRecordingChunks(
  opts: TranscribeRecordingOptions,
  chunks: RecordingAudioChunk[],
): Promise<RecordingTranscriptionResult> {
  const model = opts.model ?? DEFAULT_MODEL
  const usages: Array<{ usage: TokenUsage | null; model: string; costUsd?: number }> = []
  const perChunk: TranscribedUtterance[][] = new Array(chunks.length)
  let failedChunks = 0

  let next = 0
  const worker = async () => {
    while (true) {
      const i = next++
      if (i >= chunks.length) return
      try {
        let out: Awaited<ReturnType<typeof transcribeOneChunk>>
        try {
          out = await transcribeOneChunk(opts, chunks[i], i)
        } catch {
          out = await transcribeOneChunk(opts, chunks[i], i) // one retry
        }
        perChunk[i] = out.utterances
        usages.push({ usage: out.usage, model })
      } catch (err) {
        failedChunks++
        perChunk[i] = []
        console.warn(
          `[transcribe-recording] chunk ${i}/${chunks.length} failed twice:`,
          err instanceof Error ? err.message : err,
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
    truncated: failedChunks > 0 || utterances.length === 0,
    // Chunk-parallel mode has no per-window degeneration guard (that runs on the
    // continuation-window path only), so nothing degenerates to count here.
    degenerateWindows: 0,
  }
}
