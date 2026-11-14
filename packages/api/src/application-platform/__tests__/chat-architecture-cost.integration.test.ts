/** Actual HTTP/database measurements, never a mocked source proof. [COMP:api/native-chat-read-cost] */
import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'
import pg from 'pg'
import express from 'express'
import request from 'supertest'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { boundScopeSources, type LLMProvider, type Message, type StreamChunk } from '@use-brian/core'
import { chatRoutes } from '../../routes/chat.js'
import { getAppPool, getPool } from '../../db/client.js'
import { authSessionStore } from '../../db/auth-session-store.js'
import { addSessionMessage, createPersonalWebSession } from '../../db/sessions.js'
import { readAdmittedSessionQuery } from '../../db/session-query-reader.js'
import { readRetainedContextFrame } from '../../db/session-context-revisions.js'
import { publishNativeSessionMessageBatch } from '../../db/session-message-publication.js'
import { createDbMemoryStore } from '../../db/memory-store.js'
import { createDbCapabilityStore } from '../../db/capability-store.js'
import { createPendingApprovalsStore } from '../../db/pending-approvals-store.js'
import { resolveSessionTitleAuthority } from '../../routes/session-title-authority.js'
import { readAttendedSessionHistory } from '../../routes/attended-session-context.js'
import { persistentContextFixture } from './fixtures/persistent-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

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

