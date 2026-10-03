import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createServer, type Server, type IncomingMessage } from 'node:http'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import type { Duplex } from 'node:stream'
import type { LLMProvider, ProviderRequest, NativeLlmAdapter } from '@use-brian/core'
import type { NativeControllerOptions } from '../../../apps/app-desktop/src/computer-control/controller.js'
import type { Mock } from 'vitest'
import type { QueryResultRow } from 'pg'
import type {} from '../src/auth/middleware.js'
import type { AddressInfo } from 'node:net'
import { NativeRelay } from '../../../apps/browser-relay/src/native-relay.js'
import { relaySecretMatches } from '../../../apps/browser-relay/src/auth.js'
import { NativeComputerController } from '../../../apps/app-desktop/src/computer-control/controller.js'
import { NativeRelayClient } from '../../../apps/app-desktop/src/computer-control/relay-client.js'
import type { NativeHelper } from '../../../apps/app-desktop/src/computer-control/helper-client.js'
import { CommandSchema, GrantSchema, sameIdentity, type NativeCommand, type NativeGrant, type NativeObservation, type NativeReceipt } from '@use-brian/computer-control/protocol.js'
import { verifyNativeToken } from '../src/auth/native-computer-token.js'
import { nativeComputerRoutes } from '../src/routes/native-computer.js'
import { NativeComputerService } from '../src/computer-use/service.js'
import { composeNativeComputerTool } from '../src/computer-use/composition.js'
import { createRelayNativeComputerProvider } from '../src/computer-use/provider.js'
import { query } from '../src/db/client.js'
import { createNativeComputerModelRuntimeFactory } from '../src/computer-use/model-runtime.js'

vi.mock('../src/db/client.js', () => ({ query: vi.fn() }))

/** P1 fake-OS integration, NOT native acceptance: no Electron runtime, OS input,
 * helper process, provider network, or PostgreSQL. Real production Express routes
 * (this checkout has no Hono native routes), service, composition/orchestrator,
 * NativeRelay, main controller and NativeRelayClient. Only SQL/auth, model choices,
 * local dialog and NativeHelper are fixtures. The relay entrypoint has no factory;
 * this host wires its native-only HTTP/WS namespace to the actual NativeRelay.
 * No BrowserRelay execution, mocked fetch, mocked send/receive, or desktop access.
 */
// Runtime resolution uses the relay's installed ws; the API has no @types/ws.
// This narrow transport boundary derives send/close from the real relay contract.
type Socket = Parameters<NativeRelay['handle']>[0] & {
  terminate(): void
  on(event: 'message', listener: (raw: Buffer) => void): void
  on(event: 'close' | 'error', listener: () => void): void
}
interface SocketServer {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, done: (socket: Socket) => void): void
  emit(event: 'connection', socket: Socket): void
  on(event: 'connection', listener: (socket: Socket) => void): void
  close(done: () => void): void
}
const { WebSocket, WebSocketServer } = createRequire(new URL('../../../apps/browser-relay/package.json', import.meta.url))('ws') as {
  WebSocket: new (url: string) => Socket
  WebSocketServer: new (options: { noServer: boolean }) => SocketServer
}
const model = { catalogId: 'fake-native-e2e', wireId: 'fake-native-e2e' }
const completion = (result: string) => ({ result, providerId: 'fake-native-e2e', model })
const uuid = () => randomUUID()
const scope = { userId: uuid(), workspaceId: uuid(), assistantId: uuid(), conversationId: uuid(), taskId: uuid() }
const authSessionId = uuid()
const target = { appId: 'fake-editor', processId: 42, processInstanceId: 'fake-process', windowId: 'fake-window', windowInstanceId: 'fake-instance' }
const bounds = { x: 0, y: 0, width: 200, height: 100 }
const secret = 'native-e2e-only-secret'
const caps = { protocol: 'native-computer-v1' as const, platform: 'darwin' as const, axRead: true, semanticActions: true, windowCapture: false, input: false, accessibilityPermission: 'granted' as const, capturePermission: 'denied' as const, limitations: [] }
type Row = typeof scope & { id: string; deviceId: string; deploymentId: string; challenge: string; expiresAt: Date; authSessionId: string; state: string; epoch: number; grantId: string | null; runState: string | null; revoked?: boolean }
let row: Row | undefined
let audits: unknown[][]
let revokedAuthority: 'auth' | 'capability' | 'policy' | undefined
let executionChecks: number

