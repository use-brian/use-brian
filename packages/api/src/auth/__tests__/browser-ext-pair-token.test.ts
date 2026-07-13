import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  signBrowserExtPairToken,
  signBrowserExtSessionToken,
  verifyBrowserExtHelloToken,
  verifyBrowserExtPairToken,
  verifyBrowserExtSessionToken,
} from '../browser-ext-pair-token.js'

const SECRET = 's3cret'

afterEach(() => {
  vi.useRealTimers()
})

describe('[COMP:sandbox/browser-tools] Browser-extension pairing tokens (P1.3)', () => {
  it('round-trips a pairing token bound to {userId, workspaceId}', () => {
    const token = signBrowserExtPairToken({ userId: 'user-1', workspaceId: 'ws-1' }, SECRET)
    expect(verifyBrowserExtPairToken(token, SECRET)).toMatchObject({
      kind: 'browser-ext-pair',
      userId: 'user-1',
      workspaceId: 'ws-1',
    })
  })

  it('rejects a tampered token and a wrong secret', () => {
    const token = signBrowserExtPairToken({ userId: 'user-1', workspaceId: 'ws-1' }, SECRET)
    const [h, b, s] = token.split('.')
    const forgedBody = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(b, 'base64url').toString()), userId: 'attacker' }),
    ).toString('base64url')
    expect(verifyBrowserExtPairToken(`${h}.${forgedBody}.${s}`, SECRET)).toBeNull()
    expect(verifyBrowserExtPairToken(token, 'other')).toBeNull()
    expect(verifyBrowserExtPairToken('junk', SECRET)).toBeNull()
  })

  it('expires: a pair token dies after 10 minutes, a session token survives weeks', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-10T00:00:00Z'))
    const pair = signBrowserExtPairToken({ userId: 'u', workspaceId: 'w' }, SECRET)
    const session = signBrowserExtSessionToken({ userId: 'u', workspaceId: 'w' }, SECRET)

    vi.setSystemTime(new Date('2026-07-10T00:11:00Z'))
    expect(verifyBrowserExtPairToken(pair, SECRET)).toBeNull()
    expect(verifyBrowserExtSessionToken(session, SECRET)).not.toBeNull()
    expect(verifyBrowserExtHelloToken(session, SECRET)?.kind).toBe('browser-ext-session')

    vi.setSystemTime(new Date('2026-08-15T00:00:00Z'))
    expect(verifyBrowserExtSessionToken(session, SECRET)).toBeNull()
  })

  it('never accepts an access/refresh-shaped token (kind claim is load-bearing)', () => {
    // A token with no kind claim (like jwt.ts access tokens) must not pair.
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const body = Buffer.from(
      JSON.stringify({ sub: 'user-1', type: 'access', exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString('base64url')
    const { createHmac } = require('node:crypto') as typeof import('node:crypto')
    const sig = createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url')
    expect(verifyBrowserExtHelloToken(`${header}.${body}.${sig}`, SECRET)).toBeNull()
  })
})
