/** Doc-thread per-turn cost (M6 row A11, M7 constant-cost criterion). [COMP:api/native-chat-read-cost]
 *
 * N sequential turns through the real chat route on a product-created Page
 * comment thread or a matched Room. Verify the persisted anchor and exact
 * streamed/reopened replies alongside the route's real authority timings.
 *
 *   BRIAN_DOC_THREAD_TURNS   turns (default 32)
 *   BRIAN_DOC_THREAD_OUTPUT  JSON output path (default /tmp/brian-doc-thread.json)
 *   BRIAN_DOC_THREAD_SURFACE page (default) or room
 */
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import pg from 'pg'
import express from 'express'
import request from 'supertest'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { LLMProvider, StreamChunk } from '@use-brian/agent-runtime/providers/types.js'
import { chatRoutes } from '../../routes/chat.js'
import { getAppPool, getPool } from '../../db/client.js'
import { authSessionStore } from '../../db/auth-session-store.js'
import { createDbCommentThreadStore } from '../../db/comment-thread-store.js'
import { readNativeConversationHistory } from '../../db/chat-presentation.js'
import { conversationReadersActive, initializeConversationVisibility } from '../../db/conversation-visibility.js'
import { createDbMemoryStore } from '../../db/memory-store.js'
import { createDbCapabilityStore } from '../../db/capability-store.js'
import { createPendingApprovalsStore } from '../../db/pending-approvals-store.js'
import { persistentContextFixture } from './fixtures/persistent-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const { snapshotStatements, statementDelta } = await import(new URL('../../../../../scripts/testing/m6/sql-observer.mjs', import.meta.url).href)

const turns = Number(process.env.BRIAN_DOC_THREAD_TURNS ?? '32')
const room = process.env.BRIAN_DOC_THREAD_SURFACE === 'room'

