import {randomUUID} from 'node:crypto'
import {afterAll,describe,it,expect} from 'vitest'
import {getPool,getAppPool,queryWithRLS,runWithAgentAccess} from '../../db/client.js'
import {createDbWorkspaceGroupStore} from '../../db/workspace-group-store.js'
import {officeArtifactStore} from '../../db/office-artifacts.js'
import {readOfficeClassification,restrictOfficeClassification} from '../classification.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool()
afterAll(async()=>{await getAppPool().end();await pool.end()})
async function fixture(){
  const owner=randomUUID(),reader=randomUUID(),workspace=randomUUID()
  for(const id of [owner,reader])await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Office boundary fixture',$2,false)",[workspace,owner])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential'),($1,$3,'member','confidential')",[workspace,owner,reader])
  const groups=createDbWorkspaceGroupStore()
  const a=await groups.createTeam(owner,workspace,{name:'Operations',key:'operations'})
  const b=await groups.createTeam(owner,workspace,{name:'Planning',key:'planning'})
  for(const user of [owner,reader])await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store') ON CONFLICT (department_id,user_id) WHERE user_id IS NOT NULL DO UPDATE SET clearance='confidential'",[workspace,a.id,user])
  await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store') ON CONFLICT (department_id,user_id) WHERE user_id IS NOT NULL DO UPDATE SET clearance='confidential'",[workspace,b.id,owner])
  await pool.query('DELETE FROM department_edges WHERE department_id=$1 AND user_id=$2',[b.id,reader])
  // No owner bypass under v2; both permissions above are real membership edges.
  await pool.query("UPDATE workspace_access_policies SET setup_state='ready',access_mode='departments' WHERE workspace_id=$1",[workspace])
  await pool.query('UPDATE workspaces SET department_read_v2=true WHERE id=$1',[workspace])
  const artifact=await officeArtifactStore.createShell({userId:owner,workspaceId:workspace,family:'document',title:'Plan',templateVersionId:null,capabilityVersion:1,sensitivity:'internal'}, {provenance:{kind:'human_authored_root',actorUserId:owner,workspaceId:workspace},destination:{kind:'department',departmentId:a.id}})
  return {owner,reader,workspace,a,b,artifact}
}
describe('[COMP:api/office-classification] departmental Office classification (PG)',()=>{
  it('preserves existing departments, checks revision, records history and removes excluded readers',async()=>{
    const f=await fixture(),before=await readOfficeClassification(f.owner,f.artifact.id)
    expect(await readOfficeClassification(f.reader,f.artifact.id)).not.toBeNull()
    await restrictOfficeClassification(f.owner,{artifactId:f.artifact.id,expectedRevision:before!.revision,departmentId:f.b.id,sensitivity:'confidential'})
    const after=await readOfficeClassification(f.owner,f.artifact.id)
    expect(after?.compartments.sort()).toEqual([f.a.compartmentKey,f.b.compartmentKey].sort())
    expect(after?.sensitivity).toBe('confidential');expect(after?.history).toHaveLength(1)
    expect(await readOfficeClassification(f.reader,f.artifact.id)).toBeNull()
    await expect(restrictOfficeClassification(f.owner,{artifactId:f.artifact.id,expectedRevision:before!.revision,sensitivity:'confidential'})).rejects.toMatchObject({code:'office_classification_changed'})
    await expect(restrictOfficeClassification(f.owner,{artifactId:f.artifact.id,expectedRevision:after!.revision,sensitivity:'internal'})).rejects.toMatchObject({code:'office_classification_floor'})
  })
  it('refuses member edits and revoked destination membership without an audit/write',async()=>{
    const f=await fixture(),before=await readOfficeClassification(f.owner,f.artifact.id)
    await expect(restrictOfficeClassification(f.reader,{artifactId:f.artifact.id,expectedRevision:before!.revision,sensitivity:'confidential'})).rejects.toMatchObject({status:404})
    await pool.query('INSERT INTO department_owners(workspace_id,department_id,user_id) VALUES($1,$2,$3)',[f.workspace,f.b.id,f.reader])
    await pool.query('DELETE FROM department_owners WHERE department_id=$1 AND user_id=$2',[f.b.id,f.owner])
    await pool.query('DELETE FROM department_edges WHERE department_id=$1 AND user_id=$2',[f.b.id,f.owner])
    await expect(restrictOfficeClassification(f.owner,{artifactId:f.artifact.id,expectedRevision:before!.revision,departmentId:f.b.id,sensitivity:'confidential'})).rejects.toMatchObject({status:404})
    expect((await readOfficeClassification(f.owner,f.artifact.id))?.history).toHaveLength(0)
  })
  it('uses department clearance above the legacy base and refuses expired membership',async()=>{
    const f=await fixture()
    await pool.query("UPDATE workspace_members SET clearance='public',team_scope_mode='assigned' WHERE workspace_id=$1 AND user_id=$2",[f.workspace,f.reader])
    await pool.query("UPDATE department_edges SET clearance='confidential' WHERE department_id=$1 AND user_id=$2",[f.a.id,f.reader])
    const before=await readOfficeClassification(f.owner,f.artifact.id)
    await restrictOfficeClassification(f.owner,{artifactId:f.artifact.id,expectedRevision:before!.revision,sensitivity:'confidential'})
    expect(await readOfficeClassification(f.reader,f.artifact.id)).not.toBeNull()
    expect(await runWithAgentAccess({clearance:'public',compartments:[],projectIds:[]},()=>readOfficeClassification(f.owner,f.artifact.id))).toBeNull()
    await pool.query("UPDATE department_edges SET expires_at=now()-interval '1 second' WHERE department_id=$1 AND user_id=$2",[f.a.id,f.reader])
    expect(await readOfficeClassification(f.reader,f.artifact.id)).toBeNull()
  })
  it('protects legacy snapshot bytes through generic file reads after classification',async()=>{
    const f=await fixture(),file=randomUUID()
    await pool.query("UPDATE workspace_access_policies SET setup_state='legacy' WHERE workspace_id=$1",[f.workspace])
    await pool.query(`INSERT INTO workspace_files(id,workspace_id,path,parent_path,name,mime,size_bytes,storage_uri,sensitivity,compartments,created_by_user_id)
      VALUES($1,$2,$3,'/','snapshot.json','application/json',2,'local://fixture','internal',$4,$5)`,[file,f.workspace,`/snapshot-${file}.json`,[f.a.compartmentKey],f.owner])
    await pool.query(`INSERT INTO office_artifact_versions(artifact_id,workspace_id,version,snapshot_file_id,snapshot_hash,operation_clock,schema_version,capability_version,author_type,author_user_id,origin)
      VALUES($1,$2,1,$3,$4,''::bytea,1,1,'user',$5,'manual')`,[f.artifact.id,f.workspace,file,'a'.repeat(64),f.owner])
    await pool.query("UPDATE workspace_access_policies SET setup_state='ready' WHERE workspace_id=$1",[f.workspace])
    expect((await queryWithRLS(f.reader,'SELECT id FROM workspace_files WHERE id=$1',[file])).rows).toHaveLength(1)
    const version=(await pool.query('SELECT id FROM office_artifact_versions WHERE artifact_id=$1',[f.artifact.id])).rows[0].id
    await pool.query(`INSERT INTO office_offline_packages(artifact_id,artifact_version_id,workspace_id,user_id,device_id,package_file_id,manifest,manifest_hash,signature,state_vector,complete)
      VALUES($1,$2,$3,$4,'fixture-device',$5,'{}',$6,'fixture-signature',''::bytea,true)`,[f.artifact.id,version,f.workspace,f.reader,file,'b'.repeat(64)])
    const before=await readOfficeClassification(f.owner,f.artifact.id)
    await restrictOfficeClassification(f.owner,{artifactId:f.artifact.id,expectedRevision:before!.revision,departmentId:f.b.id,sensitivity:'internal'})
    const offline=(await pool.query('SELECT revoked_at,complete FROM office_offline_packages WHERE artifact_id=$1',[f.artifact.id])).rows[0]
    expect(offline.revoked_at).not.toBeNull();expect(offline.complete).toBe(false)
    expect((await queryWithRLS(f.reader,'SELECT id FROM workspace_files WHERE id=$1',[file])).rows).toHaveLength(0)
    expect((await queryWithRLS(f.owner,'SELECT id FROM workspace_files WHERE id=$1',[file])).rows).toHaveLength(1)
  })
})
