import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterAll, describe, expect, it } from 'vitest'
import type { LLMProvider } from '@use-brian/agent-runtime/providers/types.js'
import { createDbCapabilityStore } from '../../db/capability-store.js'
import { getAppPool, getPool } from '../../db/client.js'
import { createDbCommentThreadStore } from '../../db/comment-thread-store.js'
import { authSessionStore } from '../../db/auth-session-store.js'
import { readNativeConversationHistory } from '../../db/chat-presentation.js'
import { initializeConversationVisibility } from '../../db/conversation-visibility.js'
import { createDbMemoryStore } from '../../db/memory-store.js'
import { createPendingApprovalsStore } from '../../db/pending-approvals-store.js'
import { createTeamspaceStore } from '../../db/teamspace-store.js'
import { chatRoutes } from '../../routes/chat.js'
import { persistentContextFixture } from '../../application-platform/__tests__/fixtures/persistent-context.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

const privateFrameSignature = 'public.private_conversation_page_frame_source(uuid,uuid,text,uuid,text,uuid)'
const installed = (await getPool().query<{ active: boolean }>('SELECT to_regprocedure($1) IS NOT NULL AS active', [privateFrameSignature])).rows[0].active
const scenarios = ['ordinary', 'before-dispatch', 'during-delivery', 'different-page', 'private-page'] as const

