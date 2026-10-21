/**
 * MV3 background service worker — wires the relay client, the consent gate,
 * and the CDP executor into the P1.2 command loop. The extension is a
 * governed backend: it executes one discrete relay command at a time in the
 * profile-scoped tab set the user allowed, and the Stop button always wins.
 */
import { CommandQueue } from './command-queue.js'
import { RelayClient } from './relay-client.js'
import { TabExecutor, ExecutorError, isDetachedError, retryableAfterReattach } from './executor.js'
import {
  TaskGate,
  CONSENT_PROMPT_TIMEOUT_MS,
  type ConsentOutcome,
  type ConsentPromptOptions,
} from './task-gate.js'
import {
  activeTabForConsent,
  attachabilityOf,
  eligibilityOf,
  RESTRICTED_TAB_MESSAGE,
} from './tab-eligibility.js'
import { credentialsForConfigure, isTrustedPairingOrigin, type PairRequest } from './pairing.js'
import { hasBrowserControl } from './browser-control-permission.js'
import { readBuildStamp } from './build-info.js'
import { isTabControlPreapproved } from './consent-preapproval.js'
import type { LocalControlMode } from './protocol.js'

import { ProtectedFill, denied } from './protected-fill.js'
import { installAssistantChat, pairedChatIdentity, pageEvidence } from './assistant-chat.js'

const protectedFill = new ProtectedFill(chrome.storage.local)
const executor = new TabExecutor()
const commands = new CommandQueue()

// ── Consent prompt: a small extension window with Allow / Deny ──

let controlHadTask = false
let pendingConsent: ((res: { allowed: boolean }) => void) | null = null

