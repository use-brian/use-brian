/** Popup UI: connect/disconnect the relay pairing + the persistent Stop (P1.7). */
import { buildLine, buildWarning, statusLine, type PopupStatus } from './popup-status.js'
import { PREAPPROVE_TAB_CONTROL_KEY } from './consent-preapproval.js'

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`missing #${id}`)
  return node as T
}

const statusBox = el<HTMLDivElement>('status')
const statusText = el<HTMLSpanElement>('status-text')
const relayUrlInput = el<HTMLInputElement>('relay-url')
const tokenInput = el<HTMLInputElement>('pairing-token')
const buildWarningBox = el<HTMLDivElement>('build-warning')
const buildLineBox = el<HTMLParagraphElement>('build-line')
const preapproveInput = el<HTMLInputElement>('preapprove-tab-control')

async function refreshStatus(): Promise<void> {
  const status = ((await chrome.runtime.sendMessage({ type: 'status' })) ?? {}) as PopupStatus
  // "Ready" is the socket AND the gate AND the grant: a held Stop or a missing
  // browser-control permission is not a working browser, so neither may paint
  // the green state.
  const granted = status.hasControl !== false
  statusBox.classList.toggle('ready', status.state === 'ready' && !status.stopped && granted)
  statusText.textContent = statusLine(status)
  // Staleness does NOT clear the green dot: the socket really is up. It is a
  // second fact about the install, shown beside the first rather than instead.
  const warning = buildWarning(status)
  buildWarningBox.textContent = warning ?? ''
  buildWarningBox.hidden = warning === null
  buildLineBox.textContent = buildLine(status)
}

async function loadStored(): Promise<void> {
  const stored = await chrome.storage.local.get(['relayUrl', PREAPPROVE_TAB_CONTROL_KEY])
  if (typeof stored.relayUrl === 'string') relayUrlInput.value = stored.relayUrl
  preapproveInput.checked = stored[PREAPPROVE_TAB_CONTROL_KEY] === true
}

preapproveInput.addEventListener('change', () => {
  const enabled = preapproveInput.checked
  preapproveInput.disabled = true
  void (async () => {
    try {
      await chrome.storage.local.set({ [PREAPPROVE_TAB_CONTROL_KEY]: enabled })
      await chrome.runtime.sendMessage({
        type: 'consent-preapproval-changed',
        preapproveEnabled: enabled,
      })
    } catch {
      await chrome.storage.local.set({ [PREAPPROVE_TAB_CONTROL_KEY]: !enabled }).catch(() => undefined)
      preapproveInput.checked = !enabled
    } finally {
      preapproveInput.disabled = false
    }
  })()
})

el<HTMLButtonElement>('connect').addEventListener('click', () => {
  void (async () => {
    await chrome.runtime.sendMessage({
      type: 'configure',
      relayUrl: relayUrlInput.value.trim(),
      pairingToken: tokenInput.value.trim() || undefined,
    })
    tokenInput.value = ''
    setTimeout(() => void refreshStatus(), 400)
  })()
})

el<HTMLButtonElement>('disconnect').addEventListener('click', () => {
  void (async () => {
    await chrome.runtime.sendMessage({ type: 'disconnect' })
    await refreshStatus()
  })()
})

el<HTMLButtonElement>('stop').addEventListener('click', () => {
  void (async () => {
    await chrome.runtime.sendMessage({ type: 'stop-task' })
    await refreshStatus()
  })()
})

void loadStored()
void refreshStatus()
setInterval(() => void refreshStatus(), 2_000)
