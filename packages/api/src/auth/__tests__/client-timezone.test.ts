import { describe, it, expect, vi } from 'vitest'
import type { Request, Response, NextFunction } from 'express'
import { attachClientTimezone, resolvePresenceTimezone } from '../client-timezone.js'

function mockReq(headers: Record<string, string | undefined>): Request {
  return { headers } as unknown as Request
}

describe('[COMP:api/client-timezone] attachClientTimezone', () => {
  it('attaches a valid IANA zone from the X-Client-Timezone header', () => {
    const req = mockReq({ 'x-client-timezone': 'Asia/Hong_Kong' })
    const next = vi.fn()
    attachClientTimezone()(req, {} as Response, next as unknown as NextFunction)
    expect(req.clientTimezone).toBe('Asia/Hong_Kong')
    expect(next).toHaveBeenCalledOnce()
  })

  it('trims surrounding whitespace', () => {
    const req = mockReq({ 'x-client-timezone': '  Europe/Berlin  ' })
    const next = vi.fn()
    attachClientTimezone()(req, {} as Response, next as unknown as NextFunction)
    expect(req.clientTimezone).toBe('Europe/Berlin')
  })

  it('drops an unknown zone without setting the field', () => {
    const req = mockReq({ 'x-client-timezone': 'Mars/Olympus_Mons' })
    const next = vi.fn()
    attachClientTimezone()(req, {} as Response, next as unknown as NextFunction)
    expect(req.clientTimezone).toBeUndefined()
    expect(next).toHaveBeenCalledOnce()
  })

  it('drops an overly long header value to avoid abuse', () => {
    const req = mockReq({ 'x-client-timezone': 'X'.repeat(200) })
    const next = vi.fn()
    attachClientTimezone()(req, {} as Response, next as unknown as NextFunction)
    expect(req.clientTimezone).toBeUndefined()
  })

  it('is a no-op when the header is missing', () => {
    const req = mockReq({})
    const next = vi.fn()
    attachClientTimezone()(req, {} as Response, next as unknown as NextFunction)
    expect(req.clientTimezone).toBeUndefined()
    expect(next).toHaveBeenCalledOnce()
  })

  it('never calls res.status — the middleware must not reject', () => {
    const req = mockReq({ 'x-client-timezone': 'Not/A_Zone' })
    const status = vi.fn()
    const res = { status } as unknown as Response
    const next = vi.fn()
    attachClientTimezone()(req, res, next as unknown as NextFunction)
    expect(status).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledOnce()
  })
})

describe('[COMP:api/client-timezone] resolvePresenceTimezone', () => {
  // Anchored to a fixed instant so freshness windows are deterministic.
  const NOW = new Date('2026-04-27T17:40:00Z').getTime()
  const now = () => NOW

  it('prefers a valid live header over every other signal', () => {
    const out = resolvePresenceTimezone({
      liveClientTz: 'Asia/Tokyo',
      lastSeenTz: 'America/New_York',
      lastSeenTzAt: new Date(NOW - 1000),
      anchorTimezone: 'Asia/Hong_Kong',
      now,
    })
    expect(out).toBe('Asia/Tokyo')
  })

  it('ignores a malformed live header and falls through', () => {
    const out = resolvePresenceTimezone({
      liveClientTz: 'Mars/Olympus_Mons',
      anchorTimezone: 'Asia/Hong_Kong',
      now,
    })
    expect(out).toBe('Asia/Hong_Kong')
  })

  it('treats UTC live header as no-signal (browser default)', () => {
    // Some browsers and older clients report the literal 'UTC' even when
    // the user is anywhere — we treat that as missing rather than letting
    // it overwrite a more informative stored zone.
    const out = resolvePresenceTimezone({
      liveClientTz: 'UTC',
      lastSeenTz: 'Asia/Tokyo',
      lastSeenTzAt: new Date(NOW - 60_000),
      anchorTimezone: 'Asia/Hong_Kong',
      now,
    })
    expect(out).toBe('Asia/Tokyo')
  })

  it('uses fresh stored last_seen_tz when no live header is present', () => {
    const out = resolvePresenceTimezone({
      lastSeenTz: 'Asia/Tokyo',
      lastSeenTzAt: new Date(NOW - 60 * 60 * 1000), // 1h ago
      anchorTimezone: 'Asia/Hong_Kong',
      now,
    })
    expect(out).toBe('Asia/Tokyo')
  })

  it('falls back to anchor when stored observation is past the freshness window', () => {
    const out = resolvePresenceTimezone({
      lastSeenTz: 'Asia/Tokyo',
      lastSeenTzAt: new Date(NOW - 25 * 60 * 60 * 1000), // 25h ago
      anchorTimezone: 'Asia/Hong_Kong',
      now,
    })
    expect(out).toBe('Asia/Hong_Kong')
  })

  it('falls back to anchor when no signals are present', () => {
    expect(resolvePresenceTimezone({ anchorTimezone: 'Europe/Berlin', now })).toBe('Europe/Berlin')
  })

  it('returns UTC when even the anchor is missing', () => {
    expect(resolvePresenceTimezone({ now })).toBe('UTC')
  })

  it('ignores stored last_seen_tz when its timestamp is missing', () => {
    const out = resolvePresenceTimezone({
      lastSeenTz: 'Asia/Tokyo',
      lastSeenTzAt: null,
      anchorTimezone: 'Asia/Hong_Kong',
      now,
    })
    expect(out).toBe('Asia/Hong_Kong')
  })
})
