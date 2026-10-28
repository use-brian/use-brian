/** Firefox My Browser background page: relay + consent + native companion. */
import { RelayClient } from './relay-client.js'
import { CommandQueue } from './command-queue.js'
import {
  TaskGate,
  CONSENT_PROMPT_TIMEOUT_MS,
  type ConsentOutcome,
  type ConsentPromptOptions,
} from './task-gate.js'
import { activeTabForConsent, eligibilityOf } from './tab-eligibility.js'
import { credentialsForConfigure, type PairRequest } from './pairing.js'
import { FirefoxNativeClient, FirefoxNativeError } from './firefox-native-client.js'
import { readBuildStamp } from './build-info.js'
import { isTabControlPreapproved } from './consent-preapproval.js'

const ext = (globalThis as unknown as { browser: typeof chrome }).browser
const native = new FirefoxNativeClient()
const commands = new CommandQueue()
let boundTabId: number | null = null
let boundGeneration = 0
let pendingConsent: ((res: { allowed: boolean }) => void) | null = null
let pendingConsentId: string | null = null

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

function promptForConsent(options: ConsentPromptOptions): Promise<ConsentOutcome> {
  return new Promise((resolve, reject) => {
    const promptId = crypto.randomUUID()
    let settled = false
    let targetTabId: number | null = null
    let promptReady = false
    let promptWindowId: number | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const current = (): boolean => !settled && pendingConsent === respond
    const closePromptWindow = (): void => {
      const windowId = promptWindowId
      promptWindowId = undefined
      if (windowId != null) void ext.windows.remove(windowId).catch(() => {})
    }
    const cleanup = (): void => {
      settled = true
      clearTimeout(timer)
      if (pendingConsent === respond) {
        pendingConsent = null
        pendingConsentId = null
      }
      closePromptWindow()
    }
    const finish = (outcome: ConsentOutcome): void => {
      if (!current()) return
      cleanup()
      resolve(outcome)
    }
    const respond = (res: { allowed: boolean }): void => {
      // Cancellation works during setup; only the displayed prompt may Allow.
      if (res.allowed && (!promptReady || targetTabId == null)) return
      finish(res.allowed && targetTabId != null
        ? { allowed: true, tabId: targetTabId }
        : { allowed: false, reason: 'denied' })
    }
    pendingConsent = respond
    pendingConsentId = promptId
    void (async () => {
      const activeTab = await activeTabForConsent((options) => ext.windows.getLastFocused(options))
      if (!current()) return
      const eligibility = eligibilityOf(activeTab?.url, { allowFirefoxNewTab: true })
      if (!eligibility.eligible) { finish({ allowed: false, reason: eligibility.reason }); return }
      if (activeTab?.id == null) { finish({ allowed: false, reason: 'no_active_tab' }); return }
      targetTabId = activeTab.id
      const preapproved = options.allowPreApproval && await isTabControlPreapproved(ext.storage.local)
      if (!current()) return
      if (preapproved) { finish({ allowed: true, tabId: targetTabId }); return }
      const promptWindow = await ext.windows.create({
        url: ext.runtime.getURL(`allow.html?host=${encodeURIComponent(hostOf(activeTab.url ?? ''))}&promptId=${encodeURIComponent(promptId)}`),
        type: 'popup',
        width: 380,
        height: 220,
        focused: true,
      })
      promptWindowId = promptWindow.id
      if (!current()) { closePromptWindow(); return }
      promptReady = true
      timer = setTimeout(() => finish({ allowed: false, reason: 'denied' }), CONSENT_PROMPT_TIMEOUT_MS)
    })().catch(error => {
      if (!current()) return
      cleanup()
      reject(error)
    })
  })
}

function cancelCommands(): void {
  commands.cancel()
  pendingConsent?.({ allowed: false })
  boundTabId = null
}

const gate = new TaskGate({ prompt: promptForConsent })
let relayWasReady = false

async function getStored<T = string>(key: string): Promise<T | null> {
  const obj = await ext.storage.local.get(key)
  return (obj[key] as T | undefined) ?? null
}

