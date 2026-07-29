/** Firefox per-task Allow/Deny prompt. */
export {}

const ext = (globalThis as unknown as { browser: typeof chrome }).browser
const params = new URLSearchParams(location.search)
const host = params.get('host') ?? 'this page'
const detail = document.getElementById('detail')
if (detail) detail.textContent = `Use Brian wants to work in the tab on ${host}. You can watch it and stop at any time.`

document.getElementById('allow')?.addEventListener('click', () => {
  void ext.runtime.sendMessage({ type: 'consent-response', allowed: true }).then(() => window.close())
})
document.getElementById('deny')?.addEventListener('click', () => {
  void ext.runtime.sendMessage({ type: 'consent-response', allowed: false }).then(() => window.close())
})
