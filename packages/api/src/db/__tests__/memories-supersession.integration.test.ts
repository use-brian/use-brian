import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import pg from 'pg'

/**
 * Integration test for WU-2.2 — memory supersession-on-write,
 * bi-temporal reads, and the D.7 getMemoryHistory chain walker.
 *
 * Requires the token-verified disposable PostgreSQL fixture with all migrations.
 * Missing fixture evidence fails before database access.
 */

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:2000})
const describeIf=describe


afterAll(async () => {
  if (pool) await pool.end()
})

async function makeUser(client: pg.PoolClient): Promise<string> {
  const r = await client.query(
    `INSERT INTO users (id, auth_provider, auth_provider_id)
     VALUES (gen_random_uuid(), 'test', 'mem-sup-' || gen_random_uuid())
     RETURNING id`,
  )
  return r.rows[0].id
}

async function makeWorkspace(client: pg.PoolClient, ownerUserId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
     VALUES (gen_random_uuid(), 'mem-sup-ws', 'test', $1, false)
     RETURNING id`,
    [ownerUserId],
  )
  await client.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner') ON CONFLICT DO NOTHING",[r.rows[0].id,ownerUserId])
  return r.rows[0].id
}

async function makeAssistant(client: pg.PoolClient, ownerUserId: string, workspaceId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO assistants (id, name, owner_user_id, workspace_id)
     VALUES (gen_random_uuid(), 'mem-sup-assistant', $1, $2)
     RETURNING id`,
    [ownerUserId, workspaceId],
  )
  return r.rows[0].id
}

