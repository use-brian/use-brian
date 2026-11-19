#!/usr/bin/env node
// [COMP:app-web/conversation-controller] M5 shared-controller browser qualification journeys.
// Receipt: brian-platform docs/plans/evidence/oss-chat-replacement/canonical-publication/m5-browser-qualification/README.md
// Usage: node m5-controller-qualification-browser.mjs <journey> <width> <outDir>
// Requires a running local stack (API 4100, app 3003) whose model provider is m5-scripted-provider.mjs,
// and M5_WORK_DIR/fixtures.json from the receipt's fixture steps. Journeys: new-chat-reload, composer-accept,
// stop, network-loss, question, switch, approval, room, uploads, workbench-stop, dock, identity, restart, restart2.
import { settle, mention, keyFrames, launch, send, frames, reqs, ensure, writeJson, waitFrame, stopBtn, sendBtn, composer, summarizeFrames, providerCalls, token, api, APP, bodyText } from './m5-qualification-harness.mjs'
const [, , name, widthArg, outRoot] = process.argv
const width = Number(widthArg); const height = width <= 500 ? 844 : 900
const out = ensure(`${outRoot}/${name}-${width}`)
const run = Date.now().toString(36)
const tag = (s) => `${name.slice(0, 6)}-${s}-${width}-${run}`
const checks = []
const check = (id, ok, detail) => { checks.push({ id, ok: Boolean(ok), detail }); console.log(ok ? 'PASS' : 'FAIL', id, detail ?? '') }
const shot = (page, n) => page.screenshot({ path: `${out}/${n}.png` }).then(() => `${out}/${n}.png`)
const J = {}
const pages = []
import * as lib from './m5-qualification-harness.mjs'
const _newCtx = lib.newCtx
const newCtxT = async (...a) => { const r = await _newCtx(...a); pages.push(r); return r }

// J1: new chat, first send adopts the session, reload mid-turn re-attaches, follow-up works.
J['new-chat-reload'] = async (b) => {
  const { page, consoleErrors } = await newCtxT(b, { width, height })
  const t = tag('a')
  await send(page, `First message slow:30 #${t}`)
  const sess = await waitFrame(page, f => f.type === 'session', 60000, 'session')
  await page.waitForURL(/[?&]s=/, { timeout: 20000 })
  const sid = new URL(page.url()).searchParams.get('s')
  check('url-adopts-session', !!sid, page.url())
  await waitFrame(page, f => f.type === 'text_delta', 30000, 'text_delta')
  await shot(page, '01-mid-turn')
  const before = summarizeFrames(await frames(page))
  await page.reload({ waitUntil: 'commit' })
  await composer(page).waitFor({ timeout: 60000 })
  const follow = await waitFrame(page, f => f.stream === 'follow', 30000, 'follow frame').catch(() => null)
  check('reload-opens-follow-stream', !!follow, follow?.type)
  await shot(page, '02-after-reload')
  await page.getByText(new RegExp(`Slow reply #${t}:.*end\\.`)).first().waitFor({ timeout: 150000 })
  check('reply-lands-after-reload', true)
  const afterReload = summarizeFrames(await frames(page))
  await shot(page, '03-reply-landed')
  const rail = await page.locator(`a[href*="s=${sid}"]`).count()
  check('rail-row-present', rail > 0 || width < 768, `rail links=${rail}`)
  await stopBtn(page).waitFor({ state: 'hidden', timeout: 60000 })
  const t2 = tag('b')
  await send(page, `Follow up #${t2}`)
  await page.getByText(`Scripted reply #${t2} to:`).first().waitFor({ timeout: 60000 })
  check('follow-up-turn-completes', true)
  check('same-session-after-follow-up', new URL(page.url()).searchParams.get('s') === sid, page.url())
  check('no-duplicate-send', providerCalls(t).length === 1 && providerCalls(t2).length === 1, `calls a=${providerCalls(t).length} b=${providerCalls(t2).length}`)
  await shot(page, '04-follow-up')
  return { sessionId: sid, framesBeforeReload: before, framesAfterReload: afterReload, framesFinal: summarizeFrames(await frames(page)), consoleErrors }
}

// J2: composer clears only after acceptance; offline / rejected first send keeps the text.
J['composer-accept'] = async (b) => {
  const { page, ctx, consoleErrors } = await newCtxT(b, { width, height })
  const t = tag('a')
  let release
  const gate = new Promise(r => { release = r })
  await page.route('**/api/chat', async (route) => { if (route.request().method() === 'POST') { await gate; } await route.continue() })
  const text = `Accept me #${t}`
  await send(page, text)
  await page.waitForTimeout(1500)
  const pending = await composer(page).inputValue()
  check('text-kept-before-acceptance', pending === text, JSON.stringify(pending))
  await shot(page, '01-before-acceptance')
  release()
  await waitFrame(page, f => f.type === 'session' || f.type === 'user_message_saved', 60000, 'acceptance')
  await page.waitForTimeout(400)
  const after = await composer(page).inputValue()
  check('text-cleared-after-acceptance', after === '', JSON.stringify(after))
  await page.getByText(`Scripted reply #${t} to:`).first().waitFor({ timeout: 60000 })
  await page.unroute('**/api/chat')
  // offline first send in a new chat
  await page.getByRole('button', { name: 'New chat' }).first().click().catch(async () => page.goto(page.url().split('?')[0]))
  await composer(page).waitFor()
  const t2 = tag('off')
  const text2 = `Offline send #${t2}`
  await page.route('**/api/chat', (route) => route.request().method() === 'POST' ? route.abort('internetdisconnected') : route.continue())
  await send(page, text2)
  await page.waitForTimeout(2500)
  const kept = await composer(page).inputValue()
  check('offline-send-keeps-text', kept === text2, JSON.stringify(kept))
  await shot(page, '02-offline-send')
  await page.unroute('**/api/chat')
  // rejected (HTTP 500) first send
  await composer(page).fill('')
  const t3 = tag('rej')
  const text3 = `Rejected send #${t3}`
  await page.route('**/api/chat', (route) => route.request().method() === 'POST' ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'm5_injected_failure' }) }) : route.continue())
  await send(page, text3)
  await page.waitForTimeout(2500)
  const kept3 = await composer(page).inputValue()
  check('rejected-send-keeps-text', kept3 === text3, JSON.stringify(kept3))
  await shot(page, '03-rejected-send')
  await page.unroute('**/api/chat')
  check('nothing-auto-sent', providerCalls(t2).length === 0 && providerCalls(t3).length === 0, `offline=${providerCalls(t2).length} rejected=${providerCalls(t3).length}`)
  const posts = (await reqs(page)).filter(r => r.method === 'POST' && /\/api\/chat$/.test(r.url))
  return { chatPosts: posts.map(p => ({ status: p.status ?? null, error: p.error ?? null })), consoleErrors }
}

