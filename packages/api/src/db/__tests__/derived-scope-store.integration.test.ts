import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import type { ScopeSource } from '@use-brian/core'
import { createMemory, updateMemory, getMemoryById, getMemoryByIdSystem, getMemoryIndexSystem, listMemoriesWithMetrics, type Memory } from '../memories.js'
import { getPool, getAppPool } from '../client.js'
import { createDbMemoryStore } from '../memory-store.js'
import { runLightConsolidation, runREMConsolidation, runDeepConsolidation } from '@use-brian/core'
import { getSoulContext, writeScopedSummary } from '../scoped-summary-store.js'
import { addSessionMessage } from '../sessions.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
const asSource = (memory: Memory): ScopeSource => ({
  workspaceId: memory.workspaceId!, userId: memory.userId, assistantId: memory.assistantId,
  sensitivity: memory.sensitivity, compartments: memory.compartments, projectIds: memory.projectIds,
  resourceKind: 'memory', resourceId: memory.id, version: memory.scopeVersion,
})
async function fixture() {
  const workspaceId = randomUUID(), userId = randomUUID(), assistantId = randomUUID(), projectId = randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [userId])
  await pool.query(`INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Scope fixture',$2)`, [workspaceId,userId])
  await pool.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')`, [workspaceId,userId])
  await pool.query(`INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind) VALUES($1,'Fixture assistant',$2,$3,'standard')`, [assistantId,userId,workspaceId])
  for (const key of ['finance','product']) await pool.query(`INSERT INTO workspace_compartments(workspace_id,key,label) VALUES($1,$2,$2)`,[workspaceId,key])
  await pool.query(`INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Fixture','fixture',$3)`,[projectId,workspaceId,userId])
  const params = { workspaceId,userId,assistantId,createdByUserId: userId,sensitivity: 'internal' as const,summary: 'Fixture source' }
  const create = (overrides: Partial<Parameters<typeof createMemory>[0]> = {}) => createMemory({ ...params,...overrides })
  const derive = (sources: Memory[], overrides: Partial<Parameters<typeof createMemory>[0]> = {}) => create({
    summary: 'Derived fixture',sensitivity: 'public',compartments: [],projectIds: [],
    derivation: { producer: 'test-synthesis',sources: sources.map(asSource) },...overrides,
  })
  return { workspaceId,userId,assistantId,projectId,create,derive }
}

