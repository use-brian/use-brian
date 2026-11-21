import { randomUUID } from 'node:crypto'
import express from 'express'
import pg from 'pg'
import request from 'supertest'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { LLMProvider } from '@use-brian/agent-runtime/providers/types.js'
import type { WorkspaceFilesStore } from '@use-brian/core/workspace-files/types.js'
import { authSessionStore } from '../../db/auth-session-store.js'
import { createDbCapabilityStore } from '../../db/capability-store.js'
import { getAppPool, getPool } from '../../db/client.js'
import { createDbMemoryStore } from '../../db/memory-store.js'
import { createPendingApprovalsStore } from '../../db/pending-approvals-store.js'
import { createPersonalWebSession } from '../../db/sessions.js'
import { createDbWorkspaceFilesStore } from '../../db/workspace-files-store.js'
import { chatRoutes } from '../../routes/chat.js'
import { PER_TURN_FILES_INDEX_CAP } from '../../turn/index-caps.js'
import { persistentContextFixture } from './fixtures/persistent-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

type Fixture = Awaited<ReturnType<typeof persistentContextFixture>>
const hiddenPath = '/fixture-private-plan.txt'
const unavailable = 'The workspace file index is unavailable for this turn.'
const empty = 'The workspace file index returned no entries within this turn’s access.'
const answer = 'The requested workspace file needs a current lookup.'

async function addPrivateFile(f: Fixture) {
  return createDbWorkspaceFilesStore().create(f.ownerId, {
    workspaceId: f.workspaceId, userId: f.ownerId, path: hiddenPath, parentPath: '/', name: 'fixture-private-plan.txt',
    mime: 'text/plain', sizeBytes: 12, storageUri: 'fixture://private-plan', summary: 'Fictional private file marker',
    createdByUserId: f.ownerId, sensitivity: 'internal',
  })
}

async function mountedTurn(f: Fixture, store: WorkspaceFilesStore, audience: 'personal' | 'room', capability = true) {
  await f.pool.query("UPDATE workspaces SET plan='pro' WHERE id=$1", [f.workspaceId])
  const capabilityStore = createDbCapabilityStore()
  if (capability) await capabilityStore.grant({ assistantId: f.assistantId, capability: 'files', grantedByUserId: f.ownerId })
  const device = await authSessionStore.create(f.ownerId, { deviceLabel: 'Fictional Files reader', userAgent: null, ipAddress: null })
  if (!device) throw new Error('Missing test device')
  const session = audience === 'room' ? f.session : await createPersonalWebSession({
    assistantId: f.assistantId, userId: f.ownerId, workspaceId: f.workspaceId, channelType: 'web', channelId: randomUUID(), appOrigin: 'chat',
  }, { actorUserId: f.ownerId, authSessionId: device.id, authVersion: device.authVersion })
  const calls: { system: string; messages: string }[] = []
  const provider: LLMProvider = {
    name: 'fictional-files-index', models: ['fixture'],
    async *stream() {
      yield { type: 'message_start', model: 'fixture' }
      yield { type: 'text_delta', text: 'Fictional context classifier control' }
      yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }
    },
    createSession(options) {
      return { async *send(messages) {
        calls.push({ system: `${options.systemPrompt}\n${options.runtimeSystemContext ?? ''}`, messages: JSON.stringify(messages) })
        yield { type: 'message_start', model: 'fixture' }
        yield { type: 'text_delta', text: answer }
        yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 10 } }
      } }
    },
  }
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.userId = f.ownerId
    req.authSessionId = device.id
    req.authVersion = device.authVersion
    next()
  })
  app.use('/chat', chatRoutes({ provider, systemPrompt: 'Fictional Files context fixture.', tools: new Map(), capabilityStore,
    memoryStore: createDbMemoryStore(), pendingApprovalsStore: createPendingApprovalsStore(), workspaceFilesStore: store }))
  const response = await request(app).post('/chat').send({ sessionId: session.id, assistantId: f.assistantId,
    workspaceId: f.workspaceId, message: 'Please check the workspace files for the project plan.', mode: 'default', model: 'pro' }).expect(200)
  expect(response.text).toContain('event: done')
  expect(response.text).not.toContain('event: error')
  expect(calls).toHaveLength(1)
  expect(calls[0].messages).not.toContain('# Workspace Files')
  const reply = (await f.pool.query<{ id: string }>("SELECT id FROM session_messages WHERE session_id=$1 AND role='assistant'", [session.id])).rows[0]
  if (!reply) throw new Error('Missing durable Files context reply')
  return { system: calls[0].system, reply: reply.id }
}