describe.sequential('[COMP:api/native-chat-read-cost] chat replacement baseline', () => {
  const results: unknown[] = []
  afterAll(async () => {
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
    const source = Object.fromEntries(await Promise.all(['packages/api/src', 'packages/core/src', 'packages/core/dist', 'packages/api/migrations']
      .map(async path => [path, await fingerprint(join(root, path))])))
    await writeFile(process.env.BRIAN_CHAT_COST_OUTPUT ?? '/tmp/brian-chat-cost.json', JSON.stringify({
      source, node: process.version, provider: 'deterministic, zero network latency',
      measurement: 'Foreground SQL calls include transaction/control statements; function stats exclude inlined SQL. No workers started.',
      results,
    }, null, 2))
    await getAppPool().end(); await getPool().end()
  })

  const scenarios = (['empty-private', 'populated-private', 'shared-room'] as const).flatMap(scenario =>
    (['legacy', 'department-v2'] as const).map(permissionModel => ({ scenario, permissionModel })))
  it.each(scenarios)('$scenario / $permissionModel', async ({ scenario, permissionModel }) => {
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
      if (scenario === 'populated-private') {
        const input = await addSessionMessage({ sessionId: session.id, role: 'user', content: [{ type: 'text', text: 'Remember the amber notebook.' }],
          senderUserId: f.ownerId, scope: { ...f.envelope, userId: f.ownerId } })
        const authority = await fresh()
        const history = await readAdmittedSessionQuery({ sessionId: session.id, throughSequence: input.sequenceNum, authority })
        retainedCoverage = await readRetainedContextFrame(authority, [], async client =>
          (await client.query('SELECT read_native_retained_scope_evidence($1,$2) AS value', [f.workspaceId,
            JSON.stringify(boundScopeSources(history).map(source => ({ kind: source.resourceKind, id: source.resourceId, version: source.version }))),
          ])).rows[0].value)
        retainedCoverage = { sourceKinds: [...new Set(boundScopeSources(history).map(source => source.resourceKind))], admitted: retainedCoverage !== null }
        await publishNativeSessionMessageBatch({ sessionId: session.id, authority, derivationTarget: { ...f.envelope, userId: f.ownerId },
          derivation: { producer: 'fixture:chat-cost', sources: boundScopeSources(history) },
          messages: [{ role: 'assistant', senderAssistantId: f.assistantId, content: [{ type: 'text', text: 'The notebook is amber.' }] }] })
      }
      await f.pool.query("UPDATE workspaces SET plan='pro' WHERE id=$1", [f.workspaceId])
      const calls: Message[][] = []
      const reply = 'The amber notebook is ready. We can continue our discussion with the earlier details kept in this conversation for you.'
      const chunks = (text: string): StreamChunk[] => [{ type: 'message_start', model: 'fixture' },
        ...text.split(' ').map((word, i) => ({ type: 'text_delta' as const, text: (i ? ' ' : '') + word })),
        { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 20 } }]
      const provider: LLMProvider = { name: 'fictional-cost', models: ['fixture'],
        stream: async function* () { yield* chunks('Fictional notebook discussion') },
        createSession() { return { send(messages) { calls.push(structuredClone(messages)); return (async function* () { yield* chunks(reply) })() } } },
      }
      const app = express(); app.use(express.json()); app.use((req, _res, next) => {
        req.userId = f.ownerId; req.authSessionId = device.id; req.authVersion = device.authVersion; next()
      })
      app.use('/chat', chatRoutes({ provider, systemPrompt: 'Continue the fictional conversation.', tools: new Map(),
        memoryStore: createDbMemoryStore(), capabilityStore: createDbCapabilityStore(), pendingApprovalsStore: createPendingApprovalsStore() }))
      const before = await functionStats()
      let queries = 0, queryMs = 0, poolWaitMs = 0, checkouts = 0, firstTextMs: number | undefined
      const queryWork = new Map<string, { shape: string; calls: number; elapsedMs: number }>()
      const originalQuery = pg.Client.prototype.query
      const originalConnect = pg.Pool.prototype.connect
      // Preserve both callback and promise overloads. Record statement shape
      // without parameter values or SQL literals, only in this synthetic rig.
      const querySpy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (this: pg.Client, ...args: unknown[]) {
        queries++; const start = performance.now()
        const sql = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string })?.text ?? ''
        const shape = sql.replace(/'(?:[^']|'')*'/g, '?').replace(/\$\d+/g, '?').replace(/\s+/g, ' ').trim()
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
        if (typeof callback === 'function') args[0] = (...values: unknown[]) => { poolWaitMs += performance.now() - start; callback(...values) }
        const result = Reflect.apply(originalConnect, this, args)
        if (result && typeof result.finally === 'function') return result.finally(() => { poolWaitMs += performance.now() - start })
        return result
      } as typeof originalConnect)
      const start = performance.now()
      let body = ''
      let response: Awaited<ReturnType<ReturnType<typeof request>['post']>>
      try {
        response = await request(app).post('/chat').send({ sessionId: session.id, assistantId: f.assistantId, workspaceId: f.workspaceId,
          message: 'Which notebook did we choose earlier?', mode: 'default', model: 'pro' }).buffer(true).parse((res, done) => {
          res.on('data', (chunk: Buffer) => { body += chunk.toString(); if (firstTextMs === undefined && body.includes('event: text_delta')) firstTextMs = performance.now() - start })
          res.on('end', () => done(null, body)); res.on('error', done)
        })
      } finally { querySpy.mockRestore(); poolSpy.mockRestore() }
      const elapsedMs = performance.now() - start
      const after = await functionStats()
      const functions = [...after.values()].map(row => { const prior = before.get(row.name); return { name: row.name,
        calls: row.calls - (prior?.calls ?? 0), totalMs: row.totalMs - (prior?.totalMs ?? 0), selfMs: row.selfMs - (prior?.selfMs ?? 0) }
      }).filter(row => row.calls > 0).sort((a, b) => b.selfMs - a.selfMs)
      const metrics = { scenario, permissionModel, elapsedMs, firstTextMs, queries, queryMs, poolWaitMs, checkouts, retainedCoverage,
        outputEvents: (body.match(/event: text_delta/g) ?? []).length, functionCalls: functions.reduce((sum, row) => sum + row.calls, 0), functions,
        queryWork: [...queryWork.values()].sort((a, b) => b.calls - a.calls) }
      results.push(metrics)
      console.info('chat-cost', JSON.stringify({ ...metrics, queryWork: undefined, functions: functions.slice(0, 5) }))
      expect(metrics.queryWork.reduce((sum, work) => sum + work.calls, 0)).toBe(queries)
      expect(response.status).toBe(200); expect(body).not.toContain('event: error'); expect(firstTextMs).toBeDefined()
      if (scenario === 'populated-private') expect(JSON.stringify(calls[0])).toContain('The notebook is amber.')
      const saved = await readAttendedSessionHistory(await fresh(), session.id)
      expect(saved.at(-1)?.content).toEqual([{ type: 'text', text: reply }])
    } finally { await f.cleanup() }
  }, 120_000)
})
