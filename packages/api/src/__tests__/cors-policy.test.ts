import { describe, expect, it } from 'vitest'

import { isOpaqueDesktopBearerRequest } from '../cors-policy.js'

describe('[COMP:api/cors-policy] bundled desktop opaque-origin admission', () => {
  it('admits actual bearer requests from the file renderer', () => {
    expect(isOpaqueDesktopBearerRequest({
      path: '/api/assistants',
      authorization: 'Bearer desktop-token',
    })).toBe(true)
  })

  it('admits bearer preflights case-insensitively', () => {
    expect(isOpaqueDesktopBearerRequest({
      path: '/api/chat',
      requestedHeaders: 'content-type, Authorization, x-client-timezone',
    })).toBe(true)
  })

  it('admits refresh while rejecting cookie-only opaque requests', () => {
    expect(isOpaqueDesktopBearerRequest({ path: '/auth/refresh' })).toBe(true)
    expect(isOpaqueDesktopBearerRequest({ path: '/api/assistants' })).toBe(false)
    expect(isOpaqueDesktopBearerRequest({
      path: '/api/assistants',
      authorization: 'Bearer ',
    })).toBe(false)
  })
})
