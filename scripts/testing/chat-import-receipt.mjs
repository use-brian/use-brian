#!/usr/bin/env node
/**
 * Runtime import receipt driver for M4
 * (docs/plans/oss-chat-m4-runtime-separation-plan.md section 5.2).
 *
 * Runs the actual built API, a durable ordinary turn, and named activation
 * probes. A probe that could not exercise its receiving path leaves the
 * runtime qualification incomplete.
 *
 *   # self-test: deterministic provider only, no boot, no database
 *   node scripts/testing/chat-import-receipt.mjs --self-test
 *
 *   # boot the BUILT OSS API (apps/api/dist/index.js) against the local rig
 *   pnpm -C use-brian exec turbo run build --filter="@use-brian/api-open^..." && pnpm --filter @use-brian/api-open build
 *   scripts/rig-up.sh
 *   node scripts/testing/chat-import-receipt.mjs --out /tmp/receipt.json [--workers] [--label before]
 *
 * The API runs under `node --import scripts/testing/module-trace-hook.mjs`
 * with `--no-workers` (unless `--workers`), `USEBRIAN_EDITION=oss`, and
 * `DASHSCOPE_BASE_URL` pointed at an in-driver deterministic
 * OpenAI-compatible SSE server (`boot.ts` honours the override), so no
 * network provider is reached. The database is the maintained rig
 * (`scripts/rig-env.mjs`, port 5442); a non-loopback host or port 5432 is
 * refused.
 *
 * [COMP:invariants/chat-import-graph]
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { globToRegExp } from './import-graph.mjs'
import { mailboxFixtureResponse } from './m4/mailbox-archive-probe.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OSS_ROOT = resolve(HERE, '../..')
const HOOK = join(HERE, 'module-trace-hook.mjs')
export const DETERMINISTIC_REPLY = 'Deterministic receipt reply.'

/** Receiving probes and their runtime implementation inventory (plan 5.2). */
export const ACTIVATION_PROBES = [
  { id: 'office-docx-pdf-export', loads: [], npmLoads: ['docx', '@cantoo/pdf-lib'] },
  { id: 'crm-contact-create', loads: ['packages/api/dist/routes/crm.js'] },
  { id: 'campaign-draft', loads: ['packages/api/dist/routes/campaigns.js'] },
  { id: 'file-ingest-job', loads: ['packages/api/dist/files/ingest-file.js'] },
  { id: 'mailbox-tool-call', loads: ['packages/api/dist/db/email-archive-search.js'] },
]

// ── Deterministic OpenAI-compatible provider ────────────────────────────

/** Fixed SSE frames for one streamed completion. */
export function completionFrames(model = 'deterministic', answer = DETERMINISTIC_REPLY) {
  const id = 'chatcmpl-receipt'
  const base = { id, object: 'chat.completion.chunk', created: 0, model }
  const words = answer.split(/(?<= )/)
  return [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
    ...words.map((w) => ({ ...base, choices: [{ index: 0, delta: { content: w }, finish_reason: null }] })),
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { ...base, choices: [], usage: { prompt_tokens: 1, completion_tokens: words.length, total_tokens: 1 + words.length } },
  ]
}

