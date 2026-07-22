/** Per-task consent window (P1.7): Allow / Deny for the current tab. */

const params = new URLSearchParams(location.search)
const host = params.get('host')
if (host) {
  const detail = document.getElementById('detail')
  if (detail) {
    detail.textContent = `Your assistant wants to browse and act in the current tab (${host}) for this task. You can stop it at any time from the extension.`
  }
}

function respond(allowed: boolean): void {
  void chrome.runtime.sendMessage({ type: 'consent-response', allowed }).finally(() => window.close())
}

document.getElementById('allow')?.addEventListener('click', () => respond(true))
document.getElementById('deny')?.addEventListener('click', () => respond(false))