afterAll(async () => { await getAppPool().end(); await getPool().end() })
describe.sequential('[COMP:api/page-thread-audience] native Page access withdrawal during chat', () => {
  it.each(scenarios.filter(scenario => installed || !['different-page', 'private-page'].includes(scenario)))('checks actual Page-thread admission in %s', async scenario => {
    const f = await persistentContextFixture('internal')
    const teamspaceId = randomUUID(), pageId = randomUUID()
    const privatePage = scenario==='private-page'
    const userId = privatePage ? f.ownerId : f.firstId
    let removed = false, dispatched = false
    const remove = async () => { removed = await createTeamspaceStore().removeMemberSystem(teamspaceId, userId) }
    const partial = 'Fictional first protected sentence.'
    const remaining = ' Fictional later protected sentence.'
    try {
      await initializeConversationVisibility()
      const device = (await authSessionStore.create(userId, { deviceLabel: 'Fictional teamspace dock', userAgent: null, ipAddress: null }))!
      await f.pool.query("UPDATE workspaces SET plan='pro' WHERE id=$1", [f.workspaceId])
      await f.pool.query("UPDATE assistants SET clearance='internal' WHERE id=$1", [f.assistantId])
      await f.pool.query("INSERT INTO teamspaces (id,workspace_id,name,sensitivity,created_by) VALUES ($1,$2,'Fictional shared dock','internal',$3)", [teamspaceId, f.workspaceId, f.ownerId])
      await f.pool.query('INSERT INTO teamspace_members(teamspace_id,user_id) SELECT $1,u FROM unnest($2::uuid[]) u', [teamspaceId,[...new Set([f.ownerId,userId])]])
      await f.pool.query(`INSERT INTO saved_views(id,workspace_id,created_by,name,entity,view_type,page,state,clearance,teamspace_id)
        VALUES($1,$2,$3,'Fictional shared dock Page','tasks','table','{"blocks":[]}','saved','internal',$4)`, [pageId, f.workspaceId, f.ownerId, privatePage?null:teamspaceId])
      const thread=await createDbCommentThreadStore().createThread({userId,workspaceId:f.workspaceId,assistantId:f.assistantId,pageId,anchorKind:'human_range'})
      const requestedPage = scenario==='different-page' ? randomUUID() : pageId
      if (requestedPage!==pageId) await f.pool.query(`INSERT INTO saved_views(id,workspace_id,created_by,name,entity,view_type,page,state,clearance,teamspace_id)
        VALUES($1,$2,$3,'Fictional other eligible Page','tasks','table','{"blocks":[]}','saved','internal',$4)`, [requestedPage,f.workspaceId,f.ownerId,teamspaceId])
      let firstSeen!: () => void
      const firstOutput = new Promise<void>(resolve => { firstSeen = resolve })
      const provider: LLMProvider = { name:'fictional-dock', models:['fixture'], stream() { throw new Error('unexpected unframed model send') },
        createSession(session) { return { async *send(_messages, options) {
          if (scenario==='before-dispatch') await remove()
          await (options?.assertInputAuthority ?? session.assertInputAuthority)?.()
          dispatched = true
          yield { type:'message_start', model:'fixture' }
          yield { type:'text_delta', text:partial }
          if (scenario==='during-delivery') {
            await firstOutput
            await remove()
          }
          yield { type:'text_delta', text:remaining }
          yield { type:'message_end', stopReason:'end_turn', usage:{ inputTokens:10, outputTokens:8 } }
        } } }
      }
      const app = express(); app.use(express.json()); app.use((req,_res,next) => {
        req.userId=userId;req.authSessionId=device.id;req.authVersion=device.authVersion;next()
      })
      app.use('/chat',chatRoutes({provider,systemPrompt:'Answer about the open Page.',tools:new Map(),memoryStore:createDbMemoryStore(),
        capabilityStore:createDbCapabilityStore(),pendingApprovalsStore:createPendingApprovalsStore()}))
      let body=''
      const reply = await request(app).post('/chat').send({ assistantId:f.assistantId, workspaceId:f.workspaceId,
        sessionId:thread.sessionId,message:'Fictional dock question.',appOrigin:'doc',docViewId:requestedPage,model:'pro',timezone:'UTC',channelId:randomUUID() })
        .buffer(true).parse((res, done) => {
          res.on('data',(chunk:Buffer)=>{body+=chunk.toString();if(body.includes(partial))firstSeen()})
          res.on('end',()=>done(null,body));res.on('error',done)
        }).timeout(30_000)
      expect(reply.status).toBe(200)
      const sessionId = body.match(/"sessionId":"([0-9a-f-]{36})"/)?.[1]
      expect(sessionId).toBeDefined()
      const durable = (await f.pool.query<{role:string}>(`SELECT role FROM session_messages WHERE session_id=$1 ORDER BY sequence_num`,[sessionId])).rows
      if (scenario==='ordinary' || privatePage) {
        expect(dispatched).toBe(true)
        expect(body).toContain(partial)
        expect(body).toContain(remaining)
        expect(body).not.toContain('event: error')
        const messages = await readNativeConversationHistory({userId,authSessionId:device.id,authVersion:device.authVersion},sessionId!)
        expect(messages.filter(m=>m.role==='assistant').map(m=>m.content)).toEqual([[{type:'text',text:partial+remaining}]])
        if (privatePage) {
          const other = (await authSessionStore.create(f.firstId,{deviceLabel:'Fictional other member',userAgent:null,ipAddress:null}))!
          await expect(readNativeConversationHistory({userId:f.firstId,authSessionId:other.id,authVersion:other.authVersion},sessionId!)).rejects.toBeTruthy()
          const edges=(await f.pool.query<{kind:string;id:string;version:string}>(`SELECT DISTINCT source_kind kind,source_id id,source_version version
            FROM scope_derivation_sources WHERE workspace_id=$1 AND source_kind IN('page_event_changed','page_live_changed')`,[f.workspaceId])).rows
          expect(edges.map(source=>source.kind).sort()).toEqual(['page_event_changed','page_live_changed'])
          for (const source of edges) {
            const command='SELECT private_conversation_page_frame_source($1,$2,$3,$4,$5,$6) AS proved'
            const tuple=[f.workspaceId,sessionId,source.kind,source.id,source.version,userId]
            expect((await f.pool.query(command,tuple)).rows[0].proved).toBe(true)
            expect((await f.pool.query(command,[f.workspaceId,f.session.id,...tuple.slice(2)])).rows[0].proved).toBe(false)
            expect((await f.pool.query(command,[...tuple.slice(0,4),'wrong-version',userId])).rows[0].proved).toBe(false)
            expect((await f.pool.query(command,[...tuple.slice(0,-1),f.firstId])).rows[0].proved).toBe(false)
            await expect(getAppPool().query(command,tuple)).rejects.toMatchObject({code:'42501'})
          }
        }
      } else if (scenario==='different-page') {
        expect(dispatched).toBe(false)
        expect(body).not.toContain(partial)
        expect(body).toContain('event: error')
        expect(durable.some(row=>row.role==='assistant')).toBe(false)
      } else {
        expect(removed).toBe(true)
        expect(dispatched).toBe(scenario==='during-delivery')
        expect(body.includes(partial)).toBe(scenario==='during-delivery')
        expect(body).not.toContain(remaining)
        expect(body).toContain('event: error')
        expect(durable.map(row=>row.role)).toEqual(['user'])
      }
    } finally { await f.cleanup() }
  }, 45_000)
})
