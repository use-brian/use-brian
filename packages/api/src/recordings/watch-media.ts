import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WatchError } from './watch-store.js'
const exec = promisify(execFile)

/** Forced MOV/MP4 demuxer: a mislabeled playlist must not make ffprobe fetch URLs. */
export async function validateWatchAudio(audio: Buffer, durationMs: number | null, maximumMs = 60000) {
  const dir = await mkdtemp(join(tmpdir(), 'watch-probe-'))
  try {
    const path = join(dir, 'window.m4a')
    await writeFile(path, audio)
    let actual: number
    try {
      const { stdout } = await exec('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-f', 'mov', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path], { timeout: 60000, maxBuffer: 1 << 20 })
      actual = Math.round(Number.parseFloat(stdout) * 1000)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new WatchError(503, 'audio_probe_unavailable')
      throw new WatchError(422, 'invalid_audio')
    }
    if (!Number.isFinite(actual) || actual <= 0 || actual > maximumMs + 1000 || (durationMs !== null && Math.abs(actual - durationMs) > 1000)) throw new WatchError(422, 'audio_duration_mismatch')
  } finally { await rm(dir, { recursive: true, force: true }) }
}
