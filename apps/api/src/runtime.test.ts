import { describe, expect, it } from 'vitest'
import { resolveApiJwtSecret, shouldRunApiWorkers } from './runtime.js'

describe('[COMP:app/open-api] deployment runtime', () => {
  it('requires a persistent JWT secret for Outpost only', () => {
    expect(resolveApiJwtSecret('outpost', 'configured', 'ephemeral')).toBe('configured')
    expect(() => resolveApiJwtSecret('outpost', undefined, 'ephemeral')).toThrow(/JWT_SECRET/)
    expect(resolveApiJwtSecret('oss', undefined, 'ephemeral')).toBe('ephemeral')
  })

  it('supports separate HTTP and worker processes', () => {
    expect(shouldRunApiWorkers(['node', 'dist/index.js'])).toBe(true)
    expect(shouldRunApiWorkers(['node', 'dist/index.js', '--no-workers'])).toBe(false)
  })
})