async function promptForConsent(options: ConsentPromptOptions): Promise<ConsentOutcome> {
  controlHadTask = true
  const activeTab = await activeTabForConsent((options) => chrome.windows.getLastFocused(options))
  // An unattachable page is NOT a refusal. Reporting it as one told users they
  // had declined a prompt never shown, and sent the assistant chasing a consent
  // problem instead of saying "switch to the page you want me to work on".
  const eligibility = eligibilityOf(activeTab?.url)
  if (!eligibility.eligible) return { allowed: false, reason: eligibility.reason }
  if (activeTab?.id == null) return { allowed: false, reason: 'no_active_tab' }

  const targetTabId = activeTab.id
  if (options.allowPreApproval && await isTabControlPreapproved(chrome.storage.local)) {
    return { allowed: true, tabId: targetTabId }
  }
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
let relayWasReady = false
let assistantChat: ReturnType<typeof installAssistantChat> | undefined
let pairingWrites: Promise<unknown> = Promise.resolve()
function pairingWrite<T>(fn: () => Promise<T>): Promise<T> {
  const result = pairingWrites.then(fn); pairingWrites = result.catch(() => undefined); return result
}

async function stopTask(): Promise<void> {
  protectedFill.approve(false)
  pendingConsent?.({ allowed: false })
  await clearTask(gate.stop())
}

async function clearTask(createdTabIds: number[]): Promise<void> {
  commands.cancel()
  protectedFill.approve(false)
  await executor.detach()
  if (createdTabIds.length > 0) {
    await chrome.tabs.remove(createdTabIds).catch(() => undefined)
  }
}

// ── Relay connection ───────────────────────────────────────────

async function getStored<T = string>(key: string): Promise<T | null> {
  const obj = await chrome.storage.local.get(key)
  return (obj[key] as T | undefined) ?? null
}

const client = new RelayClient({
  getUrl: () => getStored('relayUrl'),
  connect: (url) => new WebSocket(url) as unknown as import('./relay-client.js').WebSocketLike,
  getToken: async () => (await getStored('sessionToken')) ?? (await getStored('pairingToken')),
  getBuild: () => readBuildStamp(),
  capabilities: { protectedFillV1: true },
  onSessionToken: token => pairingWrite(async () => {
    const active = pairedChatIdentity((await getStored('sessionToken')) ?? (await getStored('pairingToken')), 0)
    const incoming = pairedChatIdentity(token, 0)
    if (!active || !incoming || JSON.stringify(active) !== JSON.stringify(incoming)) return
    await protectedFill.allowCredential(token, 'browser-ext-session')
    await chrome.storage.local.set({ sessionToken: token })
    await chrome.storage.local.remove('pairingToken')
  }),
  onCommand: (cmd) => {
    // Enqueue at receipt, so Stop invalidates the actual waiting generation.
    // An outer promise chain here would let stale commands enqueue AFTER Stop.
    void handleCommand(cmd).catch(() => undefined)
  },
  onStateChange: (state) => {
    if (state === 'ready') {
      relayWasReady = true
    } else if (relayWasReady) {
      // A lost control plane must revoke browser control even if the relay
      // process restarts and forgets a queued Stop.
      relayWasReady = false
      // A transport interruption ends the active task, but it is not the
      // user's Stop action. Once the relay recovers, local pre-approval may
      // authorize the next task as configured.
      void clearTask(gate.endTask())
    }
    assistantChat?.refresh()
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
  return pairingWrite(async () => {
    if (req.automatic && (gate.currentTab() !== null || pendingConsent)) throw new Error('busy')
    if (req.pairingToken?.trim()) await protectedFill.allowCredential(req.pairingToken.trim(), 'browser-ext-pair')
    if (req.automatic && (gate.currentTab() !== null || pendingConsent)) throw new Error('busy')
    if (req.pairingToken?.trim()) {
      const before = pairedChatIdentity((await getStored('sessionToken')) ?? (await getStored('pairingToken')), 0)
      const after = pairedChatIdentity(req.pairingToken.trim(), 0)
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        controlHadTask = false
        assistantChat?.invalidate()
        client.sendEvent('stopped')
        client.stop()
        await stopTask()
        await commands.run(async () => undefined)
      }
    }
    const { set, remove } = credentialsForConfigure(req)
    if (Object.keys(set).length > 0) await chrome.storage.local.set(set)
    if (remove.length > 0) await chrome.storage.local.remove(remove)
    client.stop()
    await startClient()
  })
}

function pairingMatches(): string[] {
  return chrome.runtime.getManifest().externally_connectable?.matches ?? []
}

// ── Command loop ───────────────────────────────────────────────

async function handleCommand(cmd: {
  id: string
  op: string
  args: Record<string, unknown>
  controlMode: LocalControlMode
}): Promise<void> {
  try {
    // Stop bypasses the queue and invalidates work submitted before it.
    const data = cmd.op === 'stop'
      ? await executeOp(cmd.op, cmd.args, cmd.controlMode)
      : await commands.run(async check => {
        const result = await executeOp(cmd.op, cmd.args, cmd.controlMode, check)
        check() // Do not publish a stale in-flight observation after Stop.
        return result
      })
    client.sendResult({ id: cmd.id, ok: true, data })
  } catch (err) {
    let redact = true
    try { redact = cmd.op === 'browserFillReference' || await protectedFill.locked() } catch { /* Unknown lock state fails closed. */ }
    if (redact) {
      client.sendResult({id:cmd.id, ok:false, error:'Protected fill unavailable', code:'protected_fill_denied'})
      return
    }
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

async function executeOp(
  op: string,
  args: Record<string, unknown>,
  controlMode: LocalControlMode,
  check: () => void = () => {},
): Promise<unknown> {
  if (op === 'stop') {
    await stopTask()
    return { stopped: true }
  }
  if (await protectedFill.locked()) throw denied()
  check()
  try {
    return await dispatch(op, args, controlMode, check)
  } catch (err) {
    // Chrome can drop the CDP session mid-command. Re-attaching costs one
    // round trip and the gate still governs it (a revoked consent re-prompts),
    // so recover once rather than handing the model a dead browser — but only
    // for ops that cannot double-fire. See `retryableAfterReattach`.
    check()
    if (!isDetachedError(err) || !retryableAfterReattach(op)) throw err
    return await dispatch(op, args, controlMode, check)
  }
}

/**
 * Attach to the consented tab, refusing first if the tab is no longer one CDP
 * will take.
 *
 * `requireTab()` only consults the user when there is no live consent; inside
 * the 10-minute idle window it returns the cached tab id having re-checked
 * nothing, and the post-detach retry in `executeOp` re-attaches without asking
 * either. Both paths therefore skip `promptForConsent`, which is where
 * eligibility was being enforced — so the tab the user allowed on a website
 * could be a settings or extension page by the time we attach to it.
 *
 * Consent is dropped rather than kept, so the next command prompts against
 * whatever the user is actually looking at; keeping it would make the same
 * command fail for the rest of the idle window even after they switched back.
 * `stop()` would be disproportionate — it has no resume path.
 */
async function attachToEligibleTab(tabId: number, check: () => void): Promise<void> {
  check()
  let url: string | undefined
  try {
    url = (await chrome.tabs.get(tabId)).url
  } catch {
    // Tab is gone. Let `attach` produce the authoritative failure.
  }
  check()
  if (!attachabilityOf(url)) {
    gate.revokeConsent()
    throw new ExecutorError(RESTRICTED_TAB_MESSAGE, 'no_eligible_tab')
  }
  await executor.attach(tabId)
  try { check() } catch (error) {
    // Stop can race an already-issued asynchronous debugger attachment.
    await executor.detach()
    throw error
  }
}

async function dispatch(
  op: string,
  args: Record<string, unknown>,
  controlMode: LocalControlMode,
  check: () => void = () => {},
): Promise<unknown> {
  if (op === 'browserFillReference') {
    return protectedFill.fill(args, () => gate.entries(controlMode).map(t => t.tabId), async request => {
      if (!(await hasBrowserControl())) throw denied()
      check()
      const tabId = await gate.requireTab(controlMode)
      check()
      if (!(await chrome.tabs.get(tabId)).active) throw denied()
      await attachToEligibleTab(tabId, check)
      const assign = await executor.prepareProtectedFill(request.destinationOrigin, request.items.map(i => i.ref))
      check()
      return assign
    }, check)
  }
  // Required in the manifest. If it is absent, this install is malformed;
  // report that honestly instead of blaming the website.
  if (!(await hasBrowserControl())) {
    throw new ExecutorError(
      'Use Brian is missing its required browser-control permission. Reload or reinstall the extension.',
      'no_browser_permission',
    )
  }
  check()
  const tabId = await gate.requireTab(controlMode)
  check()
  if (op === 'openTab') return openTab(args, controlMode, check)
  if (op === 'listTabs') return listTabs(controlMode, check)
  if (op === 'switchTab') return switchTab(args, controlMode, check)
  if (op === 'closeTab') return closeTab(args, controlMode, check)
  await attachToEligibleTab(tabId, check)
  check()
  switch (op) {
    case 'navigate':
      return executor.navigate(String(args.url ?? ''))
    case 'snapshot':
      return executor.snapshot(args.mode === 'full' ? 'full' : 'interactive')
    case 'click':
      await executor.click(String(args.ref ?? ''))
      return { clicked: true }
    case 'fillForm':
      return executor.fillForm(args)
    case 'type':
      await executor.type(String(args.ref ?? ''), String(args.text ?? ''))
      return { typed: true }
    case 'currentUrl':
      return executor.currentUrl()
    case 'captureState':
      return executor.captureState(String(args.site ?? ''))
    case 'captureFrame':
      return executor.captureFrame()
    case 'takeoverInput':
      await executor.takeoverInput(args.event as Parameters<TabExecutor['takeoverInput']>[0])
      return { forwarded: true }
    default:
      throw new ExecutorError(`Unknown op ${op}`, 'backend_error')
  }
}

function webUrl(value: unknown): string {
  const raw = String(value ?? '')
  try {
    const parsed = new URL(raw)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString()
  } catch {
    // Use our own stable message rather than Chrome's vendor wording.
  }
  throw new ExecutorError('Only absolute http(s) URLs can be opened in a new tab.', 'backend_error')
}

async function openTab(
  args: Record<string, unknown>,
  _controlMode: LocalControlMode,
  check: () => void,
): Promise<{ tabId: string; url: string; title: string }> {
  check()
  if (!gate.canOpenTaskTab()) {
    throw new ExecutorError('A task may open at most 8 browser tabs.', 'tab_limit')
  }
  const tab = await chrome.tabs.create({ url: webUrl(args.url), active: true })
  try { check() } catch (error) {
    // Stop's cleanup list was collected before this create completed. Only this
    // newly-created tab belongs to us; never close a switch target on cancellation.
    if (tab.id != null) await chrome.tabs.remove(tab.id).catch(() => undefined)
    throw error
  }
  if (tab.id == null) throw new ExecutorError('Chrome did not create the requested tab.', 'backend_error')
  const handle = gate.registerCreatedTab(tab.id, true)
  await attachToEligibleTab(tab.id, check)
  const current = await chrome.tabs.get(tab.id)
  check()
  return { tabId: handle, url: current.url ?? '', title: current.title ?? '' }
}

async function eligibleTabs(controlMode: LocalControlMode, check: () => void): Promise<chrome.tabs.Tab[]> {
  check()
  if (controlMode === 'full_browser') {
    const all = await chrome.tabs.query({})
    check()
    return all.filter((tab) => tab.id != null && !tab.incognito && attachabilityOf(tab.url))
  }
  const tabs: chrome.tabs.Tab[] = []
  for (const entry of gate.entries(controlMode)) {
    try {
      const tab = await chrome.tabs.get(entry.tabId)
      check()
      if (!tab.incognito && attachabilityOf(tab.url)) tabs.push(tab)
    } catch {
      check() // A cancelled read must not mutate the gate (or continue the loop).
      gate.onTabRemoved(entry.tabId)
    }
  }
  return tabs
}

async function listTabs(controlMode: LocalControlMode, check: () => void): Promise<{
  tabs: Array<{ id: string; title: string; url: string; active: boolean; taskOwned: boolean }>
  activeTabId: string | null
}> {
  const tabs = await eligibleTabs(controlMode, check)
  check()
  const visible = tabs.map((tab) => {
    const id = tab.id as number
    const handle = gate.handleForTab(id) ?? gate.registerFullTab(id)
    return {
      id: handle,
      title: tab.title ?? '',
      url: tab.url ?? '',
      active: gate.currentTab() === id,
      taskOwned: gate.isTaskOwnedTab(id),
    }
  })
  return { tabs: visible, activeTabId: gate.currentHandle() }
}

async function switchTab(
  args: Record<string, unknown>,
  controlMode: LocalControlMode,
  check: () => void,
): Promise<{ tabId: string; url: string; title: string }> {
  check()
  const handle = String(args.tabId ?? '')
  const tabId = gate.selectHandle(handle, controlMode)
  const tab = await chrome.tabs.get(tabId)
  check()
  if (!attachabilityOf(tab.url) || tab.incognito) {
    gate.onTabRemoved(tabId)
    throw new ExecutorError(RESTRICTED_TAB_MESSAGE, 'no_eligible_tab')
  }
  await chrome.tabs.update(tabId, { active: true })
  check()
  if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true })
  check()
  await attachToEligibleTab(tabId, check)
  const current = await chrome.tabs.get(tabId)
  check()
  return { tabId: handle, url: current.url ?? '', title: current.title ?? '' }
}

async function closeTab(
  args: Record<string, unknown>,
  controlMode: LocalControlMode,
  check: () => void,
): Promise<{ closed: boolean; activeTabId: string | null }> {
  check()
  const tabId = gate.selectHandle(String(args.tabId ?? ''), controlMode)
  const wasCurrent = gate.currentTab() === tabId
  if (wasCurrent) await executor.detach()
  check()
  await chrome.tabs.remove(tabId)
  check()
  gate.onTabRemoved(tabId)
  return { closed: true, activeTabId: gate.currentHandle() }
}

// ── Chrome event wiring ────────────────────────────────────────

chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId
  if (tabId == null || !executor.onDetached(tabId)) return
  if (reason === 'canceled_by_user') {
    // The user dismissed Chrome's own debugging banner. Treat it as a refusal:
    // ask again through our per-task Allow window instead of re-attaching.
    gate.revokeConsent({ requireManualApproval: true })
    client.sendEvent('detached')
  }
})

