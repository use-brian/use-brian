import { describe, it, expect, vi } from 'vitest'
import type { MediaBackend } from '@use-brian/core'
import {
  buildFrameBatchPrompt,
  createRecordingFrameAnalyzer,
  interleaveTranscriptText,
  parseFrameBatchReply,
} from '../frame-analysis.js'
import { planFrameSampling } from '../ffmpeg.js'

/**
 * Pure unit tests for video keyframe analysis. No ffmpeg, no network — the
 * extractor and the batch runner are injected.
 *
 * Spec: docs/architecture/media/transcription.md § "Video frame analysis".
 */
describe('[COMP:recordings/frame-analysis] frame analysis', () => {
  const backend: MediaBackend = { kind: 'dashscope', apiKey: 'k', baseUrl: 'https://x.example' }
  const frame = (tsMs: number) => ({ tsMs, buffer: Buffer.from('jpg'), mime: 'image/jpeg' })

  describe('planFrameSampling', () => {
    it('caps a long recording at maxFrames by widening the interval', () => {
      const plan = planFrameSampling(2 * 60 * 60 * 1000, { maxFrames: 48, minIntervalSec: 10 })
      expect(plan.intervalSec).toBe(150)
      expect(plan.expectedFrames).toBeLessThanOrEqual(48)
    })

    it('never samples denser than minIntervalSec on a short video', () => {
      const plan = planFrameSampling(3 * 60 * 1000, { maxFrames: 48, minIntervalSec: 10 })
      expect(plan.intervalSec).toBe(10)
      expect(plan.expectedFrames).toBe(19) // t=0 plus one per 10s over 180s
    })
  })

  describe('buildFrameBatchPrompt', () => {
    it('binds batch-local frame numbers to recording timestamps', () => {
      const prompt = buildFrameBatchPrompt([frame(0), frame(150_000)])
      expect(prompt).toContain('Frame 1 = [0:00:00]')
      expect(prompt).toContain('Frame 2 = [0:02:30]')
      expect(prompt).toContain('SKIP')
    })

    it('carries the workspace language hint when present', () => {
      expect(buildFrameBatchPrompt([frame(0)], { language: 'ja' })).toContain('"ja"')
      expect(buildFrameBatchPrompt([frame(0)])).not.toContain('ISO 639')
    })
  })

  describe('parseFrameBatchReply', () => {
    const frames = [frame(0), frame(10_000), frame(20_000)]

    it('maps well-formed lines to their frame timestamps, in order', () => {
      const reply = 'Frame 2: A pricing slide titled "Q3 Plans".\nFrame 1: Title slide.'
      expect(parseFrameBatchReply(reply, frames)).toEqual([
        { tsMs: 0, description: 'Title slide.' },
        { tsMs: 10_000, description: 'A pricing slide titled "Q3 Plans".' },
      ])
    })

    it('drops SKIP frames, out-of-range numbers, duplicates, and chatter', () => {
      const reply = [
        'Here are the descriptions:',
        'Frame 1: SKIP',
        'Frame 2: The dashboard shows revenue up 12%.',
        'Frame 2: a duplicate that must not win',
        'Frame 9: does not exist in this batch',
        'not a frame line at all',
      ].join('\n')
      expect(parseFrameBatchReply(reply, frames)).toEqual([
        { tsMs: 10_000, description: 'The dashboard shows revenue up 12%.' },
      ])
    })

    it('returns [] for a reply with no parseable line, never throwing', () => {
      expect(parseFrameBatchReply('I cannot see any images.', frames)).toEqual([])
    })
  })

  describe('createRecordingFrameAnalyzer', () => {
    it('resolves null when no vision backend is configured', async () => {
      const analyze = createRecordingFrameAnalyzer({
        backend: () => undefined,
        extractFrames: vi.fn(async () => [frame(0)]),
      })
      expect(await analyze({ sourceUrl: 'https://x.example/v', durationMs: 1000 })).toBeNull()
    })

    it('resolves null when the source has no decodable video frames', async () => {
      const analyze = createRecordingFrameAnalyzer({
        backend: () => backend,
        extractFrames: vi.fn(async () => []),
      })
      expect(await analyze({ sourceUrl: 'https://x.example/v', durationMs: 1000 })).toBeNull()
    })

    it('batches frames, collects per-call usage, and merges parsed moments', async () => {
      const frames = Array.from({ length: 15 }, (_, i) => frame(i * 10_000))
      const runBatch = vi
        .fn()
        .mockResolvedValueOnce({ text: 'Frame 1: First slide.', usage: { inputTokens: 10, outputTokens: 2 }, model: 'm1' })
        .mockResolvedValueOnce({ text: 'Frame 3: Last slide.', usage: null, model: 'm1' })
      const analyze = createRecordingFrameAnalyzer({
        backend: () => backend,
        extractFrames: vi.fn(async () => frames),
        runBatch,
      })
      const result = await analyze({ sourceUrl: 'https://x.example/v', durationMs: 150_000 })
      expect(runBatch).toHaveBeenCalledTimes(2) // 12 + 3
      expect(result?.usages).toHaveLength(2)
      // Batch 2's "Frame 3" is batch-local: frames[12 + 2] = 140s.
      expect(result?.moments).toEqual([
        { tsMs: 0, description: 'First slide.' },
        { tsMs: 140_000, description: 'Last slide.' },
      ])
    })
  })

  describe('interleaveTranscriptText', () => {
    it('interleaves visual moments chronologically, visual first on a tie', () => {
      const text = interleaveTranscriptText(
        [
          { startMs: 0, speaker: 'A', text: 'Welcome everyone.' },
          { startMs: 20_000, speaker: null, text: 'So about the chart.' },
        ],
        [
          { tsMs: 0, description: 'Title slide.' },
          { tsMs: 20_000, description: 'A bar chart of monthly revenue.' },
        ],
      )
      expect(text.split('\n')).toEqual([
        'Screen: Title slide.',
        'A: Welcome everyone.',
        'Screen: A bar chart of monthly revenue.',
        'So about the chart.',
      ])
    })

    it('is exactly the legacy join when there are no moments', () => {
      const text = interleaveTranscriptText(
        [{ startMs: 0, speaker: 'A', text: 'Hello.' }, { startMs: 1, speaker: null, text: 'Hi.' }],
        [],
      )
      expect(text).toBe('A: Hello.\nHi.')
    })
  })
})
