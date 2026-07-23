/** Popup UI: connect/disconnect the relay pairing + the persistent Stop (P1.7). */
import { statusLine, type PopupStatus } from './popup-status.js'

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`missing #${id}`)
  return node as T
}

const statusBox = el<HTMLDivElement>('status')
const statusText = el<HTMLSpanElement>('status-text')
const relayUrlInput = el<HTMLInputElement>('relay-url')
const tokenInput = el<HTMLInputElement>('pairing-token')

async function refreshStatus(): Promise<void> {
  const status = ((await chrome.runtime.sendMessage({ type: 'status' })) ?? {}) as PopupStatus
  // "Ready" is the socket AND the gate: a held Stop is not a working browser,
  // so it must not paint the green state either.
  statusBox.classList.toggle('ready', status.state === 'ready' && !status.stopped)
  statusText.textContent = statusLine(status)
}

async function loadStored(): Promise<void> {
  const stored = await chrome.storage.local.get(['relayUrl'])
  if (typeof stored.relayUrl === 'string') relayUrlInput.value = stored.relayUrl
}

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
