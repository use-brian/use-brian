/** Independent persisted source authority. [COMP:examples/application-references] */
import { open, readFile, rename, mkdir, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
export class SourceStoreError extends Error { constructor(code) { super(code);this.code=code } }
const deny = () => { throw new SourceStoreError('source_access_denied') }
const invalid = () => { throw new SourceStoreError('source_protocol_invalid') }
export function identityKey(identity) {return JSON.stringify([identity.issuer,identity.audience,identity.workspaceId,identity.connectorInstanceId,identity.kind,identity.id,identity.assistantId])}
export function actorIdentity(actor) {return {issuer:actor.iss,audience:actor.aud,workspaceId:actor.workspaceId,connectorInstanceId:actor.connectorInstanceId,kind:actor.actor.kind,id:actor.actor.kind==='human'?actor.actor.userId:actor.actor.serviceUserId,assistantId:actor.executingAssistantId}}
export function subjectIdentity(actor,subject) {return {...actorIdentity(actor),kind:subject.kind,id:subject.id,assistantId:subject.executingAssistantId}}
function account(state,identity) {const mapping=state.identities.find(row=>identityKey(row)===identityKey(identity));const result=state.accounts.find(row=>row.id===mapping?.accountId&&row.enabled===true);if(!result)deny();return result}
function record(state,ref,historical=false) {
 const current=state.records.find(row=>row.type===ref.type&&row.id===ref.id&&!row.withdrawn)
 if(!current||current.policyVersion!==ref.policyVersion)deny()
 if(current.contentVersion===ref.contentVersion)return current
 if(!historical)deny()
 const saved=state.history?.find(row=>row.type===ref.type&&row.id===ref.id&&row.contentVersion===ref.contentVersion&&row.policyVersion===ref.policyVersion)
 if(!saved)deny();return saved
}
function grant(state,accountId,resource,fields,action,mode,now,requestedRelease) {
 if(!Array.isArray(fields)||!fields.length||fields.length>256||new Set(fields).size!==fields.length||fields.some(field=>typeof field!=='string'||!Object.hasOwn(resource.values,field)))deny()
 if(mode==='released_snapshot') {
  const release=state.releases.find(row=>(requestedRelease===undefined||row.id===requestedRelease.id&&row.expiresAt===requestedRelease.expiresAt)&&row.resourceType===resource.type&&row.resourceId===resource.id&&row.contentVersion===resource.contentVersion&&row.policyVersion===resource.policyVersion&&row.accountIds.includes(accountId)&&row.expiresAt>now&&!row.revoked&&fields.every(field=>row.fields.includes(field))&&row.actions.includes(action))
  if(!release)deny();return {release,actions:release.actions,fields:release.fields,model:release.model===true&&release.actions.includes('context')}
 }
 const matches=state.grants.filter(row=>row.accountId===accountId&&row.resourceType===resource.type&&row.resourceId===resource.id&&row.actions.includes(action)&&row.retentionModes.includes(mode)&&!row.revoked)
 if(!matches.length||fields.some(field=>!matches.some(row=>row.fields.includes(field))))deny()
 return {actions:[...new Set(matches.flatMap(row=>row.actions))].filter(candidate=>fields.every(field=>matches.some(row=>row.fields.includes(field)&&row.actions.includes(candidate)))),fields:[...new Set(matches.flatMap(row=>row.fields))],model:fields.every(field=>matches.some(row=>row.fields.includes(field)&&row.model===true&&row.actions.includes('context')))}
}
export function authorizeSourceAccount(state,accountId,ref,fields,action,mode,now=Date.now(),requestedRelease) {
 if(!state.accounts.some(row=>row.id===accountId&&row.enabled===true))deny()
 const resource=record(state,ref,mode==='governed'&&['read','context','derive','retain'].includes(action))
 // Exact historical fields and current source fields independently pass the current ACL.
 const current=state.records.find(row=>row.type===ref.type&&row.id===ref.id&&!row.withdrawn)
 if(resource!==current)grant(state,accountId,current,fields,action,mode,now,requestedRelease)
 const permission=grant(state,accountId,resource,fields,action,mode,now,requestedRelease)
 return {resource,permission}
}
export function createSourceStore(file,{tenant,now=Date.now,dispatchCommands=false,sdk}={}) {
 if(!file||!tenant)invalid()
 const {parseSourceAuthorizationRequest,sourceEffectDigest,sourceSubjectKey}=sdk??{}
 if(dispatchCommands&&[parseSourceAuthorizationRequest,sourceEffectDigest,sourceSubjectKey].some(fn=>typeof fn!=='function'))invalid()
 async function transaction(operation) {
  await mkdir(dirname(file),{recursive:true});let lock
  for(let attempt=0;attempt<100;attempt++){try{lock=await open(file+'.lock','wx',0o600);break}catch(error){if(error.code!=='EEXIST')throw error;await new Promise(resolve=>setTimeout(resolve,5))}}
  if(!lock)throw new SourceStoreError('source_unavailable')
  try {
   const state=JSON.parse(await readFile(file,'utf8'));if(state.version!==1||state.tenant!==tenant)invalid()
   const result=await operation(state)
   const temp=file+'.'+randomUUID()+'.tmp',output=await open(temp,'wx',0o600)
   try{await output.writeFile(JSON.stringify(state));await output.sync()}finally{await output.close()}
   await rename(temp,file);const directory=await open(dirname(file),'r');try{await directory.sync()}finally{await directory.close()}
   return structuredClone(result)
  }catch(error){if(error instanceof SourceStoreError)throw error;throw new SourceStoreError('source_unavailable')}
  finally{await lock.close();await unlink(file+'.lock')}
 }
 const resolveAccount=(state,identity)=>account(state,identity)
 const resourceRef=resource=>({type:resource.type,id:resource.id,contentVersion:resource.contentVersion,policyVersion:resource.policyVersion})
 const subject=actor=>({kind:actor.actor.kind,id:actor.actor.kind==='human'?actor.actor.userId:actor.actor.serviceUserId,executingAssistantId:actor.executingAssistantId})
 function dispatchInput(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='destination,expectedPolicyVersion,expectedVersion,fields,id,idempotencyKey,type'
   ||input.destination!=='source_outbox'||!Array.isArray(input.fields)||!input.fields.length||input.fields.length>256
   ||new Set(input.fields).size!==input.fields.length||input.fields.some(f=>typeof f!=='string'||!f||f.length>256)
   ||['type','id','expectedVersion','expectedPolicyVersion','idempotencyKey'].some(k=>typeof input[k]!=='string'||!input[k]||input[k].length>256))invalid()
  return input
 }
 function updateInput(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='expectedPolicyVersion,expectedVersion,id,idempotencyKey,type,values'
   ||!input.values||typeof input.values!=='object'||Array.isArray(input.values)||!Object.keys(input.values).length||Object.keys(input.values).length>256
   ||Object.entries(input.values).some(([field,value])=>!field||field.length>256||typeof value!=='string'||value.length>8192)
   ||['type','id','expectedVersion','expectedPolicyVersion','idempotencyKey'].some(k=>typeof input[k]!=='string'||!input[k]||input[k].length>256))invalid()
  return input
 }
 function dispatchRequest(request){
  const parsed=parseSourceAuthorizationRequest(request),updating=parsed.effect?.tool==='updateRecord'
  const input=updating?updateInput(parsed.effect.input):dispatchInput(parsed.effect?.input),fields=updating?Object.keys(input.values):input.fields
  if(!dispatchCommands||!['dispatchRecord','updateRecord'].includes(parsed.effect.tool)||parsed.effect.idempotencyKey!==input.idempotencyKey||parsed.items.length!==1)deny()
  const item=parsed.items[0]
  if(item.action!=='mutate'||item.retentionMode!=='governed'||item.resource.type!==input.type||item.resource.id!==input.id
   ||item.resource.contentVersion!==input.expectedVersion||item.resource.policyVersion!==input.expectedPolicyVersion
   ||item.fields.length!==fields.length||item.fields.some(f=>!fields.includes(f)))deny()
  return{parsed,input,fields,updating,digest:sourceEffectDigest(parsed.effect)}
 }
 function observation(actor,resource,fields,permission,mode){return {resource:resourceRef(resource),fields,labels:resource.labels,subjects:[{kind:actor.actor.kind,id:actor.actor.kind==='human'?actor.actor.userId:actor.actor.serviceUserId,executingAssistantId:actor.executingAssistantId}],actions:permission.actions,retention:mode==='released_snapshot'?{mode,releaseId:permission.release.id,expiresAt:permission.release.expiresAt}:{mode},export:{model:permission.model===true,destinations:[]}}}
 function mutateRecord(state,actor,key,input,checked){
   const caller=resolveAccount(state,actorIdentity(actor)),identity=identityKey(actorIdentity(actor)),digest=checked?.digest??createHash('sha256').update(JSON.stringify(input)).digest('hex'),existing=state.effects.find(row=>row.key===key&&row.identity===identity)
   if(existing){if(existing.digest!==digest)invalid();for(const observation of existing.evidence.resources)authorizeSourceAccount(state,caller.id,observation.resource,observation.fields,'mutate','governed',now());return{receipt:existing.receipt,evidence:existing.evidence}}
   if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='expectedVersion,id,patch,type'||!input.patch||typeof input.patch!=='object'||Array.isArray(input.patch)||!Object.keys(input.patch).length)invalid()
   const resource=state.records.find(row=>row.type===input.type&&row.id===input.id);if(!resource||resource.contentVersion!==input.expectedVersion)deny()
   if(checked&&resource.policyVersion!==checked.input.expectedPolicyVersion)deny()
   const fields=Object.keys(input.patch),permission=authorizeSourceAccount(state,caller.id,resourceRef(resource),fields,'mutate','governed',now()).permission
   if(!/^[1-9]\d*$/.test(resource.contentVersion)||fields.some(field=>typeof input.patch[field]!=='string'||input.patch[field].length>8192))invalid()
   state.history??=[];state.history.push(structuredClone(resource))
   for(const field of fields)resource.values[field]=input.patch[field]
   resource.contentVersion=String(BigInt(resource.contentVersion)+1n)
   const receipt=randomUUID(),evidence={version:'ub.source.v1',tenant,resources:[observation(actor,resource,fields,permission,'governed')]}
   state.effects.push({identity,key,digest,receipt,evidence,...(checked?{kind:'update',resource:{type:input.type,id:input.id,contentVersion:input.expectedVersion,policyVersion:checked.input.expectedPolicyVersion},fields:[...fields]}:{})});return{receipt,evidence}
 }
 return {
  transaction,
  consumeReplay:entry=>transaction(state=>{for(const[key,expiry]of Object.entries(state.replays))if(expiry<=entry.now)delete state.replays[key];if(state.replays[entry.key]||entry.expiresAt<=entry.now)return false;if(Object.keys(state.replays).length>=10000)throw new SourceStoreError('source_unavailable');state.replays[entry.key]=entry.expiresAt;return true}),
  capabilities:actor=>transaction(state=>{resolveAccount(state,actorIdentity(actor));return{version:'ub.source.v1',tenant,retentionModes:['governed','released_snapshot','ephemeral'],fieldEvidence:true,reconciliation:true,...(dispatchCommands?{effectBinding:'command_v1'}:{})}}),
  catalog:actor=>transaction(state=>{
   const caller=resolveAccount(state,actorIdentity(actor)),readFields=new Set(),mutateFields=new Set()
   for(const resource of state.records)for(const field of Object.keys(resource.values)){
    try{authorizeSourceAccount(state,caller.id,resourceRef(resource),[field],'read','governed',now());readFields.add(field)
     try{authorizeSourceAccount(state,caller.id,resourceRef(resource),[field],'mutate','governed',now());mutateFields.add(field)}catch(error){if(error.code!=='source_access_denied')throw error}
    }catch(error){if(error.code!=='source_access_denied')throw error}
   }
   return{readFields:[...readFields].sort(),mutateFields:[...mutateFields].sort()}
  }),
  authorize:(actor,request)=>transaction(state=>{
   const initiator=resolveAccount(state,actorIdentity(actor)),issuedAt=now(),decisions=[]
   for(const item of request.items)for(const recipient of request.recipients){let allowed=false
    try{if(dispatchCommands&&request.effect)dispatchRequest(request);if(item.retentionMode==='released_snapshot'&&!item.release)deny();authorizeSourceAccount(state,initiator.id,item.resource,item.fields,item.action,item.retentionMode,issuedAt,item.release);const target=resolveAccount(state,subjectIdentity(actor,recipient.subject));authorizeSourceAccount(state,target.id,item.resource,item.fields,item.action,item.retentionMode,issuedAt,item.release);allowed=true}catch(error){if(!['source_access_denied','source_protocol_invalid'].includes(error.code))throw error}
    decisions.push({itemId:item.itemId,recipientId:recipient.recipientId,allowed,...(allowed?{receipt:{id:randomUUID(),issuedAt,expiresAt:issuedAt+5000}}:{})})
   }return{version:'ub.source.v1',tenant,operationId:request.operationId,decisions}
  }),
  read:(actor,input)=>transaction(state=>{
   const caller=resolveAccount(state,actorIdentity(actor)),matches=state.records.filter(row=>row.id===input.id&&(row.type===input.type||dispatchCommands&&input.type===undefined)),resource=matches.length===1?matches[0]:null;if(!resource)deny()
   const{permission}=authorizeSourceAccount(state,caller.id,resourceRef(resource),input.fields,'read',input.retentionMode,now())
   return{data:Object.fromEntries(input.fields.map(field=>[field,resource.values[field]])),envelope:{version:'ub.source.v1',tenant,resources:[observation(actor,resource,input.fields,permission,input.retentionMode)]}}
  }),
  readForAccount:(accountId,input)=>transaction(state=>{const resource=state.records.find(row=>row.type===input.type&&row.id===input.id);if(!resource)deny();authorizeSourceAccount(state,accountId,resourceRef(resource),input.fields,'read','governed',now());return Object.fromEntries(input.fields.map(field=>[field,resource.values[field]]))}),
  command:(actor,key,input)=>transaction(state=>{if(dispatchCommands)deny();return mutateRecord(state,actor,key,input)}),
  dispatch:(actor,input,authorization)=>transaction(state=>{
   const checked=dispatchRequest(authorization)
   if(checked.parsed.recipients.length!==1||sourceSubjectKey(checked.parsed.recipients[0].subject)!==sourceSubjectKey(subject(actor))
    ||checked.digest!==sourceEffectDigest({tool:checked.parsed.effect.tool,input:checked.updating?updateInput(input):dispatchInput(input),idempotencyKey:input.idempotencyKey}))deny()
   const caller=resolveAccount(state,actorIdentity(actor)),ref={type:input.type,id:input.id,contentVersion:input.expectedVersion,policyVersion:input.expectedPolicyVersion}
   const resource=authorizeSourceAccount(state,caller.id,ref,checked.fields,'mutate','governed',now()).resource
   authorizeSourceAccount(state,caller.id,ref,checked.fields,'read','governed',now())
   if(checked.updating){const result=mutateRecord(state,actor,input.idempotencyKey,{type:input.type,id:input.id,expectedVersion:input.expectedVersion,patch:input.values},checked);return{receipt:result.receipt,effectDigest:checked.digest}}
   const identity=identityKey(actorIdentity(actor)),existing=state.effects.find(row=>row.key===input.idempotencyKey&&row.identity===identity)
   if(existing){if(existing.kind!=='dispatch'||existing.digest!==checked.digest)deny();return{receipt:existing.receipt,effectDigest:existing.digest}}
   const receipt=randomUUID();state.dispatches??=[]
   state.dispatches.push({id:randomUUID(),identity,key:input.idempotencyKey,destination:'source_outbox',resource:resourceRef(resource),fields:[...input.fields],values:Object.fromEntries(input.fields.map(f=>[f,resource.values[f]])),status:'queued'})
   state.effects.push({kind:'dispatch',identity,key:input.idempotencyKey,digest:checked.digest,receipt,resource:resourceRef(resource),fields:[...input.fields]})
   return{receipt,effectDigest:checked.digest}
  }),
  reconcile:(actor,request)=>transaction(state=>{const caller=resolveAccount(state,actorIdentity(actor)),effect=state.effects.find(row=>row.key===request.idempotencyKey&&row.identity===identityKey(actorIdentity(actor)));if(!effect)return{version:'ub.source.v1',tenant,state:'not_applied'};if(request.receipt&&request.receipt!==effect.receipt)deny();
   if(effect.kind==='dispatch'||effect.kind==='update'){
    const checked=dispatchRequest(request.authorization)
    if(checked.parsed.recipients.length!==1||sourceSubjectKey(checked.parsed.recipients[0].subject)!==sourceSubjectKey(subject(actor))||request.effectDigest!==effect.digest||checked.digest!==effect.digest)deny()
    const current=state.records.find(row=>row.type===effect.resource.type&&row.id===effect.resource.id&&!row.withdrawn)
    if(!current||current.policyVersion!==effect.resource.policyVersion)deny()
    const admitted=effect.kind==='update'?resourceRef(current):effect.resource
    authorizeSourceAccount(state,caller.id,admitted,effect.fields,'mutate','governed',now());authorizeSourceAccount(state,caller.id,admitted,effect.fields,'read','governed',now())
    return{version:'ub.source.v1',tenant,state:'applied',receipt:effect.receipt,effectDigest:effect.digest}
   }
   for(const item of effect.evidence.resources)authorizeSourceAccount(state,caller.id,item.resource,item.fields,'mutate','governed',now());return{version:'ub.source.v1',tenant,state:'applied',receipt:effect.receipt,evidence:effect.evidence}}),
 }
}
