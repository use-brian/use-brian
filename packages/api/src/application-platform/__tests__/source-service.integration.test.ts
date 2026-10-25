import { createPublicKey,randomBytes,randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll,describe,expect,it } from 'vitest'
import { ContextScopeAccumulator,advanceWorkflowRun,type ApplicationAuthorityLayers,type ExecutionContext,type ScopeSource } from '@use-brian/core'
import { createConnectorActorVerifier,type SourceSubject,type SourceAuthorizationRequest } from '@use-brian/brian-app/connector'
import type { ApplicationAccessGrant } from '@use-brian/shared'
import { getPool,getAppPool,applyRLSGucs,queryWithRLS,runWithAgentAccess } from '../../db/client.js'
import { findOrCreateUser } from '../../db/users.js'
import { createConnectorInstanceStore } from '../../db/connector-instance-store.js'
import { createConnectorActorKeyStore } from '../connector-actor-keys.js'
import { createConnectorSourceRuntimeFactory,configureConnectorSourceRuntimeFactory } from '../source-runtime.js'
import { createRetainedSourceAuthorityCoordinator,pinPreparedExternalSourceAuthority } from '../retained-source-authority.js'
import { pinExternalSourceOperation,activatePinnedExternalSourceOperation } from '../source-store.js'
import { authenticateBoundApplicationCredential,mintApplicationCredentialSecret } from '../credentials.js'
import { getApplicationExecutionBinding,applyApplicationRLSContext,releaseApplicationTransactionBinding } from '../execution-context.js'
import { resolveSourceServiceExecution,prepareSourceServiceBinding,getSourceServiceExecutionBinding,activateSourceServiceBinding } from '../source-service-binding.js'
import { createDbWorkflowStore,createDbWorkflowRunStore } from '../../db/workflow-store.js'
import { captureAuthoringAuthoritySystem,resolveWorkflowRunScope } from '../../context-scope/workflow-authority.js'
import { buildWorkflowToolRegistry } from '../../workflow/mcp-bridge.js'
import { ApplicationManagementService } from '../management.js'
import { ApplicationPlatformService } from '../service.js'
import { createCanonicalNativeApplicationModule } from '../native-adapters.js'
import { validateDerivedWriteInputs } from '../../db/derived-scope-store.js'
import { independentSourceSchema,independentSourceReplayConsumer,startIndependentSource } from './fixtures/independent-source.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool()

import { sourceServiceFixture as fixture, sourceServiceFixtureCleanups as cleanups } from './fixtures/source-service.js'

