import { admitWorkspaceResource } from '../../workspace-access/resource-admission.js'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { executePromptOnlyGeneration } from '../../office/generation-publication.js'
import { createLocalFilesClient } from '../../files/local-files-client.js'
import { createSingletonFilesClientResolver } from '../../files/files-api.js'
import { createOfficeLiveStore } from '../../db/office-live.js'
import { getWorkspaceFileById } from '../../db/workspace-files.js'
import { randomUUID } from 'node:crypto'
import express, { type ErrorRequestHandler } from 'express'
import request from 'supertest'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { requireAuth } from '../../auth/middleware.js'
import { createTokens } from '../../auth/jwt.js'
import { authSessionStore } from '../../db/auth-session-store.js'
import { getPool, getAppPool, queryWithRLS, applyRLSGucs, rollbackAndRelease } from '../../db/client.js'
import { officeArtifactStore } from '../../db/office-artifacts.js'
import { createDbWorkspaceGroupStore } from '../../db/workspace-group-store.js'
import { officeGenerationStore } from '../../db/office-generation.js'
import { createOfficeGenerationWorker } from '../../office/generation-worker.js'
import { createOfficeService } from '../../office/service.js'
import { officeArtifactRoutes } from '../office-artifacts.js'
import { WorkspaceAccessError } from '../../workspace-access/policy.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
// This suite asserts the legacy (pre-v2) model, which workspaces.department_read_v2=false still
// serves as the cutover's rollback path (migration 650, decision D22); its workspaces are pinned to it.
await assertLocalFixture()
const pool = getPool(), secret = 'office-authored-shell-fixture-secret'
afterAll(async () => { await getAppPool().end(); await pool.end() })

