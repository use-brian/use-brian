// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Wire = { id: string; type: string; op?: string; args?: Record<string, unknown>; [key: string]: unknown }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

let messages: (message: unknown, sender?: { url: string }) => unknown
let selectedTab: { id: number; url: string; title: string }
let storage: Record<string, unknown>
let nativeMessages: Wire[]
let runtimeSendMessage: ReturnType<typeof vi.fn>
let bindDelay: ReturnType<typeof deferred<unknown>> | undefined
let nativeReply: (message: unknown) => void
let tabRemoved: (tabId: number) => void
let tabsUpdate: ReturnType<typeof vi.fn>
let createWindow: ReturnType<typeof vi.fn>
let removeWindow: ReturnType<typeof vi.fn>
let getLastFocused: ReturnType<typeof vi.fn>
let storageGet: ReturnType<typeof vi.fn>
let sockets: TestSocket[]
class TestSocket {
  readyState = 0
  sent: Wire[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(_url: string) {
    sockets.push(this)
    queueMicrotask(() => {
      this.readyState = 1
      this.onopen?.()
      this.receive({ type: 'ready' })
    })
  }
  send(data: string) { this.sent.push(JSON.parse(data) as Wire) }
  receive(message: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(message) }) }
  close(code = 4401) { this.readyState = 3; this.onclose?.({ code }) }
}
function command(id: string, op = 'navigate', args: Record<string, unknown> = { url: 'https://destination.example/next' }) {
  sockets[0]!.receive({ type: 'command', id, op, args, controlMode: 'task_tabs' })
}
function result(id: string) { return sockets[0]!.sent.find(frame => frame.type === 'result' && frame.id === id) }
const tick = async () => { for (let index = 0; index < 8; index++) await Promise.resolve() }
const allowHtml = readFileSync(`${process.cwd()}/static-firefox/allow.html`, 'utf8')

async function clickAllowPopup(url: string, choice: 'allow' | 'deny' = 'allow') {
  const originalDocument = globalThis.document
  const originalLocation = globalThis.location
  const page = new DOMParser().parseFromString(allowHtml, 'text/html')
  const sentBefore = runtimeSendMessage.mock.calls.length
  try {
    vi.stubGlobal('document', page)
    vi.stubGlobal('location', new URL(url))
    // Re-evaluate the real page entry for this popup, with its own captured URL.
    // The running background retains its real gate/queue/transport instances.
    vi.resetModules()
    await import('../firefox-allow.js')
    page.getElementById(choice)!.click()
    await tick()
    return runtimeSendMessage.mock.calls.slice(sentBefore).map(([message]) => message)
  } finally {
    vi.stubGlobal('document', originalDocument)
    vi.stubGlobal('location', originalLocation)
  }
}

function latestPromptUrl(): string {
  return createWindow.mock.calls.at(-1)![0].url as string
}