// Deliberately narrow SQL test double: unknown queries fail, writes retain state,
// CAS/run claims and authenticated owner/session reads are enforced, not canned.
function memoryQuery(sql: string, p: unknown[] = []) {
  const rows = (values: unknown[] = []) => ({ rows: values })
  if (sql.startsWith('SELECT 1 FROM native_computer_sessions n')) {
    // Atomic execution authorization: evaluate the full bound scope and all
    // simulated revocations here, never fall through to a generic row SELECT.
    const expected = row && [row.id,row.userId,row.authSessionId,row.workspaceId,row.assistantId,row.conversationId,row.taskId,row.grantId,row.epoch,row.deploymentId,row.deviceId]
    return rows(row && expected && p.length === expected.length && p.every((v,i) => v === expected[i]) &&
      row.state === 'execution_unknown' && !row.revoked && row.expiresAt.getTime() > Date.now() &&
      !revokedAuthority && row.userId === scope.userId && row.workspaceId === scope.workspaceId &&
      row.assistantId === scope.assistantId && row.conversationId === scope.conversationId && row.taskId === scope.taskId ? [{}] : [])
  }
  if (sql.startsWith('SELECT 1 FROM sessions')) return rows(revokedAuthority !== 'capability' && p.every((v, i) => v === [scope.userId, scope.workspaceId, scope.assistantId, scope.conversationId, scope.taskId][i]) ? [{}] : [])
  if (sql.startsWith('SELECT policy')) return rows(revokedAuthority === 'policy' ? [{policy:'block'}] : [])
  if (sql.startsWith('INSERT INTO native_computer_audit')) { audits.push([...p]); return rows() }
  if (sql.startsWith('INSERT INTO native_computer_sessions')) {
    row = { id: p[0] as string, ...scope, deviceId: p[6] as string, deploymentId: p[7] as string, challenge: p[8] as string, expiresAt: p[9] as Date, authSessionId: p[10] as string, state: 'awaiting_local_consent', epoch: 0, grantId: null, runState: null }
    return rows()
  }
  if (sql.startsWith('SELECT id FROM native_computer_sessions WHERE deployment_id')) return rows(row && row.deviceId === p[1] && (row.state === 'execution_unknown' || row.runState === 'running' || row.runState === 'execution_unknown') ? [row] : [])
  if (sql.startsWith('SELECT')) {
    if (sql.includes('FROM auth_sessions') && revokedAuthority === 'auth') return rows()
    if (!row || row.id !== p[0] || row.userId !== p[1]) return rows()
    if (sql.includes('auth_session_id=$3') && p[2] !== row.authSessionId) return rows()
    if (sql.includes('revoked_at IS NULL AND expires_at>now()') && (row.revoked || row.expiresAt.getTime() <= Date.now())) return rows()
    return rows([{ ...row }])
  }
  if (sql.includes('WHERE expires_at<=now()')) return rows()
  if (!row || row.id !== p[0]) throw new Error(`Unexpected SQL: ${sql}`)
  if (sql.includes("SET state='active',grant_id")) {
    if (row.state !== 'awaiting_local_consent' || row.revoked) return rows()
    Object.assign(row, { state: 'active', grantId: p[2], expiresAt: p[3], epoch: p[4] })
  } else if (sql.includes("SET run_state='running'")) {
    if (row.runState || row.revoked || row.state !== 'active' || row.grantId !== p[1]) return rows()
    row.runState = 'running'
  } else if (sql.includes('SET run_state=CASE')) row.runState = row.state === 'execution_unknown' ? 'execution_unknown' : p[2] as string
  else if (sql.includes('revoked_at=COALESCE')) { row.state = 'execution_unknown'; row.revoked = true; row.epoch++ }
  else if (sql.includes('SET revoked_at=now()')) {
    if (row.revoked) return rows()
    row.revoked = true; row.epoch++; if (row.state !== 'execution_unknown') row.state = 'ended'
  } else if (sql.includes("SET state='execution_unknown'")) {
    if (row.state !== 'active' || row.revoked) return rows()
    row.state = 'execution_unknown'
  } else if (sql.includes("SET state='active'")) { if (!row.revoked && row.state === 'execution_unknown') row.state = 'active' }
  else throw new Error(`Unexpected SQL: ${sql}`)
  return rows([{ id: row.id }])
}