chrome.tabs.onRemoved.addListener((tabId) => {
  if (gate.onTabRemoved(tabId)) {
    void executor.detach()
    if (gate.currentTab() == null) client.sendEvent('tab_closed')
  }
})

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id != null && tab.openerTabId != null) protectedFill.trackTab(tab.id, tab.openerTabId)
  if (tab.id == null || tab.openerTabId == null || !gate.isAuthorizedTab(tab.openerTabId)) return
  if (!gate.canOpenTaskTab()) {
    // The site opened this tab from a task-owned page, so it belongs to the
    // task even though it exceeded the bounded scope. Close it immediately
    // instead of leaving an untracked tab that Stop can no longer clean up.
    void chrome.tabs.remove(tab.id)
    return
  }
  gate.registerCreatedTab(tab.id, tab.active === true)
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (_sender.id !== chrome.runtime.id || !_sender.url?.startsWith(chrome.runtime.getURL(''))) return undefined
  const msg = message as {
    protectedApiBase?: string
    type?: string
    allowed?: boolean
    relayUrl?: string
    pairingToken?: string
    preapproveEnabled?: boolean
  }
  if (msg.type === 'protected-status') {
    void protectedFill.status().then(sendResponse)
    return true
  } else if (msg.type === 'protected-approval') {
    // This is a response to the active queued fill, not another queued job:
    // putting it behind fill would deadlock its approval wait.
    protectedFill.approve(msg.allowed === true)
    sendResponse({ok:true})
  } else if (msg.type === 'protected-recover-server') {
    if (_sender.url?.split('#')[0] !== chrome.runtime.getURL('popup.html') || msg.allowed !== true) {
      sendResponse({ok:false})
      return undefined
    }
    void commands.run(() => protectedFill.recoverServer())
      .then(status => sendResponse({ok:true, status}), () => sendResponse({ok:false}))
    return true
  } else if (msg.type === 'protected-recover-all-tabs') {
    // Broad destructive recovery has a separate, explicitly confirmed trusted UI
    // route. It is never a relay op, nor a boolean smuggled into normal completion.
    if (_sender.url?.split('#')[0] !== chrome.runtime.getURL('popup.html') || msg.allowed !== true) {
      sendResponse({ok:false})
      return undefined
    }
    protectedFill.approve(false)
    void commands.run(() => protectedFill.complete(stopTask, true))
      .then(() => sendResponse({ok:true}), () => sendResponse({ok:false}))
    return true
  } else if (msg.type === 'protected-complete') {
    protectedFill.approve(false)
    void commands.run(() => protectedFill.complete(stopTask)).then(() => sendResponse({ok:true}), () => sendResponse({ok:false}))
    return true
  } else if (msg.type === 'protected-configure') {
    void (async () => {
      try {
        await protectedFill.configureApi(msg.protectedApiBase)
        sendResponse({ok:true})
      } catch { sendResponse({ok:false}) }
    })()
    return true
  } else if (msg.type === 'consent-response') {
    pendingConsent?.({ allowed: msg.allowed === true })
    sendResponse({ ok: true })
  } else if (msg.type === 'stop-task') {
    void stopTask()
    client.sendEvent('stopped')
    sendResponse({ ok: true })
  } else if (msg.type === 'consent-preapproval-changed') {
    if (msg.preapproveEnabled !== true) {
      gate.revokeConsent()
      void executor.detach()
    }
    sendResponse({ ok: true })
  } else if (msg.type === 'configure') {
    void (async () => {
      try {
        await applyPairing({ relayUrl: msg.relayUrl, pairingToken: msg.pairingToken })
        sendResponse({ ok: true })
      } catch { sendResponse({ok:false, error:'Protected fill unavailable', code:'protected_fill_denied'}) }
    })()
    return true // async sendResponse
  } else if (msg.type === 'disconnect') {
    void pairingWrite(async () => {
      assistantChat?.invalidate()
      client.sendEvent('stopped')
      client.stop()
      await stopTask()
      await commands.run(async () => undefined)
      await chrome.storage.local.remove(['sessionToken', 'pairingToken'])
    }).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }))
    return true
  } else if (msg.type === 'status') {
    void (async () => {
      sendResponse({
        state: client.getState(),
        controlledTab: gate.currentTab(),
        stopped: gate.isStopped(),
        // False means a malformed install: debugger is a required permission.
        hasControl: await hasBrowserControl(),
        // Which build is loaded, and whether the relay thinks it is behind.
        // Answering this used to require deriving the extension id from a
        // SHA256 of the folder path it was loaded from.
        build: await readBuildStamp(),
        staleBuild: client.isBuildStale(),
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
  const msg = message as { type?: string; relayUrl?: string; pairingToken?: string; automatic?: boolean }
  if (msg.type === 'pair') {
    void (async () => {
      try {
        await applyPairing({ relayUrl: msg.relayUrl, pairingToken: msg.pairingToken, automatic: msg.automatic === true })
        await chrome.storage.local.set({ assistantAppOrigin: sender.origin })
        sendResponse({ ok: true })
      } catch { sendResponse({ok:false, error:'Protected fill unavailable', code:'protected_fill_denied'}) }
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
        build: await readBuildStamp(),
        staleBuild: client.isBuildStale(),
      })
    })()
    return true // async sendResponse
  }
  if (msg.type === 'request-control') {
    void (async () => {
      const hasControl = await hasBrowserControl()
      sendResponse({ ok: hasControl, hasControl })
    })()
    return true // async sendResponse
  }
  sendResponse({ ok: false, error: 'unsupported' })
  return undefined
})

assistantChat = installAssistantChat({
  identity: async () => pairedChatIdentity((await getStored('sessionToken')) ?? (await getStored('pairingToken'))),
  ready: () => client.getState() === 'ready',
  accountStore: chrome.storage.session,
  installationId: async () => {
    const saved = await getStored('assistantBrowserInstallation')
    if (saved && /^[a-f0-9-]{36}$/.test(saved)) return saved
    const id = crypto.randomUUID()
    await chrome.storage.local.set({ assistantBrowserInstallation: id })
    return id
  },
  beforeAutomaticConnect: async () => {
    if (await protectedFill.locked()) throw denied()
    if (gate.currentTab() !== null || pendingConsent) throw new Error('busy')
  },
  controlState: async () => {
    if (pendingConsent) return { phase: 'waiting' }
    if (gate.isStopped()) return { phase: controlHadTask ? 'stopped' : 'idle' }
    const tabId = gate.currentTab()
    if (tabId === null) return { phase: 'idle' }
    const tab = await chrome.tabs.get(tabId).catch(() => null)
    if (!tab?.url || !attachabilityOf(tab.url)) return { phase: 'idle' }
    return { phase: 'active', host: hostOf(tab.url) }
  },
  appOrigin: () => getStored('assistantAppOrigin'),
  beforeAccountSwitch: async () => {
    if (await protectedFill.locked()) throw denied()
    client.sendEvent('stopped')
    client.stop()
    await stopTask()
    await commands.run(async () => undefined)
  },
  matches: pairingMatches,
  stop: async () => {
    const stopped = stopTask()
    client.sendEvent('stopped')
    await stopped
  },
  pageStillCurrent: async page => {
    const active = await activeTabForConsent(options => chrome.windows.getLastFocused(options))
    return !gate.isStopped() && !await protectedFill.locked() && active?.id === gate.currentTab() && active?.url === page.url
  },
  readPage: () => commands.run(async check => {
    if (await protectedFill.locked()) throw denied()
    check()
    const active = await activeTabForConsent(options => chrome.windows.getLastFocused(options))
    if (active?.id == null || active.incognito || !attachabilityOf(active.url)) throw new Error('no_eligible_tab')
    if (gate.currentTab() !== null && gate.currentTab() !== active.id) throw new Error('different_task_tab')
    const tabId = await gate.requireTab('task_tabs')
    check()
    if (tabId !== active.id) throw new Error('page_changed')
    await attachToEligibleTab(tabId, check)
    const snapshot = await executor.readPageContext()
    check()
    if (snapshot.url !== active.url) throw new Error('page_changed')
    return pageEvidence(snapshot)
  }),
})

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
void startClient()