describe.sequential('[COMP:api/source-service-binding] real source-service workflow authority',()=>{
 afterAll(async()=>{for(const cleanup of [...cleanups])await cleanup();configureConnectorSourceRuntimeFactory(undefined);await getAppPool().end();await pool.end()})
 it('keeps named service identity, Brian ceilings, source ACL, exact transaction and derive/retain ancestry separate',async()=>{
  const f=await fixture();try{
   const {execution,runtime,accumulator}=await f.runtime()
   expect(execution.security.access.userId).toBe(f.service);expect(execution.security.access.userId).not.toBe(f.owner)
   expect((await pool.query('SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspace,f.service])).rowCount).toBe(0)
   expect(await authenticateBoundApplicationCredential({bindingId:f.binding})).toBeNull()
   const result=await runtime.read!('readRecord',{id:'order-1',fields:['description','cost']});expect(JSON.stringify(result.result)).toContain('37.25')
   const sources=result.sources
   const prepared=await f.coordinator.prepare(execution,sources,'retain')
   await f.tx(execution,async c=>{
    expect((await c.query(`SELECT r.rolsuper,r.rolbypassrls,pg_has_role(r.oid,c.relowner,'USAGE') AS table_owner FROM pg_roles r JOIN pg_class c ON c.oid='application_clients'::regclass WHERE r.rolname=current_user`)).rows[0]).toMatchObject({rolsuper:false,rolbypassrls:false,table_owner:false})
    await expect(pinPreparedExternalSourceAuthority(c,execution,structuredClone(prepared))).rejects.toMatchObject({code:'source_access_denied'})
    await pinPreparedExternalSourceAuthority(c,execution,prepared)
    await validateDerivedWriteInputs(c,{producer:'service-conformance',sources})
    expect((await c.query('SELECT external_source_retention_allowed($1,$2,$3) AS allowed',[f.workspace,sources[0].resourceId,sources[0].version])).rows[0].allowed).toBe(true)
    const receipt=(await pool.query('SELECT actor_kind,actor_id,assistant_id,service_binding_id,derivation_receipt FROM external_source_authorizations WHERE service_binding_id=$1 AND action=\'retain\'',[f.binding])).rows[0]
    expect(receipt).toMatchObject({actor_kind:'service',actor_id:f.service,assistant_id:f.assistant,service_binding_id:f.binding});expect(receipt.derivation_receipt).toBeTruthy()
   })
   await f.tx(execution,async c=>{await expect(pinPreparedExternalSourceAuthority(c,execution,prepared)).rejects.toMatchObject({code:'source_access_denied'})})
   await expect(f.coordinator.prepare(execution,sources,'deliver',[{kind:'human',id:f.owner,executingAssistantId:f.assistant}])).rejects.toMatchObject({code:'source_access_denied'})
   await expect(runtime.call('updateRecord',{id:'order-1',expectedVersion:'1',values:{cost:'99'},idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'source_unavailable'})
   expect(f.source.counters.effects).toBe(0)
   await f.sourcePool.query("UPDATE grants SET actions=array_remove(actions,'derive') WHERE kind='service' AND account_id=$1",[f.service])
   await expect(f.coordinator.prepare(execution,sources,'retain')).rejects.toMatchObject({code:'source_access_denied'})
  }finally{await f.cleanup()}
 })
 it('does not upgrade read-only app permission to derive/retain',async()=>{
  const f=await fixture({readOnly:true});try{const {execution,runtime}=await f.runtime();const read=await runtime.read!('readRecord',{id:'order-1',fields:['description']});
   await expect(f.coordinator.prepare(execution,read.sources,'retain')).rejects.toMatchObject({code:'source_access_denied'})
  }finally{await f.cleanup()}
 })
 it('denies ungranted fields/resources even when the source independently allows them',async()=>{
  const f=await fixture({fields:['description']});try{const {runtime}=await f.runtime();expect(JSON.stringify(await runtime.read!('readRecord',{id:'order-1',fields:['description']}))).toContain('Fictional purchase')
   await expect(runtime.read!('readRecord',{id:'order-1',fields:['cost']})).rejects.toMatchObject({code:'source_access_denied'})
   await expect(runtime.read!('readRecord',{id:'another-order',fields:['description']})).rejects.toBeDefined()
  }finally{await f.cleanup()}
 })
 it.each(['parent','credential','application','assistant','profile','binding','source','sourceAssistant'] as const)('refuses current %s revocation across an actual source await',async kind=>{
  const f=await fixture();try{const {execution,runtime}=await f.runtime();f.source.setAfterRead(async()=>{
   f.source.setAfterRead()
   if(kind==='parent')await pool.query("UPDATE application_access_grants SET status='revoked' WHERE id=$1",[f.parent])
   if(kind==='credential')await pool.query("UPDATE application_api_credentials SET status='revoked' WHERE id=$1",[f.credential])
   if(kind==='application')await pool.query("UPDATE application_clients SET status='suspended' WHERE id=$1",[f.app])
   if(kind==='assistant')await pool.query("DELETE FROM department_edges WHERE workspace_id=$1 AND assistant_id=$2",[f.workspace,f.assistant])
   if(kind==='profile')await pool.query("UPDATE connector_source_profiles SET status='revoked' WHERE id=$1",[f.profile])
   if(kind==='binding')await pool.query("UPDATE source_service_bindings SET status='revoked' WHERE id=$1",[f.binding])
   if(kind==='source')await f.sourcePool.query("DELETE FROM grants WHERE kind='service' AND account_id=$1",[f.service])
   if(kind==='sourceAssistant')await f.sourcePool.query('UPDATE assistants SET active=false WHERE id=$1',[f.assistant])
  });await expect(runtime.read!('readRecord',{id:'order-1',fields:['description']})).rejects.toBeDefined();expect(execution.security.access.userId).toBe(f.service)
  }finally{await f.cleanup()}
 })
 it('runs the actual workflow bridge, atomically retains output/ancestry and resumes under the same service',async()=>{
  const f=await fixture();try{
   const runs=createDbWorkflowRunStore(),run=await runs.createRun({workflowId:f.workflow.id,workspaceId:f.workspace,triggeredBy:null,triggerKind:'schedule'})
   const deps={abortSignal:new AbortController().signal,workflowStore:createDbWorkflowStore(),runStore:runs,resolvePrimary:async()=>f.assistant,resolveRunScope:resolveWorkflowRunScope,
    buildToolRegistry:(scope:Parameters<typeof buildWorkflowToolRegistry>[1])=>buildWorkflowToolRegistry({firstParty:new Map([['humanOnly',{} as never]]),connectorStore:{} as never,settingsStore:{} as never},scope),
    consultTransport:{async send(){throw new Error('Unexpected model turn')}},pauseRunForWait:async()=>{}}
   const first=await advanceWorkflowRun(deps,run.id);if(first.kind==='failed')console.error('source-service-workflow-typed-failure',JSON.stringify(first))
   expect(first).toMatchObject({kind:'paused'})
   const stored=(await runs.getRunSystem(run.id))!;expect(stored.vars.__contextScopeEvidence).toBeTruthy();expect(JSON.stringify((await pool.query('SELECT output FROM workflow_step_runs WHERE run_id=$1',[run.id])).rows)).toContain('Fictional purchase')
   expect((await pool.query('SELECT binding_id FROM source_service_workflow_runs WHERE run_id=$1',[run.id])).rows[0].binding_id).toBe(f.binding)
    const snapshot=(await pool.query('SELECT workflow_derivation_snapshot($1,$2) AS value',[f.workspace,run.id])).rows[0].value
    const ancestry=(await pool.query('SELECT * FROM read_external_source_dependencies($1,$2,$3,$4)',[f.workspace,['workflow_run'],[run.id],[snapshot.version]])).rows
    expect(snapshot).toMatchObject({held:false,sensitivity:'confidential'})
    expect(ancestry.length).toBeGreaterThan(0);expect(ancestry.every((row:{source:ScopeSource})=>row.source.resourceKind==='external_source')).toBe(true)
    expect(ancestry.map((row:{source:ScopeSource})=>row.source.resourceId).sort()).toEqual(snapshot.requiredSources.map((source:ScopeSource)=>source.resourceId).sort())
    expect((await queryWithRLS(f.owner,'SELECT id FROM workflow_runs WHERE id=$1',[run.id])).rows).toEqual([])
   const scope=await resolveWorkflowRunScope({run:stored,userId:f.owner,assistantId:f.assistant,workspaceId:f.workspace})
   expect(scope.executionContext.security.access.userId).toBe(f.service)
   const pause=(await pool.query(`SELECT id FROM workflow_step_runs WHERE run_id=$1 AND step_id='pause'`,[run.id])).rows[0];await runs.updateStepRun(pause.id,{status:'completed',finishedAt:new Date()})
   expect(await advanceWorkflowRun(deps,run.id,{startAt:['readAgain']})).toMatchObject({kind:'completed'})
   const final=(await runs.getRunSystem(run.id))!;expect(final.status).toBe('completed')
  }finally{await f.cleanup()}
 })
  it.each(['parent','credential','application','assistant','profile','binding','source','sourceAssistant'] as const)('denies %s revocation on a persisted workflow resume',async kind=>{
   const f=await fixture();try{
    const runs=createDbWorkflowRunStore(),run=await runs.createRun({workflowId:f.workflow.id,workspaceId:f.workspace,triggeredBy:null,triggerKind:'schedule'})
    const deps={abortSignal:new AbortController().signal,workflowStore:createDbWorkflowStore(),runStore:runs,resolvePrimary:async()=>f.assistant,resolveRunScope:resolveWorkflowRunScope,
     buildToolRegistry:(scope:Parameters<typeof buildWorkflowToolRegistry>[1])=>buildWorkflowToolRegistry({firstParty:new Map(),connectorStore:{} as never,settingsStore:{} as never},scope),
     consultTransport:{async send(){throw new Error('Unexpected model turn')}},pauseRunForWait:async()=>{}}
    expect(await advanceWorkflowRun(deps,run.id)).toMatchObject({kind:'paused'})
    if(kind==='parent')await pool.query("UPDATE application_access_grants SET status='revoked' WHERE id=$1",[f.parent])
    if(kind==='credential')await pool.query("UPDATE application_api_credentials SET status='revoked' WHERE id=$1",[f.credential])
    if(kind==='application')await pool.query("UPDATE application_clients SET status='suspended' WHERE id=$1",[f.app])
    if(kind==='assistant')await pool.query("DELETE FROM department_edges WHERE workspace_id=$1 AND assistant_id=$2",[f.workspace,f.assistant])
    if(kind==='profile')await pool.query("UPDATE connector_source_profiles SET status='revoked' WHERE id=$1",[f.profile])
    if(kind==='binding')await pool.query("UPDATE source_service_bindings SET status='revoked' WHERE id=$1",[f.binding])
    if(kind==='source')await f.sourcePool.query("UPDATE accounts SET active=false WHERE kind='service' AND id=$1",[f.service])
    if(kind==='sourceAssistant')await f.sourcePool.query('UPDATE assistants SET active=false WHERE id=$1',[f.assistant])
    expect(await advanceWorkflowRun(deps,run.id,{startAt:['readAgain']})).toMatchObject({kind:'failed'})
    expect((await pool.query("SELECT 1 FROM workflow_step_runs WHERE run_id=$1 AND step_id='readAgain' AND output IS NOT NULL",[run.id])).rowCount).toBe(0)
   }finally{await f.cleanup()}
  })

 it('reviews external release with the actual source, denies copied/stale apply and requires fresh credentials after grant revision',async()=>{
  const f=await fixture();try{
   const actual=await f.runtime();await actual.runtime.read!('readRecord',{id:'order-1',fields:['description','cost']})
   const management=new ApplicationManagementService(new ApplicationPlatformService([createCanonicalNativeApplicationModule()]))
   const origin=(await pool.query('SELECT resource_origin FROM application_access_grants WHERE id=$1',[f.leaf])).rows[0].resource_origin
   const proposal={principal:{kind:'service',userId:f.service},origin,typeKey:'purchase',actions:['read'],readFields:['description'],writeFields:[],selector:{kind:'ids',ids:['order-1']},
    compartments:['team:'+f.department],projectIds:[],clearance:'confidential',parentGrantId:f.parent,expiresAt:null}
   const review=await management.reviewGrant(f.owner,f.workspace,f.app,proposal)
   expect(review.id).toBeTruthy();expect(review.canIssue).toBe(false)
   await expect(management.applyGrantReview(f.reader,f.workspace,f.app,review.id)).rejects.toBeDefined()
   await f.sourcePool.query("UPDATE accounts SET active=false WHERE kind='service' AND id=$1",[f.service])
   await expect(management.applyGrantReview(f.owner,f.workspace,f.app,review.id)).rejects.toMatchObject({code:'access_unavailable',effect:'none'})
   await f.sourcePool.query("UPDATE accounts SET active=true WHERE kind='service' AND id=$1",[f.service])
   await expect(management.applyGrantReview(f.owner,f.workspace,f.app,review.id)).rejects.toMatchObject({code:'access_unavailable',effect:'none'})
   expect((await pool.query('SELECT consumed_grant_id FROM application_grant_reviews WHERE id=$1',[review.id])).rows[0].consumed_grant_id).toBeNull()
   await pool.query('UPDATE application_clients SET grant_revision=grant_revision+1 WHERE id=$1',[f.app])
   await expect(resolveSourceServiceExecution(f.binding)).rejects.toMatchObject({code:'source_access_denied'})
   await expect(management.applyGrantReview(f.owner,f.workspace,f.app,review.id)).rejects.toMatchObject({code:'access_unavailable',effect:'none'})
  }finally{await f.cleanup()}
 })
 it('keeps native pending review rollback, copied review and live qualification boundaries',async()=>{
  const f=await fixture();try{
   const actual=await f.runtime();await actual.runtime.read!('readRecord',{id:'order-1',fields:['description','cost']})
   await pool.query("UPDATE source_service_bindings SET status='revoked' WHERE id=$1",[f.binding])
   const c=await getAppPool().connect();let review:string
   try{await c.query('BEGIN');await applyRLSGucs(c,f.owner);await c.query("SELECT set_config('app.application_assistant_id',$1,true),set_config('app.v2_assistant_id',$1,true)",[f.assistant]);
    review=(await prepareSourceServiceBinding(c,f.owner,f.workspace,{profileId:f.profile,appId:f.app,credentialId:f.credential,workflowId:f.workflow.id,expiresAt:new Date(Date.now()+15*60e3).toISOString()})).reviewId
    await c.query('ROLLBACK');expect((await pool.query('SELECT id FROM source_service_bindings WHERE id=$1',[review])).rows).toEqual([])
    await c.query('BEGIN');await applyRLSGucs(c,f.owner);await c.query("SELECT set_config('app.application_assistant_id',$1,true),set_config('app.v2_assistant_id',$1,true)",[f.assistant])
    review=(await prepareSourceServiceBinding(c,f.owner,f.workspace,{profileId:f.profile,appId:f.app,credentialId:f.credential,workflowId:f.workflow.id,expiresAt:new Date(Date.now()+15*60e3).toISOString()})).reviewId;await c.query('COMMIT')
    expect((await queryWithRLS(f.owner,"SELECT application_runtime_qualified($1,'application_data') AS ready",[f.workspace])).rows[0].ready).toBe(false)
    await c.query('BEGIN');await applyRLSGucs(c,f.owner);await c.query("SELECT set_config('app.application_assistant_id',$1,true),set_config('app.v2_assistant_id',$1,true)",[f.assistant])
    await expect(c.query('SELECT activate_source_service_binding($1,$2)',[review,randomUUID()])).rejects.toMatchObject({code:'42501'});await c.query('ROLLBACK')
    await expect(resolveSourceServiceExecution(review)).rejects.toMatchObject({code:'source_access_denied'})
     await c.query('BEGIN');await applyRLSGucs(c,f.owner);await c.query("SELECT set_config('app.application_assistant_id',$1,true),set_config('app.v2_assistant_id',$1,true)",[f.assistant])
     await expect(activateSourceServiceBinding(c,f.owner,f.workspace,review)).rejects.toBeDefined();await c.query('ROLLBACK')
     expect((await pool.query('SELECT status FROM source_service_bindings WHERE id=$1',[review])).rows[0].status).toBe('pending')
   }finally{await c.query('ROLLBACK');c.release()}
  }finally{await f.cleanup()}
 })
})
