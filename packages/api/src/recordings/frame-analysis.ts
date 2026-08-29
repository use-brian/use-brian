// [COMP:recordings/frame-analysis] - video keyframe analysis for the recording
// pipeline.
//
// A video recording's audio track carries the words; its frames carry the
// slides, demos, and on-screen text the words point at. This module samples
// bounded keyframes from the stored video (ffmpeg, one pass), describes them in
// batches through the provider-blind media backend (`runFrameBatchUnderstanding`
// - Gemini inlineData / Qwen-VL data URIs / the deployment's own chat provider),
// and returns timestamped VISUAL MOMENTS the orchestrations merge into
// transcript_segments (kind='visual'), the Pipeline-B ingest text, and - via
// `loadRecordingTranscript` - the synthesis prompt, so briefs can cite what was
// on screen with the same `[H:MM:SS]` stamps as speech.
//
// Failure posture matches every additive recording step: the analyzer returns
// null (no vision backend, no decodable video stream) or throws (a real
// infrastructure failure); the CALLER isolates the throw so a vision outage can
// never cost the user their transcript.
//
// Spec: docs/architecture/media/transcription.md -> "Video frame analysis".

import {
  runFrameBatchUnderstanding,
  type FrameBatchRequest,
  type MediaBackend,
  type MediaResult,
  type TokenUsage,
} from '@use-brian/core'
import { formatStamp } from '@use-brian/shared'
import {
  extractRecordingFrames,
  type FrameSamplingOptions,
  type SampledFrame,
} from './ffmpeg.js'

export type VisualMoment = { tsMs: number; description: string }

export type FrameAnalysis = {
  moments: VisualMoment[]
  /** One entry per vision call, for COGS recording (never a billed credit). */
  usages: Array<{ model: string; usage: TokenUsage | null }>
}

export type RecordingFrameAnalyzer = (args: {
  /** Signed READ url of the ORIGINAL stored video object. */
  sourceUrl: string
  /** ffprobe truth, drives the sampling plan. */
  durationMs: number
}) => Promise<FrameAnalysis | null>

/** Frames per vision call. Descriptions stay short, so 12 frames fit well
 *  inside one call's output budget and keep a failed batch's blast radius small. */
const FRAMES_PER_BATCH = 12
/** Mirrors the media distiller's default (`files/distill.ts` DEFAULT_MODEL). */
const FRAME_VISION_MODEL = 'gemini-2.5-flash'
const BATCH_MAX_OUTPUT_TOKENS = 2048
const BATCH_TIMEOUT_MS = 120_000

/**
 * The batch prompt. Frames are numbered BATCH-LOCALLY (`Frame 1..n`) and each
 * number is bound to its recording timestamp in the prompt, so the reply needs
 * no timestamp arithmetic of its own - a model-mangled stamp cannot move a
 * description to a moment that never existed. `SKIP` exists so near-duplicate
 * frames (a slide held for five minutes) cost one description, not ten.
 */
export function buildFrameBatchPrompt(frames: Array<{ tsMs: number }>, opts?: { language?: string }): string {
  const listing = frames
    .map((frame, i) => `Frame ${i + 1} = [${formatStamp(frame.tsMs)}]`)
    .join('\n')
  const language = opts?.language
    ? `Write the descriptions in the language with ISO 639 code "${opts.language}".\n`
    : ''
  return (
    'These are frames sampled from one video recording, in chronological order. ' +
    'For each frame, describe in one or two sentences the information it shows: slide titles and their key points, ' +
    'on-screen text, charts and what they say, application or document content, or the scene if it is a camera shot. ' +
    'Transcribe short on-screen text verbatim where it carries the meaning.\n' +
    `${language}` +
    'Reply with exactly one line per frame, in order, formatted as:\n' +
    'Frame <number>: <description>\n' +
    'If a frame shows nothing new compared to the previous frame, reply "Frame <number>: SKIP".\n\n' +
    `${listing}`
  )
}

const FRAME_LINE_RE = /^\s*Frame\s+(\d+)\s*[:.]\s*(.+)\s*$/i

/**
 * Parse a batch reply back to moments. Only well-formed `Frame <n>: <text>`
 * lines are accepted, `n` must address a frame in THIS batch, `SKIP` drops the
 * frame, and a duplicate number keeps its first description. Everything else
 * (preamble, markdown fences, trailing chatter) is ignored - a malformed reply
 * degrades to fewer moments, never to a wrong timestamp.
 */
