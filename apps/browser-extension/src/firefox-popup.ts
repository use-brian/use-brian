/** Firefox popup with the same layout/actions as the Chromium popup. */
import { buildLine, buildWarning } from './popup-status.js'

const ext = (globalThis as unknown as { browser: typeof chrome }).browser

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`missing #${id}`)
  return node as T
}

type Status = {
  state?: string
  controlledTab?: number | null
  stopped?: boolean
  hasControl?: boolean
  controlReason?: string
  build?: string | null
  staleBuild?: boolean
}

const STATE_LABELS: Record<string, string> = {
  ready: 'Connected. The assistant can request browser tasks.',
  connecting: 'Connecting to the relay...',
  disconnected: 'Disconnected. Reconnecting automatically.',
  unpaired: 'Not paired. Paste a pairing token from Use Brian settings.',
  replaced: 'Another browser took over this pairing. Press Connect to take it back.',
}

const statusBox = el<HTMLDivElement>('status')
const statusText = el<HTMLSpanElement>('status-text')
const relayUrlInput = el<HTMLInputElement>('relay-url')
const tokenInput = el<HTMLInputElement>('pairing-token')
const grantRow = el<HTMLDivElement>('grant-row')
const buildWarningBox = el<HTMLDivElement>('build-warning')
const buildLineBox = el<HTMLParagraphElement>('build-line')

function statusLine(status: Status): string {
  if (status.hasControl === false) {
    return status.controlReason === 'firefox_companion_missing'
      ? 'Use Brian desktop is required. Open it below to finish Firefox setup.'
      : 'Firefox must be started for My Browser. Open Use Brian below, then restart Firefox.'
  }
  if (status.stopped) return 'Task stopped. The next request will ask your permission again.'
  return `${STATE_LABELS[status.state ?? 'unpaired'] ?? status.state ?? 'unpaired'}${
    status.controlledTab != null ? ' Controlling one allowed tab.' : ''
  }`
}

async function refreshStatus(): Promise<void> {
  const status = ((await ext.runtime.sendMessage({ type: 'status' })) ?? {}) as Status
  const ready = status.hasControl !== false
  statusBox.classList.toggle('ready', status.state === 'ready' && !status.stopped && ready)
  statusText.textContent = statusLine(status)
  grantRow.hidden = ready
  // Same two facts as the Chromium popup, from the same pure helpers: the
  // Firefox wording differs for control state, never for build state.
  const warning = buildWarning(status)
  buildWarningBox.textContent = warning ?? ''
  buildWarningBox.hidden = warning === null
  buildLineBox.textContent = buildLine(status)
}

async function loadStored(): Promise<void> {
  const stored = await ext.storage.local.get(['relayUrl'])
  if (typeof stored.relayUrl === 'string') relayUrlInput.value = stored.relayUrl
}

el<HTMLButtonElement>('grant').addEventListener('click', () => {
  void ext.runtime
    .sendMessage({ type: 'open-firefox-control' })
    .then(() => window.close())
    .catch(() => {
      statusText.textContent = 'Open the Use Brian desktop app, then choose Start Firefox for My Browser.'
    })
})
el<HTMLButtonElement>('connect').addEventListener('click', () => {
  void ext.runtime
    .sendMessage({
      type: 'configure',
      relayUrl: relayUrlInput.value.trim(),
      pairingToken: tokenInput.value.trim() || undefined,
    })
    .then(() => {
      tokenInput.value = ''
      setTimeout(() => void refreshStatus(), 400)
    })
})
el<HTMLButtonElement>('disconnect').addEventListener('click', () => {
  void ext.runtime.sendMessage({ type: 'disconnect' }).then(() => refreshStatus())
})
el<HTMLButtonElement>('stop').addEventListener('click', () => {
  void ext.runtime.sendMessage({ type: 'stop-task' }).then(() => refreshStatus())
})

void loadStored()
void refreshStatus()
setInterval(() => void refreshStatus(), 2_000)