let relay: NativeRelay
let server: Server
let wss: InstanceType<typeof WebSocketServer>
let service: NativeComputerService
let controller: NativeComputerController
let client: NativeRelayClient
let app: ReturnType<typeof express>
let grant: NativeGrant
let helper: NativeHelper
let calls: NativeCommand[]
let observations: NativeObservation[]
let effects: number
let mode: 'normal' | 'stall' | 'lost'
let approveAction: Mock<NativeControllerOptions['approveAction']>
let approveGrant: Mock<NativeControllerOptions['approveGrant']>
let verify: Mock<NonNullable<NativeLlmAdapter['verify']>>
let relayUrl: string
let sockets: Set<InstanceType<typeof WebSocket>>
let wireMessages: Array<{ type: string; status?: ReturnType<NativeComputerController['status']>; receipt?: NativeReceipt }>

beforeEach(async () => {
  wireMessages = []; revokedAuthority = undefined; executionChecks = 0; row = undefined; audits = []; calls = []; observations = []; effects = 0; mode = 'normal'; sockets = new Set()
  vi.mocked(query).mockImplementation(async <T extends QueryResultRow>(sql: string, params?: unknown[]) => {
    const result = memoryQuery(sql, params)
    // As with pg, the caller chooses the row type for its SQL projection.
    return { command: '', rowCount: result.rows.length, oid: 0, fields: [], rows: result.rows as T[] }
  })
  relay = new NativeRelay(token => verifyNativeToken(token, secret))
  const host = express()
  host.use('/internal', (req, res, next) => { if (!relaySecretMatches(req.headers['x-relay-secret'], secret)) { res.sendStatus(401); return } next() })
  host.use(express.json())
  host.post('/internal/native-computer/register', (req, res) => {
    const g = GrantSchema.parse(req.body.grant); const c = verifyNativeToken(req.body.token, secret)
    if (!c || !sameIdentity(c.identity, g.identity) || c.grantId !== g.grantId || c.epoch !== g.epoch || c.exp !== g.expiresAt) { res.sendStatus(403); return }
    relay.register(g, c.jti); res.json({ ok: true })
  })
  host.post('/internal/native-computer/command', async (req, res) => { res.json(await relay.dispatch(req.body)) })
  host.get('/internal/native-computer/sessions/:id', (req, res) => { relay.sweep(); res.json(relay.status(req.params.id)) })
  host.delete('/internal/native-computer/sessions/:id', (req, res) => { relay.revoke(req.params.id); res.json({ ok: true }) })
  server = createServer(host)
  wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/native-computer-v1') { socket.destroy(); return }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws))
  })
  wss.on('connection', socket => {
    sockets.add(socket)
    socket.on('message', raw => { wireMessages.push(JSON.parse(raw.toString())); relay.handle(socket, raw.toString()) })
    socket.on('close', () => { sockets.delete(socket); relay.disconnect(socket) })
    socket.on('error', () => relay.disconnect(socket))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  relayUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  service = new NativeComputerService({ relayUrl, relaySecret: secret, jwtSecret: secret, deploymentId: 'e2e' })
  helper = {
    capabilities: async () => caps, listTargets: async () => [target], start: async () => {},
    beginApproval: vi.fn(async () => true), endApproval: vi.fn(async () => true), kill: vi.fn(async () => {}),
    execute: async c => {
      calls.push(c)
      if (c.action.kind === 'observe') {
        const o: NativeObservation = { id: uuid(), identity: c.identity, epoch: c.epoch, target, capturedAt: Date.now(), monotonicMs: observations.length + 1, foreground: true, bounds, displayLayoutVersion: 'fake-layout', completeness: 'complete', nodes: [{ ref: 'save', role: 'button', name: effects ? 'Saved' : 'Save', enabled: true, focused: false, selected: false, sensitive: false, actions: ['invoke'], bounds }] }
        observations.push(o)
        return { commandId: c.commandId, outcome: 'executed', code: 'ok', observation: o }
      }
      expect(c.action.kind).toBe('invoke'); effects++
      if (mode === 'lost') for (const socket of sockets) socket.terminate() // Actual link loss AFTER effect, BEFORE receipt.
      if (mode !== 'normal') return new Promise<NativeReceipt>(() => {}) // No OS resources or timers.
      return { commandId: c.commandId, outcome: 'executed', code: 'ok' }
    },
  }
  approveGrant = vi.fn(async () => true)
  approveAction = vi.fn<NativeControllerOptions['approveAction']>(async (c, _signal, context) => {
    expect(context).toMatchObject({ commandId: c.commandId, identity: grant.identity, observationId: observations[0].id, nodes: [{ ref: 'save', name: 'Save' }] })
    expect(effects).toBe(0)
    return true
  })
  controller = new NativeComputerController({ enabled: true, platform: 'darwin', safetyControlsReady: () => true, helperFactory: () => helper, lease: { acquire: async () => {}, release: async () => {} }, approveGrant, approveAction,
    revalidateExecution: async (command, signal) => {
      if (signal.aborted) return false
      executionChecks++
      const response = await request(app).post(`/sessions/${command.identity.sessionId}/revalidate`).send({
        commandId: command.commandId, grantId: command.grantId, epoch: command.epoch, deadlineAt: command.deadlineAt,
        digest: createHash('sha256').update(JSON.stringify(CommandSchema.parse(command))).digest('hex'),
      })
      return !signal.aborted && response.status === 200 && response.body.authorized === true
    },
  })
  verify = vi.fn<NonNullable<NativeLlmAdapter['verify']>>(async ({ observation }) => { expect(observation.id).not.toBe(observations[0].id); expect(observation.frame).toBeUndefined(); return completion('complete') })
  const tool = composeNativeComputerTool(service, async () => ({
    llm: { select: async ({ candidates }) => completion(candidates[0].id), verify },
    policy: { allows: action => action.kind === 'invoke', allowsCapture: () => false, isComplete: o => o.nodes.some(n => n.name === 'Saved') },
  }))
  app = express(); app.use(express.json())
  // Same authenticated in-process seam as routes/__tests__/native-computer.test.ts.
  app.use((req, _res, next) => { req.userId = scope.userId; req.authSessionId = authSessionId; next() })
  app.use(nativeComputerRoutes(service, tool))
}, 10_000)