beforeEach(async () => {
  vi.resetModules()
  selectedTab = { id: 7, url: 'https://destination.example/', title: 'Fixture' }
  vi.spyOn(window, 'close').mockImplementation(() => {})
  storage = { relayUrl: 'wss://relay.example/ext', sessionToken: 'fixture-session', preapproveTabControl: true }
  nativeMessages = []; sockets = []; bindDelay = undefined
  tabsUpdate = vi.fn(async () => ({ id: 7 }))
  createWindow = vi.fn(async () => ({ id: 100 + createWindow.mock.calls.length }))
  removeWindow = vi.fn(async () => {})
  getLastFocused = vi.fn(async () => ({ tabs: [{ ...selectedTab, active: true }] }))
  storageGet = vi.fn(async (key: string) => ({ [key]: storage[key] }))
  const port = {
    onMessage: { addListener: (listener: (message: unknown) => void) => { nativeReply = listener } },
    onDisconnect: { addListener: vi.fn() },
    postMessage: (request: Wire) => {
      nativeMessages.push(request)
      const reply = (data: unknown) => nativeReply({ id: request.id, ok: true, data })
      if (request.type === 'bind' && bindDelay) {
        void bindDelay.promise.then(reply)
      } else {
        queueMicrotask(() => reply(request.type === 'status' ? { ready: true }
          : request.type === 'stop' ? { stopped: true }
          : request.type === 'bind' ? { bound: true }
          : { url: request.args?.url ?? 'https://destination.example/' }))
      }
    },
  }
  runtimeSendMessage = vi.fn((message: unknown) => Promise.resolve(messages(message, { url: location.href })))
  const api = {
    runtime: {
      id: 'fixture-extension', getURL: (path: string) => `moz-extension://fixture/${path}`,
      connectNative: vi.fn(() => port),
      sendMessage: runtimeSendMessage,
      onMessage: { addListener: (listener: typeof messages) => { messages = listener } },
    },
    storage: { local: {
      get: storageGet,
      set: async (value: Record<string, unknown>) => { Object.assign(storage, value) },
      remove: async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key] },
    } },
    browserAction: { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}) },
    tabs: {
      get: vi.fn(async (id: number) => ({ ...selectedTab, id, active: true, windowId: 1 })),
      update: tabsUpdate,
      onRemoved: { addListener: (listener: typeof tabRemoved) => { tabRemoved = listener } },
    },
    windows: {
      getLastFocused,
      create: createWindow, remove: removeWindow, update: vi.fn(async () => ({})),
    },
  }
  vi.stubGlobal('chrome', api); vi.stubGlobal('browser', api)
  vi.stubGlobal('WebSocket', TestSocket)
  vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ build: 'fixture-build' }) })))
  // No relay/client/gate/queue mocks: import the actual entry point and drive its platform ports.
  await import('../firefox-background.js')
  await vi.waitFor(() => expect(sockets[0]?.sent[0]).toMatchObject({ type: 'hello' }))
})

afterEach(async () => {
  await messages?.({ type: 'stop-task' })
  bindDelay?.resolve({ bound: true })
  for (const socket of sockets) socket.close()
  await tick()
  vi.unstubAllGlobals(); vi.restoreAllMocks()
})

