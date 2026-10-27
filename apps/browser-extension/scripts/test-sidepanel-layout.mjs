// [COMP:ext/assistant-chat] Real Chromium layout against the built side panel.
// Run after pnpm build, with agent-browser on PATH. No account or model calls.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const session = `extension-composer-${process.pid}`
const run = async (...args) => (await exec('agent-browser', ['--session', session, ...args], { timeout: 30_000 })).stdout
const evaluate = async code => {
  const result = JSON.parse(await run('eval', '--json', code))
  assert.ok(result.success, JSON.stringify(result))
  return result.data.result
}
const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="app-chat.css"><link rel="stylesheet" href="sidepanel.css">
</head><body><div id="root"></div><script>
window.chrome={runtime:{connect:()=>({onMessage:{addListener:()=>{}},onDisconnect:{addListener:()=>{}},postMessage:()=>{},disconnect:()=>{}})}};
</script><script type="module" src="sidepanel.js"></script></body></html>`
const assets = new Set(['app-chat.css', 'sidepanel.css', 'sidepanel.js'])
const server = createServer(async (request, response) => {
  const name = request.url?.slice(1)
  if (!name) { response.setHeader('Content-Type', 'text/html'); response.end(html); return }
  if (!assets.has(name)) { response.writeHead(404); response.end(); return }
  try {
    const body = await readFile(new URL(`../dist/${name}`, import.meta.url))
    response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : 'text/javascript')
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
    console.log(`${width}x${viewportHeight}: empty 44px, draft grows and scrolls, clear restores 44px`)
  }
} finally {
  await run('close')
  await new Promise(resolve => server.close(resolve))
}
