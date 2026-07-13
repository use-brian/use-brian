/**
 * ElevenLabs Scribe recording transcriber (cantonese-transcription-refactor
 * Phase 1) — the hosted meeting-route provider behind the RecordingTranscriber
 * seam.
 *
 * One synchronous multipart POST carries the extracted AAC track; Scribe does
 * VAD/segmentation/diarization server-side and returns a word stream with real
 * acoustic timestamps (float seconds) and stable `speaker_id`s. We group that
 * stream into utterances (speaker change / >1.5 s gap / sentence-final
 * punctuation / length cap) — granularity is soft because segmentTranscript
 * re-packs utterances into ~1200-char segments downstream; what must be right
 * here is timestamp monotonicity and speaker fidelity.
 *
 * `keyterms` carries workspace entity names so proper nouns transcribe
 * correctly (≤1000 terms, <50 chars each per the API contract).
 *
 * COGS is flat-rate per audio hour (not tokens): `usages[0].costUsd` reports
 * it; the ingest factory prefers `costUsd` over token pricing.
 *
 * Spec: docs/architecture/media/transcription.md §"Long recordings" Providers.
 */

import type {
  RecordingTranscriber,
  RecordingTranscribeRequest,
} from './recording-transcriber.js'
import { coverageTruncated } from './recording-transcriber.js'
import type { TranscribedUtterance } from './transcribe-recording.js'

const SCRIBE_URL = 'https://api.elevenlabs.io/v1/speech-to-text'
const DEFAULT_MODEL_ID = 'scribe_v2'
/** Published batch rates 2026-07 — see docs/plans/cantonese-transcription-refactor.md §4. */
export const SCRIBE_USD_PER_AUDIO_HOUR = 0.22
export const SCRIBE_KEYTERMS_USD_PER_AUDIO_HOUR = 0.05
/** One sync call transcribes up to the 180-min ceiling — be generous. */
const DEFAULT_TIMEOUT_MS = 900_000
const MAX_KEYTERMS = 1000
const KEYTERM_MAX_CHARS = 49
const UTTERANCE_GAP_MS = 1_500
const UTTERANCE_MAX_CHARS = 500
const SENTENCE_END_RE = /[.!?。！？…]["'」』)]?$/

export type ScribeWord = {
  text: string
  start?: number
  end?: number
  type?: string // 'word' | 'spacing' | 'audio_event'
  speaker_id?: string | null
}

type ScribeResponse = {
  language_code?: string
  text?: string
  words?: ScribeWord[]
}

export type ScribeTranscriberOptions = {
  apiKey: string
  modelId?: string
  timeoutMs?: number
  usdPerAudioHour?: number
  fetchFn?: typeof fetch
}

/** Group Scribe's word stream into utterances. Pure — unit-tested directly. */
export function groupScribeWords(words: ScribeWord[]): TranscribedUtterance[] {
  type Buf = { startMs: number; endMs: number; speaker: string | null; text: string }
  const out: TranscribedUtterance[] = []
  let buf: Buf | null = null

  const flush = () => {
    if (!buf) return
    const text = buf.text.trim()
    if (text.length > 0) {
      out.push({ startMs: buf.startMs, endMs: buf.endMs, speaker: buf.speaker, text })
    }
    buf = null
  }

  for (const w of words) {
    if (w.type === 'audio_event') continue
    if (w.type === 'spacing') {
      if (buf) buf.text += w.text
      continue
    }
    const startMs = Math.round((w.start ?? 0) * 1000)
    const endMs = Math.round((w.end ?? w.start ?? 0) * 1000)
    const speaker = w.speaker_id ?? null

    if (buf) {
      const boundary =
        speaker !== buf.speaker ||
        startMs - buf.endMs > UTTERANCE_GAP_MS ||
        buf.text.length >= UTTERANCE_MAX_CHARS ||
        SENTENCE_END_RE.test(buf.text.trimEnd())
      if (boundary) flush()
    }
    if (!buf) {
      buf = { startMs, endMs: Math.max(startMs, endMs), speaker, text: w.text }
    } else {
      buf.text += w.text
      buf.endMs = Math.max(buf.endMs, endMs)
    }
  }
  flush()
  return out
}

/** Scribe's diarization speaker ids ('speaker_0') → display labels the segment
 *  store already expects ('Speaker 1'), matching the Gemini path's convention. */
function displaySpeaker(u: TranscribedUtterance): TranscribedUtterance {
  if (!u.speaker) return u
  const m = /^speaker_(\d+)$/.exec(u.speaker)
  return m ? { ...u, speaker: `Speaker ${Number(m[1]) + 1}` } : u
}

export function scribeTranscriber(opts: ScribeTranscriberOptions): RecordingTranscriber {
  const modelId = opts.modelId ?? DEFAULT_MODEL_ID
  const name = `elevenlabs:${modelId}`

  return {
    name,
    async transcribe(req: RecordingTranscribeRequest) {
      const fetchFn = opts.fetchFn ?? fetch
      const form = new FormData()
      form.append('model_id', modelId)
      form.append(
        'file',
        new Blob([new Uint8Array(req.buffer)], { type: req.mime }),
        req.displayName ?? 'recording.aac',
      )
      form.append('diarize', 'true')
      form.append('timestamps_granularity', 'word')
      form.append('tag_audio_events', 'false')
      const keyterms = (req.keyterms ?? [])
        .map((t) => t.trim())
        .filter((t) => t.length > 0 && t.length <= KEYTERM_MAX_CHARS)
        .slice(0, MAX_KEYTERMS)
      for (const term of keyterms) form.append('keyterms', term)

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      let res: Response
      try {
        res = await fetchFn(SCRIBE_URL, {
          method: 'POST',
          headers: { 'xi-api-key': opts.apiKey },
          body: form,
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timer)
      }
      if (!res.ok) {
        throw new Error(
          `Scribe transcription failed (HTTP ${res.status}): ${(await res.text().catch(() => '')).slice(0, 300)}`,
        )
      }
      const payload = (await res.json()) as ScribeResponse

      let utterances = groupScribeWords(payload.words ?? []).map(displaySpeaker)
      if (utterances.length === 0 && (payload.text ?? '').trim().length > 0) {
        // Degenerate no-words response: keep the text, spanning the known
        // duration so downstream segmenting still works.
        utterances = [
          { startMs: 0, endMs: req.durationMs, speaker: null, text: payload.text!.trim() },
        ]
      }

      const hours = req.durationMs / 3_600_000
      const rate =
        (opts.usdPerAudioHour ?? SCRIBE_USD_PER_AUDIO_HOUR) +
        (keyterms.length > 0 ? SCRIBE_KEYTERMS_USD_PER_AUDIO_HOUR : 0)

      return {
        utterances,
        usages: [{ usage: null, model: name, costUsd: hours * rate }],
        windows: 1,
        truncated: coverageTruncated(utterances, req.durationMs),
        // Single-shot file provider: no windowed continuation, so no degeneration guard runs.
        degenerateWindows: 0,
      }
    },
  }
}
