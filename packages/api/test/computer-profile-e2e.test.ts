import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import express from 'express'
import { createServer, type Server, type IncomingMessage } from 'node:http'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Duplex } from 'node:stream'
import type { AddressInfo } from 'node:net'
import { PGlite } from '@electric-sql/pglite'
import type { ToolContext } from '@use-brian/core'
import { NativeRelay } from '../../../apps/browser-relay/src/native-relay.js'
import { NativeReleaseRequestSchema } from '../../../apps/browser-relay/src/native-relay.js'
import { relaySecretMatches } from '../../../apps/browser-relay/src/auth.js'
import { NativeComputerController } from '../../../apps/app-desktop/src/computer-control/controller.js'
import { NativeRelayClient } from '../../../apps/app-desktop/src/computer-control/relay-client.js'
import type { NativeHelper } from '../../../apps/app-desktop/src/computer-control/helper-client.js'
import { CommandSchema, GrantSchema, sameIdentity, type NativeCommand, type NativeProfileGrant, type NativeObservation } from '@use-brian/computer-control/protocol.js'
import { verifyNativeToken } from '../src/auth/native-computer-token.js'
import { nativeComputerRoutes } from '../src/routes/native-computer.js'
import { NativeComputerService } from '../src/computer-use/service.js'
import { composeComputerProfileTools } from '../src/computer-use/profile-tools.js'
import { query, getPool } from '../src/db/client.js'

vi.mock('../src/db/client.js', () => ({ query: vi.fn(), getPool: vi.fn() }))

// Synthetic OS/authentication only. PGlite runs the production SQL/migrations;
// service authorization, chat tool schemas (createComputerProfileTools), HTTP,
// relay, WS client and controller are real. No task runner or model/provider.
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
const db = new PGlite()
const uuid = () => randomUUID()
const u=uuid(), w=uuid(), a=uuid(), chat=uuid(), chat2=uuid(), auth=uuid()
const secret = 'synthetic-profile-e2e-only'
const target = { appId: 'fake-editor', processId: 42, processInstanceId: 'fake-process', windowId: 'fake-window', windowInstanceId: 'fake-instance' }
const bounds = { x: 0, y: 0, width: 200, height: 100 }
const caps = { protocol: 'native-computer-v1' as const, platform: 'darwin' as const, axRead: true, semanticActions: true, windowCapture: false, input: false, accessibilityPermission: 'granted' as const, capturePermission: 'denied' as const, limitations: [] }
const context = (sessionId=chat): ToolContext => ({userId:u,workspaceId:w,assistantId:a,sessionId,appId:'chat',channelType:'web',channelId:'chat',activeCapabilities:new Set(['native_computer']),abortSignal:new AbortController().signal})
let server: Server, wss: SocketServer, controller: NativeComputerController, client: NativeRelayClient
const sockets = new Set<Socket>()
let service: NativeComputerService, relay: NativeRelay, base: string
const calls: NativeCommand[] = [], observations: NativeObservation[] = []
let effects=0, allowAction=true, executionChecks=0
const approveGrant=vi.fn(async () => true)
const approveAction=vi.fn(async () => allowAction)