describe('[COMP:ext/firefox-agent] actual Firefox background Stop fence', () => {
  it.each(['focus', 'bind'] as const)('popup Stop cancels an admitted navigate delayed during %s', async boundary => {
    const focus = deferred<{ id: number }>()
    if (boundary === 'focus') tabsUpdate.mockImplementationOnce(() => focus.promise)
    else bindDelay = deferred<unknown>()
    try {
      command('old')
      await vi.waitFor(() => boundary === 'focus'
        ? expect(tabsUpdate).toHaveBeenCalledOnce()
        : expect(nativeMessages.some(message => message.type === 'bind')).toBe(true))
      await messages({ type: 'stop-task' })
      await vi.waitFor(() => expect(nativeMessages.some(message => message.type === 'stop')).toBe(true))
      focus.resolve({ id: 7 }); bindDelay?.resolve({ bound: true })
      await vi.waitFor(() => expect(result('old')).toBeDefined())
      expect(nativeMessages.filter(message => message.type === 'execute')).toEqual([])
      expect(result('old')).toMatchObject({ ok: false, code: 'stopped' })
      expect(createWindow).not.toHaveBeenCalled()
    } finally { focus.resolve({ id: 7 }); bindDelay?.resolve({ bound: true }) }
  })

  it.each(['focus', 'bind'] as const)('relay Stop bypasses work delayed during %s and prevents late execute', async boundary => {
    const focus = deferred<{ id: number }>()
    if (boundary === 'focus') tabsUpdate.mockImplementationOnce(() => focus.promise)
    else bindDelay = deferred<unknown>()
    try {
      command('old')
      await vi.waitFor(() => boundary === 'focus'
        ? expect(tabsUpdate).toHaveBeenCalledOnce()
        : expect(nativeMessages.some(message => message.type === 'bind')).toBe(true))
      command('stop', 'stop', {})
      await vi.waitFor(() => expect(result('stop')).toMatchObject({ ok: true, data: { stopped: true } }))
      // A Stop acknowledgement must not wait for the held focus/bind response.
      expect(result('old')?.ok).not.toBe(true)
      focus.resolve({ id: 7 }); bindDelay?.resolve({ bound: true })
      await vi.waitFor(() => expect(result('old')).toBeDefined())
      expect(nativeMessages.filter(message => message.type === 'execute')).toEqual([])
      expect(result('old')).toMatchObject({ ok: false, code: 'stopped' })
    } finally { focus.resolve({ id: 7 }); bindDelay?.resolve({ bound: true }) }
  })

  it('cancels queued pre-Stop work without asking again or executing after the active barrier', async () => {
    const focus = deferred<{ id: number }>()
    tabsUpdate.mockImplementationOnce(() => focus.promise)
    try {
      command('active')
      await vi.waitFor(() => expect(tabsUpdate).toHaveBeenCalledOnce())
      command('queued', 'navigate', { url: 'https://destination.example/queued' })
      command('stop', 'stop', {})
      await vi.waitFor(() => expect(result('stop')).toMatchObject({ ok: true, data: { stopped: true } }))
      focus.resolve({ id: 7 })
      await vi.waitFor(() => expect(result('active')).toBeDefined())
      expect(nativeMessages.filter(message => message.type === 'execute')).toEqual([])
      await vi.waitFor(() => expect(result('queued')).toBeDefined())
      expect(result('active')).toMatchObject({ ok: false, code: 'stopped' })
      expect(result('queued')).toMatchObject({ ok: false, code: 'stopped' })
      expect(createWindow).not.toHaveBeenCalled()
    } finally { focus.resolve({ id: 7 }) }
  })

  it('requires a new manual Allow after Stop and then performs the fresh navigation once', async () => {
    command('initial')
    await vi.waitFor(() => expect(result('initial')).toMatchObject({ ok: true }))
    expect(createWindow).not.toHaveBeenCalled() // initial local pre-approval
    await messages({ type: 'stop-task' }); await tick()
    const oldEffects = nativeMessages.filter(message => message.type === 'execute').length
    command('fresh', 'navigate', { url: 'https://destination.example/fresh' })
    await vi.waitFor(() => expect(createWindow).toHaveBeenCalledOnce())
    expect(result('fresh')).toBeUndefined()
    expect(nativeMessages.filter(message => message.type === 'execute')).toHaveLength(oldEffects)
    await tick()
    await clickAllowPopup(latestPromptUrl())
    await vi.waitFor(() => expect(result('fresh')).toMatchObject({ ok: true, data: { url: 'https://destination.example/fresh' } }))
    expect(nativeMessages.filter(message => message.type === 'execute' && message.args?.url === 'https://destination.example/fresh')).toHaveLength(1)
  })

  it('does not widen the unsupported Firefox operation vocabulary', async () => {
    for (const op of ['fillForm', 'openTab', 'listTabs', 'switchTab', 'closeTab']) command(op, op, {})
    await vi.waitFor(() => expect(sockets[0]!.sent.filter(message => message.type === 'result')).toHaveLength(5))
    for (const op of ['fillForm', 'openTab', 'listTabs', 'switchTab', 'closeTab']) expect(result(op)).toMatchObject({ ok: false, code: 'unsupported_browser' })
    expect(nativeMessages).toEqual([])
    expect(createWindow).not.toHaveBeenCalled()
  })
})


