import { describe, expect, it } from 'vitest'
import { normalizedRetry } from './route'

describe('[COMP:app/outpost-auth] refresh retry bounds', () => {
  it('clamps negative, invalid, and oversized counters', () => {
    expect(normalizedRetry('-2147483648')).toBe(0)
    expect(normalizedRetry('invalid')).toBe(0)
    expect(normalizedRetry('999')).toBe(4)
  })
})