describeIf('[COMP:memory/supersession] updateMemory (transactional supersession)', () => {
  let memories: typeof import('../memories.js')
  let userId: string
  let assistantId: string
  let workspaceId: string

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    memories = await import('../memories.js')
  })

  beforeEach(async () => {
    const client = await pool!.connect()
    try {
      userId = await makeUser(client)
      workspaceId = await makeWorkspace(client, userId)
      assistantId = await makeAssistant(client, userId, workspaceId)
    } finally {
      client.release()
    }
  })

  it('inserts a new row, tombstones the old, and points superseded_by OLD→NEW', async () => {
    const old = await memories.createMemory({
      assistantId, userId,
      summary: 'Likes ramen',
      detail: 'noodles only',
      sensitivity: 'internal',
      tags: ['food'],
      createdByUserId: userId,
      createdByAssistantId: assistantId,
    })
    expect(old.validFrom).toBeInstanceOf(Date)
    expect(old.validTo).toBeNull()
    expect(old.supersededBy).toBeNull()

    const updated = await memories.updateMemory(old.id, { summary: 'Loves ramen' })
    expect(updated).not.toBeNull()
    expect(updated!.id).not.toBe(old.id)
    expect(updated!.summary).toBe('Loves ramen')
    expect(updated!.validTo).toBeNull()
    expect(updated!.supersededBy).toBeNull()

    // Re-read the old row directly (bypassing the bi-temporal filter)
    // and verify the tombstone + supersession pointer.
    const raw = await pool!.query(
      `SELECT valid_to, superseded_by FROM memories WHERE id = $1`,
      [old.id],
    )
    expect(raw.rows[0].valid_to).not.toBeNull()
    expect(raw.rows[0].superseded_by).toBe(updated!.id)
  })

  it('preserves unchanged fields from the old row on the new row', async () => {
    const old = await memories.createMemory({
      assistantId, userId,
      summary: 'Original summary',
      detail: 'original detail',
      sensitivity: 'internal',
      tags: ['a', 'b'],
      compartments: ['client:studio-client:alice'],
      confidence: 0.7,
      createdByUserId: userId,
      createdByAssistantId: assistantId,
    })

    const updated = await memories.updateMemory(old.id, { summary: 'New summary' })
    expect(updated!.detail).toBe('original detail')
    expect(updated!.tags).toEqual(['a', 'b'])
    expect(updated!.confidence).toBeCloseTo(0.7)
    expect(updated!.sensitivity).toBe('internal')
    expect(updated!.compartments).toEqual(['client:studio-client:alice'])
    expect(updated!.assistantId).toBe(assistantId)
    expect(updated!.userId).toBe(userId)
  })

  it('inherits authorship from the old row on the new row', async () => {
    const old = await memories.createMemory({
      assistantId, userId,
      summary: 'X',
      sensitivity: 'internal',
      createdByUserId: userId,
      createdByAssistantId: assistantId,
    })
    const updated = await memories.updateMemory(old.id, { summary: 'Y' })
    expect(updated!.createdByUserId).toBe(userId)
    expect(updated!.createdByAssistantId).toBe(assistantId)
  })

  it('resets operational counters on the new row', async () => {
    const old = await memories.createMemory({
      assistantId, userId,
      summary: 'X',
      sensitivity: 'internal',
      createdByUserId: userId,
    })
    await memories.trackRecall(old.id, 'q1')
    await memories.trackRecallOutcome(old.id, true)

    const refetchedOld = await pool!.query<{ recall_count: number; useful_recall_count: number }>(
      `SELECT recall_count, useful_recall_count FROM memories WHERE id = $1`,
      [old.id],
    )
    expect(refetchedOld.rows[0].recall_count).toBe(1)
    expect(refetchedOld.rows[0].useful_recall_count).toBe(1)

    const updated = await memories.updateMemory(old.id, { summary: 'Y' })
    expect(updated!.recallCount).toBe(0)
    const newRow = await pool!.query<{ useful_recall_count: number; last_recalled_at: Date | null }>(
      `SELECT useful_recall_count, last_recalled_at FROM memories WHERE id = $1`,
      [updated!.id],
    )
    expect(newRow.rows[0].useful_recall_count).toBe(0)
    expect(newRow.rows[0].last_recalled_at).toBeNull()
  })

  it('returns null and inserts no row when the id is already tombstoned', async () => {
    const old = await memories.createMemory({
      assistantId, userId,
 summary: 'X', sensitivity: 'internal', createdByUserId: userId,
    })
    const v2 = await memories.updateMemory(old.id, { summary: 'Y' })
    expect(v2).not.toBeNull()

    // Update against the now-tombstoned old id should no-op.
    const rejected = await memories.updateMemory(old.id, { summary: 'Z' })
    expect(rejected).toBeNull()

    const versions = await pool!.query<{ count: string }>(
      `SELECT count(*)::text FROM memories
       WHERE assistant_id = $1 AND user_id = $2`,
      [assistantId, userId],
    )
    expect(parseInt(versions.rows[0].count, 10)).toBe(2) // old + v2, no third row
  })

  it('returns null when the id never existed', async () => {
    const missing = await memories.updateMemory(
      '00000000-0000-0000-0000-000000000000',
      { summary: 'X' },
    )
    expect(missing).toBeNull()
  })
})