// J3: Stop during admission and during output; Stop failure shows stopTurnFailed.
J['stop'] = async (b) => {
  const { page, consoleErrors } = await newCtxT(b, { width, height })
  const out3 = {}
  // (a) Stop on a pending start: the POST is held 3 s in the browser so Stop is pressed before any session frame.
  let release; const gate = new Promise(r => { release = r })
  await page.route('**/api/chat', async (route) => { if (route.request().method() === 'POST') await gate; await route.continue() })
  const tp = tag('pend')
  await send(page, `Stop pending start slow:40 #${tp}`)
  await page.waitForTimeout(500)
  await stopBtn(page).click({ timeout: 5000 })
  out3.pendingClickBeforeSession = !(await frames(page)).some(f => f.type === 'session')
  check('pending-stop-click-before-session', out3.pendingClickBeforeSession)
  await page.waitForTimeout(1000)
  out3.pendingStopPostedBeforeSession = (await reqs(page)).some(r => r.url.startsWith('/api/chat/stop'))
  check('pending-stop-waits-for-turnId', !out3.pendingStopPostedBeforeSession, 'no stop POST before the original POST binds a turnId')
  release()
  const t1 = Date.now(); let stopRec
  while (Date.now() - t1 < 30000 && !((stopRec = (await reqs(page)).find(r => r.url.startsWith('/api/chat/stop'))) && stopRec.response)) await page.waitForTimeout(150)
  await page.unroute('**/api/chat')
  const sessP = (await frames(page)).find(f => f.type === 'session')
  check('pending-stop-carries-turnId', !!stopRec && !!sessP && JSON.parse(stopRec.body || '{}').turnId === sessP.turnId, stopRec?.body)
  await page.waitForTimeout(3000)
  let txt = await bodyText(page)
  out3.pendingKeyFrames = keyFrames(await frames(page)); out3.pendingStopResponse = stopRec?.response ?? null
  check('pending-stop-shows-stopped', /stopped this turn|turn was stopped/i.test(txt) && !/Something went wrong/.test(txt), (txt.match(/(You stopped this turn\.|This turn was stopped\.|Something went wrong)/g) || []).join('|'))
  check('pending-stop-no-model-output', providerCalls(tp).filter(c => c.kind === 'text').length === 0 || !(await frames(page)).some(f => f.type === 'text_delta'), `provider text calls=${providerCalls(tp).length}`)
  await shot(page, '01-stopped-pending-start')
  // (b) Stop right after the session frame (server admission / before first output)
  await page.waitForTimeout(1000)
  const na = (await frames(page)).length
  const t = tag('adm')
  // Wait for THIS turn's session frame: the pending-start case above already left one in the buffer.
  const tAdm = Date.now()
  await send(page, `Stop me early slow:40 #${t}`)
  await waitFrame(page, f => f.type === 'session' && f.t > tAdm, 30000, 'session')
  const fa = (await frames(page)).slice(na)
  out3.admissionClickAfterDeltas = fa.filter(f => f.type === 'text_delta').length
  await stopBtn(page).click({ timeout: 5000 })
  const t2s = Date.now(); let stopRec2
  while (Date.now() - t2s < 30000 && !((stopRec2 = (await reqs(page)).filter(r => r.url.startsWith('/api/chat/stop'))[1]) && stopRec2.response)) await page.waitForTimeout(150)
  await page.waitForTimeout(3000)
  txt = await bodyText(page)
  out3.admissionStopResponse = stopRec2?.response ?? null
  out3.admissionKeyFrames = keyFrames((await frames(page)).slice(na))
  check('admission-stop-shows-stopped', /stopped this turn|turn was stopped/i.test(txt.split(t)[1] ?? '') , 'stopped notice after the admission Stop')
  check('admission-no-generic-error', !/Something went wrong/.test(txt), 'generic error banner shown after admission Stop')
  await shot(page, '02-stopped-admission')
  // during output
  await page.waitForTimeout(1500)
  const n0 = (await frames(page)).length
  const t2 = tag('out')
  await send(page, `Stop me mid-output slow:80 #${t2}`)
  await waitFrame(page, f => f.type === 'text_delta' && f.d.includes('w5'), 60000, 'w5')
  let stopResolve
  await page.route('**/api/chat/stop', async (route) => { await new Promise(r => setTimeout(r, 2000)); await route.continue() })
  const deltasAtClick = (await frames(page)).slice(n0).filter(f => f.type === 'text_delta').length
  await stopBtn(page).click()
  await page.waitForTimeout(1500)
  const deltasWhilePending = (await frames(page)).slice(n0).filter(f => f.type === 'text_delta').length
  check('keeps-painting-while-stop-pending', deltasWhilePending > deltasAtClick, `deltas at click=${deltasAtClick} after 1.5s=${deltasWhilePending}`)
  await page.getByText(/You stopped this turn|This turn was stopped/).nth(1).waitFor({ timeout: 30000 }).catch(() => {})
  await page.waitForTimeout(3000)
  const settled = (await frames(page)).slice(n0)
  const deltasFinal = settled.filter(f => f.type === 'text_delta').length
  check('output-stop-ends-turn', deltasFinal < 80 && !(await stopBtn(page).isVisible().catch(() => false)), `deltas total=${deltasFinal}`)
  out3.outputFrames = summarizeFrames(settled)
  out3.outputKeyFrames = keyFrames(settled)
  const txtOut = await bodyText(page)
  out3.outputStopNoticeShown = /stopped this turn|turn was stopped/i.test(txtOut.split(t2)[1] ?? '')
  check('output-stop-keeps-partial-text', new RegExp(`Slow reply #${t2}: w1`).test(txtOut), 'partial reply kept')
  await shot(page, '03-stopped-output')
  await page.unroute('**/api/chat/stop')
  // Stop failure
  const n1 = (await frames(page)).length
  const t3 = tag('fail')
  const tFail = Date.now()
  await send(page, `Stop fails slow:40 #${t3}`)
  await waitFrame(page, f => f.type === 'text_delta' && f.d.includes('w3'), 60000, 'w3')
  await page.route('**/api/chat/stop', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"m5_injected"}' }))
  await stopBtn(page).click()
  await page.getByText('Could not stop the turn. Try again.').first().waitFor({ timeout: 15000 }).then(() => check('stop-failure-notice', true)).catch(() => check('stop-failure-notice', false, 'stopTurnFailed copy not shown'))
  await shot(page, '04-stop-failed')
  await page.unroute('**/api/chat/stop')
  await waitFrame(page, f => f.type === 'done' && f.t > tFail && (f.turnId ?? '') !== '' , 90000, 'done').catch(() => {})
  await page.waitForTimeout(2000)
  const txtF = await bodyText(page)
  check('turn-continues-after-stop-failure', new RegExp(`Slow reply #${t3}: w1 .*w40 end`).test(txtF.replace(/\s+/g, ' ')), 'reply completes after failed Stop')
  out3.failFrames = summarizeFrames((await frames(page)).slice(n1))
  await shot(page, '05-after-stop-failure')
  return { ...out3, consoleErrors }
}


// J4: network loss mid-turn: reconnecting line, mirror bubble, reply lands, no duplicate send; uncertain queued text returns.
J['network-loss'] = async (b) => {
  const { page, ctx, consoleErrors } = await newCtxT(b, { width, height })
  const o = {}
  const t = tag('a'), tq = tag('q')
  await send(page, `Network loss slow:50 #${t}`)
  await waitFrame(page, f => f.type === 'text_delta' && f.d.includes('w4'), 60000, 'w4')
  // queued input whose acknowledgement is lost: the server receives it, the browser sees a reset
  await page.route('**/api/chat', async (route) => {
    const req = route.request()
    if (req.method() === 'POST' && (req.postData() || '').includes(tq)) { try { await route.fetch() } catch {} ; return route.abort('connectionreset') }
    return route.continue()
  })
  await composer(page).fill(`Queued during loss #${tq}`)
  await sendBtn(page).click()
  await page.waitForTimeout(1200)
  await page.unroute('**/api/chat')
  await shot(page, '00-after-queued-ack-lost')
  o.composerAfterLostAck = await composer(page).inputValue()
  await ctx.setOffline(true)
  o.cut = await page.evaluate(() => window.__m5cut('direct'))
  await page.waitForTimeout(1500)
  await shot(page, '01-offline')
  const txtOff = await bodyText(page)
  o.reconnectNoticeWhileOffline = /Connection dropped/.test(txtOff)
  await page.waitForTimeout(4000)
  await ctx.setOffline(false)
  await page.waitForTimeout(1500)
  await shot(page, '02-back-online')
  const txtOn = await bodyText(page)
  check('reconnecting-notice', o.reconnectNoticeWhileOffline || /Connection dropped/.test(txtOn), 'turnReconnecting copy shown')
  await page.waitForFunction((tg) => new RegExp(`Slow reply #${tg}: w1 .*w50 end`).test(document.body.innerText.replace(/\s+/g, ' ')), t, { timeout: 90000 })
    .then(() => check('reply-lands-after-reconnect', true)).catch(() => check('reply-lands-after-reconnect', false))
  await shot(page, '03-reply-landed')
  await stopBtn(page).waitFor({ state: 'hidden', timeout: 90000 }).catch(() => {})
  await page.waitForTimeout(2000)
  await shot(page, '04-turn-settled')
  const txtEnd = await bodyText(page)
  o.genericErrorShown = /Something went wrong/.test(txtEnd)
  check('no-generic-error-after-transport-loss', !o.genericErrorShown, 'generic error banner after a transport drop')
  o.queuedChipStillShown = await page.getByText(`Queued during loss #${tq}`).count()
  const f = await frames(page)
  o.frames = summarizeFrames(f); o.keyFrames = keyFrames(f)
  check('follow-stream-used', f.some(x => x.stream === 'follow'), 'follow stream opened after loss')
  const chatPosts = (await reqs(page)).filter(r => r.method === 'POST' && r.url === '/api/chat')
  o.chatPosts = chatPosts.map(r => ({ status: r.status ?? null, error: r.error ?? null, body: (r.body || '').slice(0, 90) }))
  check('no-duplicate-original-send', chatPosts.filter(r => (r.body || '').includes(t)).length === 1 && providerCalls(t).filter(c => c.kind === 'text').length === 1, `posts=${chatPosts.filter(r => (r.body || '').includes(t)).length} provider=${providerCalls(t).length}`)
  check('uncertain-queued-not-resent', chatPosts.filter(r => (r.body || '').includes(tq)).length === 1, `queued posts=${chatPosts.filter(r => (r.body || '').includes(tq)).length}`)
  const comp = await composer(page).inputValue()
  o.composerAfter = comp
  // chat-app.md M5Q-11: uncertain queued text is reconciled against authorized history; text the server applied
  // (a user row written after it was queued) is shown once as delivered and not returned, otherwise it returns.
  const lsid = new URL(page.url()).searchParams.get('s'); const ltok = await token()
  const lrows = lsid ? (await api(ltok.accessToken, 'GET', `/api/sessions/${lsid}/messages`)).body : null
  o.queuedPersisted = (Array.isArray(lrows) ? lrows : (lrows?.messages ?? [])).filter(r => r.role === 'user' && JSON.stringify(r.content).includes(tq)).length
  const shownQ = await page.getByText(`Queued during loss #${tq}`).filter({ visible: true }).count()
  check('uncertain-queued-reconciled', o.queuedPersisted === 1 ? (!comp.includes(tq) && shownQ === 1) : comp.includes(tq), `persisted=${o.queuedPersisted} shown=${shownQ} composer=${JSON.stringify(comp)}`)
  return { ...o, consoleErrors }
}