afterEach(async () => {
  client?.disconnect()
  await controller?.dispose()
  if (row) relay?.revoke(row.id)
  for (const socket of sockets ?? []) socket.terminate()
  if (wss) await new Promise<void>(resolve => wss.close(() => resolve()))
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  vi.restoreAllMocks()
}, 10_000)

async function pair(overrides: Partial<Pick<NativeGrant, 'targets' | 'allowCapture' | 'goal'>> = {}) {
  const verifier = 'x'.repeat(43)
  const created = await request(app).post('/sessions').send({ ...Object.fromEntries(Object.entries(scope).filter(([k]) => k !== 'userId')), deviceId: 'fake-device', challenge: createHash('sha256').update(verifier).digest('base64url') }).expect(201)
  grant = { protocol: 'native-computer-v1', identity: created.body.identity, grantId: uuid(), epoch: 1, expiresAt: Date.now() + 60_000, targets: [target], allowControl: true, allowCapture: false, requester: 'Fixture user', goal: 'Save the fixture', ...overrides }
  await controller.start(grant)
  expect(approveGrant).toHaveBeenCalledOnce()
  const path = `/sessions/${grant.identity.sessionId}`
  await request(app).post(`${path}/exchange`).set('Origin', 'https://renderer.invalid').send({ verifier, grant }).expect(403)
  await request(app).post(`${path}/exchange`).send({ verifier: 'z'.repeat(43), grant }).expect(403)
  const exchanged = await request(app).post(`${path}/exchange`).send({ verifier, grant }).expect(200)
  expect(verifyNativeToken(exchanged.body.token, secret)?.identity).toEqual(grant.identity)
  client = new NativeRelayClient(controller, grant.identity, url => new WebSocket(url) as unknown as globalThis.WebSocket)
  client.connect(exchanged.body.relayUrl, exchanged.body.token)
  await client.waitUntilReady(AbortSignal.timeout(2000))
  await vi.waitFor(() => expect(relay.status(row!.id).status?.state).toBe('active'), { timeout: 2000 })
  return path
}

