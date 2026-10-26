import { isTrustedPairingOrigin } from './pairing.js'
import { installAccountSwitching, type AccountBroker } from './account-switching.js'

export type ChatIdentity = { userId: string; workspaceId: string; browserProfileId: string }
export type PageEvidence = { url: string; title: string; text: string; capturedAt: string }
const PAGE_TEXT_LIMIT = 12_000

/** Local routing hint only. The relay and API remain the credential verifiers. */
export function pairedChatIdentity(token: unknown, now = Date.now()): ChatIdentity | null {
  try {
    if (typeof token !== 'string') return null
    const c = JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')))
    if (!['browser-ext-pair', 'browser-ext-session'].includes(c.kind) || !Number.isFinite(c.exp) || c.exp * 1000 <= now) return null
    if (![c.userId, c.workspaceId, c.browserProfileId].every(v => typeof v === 'string' && v.length > 0 && v.length <= 128)) return null
    return { userId: c.userId, workspaceId: c.workspaceId, browserProfileId: c.browserProfileId }
  } catch { return null }
}

/** Include readable page evidence, never editable field contents or AX values. */
export function pageEvidence(snapshot: { url: string; title: string; nodes: Array<{ role: string; name: string }> }): PageEvidence {
  const roles = new Set(['statictext', 'heading', 'paragraph', 'cell', 'columnheader', 'rowheader', 'caption', 'link'])
  const text = snapshot.nodes.filter(n => roles.has(n.role.toLowerCase())).map(n => n.name).filter(Boolean).join('\n')
  return { url: snapshot.url.slice(0, 4096), title: snapshot.title.slice(0, 500), text: text.slice(0, PAGE_TEXT_LIMIT), capturedAt: new Date().toISOString() }
}

type Broker = AccountBroker
type Request = { id: string; panel: chrome.runtime.Port; broker: Broker; identity: ChatIdentity; sessionId?: string }