describe.sequential('[COMP:api/native-chat-read-cost] doc-thread per-turn cost', () => {
  afterAll(async () => { await getAppPool().end(); await getPool().end() })

  it(`runs ${turns} sequential turns on one ${room ? 'Room' : 'Page thread'}`, async () => {
    const f = await persistentContextFixture('confidential')
    let observer: pg.Client | undefined
    try {
      if (process.env.BRIAN_ASSURANCE_STATEMENT_STATS === 'true') {
        const marker = JSON.parse(await readFile(process.env.BRIAN_ASSURANCE_FIXTURE!, 'utf8'))
        if (!marker.bootstrapRole) throw new Error('Statement statistics require the disposable fixture observer')
        const url = new URL(process.env.DATABASE_URL!)
        url.username = marker.bootstrapRole
        observer = new pg.Client({ connectionString:url.href })
        await observer.connect()
      }
      await initializeConversationVisibility()
      const native = conversationReadersActive()
      await f.pool.query("UPDATE workspaces SET plan='pro' WHERE id=$1", [f.workspaceId])
      const device = (await authSessionStore.create(f.ownerId, { deviceLabel: 'Fictional dock browser', userAgent: null, ipAddress: null }))!
      const teamspaceId = randomUUID()
      await f.pool.query(`INSERT INTO teamspaces(id,workspace_id,name,sensitivity,created_by)
        VALUES($1,$2,'Fictional current Page Teamspace','internal',$3)`, [teamspaceId,f.workspaceId,f.ownerId])
      await f.pool.query('INSERT INTO teamspace_members(teamspace_id,user_id) VALUES($1,$2)', [teamspaceId,f.ownerId])
      const page = (await f.pool.query<{ id: string }>(`INSERT INTO saved_views(workspace_id,created_by,name,entity,view_type,page,state,clearance,teamspace_id)
        VALUES($1,$2,'Fictional dock page','tasks','table','{"blocks":[]}','saved','internal',$3) RETURNING id`, [f.workspaceId, f.ownerId, teamspaceId])).rows[0].id
      const sessionId = room ? f.session.id : (await createDbCommentThreadStore().createThread({
        userId:f.ownerId,workspaceId:f.workspaceId,assistantId:f.assistantId,pageId:page,anchorKind:'human_range',
      })).sessionId
      const binding = (await f.pool.query(`SELECT anchor_kind,visibility FROM sessions WHERE id=$1`, [sessionId])).rows[0]
      expect(binding).toEqual({ anchor_kind:room?'none':'doc_thread',visibility:'workspace' })
      const reply = 'Fictional dock reply about this page.'
      const chunks = (): StreamChunk[] => [{ type: 'message_start', model: 'fixture' },
        ...reply.split(' ').map((word, i) => ({ type: 'text_delta' as const, text: (i ? ' ' : '') + word })),
        { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 8 } }]
      const provider: LLMProvider = { name: 'fictional-dock', models: ['fixture'],
        stream: async function* (options) { await options.assertInputAuthority?.(); yield* chunks() },
        createSession(session) { return { async *send(_messages, options) {
          await (options?.assertInputAuthority ?? session.assertInputAuthority)?.()
          yield* chunks()
        } } } }
      const app = express(); app.use(express.json()); app.use((req, _res, next) => {
        req.userId = f.ownerId; req.authSessionId = device.id; req.authVersion = device.authVersion; next()
      })
      app.use('/chat', chatRoutes({ provider, systemPrompt: 'Answer about the open page.', tools: new Map(),
        memoryStore: createDbMemoryStore(), capabilityStore: createDbCapabilityStore(), pendingApprovalsStore: createPendingApprovalsStore() }))
      const results: Array<Record<string, unknown>> = []
      const output = process.env.BRIAN_DOC_THREAD_OUTPUT ?? '/tmp/brian-doc-thread.json'
      // The owner logs its closure counters when it finishes, which can follow
      // the response: collect them in order for the whole thread.
      const closures: Array<Record<string, number>> = [], originalInfo = console.info.bind(console)
      const infoSpy = vi.spyOn(console, 'info').mockImplementation((...values: unknown[]) => {
        originalInfo(...values)
        if (values[0] === '[turn-owner] admission closure' && values[1] && typeof values[1] === 'object')
          closures.push(Object.fromEntries(Object.entries(values[1] as Record<string, unknown>).filter(([, value]) => typeof value === 'number')) as Record<string, number>)
      })
      for (let turn = 1; turn <= turns; turn++) {
        const before = observer ? await snapshotStatements(observer) : undefined
        const timings: Record<string, number> = {}
        const originalLog = console.log.bind(console)
        const logSpy = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
          originalLog(...values)
          for (const value of values) if (typeof value === 'string' && value.startsWith('[chat] turn timings session '))
            for (const match of value.matchAll(/\b([a-z_]+)=(\d+(?:\.\d+)?)/g)) timings[match[1]!] = Number(match[2])
        })
        // Foreground statements: every pg client query() issued while the request runs, both pools.
        let queries = 0, pageAnchorReads = 0, pageEffects = 0
        const originalQuery = pg.Client.prototype.query
        const querySpy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (this: pg.Client, ...args: unknown[]) {
          queries++
          const input = args[0]
          const text = typeof input === 'string' ? input : (input as {text?:string})?.text ?? ''
          if (text.includes('public.capture_native_page_turn_anchor(')) pageAnchorReads++
          if (text.includes('public.capture_native_page_turn_delivery(')) pageEffects++
          return Reflect.apply(originalQuery, this, args)
        } as typeof originalQuery)
        const start = performance.now()
        let body = ''
        try {
          await request(app).post('/chat').send({ sessionId, assistantId: f.assistantId, workspaceId: f.workspaceId,
            message: `Fictional dock turn ${turn} about this page`, ...(room?{appOrigin:'chat'}:{appOrigin:'doc',docViewId:page}), model: 'pro', timezone: 'UTC' })
            .buffer(true).parse((res, done) => { res.on('data', (chunk: Buffer) => { body += chunk.toString() }); res.on('end', () => done(null, body)); res.on('error', done) })
        } finally { logSpy.mockRestore(); querySpy.mockRestore() }
        const elapsedMs = Math.round(performance.now() - start)
        const sql = observer && before ? statementDelta(before,await snapshotStatements(observer)) : undefined
        const error = /event: error/.test(body) ? body.match(/"error":"([^"]+)"/)?.[1] ?? 'error' : undefined
        const received = body.split(/\r?\n\r?\n/).filter(frame => /^event: text_delta\r?$/m.test(frame))
          .map(frame => JSON.parse(frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart()).join('\n')) as {text:string}).map(event=>event.text).join('')
        const done = /event: done/.test(body)
        results.push({ turn,elapsedMs,queries,pageAnchorReads,pageEffects,done, ...(error ? { error } : {}),
          ...(sql ? { databaseTopLevel:sql.topLevel, nested:sql.nested } : {}),
          replyMatched:received===reply,
          totalMs: timings.total_ms, audienceMs: timings.audience_check_ms, audienceChecks: timings.audience_check_count, timings })
        await writeFile(output,JSON.stringify({turns,native,binding,results},null,1))
        expect(error).toBeUndefined()
        expect(done).toBe(true)
        expect(received).toBe(reply)
      }
      for (let wait = 0; closures.length < turns && wait < 50; wait++) await new Promise(resolve => setTimeout(resolve, 100))
      infoSpy.mockRestore()
      results.forEach((result, index) => { result.closure = closures[index] ?? null })
      let reopenedReplies: number | undefined
      if (native) {
        const persisted=await readNativeConversationHistory({userId:f.ownerId,authSessionId:device.id,authVersion:device.authVersion},sessionId)
        const replies=persisted.filter(row=>row.role==='assistant')
        expect(replies.map(row=>row.content)).toEqual(Array.from({length:turns},()=>[{type:'text',text:reply}]))
        reopenedReplies=replies.length
      }
      await writeFile(output,JSON.stringify({turns,native,binding,reopenedReplies,results},null,1))
    } finally {
      try { await observer?.end() } finally { await f.cleanup() }
    }
  }, Math.max(600_000, turns * 600_000))
})
