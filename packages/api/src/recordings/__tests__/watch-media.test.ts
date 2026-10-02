import { describe, expect, it, vi } from 'vitest'
const run = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFile: (file: string, args: string[], options: unknown, callback: (error: unknown, result?: { stdout: string }) => void) => {
  try { callback(null, { stdout: run(file, args, options) }) } catch (error) { callback(error) }
} }))
import { validateWatchAudio } from '../watch-media.js'
describe('watch media validation', () => {
  it('forces local MP4 demuxing and checks actual media duration', async () => {
    run.mockReturnValue('1.0')
    await validateWatchAudio(Buffer.from('test fixture'), 1000)
    expect(run.mock.calls.at(-1)?.[1]).toEqual(expect.arrayContaining(['-protocol_whitelist', 'file,pipe', '-f', 'mov']))
    run.mockReturnValue('90')
    await expect(validateWatchAudio(Buffer.from('test'), 1000)).rejects.toMatchObject({ status: 422 })
    run.mockReturnValue('NaN')
    await expect(validateWatchAudio(Buffer.from('test'), 1000)).rejects.toMatchObject({ status: 422 })
  })
  it('missing deployment prerequisite is retryable, bad media is not', async () => {
    run.mockImplementation(() => { throw Object.assign(new Error('missing ffprobe'), { code: 'ENOENT' }) })
    await expect(validateWatchAudio(Buffer.from('test'), 1000)).rejects.toMatchObject({ status: 503 })
    run.mockImplementation(() => { throw new Error('malformed') })
    await expect(validateWatchAudio(Buffer.from('test'), 1000)).rejects.toMatchObject({ status: 422 })
  })
})
