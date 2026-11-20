/** [COMP:api/native-chat-read-cost] Installed prompt Memory admission and metadata bound. */
import { randomUUID } from 'node:crypto'
import { ContextScopeAccumulator } from '@use-brian/agent-runtime/security/context-scope.js'
import type { ScopeSource } from '@use-brian/agent-runtime/security/derived-scope.js'
import { boundScopeSources } from '@use-brian/agent-runtime/security/source-evidence.js'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bindSessionTurnAuthority } from '../../context-scope/authority-lease.js'
import { resolveExecutionContextSystem } from '../../context-scope/execution-context.js'
import { authSessionStore } from '../../db/auth-session-store.js'
import { applyRLSGucs, getAppPool, getPool, rollbackAndRelease, runWithAgentAccess } from '../../db/client.js'
import { initializeConversationVisibility, promptMemorySectionsActive } from '../../db/conversation-visibility.js'
import { updateSelfEntityAttributes } from '../../db/entities-store.js'
import { createDbMemoryStore } from '../../db/memory-store.js'
import { createMemory, getSelfEntityId, preparePromptIdentityRead, upsertSoul } from '../../db/memories.js'
import { claimTurnLease, createPersonalWebSession, findOrCreateSession, getPreferredChannel, releaseTurnLease } from '../../db/sessions.js'
import { setTurnSqlRecording, takeTurnSqlLedger, withTurnFrame } from '../../db/turn-sql-accounting.js'
import { findAssistantById } from '../../db/users.js'
import { upsertBrainEvolution } from '../../db/workspace-brain-evolution-store.js'
import { upsertEvolution } from '../../db/workspace-memory-evolution-store.js'
import { getWorkspaceIdentity } from '../../db/workspace-store.js'
import { persistentContextFixture } from './fixtures/persistent-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const { promptMemorySignature } = await import(new URL('../../../scripts/conversation-store/build-conversation-prompt-memory.mjs', import.meta.url).href)
const { authenticateConversationInstallation, currentReleaseSource } = await import(new URL('../../../scripts/conversation-store/installation-release.mjs', import.meta.url).href)

const store = createDbMemoryStore()