function toolFrames(model, name, args) {
  const id = `m4-fixture-${name}`
  const base = { id, object: 'chat.completion.chunk', created: 0, model }
  return [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [
      { index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
    ] }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    { ...base, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ]
}

export function startDeterministicProvider() {
  const requests = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      let json = {}
      try { json = body ? JSON.parse(body) : {} } catch { /* tolerate */ }
      const gemini = /^\/gemini\/v1beta\/models\/([^:/]+):(streamGenerateContent|generateContent|batchEmbedContents)$/.exec(req.url)
      const stream = json.stream === true || gemini?.[2] === 'streamGenerateContent'
      const mailboxRequest = gemini ? {
        messages: (json.contents ?? []).flatMap(item => (item.parts ?? []).flatMap(part =>
          part.functionResponse ? [{ role: 'tool', content: part.functionResponse.response?.result }]
            : part.text ? [{ role: item.role, content: part.text }] : [])),
        tools: (json.tools ?? []).flatMap(tool => (tool.functionDeclarations ?? []).map(declaration => ({ function: declaration }))),
      } : json
      const mailbox = stream ? mailboxFixtureResponse(mailboxRequest) : null
      requests.push({ method: req.method, url: req.url, model: gemini?.[1] ?? json.model ?? null, stream,
        ...(mailbox ? { mailboxAction: mailbox.name ?? 'answer', receivedArchiveReceipt: mailbox.receivedArchiveReceipt === true } : {}) })
      if (req.method === 'POST' && gemini?.[2] === 'batchEmbedContents') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ embeddings: (json.requests ?? []).map((request, index) => {
          const size = Number(request.outputDimensionality) || 768
          return { values: Array.from({ length: size }, (_, i) => i === index % size ? 1 : 0) }
        }) }))
      } else if (req.method === 'POST' && gemini) {
        const part = mailbox?.name
          ? { functionCall: { name: mailbox.name, args: mailbox.args }, thoughtSignature: 'local-fixture-tool-call' }
          : { text: mailbox?.answer ?? DETERMINISTIC_REPLY }
        const reply = JSON.stringify({ candidates: [{ content: { role: 'model', parts: [part] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 4, totalTokenCount: 5 } })
        res.writeHead(200, { 'content-type': stream ? 'text/event-stream' : 'application/json' })
        res.end(stream ? `data: ${reply}\n\n` : reply)
      } else if (req.method === 'GET' && /\/models$/.test(req.url)) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'deterministic', object: 'model' }] }))
      } else if (req.method === 'POST' && /\/chat\/completions$/.test(req.url)) {
        if (json.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
          const frames = mailbox?.name ? toolFrames(json.model, mailbox.name, mailbox.args) : completionFrames(json.model, mailbox?.answer)
          for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`)
          res.end('data: [DONE]\n\n')
        } else {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            id: 'chatcmpl-receipt', object: 'chat.completion', created: 0, model: json.model ?? 'deterministic',
            choices: [{ index: 0, message: { role: 'assistant', content: DETERMINISTIC_REPLY }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 4, total_tokens: 5 },
          }))
        }
      } else if (req.method === 'POST' && /\/embeddings$/.test(req.url)) {
        const inputs = Array.isArray(json.input) ? json.input : [json.input ?? '']
        const dims = Number(json.dimensions) || 1024
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          object: 'list', model: json.model ?? 'deterministic',
          data: inputs.map((_, index) => ({ object: 'embedding', index, embedding: Array.from({ length: dims }, (_, i) => (i === index % dims ? 1 : 0)) })),
          usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
        }))
      } else {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `deterministic provider: no route ${req.method} ${req.url}` } }))
      }
    })
  })
  return new Promise((resolveStart, rejectStart) => {
    server.once('error', rejectStart)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectStart)
      const { port } = server.address()
      resolveStart({ baseURL: `http://127.0.0.1:${port}/compatible-mode/v1`, port, requests, close: () => new Promise((r) => server.close(r)) })
    })
  })
}