function command(): NativeCommand { return { protocol: 'native-computer-v1', identity: grant.identity, grantId: grant.grantId, epoch: grant.epoch, commandId: uuid(), deadlineAt: Date.now() + 2000, action: { kind: 'observe', target } } }

describe('P1 native fake-OS end-to-end over loopback HTTP + WebSocket', () => {
  it.each([true, false])('concrete runtime click/readback with effect capabilities downgraded (counter advances: %s)', async advances => {
    const canvasTarget = { ...target, appId: 'com.usebrian.NativeComputerFixture' }
    const full = { ...caps, input: true, windowCapture: true, capturePermission: 'granted' as const }
    helper.capabilities = async () => effects ? { ...full, semanticActions: false, input: false } : full
    helper.listTargets = async () => [canvasTarget]
    helper.execute = async c => {
      calls.push(c)
      if (c.action.kind === 'click') {
        effects++
        return { commandId: c.commandId, outcome: 'executed', code: 'ok' }
      }
      expect(['observe', 'capture']).toContain(c.action.kind)
      if (effects) {
        expect(controller.status().capabilities).toMatchObject({ axRead: true, semanticActions: false, input: false })
        expect(relay.status(row!.id).status?.capabilities).toMatchObject({ axRead: true, semanticActions: false, input: false })
      }
      await new Promise(resolve => setTimeout(resolve, 2))
      const seq = observations.length + 1
      const o: NativeObservation = { id: `canvas-${seq}`, identity: c.identity, epoch: c.epoch,
        target: canvasTarget, capturedAt: Date.now(), monotonicMs: seq, foreground: true,
        bounds, displayLayoutVersion: 'fake-layout', completeness: 'complete',
        nodes: [{ ref: `counter-${seq}`, role: 'AXGroup', name: 'Safe custom canvas',
          value: `Canvas clicks: ${effects && advances ? 1 : 0}`, enabled: true, focused: false,
          selected: false, sensitive: false, actions: [] }],
        ...(c.action.kind === 'capture' ? { frame: { id: `frame-${seq}`, mimeType: 'image/png' as const,
          data: 'synthetic-canvas-pixels', width: 200, height: 100, bounds, displayLayoutVersion: 'fake-layout' } } : {}),
      }
      observations.push(o)
      return { commandId: c.commandId, outcome: 'executed', code: 'ok', observation: o }
    }
    approveAction.mockImplementation(async c => {
      expect(c.action).toMatchObject({ kind: 'click', target: canvasTarget, x: 100, y: 65 })
      expect(effects).toBe(0)
      return true
    })
    const requests: ProviderRequest[] = []
    const provider: LLMProvider = { name: 'synthetic', models: ['synthetic-canvas'], createSession: vi.fn(),
      stream: async function* (r) {
        expect(r).toMatchObject({ nativeStrict: true, allowProviderFallback: false, model: 'synthetic-canvas', responseFormat: 'json' })
        expect(r.httpRetryWindow!.deadline).toBeLessThanOrEqual(Date.now())
        const index = requests.push(r) - 1
        expect(index).toBeLessThan(4) // Unexpected replan/selection is a regression, not another canned answer.
        const content = r.messages[0]!.content as Array<{ type: string; text?: string }>
        const context = JSON.parse(content[0]!.text!)
        const replies = [
          { steps: [] },
          { objectives: [{ role: 'AXGroup', name: 'Safe custom canvas', property: 'value', equals: 'Canvas clicks: 1' }] },
          { x: 100, y: 65 },
          // Deliberately overclaims success for the unchanged-counter case.
          { status: 'complete', observationId: context.observationId,
            evidence: [{ ref: context.nodes[0].ref, property: 'value', equals: 'Canvas clicks: 1' }] },
        ]
        expect(content.some(part => part.type === 'image')).toBe(index === 2)
        if (index === 3) {
          expect(effects).toBe(1)
          expect(context.observationId).toBe(observations.at(-1)!.id)
          expect(context.nodes[0].value).toBe(`Canvas clicks: ${advances ? 1 : 0}`)
        }
        yield { type: 'text_delta', text: JSON.stringify(replies[index]) }
        yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 },
          nativeMetadata: { actualModel: 'synthetic-canvas', usage: { inputTokens: 10, outputTokens: 5 } } }
      },
    }
    const meter = vi.fn(async () => {}) // Synthetic accounting only; no billing/production claim.
    const runtime = createNativeComputerModelRuntimeFactory({ localApprovalRequired: true,
      resolve: async () => ({ provider, model: 'synthetic-canvas', plan: 'enterprise', budgetStatus: 'ok',
        grounder: { provider, model: 'synthetic-canvas', nativeGrounding: true } }),
      budget: { tokens: 10000000, costUsd: 1000, attemptTokens: 100000, attemptCostUsd: 1 }, meter,
    })
    app = express(); app.use(express.json())
    app.use((req, _res, next) => { req.userId = scope.userId; req.authSessionId = authSessionId; next() })
    app.use(nativeComputerRoutes(service, composeNativeComputerTool(service, runtime)))
    const path = await pair({ targets: [canvasTarget], allowCapture: true, goal: 'Click the canvas once' })
    const result = await request(app).post(`${path}/run`).send({}).expect(200)
    expect(result.body.data).toMatchObject({ outcome: advances ? 'completed' : 'paused', actions: 1 })
    expect(calls.map(c => c.action.kind)).toEqual(['observe', 'observe', 'capture', 'click', 'observe'])
    expect(observations.at(-1)!.id).not.toBe(observations[0].id)
    expect(observations.at(-1)!.capturedAt).toBeGreaterThan(observations[0].capturedAt)
    const click = calls.find(c => c.action.kind === 'click')!
    const receiptIndex = wireMessages.findIndex(m => m.type === 'receipt' && m.receipt?.commandId === click.commandId)
    expect(receiptIndex).toBeGreaterThan(0)
    expect(wireMessages[receiptIndex]).toMatchObject({ receipt: { outcome: 'executed', code: 'ok' } })
    expect(wireMessages[receiptIndex - 1]).toMatchObject({ type: 'status', status: { state: 'active',
      capabilities: { axRead: true, semanticActions: false, input: false } } })
    expect(audits.filter(a => a.length === 5)).toEqual(calls.map(c => [grant.identity.sessionId, c.commandId, c.action.kind, 'executed', 'ok']))
    expect(requests).toHaveLength(4); expect(meter).toHaveBeenCalledTimes(12)
    expect(provider.createSession).not.toHaveBeenCalled()
    expect(effects).toBe(1); expect(approveAction).toHaveBeenCalledOnce()
    expect(helper.beginApproval).toHaveBeenCalledOnce(); expect(helper.endApproval).toHaveBeenCalledOnce()
    const dispatches = calls.length
    expect((await request(app).post(`${path}/run`).send({}).expect(200)).body).toMatchObject({ duplicate: true, runState: 'finished' })
    expect(calls).toHaveLength(dispatches); expect(effects).toBe(1); expect(approveAction).toHaveBeenCalledOnce()
  }, 10_000)

  it('grants/exchanges/runs one AX effect with local approval, fresh verification and persisted authenticated receipts', async () => {
    const path = await pair()
    const result = await request(app).post(`${path}/run`).send({}).expect(200)
    expect(result.body.data).toMatchObject({ outcome: 'completed', actions: 1, reason: 'Verified goal postconditions' })
    expect(calls.map(c => c.action.kind)).toEqual(['observe', 'invoke', 'observe'])
    expect(executionChecks).toBe(4) // read, pre-focus, post-focus/pre-input, read
    expect(effects).toBe(1); expect(approveAction).toHaveBeenCalledOnce(); expect(verify).toHaveBeenCalledOnce()
    expect(helper.beginApproval).toHaveBeenCalledOnce(); expect(helper.endApproval).toHaveBeenCalledOnce()
    expect(observations.every(o => !o.frame)).toBe(true)
    expect(row).toMatchObject({ userId: scope.userId, authSessionId, runState: 'finished', revoked: true })
    expect(audits.filter(a => a.length === 5)).toEqual(calls.map(c => [grant.identity.sessionId, c.commandId, c.action.kind, 'executed', 'ok']))
    expect((await request(app).post(`${path}/run`).send({}).expect(200)).body).toMatchObject({ duplicate: true, runState: 'finished' })
    expect(effects).toBe(1)
  }, 10_000)

  it('rejects cross-scope and forged epochs before any helper execution, including through the relay transport', async () => {
    await pair()
    const provider = createRelayNativeComputerProvider(service, { ...scope, taskId: uuid() }, row!.id)
    await expect(provider.execute(command(), new AbortController().signal)).rejects.toThrow('scope denied')
    for (const c of [{ ...command(), epoch: 99 }, { ...command(), identity: { ...grant.identity, workspaceId: uuid() } }]) {
      const response = await fetch(`${relayUrl}/internal/native-computer/command`, { method: 'POST', headers: { 'x-relay-secret': secret, 'content-type': 'application/json' }, body: JSON.stringify(c) })
      expect(await response.json()).toMatchObject({ commandId: c.commandId, outcome: 'not_executed', code: 'denied' })
    }
    const forged = { ...command(), epoch: 99 }
    await expect(createRelayNativeComputerProvider(service, scope, row!.id).execute(forged, new AbortController().signal)).rejects.toThrow('scope denied')
    expect(calls).toHaveLength(0); expect(approveAction).not.toHaveBeenCalled()
    expect((await fetch(`${relayUrl}/internal/native-computer/sessions/${row!.id}`)).status).toBe(401)
  }, 10_000)

  it.each(['stall', 'lost'] as const)('%s: independent local Stop/link loss persists uncertainty and never retries the effect', async failure => {
    const path = await pair(); mode = failure
    const running = request(app).post(`${path}/run`).send({}).then(r => r)
    await vi.waitFor(() => expect(effects).toBe(1), { timeout: 2000 })
    if (failure === 'stall') {
      // Stop does not await the stalled helper, command queue or HTTP request.
      const stopped = controller.stop()
      expect(controller.status().state).toBe('stopped')
      expect(helper.kill).toHaveBeenCalledOnce() // Synchronous, before awaiting shutdown.
      await stopped
    }
    const result = await running
    expect(result.status).toBe(200)
    expect(result.body.data).toMatchObject({ outcome: 'execution_unknown', actions: 1 })
    expect(row).toMatchObject({ state: 'execution_unknown', runState: 'execution_unknown', revoked: true })
    expect(helper.kill).toHaveBeenCalledOnce()
    expect(calls.map(c => c.action.kind)).toEqual(['observe', 'invoke'])
    expect(audits).toContainEqual([grant.identity.sessionId, calls[1].commandId, 'invoke', 'execution_unknown', 'transport_error'])
    expect((await request(app).post(`${path}/run`).send({}).expect(200)).body).toMatchObject({ duplicate: true, runState: 'execution_unknown' })
    expect(effects).toBe(1); expect(verify).not.toHaveBeenCalled()
    // New pairing cannot silently clear the durable ambiguity for this device.
    await request(app).post('/sessions').send({ workspaceId: scope.workspaceId, assistantId: scope.assistantId, conversationId: scope.conversationId, taskId: scope.taskId, deviceId: 'fake-device', challenge: createHash('sha256').update('x'.repeat(43)).digest('base64url') }).expect(403)
    expect((await controller.execute(command())).code).toBe('stopped')
    expect(() => client.connect(`${relayUrl.replace('http:', 'ws:')}/native-computer-v1`, 'forged')).toThrow()
  }, 10_000)
})

it.each(['auth','capability','policy'] as const)('transport denies %s revocation during endApproval without helper input', async authority => {
  const path = await pair()
  let release!: (allowed: boolean) => void
  vi.mocked(helper.endApproval).mockImplementation(() => new Promise(resolve => { release = resolve }))
  const running = request(app).post(`${path}/run`).send({}).then(r => r)
  await vi.waitFor(() => expect(helper.endApproval).toHaveBeenCalledOnce(), { timeout: 2000 })
  expect(executionChecks).toBe(2)
  revokedAuthority = authority; release(true)
  await running
  expect(executionChecks).toBe(3)
  expect(effects).toBe(0); expect(calls.map(c => c.action.kind)).toEqual(['observe'])
}, 10000)