// Real HTTP even for desktop revalidation (not a service method spy).
async function http<T = unknown>(path: string, method='GET', body?: unknown, status=200) {
  const response = await fetch(`${base}${path}`, {method, headers:{'content-type':'application/json'}, ...(body === undefined ? {} : {body:JSON.stringify(body)})})
  expect(response.status, `${method} ${path}`).toBe(status)
  return await response.json() as T
}
beforeAll(async () => {
 await db.exec(`CREATE TABLE users(id uuid PRIMARY KEY,auth_version int DEFAULT 1);
 CREATE TABLE workspaces(id uuid PRIMARY KEY);
 CREATE TABLE assistants(id uuid PRIMARY KEY,workspace_id uuid,owner_user_id uuid,name text DEFAULT 'Workspace Assistant',blocked_user_ids uuid[] DEFAULT '{}');
 CREATE TABLE sessions(id uuid PRIMARY KEY,user_id uuid,assistant_id uuid,title text DEFAULT 'PRIVATE CHAT TITLE');
 CREATE TABLE tasks(id uuid PRIMARY KEY,workspace_id uuid,user_id uuid,assistant_id uuid,valid_to timestamptz,retracted_at timestamptz,scope_held boolean);
 CREATE TABLE auth_sessions(id uuid PRIMARY KEY,user_id uuid,revoked_at timestamptz,expires_at timestamptz,auth_version int);
 CREATE TABLE workspace_members(user_id uuid,workspace_id uuid);
 CREATE TABLE assistant_capabilities(assistant_id uuid,capability text,revoked_at timestamptz);
 CREATE TABLE mcp_tool_settings(assistant_id uuid,user_id uuid,server_name text,tool_name text,policy text);
 CREATE TABLE workspace_tool_policy(workspace_id uuid,server_name text,tool_name text,policy text);`)
 for(const migration of ['620_native_computer_sessions.sql','622_computer_profiles.sql']) await db.exec(await readFile(new URL(`../migrations/${migration}`,import.meta.url),'utf8'))
 vi.mocked(query).mockImplementation(((sql:string, params?:unknown[]) => db.query(sql,params)) as typeof query)
 vi.mocked(getPool).mockReturnValue({connect:async () => ({query:(sql:string,params?:unknown[]) => db.query(sql,params),release(){}})} as never)
 await db.query('INSERT INTO users(id) VALUES($1)',[u])
 await db.query('INSERT INTO workspaces VALUES($1)',[w])
 await db.query('INSERT INTO assistants(id,workspace_id) VALUES($1,$2)',[a,w])
 await db.query('INSERT INTO sessions(id,user_id,assistant_id) VALUES($1,$3,$4),($2,$3,$4)',[chat,chat2,u,a])
 await db.query("INSERT INTO auth_sessions VALUES($1,$2,NULL,now()+interval '1 hour',1)",[auth,u])
 await db.query('INSERT INTO workspace_members VALUES($1,$2)',[u,w])
 await db.query("INSERT INTO assistant_capabilities VALUES($1,'native_computer',NULL)",[a])
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
  host.delete('/internal/native-computer/sessions/:id', (req, res) => { relay.revoke(req.params.id, req.body && Object.keys(req.body).length ? NativeReleaseRequestSchema.parse(req.body).reason : undefined); res.json({ ok: true }) })
  server = createServer(host)
  wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/native-computer-v1') { socket.destroy(); return }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws))
  })
  wss.on('connection', socket => {
    sockets.add(socket)
    socket.on('message', raw => { relay.handle(socket, raw.toString()) })
    socket.on('close', () => { sockets.delete(socket); relay.disconnect(socket) })
    socket.on('error', () => relay.disconnect(socket))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const relayUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  service = new NativeComputerService({ relayUrl, relaySecret: secret, jwtSecret: secret, deploymentId: 'e2e' })
  base=relayUrl
  const helper: NativeHelper = {
    capabilities:async () => caps, listTargets:async () => [target], start:async () => {},
    beginApproval:async () => true, endApproval:async () => true, kill:async () => {},
    execute:async command => {
      calls.push(command)
      if(command.action.kind === 'observe') {
        const observation: NativeObservation = {id:uuid(),identity:command.identity,epoch:command.epoch,target,
          capturedAt:Date.now(),monotonicMs:observations.length+1,foreground:true,bounds,displayLayoutVersion:'synthetic',completeness:'complete',
          nodes:[{ref:'document',role:'AXTextArea',name:'Document',value:effects ? 'Hello fixture' : '',enabled:true,focused:false,selected:false,sensitive:false,actions:['setValue'],bounds}]}
        observations.push(observation)
        return {commandId:command.commandId,outcome:'executed',code:'ok',observation}
      }
      expect(command.action).toMatchObject({kind:'setValue',ref:'document',text:'Hello fixture',target,observationId:observations.at(-1)!.id})
      effects++
      return {commandId:command.commandId,outcome:'executed',code:'ok'}
    },
  }
  controller=new NativeComputerController({enabled:true,platform:'darwin',safetyControlsReady:() => true,helperFactory:() => helper,
    lease:{acquire:async () => {},release:async () => {}},approveGrant,approveAction,
    revalidateExecution:async (command,signal) => {
      if(signal.aborted) return false
      executionChecks++
      const result=await http<{authorized:boolean}>(`/sessions/${command.identity.sessionId}/revalidate`,'POST',{
        commandId:command.commandId,grantId:command.grantId,epoch:command.epoch,deadlineAt:command.deadlineAt,
        digest:createHash('sha256').update(JSON.stringify(CommandSchema.parse(command))).digest('hex'),
      })
      return !signal.aborted && result.authorized === true
    },
  })
  host.use((req,_res,next) => {req.userId=u;req.authSessionId=auth;next()})
  host.use(nativeComputerRoutes(service))
},30_000)

