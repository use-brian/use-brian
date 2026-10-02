import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { validateWatchAudio } from '../watch-media.js'
import { concatAudioWindows, probeRecordingDuration } from '../ffmpeg.js'
const exec = promisify(execFile)
// CI/deployment media lane MUST set WATCH_MEDIA_TEST=1; absence is a skip, not a media pass.
describe.skipIf(process.env.WATCH_MEDIA_TEST !== '1')('real AAC/M4A watch fixtures', () => {
  let dir: string, first: Buffer, second: Buffer
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'watch-real-fixtures-'))
    for (const [name, frequency] of [['first', '440'], ['second', '880']]) {
      await exec('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=16000:duration=1`, '-c:a', 'aac', '-b:a', '48k', '-movflags', '+faststart', join(dir, `${name}.m4a`)])
    }
    first = await readFile(join(dir, 'first.m4a')); second = await readFile(join(dir, 'second.m4a'))
  }, 60000)
  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })
  it('validates independently decodable M4A windows and rejects bad duration/data', async () => {
    await validateWatchAudio(first, 1000)
    await validateWatchAudio(second, 1000)
    await expect(validateWatchAudio(first, 10000)).rejects.toMatchObject({ status: 422 })
    await expect(validateWatchAudio(Buffer.from('not audio'), 1000)).rejects.toMatchObject({ status: 422 })
    await expect(validateWatchAudio(Buffer.from('#EXTM3U\nhttps://example.invalid/audio\n'), 1000)).rejects.toMatchObject({ status: 422 })
  })
  it('assembles ordered windows into one playable MP4 without losing either tone', async () => {
    const assembled = await concatAudioWindows([first, second], 'm4a')
    await validateWatchAudio(assembled.buffer, null, 180 * 60000)
    expect(assembled.mime).toBe('audio/mp4')
    const path = join(dir, 'assembled.m4a'); await writeFile(path, assembled.buffer)
    const duration = await probeRecordingDuration(path)
    expect(duration).toBeGreaterThanOrEqual(1900); expect(duration).toBeLessThan(2300)
    const { stdout } = await exec('ffmpeg', ['-v', 'error', '-i', path, '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1'], { encoding: 'buffer' })
    function crossings(startSeconds: number) {
      let count = 0
      const start = Math.floor(startSeconds * 16000)
      for (let i = start + 1; i < start + 8000; i++) {
        if (stdout.readInt16LE((i - 1) * 2) < 0 && stdout.readInt16LE(i * 2) >= 0) count++
      }
      return count
    }
    // Frequency order proves concat used capture order, not receipt order.
    expect(crossings(0.2)).toBeGreaterThan(200); expect(crossings(0.2)).toBeLessThan(240)
    expect(crossings(1.3)).toBeGreaterThan(400); expect(crossings(1.3)).toBeLessThan(480)
  }, 60000)
})