async function privateTurn(departmentV2 = false) {
  const f = await persistentContextFixture()
  if (departmentV2) await f.pool.query('UPDATE workspaces SET department_read_v2=true WHERE id=$1', [f.workspaceId])
  const auth = await authSessionStore.create(f.ownerId, { deviceLabel: 'Fictional prompt reader', userAgent: null, ipAddress: null })
  if (!auth) throw new Error('Missing test device')
  const session = await createPersonalWebSession({ assistantId: f.assistantId, userId: f.ownerId,
    workspaceId: f.workspaceId, channelType: 'web', channelId: randomUUID(), appOrigin: 'chat' },
  { actorUserId: f.ownerId, authSessionId: auth.id, authVersion: auth.authVersion })
  const assistant = await findAssistantById(f.assistantId)
  if (!assistant) throw new Error('Missing test assistant')
  const { executionContext: execution } = await resolveExecutionContextSystem({ userId: f.ownerId,
    workspaceId: f.workspaceId, assistant, memberMode: 'member', sharedAudience: false, session, sessionAuthority: session,
    nativeSessionCredential: { userId: f.ownerId, sessionId: auth.id, authVersion: auth.authVersion },
    identity: { kind: 'attended', principal: { kind: 'workspace_member', userId: f.ownerId, authenticationKind: 'native_session' } },
    ownership: { kind: 'workspace', workspaceId: f.workspaceId },
    lifecycle: { sessionId: session.id, sessionPersisted: true, channelType: 'web', channelId: session.channelId,
      abortSignal: new AbortController().signal } })
  const token = await claimTurnLease(session.id, f.assistantId)
  if (!token) throw new Error('Missing test turn lease')
  const disposeBinding = bindSessionTurnAuthority(execution.security.authority, { sessionId: session.id, assistantId: f.assistantId, token })
  const statement = `SELECT public.capture_native_prompt_memory_sections($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS value`
  const params = [f.workspaceId, f.ownerId, f.assistantId, session.id, auth.id, auth.authVersion, f.ownerId, true, true, token]
  function captureIn(db: PoolClient, snapshot: 'repeatable read' | 'read committed') {
    return runWithAgentAccess(execution.security.access, async () => {
      await db.query(snapshot === 'repeatable read' ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN')
      await applyRLSGucs(db, f.ownerId, f.assistantId)
      return (await db.query(statement, params)).rows[0].value
    })
  }
  async function capture(snapshot: 'repeatable read' | 'read committed') {
    const db = await getAppPool().connect()
    try { return await captureIn(db, snapshot) } finally { await rollbackAndRelease(db) }
  }
  const authority = { execution, accumulator: new ContextScopeAccumulator() }
  return { ...f, auth, authority, capture, captureIn, read: () => store.getPromptMemoryContext!(execution.security.access, 10, authority),
    async cleanup() {
      disposeBinding()
      try { await releaseTurnLease(session.id, 'failed', token) } finally { await f.cleanup() }
    },
  }
}

describe.sequential('reviewed native prompt Memory owner', () => {
  beforeAll(async () => {
    await initializeConversationVisibility()
    expect(promptMemorySectionsActive()).toBe(true)
  })
  afterAll(async () => { await getAppPool().end(); await getPool().end() })

  it('keeps workspace and ranked results and both team tag memberships', async () => {
    const f = await privateTurn()
    try {
      const personal = await f.memory('Fictional ranked Memory', f.ownerId)
      const team = await createMemory({ workspaceId: f.workspaceId, assistantId: f.assistantId, userId: null,
        createdByUserId: f.ownerId, scope: 'workspace', summary: 'Fictional two-cohort Memory', tags: ['self-profile','voice'],
        sensitivity: 'internal' })
      await f.memory('Fictional other-member Memory must be withheld', f.secondId)
      await f.pool.query('UPDATE memories SET last_recalled_at=now() WHERE workspace_id=$1 AND id=$2',[f.workspaceId,team.id])
      await expect(f.capture('read committed')).rejects.toMatchObject({ code: '42501', message: 'prompt_memory_snapshot_required' })
      const result = await f.read()
      expect(result?.indexes.ranked).toMatchObject({ status: 'fulfilled', value: { totalCount: 2 } })
      if (result?.indexes.ranked.status !== 'fulfilled') throw new Error('Ranked prompt Memory held')
      expect(result.indexes.ranked.value.rows.map(row => row.id)).toEqual([team.id,personal.id])
      expect(result.indexes.ranked.value.rows.every(row => row.createdAt instanceof Date)).toBe(true)
      expect(result.indexes.workspace).toMatchObject({ status: 'fulfilled', value: [{ id: team.id }] })
      expect(result.team.identity.map(row => row.id)).toEqual([team.id])
      expect(result.team.tagged.map(row => row.id)).toEqual([team.id])
    } finally { await f.cleanup() }
  }, 120_000)

  it('matches independently owned prompt sections and refuses them after device withdrawal', async () => {
    const f = await privateTurn()
    const access = f.authority.execution.security.access
    const app = 'Use Brian'
    try {
      await upsertSoul(f.assistantId,f.ownerId,null,'Fictional shared SOUL')
      await upsertSoul(f.assistantId,f.ownerId,app,'Fictional application SOUL')
      await findOrCreateSession({assistantId:f.assistantId,userId:f.ownerId,workspaceId:f.workspaceId,
        channelType:'telegram',channelId:'fictional-delivery-channel'})
      await upsertEvolution({workspaceId:f.workspaceId,totalSaves30d:8,totalVerifications30d:4,scopeNarrowRate:null,
        scopeWideRate:null,sensitivityOverRate:null,sensitivityUnderRate:null,promptSnippet:'Fictional Memory correction'})
      await upsertBrainEvolution({workspaceId:f.workspaceId,rates:{},promptSnippet:'Fictional brain correction'})
      const [soul,workspace,preferred] = await Promise.all([
        store.getSoulContext!(access,app),getWorkspaceIdentity(f.workspaceId),getPreferredChannel(f.assistantId,f.ownerId),
      ])
      expect(preferred).toEqual({channelType:'telegram',channelId:'fictional-delivery-channel'})
      const read = () => store.getPromptAuxiliaryContext!(access,app,f.authority)
      expect(await read()).toEqual({soul,workspace,preferred,evolution:'Fictional Memory correction\n\nFictional brain correction',identity:[]})
      expect(await store.getPromptAuxiliaryContext!({...access,sharedAudience:true},app,f.authority)).toBeNull()
      await authSessionStore.revokeForUser(f.ownerId,f.auth.id)
      await expect(read()).rejects.toMatchObject({code:'scope_source_changed'})
    } finally { await f.cleanup() }
  },120_000)

  it('keeps the original app self selector and freshly admits the discovered CRM person', async () => {
    const f=await privateTurn()
    const access=f.authority.execution.security.access
    try {
      const self=await updateSelfEntityAttributes({userId:f.ownerId,workspaceId:f.workspaceId,
        displayName:'Fictional eligible self',attributes:{name:'Fictional eligible self',role:'Fictional planning lead'}})
      expect(await getSelfEntityId(access)).toBe(self.id)
      expect(await f.read()).toMatchObject({selfEntityId:self.id,team:{identity:[],tagged:[]}})
      const auxiliary=()=>store.getPromptAuxiliaryContext!(access,'Use Brian',f.authority)
      const scalar=await store.getIdentity(access,f.authority)
      const retained=(await auxiliary())?.identity
      if(!retained)throw new Error('Missing retained identity rows')
      expect(retained).toEqual(scalar)
      expect(retained.map(row=>row.summary)).toContain("User's role: Fictional planning lead")
      expect(boundScopeSources(retained).some(source=>source.resourceKind==='application_field')).toBe(true)
      expect(boundScopeSources(retained)).toEqual(boundScopeSources(scalar))

      const alternate={...access,projectIds:undefined}
      expect(await getSelfEntityId(alternate)).toBe(self.id)
      expect(await store.getPromptMemoryContext!(alternate,10,f.authority)).not.toHaveProperty('selfEntityId')

      const prepared=preparePromptIdentityRead(access,f.authority,1)
      const root=(await f.pool.query<{source:ScopeSource|null}>(`SELECT (${prepared.sql}) AS source`,prepared.params)).rows[0].source
      expect(root).toMatchObject({resourceId:self.id,resourceKind:'entity'})
      await f.pool.query('UPDATE entities SET scope_held=true WHERE id=$1',[self.id])
      await expect(prepared.project(root)).rejects.toMatchObject({code:'scope_source_changed'})
      expect(await auxiliary()).toMatchObject({identity:[]})
      expect(await f.read()).toMatchObject({selfEntityId:null,team:{identity:[],tagged:[]}})
    } finally {await f.cleanup()}
  },120_000)

  it('finds the sentinel without observing fields in a workspace with 1,000 eligible metadata rows', async () => {
    const f = await privateTurn()
    try {
      await f.pool.query(`INSERT INTO public.memories(workspace_id,user_id,assistant_id,created_by_user_id,summary,sensitivity)
        SELECT $1,$2,$3,$2,'Fictional metadata candidate '||n,'internal' FROM generate_series(1,1000) n`,
      [f.workspaceId, f.ownerId, f.assistantId])
      await f.pool.query('ANALYZE public.memories')
      const count = () => f.pool.query<{ total: string }>('SELECT count(*) AS total FROM application_query_domains WHERE workspace_id=$1', [f.workspaceId])
      const before = (await count()).rows
      const packet = await f.capture('repeatable read')
      expect(packet).toMatchObject({ kind: 'unsupported', reason: 'metadata_cohort_bound' })
      expect(packet).not.toHaveProperty('indexes')
      expect(await f.read()).toBeNull()
      expect((await count()).rows).toEqual(before)
      const plan = (await f.pool.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
        SELECT m.id,m.scope_version FROM public.memories m WHERE m.workspace_id=$1
        ORDER BY m.user_id,m.assistant_id LIMIT 101`, [f.workspaceId])).rows[0]['QUERY PLAN'][0].Plan
      expect(plan).toMatchObject({ 'Node Type': 'Limit', 'Actual Rows': 101, Plans: [{
        'Node Type': 'Index Scan', 'Index Name': 'idx_memories_visibility', 'Actual Rows': 101,
      }] })
    } finally { await f.cleanup() }
  }, 120_000)

  it('ranks live Memory through the paired fallback after a large workspace’s retained history exceeds the packed bound', async () => {
    const f = await privateTurn(true)
    try {
      await f.pool.query(`WITH generated AS MATERIALIZED (
        SELECT n,gen_random_uuid() id FROM generate_series(1,208) n
      )
      INSERT INTO public.memories(id,workspace_id,user_id,assistant_id,created_by_user_id,source_session_id,
        summary,sensitivity,valid_to,superseded_by)
      SELECT a.id,$1,$2,$3,$2,CASE WHEN a.n<=204 THEN $4::uuid END,'Fictional retained Memory '||a.n,
        'internal',CASE WHEN a.n<=200 THEN now() END,b.id
      FROM generated a LEFT JOIN generated b ON b.n=a.n+1 AND a.n<=152 AND a.n%4<>0`,
      [f.workspaceId,f.ownerId,f.assistantId,f.session.id])

      expect(await f.read()).toBeNull()
      const access = f.authority.execution.security.access
      const paired = await store.getPairedPromptIndexes!(access, 5, f.authority)
      if (paired.ranked.status !== 'fulfilled' || paired.workspace.status !== 'fulfilled') throw new Error('Missing current Memory index')
      expect(paired.ranked.value.totalCount).toBe(8)
      expect(paired.ranked.value.rows).toHaveLength(5)
      expect(paired.workspace.value).toEqual([])
      expect(boundScopeSources(paired.ranked.value)).toHaveLength(9)
      expect(boundScopeSources(paired.workspace.value)).toHaveLength(9)
      expect(boundScopeSources(paired.ranked.value)).not.toEqual(boundScopeSources(paired.workspace.value))
    } finally { await f.cleanup() }
  }, 60_000)

  it('refuses unreviewed executable metadata with the installed read-only profile', async () => {
    const installed=(await getPool().query<{name:string}>(
      'SELECT name FROM public._migrations ORDER BY name COLLATE "C" DESC LIMIT 1')).rows[0].name
    const { sql } = await currentReleaseSource(installed)
    const client = await getPool().connect()
    try {
      expect(await authenticateConversationInstallation(client)).toMatchObject({witnessCurrent:true})
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      await client.query(`ALTER FUNCTION public.${promptMemorySignature} COST 101`)
      await expect(client.query(sql)).rejects.toThrow('prompt_memory_executable_contract_changed')
    } finally { await rollbackAndRelease(client) }
  }, 120_000)

  it.each([false,true])('handles a real concurrent immutable domain write, host retry %s', async retry => {
    const f = await privateTurn()
    const holderPool = new Pool({ connectionString: process.env.DATABASE_URL_APP, max: 1 })
    let holder: PoolClient | undefined
    const turnId = randomUUID()
    let reading: Promise<{value?: unknown;error?: unknown}> | undefined
    try {
      await f.memory('Fictional simultaneous Memory reader', f.ownerId)
      holder = await holderPool.connect()
      const pid = (await holder.query<{pid: number}>('SELECT pg_backend_pid() pid')).rows[0].pid
      expect(await f.captureIn(holder, 'repeatable read')).toMatchObject({ kind: 'sections' })
      setTurnSqlRecording(true)
      reading = withTurnFrame({ turnId, frameId: 'prompt-memory-conflict' },
        () => retry ? f.read() : f.capture('repeatable read'))
        .then(value => ({value}), error => ({error}))
      let blocked = false
      for (let check = 0; check < 100 && !blocked; check++) {
        blocked = (await f.pool.query<{blocked: boolean}>(`SELECT coalesce(bool_or($1=ANY(pg_blocking_pids(pid))),false) blocked
          FROM pg_stat_activity WHERE datname=current_database() AND pid<>$1 AND usename='app_user'`, [pid])).rows[0].blocked
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(blocked).toBe(true)
      await holder.query('COMMIT')
      const outcome = await reading
      if (retry) {
        expect(outcome).toMatchObject({ value: { indexes: { ranked: { status: 'fulfilled', value: { totalCount: 1 } } } } })
        expect(takeTurnSqlLedger(turnId)?.totals.failed).toBe(1)
      } else expect(outcome).toMatchObject({ error: { code: '40001' } })
    } finally {
      if (holder) await rollbackAndRelease(holder)
      await holderPool.end()
      await reading
      setTurnSqlRecording(undefined)
      takeTurnSqlLedger(turnId)
      await f.cleanup()
    }
  }, 120_000)
})
