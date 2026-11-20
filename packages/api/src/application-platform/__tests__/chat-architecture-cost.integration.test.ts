/** Actual HTTP/database measurements, never a mocked source proof. [COMP:api/native-chat-read-cost] */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFile, readFile, readdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'
import pg from 'pg'
import express from 'express'
import request from 'supertest'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { LLMProvider, Message, StreamChunk } from '@use-brian/agent-runtime/providers/types.js'
import { boundScopeSources } from '@use-brian/agent-runtime/security/source-evidence.js'
import { chatRoutes } from '../../routes/chat.js'
import { getAppPool, getPool } from '../../db/client.js'
import { conversationReadersActive, initializeConversationVisibility } from '../../db/conversation-visibility.js'
import { authSessionStore } from '../../db/auth-session-store.js'
import { addSessionMessage, createPersonalWebSession } from '../../db/sessions.js'
import { readAdmittedSessionQuery } from '../../db/conversation-store.js'
import { readRetainedContextFrame } from '../../db/session-context-revisions.js'
import { publishNativeSessionMessageBatch } from '../../db/conversation-store.js'
import { createDbMemoryStore } from '../../db/memory-store.js'
import { createDbCapabilityStore } from '../../db/capability-store.js'
import { createPendingApprovalsStore } from '../../db/pending-approvals-store.js'
import { resolveSessionTitleAuthority } from '../../routes/session-title-authority.js'
import { readAttendedSessionHistory } from '../../routes/attended-session-context.js'
import { persistentContextFixture } from './fixtures/persistent-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
await initializeConversationVisibility()
const nativeReaders = conversationReadersActive()
if (process.env.BRIAN_CHAT_COST_NATIVE_READERS === '1' && !nativeReaders)
  throw new Error('The executor inventory requires numbered native conversation readers')

const root = fileURLToPath(new URL('../../../../../', import.meta.url))
async function fingerprint(directory: string): Promise<string> {
  const hash = createHash('sha256')
  async function visit(path: string): Promise<void> {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) await visit(child)
      else if (entry.isFile()) { hash.update(relative(directory, child)); hash.update(await readFile(child)) }
    }
  }
  await visit(directory)
  return hash.digest('hex')
}

type FunctionStat = { name: string; calls: number; totalMs: number; selfMs: number }
async function functionStats(): Promise<Map<string, FunctionStat>> {
  for (const pool of [getPool(), getAppPool()]) {
    const clients = await Promise.all(Array.from({ length: Math.max(1, pool.totalCount) }, () => pool.connect()))
    try { await Promise.all(clients.map(client => client.query('SELECT pg_stat_force_next_flush()'))) }
    finally { clients.forEach(client => client.release()) }
  }
  await getPool().query('SELECT pg_stat_clear_snapshot()')
  const { rows } = await getPool().query<FunctionStat>(`SELECT funcid::regprocedure::text AS name,
    calls::integer, total_time AS "totalMs", self_time AS "selfMs" FROM pg_stat_user_functions`)
  return new Map(rows.map(row => [row.name, row]))
}

