import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { NativeComputerController, type NativeActivity } from '../computer-control/controller.js'
import type { NativeCommand, NativeGrant, NativeCapabilities, NativeReceipt } from '../computer-control/contracts.js'
import type { NativeIndicatorData } from '../native-computer-integration.js'

// Reuse the workspace's web DOM test dependency; no Electron/E2E claims here.
const { JSDOM } = createRequire(new URL('../../../app-web/package.json', import.meta.url))('jsdom') as {
  JSDOM: new (html: string) => { window: { document: Document; close(): void } }
}
const source = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
const injection = '<img src=x onerror="globalThis.pwned=true"><script>alert(1)</script>'

describe('private native indicator DOM', () => {
  it('renders truthful state, app and actual mode as text; Stop exposes only revocation', () => {
    const dom = new JSDOM(source('native-computer-indicator.html'))
    const document = dom.window.document
    let ready!: () => void
    let update!: (event: unknown, data: NativeIndicatorData) => void
    const send = vi.fn()
    runInNewContext(source('native-computer-indicator-preload.cjs'), {
      require: (name: string) => { expect(name).toBe('electron'); return { ipcRenderer: { send, on: (channel: string, cb: typeof update) => { expect(channel).toBe('Use Brian:native-status'); update = cb } } } },
      window: { addEventListener: (event: string, cb: () => void) => { expect(event).toBe('DOMContentLoaded'); ready = cb } }, document,
    })
    ready()
    const render = (state: NativeIndicatorData['state'], perception: 'ax' | 'vision' = 'ax', shortcut = 'Ctrl+Alt+Shift+Esc') => update(null, { state, activity: { appId: injection, perception }, shortcut })
    render('awaiting_local_consent')
    expect(document.getElementById('state')!.textContent).toBe('Awaiting local consent — not controlling')
    expect(document.getElementById('app')!.textContent).not.toContain(injection)
    render('active')
    expect(document.getElementById('app')!.textContent).toBe(`Target app: ${injection}`)
    expect(document.getElementById('perception')!.textContent).toBe('Actual perception: AX (accessibility)')
    expect(document.getElementById('shortcut')!.textContent).toBe('Emergency stop: Ctrl+Alt+Shift+Esc')
    render('active', 'vision', '⌘⇧Esc')
    expect(document.getElementById('perception')!.textContent).toBe('Actual perception: Vision')
    expect(document.getElementById('shortcut')!.textContent).toBe('Emergency stop: ⌘⇧Esc')
    render('awaiting_action_approval')
    expect(document.getElementById('state')!.textContent).toBe('Awaiting local action approval')
    for (const state of ['stopped', 'paused_for_user', 'ended'] as const) {
      render(state)
      expect(document.getElementById('state')!.textContent).toContain('not controlling')
      expect(document.getElementById('perception')!.textContent).toBe('Actual perception: none yet')
      expect(document.getElementById('app')!.textContent).not.toContain(injection)
    }
    expect(document.querySelector('img, script')).toBeNull()
    document.getElementById('stop')!.click()
    expect(send.mock.calls).toEqual([['Use Brian:native-emergency-stop']])
    dom.window.close()
  })
})

const identity = { deploymentId: 'deployment', userId: 'user', workspaceId: 'workspace', deviceId: 'device', sessionId: 'session', conversationId: 'conversation', taskId: 'task' }
const target = { appId: injection, processId: 42, processInstanceId: 'launch', windowId: 'window', windowInstanceId: 'instance' }
const capabilities: NativeCapabilities = { protocol: 'native-computer-v1', platform: 'darwin', axRead: true, semanticActions: true, windowCapture: true, input: true, accessibilityPermission: 'granted', capturePermission: 'granted', limitations: [] }
const grant = (epoch = 1): NativeGrant => ({ protocol: 'native-computer-v1', identity, grantId: 'grant', epoch, expiresAt: Date.now() + 60_000, targets: [target], allowControl: true, allowCapture: true, requester: 'local', goal: 'private goal' })

describe('trusted main activity callback', () => {
  it('projects only locally permitted actual dispatch; clears on Stop and new grant even with hung work', async () => {
    const events: (NativeActivity | null)[] = []
    let approve = true
    let blocked = false
    const helper = {
      capabilities: async () => capabilities, listTargets: async () => [target], start: async () => {},
      beginApproval: async () => true, endApproval: async () => true, kill: vi.fn(async () => {}),
      execute: vi.fn(async (c: NativeCommand): Promise<NativeReceipt> => blocked ? new Promise(() => {}) : { commandId: c.commandId, outcome: 'executed', code: 'ok' }),
    }
    const controller = new NativeComputerController({ revalidateExecution: async () => true, enabled: true, platform: 'darwin', safetyControlsReady: () => true,
      helperFactory: () => helper, lease: { acquire: async () => {}, release: async () => {} },
      approveGrant: async () => true, approveAction: async () => approve, onActivity: activity => { events.push(activity) },
    })
    let id = 0
    const command = (action: NativeCommand['action'], epoch = 1): NativeCommand => ({ protocol: 'native-computer-v1', identity, grantId: 'grant', epoch, commandId: `command-${++id}`, deadlineAt: Date.now() + 30_000, action })
    try {
      await controller.start(grant())
      expect(events).toEqual([null])
      await controller.execute(command({ kind: 'observe', target: { ...target, appId: 'foreign' } }))
      expect(events).toEqual([null])
      const actions: NativeCommand['action'][] = [
        { kind: 'observe', target }, { kind: 'capture', target, observationId: 'obs' },
        { kind: 'click', target, observationId: 'obs', frameId: 'frame', x: 1, y: 2 },
        { kind: 'setValue', target, observationId: 'obs', ref: 'ref', text: 'SECRET action text' },
      ]
      for (const action of actions) {
        const c = command(action)
        await controller.execute(c)
        expect(events.at(-1)).toEqual({ appId: injection, perception: ['capture', 'click'].includes(action.kind) ? 'vision' : 'ax' })
        expect(Object.isFrozen(events.at(-1))).toBe(true)
        const count = events.length
        await controller.execute(c)
        expect(events).toHaveLength(count)
      }
      approve = false
      await controller.execute(command(actions[3]))
      expect(events).toHaveLength(5)
      expect(JSON.stringify(events)).not.toContain('SECRET')
      expect(controller.status()).not.toHaveProperty('activity')
      blocked = true
      const pending = controller.execute(command(actions[0]))
      await vi.waitFor(() => expect(helper.execute).toHaveBeenCalledTimes(5))
      const stopping = controller.stop()
      expect(helper.kill).toHaveBeenCalledOnce()
      expect(events.at(-1)).toBeNull()
      expect((await pending).outcome).toBe('execution_unknown')
      await stopping
      await controller.resume(grant(3))
      expect(events.slice(-2)).toEqual([null, null])
    } finally { await controller.dispose() }
  })
})