async function selfTest() {
  const provider = await startDeterministicProvider()
  try {
    const res = await fetch(`${provider.baseURL}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen-receipt', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })
    const text = await res.text()
    const content = text.split('\n\n').filter((f) => f.startsWith('data: ') && !f.includes('[DONE]'))
      .map((f) => JSON.parse(f.slice(6))).flatMap((c) => c.choices.map((x) => x.delta?.content ?? '')).join('')
    const ok = res.headers.get('content-type')?.startsWith('text/event-stream') && content === DETERMINISTIC_REPLY && text.trimEnd().endsWith('data: [DONE]')
    console.log(JSON.stringify({ selfTest: ok ? 'pass' : 'fail', content, requests: provider.requests }, null, 2))
    return ok ? 0 : 1
  } finally { await provider.close() }
}

// ── Boot and snapshots ───────────────────────────────────────────────────

async function rigDatabaseUrl(explicit) {
  const { resolveRigDatabase } = await import('../rig-env.mjs')
  const rig = explicit ? null : resolveRigDatabase({ root: OSS_ROOT, env: process.env })
  const url = new URL(explicit ?? rig.url)
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) throw new Error(`refusing non-loopback database host ${url.hostname}`)
  if ((url.port || '5432') === '5432') throw new Error('refusing port 5432: the receipt runs against the maintained rig (5442) or an explicit disposable database')
  return url.href
}

async function waitForHealth(base, child, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`API exited with ${child.exitCode} before /health`)
    try { const r = await fetch(`${base}/health`); if (r.ok) return } catch { /* not yet */ }
    await delay(250)
  }
  throw new Error('API /health timed out')
}

async function snapshot(child, traceDir, label, timeoutMs = 10_000) {
  const before = new Set(readdirSync(traceDir))
  writeFileSync(join(traceDir, '.label'), label)
  child.kill('SIGUSR2')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const fresh = readdirSync(traceDir).filter((f) => f.endsWith('.json') && !before.has(f))
    if (fresh.length) { await delay(50); return JSON.parse(readFileSync(join(traceDir, fresh[0]), 'utf8')) }
    await delay(50)
  }
  throw new Error(`snapshot ${label} not written`)
}

function summarize(snap, previous, root = OSS_ROOT) {
  const prior = new Set(previous?.urls ?? [])
  const added = snap.urls.filter((u) => !prior.has(u))
  const rel = (u) => u.replace(`file://${root}/`, '')
  return {
    label: snap.label, loadedCount: snap.loadedCount, counts: snap.counts, npmPackages: snap.npmPackages,
    elapsedMs: snap.elapsedMs, rssBytes: snap.rssBytes, addedSincePrevious: added.length,
    addedWorkspace: added.filter((u) => u.startsWith('file:') && !u.includes('/node_modules/')).map(rel).sort(),
  }
}

/** Actual local-owner HTTP journey, including the receiving and durable boundary. */
export async function runOrdinaryTurn({ port, timeoutMs = 120_000, populate = false, fixtureAccessToken, outsiderAccessToken }) {
  const base = `http://127.0.0.1:${port}`, signal = AbortSignal.timeout(timeoutMs)
  let accessToken = fixtureAccessToken
  if (!accessToken) {
    const signIn = await fetch(`${base}/auth/local-session`, { method: 'POST', signal })
    if (!signIn.ok) throw new Error(`ordinary turn local sign-in: HTTP ${signIn.status}`)
    accessToken = (await signIn.json()).accessToken
  }
  if (typeof accessToken !== 'string' || !accessToken) throw new Error('ordinary turn local sign-in returned no token')
  const request = (path, body) => fetch(`${base}${path}`, { method: body ? 'POST' : 'GET', signal,
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const listed = await request('/api/workspaces')
  if (!listed.ok) throw new Error(`ordinary turn workspace listing: HTTP ${listed.status}`)
  const list = await listed.json(), workspaceId = (Array.isArray(list) ? list : list.workspaces)?.[0]?.id
  if (!workspaceId) throw new Error('ordinary turn has no fixture workspace')
  const created = await request('/api/sessions/workspace', { workspaceId })
  if (created.status !== 201) throw new Error(`ordinary turn conversation creation: HTTP ${created.status}`)
  const session = await created.json(), started = performance.now()
  if (populate) {
    const seeded = await request('/api/chat', { workspaceId, sessionId: session.id, assistantId: session.assistantId,
      message: 'For this fictional fixture, remember m6-fictional-amber-notebook. Reply with exactly: Deterministic receipt reply.', mode: 'default' })
    const seedBody = await seeded.text()
    if (!seeded.ok || /^event: error\r?$/m.test(seedBody)) throw new Error('ordinary turn fixture history could not be populated through the real route')
  }
  const measuredAt = performance.now()
  const response = await request('/api/chat', { workspaceId, sessionId: session.id, assistantId: session.assistantId,
    message: 'Reply with exactly this sentence, without any other text: Deterministic receipt reply.', mode: 'default' })
  const body = await response.text(), frames = body.split(/\r?\n\r?\n/)
  const textFrames = frames.filter(frame => /^event: text_delta\r?$/m.test(frame))
  const received = textFrames.map(frame => JSON.parse(frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')).text).join('')
  if (response.status !== 200 || frames.some(frame => /^event: error\r?$/m.test(frame)) || received !== DETERMINISTIC_REPLY) {
    const eventKinds = frames.flatMap(frame => /^event: ([^\r\n]+)$/m.exec(frame)?.[1] ?? [])
    const errorCodes = frames.filter(frame => /^event: error\r?$/m.test(frame)).flatMap(frame => {
      const data = /^data: (.+)$/m.exec(frame)?.[1]
      try { return data ? JSON.parse(data).code ?? [] : [] } catch { return [] }
    })
    throw new Error(`ordinary turn failed its receiving boundary: HTTP ${response.status}, ${textFrames.length} text frames, exact reply ${received === DETERMINISTIC_REPLY}, events ${eventKinds.join(', ')}, error codes ${errorCodes.join(', ')}`)
  }
  const historyResponse = await request(`/api/sessions/${session.id}/messages`)
  if (!historyResponse.ok) throw new Error(`ordinary turn reopen: HTTP ${historyResponse.status}`)
  const history = await historyResponse.json(), messages = Array.isArray(history) ? history : history.messages
  const text = message => Array.isArray(message?.content) ? message.content.filter(part => part.type === 'text').map(part => part.text).join('') : message?.content
  const savedReply = messages?.at(-1)?.role === 'assistant' && text(messages.at(-1)) === DETERMINISTIC_REPLY
  if (!savedReply) throw new Error('ordinary turn received its reply but durable reopened history differs')
  const anonymous = await fetch(`${base}/api/sessions/${session.id}/messages`, { signal })
  if (anonymous.status !== 401) throw new Error(`protected history accepted an anonymous reader (${anonymous.status})`)
  let outsiderStatus = null
  if (outsiderAccessToken) {
    const outsider = await fetch(`${base}/api/sessions/${session.id}/messages`, { signal, headers: { authorization: `Bearer ${outsiderAccessToken}` } })
    outsiderStatus = outsider.status
    if (![403, 404].includes(outsiderStatus)) throw new Error(`protected history did not deny the other fixture identity (${outsiderStatus})`)
  }
  return { status: 'pass', httpStatus: response.status, textFrames: textFrames.length, receivedExact: true, savedReply,
    elapsedMs: Math.round(performance.now() - measuredAt), setupAndTurnMs: Math.round(performance.now() - started), populated: populate,
    authentication: fixtureAccessToken ? 'canonical fixture user/device, real signed JWT and unchanged API middleware' : 'local-owner HTTP sign-in',
    identityDenials: { anonymousStatus: anonymous.status, outsiderStatus },
    sessionId: session.id, workspaceId, assistantId: session.assistantId }
}

async function provisionFixtureAuth(root, env, jwtSecret, hosted) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [join(HERE, 'm6/provision-auth.mjs')], { cwd: root,
      env: { ...env, BRIAN_ACCEPTANCE_OSS_ROOT: root, JWT_SECRET: jwtSecret,
        BRIAN_ACCEPTANCE_HOSTED_PLAN: hosted ? 'pro' : '' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    let token, diagnostic = ''
    child.stderr.on('data', bytes => { diagnostic += bytes })
    child.once('message', message => { if (message.type === 'fixture-auth' && typeof message.accessToken === 'string' && typeof message.outsiderAccessToken === 'string') token = { owner: message.accessToken, outsider: message.outsiderAccessToken } })
    child.once('error', reject)
    child.once('exit', code => code === 0 && token ? accept(token) : reject(new Error(`canonical fixture auth provisioning failed (exit ${code}); ${diagnostic.slice(-1000)}`)))
  })
}

export function ordinaryTurnImportDelta(before, after, root = OSS_ROOT) {
  const prior = new Set(before.urls), added = after.urls.filter(url => !prior.has(url))
  const config = JSON.parse(readFileSync(join(HERE, 'import-graph.config.json'), 'utf8'))
  const rules = config.forbidden.files.map(rule => globToRegExp(rule.glob))
  const workspace = added.filter(url => url.startsWith(`file://${root}/`) && !url.includes('/node_modules/'))
    .map(url => url.slice(`file://${root}/`.length).replace('/dist/', '/src/').replace(/\.js$/, '.ts'))
  const previousNpm = new Set(before.npmPackages)
  return { addedModules: added.length, forbiddenWorkspace: workspace.filter(file => rules.some(rule => rule.test(file))),
    forbiddenNpm: after.npmPackages.filter(name => !previousNpm.has(name) && config.forbidden.npm.includes(name)),
    definition: 'modules first loaded between startup and the completed ordinary turn; boot modules and activation probes are separate' }
}

async function runProbe(probe, context) {
  const expected = { id: probe.id, expectedLoads: probe.loads, expectedNpmLoads: probe.npmLoads ?? [] }
  try {
    const { executeActivationProbe } = await import('./m4/activation-probes.mjs')
    return { ...expected, ...await executeActivationProbe(probe.id, context) }
  } catch (error) { return { ...expected, status: 'fail', reason: error.message } }
}

function git(dir, args) { const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null }

/** Stop only the child this receipt created; record actual exit before returning. */
export async function stopOwnedApiChild(child, graceMs = 5_000) {
  const startedAt = new Date().toISOString();
  if (!child) return { startedAt, finishedAt: new Date().toISOString(), spawned: false };
  let closed = child.exitCode !== null || child.signalCode !== null;
  const exit = new Promise(resolveExit => { if (closed) resolveExit(); else child.once('close', () => { closed = true; resolveExit(); }); });
  if (!closed) child.kill('SIGTERM');
  let forced = false;
  const wait = () => { let timer; return Promise.race([exit, new Promise(resolveWait => { timer = setTimeout(resolveWait, graceMs); })]).finally(() => clearTimeout(timer)); };
  await wait();
  if (!closed) { forced = true; child.kill('SIGKILL'); await wait(); }
  if (!closed) throw new Error('Owned API child did not terminate within its bounded cleanup window');
  return { startedAt, finishedAt: new Date().toISOString(), spawned: true, pid: child.pid, forced,
    exitCode: child.exitCode, signal: child.signalCode };
}

export async function receipt(opts) {
  const root = opts.ossRoot ? resolve(opts.ossRoot) : OSS_ROOT
  const entry = opts.hosted ? resolve(root, '../apps/api/dist/index.js') : join(root, 'apps/api/dist/index.js')
  if (!existsSync(entry)) throw new Error(`${entry} is missing: build the OSS API first (pnpm --filter @use-brian/api-open build)`)
  const databaseUrl = await rigDatabaseUrl(opts.databaseUrl)
  let provider = opts.provider ?? null
  let child = null
  const teardown = {}, log = [], snapshots = []
  let idleObservation = null
  try {
  const traceDir = opts.traceDir ?? mkdtempSync(join(tmpdir(), 'brian-module-trace-'))
  const port = opts.port ?? 18000 + Math.floor(Math.random() * 1000)
  const jwtSecret = randomUUID()
  const fixtureDocSyncSecret = opts.fixtureAuth ? randomUUID() : undefined
  const credentialKey = opts.fixtureAuth ? randomBytes(32).toString('base64') : ''
  const fixtureEnv = { ...process.env, ...(opts.env ?? {}), DATABASE_URL: databaseUrl, CHANNEL_CREDENTIAL_KEY: credentialKey }
  const fixtureTokens = opts.fixtureAuth ? await provisionFixtureAuth(root, { ...process.env, ...(opts.env ?? {}), DATABASE_URL: databaseUrl }, jwtSecret,
    opts.hosted && !opts.provider) : undefined
  provider ??= await startDeterministicProvider();
  const deterministicFixture = opts.fixtureAuth && !opts.provider
  const hostedLocalStorage = Boolean(opts.hosted && deterministicFixture && opts.localStorage)
  const runtimeService = opts.fixtureAuth && !hostedLocalStorage ? 'm6-isolated-acceptance' : ''
  const localGuard = fileURLToPath(new URL('./m4/fixture-loopback-only.mjs', import.meta.url))
  const args = ['--import', HOOK, ...(deterministicFixture ? ['--import', localGuard] : []), entry,
    ...(opts.workers ? [] : ['--no-workers']), ...(opts.administrative ? ['--admin-only'] : [])]
  child = spawn(process.execPath, args, {
    // An empty disposable cwd prevents dotenv from importing a checkout's
    // credentials. Module resolution still follows the real built entry.
    cwd: traceDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...(opts.env ?? {}),
      ...(fixtureDocSyncSecret ? { DOC_SYNC_SECRET: fixtureDocSyncSecret } : {}),
      BRIAN_MODULE_TRACE_DIR: traceDir,
      DATABASE_URL: databaseUrl,
      PORT: String(port),
      USEBRIAN_EDITION: opts.hosted ? 'hosted' : 'oss',
      USEBRIAN_PREFERRED_PROVIDER: 'dashscope-intl',
      K_SERVICE: runtimeService,
      NODE_ENV: 'development', JWT_SECRET: jwtSecret,
      LLM_PROVIDER_KEY_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      CHANNEL_CREDENTIAL_KEY: credentialKey,
      LOCAL_FILES_DIR: join(traceDir, 'files'),
      DASHSCOPE_BASE_URL: provider.baseURL,
      DASHSCOPE_API_KEY: 'deterministic-receipt',
      GEMINI_API_KEY: opts.hosted && deterministicFixture ? 'deterministic-hosted-fixture' : '',
      BRIAN_FIXTURE_GEMINI_PORT: opts.hosted && deterministicFixture ? String(provider.port) : '',
      ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', VERTEX_PROJECT_ID: '', FALLBACK_PROVIDER_ENABLED: 'false',
    },
  })
  child.stdout.on('data', (d) => log.push(String(d)))
  child.stderr.on('data', (d) => log.push(String(d)))
    await waitForHealth(`http://127.0.0.1:${port}`, child)
    snapshots.push(await snapshot(child, traceDir, 'startup'))
    if (opts.afterReady) idleObservation = await opts.afterReady({ port, workers: Boolean(opts.workers) })
    const turn = await runOrdinaryTurn({ port, populate: Boolean(opts.populate), fixtureAccessToken: fixtureTokens?.owner, outsiderAccessToken: fixtureTokens?.outsider })
    snapshots.push(await snapshot(child, traceDir, 'after-turn'))
    const importDelta = ordinaryTurnImportDelta(snapshots[0], snapshots[1], root)
    const probes = []
    for (const probe of ACTIVATION_PROBES) {
      const before = snapshots.at(-1), action = await runProbe(probe, { root, fixtureEnv, port, turn, fixtureDocSyncSecret,
        workers: Boolean(opts.workers), accessToken: fixtureTokens?.owner, provider: opts.provider ? null : provider })
      const after = await snapshot(child, traceDir, `probe-${probe.id}`)
      snapshots.push(after)
      const oldUrls = new Set(before.urls)
      const oldNpm = new Set(before.npmPackages)
      const newWorkspace = new Set(after.urls.filter(url => !oldUrls.has(url)).map(url => url.replace(`file://${root}/`, '')))
      const newlyLoadedMatchingModules = probe.loads.filter(path => newWorkspace.has(path))
      const newlyLoadedNpmPackages = (probe.npmLoads ?? []).filter(name => after.npmPackages.includes(name) && !oldNpm.has(name))
      const loadedImplementation = newlyLoadedMatchingModules.length === probe.loads.length &&
        newlyLoadedNpmPackages.length === (probe.npmLoads?.length ?? 0)
      const ingestWorkerLoaded = after.urls.includes(`file://${root}/packages/api/dist/files/file-ingest-worker.js`)
      const expectedWorkerMode = probe.id !== 'file-ingest-job' || ingestWorkerLoaded === Boolean(opts.workers)
      let reason
      if (action.status === 'pass' && !loadedImplementation) {
        reason = 'The action did not first-load its required implementation'
      } else if (action.status === 'pass' && !expectedWorkerMode) {
        reason = 'File-ingest worker module did not honor the selected worker mode'
      }
      probes.push({ ...action, loadedImplementation, newlyLoadedMatchingModules, newlyLoadedNpmPackages,
        ...(probe.id === 'file-ingest-job' ? { ingestWorkerLoaded } : {}),
        ...(reason ? { status: 'fail', reason } : {}) })
    }
    const complete = turn.status === 'pass' && probes.every((p) => p.status === 'pass')
    return {
      tool: 'use-brian/scripts/testing/chat-import-receipt.mjs', schema: 1, mode: 'runtime', label: opts.label ?? null,
      complete,
      completeness: complete ? 'all receiving probes passed' : 'one or more receiving probes did not pass',
      node: process.version, workers: Boolean(opts.workers), entry: opts.hosted ? 'plat:apps/api/dist/index.js' : 'apps/api/dist/index.js',
      administrativeFixture: Boolean(opts.administrative),
      fixtureAuthentication: Boolean(opts.fixtureAuth),
      runtimeEnvironment: { K_SERVICE: runtimeService, runWorkers: Boolean(opts.workers),
        storage: hostedLocalStorage ? 'hosted local-development file storage' : 'normal product selection',
        subscriptionRuntime: runtimeService || opts.administrative ? 'disabled' : 'normal product selection' },
      source: { root, oss: git(root, ['rev-parse', 'HEAD']), ossDirty: Boolean(git(root, ['status', '--porcelain', '--ignore-submodules=all'])),
        entrySha256: createHash('sha256').update(readFileSync(entry)).digest('hex'),
        driverSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
        hookSha256: createHash('sha256').update(readFileSync(HOOK)).digest('hex') },
      provider: { kind: provider.kind ?? (opts.hosted && deterministicFixture ? 'in-driver deterministic Gemini-compatible SSE' : 'in-driver deterministic OpenAI-compatible SSE'), requests: provider.requests,
        ...(provider.ledger ? { spend: provider.ledger.snapshot() } : {}) },
      turn, probes, ordinaryTurnImportDelta: importDelta, idleObservation, teardown,
      turnTimings: Object.fromEntries([...(log.join('').split('\n').filter(line => line.startsWith(`[chat] turn timings session ${turn.sessionId} `)).at(-1) ?? '')
        .matchAll(/\b([a-z_]+)=(\d+(?:\.\d+)?)/g)].map(match => [match[1], Number(match[2])])),
      snapshots: snapshots.map((s, i) => summarize(s, snapshots[i - 1], root)),
      traceDir,
    }
  } catch (err) {
    err.message += `\n--- API log tail ---\n${log.join('').slice(-4000)}`
    throw err
  } finally {
    try { Object.assign(teardown, await stopOwnedApiChild(child)) }
    finally { if (!opts.provider && provider) await provider.close() }
  }
}

function parseArgs(argv) {
  const o = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--self-test') o.selfTest = true
    else if (a === '--workers') o.workers = true
    else if (a === '--hosted') o.hosted = true
    else if (a === '--out') o.out = argv[++i]
    else if (a === '--label') o.label = argv[++i]
    else if (a === '--trace-dir') o.traceDir = argv[++i]
    else if (a === '--port') o.port = Number(argv[++i])
    else if (a === '--database-url') o.databaseUrl = argv[++i]
    else if (a === '--oss-root') o.ossRoot = argv[++i]
    else throw new Error(`unknown argument ${a}`)
  }
  return o
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.selfTest) process.exitCode = await selfTest()
  else {
    const r = await receipt(opts)
    const text = JSON.stringify(r, null, 2) + '\n'
    if (opts.out) writeFileSync(resolve(opts.out), text); else process.stdout.write(text)
    console.error(`chat-import-receipt: ${r.snapshots.length} snapshot(s); complete=${r.complete} (${r.completeness})`)
    process.exitCode = r.complete ? 0 : 3
  }
}
