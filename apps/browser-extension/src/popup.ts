/** Popup UI: connect/disconnect the relay pairing + the persistent Stop (P1.7). */
import { statusLine, type PopupStatus } from './popup-status.js'
import { requestBrowserControl } from './browser-control-permission.js'

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`missing #${id}`)
  return node as T
}

const statusBox = el<HTMLDivElement>('status')
const statusText = el<HTMLSpanElement>('status-text')
const relayUrlInput = el<HTMLInputElement>('relay-url')
const tokenInput = el<HTMLInputElement>('pairing-token')
const grantRow = el<HTMLDivElement>('grant-row')

async function refreshStatus(): Promise<void> {
  const status = ((await chrome.runtime.sendMessage({ type: 'status' })) ?? {}) as PopupStatus
  // "Ready" is the socket AND the gate AND the grant: a held Stop or a missing
  // browser-control permission is not a working browser, so neither may paint
  // the green state.
  const granted = status.hasControl !== false
  statusBox.classList.toggle('ready', status.state === 'ready' && !status.stopped && granted)
  statusText.textContent = statusLine(status)
  grantRow.hidden = granted
}

async function loadStored(): Promise<void> {
  const stored = await chrome.storage.local.get(['relayUrl'])
  if (typeof stored.relayUrl === 'string') relayUrlInput.value = stored.relayUrl
}

el<HTMLButtonElement>('grant').addEventListener('click', () => {
  // Nothing may be awaited before the request: an await spends the user gesture
  // Chrome requires, and the prompt throws instead of opening.
  void requestBrowserControl().then(() => refreshStatus())
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
