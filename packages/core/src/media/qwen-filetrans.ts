/**
 * Qwen3-ASR file-transcription recording transcriber
 * (cantonese-transcription-refactor Phase 1) — the cost-optimized memo-route
 * provider behind the RecordingTranscriber seam. Env-gated and default-off
 * pending the plan's §6 data-residency call.
 *
 * DashScope file transcription is submit-by-URL only: we hand it the signed
 * GCS READ url of the ORIGINAL object (`req.sourceUrl` — the same url the
 * worker already mints for ffprobe/ffmpeg), poll the async task, then fetch
 * the result JSON it stages at `transcription_url`. Sentence-level timestamps
 * (ms) map 1:1 onto utterances; the model does no diarization (`speaker:
 * null`) which is exactly why this provider is memo-route-only.
 *
 * COGS is flat-rate per audio hour: `usages[0].costUsd`.
 *
 * Spec: docs/architecture/media/transcription.md §"Long recordings" Providers.
 */

import type {
  RecordingTranscriber,
  RecordingTranscribeRequest,
} from './recording-transcriber.js'
import { coverageTruncated } from './recording-transcriber.js'
import type { TranscribedUtterance } from './transcribe-recording.js'

/** International (Singapore) endpoint — mainland accounts not required. */
const DEFAULT_BASE_URL = 'https://dashscope-intl.aliyuncs.com'
const DEFAULT_MODEL = 'qwen3-asr-flash-filetrans'
/** Published international rate 2026-07 ($0.000035/s) — see plan §4. */
export const QWEN_FILETRANS_USD_PER_AUDIO_HOUR = 0.126
const DEFAULT_POLL_INTERVAL_MS = 5_000
const DEFAULT_MAX_POLLS = 180 // 15 min at the default interval

type SubmitResponse = { output?: { task_id?: string; task_status?: string } }
type TaskResponse = {
  output?: {
    task_status?: string
    message?: string
    result?: { transcription_url?: string }
    results?: Array<{ transcription_url?: string; subtask_status?: string }>
  }
}
type TranscriptionFile = {
  transcripts?: Array<{
    sentences?: Array<{ begin_time?: number; end_time?: number; text?: string }>
  }>
}

export type QwenFiletransOptions = {
  apiKey: string
  baseUrl?: string
  model?: string
  pollIntervalMs?: number
  maxPolls?: number
  usdPerAudioHour?: number
  fetchFn?: typeof fetch
}

function isPrivateSourceUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.toLowerCase()
    return host === 'localhost' || host === '::1' || host === '0.0.0.0' || host === '127.0.0.1' ||
      host.startsWith('127.') || host.startsWith('10.') || host.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  } catch {
    return true
  }
}

export function qwenFiletransTranscriber(opts: QwenFiletransOptions): RecordingTranscriber {
  const base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
  const model = opts.model ?? DEFAULT_MODEL
  const name = `dashscope:${model}`
  const pollInterval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const maxPolls = opts.maxPolls ?? DEFAULT_MAX_POLLS

  return {
    name,
    async transcribe(req: RecordingTranscribeRequest) {
      const fetchFn = opts.fetchFn ?? fetch
      if (!req.sourceUrl) {
        // URL-submit provider with nothing to submit — let the ladder fall
        // through to a buffer-based provider.
        throw new Error('qwen filetrans requires a sourceUrl (signed READ url)')
      }
      if (isPrivateSourceUrl(req.sourceUrl)) {
        throw new Error(
          'qwen filetrans cannot download a localhost/private storage URL. ' +
          'Configure GEMINI_API_KEY for buffer-upload transcription, or set LOCAL_FILES_PUBLIC_URL to a public HTTPS endpoint.',
        )
      }

      // 1. Submit the async task.
      const submitRes = await fetchFn(`${base}/api/v1/services/audio/asr/transcription`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          'Content-Type': 'application/json',
          'X-DashScope-Async': 'enable',
        },
        body: JSON.stringify({
          model,
          input: { file_url: req.sourceUrl },
          parameters: { enable_words: false },
        }),
      })
      if (!submitRes.ok) {
        throw new Error(
          `qwen filetrans submit failed (HTTP ${submitRes.status}): ${(await submitRes.text().catch(() => '')).slice(0, 300)}`,
        )
      }
      const submitted = (await submitRes.json()) as SubmitResponse
      const taskId = submitted.output?.task_id
      if (!taskId) throw new Error('qwen filetrans submit: response missing task_id')

      // 2. Poll until the task settles.
      let resultUrl: string | undefined
      for (let poll = 0; ; poll++) {
        if (poll >= maxPolls) {
          throw new Error(`qwen filetrans task ${taskId} did not settle within ${maxPolls} polls`)
        }
        await new Promise((r) => setTimeout(r, pollInterval))
        const pollRes = await fetchFn(`${base}/api/v1/tasks/${taskId}`, {
          headers: { Authorization: `Bearer ${opts.apiKey}` },
        })
        if (!pollRes.ok) {
          throw new Error(`qwen filetrans poll failed (HTTP ${pollRes.status})`)
        }
        const task = (await pollRes.json()) as TaskResponse
        const status = task.output?.task_status ?? 'PENDING'
        if (status === 'SUCCEEDED') {
          resultUrl =
            task.output?.result?.transcription_url ??
            task.output?.results?.[0]?.transcription_url
          if (!resultUrl) throw new Error('qwen filetrans: SUCCEEDED task missing transcription_url')
          break
        }
        if (status === 'FAILED' || status === 'CANCELED') {
          throw new Error(
            `qwen filetrans task ${taskId} ${status}: ${task.output?.message ?? 'no message'}`,
          )
        }
      }

      // 3. Fetch the staged result JSON (public, 24 h validity — no auth).
      const fileRes = await fetchFn(resultUrl)
      if (!fileRes.ok) {
        throw new Error(`qwen filetrans result fetch failed (HTTP ${fileRes.status})`)
      }
      const file = (await fileRes.json()) as TranscriptionFile

      const utterances: TranscribedUtterance[] = []
      for (const transcript of file.transcripts ?? []) {
        for (const s of transcript.sentences ?? []) {
          const text = (s.text ?? '').trim()
          if (text.length === 0) continue
          const startMs = Math.max(0, Math.round(s.begin_time ?? 0))
          utterances.push({
            startMs,
            endMs: Math.max(startMs, Math.round(s.end_time ?? startMs)),
            speaker: null,
            text,
          })
        }
      }
      utterances.sort((a, b) => a.startMs - b.startMs)

      const hours = req.durationMs / 3_600_000
      return {
        utterances,
        usages: [
          {
            usage: null,
            model: name,
            costUsd: hours * (opts.usdPerAudioHour ?? QWEN_FILETRANS_USD_PER_AUDIO_HOUR),
          },
        ],
        windows: 1,
        truncated: coverageTruncated(utterances, req.durationMs),
        // Single-shot file provider: no windowed continuation, so no degeneration guard runs.
        degenerateWindows: 0,
      }
    },
  }
}
