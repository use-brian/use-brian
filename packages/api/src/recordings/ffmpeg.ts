// Part of [COMP:recordings/open-process-recording] - policy-free ffprobe/ffmpeg helpers.

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export async function probeRecordingDuration(input: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      input,
    ], { timeout: 60_000, maxBuffer: 1 << 20 })
    const seconds = Number.parseFloat(stdout.toString().trim())
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('no positive duration returned')
    return Math.round(seconds * 1000)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`ffprobe prerequisite failed: ${message}`)
  }
}

export async function extractRecordingAudio(input: string): Promise<{ buffer: Buffer; mime: string }> {
  const outPath = join(tmpdir(), `recording-${randomUUID()}.m4a`)
  try {
    try {
      await execFileAsync('ffmpeg', [
        '-v', 'error', '-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000',
        '-c:a', 'aac', '-b:a', '24k', '-movflags', '+faststart', '-f', 'mp4', outPath,
      ], { timeout: 900_000, maxBuffer: 1 << 20 })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`ffmpeg prerequisite failed: ${message}`)
    }
    const buffer = await readFile(outPath)
    if (buffer.length === 0) throw new Error('ffmpeg produced an empty audio track')
    return { buffer, mime: 'audio/mp4' }
  } finally {
    await unlink(outPath).catch(() => {})
  }
}

export type SampledFrame = { tsMs: number; buffer: Buffer; mime: string }

export type FrameSamplingOptions = {
  /** Hard ceiling on frames per recording — the vision-cost bound. */
  maxFrames?: number
  /** Never sample denser than this, however short the video. */
  minIntervalSec?: number
}

const FRAME_MAX_DEFAULT = 48
const FRAME_MIN_INTERVAL_SEC_DEFAULT = 10

/**
 * Pure sampling plan: the interval that keeps a recording at or under
 * `maxFrames` while never sampling denser than `minIntervalSec`. Deterministic
 * so the ffmpeg pass and the timestamp arithmetic cannot disagree.
 */
export function planFrameSampling(
  durationMs: number,
  opts?: FrameSamplingOptions,
): { intervalSec: number; expectedFrames: number } {
  const maxFrames = Math.max(1, opts?.maxFrames ?? FRAME_MAX_DEFAULT)
  const minIntervalSec = Math.max(1, opts?.minIntervalSec ?? FRAME_MIN_INTERVAL_SEC_DEFAULT)
  const durationSec = Math.max(1, durationMs / 1000)
  const intervalSec = Math.max(minIntervalSec, Math.ceil(durationSec / maxFrames))
  // fps=1/interval emits the first frame at t~0, then one per interval.
  const expectedFrames = Math.min(maxFrames, Math.max(1, Math.floor(durationSec / intervalSec) + 1))
  return { intervalSec, expectedFrames }
}

/**
 * Sample keyframes from a video for visual analysis: one bounded ffmpeg pass
 * (`fps=1/interval`, downscaled, JPEG) whose frame count is capped by
 * `planFrameSampling`. Frame N's timestamp is (N-1) x interval — the fps
 * filter emits the first frame at the start of the stream. Returns [] for a
 * source with no decodable video stream (an audio file behind a video/* mime),
 * so callers degrade to audio-only without treating it as a failure.
 */
export async function extractRecordingFrames(
  input: string,
  durationMs: number,
  opts?: FrameSamplingOptions,
): Promise<SampledFrame[]> {
  const { intervalSec, expectedFrames } = planFrameSampling(durationMs, opts)
  const dir = await mkdtemp(join(tmpdir(), 'recording-frames-'))
  try {
    try {
      await execFileAsync('ffmpeg', [
        '-v', 'error', '-y', '-i', input, '-an',
        '-vf', `fps=1/${intervalSec},scale='min(896,iw)':-2`,
        '-frames:v', String(expectedFrames),
        '-q:v', '6', '-f', 'image2', join(dir, 'frame-%05d.jpg'),
      ], { timeout: 900_000, maxBuffer: 1 << 20 })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // No video stream in the container is an ordinary state for this probe
      // (audio uploaded under a video/* mime), not an infrastructure failure.
      if (/does not contain any stream|no.*video|Output file .* does not contain/i.test(message)) return []
      throw new Error(`ffmpeg frame sampling failed: ${message}`)
    }
    const frames: SampledFrame[] = []
    for (let n = 1; n <= expectedFrames; n += 1) {
      const path = join(dir, `frame-${String(n).padStart(5, '0')}.jpg`)
      let buffer: Buffer
      try {
        buffer = await readFile(path)
      } catch {
        break // ffmpeg emitted fewer frames than planned (short or sparse stream)
      }
      if (buffer.length === 0) break
      frames.push({ tsMs: (n - 1) * intervalSec * 1000, buffer, mime: 'image/jpeg' })
    }
    return frames
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Assemble sequential self-contained audio windows (the live rolling-recorder
 * output) into one playable file. Re-encodes rather than `-c copy`: the
 * windows come from independent MediaRecorder starts, so their container
 * timestamps all begin at zero and a copy-concat would overlap them. One
 * 16 kHz mono re-encode also erases any per-window codec-parameter drift.
 * The result is the finalize FALLBACK artifact (small boundary seams are
 * accepted); the lossless single upload remains the primary path.
 */
export async function concatAudioWindows(
  windows: Buffer[],
  ext = 'webm',
): Promise<{ buffer: Buffer; mime: string }> {
  if (windows.length === 0) throw new Error('no audio windows to assemble')
  const dir = await mkdtemp(join(tmpdir(), 'live-assemble-'))
  try {
    const listPath = join(dir, 'windows.txt')
    const lines: string[] = []
    for (let i = 0; i < windows.length; i += 1) {
      const path = join(dir, `w-${String(i).padStart(5, '0')}.${ext}`)
      await writeFile(path, windows[i])
      // concat-demuxer entries; paths are ours (uuid tmpdir), never user input.
      lines.push(`file '${path.replaceAll("'", String.raw`'\''`)}'`)
    }
    await writeFile(listPath, lines.join('\n'))
    const outPath = join(dir, 'assembled.m4a')
    try {
      await execFileAsync('ffmpeg', [
        '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
        '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '48k',
        '-movflags', '+faststart', '-f', 'mp4', outPath,
      ], { timeout: 900_000, maxBuffer: 1 << 20 })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`ffmpeg prerequisite failed: ${message}`)
    }
    const buffer = await readFile(outPath)
    if (buffer.length === 0) throw new Error('ffmpeg produced an empty assembled track')
    return { buffer, mime: 'audio/mp4' }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
