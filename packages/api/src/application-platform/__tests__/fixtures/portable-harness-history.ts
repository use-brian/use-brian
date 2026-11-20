/** Owned disposable portable proof only; no trigger suspension or receipt enrollment. */
import {randomUUID,createHash} from 'node:crypto'
import {expect} from 'vitest'
import type pg from 'pg'
import {getPool,getAppPool} from '../../../db/client.js'
import {authSessionStore} from '../../../db/auth-session-store.js'
import {createProjectSharedStore} from '../../../db/project-shared-store.js'
import {createProjectHarnessStore} from '../../../db/project-harness-store.js'
import {createHarnessExecutionStore} from '../../../db/project-harness-execution-store.js'
import {runAutomaticVerification} from '../../../project-harness/verification.js'

export const harnessTables=['project_harness_products','project_harness_components','project_harness_revisions','project_harness_approvals','project_harness_runs','project_harness_evidence','project_harness_execution_audit'] as const
const digest=(s:string)=>createHash('sha256').update(s).digest('hex')
export async function harnessInstalled(){
 const rows=(await getPool().query('SELECT count(*)::int n FROM pg_class WHERE relnamespace=\'public\'::regnamespace AND relname=ANY($1::text[])',[harnessTables])).rows
 if(rows[0].n!==0&&rows[0].n!==7)throw Error('partial portable harness installation')
 return rows[0].n===7
}
export async function harnessRows(client:Pick<pg.Client,'query'>){
 const result:Record<string,{rows:string[];sha256:string}>={}
 for(const table of harnessTables){
  // Server JSON text retains microseconds and opaque attribution without JS Date truncation.
  const rows=(await client.query(`SELECT to_jsonb(t)::text row FROM public.${table} t ORDER BY id`)).rows.map(r=>r.row as string)
  result[table]={rows,sha256:digest(JSON.stringify(rows))}
 }
 return result
}
export type HarnessHistory=NonNullable<Awaited<ReturnType<typeof seedHarnessHistory>>>
export async function seedHarnessHistory(){
 if(!await harnessInstalled())return undefined // historical 8273 cohort
 const q=getPool().query.bind(getPool()),shared=createProjectSharedStore(),h=createProjectHarnessStore(),e=createHarnessExecutionStore()
 const workspaceId=randomUUID(),author=randomUUID(),reviewer=randomUUID(),requester=randomUUID(),stranger=randomUUID()
 for(const id of [author,reviewer,requester,stranger])await q('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[id])
 await q("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Portable harness history',$2)",[workspaceId,author])
 for(const [id,role] of [[author,'owner'],[reviewer,'member'],[requester,'member']])await q("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,$3,'internal')",[workspaceId,id,role])
 await q('UPDATE workspaces SET department_read_v2=true,project_shared_spaces=true WHERE id=$1',[workspaceId])
 const projectId=await shared.create(author,workspaceId,{name:'Portable history',userIds:[reviewer,requester],assistantIds:[]})
 await shared.addOwner(author,projectId,reviewer)
 const device=async(userId:string)=>{const s=(await authSessionStore.create(userId,{deviceLabel:'Portable harness',userAgent:null,ipAddress:null}))!;return{userId,authSessionId:s.id}}
 const reviewActor=await device(reviewer),actor=await device(requester)
 const product=await h.createProduct(author,workspaceId,projectId,{name:'Portable product'})
 const component=await h.createComponent(author,workspaceId,projectId,product.id,{name:'Portable component'})
 const definition={schemaVersion:1 as const,rules:[],codeChecks:[],acceptanceScenarios:[{key:'visible',title:'Visible history',preconditions:['Ready'],steps:['Observe'],criteria:[{key:'present',observation:'Visible',evidence:'Observation'}]}]}
 const scopes=[{kind:'product' as const,productId:product.id},{kind:'component' as const,productId:product.id,componentId:component.id}]
 const histories=[]
 for(const scope of scopes){
  const first=await h.putDefinition(author,workspaceId,projectId,{scope,expectedRevision:0,definition})
  const second=await h.putDefinition(author,workspaceId,projectId,{scope,expectedRevision:1,definition:{...definition,acceptanceScenarios:[{...definition.acceptanceScenarios[0],title:'Revised visible history'}]}})
  histories.push({scope,ids:[second.id,first.id]})
 }
 const revisionId=histories[1].ids[0]
 await expect(e.approve({...actor,userId:author},workspaceId,projectId,revisionId,2,'Invalid session')).rejects.toMatchObject({code:'harness_human_required'})
 const approval=await e.approve(reviewActor,workspaceId,projectId,revisionId,2,'Independent portable review')
 const run=await e.createRun(actor,workspaceId,projectId,{approvalId:approval.id,scenarioKey:'visible',executor:'human',build:{buildId:'portable-build',deploymentId:'portable-deployment'},target:{url:'https://example.com/',permittedOrigins:['https://example.com']},environment:{environmentId:'portable',locale:'en',timezone:'UTC',viewport:{width:800,height:600}}})
 // Ordinary-owner insert with guards enabled: evidence_human would intentionally
 // add a fourth audit event. This fixture proves EXACTLY the three transitions.
 const evidenceId=randomUUID(),text='Fictional human observation'
 await q(`INSERT INTO project_harness_evidence(id,workspace_id,project_id,run_id,criterion_key,kind,provenance,text,sha256) VALUES($1,$2,$3,$4,'present','observation','human_reported',$5,$6)`,[evidenceId,workspaceId,projectId,run.id,text,digest(text)])
 const blocked=runAutomaticVerification(run.preview)
 await e.completeHuman(actor,workspaceId,projectId,run.id,{binding:blocked.binding,status:'passed',criteria:[{criterionKey:'present',status:'passed',evidenceIds:[evidenceId]}],evidence:[{id:evidenceId,criterionKey:'present',kind:'observation',reference:evidenceId}]})
 expect((await q('SELECT event FROM project_harness_execution_audit WHERE run_id=$1 ORDER BY created_at,id',[run.id])).rows.map(r=>r.event)).toEqual(['pending','running','passed'])
 const rows=await harnessRows(getPool())
 for(const table of harnessTables)expect(rows[table].rows.length).toBeGreaterThan(0)
 return {workspaceId,projectId,author,reviewActor,actor,stranger,revisionId,runId:run.id,evidenceId,histories,rows}
}

export async function verifyHarnessHistory(s:HarnessHistory,client:pg.Client){
 expect(await harnessRows(client)).toEqual(s.rows)
 const h=createProjectHarnessStore(),e=createHarnessExecutionStore()
 for(const history of s.histories)expect((await h.history(s.author,s.workspaceId,s.projectId,history.scope)).map(r=>r.id)).toEqual(history.ids)
 for(const [table,column,id] of [['project_harness_revisions','definition',s.revisionId],['project_harness_approvals','reason',null],['project_harness_evidence','text',s.evidenceId],['project_harness_execution_audit','event',null]] as const){
  const assignment=column==='definition'?"definition=definition":"\""+column+'\"=\"'+column+'\"'
  await expect(client.query(`UPDATE public.${table} SET ${assignment} WHERE ${id?'id=$1':'workspace_id=$1'}`,[id??s.workspaceId])).rejects.toThrow(/immutable/)
 }
 await expect(client.query('UPDATE project_harness_runs SET status=\'pending\' WHERE id=$1',[s.runId])).rejects.toThrow(/harness_/)
 const app=await getAppPool().connect()
 try{
  await app.query('BEGIN');await app.query("SELECT set_config('app.current_user_id',$1,true)",[s.stranger])
  for(const table of harnessTables)expect((await app.query(`SELECT * FROM public.${table} WHERE workspace_id=$1`,[s.workspaceId])).rows).toEqual([])
  await expect(app.query('UPDATE project_harness_runs SET status=\'pending\' WHERE id=$1',[s.runId])).rejects.toThrow('permission denied')
 }finally{await app.query('ROLLBACK');app.release()}
 // Historical attribution is unchanged. Auth-session rows follow their own
 // roster policy; prove a revoked/foreign session cannot gain human authority.
 await expect(e.approve({...s.reviewActor,authSessionId:randomUUID()},s.workspaceId,s.projectId,s.revisionId,2,'Foreign login cannot approve')).rejects.toMatchObject({code:'harness_human_required'})
 for(const actor of [s.actor,s.reviewActor]){
  await client.query('BEGIN')
  try{
   await client.query("SELECT set_config('app.current_user_id',$1,true)",[actor.userId])
   await client.query('UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1',[actor.authSessionId])
   await expect(client.query('SELECT harness_execution_human($1,$2)',[actor.userId,actor.authSessionId])).rejects.toThrow('harness_human_required')
  }finally{await client.query('ROLLBACK')}
 }
 expect(await harnessRows(client)).toEqual(s.rows)
}