it.each(['active-tab', 'preapproval', 'window-create'] as const)('[COMP:ext/firefox-agent] Stop settles delayed %s prompt setup and permits a fresh manual task before old setup returns', async boundary => {
  const focused = deferred<{ tabs: Array<{ id: number; active: boolean; url: string }> }>()
  const preference = deferred<Record<string, unknown>>()
  const window = deferred<{ id: number }>()
  storage.preapproveTabControl = boundary === 'preapproval'
  if (boundary === 'active-tab') getLastFocused.mockImplementationOnce(() => focused.promise)
  if (boundary === 'window-create') createWindow.mockImplementationOnce(() => window.promise)
  const read = storageGet.getMockImplementation()!
  let preferenceRead = false
  if (boundary === 'preapproval') storageGet.mockImplementation((key: string) => {
    if (key === 'preapproveTabControl' && !preferenceRead) { preferenceRead = true; return preference.promise }
    return read(key)
  })
  const release = () => {
    focused.resolve({ tabs: [{ id: 7, active: true, url: 'https://destination.example/' }] })
    preference.resolve({ preapproveTabControl: true })
    window.resolve({ id: 2 })
  }
  try {
    command('old-prompt')
    await vi.waitFor(() => boundary === 'active-tab' ? expect(getLastFocused).toHaveBeenCalledOnce()
      : boundary === 'preapproval' ? expect(preferenceRead).toBe(true) : expect(createWindow).toHaveBeenCalledOnce())
    await messages({ type: 'stop-task' })
    await tick()
    command('fresh-prompt', 'navigate', { url: 'https://destination.example/fresh-consent' })
    const oldWindows = boundary === 'window-create' ? 1 : 0
    // The old setup promise is intentionally still unresolved here.
    await vi.waitFor(() => expect(createWindow).toHaveBeenCalledTimes(oldWindows + 1))
    expect(result('old-prompt')).toMatchObject({ ok: false, code: 'stopped' })
    expect(nativeMessages.filter(message => message.type === 'execute')).toEqual([])
    await tick()
    await clickAllowPopup(latestPromptUrl())
    await vi.waitFor(() => expect(result('fresh-prompt')).toMatchObject({ ok: true, data: { url: 'https://destination.example/fresh-consent' } }))

    // Late cleanup of the first setup must not create a prompt or clear a newer one's callback.
    await messages({ type: 'stop-task' }); await tick()
    command('newer-prompt', 'navigate', { url: 'https://destination.example/newer-consent' })
    await vi.waitFor(() => expect(createWindow).toHaveBeenCalledTimes(oldWindows + 2))
    release(); await new Promise(resolve => setTimeout(resolve, 0))
    expect(createWindow).toHaveBeenCalledTimes(oldWindows + 2)
    expect(result('newer-prompt')).toBeUndefined()
    expect(nativeMessages.filter(message => message.type === 'execute')).toHaveLength(1)
    await clickAllowPopup(latestPromptUrl())
    await vi.waitFor(() => expect(result('newer-prompt')).toMatchObject({ ok: true, data: { url: 'https://destination.example/newer-consent' } }))
  } finally {
    release(); await new Promise(resolve => setTimeout(resolve, 0))
    await messages({ type: 'stop-task' })
  }
})

it('[COMP:ext/firefox-agent] revoked preapproval cannot install a cached Allow from a late true preference read', async () => {
  const preference = deferred<Record<string, unknown>>()
  const read = storageGet.getMockImplementation()!
  let preferenceRead = false
  storageGet.mockImplementation((key: string) => {
    if (key === 'preapproveTabControl' && !preferenceRead) { preferenceRead = true; return preference.promise }
    return read(key)
  })
  try {
    command('old-preapproval')
    await vi.waitFor(() => expect(preferenceRead).toBe(true))
    storage.preapproveTabControl = false
    await messages({ type: 'consent-preapproval-changed', preapproveEnabled: false })
    preference.resolve({ preapproveTabControl: true })
    await vi.waitFor(() => expect(result('old-preapproval')).toMatchObject({ ok: false, code: 'stopped' }))
    command('after-revocation', 'navigate', { url: 'https://destination.example/manual-required' })
    await vi.waitFor(() => expect(Boolean(result('after-revocation')) || createWindow.mock.calls.length > 0).toBe(true))
    expect(createWindow).toHaveBeenCalledOnce()
    expect(result('after-revocation')).toBeUndefined()
    expect(nativeMessages.filter(message => message.type === 'execute')).toEqual([])
    await tick()
    await clickAllowPopup(latestPromptUrl())
    await vi.waitFor(() => expect(result('after-revocation')).toMatchObject({ ok: true, data: { url: 'https://destination.example/manual-required' } }))
  } finally {
    preference.resolve({ preapproveTabControl: true }); await tick()
    await messages({ type: 'stop-task' })
  }
})