describeIf('[COMP:memory/bi-temporal-reads] reads filter valid_to IS NULL', () => {
  let memories: typeof import('../memories.js')
  let userId: string
  let assistantId: string
  let workspaceId: string

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    memories = await import('../memories.js')
  })

  beforeEach(async () => {
    const client = await pool!.connect()
    try {
      userId = await makeUser(client)
      workspaceId = await makeWorkspace(client, userId)
      assistantId = await makeAssistant(client, userId, workspaceId)
    } finally {
      client.release()
    }
  })

  function ctx(): import('@use-brian/core').AccessContext {
    return { workspaceId, userId, assistantId, assistantKind: 'standard', clearance: 'confidential' }
  }

  it('getMemoryById returns null for tombstoned ids and the new row for active ids', async () => {
    const old = await memories.createMemory({
      assistantId, userId,
 summary: 'Likes ramen', sensitivity: 'internal', createdByUserId: userId,
    })
    const updated = await memories.updateMemory(old.id, { summary: 'Loves ramen' })

    expect(await memories.getMemoryById(ctx(), old.id)).toBeNull()
    const refreshed = await memories.getMemoryById(ctx(), updated!.id)
    expect(refreshed?.summary).toBe('Loves ramen')
  })

  it('countMemories reflects only active versions', async () => {
    const a = await memories.createMemory({
      assistantId, userId,
 summary: 'A', sensitivity: 'internal', createdByUserId: userId,
    })
    await memories.createMemory({
      assistantId, userId,
 summary: 'B', sensitivity: 'internal', createdByUserId: userId,
    })
    expect(await memories.countMemories(ctx())).toBe(2)

    await memories.updateMemory(a.id, { summary: 'A2' })
    expect(await memories.countMemories(ctx())).toBe(2) // not 3
  })

  it('searchMemories does not surface superseded versions', async () => {
    const old = await memories.createMemory({
      assistantId, userId,
 summary: 'OldSummary uniqueterm', sensitivity: 'internal', createdByUserId: userId,
    })
    await memories.updateMemory(old.id, { summary: 'NewSummary uniqueterm' })

    const results = await memories.searchMemories(ctx(), { searchQuery: 'uniqueterm' })
    expect(results).toHaveLength(1)
    expect(results[0].summary).toBe('NewSummary uniqueterm')
  })

  it('getMemoryIndex omits superseded rows', async () => {
    const a = await memories.createMemory({
      assistantId, userId,
 summary: 'A', sensitivity: 'internal', createdByUserId: userId,
    })
    await memories.updateMemory(a.id, { summary: 'A2' })

    const idx = await memories.getMemoryIndex(ctx())
    expect(idx.map((r) => r.summary).sort()).toEqual(['A2'])
  })

  // NOTE: a former 'getIdentityMemories omits superseded rows' test was
  // removed here. Post-Phase-4 (retire-memory-type, mig 176/177)
  // getIdentityMemories no longer reads memory rows — it synthesises
  // identity lines from the self entity's attributes JSONB. Memory-row
  // supersession is still covered by the sibling reads below.
  it('listMemoriesWithMetrics omits superseded rows', async () => {
    const a = await memories.createMemory({
      assistantId, userId,
 summary: 'A', sensitivity: 'internal', createdByUserId: userId,
    })
    await memories.updateMemory(a.id, { summary: 'A2' })

    const rows = await memories.listMemoriesWithMetrics(assistantId, userId)
    expect(rows).toHaveLength(1)
    expect(rows[0].summary).toBe('A2')
  })
})

describeIf('[COMP:memory/row-history] getMemoryHistory walks the supersession chain', () => {
  let memories: typeof import('../memories.js')
  let userId: string
  let assistantId: string
  let workspaceId: string

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    memories = await import('../memories.js')
  })

  beforeEach(async () => {
    const client = await pool!.connect()
    try {
      userId = await makeUser(client)
      workspaceId = await makeWorkspace(client, userId)
      assistantId = await makeAssistant(client, userId, workspaceId)
    } finally {
      client.release()
    }
  })

  it('returns a single-element chain for an un-edited row', async () => {
    const m = await memories.createMemory({
      assistantId, userId,
 summary: 'Solo', sensitivity: 'internal', createdByUserId: userId,
    })
    const history = await memories.getMemoryHistory(m.id)
    expect(history.chain).toHaveLength(1)
    expect(history.chain[0].id).toBe(m.id)
    expect(history.currentId).toBe(m.id)
  })

  it('reconstructs a three-version chain in chronological order', async () => {
    const v1 = await memories.createMemory({
      assistantId, userId,
 summary: 'V1', sensitivity: 'internal', createdByUserId: userId,
    })
    const v2 = await memories.updateMemory(v1.id, { summary: 'V2' })
    expect(v2).not.toBeNull()
    const v3 = await memories.updateMemory(v2!.id, { summary: 'V3' })
    expect(v3).not.toBeNull()

    const history = await memories.getMemoryHistory(v1.id)
    expect(history.chain.map((r) => r.summary)).toEqual(['V1', 'V2', 'V3'])
    expect(history.currentId).toBe(v3!.id)
  })

  it('returns the same chain when given a mid-chain id', async () => {
    const v1 = await memories.createMemory({
      assistantId, userId,
 summary: 'V1', sensitivity: 'internal', createdByUserId: userId,
    })
    const v2 = await memories.updateMemory(v1.id, { summary: 'V2' })
    const v3 = await memories.updateMemory(v2!.id, { summary: 'V3' })

    const fromMid = await memories.getMemoryHistory(v2!.id)
    expect(fromMid.chain.map((r) => r.id)).toEqual([v1.id, v2!.id, v3!.id])
    expect(fromMid.currentId).toBe(v3!.id)

    const fromHead = await memories.getMemoryHistory(v3!.id)
    expect(fromHead.chain.map((r) => r.id)).toEqual([v1.id, v2!.id, v3!.id])
    expect(fromHead.currentId).toBe(v3!.id)
  })

  it('returns empty chain when the id does not exist', async () => {
    const history = await memories.getMemoryHistory('00000000-0000-0000-0000-000000000000')
    expect(history.chain).toEqual([])
    expect(history.currentId).toBeNull()
  })
})