afterAll(async () => {
  client?.disconnect()
  await controller?.dispose()
  for(const socket of sockets) socket.terminate()
  if(wss) await new Promise<void>(resolve => wss.close(resolve))
  if(server) {server.closeAllConnections();await new Promise<void>(resolve => server.close(() => resolve()))}
  await db.close()
  vi.restoreAllMocks()
},10_000)

it('profile chat consent crosses real HTTP/WS for one approved AX effect; release requires fresh consent and denial cannot replay', async () => {
  const tools=composeComputerProfileTools(service) // Production createComputerProfileTools wrapper, no model calls.
  const created=await http<{profile:{id:string}}>('/profiles','POST',{workspaceId:w,name:'Fixture Mac'},201)
  const profileId=created.profile.id as string, path=`/profiles/${profileId}`
  expect((await http<{profile:{name:string}}>(path,'PATCH',{name:'Named fixture Mac'})).profile.name).toBe('Named fixture Mac')
  const enabled=await http<{profile:unknown}>(`${path}/assistants/${a}`,'PATCH',{enabled:true,routingNote:'Synthetic AX only'})
  expect(enabled.profile).toMatchObject({enabledAssistantIds:[a],assistantRoutingNotes:{[a]:'Synthetic AX only'}})
  const {connectionId}=await http<{connectionId:string}>(`${path}/connect`,'POST',{workspaceId:w,deviceId:'synthetic-device'})
  const connection=async () => (await db.query('SELECT connection_id,connection_auth_session_id,device_id FROM computer_profiles WHERE id=$1',[profileId])).rows[0]
  const metadata=await connection()
  const act=(observationId:string, sessionId=chat) => tools.computerAct.execute({profile:profileId,observationId,action:{kind:'setValue',ref:'document',text:'Hello fixture'}},context(sessionId))
  const pending=await act('no-authority')
  expect(pending.data).toMatchObject({code:'local_consent_required'})
  expect((await tools.computerObserve.execute({profile:profileId},context())).data).toEqual(pending.data)
  expect((await act('no-authority',chat2)).data).toMatchObject({code:'busy'})
  expect(calls).toHaveLength(0)
  const polled=await http<{request:{id:string;requester:string}}>(`${path}/poll`,'POST',{connectionId})
  expect(polled.request).toMatchObject({id:(pending.data as {requestId:string}).requestId,conversationId:chat,assistantId:a,workspaceId:w})
  const verifier='v'.repeat(43)
  const accepted=await http<{identity:NativeProfileGrant['identity']}>(`${path}/requests/${polled.request.id}/accept`,'POST',{connectionId,challenge:createHash('sha256').update(verifier).digest('base64url')})
  const grant: NativeProfileGrant={protocol:'native-computer-v1',identity:accepted.identity,purpose:'chat-tools',grantId:uuid(),epoch:1,
    expiresAt:Date.now()+60_000,allowControl:true,allowCapture:false,requester:polled.request.requester,targets:[target]}
  expect(grant.identity).toMatchObject({profileId,conversationId:chat})
  expect(grant.identity).not.toHaveProperty('taskId')
  expect(grant).not.toHaveProperty('goal')
  await controller.start(grant)
  expect(approveGrant).toHaveBeenCalledOnce()
  const exchange=`/sessions/${grant.identity.sessionId}/exchange`
  await http(exchange,'POST',{verifier:'z'.repeat(43),grant},403)
  const paired=await http<{token:string;relayUrl:string}>(exchange,'POST',{verifier,grant})
  expect(verifyNativeToken(paired.token,secret)?.identity).toEqual(grant.identity)
  client=new NativeRelayClient(controller,grant.identity,url => new WebSocket(url) as unknown as globalThis.WebSocket)
  client.connect(paired.relayUrl,paired.token)
  await client.waitUntilReady(AbortSignal.timeout(2000))
  await vi.waitFor(() => expect(relay.status(grant.identity.sessionId).status?.state).toBe('active'))
  expect(calls).toHaveLength(0) // Consent never executes the previously proposed action.
  expect((await act('no-authority')).data).toEqual({code:'fresh_observation_required'})
  const observed=await tools.computerObserve.execute({profile:profileId},context())
  expect(observed.data).toMatchObject({outcome:'executed',nodes:[{value:''}]})
  const observationId=(observed.data as {observationId:string}).observationId
  expect((await act(observationId,chat2)).data).toMatchObject({code:'busy'})
  expect((await act(observationId)).data).toEqual({outcome:'executed',code:'ok'})
  expect((await act(observationId)).data).toEqual({code:'fresh_observation_required'})
  const readback=await tools.computerObserve.execute({profile:profileId},context())
  expect(readback.data).toMatchObject({outcome:'executed',nodes:[{value:'Hello fixture'}]})
  expect((readback.data as {observationId:string}).observationId).not.toBe(observationId)
  expect(calls.map(c => c.action.kind)).toEqual(['observe','setValue','observe'])
  expect(executionChecks).toBe(4)
  expect(effects).toBe(1)
  expect(approveAction).toHaveBeenCalledOnce()

  // A denied local proposal consumes the observation without an effect/replay.
  allowAction=false
  const readbackId=(readback.data as {observationId:string}).observationId
  expect((await act(readbackId)).data).toMatchObject({outcome:'not_executed'})
  expect((await act(readbackId)).data).toEqual({code:'fresh_observation_required'})
  expect(approveAction).toHaveBeenCalledTimes(2)
  expect(effects).toBe(1)
  expect(calls).toHaveLength(3)

  expect((await tools.computerRelease.execute({profile:profileId},context())).data).toEqual({code:'released'})
  await vi.waitFor(() => expect(controller.status().state).not.toBe('active'))
  expect(await connection()).toEqual(metadata)
  expect((await http<{profiles:unknown[]}>(`/profiles?workspaceId=${w}`)).profiles[0]).toMatchObject({connected:true})
  const old=(await db.query<{state:string;revoked_at:unknown}>('SELECT state,revoked_at FROM native_computer_sessions')).rows[0]
  expect(old.state).not.toBe('execution_unknown');expect(old.revoked_at).toBeTruthy()
  const again=await act(readbackId)
  expect(again.data).toMatchObject({code:'local_consent_required'})
  expect((again.data as {requestId:string}).requestId).not.toBe(polled.request.id)
  expect((await act(readbackId,chat2)).data).toMatchObject({code:'busy'})
  expect((await http<{request:{id:string;conversationId:string}}>(`${path}/poll`,'POST',{connectionId})).request.id).toBe((again.data as {requestId:string}).requestId)
  // Retire the unaccepted same-chat prompt; a different chat still needs consent.
  await http(`${path}/requests/${(again.data as {requestId:string}).requestId}/deny`,'POST',{connectionId})
  expect((await act(readbackId,chat2)).data).toMatchObject({code:'local_consent_required'})
  expect((await http<{request:{id:string;conversationId:string}}>(`${path}/poll`,'POST',{connectionId})).request.conversationId).toBe(chat2)
  expect(calls).toHaveLength(3);expect(effects).toBe(1)
  expect(approveGrant).toHaveBeenCalledOnce()
  expect((await db.query('SELECT * FROM tasks')).rows).toEqual([])
  expect(calls.every(c => 'profileId' in c.identity && !('taskId' in c.identity))).toBe(true)
},20_000)