describe('[COMP:ext/firefox-agent] actual Allow page prompt ownership', () => {
  it.each(['allow', 'deny'] as const)('ignores stale popup %s for a distinct fresh target', async choice => {
    storage.preapproveTabControl = false
    selectedTab = { id: 7, url: 'https://alpha.example/', title: 'Target A' }
    const oldWindow = deferred<{ id: number }>()
    createWindow.mockImplementationOnce(() => oldWindow.promise)
    try {
      command('target-a')
      await vi.waitFor(() => expect(createWindow).toHaveBeenCalledOnce())
      const oldUrl = latestPromptUrl()
      await messages({ type: 'stop-task' }); await tick()
      selectedTab = { id: 9, url: 'https://beta.example/', title: 'Target B' }
      command('target-b', 'navigate', { url: 'https://beta.example/approved' })
      await vi.waitFor(() => expect(createWindow).toHaveBeenCalledTimes(2))
      const freshUrl = latestPromptUrl()
      await tick()
      expect(result('target-a')).toMatchObject({ ok: false, code: 'stopped' })
      expect(result('target-b')).toBeUndefined()
      oldWindow.resolve({ id: 101 })
      await new Promise(resolve => setTimeout(resolve, 0))

      // Send the real old page's message even if cleanup has closed its window:
      // window closure cannot stand in for an authority check at the receiver.
      const sent = await clickAllowPopup(oldUrl, choice)
      expect(sent).toEqual([expect.objectContaining({ type: 'consent-response', allowed: choice === 'allow' })])
      await new Promise(resolve => setTimeout(resolve, 75))
      expect(result('target-b')).toBeUndefined()
      expect(nativeMessages.filter(message => message.type === 'bind' || message.type === 'execute')).toEqual([])
      expect(removeWindow.mock.calls.some(([id]) => id === 102)).toBe(false)

      await clickAllowPopup(freshUrl)
      await vi.waitFor(() => expect(result('target-b')).toMatchObject({ ok: true, data: { url: 'https://beta.example/approved' } }))
      expect(nativeMessages.filter(message => message.type === 'bind')).toEqual([
        expect.objectContaining({ args: { url: 'https://beta.example/', title: 'Target B' } }),
      ])
      expect(nativeMessages.filter(message => message.type === 'execute')).toEqual([
        expect.objectContaining({ op: 'navigate', args: { url: 'https://beta.example/approved' } }),
      ])
      const oldId = new URL(oldUrl).searchParams.get('promptId')
      const freshId = new URL(freshUrl).searchParams.get('promptId')
      expect(oldId).toBeTruthy()
      expect(freshId).toBeTruthy()
      expect(oldId).not.toBe(freshId)
    } finally { oldWindow.resolve({ id: 101 }) }
  })

  it.each(['missing', 'unknown'] as const)('ignores %s identity from an actual Allow page while the current prompt remains usable', async identity => {
    storage.preapproveTabControl = false
    command('current')
    await vi.waitFor(() => expect(createWindow).toHaveBeenCalledOnce())
    const freshUrl = latestPromptUrl()
    const unrelatedUrl = new URL(freshUrl)
    if (identity === 'missing') unrelatedUrl.searchParams.delete('promptId')
    else unrelatedUrl.searchParams.set('promptId', 'not-the-active-prompt')
    await tick()
    await clickAllowPopup(unrelatedUrl.href)
    await new Promise(resolve => setTimeout(resolve, 75))
    expect(result('current')).toBeUndefined()
    expect(nativeMessages.filter(message => message.type === 'bind' || message.type === 'execute')).toEqual([])
    await clickAllowPopup(freshUrl)
    await vi.waitFor(() => expect(result('current')).toMatchObject({ ok: true }))
    expect(nativeMessages.filter(message => message.type === 'execute')).toHaveLength(1)
  })

  it('allows an ordinary first manual prompt through its actual page', async () => {
    storage.preapproveTabControl = false
    command('ordinary-manual')
    await vi.waitFor(() => expect(createWindow).toHaveBeenCalledOnce())
    await tick()
    await clickAllowPopup(latestPromptUrl())
    await vi.waitFor(() => expect(result('ordinary-manual')).toMatchObject({ ok: true }))
    expect(nativeMessages.filter(message => message.type === 'execute')).toHaveLength(1)
  })
})
