import { describe, it, expect } from 'vitest'
import {
  TaskGate,
  CONSENT_IDLE_RESET_MS,
  MAX_TASK_CREATED_TABS,
} from '../task-gate.js'

describe('[COMP:ext/agent] Per-task consent gate (P1.7)', () => {
  it('allows the prompt layer to use pre-approval for a normal task', async () => {
    const gate = new TaskGate({
      prompt: async ({ allowPreApproval }) => ({
        allowed: true,
        tabId: allowPreApproval ? 7 : 8,
      }),
    })

    expect(await gate.requireTab()).toBe(7)
  })

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
    const gate = new TaskGate({ prompt: async () => ({ allowed: false, reason: 'denied' }) })
    const err = await gate.requireTab().catch((e: unknown) => e)
    expect((err as { code?: string }).code).toBe('consent_denied')
  })

  it('an unattachable page is no_eligible_tab, NOT a refusal', async () => {
    // The user never saw a prompt, so calling it a decline is a lie the
    // assistant then repeats back to them ("you declined"). It also sends the
    // model down the wrong recovery path: a refusal means stop asking, while
    // an ineligible tab means ask them to switch to a real page.
    const gate = new TaskGate({
      prompt: async () => ({ allowed: false, reason: 'restricted_url' }),
    })
    const err = await gate.requireTab().catch((e: unknown) => e)
    expect((err as { code?: string }).code).toBe('no_eligible_tab')
    expect((err as Error).message).not.toMatch(/declin/i)
  })

  it('no open tab is also no_eligible_tab', async () => {
    const gate = new TaskGate({
      prompt: async () => ({ allowed: false, reason: 'no_active_tab' }),
    })
    const err = await gate.requireTab().catch((e: unknown) => e)
    expect((err as { code?: string }).code).toBe('no_eligible_tab')
  })

  it('an ineligible tab never releases a latched Stop', async () => {
    // Only a human Allow releases Stop. A structural failure must not, or the
    // kill switch would come undone by accident.
    const gate = new TaskGate({
      prompt: async () => ({ allowed: false, reason: 'restricted_url' }),
    })
    gate.stop()
    await gate.requireTab().catch(() => undefined)
    expect(gate.isStopped()).toBe(true)
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

  it('does not let a pre-disconnect Allow release a newer Stop', async () => {
    let allow: (() => void) | null = null
    const gate = new TaskGate({
      prompt: () => new Promise((resolve) => {
        allow = () => resolve({ allowed: true, tabId: 3 })
      }),
    })
    const beforeDisconnect = gate.requireTab()
    gate.stop()
    const afterDisconnect = gate.requireTab()
    allow?.()

    await expect(beforeDisconnect).rejects.toMatchObject({ code: 'stopped' })
    await expect(afterDisconnect).rejects.toMatchObject({ code: 'stopped' })
    expect(gate.isStopped()).toBe(true)
    expect(gate.currentTab()).toBeNull()
  })

  it('Stop drops live consent, so the next command cannot ride the idle window', async () => {
    // Previously this asserted `code === 'stopped'` with an ALLOWING prompter
    // — i.e. it asserted that granting consent does NOT release Stop, which
    // contradicts both this test's own name and `stop()`'s contract. That
    // assertion is what kept the unreachable-release bug green.
    let prompts = 0
    let now = 1_000_000
    const gate = new TaskGate({
      prompt: async () => {
        prompts += 1
        return { allowed: true, tabId: 5 }
      },
      now: () => now,
    })
    await gate.requireTab()
    gate.stop()
    expect(gate.currentTab()).toBeNull()

    // Well inside CONSENT_IDLE_RESET_MS, so without Stop this would silently
    // reuse consent. It must not: the model may never walk through a Stop.
    now += 1_000
    await gate.requireTab()
    expect(prompts).toBe(2)
  })

  it('a fresh Allow RELEASES Stop — the user resumes without reloading the extension', async () => {
    // The symptom: after one click of Stop in the popup, every later browse
    // fails `stopped` forever and the only escape is reloading the extension
    // (a new service worker builds a new gate). 9 such failures in prod on
    // 2026-07-22 alone.
    //
    // The latch is meant to release — `requireTab` already clears `stopped`
    // once consent is granted, and `stop()` is documented as latching "until
    // the user allows a new task". But the guard at the top of `requireTab`
    // throws BEFORE the prompt is ever shown, so that release is dead code
    // and "allows a new task" is unreachable. This asserts the documented
    // behaviour, not a new design.
    let prompts = 0
    const gate = new TaskGate({
      prompt: async () => {
        prompts += 1
        return { allowed: true, tabId: 5 }
      },
    })
    await gate.requireTab()
    expect(prompts).toBe(1)

    gate.stop()
    expect(gate.isStopped()).toBe(true)

    // The user comes back and allows the tab again.
    expect(await gate.requireTab()).toBe(5)
    // Stop must have forced a FRESH prompt: the human, not the assistant,
    // is what releases the kill switch. Silently reusing live consent would
    // let the model walk straight through a Stop it was just given.
    expect(prompts).toBe(2)
    expect(gate.isStopped()).toBe(false)
  })

  it('suppresses pre-approval after Stop until a manual Allow resumes control', async () => {
    const preapprovalStates: boolean[] = []
    const gate = new TaskGate({
      prompt: async ({ allowPreApproval }) => {
        preapprovalStates.push(allowPreApproval)
        return { allowed: true, tabId: 5 }
      },
    })

    await gate.requireTab()
    gate.stop()
    await gate.requireTab()

    expect(preapprovalStates).toEqual([true, false])
    expect(gate.isStopped()).toBe(false)
  })

  it('allows pre-approval after relay loss ends the active task', async () => {
    const preapprovalStates: boolean[] = []
    const gate = new TaskGate({
      prompt: async ({ allowPreApproval }) => {
        preapprovalStates.push(allowPreApproval)
        return { allowed: true, tabId: 5 }
      },
    })

    await gate.requireTab()
    gate.registerCreatedTab(6)
    expect(gate.endTask()).toEqual([6])
    expect(gate.currentTab()).toBeNull()

    await gate.requireTab()
    expect(preapprovalStates).toEqual([true, true])
    expect(gate.isStopped()).toBe(false)
  })

  it('does not let an Allow from an ended relay task restore authorization', async () => {
    let allow: (() => void) | null = null
    const gate = new TaskGate({
      prompt: () => new Promise((resolve) => {
        allow = () => resolve({ allowed: true, tabId: 5 })
      }),
    })

    const pending = gate.requireTab()
    gate.endTask()
    allow?.()

    await expect(pending).rejects.toMatchObject({ code: 'stopped' })
    expect(gate.currentTab()).toBeNull()
    expect(gate.isStopped()).toBe(false)
  })

  it('a DECLINED prompt leaves Stop latched (declining is not a release)', async () => {
    const gate = new TaskGate({ prompt: async () => ({ allowed: false, reason: 'denied' }) })
    gate.stop()
    const err = await gate.requireTab().catch((e: unknown) => e)
    expect((err as { code?: string }).code).toBe('consent_denied')
    expect(gate.isStopped()).toBe(true)
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

  it('requires a manual Allow after the browser explicitly revokes control', async () => {
    const preapprovalStates: boolean[] = []
    const gate = new TaskGate({
      prompt: async ({ allowPreApproval }) => {
        preapprovalStates.push(allowPreApproval)
        return { allowed: true, tabId: 5 }
      },
    })

    await gate.requireTab()
    gate.revokeConsent({ requireManualApproval: true })
    await gate.requireTab()

    expect(preapprovalStates).toEqual([true, false])
  })

  it('clears the controlled tab when it closes', async () => {
    const gate = new TaskGate({ prompt: async () => ({ allowed: true, tabId: 5 }) })
    await gate.requireTab()
    expect(gate.onTabRemoved(4)).toBe(false)
    expect(gate.onTabRemoved(5)).toBe(true)
    expect(gate.currentTab()).toBeNull()
  })
})

describe('[COMP:ext/multi-tab-control] Profile-scoped tab handles', () => {
  it('keeps task mode to the approved root and task-created tabs', async () => {
    const gate = new TaskGate({ prompt: async () => ({ allowed: true, tabId: 10 }) })
    await gate.requireTab('task_tabs')
    const rootHandle = gate.currentHandle()
    const createdHandle = gate.registerCreatedTab(11)

    expect(rootHandle).toMatch(/^tab-/)
    expect(createdHandle).toMatch(/^tab-/)
    expect(gate.entries('task_tabs').map((entry) => entry.tabId)).toEqual([10, 11])
    expect(gate.isTaskOwnedTab(10)).toBe(true)
    expect(gate.isTaskOwnedTab(11)).toBe(true)
  })

  it('adopts pre-existing tabs only in full-profile mode and drops them when narrowed', async () => {
    const gate = new TaskGate({ prompt: async () => ({ allowed: true, tabId: 10 }) })
    await gate.requireTab('full_browser')
    const existing = gate.registerFullTab(99)
    expect(gate.isTaskOwnedTab(99)).toBe(false)
    expect(gate.selectHandle(existing, 'full_browser')).toBe(99)

    gate.setMode('task_tabs')
    expect(() => gate.selectHandle(existing, 'task_tabs')).toThrowError(
      /outside this browser profile's allowed task scope/i,
    )
    expect(gate.currentTab()).toBe(10)
  })

  it('Stop returns only created tabs for cleanup and preserves the approved root', async () => {
    const gate = new TaskGate({ prompt: async () => ({ allowed: true, tabId: 10 }) })
    await gate.requireTab('full_browser')
    gate.registerCreatedTab(11)
    gate.registerFullTab(12)

    expect(gate.stop()).toEqual([11])
    expect(gate.currentTab()).toBeNull()
  })

  it('keeps task-created tabs tracked for Stop cleanup across an idle re-approval', async () => {
    let now = 1_000
    const gate = new TaskGate({
      prompt: async () => ({ allowed: true, tabId: 10 }),
      now: () => now,
    })
    await gate.requireTab('task_tabs')
    gate.registerCreatedTab(11)
    now += CONSENT_IDLE_RESET_MS + 1
    await gate.requireTab('task_tabs')

    expect(gate.stop()).toEqual([11])
  })

  it('caps task-created tabs and uses opaque handles instead of Chrome ids', async () => {
    const gate = new TaskGate({ prompt: async () => ({ allowed: true, tabId: 123456 }) })
    await gate.requireTab('task_tabs')
    expect(gate.currentHandle()).not.toContain('123456')
    for (let i = 0; i < MAX_TASK_CREATED_TABS; i += 1) gate.registerCreatedTab(200 + i)
    expect(() => gate.registerCreatedTab(999)).toThrowError(/at most 8 browser tabs/i)
  })

  it('falls back to another scoped tab when the selected tab closes', async () => {
    const gate = new TaskGate({ prompt: async () => ({ allowed: true, tabId: 10 }) })
    await gate.requireTab('task_tabs')
    gate.registerCreatedTab(11)
    expect(gate.currentTab()).toBe(11)
    expect(gate.onTabRemoved(11)).toBe(true)
    expect(gate.currentTab()).toBe(10)
  })
})