/** Ports carry chat data only. No credentials or general HTTP/browser RPC. */
export function installAssistantChat(deps: {
  identity: () => Promise<ChatIdentity | null>
  ready: () => boolean
  readPage: () => Promise<PageEvidence>
  pageStillCurrent: (page: PageEvidence) => Promise<boolean>
  stop: () => Promise<void>
  matches: () => string[]
  accountStore?: Pick<chrome.storage.StorageArea, 'get' | 'set' | 'remove'>
  appOrigin?: () => Promise<string | null>
  beforeAccountSwitch?: () => Promise<void>
  installationId?: () => Promise<string>
  beforeAutomaticConnect?: () => Promise<void>
  controlState?: () => Promise<{ phase: 'idle' | 'waiting' | 'active' | 'stopped'; host?: string }>
}) {
  const brokers = new Set<Broker>()
  const panels = new Set<chrome.runtime.Port>()
  const sharedPages = new Map<chrome.runtime.Port, PageEvidence>()
  let pending: Request | null = null
  let generation = 0
  const post = (port: chrome.runtime.Port, message: unknown) => { try { port.postMessage(message) } catch { /* disconnected */ } }
  const invalidate = () => {
    generation++
    if (pending) {
      post(pending.broker.port, { type: 'stop', id: pending.id })
      post(pending.panel, { type: 'failure', id: pending.id, code: 'account_changed' })
      pending = null
    }
    sharedPages.clear()
    for (const panel of panels) post(panel, { type: 'identity-reset' })
  }
  const accounts = deps.accountStore ? installAccountSwitching({
    installationId: deps.installationId,
    beforeAutomaticConnect: async () => { if (pending) throw new Error('busy'); await deps.beforeAutomaticConnect?.() },
    currentProfile: async broker => { const identity = await deps.identity(); return deps.ready() && identity && identity.userId === broker.hello.userId && identity.workspaceId === broker.hello.workspaceId ? identity.browserProfileId : undefined },
    store: deps.accountStore, brokers: () => [...brokers],
    appOrigin: deps.appOrigin ?? (async () => null),
    beforeSwitch: async () => { if (pending) throw new Error('busy'); await (deps.beforeAccountSwitch ?? deps.stop)() },
    reset: invalidate, publish: message => { for (const panel of panels) post(panel, message) },
  }) : null
  const eligible = async () => {
    const identity = await deps.identity()
    if (!identity || !deps.ready()) return null
    const active = await accounts?.status()
    if (active?.accountDirectory?.current.id && active.accountDirectory.current.id !== identity.userId) return null
    if (active?.workspaceDirectory?.active.id && active.workspaceDirectory.active.id !== identity.workspaceId) return null
    return [...brokers].reverse().find(b => b.hello.userId === identity.userId && b.hello.workspaceId === identity.workspaceId) ?? null
  }
  const status = async (panel: chrome.runtime.Port) => {
    await accounts?.ensureConnection()
    const broker = await eligible()
    post(panel, { type: 'status', ...(await accounts?.status()), ...(deps.controlState ? { control: await deps.controlState() } : {}), connected: !!broker, ...(broker ? { identity: { userId: broker.hello.userId, workspaceId: broker.hello.workspaceId }, workspaceName: broker.hello.workspaceName, assistants: broker.hello.assistants, appearance: broker.hello.appearance } : {}) })
  }
  const refresh = () => { for (const panel of panels) void status(panel) }
  chrome.storage.onChanged.addListener(refresh)

  chrome.runtime.onConnectExternal.addListener(port => {
    if (port.name !== 'brian-assistant-chat' || !isTrustedPairingOrigin(port.sender?.origin, deps.matches()) || port.sender?.frameId !== 0) {
      port.disconnect(); return
    }
    const broker: Broker = { port, hello: {} }
    let deliveries = Promise.resolve()
    port.onMessage.addListener(message => {
      if (!message || typeof message !== 'object') return
      if (message.type === 'hello') {
        if (typeof message.userId !== 'string' || typeof message.workspaceId !== 'string' || !Array.isArray(message.assistants) || message.assistants.length > 200) return
        broker.hello = message
        brokers.add(broker)
        accounts?.hello(broker)
        refresh()
        return
      }
      if (accounts?.receive(broker, message)) return
      if (message.type === 'appearance' && brokers.has(broker)) {
        broker.hello.appearance = message.appearance
        refresh()
        return
      }
      const request = pending
      if (!request || request.broker !== broker || request.id !== message.id) return
      deliveries = deliveries.then(async () => {
        const identity = await deps.identity()
        if (!identity || !deps.ready() || identity.userId !== request.identity.userId || identity.workspaceId !== request.identity.workspaceId || identity.browserProfileId !== request.identity.browserProfileId || pending !== request) {
          post(broker.port, { type: 'stop', id: request.id })
          if (pending === request) { pending = null; post(request.panel, { type: 'failure', id: request.id, code: 'account_changed' }); void deps.stop() }
          return
        }
        if (message.type === 'event' && typeof message.event === 'string') {
          if (message.event === 'session' && typeof message.data?.sessionId === 'string') request.sessionId = message.data.sessionId
          post(request.panel, message)
        } else if (message.type === 'complete' || message.type === 'failure') {
          post(request.panel, message)
          pending = null
        }
      }).catch(() => undefined)
    })
    port.onDisconnect.addListener(() => {
      brokers.delete(broker)
      accounts?.disconnected(broker)
      if (pending?.broker === broker) {
        post(pending.panel, { type: 'failure', id: pending.id, code: 'app_disconnected' })
        pending = null
        void deps.stop()
      }
      refresh()
    })
  })

  chrome.runtime.onConnect.addListener(panel => {
    if (panel.name !== 'brian-assistant-panel' || panel.sender?.id !== chrome.runtime.id || panel.sender.url !== chrome.runtime.getURL('sidepanel.html')) return
    panels.add(panel)
    void status(panel)
    panel.onDisconnect.addListener(() => {
      generation++
      panels.delete(panel)
      sharedPages.delete(panel)
      if (pending?.panel === panel) {
        post(pending.broker.port, { type: 'stop', id: pending.id })
        pending = null
        void deps.stop()
      }
    })
    panel.onMessage.addListener(message => {
      const admission = generation
      void (async () => {
        if (message && typeof message === 'object' && await accounts?.panel(message)) return
        if (message?.type === 'status') { await status(panel); return }
        if (message?.type === 'stop') {
          generation++
          const request = pending
          if (request?.panel === panel) {
            post(request.broker.port, { type: 'stop', id: request.id })
          }
          await deps.stop(); await status(panel); return
        }
        if (await accounts?.blocked()) throw new Error('account_switching')
        if (message?.type === 'read-page') {
          if (!await eligible()) throw new Error('app_disconnected')
          if (admission !== generation) throw new Error('stopped')
          const page = await deps.readPage()
          if (admission !== generation) throw new Error('stopped')
          sharedPages.set(panel, page)
          post(panel, { type: 'page', page }); await status(panel); return
        }
        if (message?.type === 'open-chat') {
          const broker = await eligible()
          if (!broker) throw new Error('app_disconnected')
          const url = new URL(`/w/${encodeURIComponent(String(broker.hello.workspaceId))}/chat`, broker.port.sender!.origin)
          if (typeof message.sessionId === 'string' && message.sessionId.length <= 128) url.searchParams.set('s', message.sessionId)
          await chrome.tabs.create({ url: url.href }); return
        }
        if (message?.type !== 'send') return
        if (pending) throw new Error('busy')
        if (typeof message.id !== 'string' || message.id.length > 128 || typeof message.text !== 'string' || !message.text.trim() || message.text.length > 16_000) throw new Error('invalid_request')
        const broker = await eligible()
        const identity = await deps.identity()
        if (!broker || !identity) throw new Error('app_disconnected')
        let page: PageEvidence | undefined
        if (message.page) {
          const shared = sharedPages.get(panel)
          if (!shared || shared.capturedAt !== message.page.capturedAt || Date.now() - Date.parse(shared.capturedAt) > 5 * 60_000 || !await deps.pageStillCurrent(shared)) throw new Error('page_changed')
          page = shared
        }
        // Recheck after asynchronous admission so two panels cannot both send.
        if (pending) throw new Error('busy')
        if (admission !== generation) throw new Error('stopped')
        if (!brokers.has(broker) || !deps.ready()) throw new Error('app_disconnected')
        pending = { id: message.id, panel, broker, identity }
        post(broker.port, { type: 'send', id: message.id, text: message.text, assistantId: message.assistantId,
          sessionId: message.sessionId, page, browserProfileId: identity.browserProfileId })
        sharedPages.delete(panel)
      })().catch(error => post(panel, { type: 'failure', id: message?.id,
        code: typeof error?.code === 'string' ? error.code : error instanceof Error ? error.message : 'unavailable' }))
    })
  })
  return { invalidate, refresh }
}
