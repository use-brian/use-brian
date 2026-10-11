import {randomUUID} from 'node:crypto'
import {afterAll,describe,it,expect} from 'vitest'
import {getPool,getAppPool,queryWithRLS} from '../../db/client.js'
import {resumeOfficeGeneration,readOfficeGenerationRecovery} from '../generation-recovery.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool()
afterAll(async()=>{await getAppPool().end();await pool.end()})

async function fixture() {
  const user=randomUUID(),other=randomUUID(),workspace=randomUUID(),artifact=randomUUID(),draft=randomUUID(),job=randomUUID(),template=randomUUID(),version=randomUUID(),file=randomUUID()
  for(const id of [user,other])await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Generation recovery fixture',$2,false)",[workspace,user])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential'),($1,$3,'member','confidential')",[workspace,user,other])
  await pool.query("UPDATE workspace_access_policies SET setup_state='legacy' WHERE workspace_id=$1",[workspace])
  for(const [id,mode] of [[artifact,'artifact'],[draft,'template']])await pool.query(`INSERT INTO office_artifacts(id,workspace_id,family,mode,title,creator_user_id,owner_user_id,capability_version,sensitivity,default_workspace_role)
    VALUES($1,$2,'spreadsheet',$3,'Quarterly worksheet',$4,$4,1,'internal','view')`,[id,workspace,mode,user])
  await pool.query(`INSERT INTO workspace_files(id,workspace_id,path,parent_path,name,mime,size_bytes,storage_uri,sensitivity,created_by_user_id)
    VALUES($1,$2,$3,'/','template.json','application/json',2,'local://fixture','internal',$4)`,[file,workspace,`/template-${file}.json`,user])
  await pool.query(`INSERT INTO office_templates(id,workspace_id,family,name,owner_user_id,sensitivity,draft_artifact_id,lifecycle_state)
    VALUES($1,$2,'spreadsheet','Quarterly worksheet',$3,'internal',$4,'admitted')`,[template,workspace,user,draft])
  await pool.query(`INSERT INTO office_template_versions(id,template_id,workspace_id,version,bundle_file_id,bundle_hash,capability_version,locales,when_to_use,when_not_to_use,example_requests,field_schema,admission_receipt,provenance,status,created_by)
    VALUES($1,$2,$3,1,$4,$5,1,'{en}','[]','[]','[]','{}','{}','{}','admitted',$6)`,[version,template,workspace,file,version.replaceAll('-','').repeat(2),user])
  await pool.query('UPDATE office_templates SET current_version_id=$2 WHERE id=$1',[template,version])
  const brief={family:'spreadsheet',outcome:'Prepare a draft worksheet',audience:'Internal review',sourceHandles:['file:fixture']}
  const authority={sensitivity:'internal',compartmentGrant:null,projectGrant:null}
  await pool.query(`INSERT INTO office_generation_jobs(id,workspace_id,artifact_id,initiated_by_user_id,job_kind,status,stage,brief,authority_projection,error_code,error_detail,idempotency_key)
    VALUES($1,$2,$3,$4,'create','needs_input','needs_input',$5,$6,'template_ambiguous','Which admitted template should I use?',$7)`,[job,workspace,artifact,user,JSON.stringify(brief),JSON.stringify(authority),randomUUID()])
  return {user,other,workspace,artifact,draft,job,template,version,file,brief,authority,input:{artifactId:artifact,jobId:job,templateVersionId:version}}
}

describe('[COMP:api/office-generation-recovery] real PostgreSQL template recovery',()=>{
  it('resumes concurrently once, keeps the original request and fences a different selection',async()=>{
    const f=await fixture()
    expect((await readOfficeGenerationRecovery(f.user,f.artifact,f.job)).templateChoices).toEqual([{templateVersionId:f.version,name:'Quarterly worksheet'}])
    const results=await Promise.all([resumeOfficeGeneration(f.user,f.input),resumeOfficeGeneration(f.user,f.input)])
    expect(results[0]).toEqual(results[1])
    const job=(await pool.query('SELECT status,brief,authority_projection,template_version_id FROM office_generation_jobs WHERE id=$1',[f.job])).rows[0]
    expect(job).toMatchObject({status:'queued',brief:{...f.brief,templateId:f.version},authority_projection:f.authority,template_version_id:f.version})
    expect((await pool.query("SELECT 1 FROM office_generation_events WHERE job_id=$1 AND code='office.job.template_resumed'",[f.job])).rows).toHaveLength(1)
    await expect(resumeOfficeGeneration(f.user,{...f.input,templateVersionId:randomUUID()})).rejects.toMatchObject({status:409})
  })
  it('locks a readable template even when UPDATE RLS hides it from ordinary row locks',async()=>{
    const f=await fixture()
    // Restrict template editing only; using the published template is a read.
    await pool.query(`CREATE POLICY recovery_fixture_no_template_update ON office_templates AS RESTRICTIVE FOR UPDATE USING(false)`)
    try {
      expect((await queryWithRLS(f.user,'SELECT id FROM office_templates WHERE id=$1',[f.template])).rows).toHaveLength(1)
      expect((await queryWithRLS(f.user,'SELECT id FROM office_templates WHERE id=$1 FOR SHARE',[f.template])).rows).toHaveLength(0)
      expect(await resumeOfficeGeneration(f.user,f.input)).toEqual({artifactId:f.artifact,jobId:f.job})
    } finally {await pool.query('DROP POLICY recovery_fixture_no_template_update ON office_templates')}
  })
  it.each(['noninitiator','revoked_source','edited','ready'] as const)('refuses %s without changing the job',async(reason)=>{
    const f=await fixture()
    if(reason==='revoked_source')await pool.query('UPDATE workspace_files SET scope_held=true WHERE id=$1',[f.file])
    if(reason==='edited')await pool.query('UPDATE office_artifacts SET head_version=1 WHERE id=$1',[f.artifact])
    if(reason==='ready')await pool.query("UPDATE workspace_access_policies SET setup_state='ready' WHERE workspace_id=$1",[f.workspace])
    await expect(resumeOfficeGeneration(reason==='noninitiator'?f.other:f.user,f.input)).rejects.toBeTruthy()
    expect((await pool.query('SELECT status,template_version_id FROM office_generation_jobs WHERE id=$1',[f.job])).rows[0]).toEqual({status:'needs_input',template_version_id:null})
  })
})
