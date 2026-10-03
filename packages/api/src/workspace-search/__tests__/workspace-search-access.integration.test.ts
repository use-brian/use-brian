import { createMemory } from '../../db/memories.js'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { getAppPool, getPool, queryWithRLS } from '../../db/client.js'
import { createSearchAdapters, readSearchItem } from '../adapters.js'
import { createWorkspaceSearchService } from '../service.js'
import { projectOfficeSearchBatch } from '../office-projection.js'
import type { WorkspaceSearchFamily } from '@use-brian/shared'
import { encodeOfficeState, officeStateVector, snapshotToYDoc } from '@use-brian/office-model'
import { officeSearchFixture } from './office-fixtures.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
const q = (sql: string, values: unknown[] = []) => pool.query(sql,values)
const sources = createSearchAdapters()
const search = createWorkspaceSearchService(sources)
afterAll(async () => { await getAppPool().end(); await pool.end() })

async function fixture() {
  const userId=randomUUID(),other=randomUUID(),workspaceId=randomUUID(),foreign=randomUUID(),assistant=randomUUID()
  for (const id of [userId,other]) await q('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[id])
  await q("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Search fixture',$3),($2,'Other fixture',$4)",[workspaceId,foreign,userId,other])
  await q("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential'),($1,$3,'member','internal'),($4,$3,'owner','confidential')",[workspaceId,userId,other,foreign])
  await q("INSERT INTO assistants(id,name,workspace_id,kind,clearance) VALUES($1,'Fixture assistant',$2,'primary','confidential')",[assistant,workspaceId])
  return {userId,other,workspaceId,foreign,assistant}
}

async function run(f: { userId:string;workspaceId:string },kind:WorkspaceSearchFamily,query='needle') {
  return sources[kind]({...f,query,offset:0,limit:50,signal:new AbortController().signal})
}

describe('[COMP:search/workspace-service] Real PostgreSQL search authority and source coverage', () => {
  it('uses a non-owner, non-bypass role for every user query',async()=>{
    const f=await fixture()
    expect((await queryWithRLS(f.userId,'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows)
      .toEqual([{rolsuper:false,rolbypassrls:false}])
  })

  it('searches task descriptions and completed tasks, excludes foreign, retracted and private rows',async()=>{
    const f=await fixture()
    const insert=async(w:string,owner:string|null,title:string,status='done')=>(await q(`INSERT INTO tasks(workspace_id,user_id,title,status,attributes,created_by_user_id)
      VALUES($1,$2,$3,$4,'{"description":"needle body"}',$5) RETURNING id`,[w,owner,title,status,f.userId])).rows[0].id
    const visible=await insert(f.workspaceId,null,'Completed task')
    await insert(f.foreign,null,'Foreign needle')
    await insert(f.workspaceId,f.other,'Private needle')
    const deleted=await insert(f.workspaceId,null,'Deleted needle')
    await q('UPDATE tasks SET retracted_at=now() WHERE id=$1',[deleted])
    expect(await run(f,'tasks')).toMatchObject([{id:visible,status:'done',match:'body',snippet:'Completed task needle body'}])
    const forbidden=await search({userId:f.userId,workspaceId:f.foreign},{q:'needle',kind:'tasks'})
    expect(forbidden.items).toEqual([])
  })

  it('applies live department edges and clearance even for a workspace owner and clears revoked matches',async()=>{
    const f=await fixture(),department=randomUUID(),key=`team:${department}`
    await q(`INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key)
      VALUES($1,$2,'Fixture department',$3,'team',$1::uuid::text,$4)`,[department,f.workspaceId,f.other,key])
    await q(`INSERT INTO workspace_compartments(workspace_id,key,label,created_by,managed_by,managed_ref_id)
      VALUES($1,$2,'Fixture department',$3,'team',$4)`,[f.workspaceId,key,f.other,department])
    const id=(await q(`INSERT INTO tasks(workspace_id,title,sensitivity,compartments,created_by_user_id)
      VALUES($1,'needle confidential','confidential',$2,$3) RETURNING id`,[f.workspaceId,[key],f.other])).rows[0].id
    expect(await run(f,'tasks')).toEqual([])
    await q("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'internal','store')",[f.workspaceId,department,f.userId])
    expect(await run(f,'tasks')).toEqual([])
    await q("UPDATE department_edges SET clearance='confidential' WHERE department_id=$1 AND user_id=$2",[department,f.userId])
    expect((await run(f,'tasks')).map(row=>row.id)).toEqual([id])
    expect(await readSearchItem(f,'tasks',`task:${id}`,new AbortController().signal)).toMatchObject({id,text:'needle confidential'})
    await q('DELETE FROM department_edges WHERE department_id=$1 AND user_id=$2',[department,f.userId])
    expect(await readSearchItem(f,'tasks',`task:${id}`,new AbortController().signal)).toBeNull()
    expect(await run(f,'tasks')).toEqual([])
  })

  it('searches canonical Page block text while keeping other users drafts private',async()=>{
    const f=await fixture()
    const insert=async(owner:string,state:string)=>(await q(`INSERT INTO saved_views(workspace_id,created_by,name,entity,view_type,binding,state,page)
      VALUES($1,$2,'Page title','tasks','table','{}',$3,'{"blocks":[{"type":"paragraph","text":"needle body"}]}') RETURNING id`,[f.workspaceId,owner,state])).rows[0].id
    const saved=await insert(f.userId,'saved'),draft=await insert(f.userId,'draft')
    await insert(f.other,'draft')
    expect((await run(f,'pages')).map(row=>row.id).sort()).toEqual([saved,draft].sort())
  })

  it('searches memories and entry bodies, folds chunks into their canonical knowledge entry',async()=>{
    const f=await fixture()
    const memory=(await createMemory({assistantId:f.assistant,workspaceId:f.workspaceId,userId:f.userId,summary:'Memory title',detail:'needle memory',createdByUserId:f.userId,sensitivity:'internal'})).id
    const entry=(await q("INSERT INTO knowledge_entries(workspace_id,path,title,content,created_by) VALUES($1,'fixture.md','Entry title','needle entry',$2) RETURNING id",[f.workspaceId,f.userId])).rows[0].id
    for(let i=0;i<3;i++)await q("INSERT INTO kb_chunks(workspace_id,source_path,chunk_index,chunk_text,title,created_by_user_id,user_id,source) VALUES($1,'fixture.md',$2,'needle chunk','Entry title',$3,$3,'user')",[f.workspaceId,i,f.userId])
    const found=await run(f,'knowledge')
    expect(found.map(row=>row.id).sort()).toEqual([memory,entry].sort())
    expect(found.find(row=>row.id===entry)?.target).toEqual({type:'knowledge',id:entry,path:'fixture.md'})
  })

  it('searches people, companies, deals and custom/operator record text without collapsing equal titles',async()=>{
    const f=await fixture(),ids:string[]=[]
    for(const kind of ['person','company','deal','project'])ids.push((await q(`INSERT INTO entities(workspace_id,kind,display_name,attributes,source,created_by_user_id)
      VALUES($1,$2,'Same title','{"description":"needle body"}','user',$3) RETURNING id`,[f.workspaceId,kind,f.userId])).rows[0].id)
    const type=(await q(`INSERT INTO entity_types(workspace_id,name,properties,created_by)
      VALUES($1,'Fixture records','[{"name":"title","config":{"kind":"text"}}]',$2) RETURNING id`,[f.workspaceId,f.userId])).rows[0].id
    ids.push((await q(`INSERT INTO entity_instances(workspace_id,entity_type_id,data,created_by,last_edited_by)
      VALUES($1,$2,'{"title":{"kind":"text","value":"Same title"},"body":{"kind":"text","value":"needle body"}}',$3,$3) RETURNING id`,[f.workspaceId,type,f.userId])).rows[0].id)
    expect((await run(f,'records')).map(row=>row.id).sort()).toEqual(ids.sort())
  })

  it('searches workflow descriptions and titles without exposing definitions or webhook secrets',async()=>{
    const f=await fixture()
    const id=(await q(`INSERT INTO workflows(workspace_id,created_by,name,description,definition,enabled)
      VALUES($1,$2,'Workflow title','needle description','{"secret":"hidden credential"}',false) RETURNING id`,[f.workspaceId,f.userId])).rows[0].id
    expect(await run(f,'workflows')).toMatchObject([{id,snippet:'needle description',target:{type:'workflow',id}}])
    expect(await run(f,'workflows','credential')).toEqual([])
  })

  it('keeps a pending Office projection partial instead of returning an empty complete result',async()=>{
    const f=await fixture()
    await q("INSERT INTO office_artifacts(workspace_id,family,title,creator_user_id,owner_user_id,capability_version,sensitivity) VALUES($1,'document','needle Office',$2,$2,1,'internal')",[f.workspaceId,f.userId])
    expect(await search(f,{q:'needle',kind:'office'})).toMatchObject({items:[],completeness:'partial',unavailableFamilies:['office']})
    await projectOfficeSearchBatch(async()=>null)
    expect(await run(f,'office')).toHaveLength(1)
  })

  it('searches extracted file text and recording transcripts once per canonical artifact',async()=>{
    const f=await fixture()
    const file=(await q(`INSERT INTO workspace_files(workspace_id,name,path,storage_uri,created_by_user_id,user_id)
      VALUES($1,'Fixture text','/fixture.txt','fixture://text',$2,$2) RETURNING id`,[f.workspaceId,f.userId])).rows[0].id
    for(let i=0;i<3;i++)await q(`INSERT INTO file_segments(workspace_id,file_id,segment_index,char_start,char_end,content,user_id,created_by_user_id)
      VALUES($1,$2,$3,0,20,'needle extracted text',$4,$4)`,[f.workspaceId,file,i,f.userId])
    const episode=(await q(`INSERT INTO episodes(workspace_id,source_kind,occurred_at,user_id,assistant_id,summary_text,source_ref,created_by_user_id)
      VALUES($1,'recording',now(),$2,$3,'Recording fixture','{}',$2) RETURNING id`,[f.workspaceId,f.userId,f.assistant])).rows[0].id
    await q(`INSERT INTO recordings(id,workspace_id,title,mime,gcs_key,user_id,created_by_user_id)
      VALUES($1,$2,'Recording fixture','audio/wav','fixture.wav',$3,$3)`,[episode,f.workspaceId,f.userId])
    for(let i=0;i<3;i++)await q(`INSERT INTO transcript_segments(workspace_id,recording_id,segment_index,start_ms,end_ms,segment_text,user_id,created_by_user_id)
      VALUES($1,$2,$3,0,1000,'needle transcript',$4,$4)`,[f.workspaceId,episode,i,f.userId])
    expect((await run(f,'files')).map(row=>row.id).sort()).toEqual([file,episode].sort())
    await q('UPDATE workspace_files SET user_id=$2 WHERE id=$1',[file,f.other])
    expect((await run(f,'files')).map(row=>row.id)).toEqual([episode])
  })

  it('searches visible Personal/shared messages but never another persons Personal chat, reasoning or tool payloads',async()=>{
    const f=await fixture()
    const session=async(owner:string,visibility:string,title='Conversation fixture')=>(await q(`INSERT INTO sessions(assistant_id,user_id,channel_type,channel_id,workspace_id,visibility,title,effective_clearance,app_origin)
      VALUES($1,$2,'web',$3,$4,$5,$6,'internal','chat') RETURNING id`,[f.assistant,owner,randomUUID(),f.workspaceId,visibility,title])).rows[0].id
    const message=async(id:string,owner:string|null,content:unknown)=>(await q(`INSERT INTO session_messages(session_id,role,content,sequence_num,workspace_id,user_id,assistant_id,sensitivity,compartments,project_ids,scope_version,scope_held)
      VALUES($1,'assistant',$2,1,$3,$4,$5,'internal','{}','{}',1,false) RETURNING id`,[id,JSON.stringify(content),f.workspaceId,owner,f.assistant])).rows[0].id
    const personal=await session(f.userId,'owner'),privateOther=await session(f.other,'owner'),shared=await session(f.other,'workspace')
    await message(personal,f.userId,[{type:'text',text:'needle personal reply'}])
    await message(privateOther,f.other,[{type:'text',text:'needle other private reply'}])
    await message(shared,null,[{type:'text',text:'needle shared reply'}])
    const hidden=await session(f.userId,'owner')
    await message(hidden,f.userId,[{type:'thinking',thinking:'needle hidden reasoning'},{type:'tool_use',name:'secret',input:{value:'needle credential'}},{type:'text',text:'needle private narration'}])
    expect((await run(f,'conversations')).map(row=>row.id).sort()).toEqual([personal,shared].sort())
    expect(await run(f,'conversations','credential')).toEqual([])
    await q("UPDATE sessions SET effective_clearance='confidential' WHERE id=$1",[shared])
    expect((await run({...f,userId:f.other},'conversations')).map(row=>row.id)).toEqual([privateOther])
  })

  it.each(['document','presentation','spreadsheet'] as const)('projects persisted %s text and rechecks source ACLs on every search',async family=>{
    const f=await fixture()
    const id=(await q(`INSERT INTO office_artifacts(workspace_id,family,title,creator_user_id,owner_user_id,capability_version,sensitivity)
      VALUES($1,$2,'Office fixture',$3,$3,1,'internal') RETURNING id`,[f.workspaceId,family,f.userId])).rows[0].id
    const doc=snapshotToYDoc(officeSearchFixture(family,id,f.workspaceId))
    await q(`INSERT INTO office_collab_documents(artifact_id,workspace_id,ydoc,state_vector,canonical_hash,base_version)
      VALUES($1,$2,$3,$4,$5,0)`,[id,f.workspaceId,Buffer.from(encodeOfficeState(doc)),Buffer.from(officeStateVector(doc)),'a'.repeat(64)])
    doc.destroy()
    await projectOfficeSearchBatch(async()=>null)
    expect(await run(f,'office')).toMatchObject([{id,snippet:expect.stringContaining('needle Office body'),target:{type:'office',id,family}}])
    const file=(await q("INSERT INTO workspace_files(workspace_id,name,path,storage_uri,created_by_user_id) VALUES($1,'snapshot.json',$2,'fixture://snapshot',$3) RETURNING id",[f.workspaceId,`/snapshot-${id}.json`,f.userId])).rows[0].id
    const version=(await q(`INSERT INTO office_artifact_versions(artifact_id,workspace_id,version,snapshot_file_id,snapshot_hash,operation_clock,schema_version,capability_version,author_type,origin)
      VALUES($1,$2,1,$3,$4,''::bytea,1,1,'user','manual') RETURNING id`,[id,f.workspaceId,file,'a'.repeat(64)])).rows[0].id
    const department=randomUUID(),key=`team:${department}`
    await q(`INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key)
      VALUES($1,$2,'Fixture source department',$3,'team',$1::uuid::text,$4)`,[department,f.workspaceId,f.other,key])
    await q(`INSERT INTO workspace_compartments(workspace_id,key,label,created_by,managed_by,managed_ref_id)
      VALUES($1,$2,'Fixture source department',$3,'team',$4)`,[f.workspaceId,key,f.other,department])
    const source=(await q(`INSERT INTO office_artifact_sources(artifact_id,artifact_version_id,workspace_id,source_kind,source_id,sensitivity,required_compartments)
      VALUES($1,$2,$3,'user_attested','fixture','internal',$4) RETURNING id`,[id,version,f.workspaceId,[key]])).rows[0].id
    expect(await run(f,'office')).toEqual([])
    expect((await queryWithRLS(f.userId,'SELECT body FROM workspace_search_office_text WHERE artifact_id=$1',[id])).rows).toEqual([])
    await q('UPDATE office_artifact_sources SET retracted_at=now() WHERE id=$1',[source])
    // Canonical source inheritance raises the root permanently; retraction alone cannot declassify it.
    expect(await run(f,'office')).toEqual([])
    await q("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'internal','store')",[f.workspaceId,department,f.userId])
    expect(await run(f,'office')).toHaveLength(1)
    await q("INSERT INTO office_artifact_grants(artifact_id,workspace_id,user_id,role) VALUES($1,$2,$3,'deny')",[id,f.workspaceId,f.userId])
    expect(await run(f,'office')).toEqual([])
  })

  it('enumerates stable real source pages without repeats and ranks Unicode/CJK titles ahead of body matches',async()=>{
    const f=await fixture(),expected:string[]=[]
    for(let i=0;i<17;i++) {
      expected.push((await q("INSERT INTO tasks(workspace_id,title,created_by_user_id) VALUES($1,$2,$3) RETURNING id",[f.workspaceId,`needle ${i}`,f.userId])).rows[0].id)
      expected.push((await q("INSERT INTO workflows(workspace_id,created_by,name,definition) VALUES($1,$2,$3,'{}') RETURNING id",[f.workspaceId,f.userId,`needle ${i}`])).rows[0].id)
    }
    const actual:string[]=[]
    let cursor:string|undefined
    do {
      const page=await search(f,{q:'needle',limit:5,cursor})
      expect(page.completeness).toBe('complete')
      actual.push(...page.items.map(item=>item.id))
      cursor=page.nextCursor??undefined
      expect(actual.length).toBeLessThanOrEqual(expected.length)
    } while(cursor)
    expect(actual.sort()).toEqual(expected.sort())
    await q(`INSERT INTO tasks(workspace_id,title,attributes,created_by_user_id)
      VALUES($1,'ＡＴＬＡＳ','{}',$2),($1,'季度產品計劃','{}',$2),($1,'A weak suggestion','{"description":"產品"}',$2)`,[f.workspaceId,f.userId])
    expect((await run(f,'tasks','atlas'))[0]?.match).toBe('exact')
    expect((await run(f,'tasks','產品')).map(item=>item.match)).toEqual(['tokens','body'])
    expect(await run(f,'tasks','%')).toEqual([])
  })
})
