/** Firefox My Browser background page: relay + consent + desktop companion. */
import { RelayClient } from './relay-client.js'
import { TaskGate, CONSENT_PROMPT_TIMEOUT_MS, type ConsentOutcome } from './task-gate.js'
import { activeTabForConsent, eligibilityOf } from './tab-eligibility.js'
import { credentialsForConfigure, type PairRequest } from './pairing.js'
import { FirefoxNativeClient, FirefoxNativeError } from './firefox-native-client.js'

const ext = (globalThis as unknown as { browser: typeof chrome }).browser
const native = new FirefoxNativeClient()
let boundTabId: number | null = null
let boundGeneration = 0
let pendingConsent: ((res: { allowed: boolean }) => void) | null = null

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

async function promptForConsent(): Promise<ConsentOutcome> {
  const activeTab = await activeTabForConsent((options) => ext.windows.getLastFocused(options))
  const eligibility = eligibilityOf(activeTab?.url, { allowFirefoxNewTab: true })
  if (!eligibility.eligible) return { allowed: false, reason: eligibility.reason }
  if (activeTab?.id == null) return { allowed: false, reason: 'no_active_tab' }
  const targetTabId = activeTab.id
  await ext.windows.create({
    url: ext.runtime.getURL(`allow.html?host=${encodeURIComponent(hostOf(activeTab.url ?? ''))}`),
    type: 'popup',
    width: 380,
    height: 220,
    focused: true,
  })
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingConsent = null
      resolve({ allowed: false, reason: 'denied' })
    }, CONSENT_PROMPT_TIMEOUT_MS)
    pendingConsent = (res) => {
      clearTimeout(timer)
      pendingConsent = null
      resolve(res.allowed ? { allowed: true, tabId: targetTabId } : { allowed: false, reason: 'denied' })
    }
  })
}

const gate = new TaskGate({ prompt: promptForConsent })

async function getStored<T = string>(key: string): Promise<T | null> {
  const obj = await ext.storage.local.get(key)
  return (obj[key] as T | undefined) ?? null
}

const client = new RelayClient({
  getUrl: () => getStored('relayUrl'),
  connect: (url) => new WebSocket(url) as unknown as import('./relay-client.js').WebSocketLike,
  getToken: async () => (await getStored('sessionToken')) ?? (await getStored('pairingToken')),
  onSessionToken: async (token) => {
    await ext.storage.local.set({ sessionToken: token })
    await ext.storage.local.remove('pairingToken')
  },
  onCommand: (cmd) => void handleCommand(cmd),
  onStateChange: (state) => {
    void ext.browserAction.setBadgeText({ text: state === 'ready' ? 'ON' : '' })
    void ext.browserAction.setBadgeBackgroundColor({ color: '#16a34a' })
  },
})

async function applyPairing(req: PairRequest): Promise<void> {
  const { set, remove } = credentialsForConfigure(req)
  if (Object.keys(set).length > 0) await ext.storage.local.set(set)
  if (remove.length > 0) await ext.storage.local.remove(remove)
  client.stop()
  client.start()
}

async function handleCommand(cmd: { id: string; op: string; args: Record<string, unknown> }): Promise<void> {
  try {
    const data = await executeOp(cmd.op, cmd.args)
    client.sendResult({ id: cmd.id, ok: true, data })
  } catch (error) {
    client.sendResult({
      id: cmd.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      code: error instanceof FirefoxNativeError ? error.code : ((error as { code?: string })?.code ?? 'backend_error'),
    })
  }
}

async function executeOp(op: string, args: Record<string, unknown>): Promise<unknown> {
  if (op === 'stop') {
    gate.stop()
    boundTabId = null
    return native.request('stop')
  }
  const status = await native.status()
  if (!status.ready) {
    throw new FirefoxNativeError(
      status.reason === 'firefox_companion_missing'
        ? 'Install or open the Use Brian desktop app to use My Browser in Firefox.'
        : 'Quit Firefox, then choose Start Firefox for My Browser in the Use Brian desktop app.',
      status.reason ?? 'firefox_restart_required',
    )
  }
  const tabId = await gate.requireTab()
  const generation = native.connectionGeneration()
  if (boundTabId !== tabId || boundGeneration !== generation) {
    const tab = await ext.tabs.get(tabId)
    await ext.tabs.update(tabId, { active: true })
    if (tab.windowId != null) await ext.windows.update(tab.windowId, { focused: true })
    await new Promise((resolve) => setTimeout(resolve, 50))
    await native.request('bind', { args: { url: tab.url ?? '', title: tab.title ?? '' } })
    boundTabId = tabId
    boundGeneration = generation
  }
  return native.request('execute', { op, args })
}

ext.tabs.onRemoved.addListener((tabId) => {
  if (!gate.onTabRemoved(tabId)) return
  boundTabId = null
  void native.request('stop')
  client.sendEvent('tab_closed')
})

ext.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as { type?: string; allowed?: boolean; relayUrl?: string; pairingToken?: string }
  if (msg.type === 'consent-response') {
    pendingConsent?.({ allowed: msg.allowed === true })
    return Promise.resolve({ ok: true })
  }
  if (msg.type === 'stop-task') {
    gate.stop()
    boundTabId = null
    void native.request('stop')
    client.sendEvent('stopped')
    return Promise.resolve({ ok: true })
  }
  if (msg.type === 'configure') {
    return applyPairing({ relayUrl: msg.relayUrl, pairingToken: msg.pairingToken }).then(() => ({ ok: true }))
  }
  if (msg.type === 'disconnect') {
    gate.stop()
    boundTabId = null
    void native.request('stop')
    return ext.storage.local.remove(['sessionToken', 'pairingToken']).then(() => {
      client.stop()
      return { ok: true }
    })
  }
  if (msg.type === 'open-firefox-control') {
    return native.request('openDesktop').then(() => ({ ok: true }))
  }
  if (msg.type === 'status') {
    return native.status().then((control) => ({
      state: client.getState(),
      controlledTab: gate.currentTab(),
      stopped: gate.isStopped(),
      hasControl: control.ready,
      controlReason: control.reason,
      extensionId: ext.runtime.id,
    }))
  }
  return undefined
})

client.start()