export function parseFrameBatchReply(
  text: string,
  frames: Array<{ tsMs: number }>,
): VisualMoment[] {
  const seen = new Set<number>()
  const moments: VisualMoment[] = []
  for (const line of text.split('\n')) {
    const m = FRAME_LINE_RE.exec(line)
    if (!m) continue
    const n = Number(m[1])
    if (!Number.isInteger(n) || n < 1 || n > frames.length || seen.has(n)) continue
    seen.add(n)
    const description = m[2].trim()
    if (!description || /^SKIP\b/i.test(description)) continue
    moments.push({ tsMs: frames[n - 1].tsMs, description })
  }
  moments.sort((a, b) => a.tsMs - b.tsMs)
  return moments
}

/**
 * The Pipeline-B ingest text with visual moments interleaved chronologically.
 * Speech lines keep the exact `speaker: text` shape `joinTranscript` always
 * produced (extraction prompts are tuned to it); a visual moment rides as a
 * `Screen: description` line at its place in time, visual-first on a tie for
 * the same reason `mergeVisualSegments` orders that way.
 */
export function interleaveTranscriptText(
  utterances: ReadonlyArray<{ startMs: number; speaker: string | null; text: string }>,
  moments: ReadonlyArray<VisualMoment>,
): string {
  type Line = { startMs: number; visual: boolean; line: string }
  const lines: Line[] = [
    ...moments.map((m) => ({ startMs: m.tsMs, visual: true, line: `Screen: ${m.description}` })),
    ...utterances.map((u) => ({
      startMs: u.startMs,
      visual: false,
      line: `${u.speaker ? `${u.speaker}: ` : ''}${u.text}`,
    })),
  ]
  return lines
    .sort((a, b) => a.startMs - b.startMs || Number(b.visual) - Number(a.visual))
    .map((l) => l.line)
    .join('\n')
}

export type CreateFrameAnalyzerDeps = {
  /**
   * Resolve the vision backend PER CALL (provider preference is hot-mutable).
   * Undefined = no vision capability configured; the analyzer resolves null
   * and the recording proceeds audio-only.
   */
  backend: () => MediaBackend | undefined
  /** ISO 639 hint for description language (workspace transcription pref). */
  language?: () => string | undefined
  sampling?: FrameSamplingOptions
  model?: string
  // Injected for tests; default to the real implementations.
  extractFrames?: (input: string, durationMs: number, opts?: FrameSamplingOptions) => Promise<SampledFrame[]>
  runBatch?: (backend: MediaBackend, req: FrameBatchRequest) => Promise<MediaResult>
}

export function createRecordingFrameAnalyzer(deps: CreateFrameAnalyzerDeps): RecordingFrameAnalyzer {
  const extract = deps.extractFrames ?? extractRecordingFrames
  const runBatch = deps.runBatch ?? runFrameBatchUnderstanding
  return async ({ sourceUrl, durationMs }) => {
    const backend = deps.backend()
    if (!backend) return null
    const frames = await extract(sourceUrl, durationMs, deps.sampling)
    if (frames.length === 0) return null
    const language = deps.language?.()
    const moments: VisualMoment[] = []
    const usages: FrameAnalysis['usages'] = []
    // Sequential batches on purpose: the recording worker runs at concurrency 1
    // on a small instance, and a batch failure should stop spending, not fan out.
    for (let start = 0; start < frames.length; start += FRAMES_PER_BATCH) {
      const batch = frames.slice(start, start + FRAMES_PER_BATCH)
      const result = await runBatch(backend, {
        frames: batch.map((f) => ({ buffer: f.buffer, mime: f.mime })),
        prompt: buildFrameBatchPrompt(batch, language ? { language } : undefined),
        model: deps.model ?? FRAME_VISION_MODEL,
        maxOutputTokens: BATCH_MAX_OUTPUT_TOKENS,
        timeoutMs: BATCH_TIMEOUT_MS,
        errorLabel: 'recording frame analysis',
      })
      usages.push({ model: result.model, usage: result.usage })
      moments.push(...parseFrameBatchReply(result.text, batch))
    }
    return { moments, usages }
  }
}
