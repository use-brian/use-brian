/**
 * The popup's status line is a pure function of the background's `status`
 * reply, so the wording is testable without a DOM (this package runs vitest in
 * the node environment).
 */
import { describe, it, expect } from 'vitest'
import { buildLine, buildWarning, statusLine } from '../popup-status.js'

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

  it('outranks a healthy socket when browser control has not been granted', () => {
    // The exact lie this status line exists to stop telling: the relay is up so
    // the socket reads "Connected", while every task refuses.
    const line = statusLine({ state: 'ready', hasControl: false })
    expect(line).not.toContain('Connected.')
    expect(line.toLowerCase()).toContain('not allowed to manage this browser')
    // It outranks the stopped label too — a grant the user never gave is the
    // thing they have to fix first.
    expect(statusLine({ state: 'ready', stopped: true, hasControl: false })).toBe(line)
  })

  it('treats an older background with no hasControl field as granted', () => {
    // The field is absent when the popup is newer than the service worker
    // mid-upgrade. Inventing a permission warning there would send the user
    // hunting for a button to grant something they already have.
    expect(statusLine({ state: 'ready' })).toContain('Connected.')
    expect(statusLine({ state: 'ready', hasControl: true })).toContain('Connected.')
  })

  it('falls back to the raw state rather than rendering nothing', () => {
    expect(statusLine({ state: 'some-future-state' })).toContain('some-future-state')
    expect(statusLine({})).toContain('Not paired')
  })
})

/**
 * Which build is loaded, shown before anyone has to ask.
 *
 * Establishing this during the 2026-08-03 incident required taking a SHA256 of
 * the folder path Chrome derives unpacked extension ids from. The install was
 * eleven days stale, from a folder orphaned by the open-core cutover, and
 * nothing on any surface said so.
 */
describe('[COMP:ext/agent] Popup build status', () => {
  it('warns only when the relay actually said the build is stale', () => {
    expect(buildWarning({ staleBuild: true })).toMatch(/out of date/i)
    expect(buildWarning({ staleBuild: false })).toBeNull()
    // Undefined is an older background, not a verdict. Accusing an install of
    // being stale on no evidence is the mirror of the bug being fixed.
    expect(buildWarning({})).toBeNull()
  })

  it('keeps staleness beside the status line, never instead of it', () => {
    // A stale extension is genuinely connected: both statements are true, and
    // collapsing them would force a choice between two facts the user needs.
    const status = { state: 'ready', staleBuild: true }
    expect(statusLine(status)).toContain('Connected.')
    expect(buildWarning(status)).not.toBeNull()
  })

  it('ranks a missing grant above staleness', () => {
    // Staleness only might block work; a missing grant blocks it outright.
    expect(statusLine({ state: 'ready', hasControl: false, staleBuild: true })).toMatch(
      /Not allowed to manage/,
    )
  })

  it('names the build, and says so plainly when there is none', () => {
    expect(buildLine({ build: 'f0c49f289acc' })).toBe('Build f0c49f289acc')
    expect(buildLine({ build: null })).toMatch(/predates build stamping/i)
    expect(buildLine({})).toMatch(/predates build stamping/i)
  })
})
