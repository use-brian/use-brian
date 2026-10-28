// [COMP:ext/assistant-chat] Real Chromium layout against the built side panel.
// Run after pnpm build, with agent-browser on PATH. No account or model calls.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const session = `extension-composer-${process.pid}`
const run = async (...args) => (await exec('agent-browser', ['--session', session, ...args], { timeout: 30_000 })).stdout
const evaluate = async code => {
  const result = JSON.parse(await run('eval', '--json', code))
  assert.ok(result.success, JSON.stringify(result))
  return result.data.result
}
const output = process.env.EXTENSION_LAYOUT_OUTPUT
if (output) await mkdir(output, { recursive: true })
const capture = async (name, full = false) => { if (output) await run('screenshot', `${output}/${name}.png`, ...(full ? ['--full'] : [])) }
const init = `<script>(${(() => {
  const listeners = new Set()
  let status = { type: 'status', connected: false }
  const publish = () => { for (const listener of listeners) listener(status) }
  const requests = [], windows = []
  window.fixture = { requests, windows, signedIn: () => {
    status = { type: 'status', connected: true, workspaceName: 'Example workspace', assistants: [{ id: 'assistant', name: 'Example assistant' }],
      accountDirectory: { current: { id: 'user', name: 'Example user', email: 'user@example.com' }, accounts: [] } }
    publish()
  } }
  window.chrome = {
    runtime: { getURL: path => `chrome-extension://fixture/${path}`,
      sendMessage: async message => {
        requests.push(message)
        return message.type === 'protected-status' ? { apiConfigured: true } : message.type === 'status' ? { state: 'unpaired' } : { ok: true }
      },
      connect: () => ({ onMessage: { addListener: listener => { listeners.add(listener); queueMicrotask(() => listener(status)) } },
        onDisconnect: { addListener: () => {} }, disconnect: () => {}, postMessage: message => {
          requests.push(message)
          if (message.type === 'sign-in') { status = { ...status, signInPending: true }; publish() }
          if (message.type === 'cancel-sign-in') { status = { ...status, signInPending: false }; publish() }
          if (message.type === 'status') publish()
        } }),
    }, storage: { local: { get: async () => ({}), set: async () => {} } }, windows: { create: async value => { windows.push(value) } },
  }
}).toString()})();</script>`
const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="app-chat.css"><link rel="stylesheet" href="sidepanel.css">
</head><body><div id="root"></div>${init}<script type="module" src="sidepanel.js"></script></body></html>`
const assets = new Set(['app-chat.css', 'sidepanel.css', 'sidepanel.js', 'popup.html', 'popup.js', 'popup-status.js', 'consent-preapproval.js', 'icon-32.png'])
const server = createServer(async (request, response) => {
  const name = request.url?.slice(1)
  if (!name) { response.setHeader('Content-Type', 'text/html'); response.end(html); return }
  if (!assets.has(name)) { response.writeHead(404); response.end(); return }
  try {
    let body = await readFile(new URL(`../dist/${name}`, import.meta.url))
    if (name === 'popup.html') body = Buffer.from(body.toString().replace('<script type="module"', `${init}<script type="module"`))
    response.setHeader('Content-Type', name.endsWith('.html') ? 'text/html' : name.endsWith('.css') ? 'text/css' : name.endsWith('.png') ? 'image/png' : 'text/javascript')
    response.end(body)
  } catch (error) { response.writeHead(500); response.end(String(error)) }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const height = () => evaluate('document.querySelector("textarea").getBoundingClientRect().height')
const compact = async () => {
  await run('wait', '--fn', 'document.querySelector("textarea").getBoundingClientRect().height === 44')
  assert.equal(await height(), 44)
}
try {
  for (const [width, viewportHeight] of [[380, 820], [320, 400], [600, 900]]) {
    await run('set', 'viewport', String(width), String(viewportHeight))
    await run('open', origin)
    await compact()
    const visible = await evaluate(`(() => {
      const button=document.querySelector('.connection-primary'), box=button.getBoundingClientRect();
      return document.elementFromPoint(box.x+box.width/2,box.y+box.height/2)===button;
    })()`)
    assert.ok(visible, 'Sign in must be reachable immediately, including in a short panel')
    assert.equal(await evaluate('document.querySelector("#connection-heading").getBoundingClientRect().top >= document.querySelector(".panel-header").getBoundingClientRect().bottom'), true)
    assert.equal(await evaluate('document.querySelector(".connection-advanced").open'), false)
    await capture(`panel-${width}-sign-in`)
    await run('click', '.connection-primary')
    await run('wait', '--fn', 'document.querySelector(".connection-primary").textContent === "Open sign-in tab"')
    await run('click', '.connection-actions .text-button')
    await run('wait', '--fn', 'document.querySelector(".connection-primary").textContent === "Sign in to Brian"')
    // A transient narrow panel used to wrap the placeholder into a tall draft.
    await evaluate('document.getElementById("root").style.width="1px"; true')
    await run('wait', '--fn', 'document.querySelector("textarea").clientWidth < 100')
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))')
    await compact()
    await evaluate('document.getElementById("root").style.width=""; true')
    await compact()
    await run('fill', 'textarea', 'One line\nTwo lines\nThree lines')
    assert.ok(await height() > 44, 'typed newlines must grow the composer')
    await run('fill', 'textarea', 'A wrapped draft sentence. '.repeat(100))
    const capped = await evaluate(`(() => {
      const el=document.querySelector('textarea');
      return {height:el.getBoundingClientRect().height,scroll:el.scrollHeight,overflow:getComputedStyle(el).overflowY};
    })()`)
    assert.ok(Math.abs(capped.height - Math.min(240, viewportHeight * .3)) < 1, JSON.stringify(capped))
    assert.ok(capped.scroll > capped.height)
    assert.equal(capped.overflow, 'auto')
    await evaluate('document.querySelector("textarea").select(); true')
    await run('press', 'Backspace')
    await compact()
    assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false)
    assert.equal((await run('errors')).trim(), '')
    await evaluate('window.fixture.signedIn(); true')
    await run('wait', '--fn', 'document.querySelector("[data-chat-greeting]") !== null')
    await capture(`panel-${width}-connected`)
    console.log(`${width}x${viewportHeight}: empty 44px, draft grows and scrolls, clear restores 44px`)
  }
  await run('set', 'viewport', '380', '760')
  await run('open', `${origin}/popup.html`)
  assert.equal(await evaluate('document.querySelector("#advanced-connection").open'), false)
  await capture('settings-sign-in')
  await run('click', '#sign-in')
  await run('wait', '--fn', 'document.querySelector("#sign-in").textContent === "Open sign-in tab"')
  await capture('settings-waiting')
  await run('click', '#cancel-sign-in')
  await run('click', '#advanced-connection > summary')
  await capture('settings-advanced', true)
  await run('fill', '#relay-url', 'wss://relay.example.com/ext')
  await run('fill', '#pairing-token', 'fictional-pairing-token')
  await run('click', '#connect')
  assert.equal(await evaluate('document.querySelector("#pairing-token").value'), '')
  assert.equal(await evaluate('document.querySelector("#sign-in").textContent'), 'Sign in to Brian')
  assert.equal(await evaluate('window.fixture.requests.some(message => message.type === "configure" && message.pairingToken === "fictional-pairing-token")'), true)
  await evaluate('window.fixture.signedIn(); true')
  await run('wait', '--fn', 'document.querySelector("#account-identity").textContent.includes("user@example.com")')
  assert.equal((await run('errors')).trim(), '')
  console.log('Settings: sign-in, waiting, cancel, Advanced manual pairing and connected identity pass')
} finally {
  await run('close')
  await new Promise(resolve => server.close(resolve))
}
