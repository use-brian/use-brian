// [COMP:app-desktop/offline-restart] M5 packaged-desktop qualification driver (test harness only).
// Launches the unsigned qualification package (see m5-desktop-bootstrap.mjs) with Playwright's
// Electron support against a throwaway profile and a local stack. Observation reuses the app-web
// M5 harness TEE init script (SSE frame tee; no fault injection unless a journey calls it).
// Env: M5_DESKTOP_EXE (packaged executable), M5_DESKTOP_PROFILE, M5_DESKTOP_HOME (HOME for the app),
// M5_DESKTOP_APP_URL, M5_DESKTOP_API_URL, PLAYWRIGHT_MODULE (playwright-core index.mjs in a scratch dir).
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const { _electron } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core')
const { TEE } = await import('../../app-web/scripts/m5-qualification-harness.mjs')

const EXE = process.env.M5_DESKTOP_EXE
export const PROFILE = process.env.M5_DESKTOP_PROFILE
export const APP = process.env.M5_DESKTOP_APP_URL
const API = process.env.M5_DESKTOP_API_URL

export function ensure(dir) { mkdirSync(dir, { recursive: true }); return dir }
export function writeJson(path, obj) { writeFileSync(path, JSON.stringify(obj, null, 2)) }

/** Launch the packaged app; every page gets the TEE observer and console capture. */
export async function launchApp(log = []) {
  const env = { ...process.env, HOME: process.env.M5_DESKTOP_HOME, M5_DESKTOP_PROFILE: PROFILE, M5_DESKTOP_APP_URL: APP, M5_DESKTOP_API_URL: API }
  delete env.PLAYWRIGHT_MODULE
  const app = await _electron.launch({ executablePath: EXE, env, timeout: 120000 })
  const proc = app.process()
  const tee = (kind) => (d) => { log.push({ t: Date.now(), [kind]: String(d).slice(0, 2000) }); if (process.env.M5_DESKTOP_LOG) appendFileSync(process.env.M5_DESKTOP_LOG, `${new Date().toISOString()} ${kind} ${String(d)}`) }
  proc.stdout?.on('data', tee('out'))
  proc.stderr?.on('data', tee('err'))
  const consoleErrors = []
  const wire = (page) => {
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push({ t: Date.now(), url: page.url().slice(-80), text: m.text().slice(0, 400) }) })
    page.on('pageerror', (e) => consoleErrors.push({ t: Date.now(), url: page.url().slice(-80), text: 'pageerror: ' + e.message.slice(0, 400) }))
    page.setDefaultTimeout(30000)
  }
  await app.context().addInitScript(TEE)
  app.on('window', wire)
  for (const p of app.windows()) wire(p)
  return { app, consoleErrors, log }
}

/** Window inventory from the main process (title, URL, visibility). */
export async function windows(app) {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({
    id: w.id, title: w.getTitle(), url: w.webContents.getURL(), visible: w.isVisible(), destroyed: w.isDestroyed(),
  }))).then((list) => list.map((w) => ({ ...w, url: shortUrl(w.url) })))
}
/** Bundled renderer URLs carry the whole public config in the query; keep the route and entry state. */
export function shortUrl(raw) {
  try {
    const u = new URL(raw)
    const entry = u.searchParams.get('accountEntry')
    const file = u.pathname.split('/').slice(-2).join('/')
    return `${u.protocol === 'file:' ? file : u.origin + u.pathname}${entry ? `?accountEntry=${entry}` : ''}${u.hash}`
  } catch { return raw }
}

export const isChatRoute = (url) => /#\/desktop\/chat\//.test(url)
const isPet = (url) => /brian-pet\.html/.test(url)
function pageWhere(app, pred) { return app.windows().find((p) => { try { return pred(p.url()) } catch { return false } }) }
async function waitPage(app, pred, timeout = 60000, label = 'page') {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const p = pageWhere(app, pred)
    if (p) return p
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`timeout waiting for ${label}`)
}
export const mainPage = (app, timeout) => waitPage(app, (u) => /renderer\/index\.html/.test(u) && !isChatRoute(u), timeout, 'main window')
export const chatPage = (app, timeout) => waitPage(app, isChatRoute, timeout, 'chat window')
export const petPage = (app, timeout) => waitPage(app, isPet, timeout, 'Brian pet')

/** The first window loads before the init script is registered; install the observer in place (idempotent). */
export async function observe(page) { await page.evaluate(TEE) }
export const frames = (page) => page.evaluate(() => window.__m5frames ?? [])
export const reqs = (page) => page.evaluate(() => window.__m5reqs ?? [])
export function composer(page) { return page.getByRole('textbox', { name: 'Ask a question or describe a task' }).filter({ visible: true }).first() }
const sendBtn = (page) => page.locator('[data-testid="chat-composer-send"]:visible').first()
export const stopBtn = (page) => page.getByRole('button', { name: 'Stop generating' }).filter({ visible: true }).first()
export async function send(page, text) {
  const box = composer(page); await box.click(); await box.fill(text)
  await sendBtn(page).click()
}
export async function bodyText(page) { return page.locator('body').first().innerText().catch(() => '') }
export async function waitText(page, re, timeout = 60000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const t = await bodyText(page)
    if (re.test(t)) return true
    await page.waitForTimeout(300)
  }
  return false
}
export async function shot(page, dir, name) { try { await page.screenshot({ path: join(dir, `${name}.png`) }) } catch (e) { return String(e) } return null }

export async function ownerToken() {
  const r = await fetch(`${API}/auth/local-session`, { method: 'POST' }); return r.json()
}
export async function api(tok, method, path, body) {
  const r = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  let j = null; try { j = await r.json() } catch {}
  return { status: r.status, body: j }
}