async function fileAncestry(f: Fixture, messageId: string) {
  return (await f.pool.query<{ id: string }>(`SELECT id
    FROM public.application_scope_lineage($1,ARRAY['session_message'],ARRAY[$2::uuid],ARRAY['1'])
    WHERE kind='workspace_file'`, [f.workspaceId, messageId])).rows.map(row => row.id)
}

describe.sequential('[COMP:files/prompt-context] workspace Files reaches the chat provider', () => {
  afterAll(async () => { await getAppPool().end(); await getPool().end() })

  it.each(['personal', 'room'] as const)('reports an unavailable %s lookup without leaking its database failure', async audience => {
    const f = await persistentContextFixture()
    try {
      const store = createDbWorkspaceFilesStore()
      const cause = 'Fictional database error mentioning another workspace'
      vi.spyOn(store, 'listIndexRanked').mockRejectedValue(new Error(cause))
      const { system, reply } = await mountedTurn(f, store, audience)
      expect(system).toContain(unavailable)
      expect(system).not.toContain(empty)
      expect(system).not.toContain(cause)
      expect(await fileAncestry(f, reply)).toEqual([])
    } finally { await f.cleanup() }
  })

  it('reports a successful empty room index without exposing a privately owned file', async () => {
    const f = await persistentContextFixture()
    try {
      await addPrivateFile(f)
      const { system, reply } = await mountedTurn(f, createDbWorkspaceFilesStore(), 'room')
      expect(system).toContain(empty)
      expect(system).not.toContain(unavailable)
      expect(system).not.toContain(hiddenPath)
      expect(await fileAncestry(f, reply)).toEqual([])
    } finally { await f.cleanup() }
  })

  it('omits an independently read personal file when room delivery denies the evidence', async () => {
    const f = await persistentContextFixture()
    try {
      const file = await addPrivateFile(f)
      const store = createDbWorkspaceFilesStore()
      const personalIndex = await store.listIndexRanked({ workspaceId: f.workspaceId, userId: f.ownerId,
        assistantId: f.assistantId, assistantKind: 'primary' }, PER_TURN_FILES_INDEX_CAP)
      expect(personalIndex.map(row => row.id)).toEqual([file.id])
      vi.spyOn(store, 'listIndexRanked').mockResolvedValue(personalIndex)
      const { system, reply } = await mountedTurn(f, store, 'room')
      expect(system).toContain(unavailable)
      expect(system).not.toContain(empty)
      expect(system).not.toContain(hiddenPath)
      expect(system).not.toContain('Fictional private file marker')
      expect(await fileAncestry(f, reply)).toEqual([])
    } finally { await f.cleanup() }
  })

  it('omits the index when the Files capability is inactive', async () => {
    const f = await persistentContextFixture()
    try {
      const store = createDbWorkspaceFilesStore()
      const reader = vi.spyOn(store, 'listIndexRanked')
      const { system } = await mountedTurn(f, store, 'personal', false)
      expect(reader).not.toHaveBeenCalled()
      expect(system).not.toContain('# Workspace Files')
    } finally { await f.cleanup() }
  })

  it.each(['classic', 'department'] as const)('bounds %s catalog reads and records exactly the surfaced evidence', async mode => {
    const f = await persistentContextFixture()
    try {
      if (mode === 'department') await f.pool.query('UPDATE workspaces SET department_read_v2=true WHERE id=$1', [f.workspaceId])
      const inserted = (await f.pool.query<{ id: string; path: string }>(`INSERT INTO public.workspace_files(
        workspace_id,path,parent_path,name,storage_uri,created_by_user_id,mime,updated_at)
        SELECT $1,'/operational/fixture-'||n||'.txt','/operational','fixture-'||n||'.txt','fixture://catalog/'||n,$2,
          'text/plain',statement_timestamp()-(n||' seconds')::interval FROM generate_series(1,2048) n
        RETURNING id,path`, [f.workspaceId, f.ownerId])).rows
      await f.pool.query(`INSERT INTO public.workspace_files(workspace_id,path,name,storage_uri,created_by_user_id,metadata,updated_at)
        SELECT $1,path,'excluded.txt','fixture://excluded',$2,metadata,statement_timestamp()
        FROM (VALUES('/doc/fixture-decorative.txt','{}'::jsonb),('/apps/fixture-program.txt','{}'::jsonb),
          ('/office/sessions/fixture-attachment.txt','{}'::jsonb),('/fixture-unindexed.txt','{"noIndex":true}'::jsonb)) assets(path,metadata)`,
      [f.workspaceId, f.ownerId])
      await f.pool.query(`INSERT INTO public.workspace_files(workspace_id,path,name,storage_uri,created_by_user_id,metadata,updated_at)
        SELECT $1,CASE WHEN n%2=0 THEN '/doc/' ELSE '/' END||'fixture-excluded-'||n||'.txt',
          'excluded.txt','fixture://excluded/'||n,$2,CASE WHEN n%2=0 THEN '{}'::jsonb ELSE '{"noIndex":true}'::jsonb END,
          statement_timestamp()+n*interval '1 second' FROM generate_series(1,4096) n`, [f.workspaceId, f.ownerId])
      await f.pool.query(`INSERT INTO public.workspace_files(workspace_id,path,name,storage_uri,created_by_user_id,user_id,updated_at)
        SELECT $1,'/fixture-inaccessible-'||n||'.txt','inaccessible.txt','fixture://inaccessible/'||n,$2,$3,
          statement_timestamp()+n*interval '1 second' FROM generate_series(1,128) n`, [f.workspaceId, f.ownerId, f.secondId])
      // Observe the real ranked query on its own app-role connection after
      // its access GUCs and local planner preference have been installed.
      type Plan = { 'Actual Rows': number; 'Shared Hit Blocks': number; 'Shared Read Blocks': number;
        'Index Name'?: string; 'Relation Name'?: string; Plans?: Plan[] }
      const plans: { rows: number; buffers: number; index?: string }[] = []
      const query = pg.Client.prototype.query
      const trace = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (this: pg.Client, ...args: unknown[]) {
        const [statement, values] = args
        if (typeof statement !== 'string' || !statement.includes('FROM workspace_files')
          || !statement.includes('ORDER BY updated_at DESC') || !Array.isArray(values)) return Reflect.apply(query, this, args)
        const explain: Promise<pg.QueryResult<{ 'QUERY PLAN': { Plan: Plan }[] }>> = Reflect.apply(query, this,
          [`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ${statement}`, values])
        return explain.then(({ rows }) => {
          const plan = rows[0]['QUERY PLAN'][0].Plan
          plans.push({ rows: plan['Actual Rows'], buffers: plan['Shared Hit Blocks'] + plan['Shared Read Blocks'],
            index: plan.Plans?.find(node => node['Relation Name'] === 'workspace_files')?.['Index Name'] })
          return Reflect.apply(query, this, args)
        })
      } as typeof query)
      const { system, reply } = await mountedTurn(f, createDbWorkspaceFilesStore(), 'personal').finally(() => trace.mockRestore())
      expect(plans.map(plan => plan.rows)).toEqual([PER_TURN_FILES_INDEX_CAP])
      // Before the ordered catalog read, the same role touched well over
      // 250,000 buffers. Leave headroom for legitimate policy and heap growth.
      expect(plans[0].buffers).toBeLessThan(70_000)
      console.info('Files catalog plan', mode, plans[0])
      expect(system).toContain('Recent workspace files available to this turn.')
      const paths = [...system.matchAll(/\/operational\/fixture-\d+\.txt/g)].map(match => match[0])
      const expected = Array.from({ length: PER_TURN_FILES_INDEX_CAP }, (_, index) => `/operational/fixture-${index + 1}.txt`)
      expect(paths).toEqual(expected)
      expect(system).not.toMatch(/fixture-(?:decorative|program|attachment|unindexed)\.txt/)
      expect(system).not.toContain('/fixture-excluded-')
      expect(system).not.toContain('/fixture-inaccessible-')
      expect((await fileAncestry(f, reply)).sort()).toEqual(inserted.filter(row => expected.includes(row.path)).map(row => row.id).sort())
    } finally { await f.cleanup() }
  })
})
