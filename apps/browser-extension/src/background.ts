/**
 * MV3 background service worker — wires the relay client, the consent gate,
 * and the CDP executor into the P1.2 command loop. The extension is a
 * governed backend: it executes one discrete relay command at a time in the
 * one tab the user allowed, and the Stop button always wins.
 */
import { RelayClient } from './relay-client.js'
import { TabExecutor, ExecutorError, isDetachedError, retryableAfterReattach } from './executor.js'
import { TaskGate, CONSENT_PROMPT_TIMEOUT_MS } from './task-gate.js'

const executor = new TabExecutor()

// ── Consent prompt: a small extension window with Allow / Deny ──

let pendingConsent: ((res: { allowed: boolean; tabId: number | null }) => void) | null = null

async function promptForConsent(): Promise<{ allowed: boolean; tabId: number | null }> {
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (!activeTab?.id || activeTab.url?.startsWith('chrome://')) {
    return { allowed: false, tabId: null }
  }
  const targetTabId = activeTab.id
  await chrome.windows.create({
    url: chrome.runtime.getURL(`allow.html?host=${encodeURIComponent(hostOf(activeTab.url ?? ''))}`),
    type: 'popup',
    width: 380,
    height: 220,
    focused: true,
  })
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingConsent = null
      resolve({ allowed: false, tabId: null })
    }, CONSENT_PROMPT_TIMEOUT_MS)
    pendingConsent = (res) => {
      clearTimeout(timer)
      pendingConsent = null
      resolve({ allowed: res.allowed, tabId: res.allowed ? targetTabId : null })
    }
  })
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

const gate = new TaskGate({ prompt: promptForConsent })

// ── Relay connection ───────────────────────────────────────────

async function getStored<T = string>(key: string): Promise<T | null> {
  const obj = await chrome.storage.local.get(key)
  return (obj[key] as T | undefined) ?? null
}

const client = new RelayClient({
  getUrl: () => getStored('relayUrl'),
  connect: (url) => new WebSocket(url) as unknown as import('./relay-client.js').WebSocketLike,
  getToken: async () => (await getStored('sessionToken')) ?? (await getStored('pairingToken')),
  onSessionToken: async (token) => {
    await chrome.storage.local.set({ sessionToken: token })
    await chrome.storage.local.remove('pairingToken')
  },
  onCommand: (cmd) => void handleCommand(cmd),
  onStateChange: (state) => {
    void chrome.action.setBadgeText({ text: state === 'ready' ? 'ON' : '' })
    void chrome.action.setBadgeBackgroundColor({ color: '#16a34a' })
  },
})

async function startClient(): Promise<void> {
  client.start()
}

// ── Command loop ───────────────────────────────────────────────

async function handleCommand(cmd: { id: string; op: string; args: Record<string, unknown> }): Promise<void> {
  try {
    const data = await executeOp(cmd.op, cmd.args)
    client.sendResult({ id: cmd.id, ok: true, data })
  } catch (err) {
    const code =
      err instanceof ExecutorError
        ? err.code
        : ((err as { code?: string })?.code ?? 'backend_error')
    client.sendResult({
      id: cmd.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      code,
    })
  }
}

async function executeOp(op: string, args: Record<string, unknown>): Promise<unknown> {
  if (op === 'stop') {
    gate.stop()
    await executor.detach()
    return { stopped: true }
  }
  try {
    return await dispatch(op, args)
  } catch (err) {
    // Chrome can drop the CDP session mid-command. Re-attaching costs one
    // round trip and the gate still governs it (a revoked consent re-prompts),
    // so recover once rather than handing the model a dead browser — but only
    // for ops that cannot double-fire. See `retryableAfterReattach`.
    if (!isDetachedError(err) || !retryableAfterReattach(op)) throw err
    return await dispatch(op, args)
  }
}

async function dispatch(op: string, args: Record<string, unknown>): Promise<unknown> {
  const tabId = await gate.requireTab()
  await executor.attach(tabId)
  switch (op) {
    case 'navigate':
      return executor.navigate(String(args.url ?? ''))
    case 'snapshot':
      return executor.snapshot()
    case 'click':
      await executor.click(String(args.ref ?? ''))
      return { clicked: true }
    case 'type':
      await executor.type(String(args.ref ?? ''), String(args.text ?? ''))
      return { typed: true }
    case 'currentUrl':
      return executor.currentUrl()
    default:
      throw new ExecutorError(`Unknown op ${op}`, 'backend_error')
  }
}

// ── Chrome event wiring ────────────────────────────────────────

/**
 * Chrome ended the debugging session. Without this the executor keeps its
 * cached tab id, `attach()` short-circuits on it, and every later CDP op fails
 * with "Debugger is not attached" forever while `currentUrl` (no CDP) keeps
 * working — the exact half-dead state seen in prod on 2026-07-22.
 */
chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId
  if (tabId == null || !executor.onDetached(tabId)) return
  if (reason === 'canceled_by_user') {
    // The user dismissed Chrome's own debugging banner. Treat it as a refusal:
    // ask again through our Allow window instead of re-attaching behind them.
    gate.revokeConsent()
    client.sendEvent('detached')
  }
})

chrome.tabs.onRemoved.addListener((tabId) => {
  if (gate.onTabRemoved(tabId)) {
    void executor.detach()
    client.sendEvent('tab_closed')
  }
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const msg = message as { type?: string; allowed?: boolean; relayUrl?: string; pairingToken?: string }
  if (msg.type === 'consent-response') {
    pendingConsent?.({ allowed: msg.allowed === true, tabId: null })
    sendResponse({ ok: true })
  } else if (msg.type === 'stop-task') {
    gate.stop()
    void executor.detach()
    client.sendEvent('stopped')
    sendResponse({ ok: true })
  } else if (msg.type === 'configure') {
    void (async () => {
      await chrome.storage.local.set({
        relayUrl: msg.relayUrl,
        ...(msg.pairingToken ? { pairingToken: msg.pairingToken } : {}),
      })
      await chrome.storage.local.remove('sessionToken')
      client.stop()
      await startClient()
      sendResponse({ ok: true })
    })()
    return true // async sendResponse
  } else if (msg.type === 'disconnect') {
    void chrome.storage.local.remove(['sessionToken', 'pairingToken'])
    client.stop()
    sendResponse({ ok: true })
  } else if (msg.type === 'status') {
    sendResponse({
      state: client.getState(),
      controlledTab: gate.currentTab(),
      stopped: gate.isStopped(),
    })
  }
  return undefined
})

void startClient()
