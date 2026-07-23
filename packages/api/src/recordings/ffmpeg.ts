// Part of [COMP:recordings/open-process-recording] - policy-free ffprobe/ffmpeg helpers.

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'
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