describeIf('[COMP:memory/authorship-stamp] createMemory writes universal-column authorship', () => {
  let memories: typeof import('../memories.js')
  let userId: string
  let assistantId: string
  let workspaceId: string

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    memories = await import('../memories.js')
  })

  beforeEach(async () => {
    const client = await pool!.connect()
    try {
      userId = await makeUser(client)
      workspaceId = await makeWorkspace(client, userId)
      assistantId = await makeAssistant(client, userId, workspaceId)
    } finally {
      client.release()
    }
  })

  it('stamps createdByUserId / createdByAssistantId / sourceEpisodeId when supplied', async () => {
    const m = await memories.createMemory({
      assistantId, userId,
 summary: 'X', sensitivity: 'internal',
      createdByUserId: userId,
      createdByAssistantId: assistantId,
      // sourceEpisodeId left out — episodes table FK lands in mig 129 but
      // is plain UUID at this stage, so any UUID would work. We assert
      // the absence path; presence is symmetric.
    })
    expect(m.createdByUserId).toBe(userId)
    expect(m.createdByAssistantId).toBe(assistantId)
    expect(m.sourceEpisodeId).toBeNull()
    expect(m.validFrom).toBeInstanceOf(Date)
    expect(m.validTo).toBeNull()
    expect(m.supersededBy).toBeNull()
  })

  it('rejects inserts missing createdByUserId (WU-4.5 authorship NOT NULL enforcement)', async () => {
    await expect(
      memories.createMemory({
        assistantId, userId,
 summary: 'X', sensitivity: 'internal',
        createdByUserId: '',
      }),
    ).rejects.toThrowError(/createMemory.*createdByUserId.*WU-4\.5/)
  })
})

describe('[COMP:memory/learning] PostgreSQL eligibility and compatibility',()=>{
  const learned={version:1,state:'established',origin:'explicit',applicability:{activity:'status_update'},appliesUntil:'2026-12-01T00:00:00Z'}
  it('filters candidates, wrong context and expired facts with exact boundary semantics',async()=>{
    const allowed=async(value:unknown,context:unknown={},at='2026-11-01T00:00:00Z',review=false)=>(await pool.query(
      'SELECT memory_learning_allows($1::jsonb,$2::jsonb,$3,$4::timestamptz) AS ok',[value,context,review,at])).rows[0].ok
    expect(await allowed(null)).toBe(true)
    expect(await allowed({...learned,state:'candidate'},{activity:'status_update'})).toBe(false)
    expect(await allowed(learned,{})).toBe(false)
    expect(await allowed(learned,{activity:'status_update'})).toBe(true)
    expect(await allowed(learned,{activity:'status_update'},learned.appliesUntil)).toBe(false)
    expect(await allowed({...learned,state:'candidate'},{},undefined,true)).toBe(true)
    expect(await allowed({version:1,applicability:{}})).toBe(false)
    expect(await allowed({...learned,applicability:{unknown:'value'}})).toBe(false)
    expect(await allowed({...learned,evidenceGroups:[['00000000-0000-4000-8000-000000000001']]},{activity:'status_update'})).toBe(false)
  })
  it('includes metadata in native projections without weakening pinned dependencies',async()=>{
    const row=(await pool.query('SELECT application_memory_field_keys() AS fields, application_memory_statement_helpers_current() AS intact')).rows[0]
    expect(row.fields).toContain('learning')
    expect(row.intact).toBe(true)
  })
})


