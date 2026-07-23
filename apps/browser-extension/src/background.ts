/**
 * MV3 background service worker — wires the relay client, the consent gate,
 * and the CDP executor into the P1.2 command loop. The extension is a
 * governed backend: it executes one discrete relay command at a time in the
 * one tab the user allowed, and the Stop button always wins.
 */
import { RelayClient } from './relay-client.js'
import { TabExecutor, ExecutorError, isDetachedError, retryableAfterReattach } from './executor.js'
import { TaskGate, CONSENT_PROMPT_TIMEOUT_MS, type ConsentOutcome } from './task-gate.js'
import { eligibilityOf } from './tab-eligibility.js'
import { credentialsForConfigure, isTrustedPairingOrigin, type PairRequest } from './pairing.js'
import { hasBrowserControl } from './browser-control-permission.js'

const executor = new TabExecutor()

/**
 * Open the browser-control permission window. The prompt itself cannot be
 * raised from here — `chrome.permissions.request()` needs a user gesture in an
 * extension context — so this opens the one page that has a button to do it.
 * Sized like the consent window so the two read as the same family.
 */
async function openGrantWindow(): Promise<void> {
  await chrome.windows.create({
    url: chrome.runtime.getURL('grant.html'),
    type: 'popup',
    width: 400,
    height: 250,
    focused: true,
  })
}

// ── Consent prompt: a small extension window with Allow / Deny ──

let pendingConsent: ((res: { allowed: boolean }) => void) | null = null

async function promptForConsent(): Promise<ConsentOutcome> {
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  // An unattachable page is NOT a refusal. Reporting it as one told users they
  // had declined a prompt never shown, and sent the assistant chasing a consent
  // problem instead of saying "switch to the page you want me to work on".
  const eligibility = eligibilityOf(activeTab?.url)
  if (!eligibility.eligible) return { allowed: false, reason: eligibility.reason }
  if (activeTab?.id == null) return { allowed: false, reason: 'no_active_tab' }

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
      resolve({ allowed: false, reason: 'denied' })
    }, CONSENT_PROMPT_TIMEOUT_MS)
    pendingConsent = (res) => {
      clearTimeout(timer)
      pendingConsent = null
      resolve(
        res.allowed ? { allowed: true, tabId: targetTabId } : { allowed: false, reason: 'denied' },
      )
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

/**
 * The one path that writes pairing credentials, shared by the popup's Connect
 * and by one-click pairing from the web app. `credentialsForConfigure` decides
 * what survives — critically, a Connect with no new token keeps the live
 * session instead of wiping it.
 */
async function applyPairing(req: PairRequest): Promise<void> {
  const { set, remove } = credentialsForConfigure(req)
  if (Object.keys(set).length > 0) await chrome.storage.local.set(set)
  if (remove.length > 0) await chrome.storage.local.remove(remove)
  client.stop()
  await startClient()
}

function pairingMatches(): string[] {
  return chrome.runtime.getManifest().externally_connectable?.matches ?? []
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
  // Browser control is an OPTIONAL permission now, so it can genuinely be
  // absent here. Say so in the one word the assistant can act on; without this
  // the first CDP call fails with Chrome's own "Cannot access" wording, which
  // reads like the website blocked us rather than "you have not allowed this
  // yet" — the same misdiagnosis the detach path exists to prevent.
  if (!(await hasBrowserControl())) {
    void openGrantWindow()
    throw new ExecutorError(
      'Use Brian is not allowed to manage this browser yet. Allow it in the window that just opened, or from the extension popup.',
      'no_browser_permission',
    )
  }
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
    pendingConsent?.({ allowed: msg.allowed === true })
    sendResponse({ ok: true })
  } else if (msg.type === 'stop-task') {
    gate.stop()
    void executor.detach()
    client.sendEvent('stopped')
    sendResponse({ ok: true })
  } else if (msg.type === 'configure') {
    void (async () => {
      await applyPairing({ relayUrl: msg.relayUrl, pairingToken: msg.pairingToken })
      sendResponse({ ok: true })
    })()
    return true // async sendResponse
  } else if (msg.type === 'disconnect') {
    void chrome.storage.local.remove(['sessionToken', 'pairingToken'])
    client.stop()
    sendResponse({ ok: true })
  } else if (msg.type === 'status') {
    void (async () => {
      sendResponse({
        state: client.getState(),
        controlledTab: gate.currentTab(),
        stopped: gate.isStopped(),
        // Whether the user has granted browser control. The popup paints its
        // Allow button off this, so a paired-but-not-allowed install stops
        // claiming it is ready to work.
        hasControl: await hasBrowserControl(),
        // Shown in the popup so a self-hoster can point their own deployment at
        // this install without digging through chrome://extensions.
        extensionId: chrome.runtime.id,
      })
    })()
    return true // async sendResponse
  }
  return undefined
})

/**
 * One-click pairing: our own web app already holds the relay address and a
 * freshly minted code, so it hands them straight over instead of asking the
 * user to copy two values into the popup before a 10-minute token expires.
 *
 * `externally_connectable` in the manifest is what admits the sender at all;
 * the origin re-check below reads that same list, so the manifest stays the
 * single definition of who may pair this extension. The channel is inbound
 * only and carries nothing but pairing config — it grants the extension no
 * reach into any page, which is why it does not widen the §6 surface.
 */
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (!isTrustedPairingOrigin(sender.origin, pairingMatches())) {
    sendResponse({ ok: false, error: 'origin_not_allowed' })
    return undefined
  }
  const msg = message as { type?: string; relayUrl?: string; pairingToken?: string }
  if (msg.type === 'pair') {
    void (async () => {
      await applyPairing({ relayUrl: msg.relayUrl, pairingToken: msg.pairingToken })
      sendResponse({ ok: true })
    })()
    return true // async sendResponse
  }
  if (msg.type === 'status') {
    // Lets the connect panel say "installed but not paired" instead of
    // guessing from the relay's server-side view alone. `hasControl` adds the
    // third state the web app needs: paired, but not yet allowed to drive.
    void (async () => {
      sendResponse({
        ok: true,
        state: client.getState(),
        stopped: gate.isStopped(),
        hasControl: await hasBrowserControl(),
      })
    })()
    return true // async sendResponse
  }
  /**
   * The web app cannot raise Chrome's permission prompt itself — the API is
   * extension-only and needs a user gesture in an extension context. So the
   * sidebar's "Allow browser control" asks us to open the window that can.
   * This grants the sender nothing: it opens our own page and the user still
   * has to click Allow and then accept Chrome's own dialog.
   */
  if (msg.type === 'request-control') {
    void (async () => {
      if (await hasBrowserControl()) {
        sendResponse({ ok: true, hasControl: true })
        return
      }
      await openGrantWindow()
      sendResponse({ ok: true, hasControl: false, prompted: true })
    })()
    return true // async sendResponse
  }
  sendResponse({ ok: false, error: 'unsupported' })
  return undefined
})

void startClient()