// The observer has no product authority and never runs inside a measured request.
// Track=all includes SQL executed by SQL/PLpgSQL functions and RLS policies.
type StatementStat={key:string;queryId:string;topLevel:boolean;shape:string;calls:number;rows:number;execMs:number;sharedHits:number;sharedReads:number;tempReads:number;tempWrites:number}
async function statementStats():Promise<{dealloc:string;reset:string;statements:StatementStat[]}|undefined>{
 if(process.env.BRIAN_ASSURANCE_STATEMENT_STATS!=='true')return undefined
 const marker=JSON.parse(await readFile(process.env.BRIAN_ASSURANCE_FIXTURE!,'utf8')) as {bootstrapRole?:string}
 if(!marker.bootstrapRole)throw new Error('Nested SQL requires the disposable bootstrap observer')
 const url=new URL(process.env.DATABASE_URL!);url.username=marker.bootstrapRole
 const admin=new pg.Client({connectionString:url.href});await admin.connect()
 try{
  const state=(await admin.query<{track:string;dealloc:string;reset:string}>(`/* chat-cost-observer */ SELECT current_setting('pg_stat_statements.track') AS track,
   dealloc::text,stats_reset::text AS reset FROM pg_stat_statements_info`)).rows[0]
  if(state?.track!=='all')throw new Error('Nested SQL tracking is incomplete')
  const rows=(await admin.query<StatementStat>(`/* chat-cost-observer */ SELECT userid||':'||dbid||':'||queryid||':'||toplevel AS key,
   queryid::text AS "queryId",toplevel AS "topLevel",query AS shape,calls::float8,rows::float8,total_exec_time AS "execMs",
   shared_blks_hit::float8 AS "sharedHits",shared_blks_read::float8 AS "sharedReads",temp_blks_read::float8 AS "tempReads",temp_blks_written::float8 AS "tempWrites"
   FROM pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database())
    AND query NOT LIKE '/* chat-cost-observer */%'`)).rows
  return{dealloc:state.dealloc,reset:state.reset,statements:rows.map(row=>({...row,shape:row.shape.replace(/'(?:[^']|'')*'/g,'?').replace(/\$\d+/g,'?').replace(/\s+/g,' ').trim()}))}
 }finally{await admin.end()}
}
function statementDelta(before:Awaited<ReturnType<typeof statementStats>>,after:Awaited<ReturnType<typeof statementStats>>){
 if(!before&&!after)return undefined
 if(!before||!after||before.dealloc!==after.dealloc||before.reset!==after.reset)throw new Error('Nested SQL statistics changed or evicted entries')
 const prior=new Map(before.statements.map(row=>[row.key,row]))
 const counters=['calls','rows','execMs','sharedHits','sharedReads','tempReads','tempWrites'] as const
 const statements=after.statements.map(row=>({...row,...Object.fromEntries(counters.map(key=>[key,row[key]-(prior.get(row.key)?.[key]??0)]))}))
  .filter(row=>row.calls>0)
 if(statements.some(row=>counters.some(key=>row[key]<0)))throw new Error('Nested SQL statistics reset during request')
 const sum=(topLevel:boolean)=>Object.fromEntries(counters.map(key=>[key,statements.filter(row=>row.topLevel===topLevel).reduce((n,row)=>n+row[key],0)]))
 return{topLevel:sum(true),nested:sum(false),statements:statements.sort((a,b)=>b.calls-a.calls),
  limitation:'Nested SQL statements and rows/buffer activity, not complete physical permission units. Inclusive execution times overlap and are not wall time.'}
}

// One-lookup workload (M6 row A8): one catalog call on the folded web surface,
// `mcp_call` to the introspection lane's `listPendingApprovals`, which makes one
// RLS-gated read of the fixture database through the real pending-approvals
// store (no connector network, no external dependency). A fresh workspace has
// no pending approvals, so the tool result text is fixed.
const LOOKUP = { id: 'fictional-lookup-call', server: 'introspection', tool: 'listPendingApprovals',
  result: 'No approvals are pending in this workspace.' } as const
type LookupCounter = { calls: number; statements: number; current: () => number }
async function lookupCatalog(counter: LookupCounter) {
  const [{ createDbConnectorStore }, { createDbMcpSettingsStore }, { createIntrospectionTools }] = await Promise.all([
    import('../../db/connector-store.js'), import('../../db/mcp-settings-store.js'), import('@use-brian/core/introspection/tools.js')])
  const approvals = createPendingApprovalsStore()
  const unused = () => { throw new Error('The one-lookup fixture offers listPendingApprovals only') }
  const deps = {
    pendingApprovals: { async listPendingForWorkspace(userId: string, workspaceId: string) {
      counter.calls++; const before = counter.current()
      try { return await approvals.listPendingForWorkspace(userId, workspaceId) } finally { counter.statements += counter.current() - before }
    } },
    scheduledJobs: { search: unused }, workerRuns: { listRecentForWorkspace: unused },
    sessionHistory: { listSessionsForWorkspaceSystem: unused, getSessionTranscriptForWorkspaceSystem: unused },
  } as unknown as Parameters<typeof createIntrospectionTools>[0]
  // The catalog needs both connector stores to compose the web surface at all.
  return { connectorStore: createDbConnectorStore(randomBytes(32)), mcpSettingsStore: createDbMcpSettingsStore(),
    introspectionTools: createIntrospectionTools(deps).filter(tool => tool.name === LOOKUP.tool) }
}

describe.sequential('[COMP:api/native-chat-read-cost] chat replacement baseline', () => {
  const results: unknown[] = []
  afterAll(async () => {
    // The installed executable schema can differ from migration files during
    // a disposable architectural prototype. Bind measurements to what ran.
    const database = (await getPool().query<{ fingerprint: string }>(`SELECT encode(sha256(convert_to(
      jsonb_agg(to_jsonb(p) ORDER BY p.oid::regprocedure::text)::text,'UTF8')),'hex') AS fingerprint
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.prokind='f'`)).rows[0]
    if (process.env.BRIAN_CHAT_COST_CATALOG) {
      const functions = (await getPool().query(`SELECT p.oid::regprocedure::text AS signature,
        r.rolname AS owner,p.prosecdef AS definer,p.provolatile AS volatility,p.proacl::text AS grants,
        md5(pg_get_functiondef(p.oid)) AS definition_hash,
        ARRAY(SELECT pg_describe_object(d.classid,d.objid,d.objsubid) FROM pg_depend d
          WHERE d.refclassid='pg_proc'::regclass AND d.refobjid=p.oid ORDER BY 1) AS stored_dependents
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
        WHERE n.nspname='public' AND p.prokind='f' AND
          (p.proname LIKE '%native%' OR p.proname LIKE '%session%' OR p.proname LIKE '%scope%')
        ORDER BY 1`)).rows
      await writeFile(process.env.BRIAN_CHAT_COST_CATALOG, JSON.stringify({
        limitation: 'pg_depend excludes many PL/pgSQL body and dynamic-SQL calls. Review source callers before deleting any function.', functions,
      }, null, 2))
    }
    const source = Object.fromEntries(await Promise.all(['packages/api/src', 'packages/agent-runtime/src', 'packages/agent-runtime/dist', 'packages/core/src', 'packages/core/dist', 'packages/api/migrations']
      .map(async path => [path, await fingerprint(join(root, path))])))
    const roles = await Promise.all([getPool(),getAppPool()].map(async pool =>
      (await pool.query(`SELECT rolname AS name,rolsuper AS superuser,rolbypassrls AS bypass
        FROM pg_roles WHERE rolname=session_user`)).rows[0]))
    const attestation = process.env.BRIAN_CHAT_COST_PRIMITIVE_ATTESTATION === '1' ? {
      installedMigrations: (await getPool().query<{name: string}>('SELECT name FROM public._migrations ORDER BY name')).rows.map(row => row.name),
      releaseRoutines: (await getPool().query(`SELECT p.oid::regprocedure::text AS signature, roles.rolname AS owner,
          p.prosecdef AS definer, p.proacl::text AS grants,
          encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') AS sha256
        FROM pg_proc p JOIN pg_roles roles ON roles.oid=p.proowner
        WHERE p.pronamespace='public'::regnamespace AND p.proname=ANY($1::text[]) ORDER BY signature`, [[
        'admit_native_turn_conversation_records', 'capture_native_turn_conversation_record', 'capture_conversation_evidence',
      ]])).rows,
    } : undefined
    await writeFile(process.env.BRIAN_CHAT_COST_OUTPUT ?? '/tmp/brian-chat-cost.json', JSON.stringify({
      ...(tool ? { tool } : {}), source, fixture: createHash('sha256').update(await readFile(join(root,'scripts/crm/local-fixture.mjs'))).digest('hex'), database, roles:{system:roles[0],application:roles[1]}, node: process.version, provider: 'deterministic, zero network latency', nativeReaders,
      ...(attestation ? { attestation } : {}),
      measurement: 'Fixed-frame runs pace provider text on actual client receipt; fragment runs allow bounded read-ahead. Foreground SQL calls include transaction/control statements; function stats exclude inlined SQL. No workers started.',
      results,
    }, null, 2))
    await getAppPool().end(); await getPool().end()
  })

  const fragments=process.env.BRIAN_CHAT_COST_FRAGMENTS===undefined?undefined:Number(process.env.BRIAN_CHAT_COST_FRAGMENTS)
  if(fragments!==undefined&&![20,200,2000].includes(fragments))throw new Error('Cost fixture fragmentation must be 20, 200 or 2000')
  // `lookup`: the one-lookup workload. `catalog`: the same catalog wiring with
  // no call, which separates catalog preparation from the call. Unset: the
  // original no-tool workload, unchanged (no catalog stores, no tools).
  const tool=process.env.BRIAN_CHAT_COST_TOOL as 'lookup'|'catalog'|undefined
  if(tool!==undefined&&tool!=='lookup'&&tool!=='catalog')throw new Error('Cost fixture tool mode must be lookup or catalog')
  if(tool!==undefined&&fragments!==undefined)throw new Error('The one-lookup workload uses fixed frames only')
  const samples=Number(process.env.BRIAN_CHAT_COST_SAMPLES??'1')
  if(!Number.isInteger(samples)||samples<1||samples>31)throw new Error('Cost fixture samples must be an integer from 1 to 31')
  const retainedMessages=process.env.BRIAN_CHAT_COST_MESSAGES===undefined?undefined:Number(process.env.BRIAN_CHAT_COST_MESSAGES)
  const retainedDependencies=process.env.BRIAN_CHAT_COST_DEPENDENCIES===undefined?undefined:Number(process.env.BRIAN_CHAT_COST_DEPENDENCIES)
  const scaling=retainedMessages!==undefined||retainedDependencies!==undefined
  if(scaling&&(![10,100,1000].includes(retainedMessages!)||![1,10,100].includes(retainedDependencies!)||samples!==1||fragments!==undefined||tool!==undefined))throw new Error('Scaling requires messages10/100/1000,dependencies1/10/100,one sample and the fixed no-tool workload')
  const scenarios = scaling ? [{scenario:'populated-private' as const,permissionModel:'department-v2' as const,sample:0}] : Array.from({length:samples},(_,sample)=>(['empty-private', 'populated-private', 'shared-room'] as const).flatMap(scenario =>
    (['legacy', 'department-v2'] as const).map(permissionModel => ({ scenario, permissionModel, sample })))).flat()
  it.each(scenarios)('$scenario / $permissionModel / sample $sample', async ({ scenario, permissionModel, sample }) => {
    // Only the verified disposable bootstrap may enable observation. Actual
    // requests still use the ordinary owner and the non-owner app_user roles.
    const marker = JSON.parse(await readFile(process.env.BRIAN_ASSURANCE_FIXTURE!, 'utf8')) as { bootstrapRole?: string }
    const url = new URL(process.env.DATABASE_URL!)
    if (marker.bootstrapRole) url.username = marker.bootstrapRole
    const admin = new pg.Client({ connectionString: url.href })
    await admin.connect()
    try {
      await admin.query("ALTER ROLE app_user SET track_functions='all'")
      await admin.query("ALTER ROLE assurance_owner SET track_functions='all'")
    } finally { await admin.end() }
    const f = await persistentContextFixture('confidential')
    try {
      await f.pool.query('UPDATE workspaces SET department_read_v2=$2 WHERE id=$1', [f.workspaceId, permissionModel === 'department-v2'])
      const device = (await authSessionStore.create(f.ownerId, { deviceLabel: 'Fictional cost browser', userAgent: null, ipAddress: null }))!
      const claims = { userId: f.ownerId, sessionId: device.id, authVersion: device.authVersion }
      const session = scenario === 'shared-room' ? f.session : await createPersonalWebSession({
        assistantId: f.assistantId, userId: f.ownerId, workspaceId: f.workspaceId, channelType: 'web', channelId: randomUUID(), appOrigin: 'chat',
      }, { actorUserId: f.ownerId, authSessionId: device.id, authVersion: device.authVersion })
      const fresh = () => resolveSessionTitleAuthority({ claims, sessionId: session.id, readOnly: false })
      let retainedCoverage: unknown
      let scalingFixture: { retainedMessages: number; dependencyCaptures: number; durableRetainedMessages: number; seedMs: number } | undefined
      if (scaling) {
        const seededAt=performance.now(),sources:Array<ReturnType<typeof boundScopeSources>[number]>=[]
        // Each dependency is a genuinely separate private transcript captured by
        // the canonical reader, rather than duplicated source metadata.
        for(let dependency=0;dependency<retainedDependencies!;dependency++){
          const sourceSession=await createPersonalWebSession({assistantId:f.assistantId,userId:f.ownerId,workspaceId:f.workspaceId,
            channelType:'web',channelId:randomUUID(),appOrigin:'chat'}, {actorUserId:f.ownerId,authSessionId:device.id,authVersion:device.authVersion})
          const authored=await addSessionMessage({sessionId:sourceSession.id,role:'user',senderUserId:f.ownerId,
            content:[{type:'text',text:`Fictional distinct scaling dependency ${dependency}.`}],scope:{...f.envelope,userId:f.ownerId}})
          const sourceAuthority=await resolveSessionTitleAuthority({claims,sessionId:sourceSession.id,readOnly:false})
          const sourceHistory=await readAdmittedSessionQuery({sessionId:sourceSession.id,throughSequence:authored.sequenceNum,authority:sourceAuthority})
          sources.push(...boundScopeSources(sourceHistory))
        }
        const distinct=new Set(sources.map(source=>`${source.resourceKind}:${source.resourceId}:${source.version}`))
        expect(distinct.size).toBe(retainedDependencies)
        // Preserve the canonical writer's 512-row admission limit. Each batch
        // obtains current authority; the original dependency captures remain
        // genuine source evidence and are independently revalidated by writes.
        for(let offset=0;offset<retainedMessages!;offset+=512){
          await publishNativeSessionMessageBatch({sessionId:session.id,authority:await fresh(),derivationTarget:{...f.envelope,userId:f.ownerId},
            derivation:{producer:'fixture:chat-scaling',sources},messages:Array.from({length:Math.min(512,retainedMessages!-offset)},(_,index)=>({role:'assistant' as const,
              senderAssistantId:f.assistantId,content:[{type:'text' as const,text:`Fictional retained scaling message ${offset+index}.`}]}))})
        }
        const reopened=(await readAttendedSessionHistory(await fresh(),session.id)).messages
        expect(reopened).toHaveLength(retainedMessages!)
        expect(reopened.map(message=>message.sequenceNum)).toEqual(Array.from({length:retainedMessages!},(_,index)=>index+1))
        expect(JSON.stringify(reopened[0]?.content)).toContain('Fictional retained scaling message 0.')
        expect(JSON.stringify(reopened.at(-1)?.content)).toContain(`Fictional retained scaling message ${retainedMessages!-1}.`)
        scalingFixture={retainedMessages:retainedMessages!,dependencyCaptures:distinct.size,durableRetainedMessages:reopened.length,seedMs:Math.round(performance.now()-seededAt)}
      } else if (scenario === 'populated-private') {
        const input = await addSessionMessage({ sessionId: session.id, role: 'user', content: [{ type: 'text', text: 'Remember the amber notebook.' }],
          senderUserId: f.ownerId, scope: { ...f.envelope, userId: f.ownerId } })
        const authority = await fresh()
        const history = await readAdmittedSessionQuery({ sessionId: session.id, throughSequence: input.sequenceNum, authority })
        retainedCoverage = await readRetainedContextFrame(authority, [], async client =>
          (await client.query('SELECT capture_conversation_evidence($1,$2) AS value', [f.workspaceId,
            JSON.stringify(boundScopeSources(history).map(source => ({ kind: source.resourceKind, id: source.resourceId, version: source.version }))),
          ])).rows[0].value)
        retainedCoverage = { sourceKinds: [...new Set(boundScopeSources(history).map(source => source.resourceKind))], admitted: retainedCoverage !== null }
        await publishNativeSessionMessageBatch({ sessionId: session.id, authority, derivationTarget: { ...f.envelope, userId: f.ownerId },
          derivation: { producer: 'fixture:chat-cost', sources: boundScopeSources(history) },
          messages: [{ role: 'assistant', senderAssistantId: f.assistantId, content: [{ type: 'text', text: 'The notebook is amber.' }] }] })
      }
      await f.pool.query("UPDATE workspaces SET plan='pro' WHERE id=$1", [f.workspaceId])
      const staleRoom=process.env.BRIAN_CHAT_COST_STALE_ROOM==='1'&&scenario==='shared-room'
      if(staleRoom)await f.pool.query("UPDATE sessions SET status='running',turn_lease_token=gen_random_uuid(),turn_heartbeat_at=now()-interval '2 minutes' WHERE id=$1",[session.id])
      const recoveryEvents:unknown[]=[]
      const calls: Message[][] = []
      const sentence = 'The amber notebook is ready. We can continue our discussion with the earlier details kept in this conversation for you.'
      // Fragment scaling keeps exactly the same bytes at every setting. The
      // ordinary before/after fixture retains its original short reply.
      const reply = fragments===undefined?sentence:Array(20).fill(sentence).join(' ')
      const chunks = (text: string, count?:number): StreamChunk[] => [{ type: 'message_start', model: 'fixture' },
        ...(count===undefined?text.split(' ').map((word,i)=>(i?' ':'')+word)
          :Array.from({length:count},(_,i)=>text.slice(Math.floor(i*text.length/count),Math.floor((i+1)*text.length/count))))
          .map(text=>({type:'text_delta' as const,text})),
        { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 20 } }]
      // Fixed-frame qualification advances only after the client receives each
      // text frame. Fragment scaling instead exercises unrestricted read-ahead.
      let delivered = 0
      let notifyDelivery: (() => void) | undefined
      const waitForDelivery = (count: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
        const finish = () => {
          if (delivered < count && !signal?.aborted) return
          signal?.removeEventListener('abort', finish)
          notifyDelivery = undefined
          if (signal?.aborted) reject(signal.reason)
          else resolve()
        }
        notifyDelivery = finish
        signal?.addEventListener('abort', finish, { once: true })
        finish()
      })
      const lookupCounter: LookupCounter = { calls: 0, statements: 0, current: () => queries }
      const catalog = tool === undefined ? undefined : await lookupCatalog(lookupCounter)
      const offered: string[][] = []
      const lookupChunks: StreamChunk[] = [{ type: 'message_start', model: 'fixture' }, { type: 'tool_use_start', id: LOOKUP.id, name: 'mcp_call' },
        { type: 'tool_use_delta', id: LOOKUP.id, input: JSON.stringify({ server: LOOKUP.server, tool: LOOKUP.tool, args: {} }) },
        { type: 'tool_use_end', id: LOOKUP.id }, { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } }]
      const provider: LLMProvider = { name: 'fictional-cost', models: ['fixture'],
        stream: async function* () { yield* chunks('Fictional notebook discussion') },
        createSession(sessionOptions) { if (tool) offered.push((sessionOptions.tools ?? []).map(offer => offer.name)); return { send(messages, options) {
          calls.push(structuredClone(messages))
          // One-lookup: the first round is the single catalog call, the next the 20 frames.
          if (tool === 'lookup' && calls.length === 1) return (async function* () { yield* lookupChunks })()
          return (async function* () {
            let count = 0
            for (const chunk of chunks(reply, fragments)) {
              yield chunk
              if (fragments === undefined && chunk.type === 'text_delta') await waitForDelivery(++count, options?.signal)
            }
          })()
        } } },
      }
      const app = express(); app.use(express.json()); app.use((req, _res, next) => {
        req.userId = f.ownerId; req.authSessionId = device.id; req.authVersion = device.authVersion; next()
      })
      app.use('/chat', chatRoutes({ provider, systemPrompt: 'Continue the fictional conversation.', tools: new Map(),
        publishSessionEvent:event=>{if(event.kind==='turn_completed'&&event.payload.reason==='stalled_reclaimed')recoveryEvents.push(event)},
        memoryStore: createDbMemoryStore(), capabilityStore: createDbCapabilityStore(), pendingApprovalsStore: createPendingApprovalsStore(), ...(catalog ?? {}) }))
      const before = await functionStats()
      const statementsBefore=await statementStats()
      let queries = 0, queryMs = 0, poolWaitMs = 0, checkouts = 0, firstTextMs: number | undefined
      const traceCallers = process.env.BRIAN_CHAT_COST_CALLERS === '1'
      const priorStackLimit = Error.stackTraceLimit
      if (traceCallers) Error.stackTraceLimit = 40
      const queryCallers = new Map<string, { shape: string; stack: string; calls: number }>()
      const queryWork = new Map<string, { shape: string; calls: number; elapsedMs: number }>()
      const poolSubmission = traceCallers ? new AsyncLocalStorage<{ stack: string; awaitingConnect: boolean; dispatching: boolean }>() : undefined
      const callerStack = () => (new Error().stack ?? '').split('\n').slice(1)
        .filter(line => !line.includes('node_modules') && !line.includes('node:'))
        .join('\n').replaceAll(root, '<oss>/')
      const originalQuery = pg.Client.prototype.query
      const originalPoolQuery = pg.Pool.prototype.query
      const originalConnect = pg.Pool.prototype.connect
      // Pool checkout may run from another request's release callback. Retain
      // the submitting stack, then bind only its synchronous client dispatch.
      const poolQuerySpy = traceCallers ? vi.spyOn(pg.Pool.prototype, 'query').mockImplementation(function (this: pg.Pool, ...args: unknown[]) {
        return poolSubmission!.run({ stack: callerStack(), awaitingConnect: true, dispatching: false }, () => Reflect.apply(originalPoolQuery, this, args))
      } as typeof originalPoolQuery) : undefined
      // Preserve both callback and promise overloads. Record statement shape
      // without parameter values or SQL literals, only in this synthetic rig.
      const querySpy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (this: pg.Client, ...args: unknown[]) {
        queries++; const start = performance.now()
        const sql = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string })?.text ?? ''
        const shape = sql.replace(/'(?:[^']|'')*'/g, '?').replace(/\$\d+/g, '?').replace(/\s+/g, ' ').trim()
        if (traceCallers) {
          const submission = poolSubmission!.getStore()
          const stack = submission?.dispatching ? submission.stack : callerStack()
          const key = JSON.stringify([shape, stack])
          const caller = queryCallers.get(key) ?? { shape, stack, calls: 0 }
          caller.calls++; queryCallers.set(key, caller)
        }
        const work = queryWork.get(shape) ?? { shape, calls: 0, elapsedMs: 0 }
        work.calls++; queryWork.set(shape, work)
        const finish = () => { const elapsed = performance.now() - start; queryMs += elapsed; work.elapsedMs += elapsed }
        const callback = args.at(-1)
        if (typeof callback === 'function') args[args.length - 1] = (...values: unknown[]) => { finish(); callback(...values) }
        const result = Reflect.apply(originalQuery, this, args)
        if (result && typeof result.finally === 'function') return result.finally(finish)
        return result
      } as typeof originalQuery)
      const poolSpy = vi.spyOn(pg.Pool.prototype, 'connect').mockImplementation(function (this: pg.Pool, ...args: unknown[]) {
        checkouts++; const start = performance.now(), callback = args[0]
        const context = poolSubmission?.getStore()
        const submission = context?.awaitingConnect ? context : undefined
        if (submission) submission.awaitingConnect = false
        if (typeof callback === 'function') args[0] = function (this: unknown, ...values: unknown[]) {
          poolWaitMs += performance.now() - start
          if (!submission) return Reflect.apply(callback, this, values)
          submission.dispatching = true
          try { return poolSubmission!.run(submission, () => Reflect.apply(callback, this, values)) }
          finally { submission.dispatching = false }
        }
        const result = Reflect.apply(originalConnect, this, args)
        if (result && typeof result.finally === 'function') return result.finally(() => { poolWaitMs += performance.now() - start })
        return result
      } as typeof originalConnect)
      const turnTimings:Record<string,number>={},originalLog=console.log.bind(console)
      const timingSpy=vi.spyOn(console,'log').mockImplementation((...values:unknown[])=>{
        originalLog(...values)
        for(const value of values)if(typeof value==='string'&&value.startsWith(`[chat] turn timings session ${session.id} `)){
          for(const match of value.matchAll(/\b([a-z_]+)=(\d+(?:\.\d+)?)/g))turnTimings[match[1]]=Number(match[2])
        }
      })
      const start = performance.now()
      const primitiveOutput = process.env.BRIAN_CHAT_COST_PRIMITIVE_OUTPUT
      if (primitiveOutput) await writeFile(primitiveOutput, '')
      let body = ''
      let response: Awaited<ReturnType<ReturnType<typeof request>['post']>>
      try {
        response = await request(app).post('/chat').send({ sessionId: session.id, assistantId: f.assistantId, workspaceId: f.workspaceId,
          message: 'Which notebook did we choose earlier?', mode: 'default', model: 'pro' }).buffer(true).parse((res, done) => {
          res.on('data', (chunk: Buffer) => {
            body += chunk.toString()
            delivered = (body.match(/event: text_delta/g) ?? []).length
            if (firstTextMs === undefined && delivered) firstTextMs = performance.now() - start
            notifyDelivery?.()
          })
          res.on('end', () => done(null, body)); res.on('error', done)
        })
      } finally { querySpy.mockRestore(); poolSpy.mockRestore(); poolQuerySpy?.mockRestore(); poolSubmission?.disable(); timingSpy.mockRestore(); Error.stackTraceLimit = priorStackLimit }
      const elapsedMs = performance.now() - start
      if (primitiveOutput) await appendFile(primitiveOutput, JSON.stringify({ windowEnd: new Date().toISOString(), foregroundStatements: queries }) + '\n')
      const nestedSql=statementDelta(statementsBefore,await statementStats())
      const after = await functionStats()
      const functions = [...after.values()].map(row => { const prior = before.get(row.name); return { name: row.name,
        calls: row.calls - (prior?.calls ?? 0), totalMs: row.totalMs - (prior?.totalMs ?? 0), selfMs: row.selfMs - (prior?.selfMs ?? 0) }
      }).filter(row => row.calls > 0).sort((a, b) => b.selfMs - a.selfMs)
      const metrics = { scenario, permissionModel, sample, nestedSql, warmup:samples>1&&sample===0, providerTextChunks:fragments??reply.split(' ').length, outputBytes:Buffer.byteLength(reply), turnTimings, verified: false, elapsedMs, firstTextMs, queries, queryMs, poolWaitMs, checkouts, retainedCoverage,
        receivedTextSha256: undefined as string | undefined, savedTextSha256: undefined as string | undefined,
        ...(primitiveOutput ? { primitiveOutput, primitiveScope: 'Fixture executor query inventory through HTTP completion; incomplete coverage never qualifies physical work; instrumented latency is diagnostic only' } : {}),
        ...(scalingFixture?{scaling:{...scalingFixture,providerRetainedMessages:new Set([...JSON.stringify(calls[0]).matchAll(/Fictional retained scaling message (\d+)\./g)].map(match=>match[1])).size}}:{}),
        outputEvents: (body.match(/event: text_delta/g) ?? []).length, functionCalls: functions.reduce((sum, row) => sum + row.calls, 0), functions,
        queryWork: [...queryWork.values()].sort((a, b) => b.calls - a.calls),
        ...(tool ? { workload: tool === 'lookup' ? 'one-lookup' : 'catalog-no-call', lookup: { call: tool === 'lookup' ? { name: 'mcp_call', server: LOOKUP.server, tool: LOOKUP.tool } : null,
          calls: lookupCounter.calls, statements: lookupCounter.statements, providerRounds: calls.length, catalogPairOffered: offered[0]?.includes('mcp_call') === true,
          connectorNetwork: 'none: the introspection lane reads the fixture database', deferredJobs: 'none: no workers started' } } : {}),
        ...(traceCallers ? { queryCallers: [...queryCallers.values()].sort((a, b) => b.calls - a.calls) } : {}) }
      results.push(metrics)
      if(staleRoom){
        expect(recoveryEvents).toHaveLength(1)
        // Lease ownership moved into its authenticated canonical native owner;
        // the old raw UPDATE is no longer a valid observation boundary.
        const claims=metrics.queryWork.filter(work=>work.shape.startsWith('SELECT native_session_turn_transition('))
        expect(claims.reduce((n,work)=>n+work.calls,0)).toBe(1)
        expect(metrics.queryWork.filter(work=>work.shape.startsWith('UPDATE sessions')&&work.shape.includes('turn_lease_token'))).toHaveLength(0)
      }
      expect(metrics.queryWork.reduce((sum, work) => sum + work.calls, 0)).toBe(queries)
      if (traceCallers) {
        expect([...queryCallers.values()].reduce((sum, caller) => sum + caller.calls, 0)).toBe(queries)
        for (const caller of queryCallers.values()) if (/capture_conversation_evidence|read_session_authority_facts/.test(caller.shape)) {
          expect(caller.stack).toMatch(/<oss>\/packages\/api\/src\/(?!application-platform\/__tests__\/)/)
        }
      }
      expect(response.status).toBe(200); expect(body).not.toContain('event: error'); expect(firstTextMs).toBeDefined(); expect(metrics.outputEvents).toBeGreaterThan(0); expect(metrics.outputEvents).toBeLessThanOrEqual(fragments??reply.split(' ').length); if (fragments===undefined) expect(metrics.outputEvents).toBe(reply.split(' ').length); expect(turnTimings.loop_started_at_ms).toBeGreaterThanOrEqual(0); expect(turnTimings.client_done_at_ms).toBeGreaterThan(0)
      for (const phase of ['publication_precommit_authority', 'publication_postcommit_authority', 'publication_after_commit_delivery']) {
        expect(turnTimings[`${phase}_count`]).toBe(1)
        expect(turnTimings[`${phase}_ms`]).toBeGreaterThanOrEqual(0)
      }
      const receivedText = body.split(/\r?\n\r?\n/).filter(frame => /^event: text_delta\r?$/m.test(frame))
        .map(frame => JSON.parse(frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart()).join('\n')) as {text:string})
        .map(event => event.text).join('')
      expect(receivedText).toBe(reply)
      if(scaling)expect(JSON.stringify(calls[0])).toContain(`Fictional retained scaling message ${retainedMessages!-1}.`)
      else if (scenario === 'populated-private') expect(JSON.stringify(calls[0])).toContain('The notebook is amber.')
      if (tool) expect(offered[0]).toContain('mcp_call')
      if (tool === 'lookup') {
        // Exactly one lookup ran, and its fixed result reached the provider's second round.
        expect(lookupCounter.calls).toBe(1); expect(calls).toHaveLength(2)
        expect(JSON.stringify(calls[1])).toContain(LOOKUP.id); expect(JSON.stringify(calls[1])).toContain(LOOKUP.result)
      } else if (tool === 'catalog') { expect(lookupCounter.calls).toBe(0); expect(calls).toHaveLength(1) }
      const saved = (await readAttendedSessionHistory(await fresh(), session.id)).messages
      const savedContent = saved.at(-1)?.content
      expect(savedContent).toEqual([{ type: 'text', text: reply }])
      metrics.receivedTextSha256 = createHash('sha256').update(receivedText).digest('hex')
      metrics.savedTextSha256 = createHash('sha256').update((savedContent as [{ text: string }])[0].text).digest('hex')
      metrics.verified = true
      console.info('chat-cost', JSON.stringify({ ...metrics, queryWork: undefined, nestedSql:nestedSql?{topLevel:nestedSql.topLevel,nested:nestedSql.nested}:undefined, functions: functions.slice(0, 5) }))
    } finally { await f.cleanup() }
  }, 120_000)
})