const client = new RelayClient({
  getUrl: () => getStored('relayUrl'),
  connect: (url) => new WebSocket(url) as unknown as import('./relay-client.js').WebSocketLike,
  getToken: async () => (await getStored('sessionToken')) ?? (await getStored('pairingToken')),
  getBuild: () => readBuildStamp(),
  onSessionToken: async (token) => {
    await ext.storage.local.set({ sessionToken: token })
    await ext.storage.local.remove('pairingToken')
  },
  onCommand: (cmd) => void handleCommand(cmd),
  onStateChange: (state) => {
    if (state === 'ready') {
      relayWasReady = true
    } else if (relayWasReady) {
      relayWasReady = false
      gate.endTask()
      cancelCommands()
      void native.request('stop').catch(() => {})
    }
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
    const data = cmd.op === 'stop'
      ? await executeOp(cmd.op, cmd.args)
      : await commands.run(async check => {
        try {
          const result = await executeOp(cmd.op, cmd.args, check)
          check()
          return result
        } catch (error) {
          check()
          throw error
        }
      })
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

async function executeOp(op: string, args: Record<string, unknown>, check: () => void = () => {}): Promise<unknown> {
  check()
  if (op === 'browserFillReference' || (op !== 'stop' && (await chrome.storage.local.get('protectedDisclosureLock')).protectedDisclosureLock)) {
    throw new FirefoxNativeError('Protected fill unavailable', 'protected_fill_denied')
  }
  check()
  if (op === 'stop') {
    gate.stop()
    cancelCommands()
    return native.request('stop')
  }
  if (op === 'fillForm') {
    throw new FirefoxNativeError('Batch form filling is not implemented in Firefox.', 'unsupported_browser')
  }
  if (op === 'openTab' || op === 'listTabs' || op === 'switchTab' || op === 'closeTab') {
    throw new FirefoxNativeError(
      'Multi-tab control is currently available in the Chrome and Edge extension only.',
      'unsupported_browser',
    )
  }
  const status = await native.status()
  check()
  if (!status.ready) {
    throw new FirefoxNativeError(
      status.reason === 'firefox_companion_missing'
        ? 'Install the Use Brian Firefox companion or open the desktop app to use My Browser in Firefox.'
        : 'Quit Firefox, then run use-brian-firefox start or choose Start Firefox for My Browser in the desktop app.',
      status.reason ?? 'firefox_restart_required',
    )
  }
  const tabId = await gate.requireTab()
  check()
  const generation = native.connectionGeneration()
  if (boundTabId !== tabId || boundGeneration !== generation) {
    const tab = await ext.tabs.get(tabId)
    check()
    await ext.tabs.update(tabId, { active: true })
    check()
    if (tab.windowId != null) {
      await ext.windows.update(tab.windowId, { focused: true })
      check()
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
    check()
    await native.request('bind', { args: { url: tab.url ?? '', title: tab.title ?? '' } })
    try { check() } catch (error) {
      // A late bind must not retain control after Stop won the setup race.
      await native.request('stop').catch(() => {})
      throw error
    }
    boundTabId = tabId
    boundGeneration = generation
  }
  check()
  return native.request('execute', { op, args })
}

ext.tabs.onRemoved.addListener((tabId) => {
  if (!gate.onTabRemoved(tabId)) return
  cancelCommands()
  void native.request('stop')
  client.sendEvent('tab_closed')
})

ext.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as {
    type?: string
    allowed?: boolean
    promptId?: string
    relayUrl?: string
    pairingToken?: string
    preapproveEnabled?: boolean
  }
  if (msg.type === 'consent-response') {
    if (typeof msg.promptId === 'string' && msg.promptId === pendingConsentId) {
      pendingConsent?.({ allowed: msg.allowed === true })
    }
    return Promise.resolve({ ok: true })
  }
  if (msg.type === 'stop-task') {
    gate.stop()
    cancelCommands()
    void native.request('stop')
    client.sendEvent('stopped')
    return Promise.resolve({ ok: true })
  }
  if (msg.type === 'consent-preapproval-changed') {
    if (msg.preapproveEnabled !== true) {
      gate.revokeConsent()
      cancelCommands()
      void native.request('stop')
    }
    return Promise.resolve({ ok: true })
  }
  if (msg.type === 'configure') {
    return applyPairing({ relayUrl: msg.relayUrl, pairingToken: msg.pairingToken }).then(() => ({ ok: true }))
  }
  if (msg.type === 'disconnect') {
    gate.stop()
    cancelCommands()
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
    return Promise.all([native.status(), readBuildStamp()]).then(([control, build]) => ({
      state: client.getState(),
      controlledTab: gate.currentTab(),
      stopped: gate.isStopped(),
      hasControl: control.ready,
      controlReason: control.reason,
      build,
      staleBuild: client.isBuildStale(),
      extensionId: ext.runtime.id,
    }))
  }
  return undefined
})

client.start()
