import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
describe('watch boot registration regression', () => {
  it('mounts an opt-in device router before broad human guards and wires the real transcription provider', () => {
    const boot = readFileSync(new URL('../../boot.ts', import.meta.url), 'utf8')
    const mount = boot.indexOf("app.use('/api/watch/v1'")
    expect(mount).toBeGreaterThan(0)
    expect(mount).toBeLessThan(boot.indexOf("app.use('/api', requireAuth(env.JWT_SECRET)"))
    const section = boot.slice(mount - 220, mount + 700)
    expect(section).toContain("process.env.WATCH_RECORDING_ENABLED === 'true'")
    expect(section).toContain("if (process.env.WATCH_RECORDING_ENABLED === 'true' && filesApi && filesResolver)")
    expect(section).toContain('humanAuth: requireAuth(env.JWT_SECRET)')
    expect(section).toContain('authorize: authorizeWatchDestination')
    expect(section).toContain('createWatchService({ pages: savedViewStore, files: filesApi')
    expect(section).toContain('voiceTranscription.enabled')
    expect(section).toContain('transcribeWatchAudio(')
    expect(section).toContain('voiceTranscription.apiKey')
    expect(section).toContain('provisioningKey: env.JWT_SECRET')
    expect(boot).toContain('stopWatchCleanup = startWatchCleanup()')
    expect(boot).toContain('await stopWatchCleanup?.()')
  })
})
