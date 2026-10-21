import type { PageEvidence } from './assistant-chat.js'

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const input = el<HTMLTextAreaElement>('message')
let port: chrome.runtime.Port
let assistantId = ''
let sessionId: string | undefined
let page: PageEvidence | undefined
let requestId: string | undefined
let answer: HTMLElement | null = null
let connected = false
let rosterKey = ''
const error = (message: string) => { el('error').textContent = message; el('error').hidden = !message }
function controls() { el<HTMLButtonElement>('send').disabled = !connected || !assistantId || !!requestId; el<HTMLButtonElement>('share-page').disabled = !connected || !!requestId; el<HTMLDetailsElement>('assistant-picker').inert = !!requestId; el<HTMLButtonElement>('new-chat').disabled = !!requestId }
function row(role: string, text: string) { const node = document.createElement('div'); node.className = `message ${role}`; node.textContent = text; el('messages').querySelector('.empty')?.remove(); el('messages').append(node); node.scrollIntoView({ block: 'end' }); return node }
function reset() {
  sessionId = undefined; answer = null; page = undefined; el('page-preview').hidden = true
  const welcome = document.createElement('p'); welcome.className = 'empty'; welcome.textContent = 'Ask about this page, connect it to your company knowledge, or ask Brian to work in your browser.'
  el('messages').replaceChildren(welcome); el('review').hidden = true; error('')
}
function send(message: unknown) { try { port.postMessage(message) } catch { connected = false; controls(); error('Connection lost. Keep Brian open and retry. No message was resent.') } }
function connect() {
  port?.disconnect()
  port = chrome.runtime.connect({ name: 'brian-assistant-panel' })
  port.onDisconnect.addListener(() => { connected = false; requestId = undefined; controls(); el('recovery').hidden = false; error('Connection lost. Check the full chat before retrying an action.') })
  port.onMessage.addListener(message => {
    if (message.type === 'status') {
      connected = message.connected === true
      el('connection').textContent = connected ? `Connected · ${String(message.workspaceName ?? 'Brian')}` : 'Open Brian to connect your assistant'
      el('recovery').hidden = connected
      const roster = Array.isArray(message.assistants) ? message.assistants : []
      const key = JSON.stringify(roster)
      if (key !== rosterKey) {
        rosterKey = key
        el('assistants').replaceChildren()
        for (const assistant of roster) {
          if (typeof assistant.id !== 'string' || typeof assistant.name !== 'string') continue
          const button = document.createElement('button'); button.textContent = assistant.name
          button.addEventListener('click', () => { if (requestId) return; assistantId = assistant.id; reset(); el('assistant-name').textContent = assistant.name; el<HTMLDetailsElement>('assistant-picker').open = false; controls() })
          el('assistants').append(button)
        }
        if (!roster.some((a: { id: string }) => a.id === assistantId)) {
          assistantId = roster[0]?.id ?? ''; reset(); el('assistant-name').textContent = roster[0]?.name ?? 'Choose assistant'
        }
      }
      controls(); return
    }
    if (message.type === 'page') {
      page = message.page; el('page-preview').hidden = false
      el<HTMLAnchorElement>('page-url').href = page!.url; el('page-url').textContent = page!.url
      el('page-text').textContent = page!.text; el('activity').textContent = ''; controls(); return
    }
    if (message.id && message.id !== requestId) return
    if (message.type === 'event') {
      const data = message.data ?? {}
      if (message.event === 'session') sessionId = data.sessionId
      if (message.event === 'text_delta' && typeof data.text === 'string') {
        answer ??= row('assistant', '')
        answer.textContent += data.text; answer.scrollIntoView({ block: 'end' })
        el('activity').textContent = ''
      }
      if (message.event === 'tool_start') { if (answer) answer.textContent = ''; el('activity').textContent = 'Working...'; if (data.name === 'askQuestion') el('review').hidden = false }
      if (message.event === 'tool_confirmation_required') { el('review').hidden = false; el('activity').textContent = 'Waiting for your approval' }
      if (message.event === 'error') error(typeof data.error === 'string' ? data.error : 'The turn could not finish. Open the full chat for details.')
      return
    }
    if (message.type === 'complete' || message.type === 'failure') {
      requestId = undefined; el('activity').textContent = ''; controls()
      if (message.type === 'failure') {
        const messages: Record<string, string> = {
          page_changed: 'The page changed or its shared excerpt expired. Share the current page again, then send.',
          different_task_tab: 'Brian is already working in another tab. Stop that task before sharing this tab.',
          no_eligible_tab: 'Open a regular website tab to share its context. Private and browser settings tabs are excluded.',
          consent_denied: 'Page sharing was declined. Press Share current page to request permission again.',
          busy: 'Another chat is still running. Wait for it to finish or press Stop.',
          stopped: 'Stopped before sending or sharing. No new request was started.',
          protected_fill_denied: 'Finish protected fill cleanup in extension Settings before sharing this page.',
        }
        error(messages[message.code] ?? 'The connection or page read failed. Open Brian, check the chat, then retry. No action was repeated.')
      }
    }
  })
}
el('composer').addEventListener('submit', event => {
  event.preventDefault()
  if (!connected || requestId || !assistantId || !input.value.trim()) return
  const text = input.value.trim(); requestId = crypto.randomUUID(); answer = null; error(''); el('review').hidden = true
  row('user', text + (page ? `\n\nShared page: ${page.title}\n${page.url}` : ''))
  send({ type: 'send', id: requestId, text, assistantId, sessionId, page })
  input.value = ''; page = undefined; el('page-preview').hidden = true; el('activity').textContent = 'Thinking...'; controls()
})
input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); el<HTMLFormElement>('composer').requestSubmit() } })
el('share-page').addEventListener('click', () => { error(''); el('activity').textContent = 'Waiting for page permission...'; send({ type: 'read-page' }) })
el('clear-page').addEventListener('click', () => { page = undefined; el('page-preview').hidden = true })
el('stop').addEventListener('click', () => send({ type: 'stop' }))
el('new-chat').addEventListener('click', reset)
el('review-chat').addEventListener('click', () => send({ type: 'open-chat', sessionId }))
el('settings').addEventListener('click', () => { void chrome.windows.create({ url: chrome.runtime.getURL('popup.html'), type: 'popup', width: 380, height: 720 }) })
el('open-app').addEventListener('click', () => { void chrome.storage.local.get('assistantAppOrigin').then(stored => chrome.tabs.create({ url: typeof stored.assistantAppOrigin === 'string' ? stored.assistantAppOrigin : 'https://app.usebrian.ai' })) })
el('retry').addEventListener('click', connect)
connect()
setInterval(() => send({ type: 'status' }), 5000)