// J7: question answer and cancel; resumed reply arrives; record the resume re-probe behaviour.
// askquestion-suspend-resume.md "Question payload contract": the question stays visible live, after `done` and after a
// reload (M5Q-13); served options render as single choices in the project Select (pending-question-panel.tsx); the
// answer resumes the turn through a user-envelope resume (Path B), so the resumed reply is the model's next answer,
// not a tool-role "Tool step finished" line.
J['question'] = async (b) => {
  const { page, consoleErrors } = await newCtxT(b, { width, height })
  const o = {}
  const t = tag('a')
  const qText = `Which colour should the M5 check use #${t}?`
  const visibleQ = () => page.getByText(qText).filter({ visible: true }).count()
  const optionLabels = async () => {
    const trig = page.locator('[data-slot="select-trigger"]').filter({ visible: true }).first()
    if (!(await trig.isVisible().catch(() => false))) return []
    await trig.click(); await page.waitForTimeout(500)
    return (await page.locator('[data-slot="select-item"]').filter({ visible: true }).allInnerTexts()).map(x => x.trim())
  }
  await send(page, `Question please ask: #${t}`)
  await page.getByText(qText).first().waitFor({ timeout: 60000 }).catch(() => {})
  o.questionLiveBeforeDone = await visibleQ() > 0
  await page.getByText('I need your input').first().waitFor({ timeout: 60000 })
  // The page reloads history at `done`; the question must survive that read (M5Q-13).
  await page.waitForTimeout(2500)
  check('question-panel-shown', await visibleQ() > 0, `question visible after done (live before done=${o.questionLiveBeforeDone})`)
  await shot(page, '01-question')
  o.optionsLive = await optionLabels()
  check('question-options-rendered', o.optionsLive.includes('Blue') && o.optionsLive.includes('Green'), JSON.stringify(o.optionsLive))
  await shot(page, '01b-options')
  await page.keyboard.press('Escape').catch(() => {})
  await page.reload({ waitUntil: 'commit' }); await composer(page).waitFor({ timeout: 60000 })
  await page.getByText('I need your input').first().waitFor({ timeout: 30000 }).catch(() => {})
  await page.waitForTimeout(2500)
  check('question-shown-after-reload', await visibleQ() > 0, 'question visible after a reload')
  o.optionsReload = await optionLabels()
  check('question-options-after-reload', o.optionsReload.includes('Blue') && o.optionsReload.includes('Green'), JSON.stringify(o.optionsReload))
  await shot(page, '02-question-after-reload')
  const nReq = (await reqs(page)).length, nFr = (await frames(page)).length
  const replies = async () => ((await bodyText(page)).match(/Scripted reply[^\n]*|Tool step finished[^\n]*/g) || [])
  o.repliesBeforeAnswer = await replies()
  await page.locator('[data-slot="select-item"]').filter({ visible: true }).filter({ hasText: /^\s*Green\s*$/ }).first().click()
  await page.waitForTimeout(300)
  const tAns = Date.now()
  await page.getByRole('button', { name: 'Send answer' }).click()
  const arrived = await page.waitForFunction((n) => (document.body.innerText.match(/Scripted reply[^\n]*|Tool step finished[^\n]*/g) || []).length > n, o.repliesBeforeAnswer.length, { timeout: 150000 }).then(() => Date.now() - tAns).catch(() => null)
  check('resumed-reply-arrives', arrived !== null, arrived !== null ? `${arrived} ms after answer` : 'no resumed reply within 150 s')
  await page.waitForTimeout(1500)
  o.repliesAfterAnswer = await replies()
  await shot(page, '03-after-answer')
  const after = (await reqs(page)).slice(nReq)
  const rel = after.filter(r => /\/api\/sessions\/[0-9a-f-]{36}(\/|$)/.test(r.url))
  o.answerRequests = rel.map(r => ({ dt: r.t - tAns, m: r.method, u: r.url.replace(/[0-9a-f-]{36}/g, ':id'), s: r.status ?? null, body: r.body ?? undefined, resp: r.response ? r.response.slice(0, 160) : undefined }))
  o.resumeFrames = summarizeFrames((await frames(page)).slice(nFr))
  o.followOpensAfterAnswer = after.filter(r => r.url.includes('/stream')).length
  o.pendingProbesAfterAnswer = after.filter(r => r.url.includes('/pending')).length
  o.sessionGetsAfterAnswer = after.filter(r => /\/api\/sessions\/[0-9a-f-]{36}$/.test(r.url)).length
  o.messageReloadsAfterAnswer = after.filter(r => r.url.includes('/messages')).length
  const txtQ = await bodyText(page)
  o.userVisibleAfterFailure = /Something went wrong|could not|Couldn't|failed/i.test(txtQ) ? 'error shown' : 'no error shown'
  check('no-resume-failure', !/couldn't continue this conversation|could not be completed|Something went wrong/i.test(txtQ), o.userVisibleAfterFailure)
  const qsid = new URL(page.url()).searchParams.get('s')
  if (qsid) { const qt = await token(); const m = await api(qt.accessToken, 'GET', `/api/sessions/${qsid}/messages`); const rows = Array.isArray(m.body) ? m.body : (m.body?.messages ?? []); o.persisted = rows.map(r => `${r.role}: ${JSON.stringify(r.content).slice(0, 160)}`) }
  await settle(page)
  // cancel variant
  const t2 = tag('c')
  await send(page, `Question to cancel ask: #${t2}`)
  await page.getByText(`Which colour should the M5 check use #${t2}?`).first().waitFor({ timeout: 60000 })
  await page.getByText('I need your input').first().waitFor({ timeout: 60000 }).catch(() => {})
  await page.getByRole('button', { name: 'Cancel', exact: true }).first().click()
  await page.waitForTimeout(800)
  const confirmBtn = page.getByRole('alertdialog').getByRole('button').filter({ hasNotText: 'Keep waiting' }).first()
  if (await confirmBtn.isVisible().catch(() => false)) await confirmBtn.click()
  await page.waitForTimeout(4000)
  const txt = await bodyText(page)
  check('cancel-clears-question', !txt.includes(`Which colour should the M5 check use #${t2}?`) || !(await page.getByText('I need your input').isVisible().catch(() => false)), 'question panel gone after cancel')
  check('composer-usable-after-cancel', await composer(page).isEditable(), '')
  await shot(page, '04-cancelled')
  return { ...o, consoleErrors }
}

// J8: A to B to A mid-turn keeps the turn live; New chat mid-turn leaves the old turn running.
J['switch'] = async (b) => {
  const { page, consoleErrors } = await newCtxT(b, { width, height })
  const o = {}
  const tA = tag('a')
  await send(page, `Chat A slow:60 #${tA}`)
  await page.waitForURL(/[?&]s=/)
  const urlA = page.url(); const sidA = new URL(urlA).searchParams.get('s')
  await waitFrame(page, f => f.type === 'text_delta' && f.d.includes('w3'), 60000, 'w3')
  // to B (new chat), send a quick turn
  await page.getByRole('button', { name: 'New chat' }).first().click()
  await page.waitForFunction(() => !new URL(location.href).searchParams.get('s'), null, { timeout: 15000 }).catch(() => {})
  const tB = tag('b')
  await send(page, `Chat B #${tB}`)
  await page.getByText(`Scripted reply #${tB} to:`).first().waitFor({ timeout: 60000 })
  const sidB = new URL(page.url()).searchParams.get('s')
  check('b-is-separate-session', sidB && sidB !== sidA, `${sidA} vs ${sidB}`)
  await shot(page, '01-chat-b')
  // back to A while its turn still runs
  const nF = (await frames(page)).length
  // in-app navigation back to A (client router, as a rail click does)
  await routerPush(page, new URL(urlA).pathname + new URL(urlA).search)
  await composer(page).waitFor()
  await page.waitForFunction((tg) => new RegExp(`Slow reply #${tg}: w1`).test(document.body.innerText), tA, { timeout: 30000 }).catch(() => {})
  const liveOnReturn = await stopBtn(page).isVisible().catch(() => false)
  const txtR = await bodyText(page)
  o.returnRequests = (await reqs(page)).slice(-40).filter(r => r.url.includes(sidA)).map(r => `${r.method} ${r.url.replace(/[0-9a-f-]{36}/g, ':id')} ${r.status ?? r.error ?? ''}`)
  o.returnFrames = summarizeFrames((await frames(page)).slice(nF))
  check('a-live-on-return', liveOnReturn && new RegExp(`Slow reply #${tA}: w1`).test(txtR), `stop visible=${liveOnReturn}`)
  await shot(page, '02-back-to-a-live')
  await page.waitForFunction((tg) => new RegExp(`Slow reply #${tg}: w1 .*w60 end`).test(document.body.innerText.replace(/\s+/g, ' ')), tA, { timeout: 90000 })
    .then(() => check('a-completes', true)).catch(() => check('a-completes', false))
  check('a-not-resent', providerCalls(tA).filter(c => c.kind === 'text').length === 1, `provider calls=${providerCalls(tA).length}`)
  await settle(page)
  // New chat mid-turn
  const tC = tag('c')
  await send(page, `Chat C slow:40 #${tC}`)
  await waitFrame(page, f => f.type === 'text_delta' && f.d.includes('w3'), 60000, 'w3 C')
  const urlC = page.url()
  await page.getByRole('button', { name: 'New chat' }).first().click()
  const tok = await token(); let persisted = false
  for (let i = 0; i < 40 && !persisted; i++) {
    await page.waitForTimeout(3000)
    const msgs = await api(tok.accessToken, 'GET', `/api/sessions/${new URL(urlC).searchParams.get('s')}/messages`)
    const rows = Array.isArray(msgs.body) ? msgs.body : (Array.isArray(msgs.body?.messages) ? msgs.body.messages : [])
    persisted = rows.some(m => m.role === 'assistant' && JSON.stringify(m.content).includes(`#${tC}`) && JSON.stringify(m.content).includes('w40 end'))
  }
  check('new-chat-leaves-turn-running', persisted && !(await reqs(page)).some(r => r.url.startsWith('/api/chat/stop')), `assistant row persisted=${persisted}`)
  o.provider = { a: providerCalls(tA).length, c: providerCalls(tC).length }
  return { ...o, consoleErrors }
}

// J6a: approval in a personal chat: live approve, live deny, restored after reload.
J['approval'] = async (b) => {
  const { page, consoleErrors } = await newCtxT(b, { width, height })
  const o = {}
  const t = tag('ap')
  await send(page, `Please approve: #${t}`)
  const approveBtn = page.getByRole('button', { name: 'Approve', exact: true }).first()
  await approveBtn.waitFor({ timeout: 60000 }).then(() => check('live-card-shown', true)).catch(() => check('live-card-shown', false))
  await shot(page, '01-live-card')
  await approveBtn.click()
  await page.waitForFunction((tg) => document.body.innerText.includes(`Tool step finished #${tg}`), t, { timeout: 60000 })
    .then(() => check('approve-resumes-turn', true)).catch(() => check('approve-resumes-turn', false))
  o.approveReqs = (await reqs(page)).filter(r => /confirm|respond|approval/.test(r.url)).map(r => ({ u: r.url.replace(/[0-9a-f-]{36}/g, ':id'), s: r.status ?? null, resp: r.response }))
  await shot(page, '02-approved')
  await settle(page)
  const t2 = tag('dn')
  await send(page, `Please approve: #${t2}`)
  await page.getByRole('button', { name: 'Deny', exact: true }).first().waitFor({ timeout: 60000 })
  await page.getByRole('button', { name: 'Deny', exact: true }).first().click()
  await page.waitForFunction((tg) => document.body.innerText.includes(`Tool step finished #${tg}`) || /Denied\./.test(document.body.innerText), t2, { timeout: 60000 })
    .then(() => check('deny-settles', true)).catch(() => check('deny-settles', false))
  await shot(page, '03-denied')
  await settle(page)
  const t3 = tag('rs')
  await send(page, `Please approve: #${t3}`)
  await page.getByRole('button', { name: 'Approve', exact: true }).first().waitFor({ timeout: 60000 })
  await page.reload({ waitUntil: 'commit' })
  await composer(page).waitFor()
  const restored = await page.getByRole('button', { name: 'Approve', exact: true }).first().waitFor({ timeout: 30000 }).then(() => true).catch(() => false)
  check('card-restored-after-reload', restored)
  await shot(page, '04-restored-card')
  if (restored) {
    const n = (await reqs(page)).length
    await page.getByRole('button', { name: 'Approve', exact: true }).first().click()
    await page.waitForFunction((tg) => document.body.innerText.includes(`Tool step finished #${tg}`), t3, { timeout: 90000 })
      .then(() => check('restored-approve-resumes', true)).catch(() => check('restored-approve-resumes', false))
    o.restoredReqs = (await reqs(page)).slice(n).filter(r => /confirm|respond|approval|stream|pending|messages/.test(r.url)).map(r => ({ u: r.url.replace(/[0-9a-f-]{36}/g, ':id'), s: r.status ?? null, resp: r.response }))
    await shot(page, '05-restored-approved')
  }
  return { ...o, consoleErrors }
}


// J5/J6b/J9/J12: workspace room with two users.
J['room'] = async (b) => {
  const fx = JSON.parse((await import('node:fs')).readFileSync(`${lib.WORK}/fixtures.json`, 'utf8'))
  const WID = fx.workspaceId
  const o = {}
  const A = await newCtxT(b, { width, height, goto: `${APP}/w/${WID}/chat?v=workspace` })
  const pa = A.page
  await composer(pa).waitFor()
  // J12: first send in the Workspace view creates the room then streams into it
  const t0 = tag('ws')
  await send(pa, `Room first send #${t0}`)
  await pa.waitForURL(/[?&]s=/, { timeout: 30000 })
  const roomUrl = pa.url(); const sid = new URL(roomUrl).searchParams.get('s')
  check('ws-first-send-creates-room', /v=workspace/.test(roomUrl) && !!sid, roomUrl)
  await pa.getByText(`Scripted reply #${t0} to:`).first().waitFor({ timeout: 60000 }).then(() => check('ws-first-send-streams-reply', true)).catch(() => check('ws-first-send-streams-reply', false))
  check('ws-first-send-direct-stream', (await frames(pa)).some(f => f.stream === 'direct' && f.type === 'text_delta'), 'reply painted from the direct stream')
  await shot(pa, '01-room-created')
  // teammate opens the room
  const B = await newCtxT(b, { width, height, as: 'm5-mate', goto: roomUrl })
  const pb = B.page
  await pb.getByText(`Room first send #${t0}`).filter({ visible: true }).first().waitFor({ timeout: 30000 }).then(() => check('teammate-sees-room-history', true)).catch(() => check('teammate-sees-room-history', false))
  await pb.waitForTimeout(2000)
  // typing indicator
  await composer(pb).click(); await pb.keyboard.type('typing now', { delay: 120 })
  const typing = await pa.getByText(/is typing/).first().waitFor({ timeout: 8000 }).then(() => true).catch(() => false)
  check('typing-indicator', typing, 'owner sees teammate typing')
  await shot(pa, '02-typing')
  await composer(pb).fill('')
  // teammate plain post appears live for the owner
  const t1 = tag('post')
  await send(pb, `Teammate post #${t1}`)
  await pa.getByText(`Teammate post #${t1}`).first().waitFor({ timeout: 20000 }).then(() => check('teammate-post-live', true)).catch(() => check('teammate-post-live', false))
  // teammate asks the assistant: owner sees the mirrored turn live
  const t2 = tag('ask')
  const nA = (await frames(pa)).length
  await mention(pb, 'M5 Brian'); await pb.keyboard.type(` slow:30 #${t2}`)
  await sendBtn(pb).click()
  await waitFrame(pa, f => f.stream === 'follow' && f.type === 'snapshot' && (f.d || '').includes(t2), 60000, 'mirror snapshot on owner').then(() => check('owner-sees-mirror-live', true)).catch(() => check('owner-sees-mirror-live', false))
  await pa.waitForTimeout(1500)
  await shot(pa, '03-owner-mirror')
  await shot(pb, '03-teammate-direct')
  await pb.getByText(new RegExp(`Slow reply #${t2}:.*end\\.`)).first().waitFor({ timeout: 60000 })
  await pa.getByText(new RegExp(`Slow reply #${t2}:.*end\\.`)).first().waitFor({ timeout: 60000 }).then(() => check('owner-gets-teammate-reply', true)).catch(() => check('owner-gets-teammate-reply', false))
  await pb.waitForTimeout(2000)
  const echoCount = await pb.getByText(`slow:30 #${t2}`).count()
  check('no-own-echo-bubble', echoCount === 1, `user bubbles with the ask on teammate page=${echoCount}`)
  o.ownerMirrorFrames = summarizeFrames((await frames(pa)).slice(nA))
  // approval 403: owner's turn, teammate (member, not asker) tries to approve
  const t3 = tag('ap')
  await mention(pa, 'M5 Brian'); await pa.keyboard.type(` approve: #${t3}`)
  await sendBtn(pa).click()
  await pa.getByRole('button', { name: 'Approve', exact: true }).first().waitFor({ timeout: 60000 })
  const mateCard = await pb.getByRole('button', { name: 'Approve', exact: true }).first().waitFor({ timeout: 20000 }).then(() => true).catch(() => false)
  o.teammateSeesCard = mateCard
  if (mateCard) {
    await pb.getByRole('button', { name: 'Approve', exact: true }).first().click()
    await pb.getByText('Only the member who asked this turn (or a workspace admin) can act on this.').first().waitFor({ timeout: 15000 })
      .then(() => check('approval-403-confirmNotAllowed', true)).catch(() => check('approval-403-confirmNotAllowed', false))
    o.mate403Reqs = (await reqs(pb)).filter(r => /confirm|respond|approval/.test(r.url)).map(r => ({ u: r.url.replace(/[0-9a-f-]{36}/g, ':id'), s: r.status ?? null, resp: r.response }))
    await shot(pb, '04-teammate-403')
  } else check('approval-403-confirmNotAllowed', false, 'teammate never saw the card')
  await pa.getByRole('button', { name: 'Approve', exact: true }).first().click()
  await pa.waitForFunction((tg) => document.body.innerText.includes(`Tool step finished #${tg}`), t3, { timeout: 60000 })
    .then(() => check('owner-approve-resumes', true)).catch(() => check('owner-approve-resumes', false))
  await pb.waitForTimeout(3000)
  const mateStillPending = await pb.getByRole('button', { name: 'Approve', exact: true }).count()
  check('teammate-card-cleared-by-other-approval', mateStillPending === 0, `pending approve buttons on teammate page=${mateStillPending}`)
  await shot(pb, '05-teammate-after-owner-approval')
  // J9: multi-assistant response group (the approved turn must finish first, or the group is mid-turn input)
  await settle(pa)
  const t5 = tag('grp')
  const nG = (await reqs(pa)).length
  await mention(pa, 'M5 Brian'); await pa.keyboard.type(' '); await page_mention_more(pa, 'M5 Helper'); await pa.keyboard.type(` group hello #${t5}`)
  await sendBtn(pa).click()
  await pa.waitForFunction((tg) => (document.body.innerText.match(new RegExp(`Scripted reply #${tg}`, 'g')) || []).length >= 2, t5, { timeout: 90000 })
    .then(() => check('group-two-replies', true)).catch(() => check('group-two-replies', false))
  await pa.waitForTimeout(2000)
  // The scripted replies echo the message's last words ("... group hello #tag"), so count user rows only.
  const userRows = await pa.getByText(`group hello #${t5}`).filter({ hasNotText: 'Scripted reply' }).count()
  check('group-one-user-row', userRows === 1, `user rows=${userRows}`)
  const groupPosts = (await reqs(pa)).slice(nG).filter(r => r.method === 'POST' && r.url === '/api/chat')
  o.groupPosts = groupPosts.map(r => (r.body || '').slice(0, 260))
  check('group-serialized-members', groupPosts.length === 2 && /roomResponseGroup/.test(groupPosts[1].body || ''), `posts=${groupPosts.length}`)
  // AssistantAvatar (chat-ui) is an element with aria-label={name}, not an <img alt>.
  const avatars = await pa.locator('[aria-label="M5 Helper"]').filter({ visible: true }).count()
  check('group-helper-avatar', avatars >= 1, `M5 Helper avatars=${avatars}`)
  await shot(pa, '06-group')
  await pb.getByText(`group hello #${t5}`).first().waitFor({ timeout: 20000 }).catch(() => {})
  await shot(pb, '06-group-teammate')
  return { roomSession: sid, ...o, consoleErrors: A.consoleErrors, teammateConsoleErrors: B.consoleErrors }
}
async function page_mention_more(page, name) { await page.keyboard.type('@' + name.slice(0, 4)); await page.getByRole('option', { name: `Mention ${name}` }).first().click() }


const FX = () => JSON.parse(require_fs().readFileSync(`${lib.WORK}/fixtures.json`, 'utf8'))
import * as fsmod from 'node:fs'
function require_fs() { return fsmod }
const dockBox = (page) => page.getByPlaceholder('Ask anything…').filter({ visible: true }).first()
// Below lg the dock is the phone drawer: its backdrop ("Close chat", opacity 0, pointer-events none) and its
// off-screen header button count as visible to Playwright while the sheet is closed, so a closed drawer used to
// read as open and the harness never tapped the FAB (M5 D1/D4 harness gap). The drawer's FAB reports the real
// state through aria-expanded; the sheet's composer must also sit inside the viewport.
const dockOpen = async (page) => {
  if (page.viewportSize().width < 1024) {
    const expanded = await page.locator('button[aria-label="Open chat"][aria-expanded="true"]').count().catch(() => 0)
    if (!expanded) return false
    return page.evaluate(() => [...document.querySelectorAll('textarea[placeholder="Ask anything…"]')].some((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight })).catch(() => false)
  }
  return page.getByRole('button', { name: 'Close chat' }).filter({ visible: true }).first().isVisible().catch(() => false)
}
async function openDock(page) {
  const vw = page.viewportSize().width
  for (let i = 0; i < 3 && !(await dockOpen(page)); i++) {
    if (vw >= 1024) await page.getByText('Ask anything…').filter({ visible: true }).last().click().catch(() => {})
    else await page.getByRole('button', { name: 'Open chat' }).filter({ visible: true }).first().click().catch(() => {})
    await page.waitForTimeout(1200)
  }
  await page.getByRole('button', { name: 'Close chat' }).filter({ visible: true }).first().waitFor({ timeout: 15000 })
  await dockBox(page).waitFor({ timeout: 15000 })
}
async function dockSend(page, text) { await openDock(page); await dockBox(page).fill(text); await page.keyboard.press('Enter') }
const routerPush = (page, url) => page.evaluate((u) => window.next?.router?.push ? window.next.router.push(u) : (location.href = u), url)

// Dock journeys: resize across lg with the drawer, build-log replay, page+dock on one session, reload, reset and resume.
J['dock'] = async (b) => {
  const fx = FX()
  const ownerTok = await token()
  let created
  for (let i = 0; i < 4 && !created?.body?.id; i++) { created = await api(ownerTok.accessToken, 'POST', `/api/workspaces/${fx.workspaceId}/views/draft`, { name: `M5 dock ${width} ${run}`, teamspaceId: null }); if (!created?.body?.id) await new Promise(r => setTimeout(r, 5000)) }
  if (!created?.body?.id) throw new Error(`page creation failed: ${created?.status}`)
  fx.pageId = created.body.id
  const PAGE = `${APP}/w/${fx.workspaceId}/p/${fx.pageId}`
  const other = width >= 1024 ? 390 : 1440
  const A = await newCtxT(b, { width, height, goto: PAGE })
  const page = A.page; const o = {}
  const t = tag('a')
  await dockSend(page, `Dock turn work: slow:45 #${t}`)
  const sess = await waitFrame(page, f => f.type === 'session', 60000, 'session')
  const sid = JSON.parse(sess.d).sessionId
  await waitFrame(page, f => f.type === 'text_delta' && f.d.includes('w3'), 60000, 'w3')
  await dockBox(page).fill(`Dock draft #${t}d`)
  await shot(page, '01-dock-mid-turn')
  // cross lg mid-turn, open the other presentation (drawer or floating dock)
  await page.setViewportSize({ width: other, height: other < 500 ? 844 : 900 })
  await page.waitForTimeout(800)
  await openDock(page)
  await page.waitForTimeout(1200)
  const draftAfterResize = await dockBox(page).inputValue()
  check('resize-same-draft', draftAfterResize === `Dock draft #${t}d`, JSON.stringify(draftAfterResize))
  const txtR = await bodyText(page)
  check('resize-same-live-turn', new RegExp(`Tool step finished #${t}[^\\n]*w1`).test(txtR) && await stopBtn(page).isVisible().catch(() => false), 'live text and Stop in the other presentation')
  await page.getByText(/Writing reply|Thinking|Working/).filter({ visible: true }).first().click().catch(() => {})
  await page.waitForTimeout(800)
  const txtFeed = await bodyText(page)
  o.feedAfterAttach = (txtFeed.match(/(Read \d+ source[^\n]*|listTasks[^\n]*|Ran \d+ tool[^\n]*|Reading[^\n]*|Writing reply[^\n]*)/g) || []).slice(0, 6)
  check('resize-build-log-replayed', o.feedAfterAttach.some(x => /Read|listTasks|Ran/.test(x)), JSON.stringify(o.feedAfterAttach))
  await shot(page, '02b-feed-expanded')
  check('resize-one-chat-post', (await reqs(page)).filter(r => r.method === 'POST' && r.url === '/api/chat').length === 1, '')
  await shot(page, '02-other-presentation-mid-turn')
  await page.setViewportSize({ width, height }); await page.waitForTimeout(800)
  await openDock(page).catch(() => {})
  await dockBox(page).fill('').catch(() => {})
  // navigate to the full page on the same session mid-turn (client navigation)
  const t2 = tag('b')
  await settle(page)
  // Wait for THIS turn's output: an earlier turn's w3 frame is still in the buffer (D1/D4 harness gap).
  const sinceB = Date.now()
  await dockSend(page, `Dock to page slow:45 #${t2}`)
  await waitFrame(page, f => f.type === 'text_delta' && f.d.includes('w3') && f.t > sinceB, 60000, 'w3 b')
  const nR = (await reqs(page)).length
  await routerPush(page, `/w/${fx.workspaceId}/chat?s=${sid}`)
  await composer(page).waitFor({ timeout: 30000 })
  await page.waitForTimeout(2500)
  const txtP = await bodyText(page)
  check('page-shows-live-dock-turn', (new RegExp(`Slow reply #${t2}: w1`).test(txtP) || new RegExp(`Tool step finished #${t}[^\\n]*w1`).test(txtP)) && await stopBtn(page).isVisible().catch(() => false), 'full page paints the running dock turn with Stop')
  await shot(page, '03-page-same-session')
  await page.waitForFunction((tg) => new RegExp(`Slow reply #${tg}: w1 .*w45 end`).test(document.body.innerText.replace(/\s+/g, ' ')), t2, { timeout: 90000 })
    .then(() => check('page-turn-completes', true)).catch(() => check('page-turn-completes', false))
  await page.waitForTimeout(1500)
  const rq = (await reqs(page)).slice(nR)
  o.pageAttachRequests = rq.filter(r => r.url.includes(sid)).map(r => `${r.method} ${r.url.replace(/[0-9a-f-]{36}/g, ':id')} ${r.status ?? ''}`)
  check('one-stream-per-session', rq.filter(r => r.method === 'POST' && r.url === '/api/chat').length === 0, `chat POSTs after navigation=${rq.filter(r => r.method === 'POST' && r.url === '/api/chat').length}`)
  const userRows = await page.getByText(`Dock to page slow:45 #${t2}`).filter({ visible: true }).count()
  const replyRows = await page.getByText(new RegExp(`Slow reply #${t2}: w1`)).filter({ visible: true }).count()
  check('history-precedence-no-duplicate-rows', userRows === 1 && replyRows === 1, `user rows=${userRows} reply rows=${replyRows}`)
  await shot(page, '04-page-completed')
  // back to the page surface: dock shows the same conversation
  await routerPush(page, `/w/${fx.workspaceId}/p/${fx.pageId}`)
  await page.waitForTimeout(2500)
  await openDock(page)
  await page.waitForTimeout(1500)
  check('dock-after-return-has-history', new RegExp(`Slow reply #${t2}: w1`).test(await bodyText(page)), '')
  // reload mid-turn: the dock re-attaches
  const t3 = tag('c')
  await settle(page)
  const sinceC = Date.now()
  await dockSend(page, `Dock reload slow:45 #${t3}`)
  await waitFrame(page, f => f.type === 'text_delta' && f.d.includes('w3') && f.t > sinceC, 60000, 'w3 c')
  await page.reload({ waitUntil: 'commit' })
  await page.waitForTimeout(5000)
  await openDock(page)
  const fol = await waitFrame(page, f => f.stream === 'follow' && (f.type === 'snapshot' || f.type === 'status'), 30000, 'follow').catch(() => null)
  check('dock-reload-reattaches', !!fol, fol?.type)
  await page.waitForFunction((tg) => new RegExp(`Slow reply #${tg}: w1 .*w45 end`).test(document.body.innerText.replace(/\s+/g, ' ')), t3, { timeout: 90000 })
    .then(() => check('dock-reload-reply-lands', true)).catch(() => check('dock-reload-reply-lands', false))
  o.reloadFrames = summarizeFrames(await frames(page))
  await shot(page, '05-dock-reload-landed')
  // reset (surface seed) then resume after reload
  await settle(page)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('doc:surface-chat-seed', { detail: { prefill: 'Seeded follow-up for M5' } })))
  await page.waitForTimeout(1500)
  const afterReset = await bodyText(page)
  o.resetComposer = await dockBox(page).inputValue().catch(() => null)
  check('dock-reset-fresh-thread', o.resetComposer === 'Seeded follow-up for M5' && !new RegExp(`Slow reply #${t3}`).test(afterReset.split('Ask anything')[0] ?? afterReset), 'seed resets to a fresh thread with prefill')
  await shot(page, '06-dock-reset')
  await page.reload({ waitUntil: 'commit' }); await page.waitForTimeout(8000)
  await openDock(page).catch(() => {}); await page.waitForTimeout(1000); await openDock(page).catch(() => {})
  const resumed = await page.waitForFunction((tg) => new RegExp(`Slow reply #${tg}: w1`).test(document.body.innerText), t3, { timeout: 30000 }).then(() => true).catch(() => false)
  check('dock-resume-latest-session', resumed, 'reload resumes the latest doc session')
  await shot(page, '07-dock-resumed')
  return { docSession: sid, ...o, consoleErrors: A.consoleErrors }
}

