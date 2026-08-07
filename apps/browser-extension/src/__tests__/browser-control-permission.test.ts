import { describe, it, expect } from 'vitest'
import { BROWSER_CONTROL_PERMISSIONS, hasBrowserControl } from '../browser-control-permission.js'

/**
 * An unreadable required-permission state must not claim browser control is
 * available and then surface an unrelated raw Chrome error on the first task.
 */
describe('[COMP:ext/browser-control-permission] Required debugger permission', () => {
  it('checks exactly the browser-control permission', () => {
    expect([...BROWSER_CONTROL_PERMISSIONS]).toEqual(['debugger'])
  })

  it('reports a granted permission', async () => {
    const granted = await hasBrowserControl({ contains: async () => true })
    expect(granted).toBe(true)
  })

  it('reports a missing permission', async () => {
    const granted = await hasBrowserControl({ contains: async () => false })
    expect(granted).toBe(false)
  })

  it('treats an unreadable permission state as NOT granted', async () => {
    const granted = await hasBrowserControl({
      contains: async () => {
        throw new Error('no permissions API')
      },
    })
    expect(granted).toBe(false)
  })
})
