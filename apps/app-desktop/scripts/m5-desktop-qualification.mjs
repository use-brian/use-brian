#!/usr/bin/env node
// [COMP:app-desktop/offline-restart] M5 packaged-desktop qualification journeys (test harness only).
// Usage: node m5-desktop-qualification.mjs <journey> <outDir>
// Journeys: first-launch, chat-window-turn, close-unload-identity, veto, dock-page, restart, stop,
// retire-idle, retire-inflight, nearby-boot-click. The sign-out journeys arm a main-process probe (armSignOutProbe) that
// judges completion from the main process itself: session-cleared reaching the main window, the main
// renderer's token, and pet clicks fired between the main window's reload and its next companion context.
// Each writes <outDir>/result.json (checks, windows, requests, frame summaries, console errors) and
// screenshots. Messages carry scripted-provider directives (slow:N, #tag); no real model is called.
import { rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const d = await import('./m5-desktop-driver.mjs')
const [journey, outDir] = process.argv.slice(2)
const out = d.ensure(outDir)
process.env.M5_DESKTOP_LOG = join(out, 'app.log')
const checks = []
const notes = []
const check = (name, ok, detail) => { checks.push({ name, ok: Boolean(ok), detail: detail ?? null }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`) }
const note = (text) => { notes.push(text); console.log(`NOTE ${text}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const requests = []
const timeline = []
const mark = (label, extra) => timeline.push({ t: Date.now(), label, ...(extra ?? {}) })
const PROVIDER_LOG = process.env.M5_PROVIDER_LOG
const RUN = Date.now().toString(36).slice(-5)
/** Per-run provider tag, so a rerun never counts an earlier run's model calls. */
const T = (base) => `${base}-${RUN}`

function providerCalls(tag) {
  if (!PROVIDER_LOG || !existsSync(PROVIDER_LOG)) return []
  return readFileSync(PROVIDER_LOG, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l) } catch { return null } })
    .filter((j) => j && j.directive?.tag === tag)
}

