/** Per-task consent window (P1.7): Allow / Deny for the current tab. */

const params = new URLSearchParams(location.search)
const host = params.get('host')
if (host) {
  const detail = document.getElementById('detail')
  if (detail) {
    detail.textContent = `Your assistant wants to browse and act in the current tab (${host}) for this task. Chrome labels active browser control as "debugging this browser." Cancel in Chrome's banner or Stop in the extension ends control.`
  }
}

function respond(allowed: boolean): void {
  void chrome.runtime.sendMessage({ type: 'consent-response', allowed }).finally(() => window.close())
}

document.getElementById('allow')?.addEventListener('click', () => respond(true))
document.getElementById('deny')?.addEventListener('click', () => respond(false))
