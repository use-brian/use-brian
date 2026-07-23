import { describe, it, expect, vi } from 'vitest'
import {
  BROWSER_CONTROL_PERMISSIONS,
  hasBrowserControl,
  requestBrowserControl,
} from '../browser-control-permission.js'

/**
 * The grant check has to fail SAFE in both directions, and the two directions
 * are opposites: an unreadable state must not claim the user granted control
 * (we would then drive a browser we have no permission for and surface a raw
 * Chrome error), and a failed ask must not be mistaken for a grant.
 */
describe('[COMP:ext/browser-control-permission] Optional debugger permission', () => {
  it('asks Chrome for exactly the debugger permission, nothing bundled', async () => {
    const request = vi.fn(async () => true)
    await requestBrowserControl({ contains: async () => false, request })
    expect(request).toHaveBeenCalledWith({ permissions: ['debugger'] })
    expect([...BROWSER_CONTROL_PERMISSIONS]).toEqual(['debugger'])
  })

  it('reports a granted permission', async () => {
    const granted = await hasBrowserControl({ contains: async () => true, request: async () => true })
    expect(granted).toBe(true)
  })

  it('reports a missing permission', async () => {
    const granted = await hasBrowserControl({ contains: async () => false, request: async () => true })
    expect(granted).toBe(false)
  })

  it('treats an unreadable permission state as NOT granted', async () => {
    const granted = await hasBrowserControl({
      contains: async () => {
        throw new Error('no permissions API')
      },
      request: async () => true,
    })
    expect(granted).toBe(false)
  })

  it('treats a throwing request (no user gesture) as a refusal, never a grant', async () => {
    const ok = await requestBrowserControl({
      contains: async () => false,
      request: async () => {
        throw new Error('This function must be called during a user gesture')
      },
    })
    expect(ok).toBe(false)
  })

  it('passes the user’s refusal straight through', async () => {
    const ok = await requestBrowserControl({ contains: async () => false, request: async () => false })
    expect(ok).toBe(false)
  })
})
