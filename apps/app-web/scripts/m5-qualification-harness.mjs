// [COMP:app-web/conversation-controller] M5 browser qualification harness (test fixture only).
// Drives the real app on a local stack with playwright-core and an installed Chrome. The init script
// only observes chat SSE bodies (window.__m5frames / __m5reqs); window.__m5cut() is an explicit fault
// injection that errors the body the app reads and cancels the upstream connection (a dropped network).
// Env: M5_WORK_DIR (fixtures.json, provider log, attachment), M5_CHROME (Chrome executable),
// PLAYWRIGHT_MODULE (default playwright-core), M5_APP (default http://localhost:3003), M5_API (default http://127.0.0.1:4100).
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core')
import { mkdirSync, writeFileSync } from 'node:fs'
const EXE = process.env.M5_CHROME
export const APP = process.env.M5_APP || 'http://localhost:3003'
const API = process.env.M5_API || 'http://127.0.0.1:4100'
// Observation only: tee SSE bodies of chat streams into window.__m5frames.
export const TEE = `(() => {
  if (window.__m5tee) return; window.__m5tee = true
  window.__m5frames = []; window.__m5reqs = []
  window.__m5cut = (kind) => { const l = (window.__m5live || []).filter(e => !kind || e.stream === kind); l.forEach(e => e.cut()); window.__m5live = (window.__m5live || []).filter(e => !l.includes(e)); return l.length }
  const orig = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input)
    const method = String(init?.method || (typeof input === 'object' && input && input.method) || 'GET').toUpperCase()
    const isStream = /\\/api\\/chat(\\?|$)/.test(url) && method === 'POST' || /\\/api\\/sessions\\/[^/]+\\/stream/.test(url)
    const isChatPost = /\\/api\\/chat(\\/[a-z-]+)?(\\?|$)/.test(url) && method === 'POST'
    let bodyText = null
    try { if (isChatPost && typeof init?.body === 'string') bodyText = init.body.slice(0, 600) } catch {}
    const rec = { t: Date.now(), method, url: url.replace(location.origin, ''), body: bodyText }
    window.__m5reqs.push(rec)
    let res
    try { res = await orig(input, init) } catch (e) { rec.error = String(e); throw e }
    rec.status = res.status
    if (/\\/api\\/chat\\/(stop|confirm)|\\/respond|\\/answer|\\/cancel|\\/pending|\\/approvals/.test(url)) { try { res.clone().text().then(t => { rec.response = t.slice(0, 300) }) } catch {} }
    if (!isStream || !res.body) return res
    const [a, b] = res.body.tee()
    const stream = url.includes('/stream') ? 'follow' : 'direct'
    ;(async () => {
      const reader = b.getReader(); window.__m5obs = window.__m5obs || []; window.__m5obs.push({ url, reader }); const dec = new TextDecoder(); let buf = ''
      try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break
          buf += dec.decode(value, { stream: true })
          let i
          while ((i = buf.indexOf('\\n\\n')) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2)
            let ev = 'message', data = ''
            for (const line of chunk.split('\\n')) { if (line.startsWith('event:')) ev = line.slice(6).trim(); else if (line.startsWith('data:')) data += line.slice(5).trim() }
            if (!data && ev === 'message') continue
            let type = ev
            try { const j = JSON.parse(data); if (j && typeof j.type === 'string') type = j.type; window.__m5frames.push({ t: Date.now(), stream, type, ev, turnId: j?.turnId ?? null, d: data.length > 300 ? data.slice(0, 300) : data }) } catch { window.__m5frames.push({ t: Date.now(), stream, type, ev, d: data.slice(0, 200) }) }
          }
        }
        window.__m5frames.push({ t: Date.now(), stream, type: '__close' })
      } catch (e) { window.__m5frames.push({ t: Date.now(), stream, type: '__error', d: String(e) }) }
    })()
    // Harness fault injection: window.__m5cut(kind) errors the body the app reads and cancels the upstream
    // connection, which is what a dropped network looks like to the app. Observation otherwise.
    window.__m5live = window.__m5live || []
    const upstream = a.getReader()
    let ctl
    const wrapped = new ReadableStream({
      start(c) { ctl = c },
      async pull(c) { try { const { value, done } = await upstream.read(); if (done) c.close(); else c.enqueue(value) } catch (e) { try { c.error(e) } catch {} } },
      cancel(r) { try { upstream.cancel(r).catch(() => {}) } catch {} },
    })
    const entry = { stream, url, cut: () => { try { ctl.error(new TypeError('network error')) } catch {} ; try { upstream.cancel('m5 cut').catch(() => {}) } catch {} ; try { (window.__m5obs || []).filter(o => o.url === url).forEach(o => o.reader.cancel('m5 cut').catch(() => {})) } catch {} ; window.__m5frames.push({ t: Date.now(), stream, type: '__cut' }) } }
    window.__m5live.push(entry)
    return new Response(wrapped, { status: res.status, statusText: res.statusText, headers: res.headers })
  }
})()`
export async function launch() { return chromium.launch({ executablePath: EXE, headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] }) }
export async function newCtx(browser, { width, height, as, goto } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, permissions: ['microphone'] })
  await ctx.addInitScript(TEE)
  const page = await ctx.newPage()
  const consoleErrors = []
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push({ t: Date.now(), text: m.text().slice(0, 400) }) })
  page.on('pageerror', e => consoleErrors.push({ t: Date.now(), text: 'pageerror: ' + e.message.slice(0, 400) }))
  page.setDefaultTimeout(30000)
  const entry = as ? `${APP}/api/auth/dev-login?as=${as}` : `${APP}/api/auth/local-session`
  await page.goto(entry, { waitUntil: 'commit', timeout: 180000 })
  if (goto) { await page.waitForTimeout(1500); await page.goto(goto, { waitUntil: 'commit', timeout: 180000 }); if (/\/chat/.test(goto)) await composer(page).waitFor({ state: 'visible', timeout: 180000 }).catch(() => {}); else await page.waitForTimeout(6000); return { ctx, page, consoleErrors } }
  await page.waitForURL(/\/w\/[0-9a-f-]+/, { timeout: 180000, waitUntil: 'commit' }).catch(() => {})
  await composer(page).waitFor({ state: 'visible', timeout: 180000 }).catch(() => {})
  // A fresh context can land on the most recent conversation; journeys start from a new chat.
  if (/[?&]s=/.test(page.url())) {
    await page.getByRole('button', { name: 'New chat' }).first().click().catch(() => {})
    await page.waitForFunction(() => !new URL(location.href).searchParams.get('s'), null, { timeout: 15000 }).catch(() => {})
    await composer(page).waitFor({ state: 'visible', timeout: 60000 }).catch(() => {})
  }
  return { ctx, page, consoleErrors }
}
export const frames = (page) => page.evaluate(() => window.__m5frames ?? [])
export const reqs = (page) => page.evaluate(() => window.__m5reqs ?? [])
export function composer(page) { return page.getByRole('textbox', { name: 'Ask a question or describe a task' }).first() }
export async function send(page, text) {
  const box = composer(page); await box.click(); await box.fill(text)
  await page.locator('[data-testid="chat-composer-send"]:visible').first().click()
}
export function writeJson(path, obj) { writeFileSync(path, JSON.stringify(obj, null, 2)) }
export function ensure(dir) { mkdirSync(dir, { recursive: true }); return dir }
import { readFileSync, existsSync } from 'node:fs'
export const WORK = process.env.M5_WORK_DIR || '/tmp/m5-qualification'
const PROVIDER_LOG = `${WORK}/provider-requests.jsonl`
export function providerCalls(tag) {
  if (!existsSync(PROVIDER_LOG)) return []
  return readFileSync(PROVIDER_LOG, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l) } catch { return null } })
    .filter(j => j && ['text', 'tool-call', 'after-tool', 'approve-unavailable'].includes(j.kind) && j.directive?.tag === tag)
}
export async function waitFrame(page, pred, timeout = 60000, label = 'frame') {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const f = await frames(page).catch(() => [])
    const hit = f.find(pred)
    if (hit) return hit
    await page.waitForTimeout(150)
  }
  throw new Error(`timeout waiting for ${label}`)
}
export const stopBtn = (page) => page.getByRole('button', { name: 'Stop generating' }).filter({ visible: true }).first()
export const sendBtn = (page) => page.locator('[data-testid="chat-composer-send"]:visible').first()
export function summarizeFrames(f) {
  const out = []
  for (const x of f) {
    const k = `${x.stream}:${x.type}`
    const last = out[out.length - 1]
    if (last && last.k === k) last.n++
    else out.push({ k, n: 1, turnId: x.turnId ? String(x.turnId).slice(0, 12) : undefined })
  }
  return out.map(o => `${o.k}${o.n > 1 ? `x${o.n}` : ''}${o.turnId ? `(${o.turnId})` : ''}`)
}
export async function token(as) {
  const url = as ? `${API}/auth/dev-login?as=${as}` : `${API}/auth/local-session`
  const r = await fetch(url, { method: 'POST' }); const j = await r.json(); return j
}
export async function api(tok, method, path, body) {
  const r = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  let j = null; try { j = await r.json() } catch {}
  return { status: r.status, body: j }
}
export const keyFrames = (f) => f.filter(x => /error|notice|turn_completed|turn_started|done|status|tool_confirmation|session$|awaiting|reply_complete/.test(x.type)).map(x => ({ stream: x.stream, type: x.type, d: x.d }))
export async function bodyText(page) { return page.locator('main, body').first().innerText().catch(() => '') }

export async function mention(page, name) {
  const box = composer(page); await box.click(); await page.keyboard.type('@' + name.slice(0, 4))
  await page.getByRole('option', { name: `Mention ${name}` }).first().click()
}

export async function settle(page, timeout = 120000) {
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].some(b => (b.getAttribute('aria-label') === 'Stop generating' || b.textContent.trim() === 'Stop generating') && b.offsetParent !== null), null, { timeout }).catch(() => {})
  await page.waitForTimeout(800)
}