// Identity change isolation: owner drafts and transcript must not reach another identity in the same browser.
J['identity'] = async (b) => {
  const fx = FX(); const PAGE = `${APP}/w/${fx.workspaceId}/p/${fx.pageId}`
  const A = await newCtxT(b, { width, height })
  const page = A.page; const o = {}
  const t = tag('a')
  await send(page, `Owner private turn slow:20 #${t}`)
  await page.getByText(new RegExp(`Slow reply #${t}:.*end\\.`)).first().waitFor({ timeout: 60000 })
  await settle(page)
  await composer(page).fill(`Owner unsent draft #${t}`)
  await page.waitForTimeout(1500)
  await page.goto(PAGE, { waitUntil: 'commit' }); await page.waitForTimeout(5000)
  await openDock(page); await dockBox(page).fill(`Owner dock draft #${t}`); await page.waitForTimeout(1500)
  await shot(page, '01-owner-state')
  // switch identity in the same browser profile
  await page.goto(`${APP}/api/auth/dev-login?as=m5-other`, { waitUntil: 'commit' })
  await page.waitForTimeout(6000)
  o.urlAfterSwitch = page.url()
  const otherWs = (await (await fetch(`${'http://127.0.0.1:4100'}/api/workspaces`, { headers: { authorization: `Bearer ${(await token('m5-other')).accessToken}` } })).json())
  const wsList = otherWs.workspaces ?? otherWs.teams ?? otherWs
  const otherWid = Array.isArray(wsList) ? (wsList[0]?.id ?? wsList[0]?.workspaceId) : null
  o.otherWorkspace = otherWid
  await page.goto(`${APP}/w/${otherWid}/chat`, { waitUntil: 'commit' }); await composer(page).waitFor({ timeout: 60000 }).catch(() => {})
  await page.waitForTimeout(3000)
  const txt = await bodyText(page)
  const comp = await composer(page).inputValue().catch(() => '')
  check('no-owner-draft-in-chat', !comp.includes(t), JSON.stringify(comp))
  check('no-owner-transcript', !txt.includes(`#${t}`), 'owner tag absent from the other identity\'s chat')
  await shot(page, '02-other-chat')
  // other identity's dock on its own page surface
  await page.goto(`${APP}/w/${otherWid}/brain`, { waitUntil: 'commit' }); await page.waitForTimeout(5000)
  await openDock(page).catch(() => {})
  await page.waitForTimeout(1500)
  const dockDraft = await dockBox(page).inputValue().catch(() => '')
  check('no-owner-dock-draft', !dockDraft.includes(t), JSON.stringify(dockDraft))
  check('no-owner-dock-transcript', !(await bodyText(page)).includes(`#${t}`), '')
  await shot(page, '03-other-dock')
  // the owner's workspace is not readable by the other identity
  await page.goto(`${APP}/w/${fx.workspaceId}/chat`, { waitUntil: 'commit' }); await page.waitForTimeout(6000)
  check('owner-workspace-not-shown', !(await bodyText(page)).includes(`#${t}`), page.url())
  await shot(page, '04-owner-workspace-as-other')
  return { ...o, consoleErrors: A.consoleErrors }
}


