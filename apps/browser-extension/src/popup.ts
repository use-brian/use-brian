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
    const result = await chrome.runtime.sendMessage({
      type: 'configure',
      relayUrl: relayUrlInput.value.trim(),
      pairingToken: tokenInput.value.trim() || undefined,
    })
    if (!result?.ok) {
      protectedError = 'Connect denied. A locked task can only be re-paired to the same account, workspace and profile.'
      void refreshProtected()
      return
    }
    protectedError = ''
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

// This configuration is human-entered extension UI state, never a relay argument.
void chrome.storage.local.get('protectedApiBase').then(s => {
  el<HTMLInputElement>('protected-api').value = s.protectedApiBase ?? ''
})
el('protected-save').addEventListener('click', () => {
  void chrome.runtime.sendMessage({type:'protected-configure', protectedApiBase:el<HTMLInputElement>('protected-api').value.trim()}).then(r => {
    protectedError = r?.ok ? '' : 'Configuration denied. Use a canonical HTTPS API origin; a locked task cannot change its pinned origin.'
    void refreshProtected()
  })
})
let protectedError = ''
async function refreshProtected(): Promise<void> {
  const s = await chrome.runtime.sendMessage({type:'protected-status'})
  el('protected-status').textContent = s?.pending ? 'Explicit disclosure approval required.' : s?.locked ?
    'Task locked (including denied or failed fills). Finish in the browser if needed, then clean up here.' : 'No protected fill pending.'
  if (protectedError) el('protected-status').textContent = protectedError
  el('protected-setup').hidden = s?.apiConfigured === true
  el('protected-renewal').hidden = s?.needsRenewal !== true
  el('protected-details').textContent = s?.pending ? `Destination: ${s.pending.destinationOrigin} · Profile: ${s.pending.browserProfileId} · Target text fields: ${s.pending.refs.join(', ')}` : ''
  el('protected-approve').hidden = !s?.pending
  el('protected-deny').hidden = !s?.pending
  el('protected-complete').hidden = !s?.locked || !!s?.pending || s?.needsSessionRecovery === true
  el('protected-session-recovery').hidden = s?.needsSessionRecovery !== true
  el('protected-recover-server').hidden = !!s?.locked
  el('protected-server-help').hidden = !!s?.locked
  // The panel is collapsed by default; anything that needs the user opens it.
  // Only ever opens: a user who expanded it to configure stays expanded.
  const attention = !!s?.pending || !!s?.locked || s?.needsRenewal === true || s?.needsSessionRecovery === true || !!protectedError
  const panel = el<HTMLDetailsElement>('protected-fill')
  panel.classList.toggle('attention', attention)
  if (attention) panel.open = true
}
for (const [id, allowed] of [['protected-approve',true],['protected-deny',false]] as const) {
  el(id).addEventListener('click', () => { void chrome.runtime.sendMessage({type:'protected-approval', allowed}).then(refreshProtected) })
}
el('protected-complete').addEventListener('click', () => {
  protectedError = ''
  void chrome.runtime.sendMessage({type:'protected-complete'}).then(r => {
    if (!r?.ok) protectedError = 'Cleanup incomplete. Lock retained. Check trusted API setup, renew pairing if expired, then retry.'
    void refreshProtected()
  })
})
void refreshProtected()
setInterval(() => void refreshProtected(), 1000)

const recoveryConsent = el<HTMLInputElement>('protected-recovery-consent')
const recoverAll = el<HTMLButtonElement>('protected-recover-all')
recoveryConsent.addEventListener('change', () => { recoverAll.disabled = !recoveryConsent.checked })
recoverAll.addEventListener('click', () => {
  if (!recoveryConsent.checked || !window.confirm('Close ALL tabs accessible to this extension in this Chrome profile, including unrelated and pinned tabs in every window? Unsaved work may be lost. Only a new extension cleanup window will remain.')) return
  recoverAll.disabled = true
  recoveryConsent.checked = false
  protectedError = ''
  void chrome.runtime.sendMessage({type:'protected-recover-all-tabs', allowed:true}).then(r => {
    if (!r?.ok) protectedError = 'Broad cleanup incomplete. Lock retained. Save your work and explicitly approve recovery again to retry.'
    void refreshProtected()
  })
})


el('protected-recover-server').addEventListener('click', () => {
  if (!window.confirm('Recover this paired profile’s server reservation? References that have not started resolution will be invalidated and cancelled. If disclosure is uncertain, recovery will require a separate approval to close ALL accessible browser tabs.')) return
  const button = el<HTMLButtonElement>('protected-recover-server')
  button.disabled = true
  protectedError = ''
  void chrome.runtime.sendMessage({type:'protected-recover-server', allowed:true}).then(r => {
    if (!r?.ok) protectedError = 'Server recovery failed. Check trusted API setup and pairing, then retry. No local lock was cleared.'
    else if (r.status === 'cancelled') protectedError = 'Undisclosed reservation cancelled; old references are invalid. Create fresh references to retry.'
    else if (r.status === 'none') protectedError = 'No server reservation found. Any local disclosure lock still requires cleanup.'
    button.disabled = false
    void refreshProtected()
  })
})
