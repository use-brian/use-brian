import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { resolveApiJwtSecret, shouldRunApiWorkers, isAdministrativeTestMode } from './runtime.js'

describe('[COMP:app/open-api] deployment runtime', () => {
  it.each([undefined, '127.0.0.1', '::1'])('passes optional API_HOST %s to the listener without starting services', (host) => {
    const entry = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
    const boot = readFileSync(new URL('../../../packages/api/src/boot.ts', import.meta.url), 'utf8')
    const forwarding = entry.match(/API_HOST: ([^,\n]+),/)
    const listener = boot.match(/server = app\.listen\((\{[^}]+\}),/)
    expect(forwarding).not.toBeNull()
    expect(listener).not.toBeNull()
    const API_HOST = runInNewContext(forwarding![1]!, { process: { env: { API_HOST: host } } })
    const options = runInNewContext(`(${listener![1]})`, { port: 4000, env: { API_HOST } })
    expect(options).toEqual({ port: 4000, host })
  })

  it('requires a persistent JWT secret for Outpost only', () => {
    expect(resolveApiJwtSecret('outpost', 'configured', 'ephemeral')).toBe('configured')
    expect(() => resolveApiJwtSecret('outpost', undefined, 'ephemeral')).toThrow(/JWT_SECRET/)
    expect(resolveApiJwtSecret('oss', undefined, 'ephemeral')).toBe('ephemeral')
  })

  it('recognizes only the explicit administrative fixture argument', () => {
    expect(isAdministrativeTestMode(['node', 'index.js'])).toBe(false)
    expect(isAdministrativeTestMode(['node', 'index.js', '--no-workers'])).toBe(false)
    expect(isAdministrativeTestMode(['node', 'index.js', '--admin-only'])).toBe(true)
  })

  it('supports separate HTTP and worker processes', () => {
    expect(shouldRunApiWorkers(['node', 'dist/index.js'])).toBe(true)
    expect(shouldRunApiWorkers(['node', 'dist/index.js', '--no-workers'])).toBe(false)
    expect(shouldRunApiWorkers(['node', 'dist/index.js', '--admin-only'])).toBe(false)
  })
})