describe('[COMP:memory/learning] source-backed evidence lifecycle',()=>{
 it('selects an explicit narrow exception only in its matching context',async()=>{
  const client=await pool.connect()
  try{
   const user=await makeUser(client),workspace=await makeWorkspace(client,user),assistant=await makeAssistant(client,user,workspace)
   const memories=await import('../memories.js'),{memoryLearningSchema}=await import('@use-brian/core')
   const common={assistantId:assistant,userId:user,createdByUserId:user,sensitivity:'internal' as const,source:'user'}
   const broad=await memories.createMemory({...common,summary:'Prefers concise writing'})
   const narrow=await memories.createMemory({...common,summary:'Prefers detailed client reports',learning:memoryLearningSchema.parse({version:1,state:'established',origin:'explicit',confirmed:true,applicability:{activity:'client_report',exceptionTo:broad.id}})})
   const access={workspaceId:workspace,userId:user,assistantId:assistant,assistantKind:'standard' as const}
   expect(await memories.getMemoryById(access,broad.id)).not.toBeNull()
   expect(await memories.getMemoryById(access,narrow.id)).toBeNull()
   expect(await memories.getMemoryById({...access,memoryContext:{activity:'client_report'}},broad.id)).toBeNull()
   expect(await memories.getMemoryById({...access,memoryContext:{activity:'client_report'}},narrow.id)).not.toBeNull()
   expect(await memories.getMemoryById({...access,memoryContext:{activity:'client_report'},memoryReview:true},broad.id)).not.toBeNull()
  }finally{client.release()}
 })
 it('establishes from independent human observations and withholds invalidated support immediately',async()=>{
  const prior=process.env.BRIAN_MEMORY_LEARNING_V1;process.env.BRIAN_MEMORY_LEARNING_V1='1'
  const client=await pool.connect()
  try {
   const user=await makeUser(client),workspace=await makeWorkspace(client,user),assistant=await makeAssistant(client,user,workspace)
   const sessions=(await client.query(`INSERT INTO sessions(assistant_id,user_id,channel_type,channel_id,workspace_id) VALUES($1,$2,'web',gen_random_uuid()::text,$3),($1,$2,'web',gen_random_uuid()::text,$3) RETURNING id`,[assistant,user,workspace])).rows
   const memories=await import('../memories.js')
   const captured=[]
   for(let i=0;i<3;i++){
    const session=sessions[i===2?1:0].id,text=['That brief status summary was helpful.','The shorter status format worked well today.','The compact status update is easy to scan.'][i]
    const {addSessionMessage}=await import('../sessions.js')
    const message=await addSessionMessage({sessionId:session,role:'user',content:text,senderUserId:user,
      scope:{workspaceId:workspace,userId:user,assistantId:assistant,sensitivity:'internal',compartments:[],projectIds:[]}},client)
    const memory=await memories.createMemory({assistantId:assistant,userId:user,createdByUserId:user,sensitivity:'internal',summary:'Prefers brief status updates',sourceSessionId:session,
     observation:{userId:user,sessionId:session,messageId:message.id,text},learningProposal:{intent:'inferred',kind:'preference',quote:text,applicability:{activity:'status_update'}}})
    captured.push({memory,message})
    expect(memory.learning).toMatchObject({state:i===2?'established':'candidate',evidenceCount:i+1,independentSources:i===2?2:1})
   }
   const learning=captured[2].memory.learning
   expect(learning).toMatchObject({evidenceCount:3,independentSources:2})
   const eligible=async(value:unknown)=>(await client.query(`SELECT memory_learning_allows($1::jsonb,'{"activity":"status_update"}') AS ok`,[value])).rows[0].ok
   expect(await eligible(learning)).toBe(true)
   await client.query('UPDATE session_messages SET scope_held=true WHERE id=$1',[captured[0].message.id])
   expect(await eligible(learning)).toBe(false)
   expect(await eligible({...learning,origin:'derived'})).toBe(false)
   expect(await eligible({...learning,confirmed:true,evidenceGroups:[]})).toBe(true)
  }finally{client.release();if(prior===undefined) delete process.env.BRIAN_MEMORY_LEARNING_V1;else process.env.BRIAN_MEMORY_LEARNING_V1=prior}
 })
})
