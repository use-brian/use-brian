import { randomUUID } from 'node:crypto'
import { afterAll,describe,expect,it } from 'vitest'
import { getPool,getAppPool,queryWithRLS,applyRLSGucs } from '../client.js'
import { runWithAgentAccess } from '../agent-access-context.js'
import { buildAccessPredicate } from '../access-predicate.js'
import { createMemory,updateMemory,deleteMemory } from '../memories.js'
import { createAuthorityLease, runWithAuthorityLease, executeWithCurrentAuthority } from '../../context-scope/authority-lease.js'
import { resolveLiveAccessCeilingSystem } from '../../context-scope/resolve-turn-scope.js'
import { findAssistantById } from '../users.js'
import { getWorkspaceRoleSystem } from '../workspace-store.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool()
async function fixture(){
  const workspaceId=randomUUID(),actor=randomUUID(),owner=randomUUID(),caller=randomUUID(),callee=randomUUID()
  for(const id of [actor,owner])await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Delegation fixture',$2)",[workspaceId,owner])
  for(const id of [actor,owner])await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspaceId,id])
  for(const id of [caller,callee])await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind) VALUES($1,'Fixture assistant',$2,$3,'standard')",[id,owner,workspaceId])
  const rows: [string,string|null,string|null][] = [['shared',null,null],['caller',null,caller],['callee',null,callee],['actor',actor,null],['owner',owner,null]]
  for(const [summary,userId,assistantId] of rows){
    const memory = await createMemory({ workspaceId, userId, assistantId: assistantId ?? caller,
      createdByUserId: owner, summary, sensitivity: 'internal' })
    // Represent legacy unpartitioned rows while retaining canonical authorship.
    if (assistantId === null) await pool.query('UPDATE memories SET assistant_id=NULL WHERE id=$1',[memory.id])
  }
  const context={workspaceId,userId:actor,assistantId:callee,assistantKind:'primary' as const,clearance:'confidential' as const,compartments:null,projectIds:null}
  const access={workspaceId,userId:actor,clearance:'internal' as const,compartments:null,projectIds:null,visibilityAssistantIds:[caller]}
  async function read(ctx=context){const p=buildAccessPredicate(ctx);return(await pool.query(`SELECT summary FROM memories WHERE ${p.sql} ORDER BY summary`,p.params)).rows.map(r=>r.summary)}
  return {workspaceId,actor,owner,caller,callee,context,access,read}
}
describe('[COMP:api/agent-access-ceiling] real delegated visibility predicates and RLS',()=>{
  afterAll(async()=>{await getAppPool().end();await pool.end()})
  it('invalidates a live lease when real membership clearance contracts during an operation', async () => {
    const f = await fixture()
    await pool.query("UPDATE workspace_members SET role='member',clearance='internal' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.actor])
    const resolve = async () => {
      if (!await getWorkspaceRoleSystem(f.actor, f.workspaceId)) return null
      const assistant = await findAssistantById(f.caller)
      return assistant ? resolveLiveAccessCeilingSystem({ userId:f.actor, workspaceId:f.workspaceId, assistant }) : null
    }
    const starting = await resolve()
    expect(starting?.clearance).toBe('internal')
    const lease = createAuthorityLease(starting!, resolve)
    await lease.assertCurrent()
    await expect(runWithAuthorityLease(lease, () => executeWithCurrentAuthority(async () => {
      await pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.actor])
      return 'Previously authorized result'
    }))).rejects.toMatchObject({ reason:'authority_changed', operationMayHaveExecuted:true })
    await pool.query("UPDATE workspace_members SET clearance='internal' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.actor])
    await expect(lease.assertCurrent()).rejects.toMatchObject({ reason:'authority_changed' })
  })
  it('does not let a primary callee widen the caller assistant visibility',async()=>{
    const f=await fixture()
    expect(await runWithAgentAccess(f.access,()=>f.read())).toEqual(['actor','caller','shared'])
    expect(await runWithAgentAccess({...f.access,visibilityAssistantIds:[]},()=>f.read())).toEqual(['actor','shared'])
  })
  it('prevents a reconstructed owner context from reading owner-private rows',async()=>{
    const f=await fixture()
    expect(await runWithAgentAccess(f.access,()=>f.read({...f.context,userId:f.owner}))).toEqual(['caller','shared'])
    expect(await runWithAgentAccess(f.access,()=>f.read({...f.context,workspaceId:randomUUID()}))).toEqual([])
  })
  it('enforces the ceiling on raw application-role reads and writes',async()=>{
    const f=await fixture()
    await runWithAgentAccess(f.access,async()=>{
      const rows=(await queryWithRLS<{summary:string}>(f.actor,'SELECT summary FROM memories WHERE workspace_id=$1 ORDER BY summary',[f.workspaceId])).rows.map(r=>r.summary)
      expect(rows).toEqual(['actor','caller','shared'])
      await expect(queryWithRLS(f.actor,"UPDATE memories SET assistant_id=$2 WHERE workspace_id=$1 AND summary='shared'",[f.workspaceId,f.callee])).rejects.toThrow(/row-level security/)
    })
    // Transaction-local state must not survive on the next pooled connection.
    const rows=(await queryWithRLS<{summary:string}>(f.actor,'SELECT summary FROM memories WHERE workspace_id=$1',[f.workspaceId])).rows.map(r=>r.summary)
    expect(rows).toContain('callee')
  })
  it('permits reads but rejects source and destination mutations outside the independent grant',async()=>{
    const f=await fixture();
    const records=[];
    for(const compartment of ['product','finance'])records.push(await createMemory({workspaceId:f.workspaceId,userId:f.actor,assistantId:f.caller,createdByUserId:f.actor,summary:compartment,sensitivity:'internal',compartments:[compartment]}));
    const [product,finance]=records;
    const access={...f.access,compartments:['product','finance'],mutationCompartments:['product']};
    await runWithAgentAccess(access,async()=>{
      const rows=await queryWithRLS<{id:string}>(f.actor,'SELECT id FROM memories WHERE id=ANY($1::uuid[])',[[product.id,finance.id]]);
      expect(rows.rows).toHaveLength(2);
      const read=buildAccessPredicate({...f.context,compartments:['product','finance'],mutationCompartments:['product']});
      const mutation=buildAccessPredicate({...f.context,compartments:['product','finance'],mutationCompartments:['product']},{operation:'mutation'});
      expect((await pool.query(`SELECT id FROM memories WHERE ${read.sql} AND id=$${read.nextIdx}`,[...read.params,finance.id])).rows).toHaveLength(1);
      expect((await pool.query(`SELECT id FROM memories WHERE ${mutation.sql} AND id=$${mutation.nextIdx}`,[...mutation.params,finance.id])).rows).toHaveLength(0);
      expect((await queryWithRLS(f.actor,"UPDATE memories SET summary='Changed' WHERE id=$1 RETURNING id",[finance.id])).rows).toHaveLength(0);
      expect((await queryWithRLS(f.actor,'DELETE FROM memories WHERE id=$1 RETURNING id',[finance.id])).rows).toHaveLength(0);
      await expect(queryWithRLS(f.actor,"UPDATE memories SET compartments=ARRAY['finance'] WHERE id=$1",[product.id])).rejects.toThrow(/row-level security/);
      expect((await queryWithRLS(f.actor,"UPDATE memories SET summary='Authorized edit' WHERE id=$1 RETURNING id",[product.id])).rows).toHaveLength(1);
    });
    // Exercise the canonical INSERT with an app-role transaction whose GUCs
    // remain pinned after leaving ALS, so RLS itself must refuse the write.
    const client=await getAppPool().connect();
    try{
      await client.query('BEGIN');
      await runWithAgentAccess(access,()=>applyRLSGucs(client,f.actor));
      await expect(createMemory({workspaceId:f.workspaceId,userId:f.actor,assistantId:f.caller,createdByUserId:f.actor,
        summary:'Unapproved source',sensitivity:'internal',compartments:['finance']},undefined,client)).rejects.toThrow(/row-level security/);
      await client.query('ROLLBACK');
    }finally{client.release()}
    expect((await queryWithRLS(f.actor,"UPDATE memories SET summary='Ordinary owner edit' WHERE id=$1 RETURNING id",[finance.id])).rows).toHaveLength(1);
  })
  it('allows a protected derived create but never uses its read grant to edit a canonical source',async()=>{
    const f=await fixture();
    const original=await createMemory({workspaceId:f.workspaceId,userId:f.actor,assistantId:f.caller,createdByUserId:f.actor,summary:'Source',sensitivity:'internal',compartments:['finance']});
    const ordinary=await createMemory({workspaceId:f.workspaceId,userId:f.actor,assistantId:f.caller,createdByUserId:f.actor,summary:'Editable source',sensitivity:'internal',compartments:['product']});
    const source=(await pool.query('SELECT read_scope_source($1,$2,$3) source',[f.workspaceId,'memory',original.id])).rows[0].source;
    await runWithAgentAccess({...f.access,compartments:['finance','product'],mutationCompartments:['product']},async()=>{
      await expect(updateMemory(original.id,{summary:'Forbidden edit'},f.context)).resolves.toBeNull();
      await expect(updateMemory(original.id,{summary:'Bypass by omitted context'})).rejects.toMatchObject({code:'scope_operation_denied'});
      await expect(deleteMemory(original.id)).rejects.toMatchObject({code:'scope_operation_denied'});
      const supplied=await pool.connect();
      try{
        await supplied.query('BEGIN');
        await expect(deleteMemory(original.id,undefined,supplied)).rejects.toMatchObject({code:'scope_operation_denied'});
        await supplied.query('ROLLBACK');
      }finally{supplied.release()}
      await expect(updateMemory(ordinary.id,{compartments:['finance']},f.context)).rejects.toMatchObject({code:'scope_operation_denied'});
      const params={workspaceId:f.workspaceId,userId:f.actor,assistantId:f.caller,createdByUserId:f.actor,summary:'Protected derivative',sensitivity:'internal' as const,compartments:['finance']};
      await expect(createMemory(params)).rejects.toMatchObject({code:'scope_operation_denied'});
      const result=await createMemory({...params,derivation:{producer:'fixture',sources:[source]}});
      expect(result).toMatchObject({compartments:['finance'],userId:f.actor,createdByUserId:f.actor});
      await expect(createMemory({...params,createdByUserId:f.owner,derivation:{producer:'fixture',sources:[source]}})).rejects.toMatchObject({code:'scope_operation_denied'});
      const authored=await createMemory({...params,compartments:['product'],summary:'Fresh authored source'});
      const changed=await updateMemory(authored.id,{summary:'Authorized replacement'},f.context);
      expect(changed?.summary).toBe('Authorized replacement');
      expect(await deleteMemory(changed!.id)).toBe(true);
    });
    expect((await pool.query('SELECT summary,valid_to FROM memories WHERE id=$1',[original.id])).rows[0]).toEqual({summary:'Source',valid_to:null});
    await pool.query('UPDATE memories SET scope_held=true WHERE id=$1',[ordinary.id]);
    await runWithAgentAccess({...f.access,mutationCompartments:null},async()=>{
      await expect(updateMemory(ordinary.id,{summary:'Held edit'})).rejects.toMatchObject({code:'scope_operation_denied'});
      await expect(deleteMemory(ordinary.id)).rejects.toMatchObject({code:'scope_operation_denied'});
    });
  })
  it('registers mutation checks on every canonical table and fails closed on malformed database grants',async()=>{
    const expected=['memories','memories_shadow','entities','entity_links','tasks','workspace_files','episodes','knowledge_entries','kb_chunks'].sort();
    for(const command of ['INSERT','UPDATE','DELETE']){
      const rows=(await pool.query<{tablename:string}>("SELECT tablename FROM pg_policies WHERE policyname=$1 AND permissive='RESTRICTIVE' AND cmd=$2 ORDER BY tablename",['execution_mutation_'+command.toLowerCase(),command])).rows;
      expect(rows.map(row=>row.tablename)).toEqual(expected);
    }
    const client=await getAppPool().connect();
    try{
      await client.query('BEGIN');
      for(const value of ['{}','[42]','invalid','"product"']){
        await client.query("SELECT set_config('app.agent_mutation_compartments',$1,true)",[value]);
        expect((await client.query("SELECT agent_mutation_scope_allows(ARRAY['product']) allowed")).rows[0].allowed).toBe(false);
      }
      await client.query('ROLLBACK');
    }finally{client.release()}
  })

})
