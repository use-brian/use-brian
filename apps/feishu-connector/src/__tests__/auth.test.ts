import { describe, expect, it } from 'vitest'
import { connectorSecretMatches } from '../auth.js'

describe('[COMP:app/feishu-connector] connector auth', () => {
  it('accepts the exact shared secret', () => {
    expect(connectorSecretMatches('secret', 'secret')).toBe(true)
  })

  it('rejects absent, empty, wrong, and different-length values', () => {
    expect(connectorSecretMatches(undefined, 'secret')).toBe(false)
    expect(connectorSecretMatches('secret', '')).toBe(false)
    expect(connectorSecretMatches('wrong!', 'secret')).toBe(false)
    expect(connectorSecretMatches('x', 'secret')).toBe(false)
  })
})