// Resume end to end: start a turn, SIGKILL the API, restart the stack, client re-attaches.
J['restart'] = async (b) => {
  const { execSync } = await import('node:child_process')
  const A = await newCtxT(b, { width, height })
  const page = A.page; const o = {}
  const t = tag('a')
  await send(page, `Restart resume slow:90 #${t}`)
  const sess = await waitFrame(page, f => f.type === 'session', 60000, 'session')
  o.sessionId = JSON.parse(sess.d).sessionId; o.turnId = sess.turnId
  await waitFrame(page, f => f.type === 'text_delta' && f.d.includes('w5'), 90000, 'w5')
  await shot(page, '01-before-kill')
  const apiPid = execSync("lsof -nP -iTCP:4100 -sTCP:LISTEN -t").toString().trim().split('\n')[0]
  o.apiPid = apiPid; o.killedAt = new Date().toISOString()
  execSync(`kill -9 ${apiPid}`)
  fsmod.writeFileSync(`${lib.WORK}/api-killed.flag`, o.killedAt)
  await page.waitForTimeout(4000)
  await shot(page, '02-after-kill')
  o.noticeAfterKill = (await bodyText(page)).match(/Connection dropped[^\n]*/)?.[0] ?? null
  check('reconnecting-notice-after-kill', !!o.noticeAfterKill, o.noticeAfterKill)
  // wait for the API to come back (restarted externally through launch.mjs)
  const t0 = Date.now(); let up = false
  while (Date.now() - t0 < 900000) { try { const r = await fetch('http://127.0.0.1:4100/health'); if (r.ok) { up = true; break } } catch {} ; await new Promise(r => setTimeout(r, 3000)) }
  o.apiBackAfterMs = Date.now() - t0
  check('api-restarted', up, `${o.apiBackAfterMs} ms`)
  const nF = (await frames(page).catch(() => [])).length
  o.pageReloadedByDevServer = await page.evaluate(() => !window.__m5frames?.some(f => f.type === 'session')).catch(() => null)
  // wait for re-attach and the turn to end (resumed or reclaimed)
  const settled = await page.waitForFunction(() => {
    const f = window.__m5frames || []
    return f.some(x => x.stream === 'follow' && (x.type === 'turn_completed' || x.type === 'done'))
  }, null, { timeout: 600000 }).then(() => true).catch(() => false)
  const f = await frames(page)
  o.framesAfterRestart = summarizeFrames(f.slice(o.pageReloadedByDevServer ? 0 : nF))
  o.keyFramesAfterRestart = keyFrames(f.slice(o.pageReloadedByDevServer ? 0 : nF))
  check('client-reattaches-follow', f.some(x => x.stream === 'follow' && x.t > t0), 'follow frames after restart')
  check('turn-settles-on-bus', settled, 'turn_completed/done observed on the follow stream')
  check('resumed-turn-publishes-bus-frames', f.some(x => x.stream === 'follow' && x.t > t0 && (x.type === 'snapshot' || x.type === 'turn_started')), 'turn_started/snapshot after restart')
  await page.waitForTimeout(4000)
  const rq = (await reqs(page)).filter(r => r.t > t0)
  o.historyReloads = rq.filter(r => r.url.includes(`/sessions/${o.sessionId}/messages`)).length
  check('history-reloads', o.historyReloads > 0, `messages GETs after restart=${o.historyReloads}`)
  o.reattachRequests = rq.filter(r => r.url.includes(o.sessionId)).map(r => `${new Date(r.t).toISOString().slice(11, 19)} ${r.method} ${r.url.replace(/[0-9a-f-]{36}/g, ':id')} ${r.status ?? r.error ?? ''}`).slice(0, 40)
  const txt = await bodyText(page)
  o.finalTranscriptHasReply = new RegExp(`Slow reply #${t}: w1`).test(txt)
  o.finalNotices = (txt.match(/(Connection dropped[^\n]*|The previous turn stopped responding[^\n]*|Something went wrong[^\n]*|Could not reconnect[^\n]*)/g) || [])
  await shot(page, '03-after-restart-settled')
  const tok = await token(); const msgs = await api(tok.accessToken, 'GET', `/api/sessions/${o.sessionId}/messages`)
  o.persistedRows = (Array.isArray(msgs.body) ? msgs.body : []).map(m => `${m.role}: ${JSON.stringify(m.content).slice(0, 80)}`)
  const st = await api(tok.accessToken, 'GET', `/api/sessions/${o.sessionId}`)
  o.sessionAfter = { status: st.body?.status, turnId: st.body?.turnId, turnEndReason: st.body?.turnEndReason }
  o.providerCalls = providerCalls(t).map(c => `${c.at} ${c.kind}`)
  return { ...o, consoleErrors: A.consoleErrors }
}