describe('[COMP:api/derived-scope-store] actual memory writes and source races', () => {
  afterAll(async () => { await getAppPool().end(); await pool.end() })

  it('persists delegated input/output from workspace-wide sources and holds them when a source changes', async () => {
    const f = await fixture(), sessionId = randomUUID()
    await pool.query(`INSERT INTO sessions(id,assistant_id,user_id,channel_type,channel_id)
      VALUES($1::uuid,$2,$3,'web',$1::uuid::text)`, [sessionId,f.assistantId,f.userId])
    const input = await f.create({ userId: null,
      sensitivity: 'confidential', compartments: ['finance'], projectIds: [f.projectId] })
    await pool.query('UPDATE memories SET assistant_id=NULL WHERE id=$1', [input.id])
    const inputSource = (await pool.query('SELECT read_scope_source($1,$2,$3) AS source',
      [f.workspaceId,'memory',input.id])).rows[0].source as ScopeSource
    const message = await addSessionMessage({ sessionId, role: 'user', content: 'Workflow question',
      derivation: { producer: 'turn:delegated-input', sources: [inputSource] } })
    const source = (await pool.query('SELECT read_scope_source($1,$2,$3) AS source',
      [f.workspaceId,'session_message',message.id])).rows[0].source as ScopeSource
    expect(source).toMatchObject({ workspaceId: f.workspaceId, userId: null, assistantId: null,
      sensitivity: 'confidential', compartments: ['finance'], projectIds: [f.projectId], version: '1' })
    const output = await addSessionMessage({ sessionId, role: 'assistant', content: 'Workflow answer',
      derivation: { producer: 'turn:delegated-output', sources: [source] } })
    const edges = (await pool.query(`SELECT s.source_id FROM scope_derivation_sources s
      JOIN scope_derivations d ON d.id=s.derivation_id WHERE d.resource_id=ANY($1::uuid[])`,
      [[message.id,output.id]])).rows.map(row => row.source_id)
    expect(edges.sort()).toEqual([input.id,message.id].sort())
    await pool.query(`UPDATE memories SET compartments=ARRAY['product'] WHERE id=$1`, [input.id])
    const rows = (await pool.query('SELECT scope_held FROM session_messages WHERE id=ANY($1::uuid[])',
      [[message.id,output.id]])).rows
    expect(rows).toEqual([{ scope_held: true }, { scope_held: true }])
    await expect(addSessionMessage({ sessionId, role: 'assistant', content: 'Stale answer',
      derivation: { producer: 'turn:delegated-output', sources: [source] } })).rejects.toThrow('scope_source_changed')
  })

  it('still rejects partial conversation scope while accepting legacy unscoped messages', async () => {
    const f = await fixture(), sessionId = randomUUID()
    await pool.query(`INSERT INTO sessions(id,assistant_id,user_id,channel_type,channel_id)
      VALUES($1::uuid,$2,$3,'web',$1::uuid::text)`, [sessionId,f.assistantId,f.userId])
    await expect(addSessionMessage({ sessionId, role: 'user', content: 'Legacy' })).resolves.toBeDefined()
    const complete = { workspace_id: f.workspaceId, sensitivity: 'internal', compartments: [],
      project_ids: [], scope_version: 1, scope_held: false }
    for (const missing of Object.keys(complete)) {
      const fields = { ...complete, [missing]: null }, columns = Object.keys(fields)
      await expect(pool.query(`INSERT INTO session_messages(session_id,role,content,sequence_num,${columns.join(',')})
        VALUES($1,'user','[]',2,${columns.map((_,i) => `$${i+2}`).join(',')})`,
        [sessionId,...Object.values(fields)])).rejects.toMatchObject({ constraint: 'session_messages_scope_complete' })
    }
  })

  it('A02/A04 persists the full floor and every edge regardless of requested lower labels', async () => {
    const f = await fixture()
    const a = await f.create({ compartments: ['product'], projectIds: [f.projectId] })
    const b = await f.create({ compartments: ['finance'], sensitivity: 'confidential' })
    const output = await f.derive([a,b])
    expect(output).toMatchObject({ sensitivity: 'confidential', compartments: ['finance','product'], projectIds: [f.projectId], userId: f.userId,assistantId: f.assistantId })
    const edges = await pool.query(`SELECT s.source_id FROM scope_derivation_sources s JOIN scope_derivations d ON d.id=s.derivation_id WHERE d.resource_id=$1`,[output.id])
    expect(edges.rows.map(r => r.source_id).sort()).toEqual([a.id,b.id].sort())
    expect((await pool.query('SELECT classification_mode FROM workspace_access_policies WHERE workspace_id=$1',[f.workspaceId])).rows[0].classification_mode).toBe('legacy')
  })

  it.each([
    ['entity','entities'],['entity_link','entity_links'],['task','tasks'],
    ['workspace_file','workspace_files'],['episode','episodes'],
    ['knowledge_entry','knowledge_entries'],['kb_chunk','kb_chunks'],
  ].flatMap(([kind,table])=>['reclassify','hold','delete'].map(change=>[kind,table,change])))('invalidates canonical %s snapshots after %s source %s',async(kind,table,change)=>{
    const f=await fixture(),id=randomUUID()
    const base={id,workspace_id:f.workspaceId,sensitivity:'confidential',compartments:['finance'],project_ids:[f.projectId]}
    const visibility=kind==='knowledge_entry'?{}:{user_id:f.userId,assistant_id:f.assistantId}
    let content:Record<string,unknown>
    if(kind==='entity')content={kind:'project',display_name:'Source project',created_by_user_id:f.userId,source:'user'}
    else if(kind==='entity_link') {
      const source=await f.create(),target=randomUUID()
      await pool.query(`INSERT INTO entities(id,kind,display_name,workspace_id,user_id,assistant_id,created_by_user_id,source) VALUES($1,'project','Linked fixture',$2,$3,$4,$3,'user')`,[target,f.workspaceId,f.userId,f.assistantId])
      content={source_kind:'memory',source_id:source.id,target_kind:'entity',target_id:target,edge_type:'mentioned',source:'user'}
    } else if(kind==='task')content={title:'Source task',created_by_user_id:f.userId}
    else if(kind==='workspace_file')content={path:'/fixture.txt',name:'fixture.txt',storage_uri:'fixture://content',created_by_user_id:f.userId}
    else if(kind==='episode')content={source_kind:'web',source_ref:{},occurred_at:new Date(),created_by_user_id:f.userId}
    else if(kind==='knowledge_entry')content={path:'fixture.md',title:'Fixture knowledge',content:'Restricted knowledge'}
    else content={chunk_text:'Restricted chunk',created_by_user_id:f.userId,source:'user'}
    const fields={...base,...visibility,...content},columns=Object.keys(fields)
    await pool.query(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(fields))
    const snapshot=(await pool.query('SELECT read_scope_source($1,$2,$3) AS source',[f.workspaceId,kind,id])).rows[0].source as ScopeSource
    const derived=await f.create({summary:'Derived from canonical source',sensitivity:'public',derivation:{producer:'source-adapter-test',sources:[snapshot]}})
    expect(derived).toMatchObject({sensitivity:'confidential',compartments:['finance'],projectIds:[f.projectId]})
    if(change==='delete')await pool.query(`DELETE FROM ${table} WHERE id=$1`,[id])
    else if(change==='hold')await pool.query(`UPDATE ${table} SET scope_held=true WHERE id=$1`,[id])
    else await pool.query(`UPDATE ${table} SET compartments=ARRAY['product'] WHERE id=$1`,[id])
    expect(await getMemoryByIdSystem(derived.id)).toBeNull()
    await expect(f.create({derivation:{producer:'stale-source-test',sources:[snapshot]}})).rejects.toThrow('scope_source_changed')
  })

  it('qualifies equal source UUIDs by kind and preserves every lineage edge',async()=>{
    const f=await fixture(),memory=await f.create()
    await pool.query(`INSERT INTO entities(id,kind,display_name,workspace_id,user_id,assistant_id,created_by_user_id,source) VALUES($1,'project','Same identifier fixture',$2,$3,$4,$3,'user')`,[memory.id,f.workspaceId,f.userId,f.assistantId])
    const entity=(await pool.query('SELECT read_scope_source($1,$2,$3) AS source',[f.workspaceId,'entity',memory.id])).rows[0].source as ScopeSource
    const output=await f.create({derivation:{producer:'mixed-source-test',sources:[asSource(memory),entity]}})
    const edges=(await pool.query('SELECT s.source_kind FROM scope_derivation_sources s JOIN scope_derivations d ON d.id=s.derivation_id WHERE d.resource_id=$1 ORDER BY source_kind',[output.id])).rows
    expect(edges).toEqual([{source_kind:'entity'},{source_kind:'memory'}])
    await pool.query(`UPDATE entities SET attributes='{"changed":true}' WHERE id=$1`,[memory.id])
    expect(await getMemoryByIdSystem(output.id)).toBeNull()
  })

  it('does not expose canonical source snapshots through the application database role',async()=>{
    const f=await fixture(),memory=await f.create(),client=await getAppPool().connect()
    try {await expect(client.query('SELECT read_scope_source($1,$2,$3)',[f.workspaceId,'memory',memory.id])).rejects.toThrow('permission denied')}
    finally{client.release()}
  })

  it('A05 rejects stale source versions before writing any output', async () => {
    const f = await fixture(), input = await f.create()
    await pool.query(`UPDATE memories SET compartments=ARRAY['finance'] WHERE id=$1`,[input.id])
    await expect(f.derive([input])).rejects.toThrow('scope_source_changed')
    expect((await pool.query(`SELECT count(*)::int n FROM memories WHERE workspace_id=$1`,[f.workspaceId])).rows[0].n).toBe(1)
  })

  it('A05 preserves the old target scope on EXTENDS even when only General sources are supplied', async () => {
    const f = await fixture(), target = await f.create({ compartments: ['finance'],sensitivity: 'confidential' }), input = await f.create()
    const result = await updateMemory(target.id,{ summary: 'Expanded',sensitivity: 'public',compartments: [],derivation: { producer: 'extends',sources: [asSource(input)] } })
    expect(result).toMatchObject({ sensitivity: 'confidential',compartments: ['finance'] })
    expect((await pool.query(`SELECT count(*)::int n FROM scope_derivation_sources s JOIN scope_derivations d ON d.id=s.derivation_id WHERE d.resource_id=$1`,[result!.id])).rows[0].n).toBe(2)
  })

  it('A08 holds all descendants on source narrowing, including for wildcard readers and workers', async () => {
    const f = await fixture(), original = await f.create()
    const first = await f.derive([original]), second = await f.derive([first])
    await pool.query(`UPDATE memories SET compartments=ARRAY['finance'] WHERE id=$1`,[original.id])
    expect(await getMemoryByIdSystem(first.id)).toBeNull()
    expect(await getMemoryByIdSystem(second.id)).toBeNull()
    const ctx = { workspaceId: f.workspaceId,userId: f.userId,assistantId: f.assistantId,assistantKind: 'primary' as const,clearance: 'confidential' as const,compartments: null }
    expect(await getMemoryById(ctx,first.id)).toBeNull()
    expect((await getMemoryIndexSystem(f.assistantId,f.userId)).map(r => r.id)).toEqual([original.id])
    // Exercise restrictive RLS using the real non-superuser app role, with ordinary wildcard authority.
    const app = new pg.Client({ connectionString: process.env.DATABASE_URL_APP })
    await app.connect()
    try {
      const role = (await app.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]
      expect(role).toEqual({ rolsuper: false,rolbypassrls: false })
      await app.query(`SELECT set_config('app.current_user_id',$1,false),set_config('app.system_bypass','false',false)`,[f.userId])
      expect((await app.query('SELECT id FROM memories WHERE id=ANY($1::uuid[])',[[first.id,second.id]])).rows).toEqual([])
    } finally { await app.end() }
    await expect(f.derive([first])).rejects.toThrow('scope_source_changed')
  })

  it('A12 rejects cross-workspace lineage references on INSERT and UPDATE', async () => {
    const f = await fixture(), foreign = await fixture()
    const original = await f.create(), output = await f.derive([original]), other = await foreign.create()
    const derivation = (await pool.query('SELECT id FROM scope_derivations WHERE resource_id=$1',[output.id])).rows[0].id
    await expect(pool.query(`INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version) VALUES($1,$2,'memory',$3,'1')`,[f.workspaceId,derivation,other.id])).rejects.toThrow('scope_source_changed')
    await expect(pool.query(`UPDATE scope_derivation_sources SET source_id=$1 WHERE derivation_id=$2`,[other.id,derivation])).rejects.toThrow('scope_source_changed')
    await expect(f.derive([other])).rejects.toThrow('scope_workspace_mismatch')
  })

  it('does not invalidate semantic versions for recall and scoring counters', async () => {
    const f = await fixture(), input = await f.create(), derived = await f.derive([input])
    await pool.query('UPDATE memories SET recall_count=recall_count+1,consolidation_score=0.7 WHERE id=$1',[input.id])
    const current = await getMemoryByIdSystem(input.id)
    expect(current!.scopeVersion).toBe(input.scopeVersion)
    expect(await getMemoryByIdSystem(derived.id)).not.toBeNull()
    await expect(f.derive([input])).resolves.toBeDefined()
  })

  it('A05 serializes source narrowing against an in-flight derived write', async () => {
    const f = await fixture(), input = await f.create()
    const writer = await pool.connect(), reclassifier = await pool.connect()
    let narrowing: Promise<pg.QueryResult> | undefined
    try {
      await writer.query('BEGIN')
      const output = await createMemory({
        assistantId: f.assistantId,userId: f.userId,workspaceId: f.workspaceId,
        createdByUserId: f.userId,summary: 'Concurrent derived fixture',sensitivity: 'public',
        derivation: { producer: 'race-fixture',sources: [asSource(input)] },
      },undefined,writer)
      // The writer holds a real row lock, so this update cannot cross its
      // validation/commit boundary. Once committed, the update holds the output.
      narrowing = reclassifier.query(`UPDATE memories SET compartments=ARRAY['finance'] WHERE id=$1`,[input.id])
      await writer.query('COMMIT')
      await narrowing
      expect(await getMemoryByIdSystem(output.id)).toBeNull()
    } finally {
      await writer.query('ROLLBACK')
      await narrowing?.catch(() => {})
      writer.release(); reclassifier.release()
    }
  })

  it('holds prior descendants during canonical source supersession', async () => {
    const f = await fixture(), input = await f.create(), output = await f.derive([input])
    const replacement = await updateMemory(input.id,{ compartments: ['finance'] })
    expect(replacement!.compartments).toEqual(['finance'])
    expect(await getMemoryByIdSystem(output.id)).toBeNull()
  })

  it('A02 executes real departmental Light and REM writers with complete evidence', async () => {
    const f = await fixture(), store = createDbMemoryStore()
    const a = await f.create({ summary: 'Identical fact',detail: 'First detail',compartments: ['finance'] })
    await f.create({ summary: 'Identical fact',detail: 'Second detail',compartments: ['finance'] })
    await f.create({ summary: 'Identical fact',detail: 'Different audience',compartments: ['product'] })
    const light = await runLightConsolidation(store,f.assistantId,f.userId)
    expect(light.memoriesAffected).toHaveLength(1)
    const merged = (await pool.query(`SELECT id,detail,compartments FROM memories WHERE workspace_id=$1 AND detail LIKE '%First detail%' AND valid_to IS NULL`,[f.workspaceId])).rows[0]
    expect(merged.detail).toContain('Second detail')
    expect(merged.detail).not.toContain('Different audience')
    expect(merged.compartments).toEqual(['finance'])
    expect(merged.id).not.toBe(a.id)
    const inputs: Memory[] = []
    for (let i=0;i<15;i++) inputs.push(await f.create({
      summary: `Fixture fact ${i}`,tags: [['process','decision','project'][i%3]],
      sensitivity: 'confidential',compartments: ['finance'],projectIds: [f.projectId],
    }))
    await runREMConsolidation(store,f.assistantId,f.userId,async () =>
      `SUMMARY: Department process insight\nDETAIL: Synthesized fixture\nCONNECTS: ${inputs[0].id.slice(0,8)}, ${inputs[1].id.slice(0,8)}`)
    const patterns = (await pool.query(`SELECT id,compartments,project_ids,sensitivity FROM memories WHERE workspace_id=$1 AND 'consolidation:rem'=ANY(tags)`,[f.workspaceId])).rows
    expect(patterns).toHaveLength(1)
    expect(patterns[0]).toMatchObject({ compartments: ['finance'],project_ids: [f.projectId],sensitivity: 'confidential' })
    const edges = await pool.query(`SELECT count(*)::int n FROM scope_derivation_sources s JOIN scope_derivations d ON d.id=s.derivation_id WHERE d.resource_id=$1`,[patterns[0].id])
    expect(edges.rows[0].n).toBe(15)
  })

  it('invalidates historical-source descendants after a metadata supersession followed by narrowing', async () => {
    const f = await fixture(), input = await f.create(), derived = await f.derive([input])
    const metadata = await updateMemory(input.id,{ confidence: 0.7 })
    expect(await getMemoryByIdSystem(derived.id)).not.toBeNull()
    await updateMemory(metadata!.id,{ compartments: ['finance'] })
    expect(await getMemoryByIdSystem(derived.id)).toBeNull()
  })

  it('A02 stores department SOUL and domains in canonical scoped rows, never global slots', async () => {
    const f = await fixture(), store = createDbMemoryStore()
    await f.create({ summary: 'Finance prefers numbered status updates',tags: ['process'],compartments: ['finance'] })
    await f.create({ summary: 'Product prefers short technical updates',tags: ['process'],compartments: ['product'] })
    const prompts: string[] = []
    await runDeepConsolidation(store,f.assistantId,f.userId,async prompt => {
      prompts.push(prompt)
      return prompt.includes('Finance prefers') ? 'Finance scoped style' : 'Product scoped style'
    },{ domainSummaryThreshold: 1 })
    expect(prompts.every(prompt => !(prompt.includes('Finance prefers') && prompt.includes('Product prefers')))).toBe(true)
    expect((await pool.query('SELECT count(*)::int n FROM user_souls WHERE assistant_id=$1',[f.assistantId])).rows[0].n).toBe(0)
    expect((await pool.query('SELECT count(*)::int n FROM domain_summaries WHERE assistant_id=$1',[f.assistantId])).rows[0].n).toBe(0)
    const slots = await pool.query('SELECT kind,count(*)::int n FROM memory_summary_slots WHERE workspace_id=$1 GROUP BY kind ORDER BY kind',[f.workspaceId])
    expect(slots.rows).toEqual([{ kind: 'domain',n: 2 },{ kind: 'soul',n: 2 }])
    expect(await getMemoryIndexSystem(f.assistantId,f.userId)).toHaveLength(2)
    expect(await listMemoriesWithMetrics(f.assistantId,f.userId)).toHaveLength(2)
    const access = { workspaceId: f.workspaceId,userId: f.userId,assistantId: f.assistantId,assistantKind: 'standard' as const,clearance: 'internal' as const,compartments: ['finance'],projectIds: null }
    const context = await getSoulContext(access)
    expect(context.content).toBe('Finance scoped style')
    expect(context.evidence.compartments).toEqual(['finance'])
    expect(context.evidence.sources).toHaveLength(1)
    expect((await getSoulContext({ ...access,compartments: [] })).content).toBeNull()
  })

  it('keeps a versioned self-profile in its own SOUL bucket and invalidates it on edit',async()=>{
    const f=await fixture(),entityId=randomUUID(),store=createDbMemoryStore()
    await pool.query(`INSERT INTO entities(id,kind,display_name,workspace_id,user_id,assistant_id,created_by_user_id,source,sensitivity,compartments,attributes)
      VALUES($1,'person','Profile fixture',$2,$3,$4,$3,'user','confidential',ARRAY['finance'],'{"self":true,"preference":"Confidential profile preference"}')`,[entityId,f.workspaceId,f.userId,f.assistantId])
    await pool.query('UPDATE users SET entity_id=$2 WHERE id=$1',[f.userId,entityId])
    await f.create({summary:'Product department preference',compartments:['product']})
    const prompts:string[]=[]
    await runDeepConsolidation(store,f.assistantId,f.userId,async prompt=>{prompts.push(prompt);return prompt.includes('Confidential profile preference')?'Confidential profile summary':'Product preference summary'})
    expect(prompts.some(p=>p.includes('Confidential profile preference'))).toBe(true)
    expect(prompts.every(p=>!(p.includes('Confidential profile preference')&&p.includes('Product department preference')))).toBe(true)
    const access={workspaceId:f.workspaceId,userId:f.userId,assistantId:f.assistantId,assistantKind:'standard' as const,clearance:'confidential' as const,compartments:['finance'],projectIds:null}
    expect((await getSoulContext(access)).content).toBe('Confidential profile summary')
    expect((await getSoulContext({...access,compartments:['product']})).content).toBe('Product preference summary')
    await pool.query(`UPDATE entities SET attributes='{"self":true,"preference":"Changed profile preference"}' WHERE id=$1`,[entityId])
    expect((await getSoulContext(access)).content).toBeNull()
    expect((await getSoulContext({...access,compartments:['product']})).content).toBe('Product preference summary')
  })

  it.each([
    ['soul', 'legacy'], ['domain', 'legacy'], ['soul', 'ready'], ['domain', 'ready'],
  ] as const)('replaces a %s summary repeatedly in %s mode without predecessor lineage', async (kind, setupState) => {
    const f = await fixture(), input = await f.create({ compartments: ['finance'] })
    await pool.query(`UPDATE workspace_access_policies SET setup_state=$2,access_mode='departments' WHERE workspace_id=$1`,[f.workspaceId,setupState])
    const write = (content: string) => writeScopedSummary({
      assistantId: f.assistantId,userId: f.userId,kind,slotKey: 'shared',content,
      derivation: { producer: `consolidation:${kind}`,sources: [asSource(input)] },
    })
    const currentId = async () => (await pool.query(
      'SELECT memory_id FROM memory_summary_slots WHERE workspace_id=$1 AND kind=$2',[f.workspaceId,kind],
    )).rows[0].memory_id as string
    let previous: string | undefined
    let dependent: Memory | undefined
    for (const content of ['First summary', 'Second summary', 'Third summary']) {
      await write(content)
      const id = await currentId(), current = await getMemoryByIdSystem(id)
      expect(current).toMatchObject({ detail: content,scopeHeld: false,validTo: null })
      expect((await pool.query(`SELECT s.source_id FROM scope_derivation_sources s
        JOIN scope_derivations d ON d.id=s.derivation_id WHERE d.resource_id=$1`,[id])).rows)
        .toEqual([{ source_id: input.id }])
      if (previous) {
        expect(id).not.toBe(previous)
        const old = (await pool.query('SELECT valid_to,superseded_by FROM memories WHERE id=$1',[previous])).rows[0]
        expect(old.valid_to).not.toBeNull()
        expect(old.superseded_by).toBe(id)
        expect(await getMemoryByIdSystem(dependent!.id)).toBeNull()
      }
      previous = id
      dependent = await f.derive([current!])
    }
    expect((await pool.query(`SELECT count(*)::int n FROM memories
      WHERE workspace_id=$1 AND tags @> ARRAY[$2]::text[] AND valid_to IS NULL`,[f.workspaceId,`consolidation:${kind}`])).rows[0].n).toBe(1)
    // Fresh summaries still inherit the actual input's invalidation.
    await pool.query('UPDATE memories SET summary=$2 WHERE id=$1',[input.id,'Changed source'])
    expect(await getMemoryByIdSystem(previous!)).toBeNull()
  })

  it('recovers a summary slot whose old update path already created predecessor lineage', async () => {
    const f = await fixture(), input = await f.create()
    const derivation = { producer: 'consolidation:soul',sources: [asSource(input)] }
    const write = (content: string) => writeScopedSummary({
      assistantId: f.assistantId,userId: f.userId,kind: 'soul',slotKey: 'shared',content,derivation,
    })
    await write('Original summary')
    const first = (await pool.query('SELECT memory_id FROM memory_summary_slots WHERE workspace_id=$1',[f.workspaceId])).rows[0].memory_id
    // Reproduce the previously deployed writer's first successful update.
    const second = await updateMemory(first,{ summary: 'Old-path update',detail: 'Old-path update',derivation })
    expect(second).not.toBeNull()
    await pool.query('UPDATE memory_summary_slots SET memory_id=$2 WHERE workspace_id=$1',[f.workspaceId,second!.id])
    expect((await pool.query(`SELECT resource_id FROM scope_descendant_memories($1,'memory',$2)`,[f.workspaceId,second!.id])).rows)
      .toContainEqual({ resource_id: second!.id })
    await write('Recovered summary')
    await write('Next healthy summary')
    const ctx = { workspaceId: f.workspaceId,userId: f.userId,assistantId: f.assistantId,assistantKind: 'standard' as const,clearance: 'confidential' as const,compartments: null }
    expect((await getSoulContext(ctx)).content).toBe('Next healthy summary')
  })

  it.each(['previous output', 'dependent'] as const)('rolls back summary replacement citing the %s', async sourceKind => {
    const f = await fixture(), input = await f.create()
    const write = (sources: ScopeSource[], content: string) => writeScopedSummary({
      assistantId: f.assistantId,userId: f.userId,kind: 'soul',slotKey: 'shared',content,
      derivation: { producer: 'consolidation:soul',sources },
    })
    await write([asSource(input)],'Original summary')
    const id = (await pool.query('SELECT memory_id FROM memory_summary_slots WHERE workspace_id=$1',[f.workspaceId])).rows[0].memory_id
    const summary = await getMemoryByIdSystem(id), dependent = await f.derive([summary!])
    const source = sourceKind === 'previous output' ? summary! : dependent
    await expect(write([asSource(source)],'Invalid circular synthesis')).rejects.toThrow('scope_source_changed')
    expect((await pool.query('SELECT memory_id FROM memory_summary_slots WHERE workspace_id=$1',[f.workspaceId])).rows[0].memory_id).toBe(id)
    expect(await getMemoryByIdSystem(id)).toMatchObject({ detail: 'Original summary',validTo: null,scopeHeld: false })
    expect(await getMemoryByIdSystem(dependent.id)).toMatchObject({ scopeHeld: false })
    expect((await pool.query(`SELECT count(*)::int n FROM memories WHERE workspace_id=$1
      AND tags @> ARRAY['consolidation:soul']::text[]`,[f.workspaceId])).rows[0].n).toBe(1)
  })

  it('A08 a scoped summary slot cannot resurrect held content and can rebuild from current evidence', async () => {
    const f = await fixture(), input = await f.create({ compartments: ['finance'] })
    const write = (memory: Memory,content: string) => writeScopedSummary({
      assistantId: f.assistantId,userId: f.userId,kind: 'soul',slotKey: 'shared',content,
      derivation: { producer: 'consolidation:soul',sources: [asSource(memory)] },
    })
    await write(input,'First scoped style')
    await pool.query('UPDATE workspace_access_policies SET classification_mode=$2 WHERE workspace_id=$1',[f.workspaceId,'review'])
    const ctx = { workspaceId: f.workspaceId,userId: f.userId,assistantId: f.assistantId,assistantKind: 'standard' as const,clearance: 'confidential' as const,compartments: null }
    await pool.query('UPDATE memories SET summary=$2 WHERE id=$1',[input.id,'Revised preference'])
    expect((await getSoulContext(ctx)).content).toBeNull()
    const current = await getMemoryByIdSystem(input.id)
    await write(current!,'Rebuilt scoped style')
    expect((await getSoulContext(ctx)).content).toBe('Rebuilt scoped style')
    expect((await pool.query('SELECT count(*)::int n FROM memory_summary_slots WHERE workspace_id=$1',[f.workspaceId])).rows[0].n).toBe(1)
  })
})
