#!/usr/bin/env node
/** Supported application journey. No database access, seeded authority or automatic retries. */
import {randomUUID} from 'node:crypto'
import {pathToFileURL} from 'node:url'

export function validateOrigin(value) {
  const u=new URL(value)
  if(u.username||u.password||u.pathname!=='/'||u.search||u.hash||
    (u.protocol!=='https:'&&!(u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)))) throw new Error('Use an HTTPS API origin or loopback HTTP origin')
  return u.origin
}
export function createReferenceApi({apiOrigin,workspaceId,nativeToken,managementOrigin=apiOrigin}) {
  const origin=validateOrigin(apiOrigin)
  if(!nativeToken||!workspaceId)throw new Error('Native token and workspace ID are required')
  async function request(path,body,token=nativeToken,extra={}) {
    let response
    try {response=await fetch(origin+path,{method:'POST',redirect:'error',signal:AbortSignal.timeout(20_000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...(token===nativeToken?{Origin:validateOrigin(managementOrigin)}:{}),...extra},body:JSON.stringify(body)})}
    catch {throw new Error('Request outcome unknown; inspect the operation before explicitly starting another attempt')}
    const text=await response.text(),line=text.split('\n').find(x=>x.startsWith('data: '))
    let result;try{result=JSON.parse(line?line.slice(6):text)}catch{throw new Error('Unreadable response; outcome may be committed')}
    if(!response.ok)throw new Error('HTTP '+response.status+'; request refused; do not automatically retry')
    return result
  }
  return {origin,command:body=>request('/api/applications/workspaces/'+encodeURIComponent(workspaceId)+'/management/commands',body),
    workflow:body=>request('/api/workflows',body),start:id=>request('/api/workflows/'+encodeURIComponent(id)+'/run',{}),
    async brian(appId,token,name,args){
      const data=await request('/api/applications/'+encodeURIComponent(appId)+'/mcp',{jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name,arguments:args}},token,{Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'})
      if(data.error||data.result?.isError)throw new Error('Registered MCP operation refused; inspect its outcome before retrying')
      return JSON.parse(data.result.content[0].text)
    }}
}
function nativeProposal(serviceUserId,typeKey,confidential=false){return {principal:{kind:'service',userId:serviceUserId},origin:{kind:'native',moduleKey:'native'},typeKey,
  actions:typeKey==='company'?['read','query','create','patch','command:create_company','command:patch_company','command:patch_records']:['read','query','create','patch','command:create_deal','command:set_deal_stage','command:patch_records'],
  readFields:typeKey==='company'?['name','domain']:['name','companyId','stage','amount','currencyCode'],writeFields:typeKey==='company'?['name','domain']:['name','companyId','stage','amount','currencyCode'],selector:{kind:'self'},expiresAt:null,parentGrantId:null,compartments:[],projectIds:[],clearance:confidential?'confidential':'internal'}}
async function grant(api,appId,input){const review=await api.command({kind:'grant.review',appId,input});if(!review.canIssue)throw new Error('Grant review refused issuance');return (await api.command({kind:'grant.apply',appId,reviewId:review.id})).grantId}
async function issue(api,appId,serviceUserId,grantIds){const review=await api.command({kind:'credential.review',appId,input:{name:'Reference operations key',kind:'service',serviceUserId,grantIds,expiresAt:new Date(Date.now()+3600_000).toISOString()}});if(!review.canIssue)throw new Error('Credential review refused issuance');const key=await api.command({kind:'credential.deliver',appId,reviewId:review.id});if(!key.secretAvailable)throw new Error('One-time credential unavailable; do not replay delivery expecting a secret');return key}

export async function runNativeReference(api,{loadSdk=async()=>import('../../output/application-platform/reference-web/service-bot/client.mjs')}={}){
  // Load before any mutation so a missing local build cannot strand setup.
  const {createServiceBot,readServiceRecord}=await loadSdk()
  const appId=(await api.command({kind:'register',input:{moduleKey:'native',name:'Reference operations app',mode:'api_client',origins:[],redirectUris:[]}})).id
  const serviceUserId=(await api.command({kind:'service.prepare',appId,input:{name:'Reference operations service',idempotencyKey:randomUUID()}})).serviceUserId
  const activation=await api.command({kind:'activation.review',appId});await api.command({kind:'activation.apply',appId,reviewId:activation.id})
  const grantIds=[];for(const type of ['company','deal'])grantIds.push(await grant(api,appId,nativeProposal(serviceUserId,type)))
  const key=await issue(api,appId,serviceUserId,grantIds)
  try{
    const client=createServiceBot({appId,apiOrigin:api.origin,credential:async()=>({kind:'service',token:key.secret})})
    const company=await client.command('create_company',{idempotencyKey:randomUUID(),input:{name:'Reference workshop',domain:'workshop.example'}}),companyId=company.resources[0].id
    await api.brian(appId,key.secret,'applicationCommand',{commandKey:'patch_company',command:{idempotencyKey:randomUUID(),expectedVersion:'1',input:{id:companyId,patch:{domain:'updated.example'}}}})
    const deal=await client.command('create_deal',{idempotencyKey:randomUUID(),input:{name:'Reference opportunity',companyId,amount:'37.25',currencyCode:'USD'}}),dealId=deal.resources[0].id
    await api.brian(appId,key.secret,'applicationCommand',{commandKey:'set_deal_stage',command:{idempotencyKey:randomUUID(),expectedVersion:'1',input:{id:dealId,stage:'proposal'}}})
    const current=await readServiceRecord(client,{type:'company',id:companyId}),currentDeal=await readServiceRecord(client,{type:'deal',id:dealId})
    if(current.values.domain!=='updated.example'||currentDeal.values.stage!=='proposal')throw new Error('Canonical readback mismatch')
    const found=await client.query('company',{fields:['name','domain'],filters:[{field:'domain',op:'eq',value:'updated.example'}],sort:[],aggregate:[],limit:100})
    if(!found.records.some(r=>r.ref.id===companyId))throw new Error('Canonical query omitted created record')
    // CRM v1 retirement closes a separate deal and preserves its canonical history.
    const retiring=await client.command('create_deal',{idempotencyKey:randomUUID(),input:{name:'Reference retirement demo',companyId,amount:'37.25',currencyCode:'USD'}}),retiredDealId=retiring.resources[0].id
    await client.command('set_deal_stage',{idempotencyKey:randomUUID(),expectedVersion:'1',input:{id:retiredDealId,stage:'lost'}})
    const retired=await client.get('deal',retiredDealId)
    if(retired.ref.version!=='2'||retired.values.stage!=='lost')throw new Error('Canonical soft-retirement readback mismatch')
    return {appId,serviceUserId,companyId,dealId,retiredDealId,retirement:'closed_lost_history_retained',nativeKeyRevoked:true}
  }finally{await api.command({kind:'credential.revoke',appId,credentialId:key.credentialId})}
}

export function safeStartAcknowledgement(value){
  if(typeof value?.runId!=='string'||!/^[0-9a-f-]{36}$/i.test(value.runId))throw new Error('Start response unavailable; outcome may be committed. Inspect execution before retrying')
  return {accepted:true,effect:'committed',runId:value.runId,outputUnavailable:value.outputUnavailable===true}
}

export async function prepareReferenceSourceProfile(api,appId,{instanceId,tenant,audience,recordId,fields}){
  const reviewed=await api.command({kind:'source.profile.review',appId,input:{instanceId,tenant,audience,recordId,fields}})
  return (await api.command({kind:'source.profile.apply',appId,reviewId:reviewed.reviewId})).profileId
}

export async function runSourceReference(api,{workspaceId,appId,serviceUserId,instanceId,tenant,audience,recordId,fields,typeKey='purchase',profileId:existingProfileId}){
  if(!appId||!serviceUserId||!instanceId||!tenant||!audience||!recordId||!fields?.length)throw new Error('Source setup requires app, service, instance, tenant, audience, record and fields')
  const profileId=existingProfileId??await prepareReferenceSourceProfile(api,appId,{instanceId,tenant,audience,recordId,fields})
  const nativeGrant=await grant(api,appId,nativeProposal(serviceUserId,'company',true))
  let bootstrap,pending,key,workflow,binding,startAttempted=false
  try{
  bootstrap=await issue(api,appId,serviceUserId,[nativeGrant])
  pending=(await api.command({kind:'source.binding.review',appId,input:{profileId,credentialId:bootstrap.credentialId,expiresAt:new Date(Date.now()+30*60_000).toISOString()}})).reviewId
  const externalGrant=await grant(api,appId,{principal:{kind:'service',userId:serviceUserId},origin:{kind:'external',connectorInstanceId:instanceId,sourceTenant:tenant},typeKey,actions:['read','command:source.derive','command:source.retain'],readFields:fields,writeFields:[],selector:{kind:'ids',ids:[recordId]},expiresAt:null,parentGrantId:null,compartments:[],projectIds:[],clearance:'confidential'})
  key=await issue(api,appId,serviceUserId,[nativeGrant,externalGrant])
  await api.command({kind:'source.binding.revoke',appId,bindingId:pending});await api.command({kind:'credential.revoke',appId,credentialId:bootstrap.credentialId})
  // The replacement secret is deliberately never printed or persisted. The server binding
  // owns execution authority; this CLI only configures it using the native human session.
  workflow=await api.workflow({workspaceId,name:'Reference source wait',definition:{startStepId:'read',steps:[{id:'read',type:'tool_call',toolName:'readRecord',arguments:{id:recordId,fields},nextStepId:'pause'},{id:'pause',type:'wait',until:{duration:{minutes:1}},nextStepId:'readAgain'},{id:'readAgain',type:'tool_call',toolName:'readRecord',arguments:{id:recordId,fields}}]}})
  binding=(await api.command({kind:'source.binding.review',appId,input:{profileId,credentialId:key.credentialId,workflowId:workflow.id,expiresAt:new Date(Date.now()+20*60_000).toISOString()}})).reviewId
  await api.command({kind:'source.binding.apply',appId,reviewId:binding})
  startAttempted=true
  const started=safeStartAcknowledgement(await api.start(workflow.id))
  return {appId,serviceUserId,profileId,credentialId:key.credentialId,bindingId:binding,workflowId:workflow.id,...started,
    meaning:'Local run creation accepted; completion and remote effects are not certified. Do not automatically retry.'}
  }catch(error){
    // Revoke known unused setup authority. A possibly started run is left for explicit
    // reconciliation, never retried or silently cancelled by this client.
    if(pending)await api.command({kind:'source.binding.revoke',appId,bindingId:pending}).catch(()=>{})
    if(bootstrap)await api.command({kind:'credential.revoke',appId,credentialId:bootstrap.credentialId}).catch(()=>{})
    if(!startAttempted){
      if(binding)await api.command({kind:'source.binding.revoke',appId,bindingId:binding}).catch(()=>{})
      if(key)await api.command({kind:'credential.revoke',appId,credentialId:key.credentialId}).catch(()=>{})
    }
    error.recovery={appId,serviceUserId,profileId,bootstrapCredentialId:bootstrap?.credentialId,pendingBindingId:pending,credentialId:key?.credentialId,bindingId:binding,workflowId:workflow?.id,startOutcome:startAttempted?'inspect_before_retry':'not_requested',cleanup:'Known unused authority revocation attempted; inspect listed IDs'}
    throw error
  }
}


export const help=`Usage: node scripts/application-platform/reference-operations.mjs native|source|start --apply --api ORIGIN --workspace ID [options]
Native session: BRIAN_NATIVE_TOKEN (environment only). Optional BRIAN_MANAGEMENT_ORIGIN.
native: creates an app, issues a one-time key, SDK CRUD + registered Brian MCP; revokes demo key.
source: --app ID --service-user ID --source-instance ID --tenant NAME --audience URI --record ID --fields description,cost [--type purchase]
  Requires independent source approval for configuring human AND prepared service first.
start: --workflow ID (explicitly creates another run; no automatic retries).
Source workflow requires default legacy workspace mode and running maintained scheduler.
See scripts/application-platform/README.md for deployment trust and setup. No paid model call.`
export async function main(argv=process.argv.slice(2),env=process.env){
  if(argv.includes('--help')||!argv.length){console.log(help);return}
  const phase=argv.shift(),options={}
  while(argv.length){const flag=argv.shift();if(flag==='--apply'){options.apply=true;continue}if(!flag.startsWith('--')||!argv.length)throw new Error('Invalid option');options[flag.slice(2)]=argv.shift()}
  if(!options.apply)throw new Error('Pass --apply to explicitly authorize this client to mutate the selected workspace')
  const api=createReferenceApi({apiOrigin:options.api,workspaceId:options.workspace,nativeToken:env.BRIAN_NATIVE_TOKEN,managementOrigin:env.BRIAN_MANAGEMENT_ORIGIN||options.api})
  let result
  if(phase==='native')result=await runNativeReference(api)
  else if(phase==='source')result=await runSourceReference(api,{workspaceId:options.workspace,appId:options.app,serviceUserId:options['service-user'],instanceId:options['source-instance'],tenant:options.tenant,audience:options.audience,recordId:options.record,fields:options.fields?.split(',').filter(Boolean),typeKey:options.type||'purchase'})
  else if(phase==='start'&&options.workflow)result={...safeStartAcknowledgement(await api.start(options.workflow)),meaning:'New local run creation requested; inspect existing run before any further explicit start.'}
  else throw new Error('Unknown phase or missing workflow')
  console.log(JSON.stringify(result,null,2))
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error.message);if(error.recovery)console.error(JSON.stringify(error.recovery));process.exitCode=1})