// The production parent router, actual session middleware/ledger, and real
// default Office store. Unrelated Office operations are not exercised here.
const service = createOfficeService({
  generationAvailable: () => true, createShell: officeArtifactStore.createShell,
  deleteEmptyShell: officeArtifactStore.deleteEmptyShell, getArtifact: officeArtifactStore.get,
  raiseScope: officeArtifactStore.raiseScope, resolveAccess: async () => null,
  createJob: async () => { throw new Error('Generation must not be reached') },
  latestJob: async () => null, getSnapshot: async () => null,
})
const app = express()
app.use(express.json())
app.use('/api/office', requireAuth(secret), officeArtifactRoutes({
  service, generationAvailable: () => true, list: async () => [],
  restoreVersion: async () => null, getArtifact: officeArtifactStore.get,
  resolveAccess: async () => null, listVersions: async () => [],
  previewVersion: async () => null, nameVersion: async () => false,
  copyVersion: async () => null, listSharing: async () => ({ status: 'unavailable' }),
  setGrant: async () => false, revokeGrant: async () => false,
  setDefaultWorkspaceRole: async () => false, canRestoreVersion: async () => false,
}))
app.use(((error, _req, res, _next) => {
  if (error instanceof WorkspaceAccessError) return void res.status(error.status).json({ error: error.code })
  res.status(500).json({ error: 'unexpected_fixture_error' })
}) as ErrorRequestHandler)
async function fixture(mode = 'simple', ready = true) {
  const owner = randomUUID(), userId = randomUUID(), workspaceId = randomUUID()
  for (const id of [owner,userId]) await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Office HTTP',$2,false)",[workspaceId,owner])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance,team_scope_mode) VALUES($1,$2,'owner','confidential','assigned'),($1,$3,'member','internal','assigned')",[workspaceId,owner,userId])
  const groups = createDbWorkspaceGroupStore()
  const team = await groups.createTeam(owner,workspaceId,{name:'Shared',key:'shared'})
  const other = await groups.createTeam(owner,workspaceId,{name:'Other',key:'other'})
  await groups.addMember(owner,team.id,userId)
  await pool.query('UPDATE workspace_access_policies SET access_mode=$2,setup_state=$3,default_department_id=$4 WHERE workspace_id=$1',[workspaceId,mode,ready?'ready':'legacy',team.id])
  const session = await authSessionStore.create(userId,{deviceLabel:'HTTP fixture',userAgent:null,ipAddress:null})
  if (!session) throw new Error('No fixture session')
  const token = createTokens(userId,secret,session).accessToken
  const assistantId = randomUUID()
  await pool.query("INSERT INTO assistants(id,name,workspace_id,owner_user_id,kind) VALUES($1,'Office authoring',$2,$3,'standard')",[assistantId,workspaceId,owner])
  const body = {workspaceId,family:'document',title:'Blank authored shell'}
  const post = (patch: Record<string,unknown> = {}, credential: string | null = token) => {
    const req = request(app).post('/api/office/artifacts/shell')
    if (credential) req.set('Authorization',`Bearer ${credential}`)
    return req.send({...body,...patch})
  }
  const generationBody = {workspaceId,assistantId,family:'document',outcome:'Write a welcome letter',audience:'Team',sourceHandles:[],idempotencyKey:randomUUID()}
  const generate = (patch: Record<string,unknown> = {}) => request(app).post('/api/office/artifacts').set('Authorization',`Bearer ${token}`).send({...generationBody,...patch})
  return {owner,userId,workspaceId,team,other,session,token,body,post,generate,generationBody}
}
describe('authenticated source-free Office shell HTTP admission (PG)', () => {
  it('creates a Simple shell as the session member, with no generation job or source', async () => {
    const f = await fixture(), response = await f.post()
    expect(response.status).toBe(201)
    expect(response.headers['cache-control']).toBe('no-store')
    const id = response.body.artifact.id
    expect(response.body.artifact).toMatchObject({workspaceId:f.workspaceId,creatorUserId:f.userId,ownerUserId:f.userId,compartments:[f.team.compartmentKey],headVersion:0,templateVersionId:null})
    const row = (await pool.query('SELECT visibility_user_ids,project_ids,compartments FROM office_artifacts WHERE id=$1',[id])).rows[0]
    expect(row).toEqual({visibility_user_ids:[],project_ids:[],compartments:[f.team.compartmentKey]})
    for (const table of ['office_generation_jobs','office_artifact_sources','office_artifact_versions']) expect((await pool.query(`SELECT id FROM ${table} WHERE artifact_id=$1`,[id])).rows).toEqual([])
    expect((await f.post({requiredCompartments:[]})).status).toBe(409)
    expect((await f.post({requiredCompartments:null})).status).toBe(400)
    expect((await f.post({expectedPolicyRevision:'0'})).status).toBe(409)
  })
  it('requires Departments selection and authorizes selected labels, General and private', async () => {
    const f = await fixture('departments')
    expect((await f.post()).body).toEqual({error:'context_selection_required'})
    expect((await f.post({requiredCompartments:[f.team.compartmentKey]})).status).toBe(201)
    expect((await f.post({requiredCompartments:[f.other.compartmentKey]})).status).toBe(404)
    expect((await f.post({requiredCompartments:[]})).status).toBe(201)
    const privateResponse = await f.post({visibility:'private'})
    expect(privateResponse.status).toBe(201)
    expect((await pool.query('SELECT visibility_user_ids,compartments FROM office_artifacts WHERE id=$1',[privateResponse.body.artifact.id])).rows[0]).toEqual({visibility_user_ids:[f.userId],compartments:[]})
    expect((await f.post({sensitivity:'confidential',requiredCompartments:[f.team.compartmentKey]})).status).toBe(404)
    expect((await f.post({projectIds:[randomUUID()],requiredCompartments:[f.team.compartmentKey]})).status).toBe(404)
  })
  it('rejects forged identity, provenance and source/content/template payload fields', async () => {
    const f = await fixture()
    for (const patch of [
      {userId:f.owner},{creatorUserId:f.owner},{ownerUserId:f.owner},{authSessionId:f.session.id},
      {provenance:{kind:'human_authored_root',actorUserId:f.owner,workspaceId:f.workspaceId}},
      {options:{provenance:{kind:'human_authored_root'}}},{sourceHandles:[]},
      {sourceArtifactId:randomUUID()},{sourceVersionId:randomUUID()},
      {templateVersionId:null},{templateId:randomUUID()},{content:'Imported content'},
      {snapshot:{}},{outcome:'Generate a report'},{mode:'template'},{visibilityUserIds:[f.owner]},
    ]) expect((await f.post(patch)).status,JSON.stringify(patch)).toBe(400)
    expect((await pool.query('SELECT id FROM office_artifacts WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
  })
  it('rejects absent, forged, sessionless, revoked and actor-mismatched credentials', async () => {
    const f = await fixture()
    for (const token of [null,'forged',createTokens(f.userId,secret).accessToken,createTokens(f.owner,secret,f.session).accessToken]) expect((await f.post({},token)).status).toBe(401)
    expect(await authSessionStore.revokeForUser(f.userId,f.session.id)).toBe(true)
    expect((await f.post()).status).toBe(401)
    expect((await pool.query('SELECT id FROM office_artifacts WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
  })
  it('rechecks workspace membership and refuses cross-workspace creation', async () => {
    const f = await fixture(), foreign = await fixture()
    expect((await f.post({workspaceId:foreign.workspaceId})).status).toBe(404)
    await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.userId])
    expect((await f.post()).status).toBe(404)
  })
  it('does not lend authored provenance to the existing generation route or direct store calls', async () => {
    const f = await fixture()
    const response = await request(app).post('/api/office/artifacts').set('Authorization',`Bearer ${f.token}`).send({workspaceId:f.workspaceId,assistantId:randomUUID(),family:'document',outcome:'A report',audience:'Team',sourceHandles:['knowledge:'+randomUUID()],idempotencyKey:'generation-stays-blocked'})
    expect(response.status).toBe(409)
    expect(response.body).toEqual({error:'office_admission_provenance_required'})
    await expect(officeArtifactStore.createShell({userId:f.userId,workspaceId:f.workspaceId,family:'document',title:'Unproved',templateVersionId:null,capabilityVersion:1,sensitivity:'internal'})).rejects.toMatchObject({code:'office_admission_provenance_required'})
  })
  it('keeps legacy unbound shells General without changing workspace mode', async () => {
    const f = await fixture('departments',false), response = await f.post()
    expect(response.status).toBe(201)
    expect(response.body.artifact.compartments).toEqual([])
    expect((await pool.query('SELECT setup_state FROM workspace_access_policies WHERE workspace_id=$1',[f.workspaceId])).rows[0].setup_state).toBe('legacy')
  })
})


describe('authenticated prompt-only Office generation request admission (PG)', () => {
  it('atomically saves a real generation job with its admitted destination, finite authority and canonical empty source contract', async () => {
    const f = await fixture(), response = await f.generate()
    expect(response.status).toBe(202)
    const job = await officeGenerationStore.get(f.userId,response.body.jobId)
    expect(job).toMatchObject({artifactId:response.body.artifactId,initiatedByUserId:f.userId,status:'queued',
      authorityProjection:{compartments:[f.team.compartmentKey],projectIds:[],compartmentGrant:[f.team.compartmentKey],projectGrant:[],sourceHandles:[],
        creationBinding:{protocol:'office_prompt_only_v1',actorUserId:f.userId,workspaceId:f.workspaceId,authSessionId:f.session.id,sources:[],implicitContext:'disabled'}}})
    expect((await f.generate()).body).toEqual(response.body)
    expect((await f.generate({outcome:'Different prompt'})).status).toBe(409)
    expect((await pool.query('SELECT id FROM office_artifacts WHERE workspace_id=$1',[f.workspaceId])).rows).toHaveLength(1)
    expect((await pool.query('SELECT id FROM office_generation_jobs WHERE workspace_id=$1',[f.workspaceId])).rows).toHaveLength(1)
    const claimed = await officeGenerationStore.claim({userId:f.userId,leaseToken:randomUUID(),leaseMs:60_000})
    expect(claimed?.id).toBe(job!.id)
  })
  it.each(['session','membership','labels'] as const)('rechecks %s at late job claim', async change => {
    const f = await fixture(), response = await f.generate()
    expect(response.status).toBe(202)
    if (change === 'session') await authSessionStore.revokeForUser(f.userId,f.session.id)
    if (change === 'membership') await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.userId])
    if (change === 'labels') await pool.query('UPDATE office_artifacts SET compartments=$2 WHERE id=$1',[response.body.artifactId,[f.other.compartmentKey]])
    expect(await officeGenerationStore.claim({userId:f.userId,leaseToken:randomUUID(),leaseMs:60_000})).toBeNull()
    expect((await pool.query('SELECT status FROM office_generation_jobs WHERE id=$1',[response.body.jobId])).rows[0].status).toBe('queued')
  })
  it('does not run implicit knowledge/template/brand context under the empty-source proof', async () => {
    const f = await fixture(), response = await f.generate()
    expect(response.status).toBe(202)
    const worker = createOfficeGenerationWorker({store:officeGenerationStore,workerUserId:f.userId,
      buildPipelineDeps:() => { throw new Error('Implicit context adapter must not run') }})
    expect(await worker.runOnce()).toBe('needs_input')
    expect(await officeGenerationStore.get(f.userId,response.body.jobId)).toMatchObject({status:'needs_input',errorCode:'office_prompt_only_execution_adapter_required'})
  })
  it('blocks unvalidated context/templates, foreign assistants, Departments ambiguity and payload provenance', async () => {
    const f = await fixture()
    for (const patch of [{sourceHandles:['knowledge:'+randomUUID()]},{templateId:randomUUID()},{additionalContext:'Read https://example.com'}, {family:'presentation'}]) {
      expect((await f.generate(patch)).status).toBe(409)
    }
    expect((await f.generate({assistantId:randomUUID()})).status).toBe(404)
    expect((await f.generate({provenance:{kind:'human_authored_root'}})).status).toBe(400)
    expect((await f.generate({authorityProjection:{creationBinding:{protocol:'office_prompt_only_v1'}}})).status).toBe(400)
    const departments = await fixture('departments')
    expect((await departments.generate()).body).toEqual({error:'context_selection_required'})
    expect((await pool.query('SELECT id FROM office_artifacts WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
    expect((await pool.query('SELECT id FROM office_generation_jobs WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
  })
})

// Actual API/session admission -> production worker/constructor -> local durable
// byte adapter + app-role PG publication. Model and converter are external fixtures.
describe('prompt-only canonical publication',()=>{
  it.each(['success','session','membership','labels','cancel','lease','source','grant','quota','rollback','ack','connect'] as const)('publishes atomically or refuses late %s',async change=>{
    const f=await fixture(), response=await f.generate()
    expect(response.status).toBe(202)
    const dir=await mkdtemp(join(tmpdir(),'office-publication-'))
    const local=createLocalFilesClient({baseDir:dir})
    let staged=false
    let restoreConnect:(()=>void)|undefined
    const storage={...local,async writeBlob(...args:Parameters<typeof local.writeBlob>) {
      await local.writeBlob(...args);staged=true
      if(change==='connect') {
        const spy=vi.spyOn(getAppPool(),'connect').mockImplementationOnce((async()=>{
          spy.mockRestore()
          throw new Error('fixture: publication connection unavailable')
        }) as never)
        restoreConnect=()=>spy.mockRestore()
      }
      if(change==='rollback' || change==='ack') {
        const appPool=getAppPool(), connect=appPool.connect.bind(appPool)
        const spy=vi.spyOn(appPool,'connect').mockImplementation((async()=>{
          const client=await connect(), query=client.query.bind(client)
          client.query=(async(sql:string,values?:unknown[])=>{
            if(sql==='ROLLBACK') client.query=query as typeof client.query
            if(change==='rollback' && sql.includes("SET status='completed'")) throw new Error('fixture: failure after file/version insert')
            const result=await query(sql,values)
            if(change==='ack' && sql==='COMMIT') {
              client.query=query as typeof client.query
              restoreConnect?.();restoreConnect=undefined
              throw new Error('fixture: lost commit acknowledgement')
            }
            return result
          }) as typeof client.query
          return client
        }) as never)
        restoreConnect=()=>spy.mockRestore()
      }
      if(change==='session') await authSessionStore.revokeForUser(f.userId,f.session.id)
      if(change==='membership') await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.userId])
      if(change==='labels') await pool.query('UPDATE office_artifacts SET compartments=$2 WHERE id=$1',[response.body.artifactId,[f.other.compartmentKey]])
      if(change==='cancel') await officeGenerationStore.cancel(f.userId,response.body.jobId)
      if(change==='lease') await pool.query("UPDATE office_generation_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[response.body.jobId])
      if(change==='source') await pool.query(`UPDATE office_generation_jobs SET brief=jsonb_set(brief,'{sourceHandles}',$2::jsonb) WHERE id=$1`,[response.body.jobId,JSON.stringify(['knowledge:'+randomUUID()])])
      if(change==='grant') await pool.query("INSERT INTO office_artifact_grants(artifact_id,workspace_id,user_id,role) VALUES($1,$2,$3,'deny')",[response.body.artifactId,f.workspaceId,f.userId])
    }}
    const resolver=createSingletonFilesClientResolver(storage,'fixture')
    const provider={async *stream(input:unknown) {
      expect(JSON.stringify(input)).not.toContain('knowledge:')
      yield {type:'message_start' as const,model:'fixture'}
      yield {type:'text_delta' as const,text:JSON.stringify({title:'Welcome',paragraphs:['Welcome to the team.']})}
      yield {type:'message_end' as const,stopReason:'end_turn' as const,usage:{inputTokens:1,outputTokens:1}}
    }}
    try {
      const worker=createOfficeGenerationWorker({store:officeGenerationStore,workerUserId:f.userId,
        buildPipelineDeps(){throw new Error('Ambient retrieval must never run')},
        async executePromptOnly(job,leaseToken) {
          await executePromptOnlyGeneration({job,leaseToken,provider:provider as never,model:'fixture',resolver,
            // LibreOffice is an external dependency, not installed in this PG fixture.
            // Native DOCX export/reopen and the production render-receipt gate run.
            renderPort:{convert:async()=>Buffer.from('%PDF-fixture'),pageCount:async()=>1},
            storageLimitBytes:change==='quota'?0:1000000})
        }})
      expect(await worker.runOnce()).toBe(change==='success'||change==='ack'?'completed':'failed')
      restoreConnect?.();restoreConnect=undefined
      expect(staged).toBe(true)
      const versions=(await pool.query('SELECT * FROM office_artifact_versions WHERE artifact_id=$1',[response.body.artifactId])).rows
      const files=(await pool.query('SELECT * FROM workspace_files WHERE workspace_id=$1',[f.workspaceId])).rows
      const job=(await pool.query('SELECT status FROM office_generation_jobs WHERE id=$1',[response.body.jobId])).rows[0]
      const head=(await pool.query('SELECT head_version FROM office_artifacts WHERE id=$1',[response.body.artifactId])).rows[0]
      if(change==='success' || change==='ack') {
        expect(job.status).toBe('completed');expect(Number(head.head_version)).toBe(1)
        expect(await createOfficeLiveStore().get(f.userId,response.body.artifactId)).toMatchObject({baseVersion:1,snapshot:{title:'Welcome'}})
        expect(versions).toHaveLength(1);expect(files).toHaveLength(1)
        expect(versions[0].snapshot_file_id).toBe(files[0].id)
        expect(files[0]).toMatchObject({sensitivity:'internal',compartments:[f.team.compartmentKey],project_ids:[],user_id:null,assistant_id:null})
        expect((await queryWithRLS(f.userId,"UPDATE workspace_files SET title='tampered' WHERE id=$1 RETURNING id",[files[0].id])).rows).toHaveLength(0)
        const blob=await local.readBlob(`${f.workspaceId}/${files[0].id}`)
        expect(blob).not.toBeNull()
        expect(createHash('sha256').update(blob!.bytes).digest('hex')).toBe(versions[0].snapshot_hash)
        expect(JSON.parse(blob!.bytes.toString()).sections[0].nodes[0].runs[0].text).toBe('Welcome to the team.')
        const ctx={workspaceId:f.workspaceId,userId:f.userId,assistantId:f.generationBody.assistantId,assistantKind:'standard' as const,clearance:'internal' as const,compartments:[f.team.compartmentKey!],projectIds:[]}
        expect(await getWorkspaceFileById(ctx,files[0].id)).not.toBeNull()
        await pool.query("INSERT INTO office_artifact_grants(artifact_id,workspace_id,user_id,role) VALUES($1,$2,$3,'deny')",[response.body.artifactId,f.workspaceId,f.userId])
        expect(await getWorkspaceFileById(ctx,files[0].id)).toBeNull()
        await pool.query('DELETE FROM office_artifacts WHERE id=$1',[response.body.artifactId])
        expect((await pool.query('SELECT artifact_id FROM office_generation_file_bindings WHERE file_id=$1',[files[0].id])).rows).toEqual([{artifact_id:null}])
        expect(await getWorkspaceFileById(ctx,files[0].id)).toBeNull()
      } else {
        expect(job.status).not.toBe('completed');expect(Number(head.head_version)).toBe(0)
        expect(versions).toHaveLength(0);expect(files).toHaveLength(0)
        expect((await pool.query('SELECT 1 FROM office_collab_documents WHERE artifact_id=$1',[response.body.artifactId])).rows).toHaveLength(0)
        expect((await readdir(join(dir,f.workspaceId))).filter(name=>!name.endsWith('.meta.json'))).toHaveLength(0)
      }
    } finally {restoreConnect?.();await rm(dir,{recursive:true,force:true})}
  })
})


describe('Office output binding SQL boundary (direct app-role)',()=>{
  it.each(['foreign','private','read_only','arbitrary_path','wrong_job','wrong_hash'] as const)('rejects %s file without disabling its legitimate reader/writer',async kind=>{
    const f=await fixture(), response=await f.generate()
    expect(response.status).toBe(202)
    const claimed=await officeGenerationStore.claim({userId:f.userId,leaseToken:randomUUID(),leaseMs:60000})
    expect(claimed?.id).toBe(response.body.jobId)
    const victim=kind==='foreign'?await fixture():f
    const fileId=randomUUID(), hash='b'.repeat(64)
    const parent=`/office/artifacts/${response.body.artifactId}/versions`, name=`1-${hash}.json`
    const path=kind==='arbitrary_path'?'/ordinary-file.json':`${parent}/${name}`
    const owner=kind==='foreign'?victim.userId:f.owner
    const compartments=[kind==='read_only'?f.other.compartmentKey!:victim.team.compartmentKey!]
    const partition=kind==='private'?f.owner:null
    if(kind==='read_only') {
      const requestId=randomUUID()
      await pool.query(`INSERT INTO workspace_access_requests(id,workspace_id,requester_user_id,beneficiary_kind,beneficiary_id,target_team_id,reason,starts_at,expires_at,payload_hash,policy_revision,status,decided_by,decided_at)
        VALUES($1,$2,$3,'member',$3,$4,'Read-only victim',now()-interval '1 day',now()+interval '1 day',$5,1,'approved',$6,now())`,[requestId,f.workspaceId,f.userId,f.other.id,'a'.repeat(64),f.owner])
      await pool.query(`INSERT INTO workspace_access_grants(workspace_id,request_id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,approved_by)
        SELECT workspace_id,id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,decided_by FROM workspace_access_requests WHERE id=$1`,[requestId])
    }
    // Seed the exact victim envelope as its legitimate administrator. This is
    // fixture setup only; the attack below uses only the non-bypass app pool.
    const setup=await pool.connect()
    try {
      await setup.query('BEGIN');await applyRLSGucs(setup,victim.owner)
      await admitWorkspaceResource(setup,victim.workspaceId,victim.owner,{writerKind:'workspace_file',
        rowVisibility:{userId:partition,assistantId:null},visibility:partition?'private':'workspace',sensitivity:'internal',
        inherited:{visibility:partition?'private':'workspace',sensitivity:'internal',compartments,projectIds:[]},
        requestedLabels:{compartments,projectIds:[]}})
      await setup.query(`INSERT INTO workspace_files(id,workspace_id,path,parent_path,name,mime,size_bytes,storage_uri,sensitivity,compartments,project_ids,user_id,created_by_user_id,metadata)
        VALUES($1,$2,$3,$4,$5,'application/json',3,$6,'internal',$7,'{}',$8,$9,$10::jsonb)`,
        [fileId,victim.workspaceId,path,parent,name,`fixture://${victim.workspaceId}/${fileId}`,compartments,partition,kind==='foreign'?victim.userId:f.userId,
          JSON.stringify({noIndex:true,contentSha256:kind==='wrong_hash'?'c'.repeat(64):hash,officeGenerationJobId:kind==='wrong_job'?randomUUID():response.body.jobId})])
      await setup.query('COMMIT')
    } finally {await rollbackAndRelease(setup)}
    expect((await queryWithRLS(f.userId,'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({rolsuper:false,rolbypassrls:false})
    if(kind==='read_only') {
      expect((await queryWithRLS(f.userId,'SELECT id FROM workspace_files WHERE id=$1',[fileId])).rows).toEqual([{id:fileId}])
      expect((await queryWithRLS(f.userId,"UPDATE workspace_files SET title='forbidden' WHERE id=$1 RETURNING id",[fileId])).rows).toEqual([])
    }
    await expect(queryWithRLS(f.userId,`INSERT INTO office_generation_file_bindings(file_id,artifact_id,workspace_id,job_id,snapshot_hash)
      VALUES($1,$2,$3,$4,$5)`,[fileId,response.body.artifactId,f.workspaceId,response.body.jobId,hash])).rejects.toMatchObject({code:'42501'})
    expect((await pool.query('SELECT 1 FROM office_generation_file_bindings WHERE file_id=$1',[fileId])).rows).toEqual([])
    expect((await queryWithRLS(owner,'SELECT id FROM workspace_files WHERE id=$1',[fileId])).rows).toEqual([{id:fileId}])
    expect((await queryWithRLS(owner,"UPDATE workspace_files SET title='still writable' WHERE id=$1 RETURNING id",[fileId])).rows).toEqual([{id:fileId}])
    expect((await queryWithRLS(owner,'DELETE FROM workspace_files WHERE id=$1 RETURNING id',[fileId])).rows).toEqual([{id:fileId}])
  })
})
