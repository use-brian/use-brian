/**
 * Qwen3-ASR-Flash buffer transcriber.
 *
 * Unlike the asynchronous filetrans model, this endpoint accepts a base64
 * data URL. That makes it the correct first choice for local/on-prem storage,
 * where a loopback signed URL is intentionally unreachable from DashScope.
 */

import type { RecordingTranscriber, RecordingTranscribeRequest } from './recording-transcriber.js'

const DEFAULT_BASE_URL = 'https://dashscope-intl.aliyuncs.com'
const DEFAULT_MODEL = 'qwen3-asr-flash'
const MAX_DURATION_MS = 5 * 60_000
const MAX_DATA_URL_BYTES = 10 * 1024 * 1024

/** Published international rate: US$0.000035 per audio second. */
export const QWEN_ASR_USD_PER_AUDIO_HOUR = 0.126

export type QwenAsrOptions = {
  apiKey: string
  baseUrl?: string
  model?: string
  usdPerAudioHour?: number
  fetchFn?: typeof fetch
}

type QwenAsrResponse = {
  choices?: Array<{ message?: { content?: string } }>
  output?: { choices?: Array<{ message?: { content?: string } }> }
}

function transcriptText(body: QwenAsrResponse): string {
  return (
    body.choices?.[0]?.message?.content ??
    body.output?.choices?.[0]?.message?.content ??
    ''
  ).trim()
}

export function qwenAsrTranscriber(opts: QwenAsrOptions): RecordingTranscriber {
  const base = (opts.baseUrl ?? DEFAULT_BASE_URL)
    .replace(/\/+$/, '')
    .replace(/\/compatible-mode\/v1$/, '')
  const model = opts.model ?? DEFAULT_MODEL
  const name = `dashscope:${model}`

  return {
    name,
    async transcribe(req: RecordingTranscribeRequest) {
      if (req.durationMs > MAX_DURATION_MS) {
        throw new Error('qwen buffer ASR supports audio up to 5 minutes')
      }
      const dataUrl = `data:${req.mime};base64,${req.buffer.toString('base64')}`
      if (Buffer.byteLength(dataUrl) > MAX_DATA_URL_BYTES) {
        throw new Error('qwen buffer ASR input exceeds the 10 MB data URL limit')
      }

      const response = await (opts.fetchFn ?? fetch)(`${base}/compatible-mode/v1/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [{
            role: 'user',
            content: [{ type: 'input_audio', input_audio: { data: dataUrl } }],
          }],
          stream: false,
          asr_options: {
            enable_itn: false,
            ...(req.language ? { language: req.language } : {}),
          },
        }),
      })
      if (!response.ok) {
        throw new Error(
          `qwen buffer ASR failed (HTTP ${response.status}): ${(await response.text().catch(() => '')).slice(0, 300)}`,
        )
      }

      const text = transcriptText((await response.json()) as QwenAsrResponse)
      if (!text) throw new Error('qwen buffer ASR returned an empty transcript')

      return {
        utterances: [{ startMs: 0, endMs: req.durationMs, speaker: null, text }],
        usages: [{
          usage: null,
          model: name,
          costUsd: (req.durationMs / 3_600_000) * (opts.usdPerAudioHour ?? QWEN_ASR_USD_PER_AUDIO_HOUR),
        }],
        windows: 1,
        truncated: false,
        degenerateWindows: 0,
      }
    },
  }
}
