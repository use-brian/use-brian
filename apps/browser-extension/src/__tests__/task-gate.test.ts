import { describe, it, expect } from 'vitest'
import { TaskGate, CONSENT_IDLE_RESET_MS } from '../task-gate.js'

describe('[COMP:ext/agent] Per-task consent gate (P1.7)', () => {
  it('prompts once, then reuses consent within the idle window', async () => {
    let prompts = 0
    let now = 1_000_000
    const gate = new TaskGate({
      prompt: async () => {
        prompts += 1
        return { allowed: true, tabId: 7 }
      },
      now: () => now,
    })
    expect(await gate.requireTab()).toBe(7)
    now += 60_000
    expect(await gate.requireTab()).toBe(7)
    expect(prompts).toBe(1)
  })

  it('re-prompts after the consent idle window expires', async () => {
    let prompts = 0
    let now = 1_000_000
    const gate = new TaskGate({
      prompt: async () => {
        prompts += 1
        return { allowed: true, tabId: 7 }
      },
      now: () => now,
    })
    await gate.requireTab()
    now += CONSENT_IDLE_RESET_MS + 1
    await gate.requireTab()
    expect(prompts).toBe(2)
  })

  it('throws consent_denied when the user denies', async () => {
    const gate = new TaskGate({ prompt: async () => ({ allowed: false, tabId: null }) })
    const err = await gate.requireTab().catch((e: unknown) => e)
    expect((err as { code?: string }).code).toBe('consent_denied')
  })

  it('shares one prompt across concurrent commands', async () => {
    let prompts = 0
    let release: (() => void) | null = null
    const gate = new TaskGate({
      prompt: () =>
        new Promise((resolve) => {
          prompts += 1
          release = () => resolve({ allowed: true, tabId: 3 })
        }),
    })
    const a = gate.requireTab()
    const b = gate.requireTab()
    release?.()
    expect(await a).toBe(3)
    expect(await b).toBe(3)
    expect(prompts).toBe(1)
  })

  it('Stop latches until a new consent is granted (persistent Stop wins)', async () => {
    const gate = new TaskGate({ prompt: async () => ({ allowed: true, tabId: 5 }) })
    await gate.requireTab()
    gate.stop()
    const err = await gate.requireTab().catch((e: unknown) => e)
    expect((err as { code?: string }).code).toBe('stopped')
    expect(gate.currentTab()).toBeNull()
  })

  it('re-asks after consent is revoked, without latching like Stop', async () => {
    // Chrome's "is debugging this browser" banner has its own Cancel. When the
    // user hits it we must not silently re-attach (that fights an explicit
    // refusal) and must not latch Stop either (there is no resume path, so the
    // browser would be dead for the session over one stray click). Asking
    // again through our own Allow window is the recoverable middle.
    let prompts = 0
    const gate = new TaskGate({
      prompt: async () => {
        prompts += 1
        return { allowed: true, tabId: 5 }
      },
    })
    await gate.requireTab()
    gate.revokeConsent()
    expect(gate.currentTab()).toBeNull()
    expect(gate.isStopped()).toBe(false)

    expect(await gate.requireTab()).toBe(5)
    expect(prompts).toBe(2)
  })

  it('clears the controlled tab when it closes', async () => {
    const gate = new TaskGate({ prompt: async () => ({ allowed: true, tabId: 5 }) })
    await gate.requireTab()
    expect(gate.onTabRemoved(4)).toBe(false)
    expect(gate.onTabRemoved(5)).toBe(true)
    expect(gate.currentTab()).toBeNull()
  })
})