async function start() {
  const s = await d.launchApp()
  s.app.context().on('request', (r) => {
    const u = r.url()
    if (/\/api\/(chat|sessions)/.test(u)) requests.push({ t: Date.now(), method: r.method(), url: u.replace(/^https?:\/\/[^/]+/, ''), frame: d.shortUrl(r.frame()?.url?.() ?? '').slice(0, 60) })
  })
  return s
}
async function signedInMain(app, timeout = 90000) {
  const main = await d.mainPage(app, timeout)
  await main.waitForURL(/#\/w\/[0-9a-f-]+/, { timeout })
  await d.observe(main)
  return main
}
const workspaceOf = (url) => (url.match(/#\/w\/([0-9a-f-]+)/) ?? [])[1] ?? null
async function setNearby(app, on) {
  return app.evaluate(({ Menu }, want) => {
    const find = (items) => { for (const i of items) { if (i.label === 'Keep Brian Nearby') return i; if (i.submenu) { const f = find(i.submenu.items); if (f) return f } } return null }
    const item = find(Menu.getApplicationMenu()?.items ?? [])
    if (!item) return 'missing'
    if (Boolean(item.checked) !== want) item.click()
    return 'ok'
  }, on)
}
async function openChatWindow(app) {
  const pet = await d.petPage(app, 20000)
  await pet.waitForTimeout(800)
  await pet.locator('#message-brian').click()
  const chat = await d.chatPage(app, 30000)
  await chatComposer(chat).waitFor({ state: 'visible', timeout: 60000 })
  return chat
}
const chatComposer = (page) => page.locator('textarea[placeholder="Ask anything…"]').filter({ visible: true }).first()
async function chatSend(page, text) {
  const box = chatComposer(page); await box.click(); await box.fill(text)
  await page.keyboard.press('Enter')
}
async function framesSafe(page) { try { return await d.frames(page) } catch { return [] } }
async function waitFrames(page, pred, timeout, label) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const f = await framesSafe(page)
    if (pred(f)) return f
    await sleep(200)
  }
  throw new Error(`timeout waiting for ${label}`)
}
const sessionIdFrom = (f) => {
  for (const x of f) {
    if (x.type === 'session' || /"sessionId"/.test(x.d ?? '')) { const m = (x.d ?? '').match(/"sessionId":"([0-9a-f-]{36})"/); if (m) return m[1] }
  }
  return null
}
const deltaCount = (f) => f.filter((x) => /delta|snapshot|text/.test(x.type)).length
function summarize(f) {
  const outp = []
  for (const x of f) { const k = `${x.stream}:${x.type}`; const last = outp[outp.length - 1]; if (last && last.k === k) last.n++; else outp.push({ k, n: 1 }) }
  return outp.map((o) => `${o.k}${o.n > 1 ? `x${o.n}` : ''}`)
}
/** A synchronous native modal blocks the main process (and the driver); detect it from the log and end the run. */
function modalSeen() {
  try { const t = readFileSync(process.env.M5_DESKTOP_LOG, 'utf8'); return t.split('\n').filter((l) => l.includes('[m5-dialog]')) } catch { return [] }
}
async function abortOnModal(label) {
  const m = modalSeen()
  if (!m.length) return
  check(`${label}: no native modal dialog`, false, m)
  try { session.app.process().kill('SIGKILL') } catch {}
  session = null
  throw new Error(`native modal blocked the main process during ${label}`)
}
/**
 * Main-process probe for a sign-out with the chat window open. Records the chat window's close, IPC sent
 * to the main window, its reloads and in-page routes, companion-context updates and new windows. From the
 * moment `session-cleared` reaches the main window it clicks the pet every 10 ms until the replacement
 * main window supplies context, either its first `#/w/<ws>` route (main.ts `rememberWorkspace`) or its
 * `set-companion-context` IPC, or 20 s pass. A click that lands after the reload but before that context
 * opens a chat window only if the previous identity's context survived sign-out.
 */
async function armSignOutProbe(app) {
  return app.evaluate(({ BrowserWindow, ipcMain, app: shell }) => {
    const ev = globalThis.__dq = []
    const push = (e) => ev.push({ t: Date.now(), ...e })
    const urlOf = (w) => { try { return w.webContents.getURL() } catch { return '' } }
    const short = (u) => u.replace(/\?.*?(#|$)/, '?…$1').slice(-80)
    const all = BrowserWindow.getAllWindows()
    const chat = all.find((w) => /#\/desktop\/chat\//.test(urlOf(w)))
    const pet = all.find((w) => /brian-pet\.html/.test(urlOf(w)))
    const main = all.find((w) => w !== chat && w !== pet && /renderer\/index\.html/.test(urlOf(w)))
    chat?.once('closed', () => push({ ev: 'chat-closed', id: chat.id }))
    let probing = false, timer = null
    const stop = (why) => { if (!probing) return; probing = false; clearInterval(timer); push({ ev: 'probe-stop', why }) }
    const click = () => {
      if (!pet || pet.isDestroyed()) return
      push({ ev: 'pet-click' })
      pet.webContents.executeJavaScript("document.getElementById('message-brian')?.click()").catch(() => {})
    }
    if (main) {
      const wc = main.webContents
      const send = wc.send.bind(wc)
      wc.send = (ch, ...a) => {
        push({ ev: 'main-ipc', ch, arg: typeof a[0] === 'string' ? a[0] : undefined })
        if (ch === 'Use Brian:session-cleared' && !probing && pet) {
          probing = true; click(); timer = setInterval(click, 10); setTimeout(() => stop('timeout'), 20000)
        }
        return send(ch, ...a)
      }
      wc.on('did-start-navigation', (_e, url, inPlace, isMain) => { if (isMain && !inPlace) push({ ev: 'main-nav', url: short(url) }) })
      wc.on('did-finish-load', () => push({ ev: 'main-loaded', url: short(urlOf(main)) }))
      wc.on('did-navigate-in-page', (_e, url, isMain) => {
        if (!isMain) return
        const ws = (url.match(/#\/w\/([0-9a-f-]+)/) ?? [])[1] ?? null
        push({ ev: 'main-route', ws })
        if (ws) stop('route')
      })
    }
    ipcMain.on('Use Brian:set-companion-context', (e, ws) => {
      if (main && !main.isDestroyed() && e.sender.id === main.webContents.id) { push({ ev: 'context', ws }); stop('context') }
    })
    shell.on('browser-window-created', (_e, w) => {
      push({ ev: 'window-created', id: w.id })
      w.webContents.once('did-start-navigation', (_x, url) => push({ ev: 'window-url', id: w.id, url: short(url) }))
    })
    return { chat: chat?.id ?? null, pet: pet?.id ?? null, main: main?.id ?? null }
  })
}
const accessToken = (page) => page.evaluate(() => window.usebrianDesktop?.getAccessToken?.() ?? null).catch(() => null)
/** Wait for the probe to finish, then judge the sign-out from the recorded main-process order. */
async function judgeSignOut(app, main, tokenBefore) {
  const t0 = Date.now()
  let order = []
  while (Date.now() - t0 < 30000) {
    order = await app.evaluate(() => globalThis.__dq ?? []).catch(() => order)
    if (order.some((o) => o.ev === 'probe-stop')) break
    await sleep(250)
  }
  await sleep(1500)
  order = await app.evaluate(() => globalThis.__dq ?? []).catch(() => order)
  result.retireOrder = order
  const closed = order.find((o) => o.ev === 'chat-closed')
  const cleared = order.find((o) => o.ev === 'main-ipc' && o.ch === 'Use Brian:session-cleared')
  check('sign-out completes: session-cleared(logout) reaches the main window after the chat window closed',
    closed && cleared && cleared.arg === 'logout' && closed.t <= cleared.t, { closed: closed?.t, cleared })
  const reloaded = cleared ? order.find((o) => o.ev === 'main-loaded' && o.t >= cleared.t) : null
  const context = cleared ? order.find((o) => (o.ev === 'context' || (o.ev === 'main-route' && o.ws)) && o.t >= cleared.t) : null
  const chats = order.filter((o) => o.ev === 'window-url' && /desktop\/chat/.test(o.url))
  const early = chats.filter((o) => !context || o.t < context.t)
  const probes = reloaded ? order.filter((o) => o.ev === 'pet-click' && o.t > reloaded.t + 5 && (!context || o.t < context.t)).length : 0
  result.signOutProbe = { reloadedAt: reloaded?.t ?? null, reloadedTo: reloaded?.url ?? null, contextAt: context?.t ?? null,
    contextSource: context?.ev ?? null, contextWorkspace: context?.ws ?? null, probesAfterReloadBeforeContext: probes, chatWindowsOpened: chats }
  const wrongWorkspace = chats.filter((o) => context?.ws && !o.url.includes(context.ws))
  check('companion context forgotten: pet clicks between the reload and the replacement main-window context open no chat window',
    cleared && probes > 0 && early.length === 0 && wrongWorkspace.length === 0, result.signOutProbe)
  const tokenAfter = await accessToken(main)
  result.tokens = { before: tokenBefore ? `…${tokenBefore.slice(-8)}` : null, after: tokenAfter ? `…${tokenAfter.slice(-8)}` : null }
  check('session cleared: the main renderer no longer holds the pre-sign-out access token', tokenBefore && tokenAfter !== tokenBefore, result.tokens)
  return { order, context }
}
/** Reuse a visible chat window (a probe click after the new context may have opened it) or open one. */
async function openOrReuseChat(app) {
  const wins = await d.windows(app)
  const open = wins.find((w) => /desktop\/chat/.test(w.url) && w.visible)
  if (open) {
    const chat = await d.chatPage(app, 10000)
    await chatComposer(chat).waitFor({ state: 'visible', timeout: 60000 })
    note('chat window already open (opened by a probe click after the replacement context); reused')
    return chat
  }
  return openChatWindow(app)
}
/**
 * M5D-4 probe: after a sign-out, the reloaded main window first exposes its workspace through its route
 * (main.ts `rememberWorkspace`, no assistant yet) and sends `set-companion-context` a few ms later. From
 * the first `#/w/<ws>` route the probe clicks the pet every 2 ms until that context IPC, so a click can open
 * the Nearby window from the route context while the full context is still on its way.
 */
async function armBootClickProbe(app) {
  return app.evaluate(({ BrowserWindow, ipcMain, app: shell }) => {
    const ev = globalThis.__boot = []
    const push = (e) => ev.push({ t: Date.now(), ...e })
    const urlOf = (w) => { try { return w.webContents.getURL() } catch { return '' } }
    const short = (u) => u.replace(/\?.*?(#|$)/, '?…$1').slice(-90)
    const all = BrowserWindow.getAllWindows()
    const pet = all.find((w) => /brian-pet\.html/.test(urlOf(w)))
    const main = all.find((w) => w !== pet && /renderer\/index\.html/.test(urlOf(w)) && !/#\/desktop\/chat\//.test(urlOf(w)))
    let cleared = false, probing = false, timer = null
    const stop = (why) => { if (!probing) return; probing = false; clearInterval(timer); push({ ev: 'probe-stop', why }) }
    const click = () => { if (pet && !pet.isDestroyed()) { push({ ev: 'pet-click' }); pet.webContents.executeJavaScript("document.getElementById('message-brian')?.click()").catch(() => {}) } }
    const wc = main.webContents
    const send = wc.send.bind(wc)
    wc.send = (ch, ...a) => { if (ch === 'Use Brian:session-cleared') { cleared = true; push({ ev: 'session-cleared' }) } return send(ch, ...a) }
    wc.on('did-navigate-in-page', (_e, url, isMain) => {
      if (!isMain || !cleared) return
      const ws = (url.match(/#\/w\/([0-9a-f-]+)/) ?? [])[1] ?? null
      push({ ev: 'main-route', ws })
      if (ws && !probing && !ev.some((o) => o.ev === 'probe-stop')) { probing = true; click(); timer = setInterval(click, 2); setTimeout(() => stop('timeout'), 3000) }
    })
    ipcMain.on('Use Brian:set-companion-context', (e, ws, assistant) => {
      if (cleared && e.sender.id === wc.id) { push({ ev: 'context', ws, assistant }); stop('context') }
    })
    shell.on('browser-window-created', (_e, w) => {
      push({ ev: 'window-created', id: w.id })
      w.webContents.on('did-start-navigation', (_x, url, inPlace, isMain) => { if (isMain) push({ ev: 'window-url', id: w.id, url: short(url), inPlace }) })
      w.webContents.on('did-fail-load', (_x, code, desc, url, isMain) => { if (isMain) push({ ev: 'window-load-failed', id: w.id, code, desc }) })
      w.on('closed', () => push({ ev: 'window-closed', id: w.id }))
    })
    return { pet: pet?.id ?? null, main: main?.id ?? null }
  })
}
async function owner() { return d.ownerToken() }
async function messages(tok, sessionId) {
  const r = await d.api(tok, 'GET', `/api/sessions/${sessionId}/messages`)
  const list = r.body?.messages ?? r.body ?? []
  return { status: r.status, rows: Array.isArray(list) ? list.map((m) => ({ role: m.role, text: (Array.isArray(m.content) ? m.content.map((p) => p?.text ?? '').join(' ') : String(m.content ?? m.text ?? '')) })) : [] }
}
async function sessionState(tok, sessionId) {
  const r = await d.api(tok, 'GET', `/api/sessions/${sessionId}`)
  const s = r.body?.session ?? r.body ?? {}
  return { status: r.status, turnStatus: s.status ?? s.turnStatus ?? null, turnEndReason: s.turnEndReason ?? null }
}
async function waitAssistant(tok, sessionId, re, timeout = 120000) {
  const t0 = Date.now(); let last = null
  while (Date.now() - t0 < timeout) {
    last = await messages(tok, sessionId)
    if (last.rows.some((m) => m.role === 'assistant' && re.test(m.text))) return { ok: true, rows: last.rows, ms: Date.now() - t0 }
    await sleep(1000)
  }
  return { ok: false, rows: last?.rows ?? [] }
}

const result = { journey, startedAt: new Date().toISOString(), checks, notes, timeline }
let session = null
try {
  if (journey === 'first-launch') {
    if (existsSync(d.PROFILE)) rmSync(d.PROFILE, { recursive: true, force: true })
    mark('launch')
    session = await start()
    const { app } = session
    const first = await d.mainPage(app, 60000)
    await d.shot(first, out, '00-first-window')
    const main = await signedInMain(app)
    mark('workspace')
    await main.waitForTimeout(3000)
    await d.shot(main, out, '01-workspace')
    const profileFiles = await app.evaluate(() => process.getBuiltinModule('node:fs').readdirSync(process.env.M5_DESKTOP_PROFILE))
    const user = await main.evaluate(() => window.usebrianDesktop?.getUser?.() ?? null).catch(() => null)
    check('profile starts with no credentials and reaches a workspace through the shell mint', /#\/w\//.test(main.url()), { workspace: workspaceOf(main.url()), ms: timeline[1].t - timeline[0].t })
    check('credentials stored in the throwaway profile only', profileFiles.some((f) => /token|account|deploy/i.test(f)), profileFiles)
    const host = new URL(d.APP).host.replace(/[.[\]]/g, '\\$&')
    check('window title names the local deployment', (await d.windows(app)).some((w) => new RegExp(`Local Brain \\(${host}\\)`).test(w.title)), (await d.windows(app)).map((w) => w.title))
    const mint = (session.log ?? []).map((l) => l.out ?? l.err ?? '').filter((l) => /Local session mint failed|did not accept/i.test(l))
    check('the shell mint is accepted for this address (no local-session failure in the app log)', mint.length === 0, mint)
    const body = await d.bodyText(main)
    check('composer visible on first workspace load', await d.composer(main).isVisible().catch(() => false))
    result.user = user
    result.bodyExcerpt = body.slice(0, 400)
  }

  if (journey === 'chat-window-turn') {
    session = await start(); const { app } = session
    const main = await signedInMain(app)
    check('Keep Brian Nearby enabled from the app menu', (await setNearby(app, true)) === 'ok')
    const chat = await openChatWindow(app)
    const ws = workspaceOf(main.url())
    check('pet click opens the dedicated chat window for the main window workspace', d.isChatRoute(chat.url()) && chat.url().includes(ws), d.shortUrl(chat.url()))
    await d.shot(chat, out, '01-chat-open')
    mark('send')
    await chatSend(chat, `Hello from the packaged desktop #${T('dq-chat1')}`)
    const f = await waitFrames(chat, (fr) => fr.some((x) => x.type === 'done' || x.type === 'turn_completed'), 90000, 'turn end')
    await chat.waitForTimeout(1500)
    const sid = sessionIdFrom(f)
    const text = await d.bodyText(chat)
    await d.shot(chat, out, '02-chat-reply')
    check('fixed reply painted in the chat window', /Hello from the packaged/i.test(text) && /(echo|Hello)/i.test(text), text.slice(-300))
    const tok = (await owner()).accessToken
    const m = sid ? await waitAssistant(tok, sid, /./, 30000) : { ok: false, rows: [] }
    check('server persisted user and assistant rows', m.ok && m.rows.some((r) => r.role === 'user'), m.rows)
    check('exactly one model call for the turn', providerCalls(T('dq-chat1')).filter((c) => c.kind === 'text').length === 1, providerCalls(T('dq-chat1')).map((c) => c.kind))
    result.sessionId = sid
    result.frames = summarize(f)
  }

  if (journey === 'close-unload-identity') {
    session = await start(); const { app } = session
    const main = await signedInMain(app)
    const ws = workspaceOf(main.url())
    await setNearby(app, true)
    const chat = await openChatWindow(app)
    mark('send-slow')
    await chatSend(chat, `slow:40 Long reply in flight #${T('dq-close')}`)
    const f = await waitFrames(chat, (fr) => deltaCount(fr) >= 4, 60000, 'streaming deltas')
    const sid = sessionIdFrom(f)
    await d.shot(chat, out, '01-turn-in-flight')
    const tokenBefore = await accessToken(main)
    await armSignOutProbe(app)
    mark('sign-out')
    await main.evaluate(() => window.usebrianDesktop.signOut())
    await sleep(4000)
    await abortOnModal('sign-out')
    const { order } = await judgeSignOut(app, main, tokenBefore)
    const wins = await d.windows(app)
    result.windowsAfterSignOut = wins
    check('identity change retires the chat window (closed, not hidden)', order.some((o) => o.ev === 'chat-closed') && !order.some((o) => o.ev === 'window-url' && /desktop\/chat/.test(o.url) && o.t < (result.signOutProbe?.contextAt ?? Infinity)), wins)
    const closedAt = order.find((o) => o.ev === 'chat-closed')?.t
    const firstMainChange = order.find((o) => o.ev === 'main-nav' || (o.ev === 'main-ipc' && /session-cleared/.test(o.ch)))?.t
    check('chat window closed before the main window left the identity', closedAt && (!firstMainChange || closedAt <= firstMainChange), order)
    await d.shot(main, out, '02-main-after-sign-out')
    const stopReqs = requests.filter((r) => /\/api\/chat\/stop/.test(r.url))
    check('closing the chat window sent no Stop request', stopReqs.length === 0, stopReqs)
    const tok = (await owner()).accessToken
    const done = sid ? await waitAssistant(tok, sid, new RegExp(`${T('dq-close')}.*w40`), 90000) : { ok: false }
    check('turn not stopped by the window close: full reply persisted server-side', done.ok, done.rows)
    const calls = providerCalls(T('dq-close'))
    check('provider stream ran to completion (no abort)', calls.length > 0 && !calls.some((c) => /abort/i.test(c.kind ?? '')), calls.map((c) => c.kind))
    result.sessionId = sid
    result.sessionState = sid ? await sessionState(tok, sid) : null
    result.signedOutBody = (await d.bodyText(main)).slice(0, 500)
    // Sign back in through the account view.
    const mainNow = await d.mainPage(app, 30000)
    await d.shot(mainNow, out, '03-account-view')
    const retry = mainNow.getByRole('button', { name: /Retry|Sign in|Continue|Open/i }).first()
    let back = false
    for (let i = 0; i < 3 && !back; i++) {
      await retry.click({ timeout: 10000 }).catch((e) => note(`account view action: ${String(e).slice(0, 120)}`))
      back = await mainNow.waitForURL(/#\/w\//, { timeout: 30000 }).then(() => true).catch(() => false)
    }
    check('signing in again lands in the workspace', back, d.shortUrl(mainNow.url()))
    if (back) {
      mark('reveal')
      await mainNow.waitForTimeout(3000)
      const chat2 = await openOrReuseChat(app).catch((e) => { note(`reopen chat: ${e.message}`); return null })
      check('reveal after identity change opens the chat window for the replacement main window context', chat2 && chat2.url().includes(workspaceOf(mainNow.url())), chat2 ? d.shortUrl(chat2.url()) : null)
      if (chat2) {
        await chat2.waitForTimeout(4000)
        await d.shot(chat2, out, '04-chat-revealed')
        const t2 = await d.bodyText(chat2)
        result.revealedChatText = t2.slice(0, 600)
        check('revealed chat window has no in-flight state from the retired renderer (no Stop control)', !(await chat2.getByRole('button', { name: 'Stop generating' }).isVisible().catch(() => false)))
      }
    }
    result.workspaceBefore = ws
  }

  if (journey === 'retire-inflight' || journey === 'retire-idle') {
    // Sign-out with the chat window open: the retire path (closeHonoringUnload) in the packaged app.
    // The main process is observed through the bootstrap's [m5-window]/[m5-dialog] log lines, which
    // survive a blocked main process; server state and the provider log judge the turn.
    const inflight = journey === 'retire-inflight'
    session = await start(); let { app } = session
    let main = await signedInMain(app)
    await setNearby(app, true)
    const chat = await openChatWindow(app)
    let sid = null
    const tag = inflight ? T('dq-retire-flight') : null
    if (inflight) {
      await chatSend(chat, `slow:40 Long reply in flight #${tag}`)
      const f = await waitFrames(chat, (fr) => deltaCount(fr) >= 4, 60000, 'streaming deltas')
      sid = sessionIdFrom(f)
      await d.shot(chat, out, '01-turn-in-flight')
    } else await d.shot(chat, out, '01-chat-open-idle')
    const tokenBefore = await accessToken(main)
    await armSignOutProbe(app)
    mark('sign-out')
    await main.evaluate(() => window.usebrianDesktop.signOut())
    await sleep(6000)
    const log = readFileSync(process.env.M5_DESKTOP_LOG, 'utf8').split('\n')
    const closeLines = log.filter((l) => /\[m5-window\] (close|closed) /.test(l))
    const modal = log.filter((l) => l.includes('[m5-dialog]'))
    result.windowTrace = closeLines
    result.modal = modal
    check('chat window closed through close() after sign-out', closeLines.some((l) => /closed 3|closed \d+/.test(l)), closeLines)
    check('retire completes without a main-process exception', modal.length === 0, modal)
    if (modal.length) {
      note('main process blocked by the uncaught-exception modal; CDP and Playwright are blocked until it is dismissed')
      const tok = (await owner()).accessToken
      if (inflight) {
        const done = await waitAssistant(tok, sid, new RegExp(`${tag}.*w40`), 90000)
        check('turn not stopped by the window close: full reply persisted server-side', done.ok, done.rows)
        result.sessionState = await sessionState(tok, sid)
        const calls = providerCalls(tag)
        check('one model call, stream ran to completion', calls.filter((c) => c.kind === 'text').length === 1, calls.map((c) => c.kind))
      }
      try { session.app.process().kill('SIGKILL') } catch {}
      session = null
      // What did the sign-out leave behind? Relaunch the same profile.
      await sleep(1500)
      session = await start(); app = session.app
      const m2 = await d.mainPage(app, 60000)
      const signedIn = await m2.waitForURL(/#\/w\//, { timeout: 30000 }).then(() => true).catch(() => false)
      await m2.waitForTimeout(2500)
      await d.shot(m2, out, '02-relaunch-after-blocked-sign-out')
      result.relaunchRoute = d.shortUrl(m2.url())
      note(`relaunch after the blocked sign-out lands ${signedIn ? 'signed in' : 'signed out'} (${result.relaunchRoute}); a local OSS target re-mints the owner on start, so this does not show whether sign-out ran`)
    } else {
      await judgeSignOut(app, main, tokenBefore)
      result.windowsAfter = await d.windows(app)
      result.mainAfter = d.shortUrl(main.url())
      if (inflight) {
        const stopReqs = requests.filter((r) => /\/api\/chat\/stop/.test(r.url))
        check('closing the chat window sent no Stop request', stopReqs.length === 0, stopReqs)
        const tok = (await owner()).accessToken
        const done = await waitAssistant(tok, sid, new RegExp(`${tag}.*w40`), 90000)
        check('turn not stopped by the window close: full reply persisted server-side', done.ok, done.rows)
        result.sessionState = await sessionState(tok, sid)
        const calls = providerCalls(tag)
        check('one model call, stream ran to completion', calls.filter((c) => c.kind === 'text').length === 1, calls.map((c) => c.kind))
      }
    }
  }

  if (journey === 'nearby-boot-click') {
    // M5D-4: a pet click while the main window boots must not open a Nearby window that then closes itself.
    // Sign-out forgets the companion context and reloads the main window (a local OSS target re-mints the
    // owner), which reproduces the boot. Up to five attempts, 12 s apart (the shell's 10 s mint cooldown),
    // until a click lands between the route-derived context and the main window's context IPC.
    session = await start(); const { app } = session
    const main = await signedInMain(app)
    await setNearby(app, true)
    await d.petPage(app, 20000)
    await sleep(12000)
    const attempts = []
    let reached = null
    for (let i = 0; i < 5 && !reached; i++) {
      await armBootClickProbe(app)
      mark(`sign-out-${i + 1}`)
      await main.evaluate(() => window.usebrianDesktop.signOut())
      await sleep(6000)
      await abortOnModal('sign-out')
      const order = await app.evaluate(() => globalThis.__boot ?? [])
      const route = order.find((o) => o.ev === 'main-route' && o.ws)
      const context = order.find((o) => o.ev === 'context')
      const opened = order.filter((o) => o.ev === 'window-url' && /desktop\/chat\//.test(o.url))
      const early = opened.find((o) => context && o.t < context.t && !/assistant=/.test(o.url))
      attempts.push({ attempt: i + 1, routeAt: route?.t ?? null, contextAt: context?.t ?? null, gapMs: route && context ? context.t - route.t : null,
        clicksInGap: order.filter((o) => o.ev === 'pet-click' && route && context && o.t >= route.t && o.t < context.t).length, opened, order })
      if (early) reached = { attempt: i + 1, window: early.id, order }
      else {
        // Close any Nearby window a late click opened, then wait out the mint cooldown.
        await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) { try { if (/#\/desktop\/chat\//.test(w.webContents.getURL())) w.close() } catch {} } })
        await sleep(12000)
      }
    }
    result.attempts = attempts.map(({ order, ...rest }) => rest)
    check('a pet click landed while the main window was booting (Nearby window opened from the route context, before the context IPC)', reached, result.attempts)
    if (reached) {
      await sleep(4000)
      const order = await app.evaluate(() => globalThis.__boot ?? [])
      result.bootOrder = order
      const closed = order.find((o) => o.ev === 'window-closed' && o.id === reached.window)
      const urls = order.filter((o) => o.ev === 'window-url' && o.id === reached.window).map((o) => o.url)
      const log = readFileSync(process.env.M5_DESKTOP_LOG, 'utf8').split('\n')
      const failures = log.filter((l) => /Failed to open the Brian chat window|UnhandledPromiseRejection|reload was interrupted|reload failed/.test(l))
      check('the Nearby window stays open (not closed by its own reload)', !closed, { closed: closed ?? null })
      check('the companion context that arrived mid-load is applied (final route carries the assistant)', urls.length >= 2 && /assistant=/.test(urls.at(-1)), urls)
      check('no load failure or unhandled rejection logged for the Nearby window', failures.length === 0, failures.map((l) => l.slice(0, 240)))
      const chat = await d.chatPage(app, 20000).catch(() => null)
      const usable = chat ? await chatComposer(chat).isVisible({ timeout: 15000 }).catch(() => false) : false
      if (chat && !usable) await chatComposer(chat).waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false)
      check('the Nearby window shows a usable composer', chat && await chatComposer(chat).isVisible().catch(() => false), chat ? d.shortUrl(chat.url()) : null)
      if (chat) await d.shot(chat, out, '01-nearby-after-boot-click')
    }
  }

  if (journey === 'veto') {
    session = await start(); const { app } = session
    const main = await signedInMain(app)
    await setNearby(app, true)
    const chat = await openChatWindow(app)
    await chatComposer(chat).click()
    await chatComposer(chat).fill('Unsent draft that must survive a vetoed sign-out')
    // A page that still holds unsaved work (for example a live dock recording) vetoes unload.
    // Leave beforeunload to Electron (will-prevent-unload); Playwright must not auto-answer it over CDP.
    chat.on('dialog', (dlg) => note(`CDP dialog event ${dlg.type()} (left to Electron)`))
    await chat.evaluate(() => { window.__dqVeto = (e) => { e.preventDefault(); e.returnValue = '' }; window.addEventListener('beforeunload', window.__dqVeto) })
    await chat.mouse.click(5, 5)
    await main.evaluate(() => window.usebrianDesktop.signOut())
    await sleep(4000)
    await abortOnModal('sign-out')
    const wins = await d.windows(app)
    const chatWin = wins.find((w) => /desktop\/chat/.test(w.url))
    check('veto keeps the chat window open and shown', chatWin && chatWin.visible, wins)
    check('veto cancels sign-out: main window still in the workspace', /#\/w\//.test(main.url()), d.shortUrl(main.url()))
    const draft = await chatComposer(chat).inputValue().catch(() => null)
    check('unsent draft intact after the veto', draft === 'Unsent draft that must survive a vetoed sign-out', draft)
    await d.shot(chat, out, '01-after-veto')
    await chat.evaluate(() => window.removeEventListener('beforeunload', window.__dqVeto))
    await chatComposer(chat).fill('')
  }

  if (journey === 'dock-page') {
    session = await start(); const { app } = session
    const main = await signedInMain(app)
    await setNearby(app, false)
    const ws = workspaceOf(main.url())
    await main.evaluate((w) => { location.hash = `#/w/${w}/tasks` }, ws)
    await main.waitForTimeout(5000)
    await d.shot(main, out, '01-tasks')
    // The collapsed dock is a pill labelled "Ask anything..."; its overlay expands the dock on click.
    await main.locator('button', { hasText: 'Ask anything' }).filter({ visible: true }).first().click()
    await main.waitForTimeout(1500)
    await d.shot(main, out, '02-dock-open')
    const box = main.locator('[data-testid="chat-composer-input"]').filter({ visible: true }).first()
    await box.click(); await box.fill(`slow:40 Dock turn crossing to the page #${T('dq-dock')}`)
    await main.keyboard.press('Enter')
    const f = await waitFrames(main, (fr) => deltaCount(fr) >= 4, 60000, 'dock deltas')
    const sid = sessionIdFrom(f)
    const postsBefore = requests.filter((r) => r.method === 'POST' && /\/api\/chat(\?|$)/.test(r.url)).length
    await d.shot(main, out, '03-dock-in-flight')
    await main.evaluate(([w, s]) => { location.hash = `#/w/${w}/chat?s=${s}` }, [ws, sid])
    await main.waitForTimeout(3000)
    await d.shot(main, out, '04-page-same-session')
    const stopVisible = await d.stopBtn(main).isVisible().catch(() => false)
    const text = await d.bodyText(main)
    check('page shows the dock live turn (Stop visible, partial text)', stopVisible && /w\d+/.test(text), { stopVisible, tail: text.slice(-200) })
    const landedOnPage = await d.waitText(main, new RegExp(`Slow reply #${T('dq-dock')}:[^\\n]*w40`), 60000)
    check('full reply lands on the page', landedOnPage)
    await main.waitForTimeout(2000)
    await d.shot(main, out, '05-page-completed')
    const posts = requests.filter((r) => r.method === 'POST' && /\/api\/chat(\?|$)/.test(r.url))
    check('one POST /api/chat for the turn (no resend on attach)', posts.length === 1 && postsBefore === 1, posts)
    const tok = (await owner()).accessToken
    await waitAssistant(tok, sid, new RegExp(`${T('dq-dock')}.*w40`), 30000)
    const m = await messages(tok, sid)
    const pageText = await d.bodyText(main)
    const occurrences = pageText.split(`Dock turn crossing to the page #${T('dq-dock')}`).length - 1
    check('after completion the user row appears once on the page', occurrences === 1, { occurrences })
    const mine = m.rows.filter((r) => r.text.includes(T('dq-dock')))
    check('server rows for this turn: one user, one assistant', mine.filter((r) => r.role === 'user').length === 1 && mine.filter((r) => r.role === 'assistant').length === 1, mine)
    result.sessionId = sid
    result.frames = summarize(await framesSafe(main))
  }

  if (journey === 'restart') {
    session = await start(); let { app } = session
    let main = await signedInMain(app)
    const ws = workspaceOf(main.url())
    await main.evaluate((w) => { location.hash = `#/w/${w}/chat` }, ws)
    await d.composer(main).waitFor({ state: 'visible', timeout: 60000 })
    await main.getByRole('button', { name: 'New chat' }).first().click().catch(() => {})
    await main.waitForTimeout(1500)
    await d.send(main, `slow:60 Reply that spans a restart #${T('dq-restart')}`)
    const f = await waitFrames(main, (fr) => deltaCount(fr) >= 4, 60000, 'deltas')
    const sid = sessionIdFrom(f)
    await d.shot(main, out, '01-in-flight')
    mark('quit')
    await session.app.close()
    mark('quit-done')
    const tok = (await owner()).accessToken
    const midState = await sessionState(tok, sid)
    result.serverStateWhileClosed = midState
    mark('relaunch')
    session = await start(); app = session.app
    main = await signedInMain(app)
    mark('relaunched')
    const landing = d.shortUrl(main.url())
    result.landingRoute = landing
    if (!main.url().includes(sid)) await main.evaluate(([w, s]) => { location.hash = `#/w/${w}/chat?s=${s}` }, [ws, sid])
    await main.waitForTimeout(2500)
    await d.shot(main, out, '02-after-relaunch')
    const live = await d.stopBtn(main).isVisible().catch(() => false)
    const landed = await d.waitText(main, new RegExp(`${T('dq-restart')}:[^\\n]*w60`), 90000)
    await main.waitForTimeout(1500)
    await d.shot(main, out, '03-reply')
    const f2 = await framesSafe(main)
    result.framesAfterRelaunch = summarize(f2)
    const fin = await sessionState(tok, sid)
    result.serverStateAfter = fin
    const m = await messages(tok, sid)
    check('relaunch restores the signed-in workspace without a prompt', /#\/w\//.test(main.url()))
    check('reply shown after relaunch (re-attached live or loaded from history)', landed, { liveTurnOnReopen: live, frames: result.framesAfterRelaunch.slice(0, 12) })
    check('server persisted one assistant row with the full reply', m.rows.filter((r) => r.role === 'assistant' && r.text.includes(T('dq-restart')) && /w60/.test(r.text)).length === 1, m.rows)
    check('turn ran once (one model call) across quit and relaunch', providerCalls(T('dq-restart')).filter((c) => c.kind === 'text').length === 1, providerCalls(T('dq-restart')).map((c) => c.kind))
    note(`outcome: ${live ? 're-attached to the live turn' : 'turn already finished; history load'}; server turnEndReason=${fin.turnEndReason}`)
    result.sessionId = sid
  }

  if (journey === 'stop') {
    session = await start(); const { app } = session
    const main = await signedInMain(app)
    const ws = workspaceOf(main.url())
    await main.evaluate((w) => { location.hash = `#/w/${w}/chat` }, ws)
    await d.composer(main).waitFor({ state: 'visible', timeout: 60000 })
    await main.getByRole('button', { name: 'New chat' }).first().click().catch(() => {})
    await main.waitForTimeout(1500)
    await d.send(main, `slow:80 Reply to be stopped #${T('dq-stop')}`)
    const f = await waitFrames(main, (fr) => deltaCount(fr) >= 6, 60000, 'deltas')
    const sid = sessionIdFrom(f)
    await d.shot(main, out, '01-in-flight')
    mark('stop')
    await d.stopBtn(main).click()
    await main.waitForTimeout(5000)
    await d.shot(main, out, '02-after-stop')
    const text = await d.bodyText(main)
    const stopReq = requests.filter((r) => /\/api\/chat\/stop/.test(r.url))
    const tok = (await owner()).accessToken
    const m = await messages(tok, sid)
    const ff = await framesSafe(main)
    result.frames = summarize(ff)
    result.framesTail = ff.slice(-6)
    result.requestStatuses = (await d.reqs(main).catch(() => [])).filter((r) => r.status >= 400 || r.error).map((r) => ({ url: r.url.slice(0, 120), status: r.status, error: r.error }))
    result.stopResponses = (await d.reqs(main).catch(() => [])).filter((r) => /stop/.test(r.url))
    check('Stop sends one /api/chat/stop', stopReq.length === 1, stopReq)
    check('Stop control clears', !(await d.stopBtn(main).isVisible().catch(() => false)))
    check('no error banner after a confirmed stop', !/Something went wrong/i.test(text), text.slice(-300))
    check('stopped state shown to the user', /stopped this turn/i.test(text), text.slice(-300))
    check('partial text kept (persisted assistant row)', m.rows.some((r) => r.role === 'assistant' && /w\d/.test(r.text)), m.rows)
    await main.waitForTimeout(6000)
    const calls = providerCalls(T('dq-stop'))
    result.providerCalls = calls.map((c) => c.kind)
    result.sessionId = sid
  }
} catch (e) {
  check(`journey completed without harness error`, false, String(e?.stack ?? e).slice(0, 800))
} finally {
  if (session) {
    for (const p of session.app.windows()) { try { result[`final:${d.shortUrl(p.url()).slice(0, 60)}`] = (await d.bodyText(p)).slice(-400) } catch {} }
    result.windows = await d.windows(session.app).catch(() => null)
    result.consoleErrors = session.consoleErrors
    result.appLog = session.log
    await session.app.close().catch(() => {})
  }
  result.requests = requests
  result.finishedAt = new Date().toISOString()
  d.writeJson(join(out, 'result.json'), result)
  const failed = checks.filter((c) => !c.ok).length
  console.log(`${journey}: ${checks.length - failed}/${checks.length} checks passed`)
}
