/**
 * The popup's status line is a pure function of the background's `status`
 * reply, so the wording is testable without a DOM (this package runs vitest in
 * the node environment).
 */
import { describe, it, expect } from 'vitest'
import { statusLine } from '../popup-status.js'

describe('[COMP:ext/agent] Popup status line', () => {
  it('reports a stopped task even while the socket is healthy', () => {
    // The popup rendered the SOCKET state only, so a gate holding a Stop still
    // read "Connected. The assistant can request browser tasks." while every
    // browse failed. The user is told the product works and watches it refuse.
    const line = statusLine({ state: 'ready', stopped: true })
    expect(line).not.toContain('Connected.')
    expect(line.toLowerCase()).toContain('stopped')
    // It must say how to get going again — the recovery is "ask me again",
    // not "reload the extension".
    expect(line.toLowerCase()).toContain('permission')
  })

  it('reports a taken-over pairing as a dead end with a way back', () => {
    const line = statusLine({ state: 'replaced' })
    expect(line.toLowerCase()).toContain('another browser')
    expect(line).toContain('Connect')
  })

  it('reports the normal connected state, and the controlled tab when there is one', () => {
    expect(statusLine({ state: 'ready' })).toContain('Connected.')
    expect(statusLine({ state: 'ready', controlledTab: 12 })).toContain('Controlling one allowed tab.')
    // A stopped gate outranks the tab note: there is nothing being controlled.
    expect(statusLine({ state: 'ready', controlledTab: 12, stopped: true })).not.toContain(
      'Controlling one allowed tab.',
    )
  })

  it('falls back to the raw state rather than rendering nothing', () => {
    expect(statusLine({ state: 'some-future-state' })).toContain('some-future-state')
    expect(statusLine({})).toContain('Not paired')
  })
})