// J10: uploads and voice note chips; draft across a session switch; ready chips across /p and back.
J['uploads'] = async (b) => {
  const fx = FX()
  const A = await newCtxT(b, { width, height })
  const page = A.page; const o = {}
  const t = tag('f')
  await page.locator('input[type="file"]').first().setInputFiles(`${lib.WORK}/m5-note.txt`)
  const chip = await page.getByText('m5-note.txt').first().waitFor({ timeout: 30000 }).then(() => true).catch(() => false)
  check('upload-chip-shown', chip)
  await page.waitForTimeout(2500)
  await shot(page, '01-chip')
  await send(page, `With a file #${t}`)
  await page.getByText(`Scripted reply #${t} to:`).first().waitFor({ timeout: 90000 }).catch(() => {})
  await settle(page)
  const bubbleChip = await page.getByText('m5-note.txt').count()
  check('chip-carried-into-bubble', bubbleChip >= 1, `file name occurrences=${bubbleChip}`)
  const post = (await reqs(page)).find(r => r.method === 'POST' && r.url === '/api/chat' && (r.body || '').includes(t))
  o.postHasFileIds = /fileIds/.test(post?.body || '')
  check('send-carries-file', o.postHasFileIds, (post?.body || '').slice(0, 200))
  await shot(page, '02-bubble-with-file')
  // draft survives a session switch (A -> New chat -> A)
  const urlA = page.url()
  await composer(page).fill(`Unsent draft #${t}`)
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: 'New chat' }).first().click()
  await page.waitForTimeout(1500)
  await page.goto(urlA, { waitUntil: 'commit' }); await composer(page).waitFor(); await page.waitForTimeout(2000)
  const d = await composer(page).inputValue()
  check('draft-survives-session-switch', d === `Unsent draft #${t}`, JSON.stringify(d))
  await composer(page).fill('')
  // ready chip across /p and back (receipt open item: expected not to survive)
  await page.locator('input[type="file"]').first().setInputFiles(`${lib.WORK}/m5-note.txt`)
  await page.getByText('m5-note.txt').last().waitFor({ timeout: 30000 }).catch(() => {})
  await page.waitForTimeout(2000)
  const before = await page.getByText('m5-note.txt').count()
  await routerPush(page, `/w/${fx.workspaceId}/p/${fx.pageId}`); await page.waitForTimeout(3000)
  await routerPush(page, new URL(urlA).pathname + new URL(urlA).search); await composer(page).waitFor(); await page.waitForTimeout(2500)
  const after = await page.getByText('m5-note.txt').count()
  o.readyChipAcrossP = { before, after }
  check('ready-chip-survives-p-and-back', after >= before, `chips before=${before} after=${after} (receipt open item)`)
  await shot(page, '03-after-p-and-back')
  // voice note via the composer recorder (fake microphone)
  const tv = tag('v')
  const rec = page.getByRole('button', { name: 'Record', exact: true }).first()
  if (await rec.isVisible().catch(() => false)) {
    await rec.click(); await page.waitForTimeout(3500)
    await shot(page, '04-recording')
    const stopRec = page.getByRole('button', { name: /Stop recording|Stop/ }).first()
    await stopRec.click().catch(() => {})
    await page.waitForTimeout(4000)
    await shot(page, '05-voice-chip')
    o.voiceUi = (await bodyText(page)).match(/(voice note|Voice note|Recording[^\n]*|Transcrib[^\n]*|Couldn't[^\n]*)/g)?.slice(0, 5) ?? []
    const sendable = await sendBtn(page).isEnabled().catch(() => false)
    if (sendable) { await sendBtn(page).click(); await page.waitForTimeout(8000) }
    const txt = await bodyText(page)
    check('voice-note-marker', /\[voice note\]|voice note/i.test(txt), JSON.stringify(o.voiceUi))
    o.voicePosts = (await reqs(page)).filter(r => r.method === 'POST' && /recording|chat$/.test(r.url)).map(r => `${r.url} ${r.status ?? r.error} ${(r.body || '').slice(0, 120)}`).slice(-4)
    await shot(page, '06-voice-sent')
  } else check('voice-note-marker', false, 'Record button not visible')
  return { ...o, consoleErrors: A.consoleErrors }
}

// J11: Work Bench Live card Stop on a re-attached (mirrored) turn; composer Stop on a re-attached personal turn.
J['workbench-stop'] = async (b) => {
  const A = await newCtxT(b, { width, height })
  const page = A.page; const o = {}
  const t = tag('wb')
  await send(page, `Work bench slow:90 #${t}`)
  await waitFrame(page, f => f.type === 'text_delta' && f.d.includes('w3'), 90000, 'w3')
  await page.reload({ waitUntil: 'commit' }); await composer(page).waitFor()
  await waitFrame(page, f => f.stream === 'follow' && f.type === 'snapshot', 30000, 'mirror').catch(() => {})
  const pane = page.getByRole('button', { name: /Open side pane|Expand Work Bench|Work Bench/ }).first()
  if (await pane.isVisible().catch(() => false)) await pane.click()
  await page.waitForTimeout(1500)
  await shot(page, '01-work-bench')
  const live = page.getByRole('button', { name: 'Stop', exact: true }).first()
  const hasLive = await live.isVisible().catch(() => false)
  check('work-bench-live-stop-visible', hasLive)
  if (hasLive) {
    await live.click()
    const t0 = Date.now(); let stopRec
    while (Date.now() - t0 < 20000 && !((stopRec = (await reqs(page)).find(r => r.url.startsWith('/api/chat/stop'))) && stopRec.response)) await page.waitForTimeout(200)
    o.wbStopBody = stopRec?.body; o.wbStopResponse = stopRec?.response
    check('work-bench-stop-cas', !!stopRec && /turnId/.test(stopRec.body || ''), stopRec?.body)
    await waitFrame(page, f => f.stream === 'follow' && f.type === 'turn_completed', 30000, 'turn_completed').then(() => check('mirrored-stop-settles-on-turn_completed', true)).catch(() => check('mirrored-stop-settles-on-turn_completed', false))
    await page.waitForTimeout(1500)
    o.wbNotice = (await bodyText(page)).match(/(You stopped this turn\.|This turn was stopped\.|[^\n]*stopped this turn\.)/)?.[0] ?? null
    check('stopped-notice', !!o.wbNotice, o.wbNotice)
    await shot(page, '02-work-bench-stopped')
  }
  // composer Stop on a re-attached personal turn (close the phone Work pane first)
  if (width < 768) { await page.getByRole('button', { name: /^Close/ }).filter({ visible: true }).last().click().catch(() => {}); await page.waitForTimeout(800) }
  await settle(page)
  const t2 = tag('cs')
  const n0 = (await reqs(page)).length
  await send(page, `Composer stop slow:90 #${t2}`)
  await waitFrame(page, f => f.type === 'text_delta' && f.d.includes('w3') && f.t > 0, 90000, 'w3 b')
  await page.reload({ waitUntil: 'commit' }); await composer(page).waitFor()
  await waitFrame(page, f => f.stream === 'follow' && f.type === 'snapshot', 30000, 'mirror b').catch(() => {})
  const cs = await stopBtn(page).isVisible().catch(() => false)
  check('composer-stop-on-reattached', cs, 'composer Stop visible on the re-attached turn')
  if (cs) {
    await stopBtn(page).click()
    const t0 = Date.now(); let stopRec
    while (Date.now() - t0 < 20000 && !((stopRec = (await reqs(page)).find(r => r.url.startsWith('/api/chat/stop'))) && stopRec.response)) await page.waitForTimeout(200)
    check('composer-stop-cas', !!stopRec && /turnId/.test(stopRec.body || ''), stopRec?.body)
    await waitFrame(page, f => f.stream === 'follow' && f.type === 'turn_completed', 30000, 'turn_completed b').then(() => check('composer-stop-settles', true)).catch(() => check('composer-stop-settles', false))
    await shot(page, '03-composer-stopped')
  }
  return { ...o, consoleErrors: A.consoleErrors }
}


// Resume end to end, variant 2: a turn suspended on an approval and a turn mid-output when the API is killed.
J['restart2'] = async (b) => {
  const { execSync } = await import('node:child_process')
  const A = await newCtxT(b, { width, height })
  const p1 = A.page; const o = {}
  const ta = tag('ap')
  await send(p1, `Restart approval approve: #${ta}`)
  await p1.getByRole('button', { name: 'Approve', exact: true }).first().waitFor({ timeout: 90000 })
  await p1.waitForURL(/[?&]s=/); const url1 = p1.url(); o.approvalSession = new URL(url1).searchParams.get('s')
  const p2 = await A.ctx.newPage()
  await p2.goto(`${APP}/w/${FX().workspaceId}/chat`, { waitUntil: 'commit' }); await composer(p2).waitFor()
  await p2.getByRole('button', { name: 'New chat' }).first().click(); await p2.waitForTimeout(1500)
  if (new URL(p2.url()).searchParams.get('s')) { await p2.getByRole('link', { name: 'New chat' }).first().click().catch(() => {}); await p2.waitForTimeout(1500) }
  const tr = tag('run')
  await send(p2, `Restart running slow:90 #${tr}`)
  await waitFrame(p2, f => f.type === 'text_delta' && f.d.includes('w5'), 90000, 'w5')
  await p2.waitForURL(/[?&]s=/); const url2 = p2.url(); o.runningSession = new URL(url2).searchParams.get('s')
  await shot(p1, '01-approval-pending'); await shot(p2, '01-running')
  const apiPid = execSync("lsof -nP -iTCP:4100 -sTCP:LISTEN -t").toString().trim().split('\n')[0]
  o.killedAt = new Date().toISOString(); execSync(`kill -9 ${apiPid}`)
  await p2.waitForTimeout(3000)
  o.p2NoticeAfterKill = (await bodyText(p2)).match(/Connection dropped[^\n]*/)?.[0] ?? null
  const t0 = Date.now(); let up = false
  while (Date.now() - t0 < 1200000) { try { const r = await fetch('http://127.0.0.1:4100/health'); const w = await fetch(`${APP}/`, { redirect: 'manual' }).catch(() => null); if (r.ok && w) { up = true; break } } catch {} ; await new Promise(r => setTimeout(r, 3000)) }
  o.stackBackAfterMs = Date.now() - t0
  check('stack-restarted', up, `${o.stackBackAfterMs} ms`)
  await new Promise(r => setTimeout(r, 8000))
  // running turn: reload, hydrate probe explains the reclaimed turn and history reloads
  await p2.goto(url2, { waitUntil: 'commit' }); await composer(p2).waitFor({ timeout: 120000 })
  await p2.waitForTimeout(5000)
  const st2 = summarizeFrames(await frames(p2)); o.runningAfterReloadFrames = st2; o.runningKeyFrames = keyFrames(await frames(p2))
  const txt2 = await bodyText(p2)
  o.runningNotice = txt2.match(/(The previous turn stopped responding[^\n]*|Connection dropped[^\n]*|Something went wrong[^\n]*)/)?.[0] ?? null
  check('crashed-turn-explained', /stopped responding|reset/i.test(o.runningNotice ?? ''), o.runningNotice)
  check('crashed-turn-history-loaded', txt2.includes(`#${tr}`), 'user message present after reload')
  await shot(p2, '02-running-after-restart')
  // suspended approval: restored card, approve, resumed turn publishes on the bus, history reloads
  await p1.goto(url1, { waitUntil: 'commit' }); await composer(p1).waitFor({ timeout: 120000 })
  const restored = await p1.getByRole('button', { name: 'Approve', exact: true }).first().waitFor({ timeout: 30000 }).then(() => true).catch(() => false)
  check('approval-card-restored-after-restart', restored)
  await shot(p1, '03-approval-restored')
  if (restored) {
    const nF = (await frames(p1)).length, nR = (await reqs(p1)).length
    const tA = Date.now()
    await p1.getByRole('button', { name: 'Approve', exact: true }).first().click()
    const arrived = await p1.waitForFunction((tg) => document.body.innerText.includes(`Tool step finished #${tg}`), ta, { timeout: 120000 }).then(() => Date.now() - tA).catch(() => null)
    check('resumed-reply-after-restart', arrived !== null, arrived !== null ? `${arrived} ms` : 'no resumed reply in 120 s')
    const f = (await frames(p1)).slice(nF)
    o.resumeFrames = summarizeFrames(f); o.resumeKeyFrames = keyFrames(f)
    check('resumed-turn-bus-frames', f.some(x => x.stream === 'follow' && (x.type === 'turn_started' || x.type === 'snapshot')), 'turn_started/snapshot on the follow stream')
    const rq = (await reqs(p1)).slice(nR)
    o.resumeRequests = rq.filter(r => r.url.includes(o.approvalSession) || /approvals|confirm/.test(r.url)).map(r => `${r.t - tA}ms ${r.method} ${r.url.replace(/[0-9a-f-]{36}/g, ':id')} ${r.status ?? r.error ?? ''} ${r.response ? r.response.slice(0, 120) : ''}`)
    check('history-reloads-after-resume', rq.some(r => r.url.includes(`/sessions/${o.approvalSession}/messages`)), '')
    await shot(p1, '04-after-resume')
  }
  const tok = await token()
  for (const [k, sid] of [['approvalSessionAfter', o.approvalSession], ['runningSessionAfter', o.runningSession]]) { const st = await api(tok.accessToken, 'GET', `/api/sessions/${sid}`); o[k] = { status: st.body?.status, turnEndReason: st.body?.turnEndReason } }
  return { ...o, consoleErrors: A.consoleErrors }
}

const b = await launch()
let result
try {
  const extra = await J[name](b)
  result = { journey: name, viewport: `${width}x${height}`, pass: checks.every(c => c.ok), checks, ...extra }
} catch (e) {
  result = { journey: name, viewport: `${width}x${height}`, pass: false, error: String(e?.message ?? e).slice(0, 800), checks }
  console.log('ERROR', result.error)
  for (const [i, p] of pages.entries()) {
    try { await p.page.screenshot({ path: `${out}/zz-error-${i}.png` }) } catch {}
    try { result[`errorState${i}`] = { url: p.page.url(), frames: summarizeFrames(await frames(p.page)), reqs: (await reqs(p.page)).filter(r => r.url.startsWith('/api/chat') || r.url.includes('/stream') || r.url.includes('/pending') || r.url.includes('/messages')).slice(-30), consoleErrors: p.consoleErrors } } catch {}
  }
} finally { await b.close() }
writeJson(`${out}/result.json`, result)
console.log('RESULT', name, width, result.pass ? 'PASS' : 'FAIL')
