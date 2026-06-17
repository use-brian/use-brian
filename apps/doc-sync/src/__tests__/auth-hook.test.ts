import { describe, it, expect } from 'vitest'
import { resolveAuth } from '../auth-hook.js'

describe('[COMP:doc-sync/auth] resolveAuth', () => {
  const jwtSecret = 'secret'

  it('rejects a missing or blank token', () => {
    expect(resolveAuth({ token: undefined, jwtSecret }).kind).toBe('reject')
    expect(resolveAuth({ token: '   ', jwtSecret }).kind).toBe('reject')
  })

  it('accepts the shared sync secret as a service connection', () => {
    expect(
      resolveAuth({ token: 'svc-xyz', jwtSecret, syncSecret: 'svc-xyz' }),
    ).toEqual({ kind: 'service' })
  })

  it('prefers the service secret over JWT verification', () => {
    const r = resolveAuth({
      token: 'svc',
      jwtSecret,
      syncSecret: 'svc',
      verify: () => 'should-not-be-used',
    })
    expect(r).toEqual({ kind: 'service' })
  })

  it('resolves a valid token to its userId via the injected verifier', () => {
    const r = resolveAuth({
      token: 'good',
      jwtSecret,
      verify: (t) => (t === 'good' ? 'user-1' : null),
    })
    expect(r).toEqual({ kind: 'user', userId: 'user-1' })
  })

  it('rejects an invalid token', () => {
    expect(resolveAuth({ token: 'bad', jwtSecret, verify: () => null })).toEqual({
      kind: 'reject',
      reason: 'invalid_token',
    })
  })
})
