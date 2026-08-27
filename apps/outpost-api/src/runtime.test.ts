import { describe, expect, it } from 'vitest'
import { assertOutpostRuntime } from './runtime.js'

describe('[COMP:app/outpost-api] runtime admission', () => {
  it('accepts only a configured Outpost process', () => {
    expect(assertOutpostRuntime({ USEBRIAN_EDITION: 'outpost', JWT_SECRET: 'secret' })).toBe('secret')
    expect(() => assertOutpostRuntime({ USEBRIAN_EDITION: 'oss', JWT_SECRET: 'secret' })).toThrow(/USEBRIAN_EDITION=outpost/)
    expect(() => assertOutpostRuntime({ USEBRIAN_EDITION: 'outpost' })).toThrow(/JWT_SECRET/)
  })
})
