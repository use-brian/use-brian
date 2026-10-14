import {previewArchiveScope} from '../workspace-access/file-programmatic-admission.js'
import {createHash} from 'node:crypto'
/** Only this authenticated connection's effective configuration. [COMP:api/engineering-history] */
import type {CaptureConfiguration} from '@use-brian/shared'
import type {BrainAuth} from '../brain-mcp/auth.js'
import type {ProgrammaticCaptureStore} from '../db/programmatic-capture-store.js'
import {queryWithRLS} from '../db/client.js'
import {ARCHIVE_TEXT_LIMIT} from './contracts.js'
export function createCaptureConfigurationReader(store:ProgrammaticCaptureStore,available:()=>boolean){
 return async(auth:BrainAuth):Promise<CaptureConfiguration>=>{
  const base={connectionId:createHash('sha256').update(`${auth.authKind}:${auth.keyId}`).digest('hex'),contractVersion:1 as const,receiptContractVersion:1 as const,localEmitterObserved:false as const,
   permittedEventKinds:[] as ('user'|'assistant')[],audience:[] as CaptureConfiguration['audience'],limits:{maxEventBytes:ARCHIVE_TEXT_LIMIT,maxExportEvents:100}}
  const target=await store.resolveTargetSystem({workspaceId:auth.workspaceId,assistantId:auth.captureAssistantId??null,overrideProfileId:auth.captureProfileId??null})
  if(!target||!auth.actingUserId)return {...base,processingPurpose:null,ready:false,failureCode:'capture_profile_not_configured'}
  const labels=target.intakeBinding?.compartments??target.rules.filter(r=>r.routingMode!=='drop').flatMap(r=>r.compartments.length?r.compartments:target.assistantDefaultCompartments)
  const projects=target.intakeBinding?.projectIds??target.rules.filter(r=>r.routingMode!=='drop').flatMap(r=>r.projectIds.length?r.projectIds:target.assistantDefaultProjectId?[target.assistantDefaultProjectId]:[])
  const departments=[...new Set(labels.filter(k=>k.startsWith('team:')).map(k=>k.slice(5)))]
  const projectIds=[...new Set([...projects,...labels.filter(k=>k.startsWith('project:')).map(k=>k.slice(8))])]
  const audience:CaptureConfiguration['audience']=[]
  if(departments.length){const rows=(await queryWithRLS(auth.actingUserId,'SELECT id,name FROM workspace_groups WHERE workspace_id=$1 AND compartment_key=ANY($2::text[]) AND status=\'active\'',[auth.workspaceId,departments.map(k=>`team:${k}`)])).rows
   for(const r of rows)audience.push({kind:'department',id:r.id,label:r.name})}
  if(projectIds.length){const rows=(await queryWithRLS(auth.actingUserId,"SELECT id,name FROM workspace_projects WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND status='active'",[auth.workspaceId,projectIds])).rows
   for(const r of rows)audience.push({kind:'project',id:r.id,label:r.name})}
  const processingPurpose=target.processingMode??'extract'
  let current=false
  if(processingPurpose==='archive_only'&&auth.authKind==='api_key'){
   current=(await queryWithRLS(auth.actingUserId,`SELECT EXISTS(SELECT 1 FROM ingest_rules r JOIN brain_keys k ON k.id=$1 JOIN assistants a ON a.id=$2
    WHERE r.capture_profile_id=$3 AND r.routing_mode<>'drop' AND engineering_capture_current($4,$2,r.id,jsonb_build_object(
      'processingPurpose','archive_only','profileRevision',$5::text,'principalKind','api_key','principalId',k.id::text,'actingUserId',$6::text,
      'keyRevision',k.capture_intake_revision::text,'ruleSnapshot',to_jsonb(r),'sensitivity',coalesce(r.episode_sensitivity,a.clearance)))) AS current`,
    [auth.keyId,target.assistantId,target.profileId,auth.workspaceId,target.revision??'1',auth.actingUserId])).rows[0]?.current===true
  }
  if(current){let admitted=false
   for(const rule of target.rules.filter(r=>r.routingMode!=='drop')){
    const scope={workspaceId:auth.workspaceId,actingUserId:auth.actingUserId,assistantId:target.assistantId,sensitivity:rule.episodeSensitivity??target.assistantClearance,
      compartments:target.intakeBinding?.compartments??(rule.scopeBindingMode==='explicit'?rule.compartments:target.assistantDefaultCompartments),
      projectIds:target.intakeBinding?.projectIds??(rule.scopeBindingMode==='explicit'?rule.projectIds:target.assistantDefaultProjectId?[target.assistantDefaultProjectId]:[])}
    try{await previewArchiveScope(scope);admitted=true;break}catch{}
   }
   current=admitted
  }
  const ready=current&&auth.scope==='read_write'&&auth.authKind==='api_key'&&available()&&processingPurpose==='archive_only'&&audience.length>0&&target.rules.some(r=>r.routingMode!=='drop')
  return {...base,processingPurpose,ready,profileId:target.profileId,profileRevision:target.revision??'1',audience:audience.sort((a,b)=>`${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)),
   permittedEventKinds:ready?['user','assistant']:[],...(!ready?{failureCode:'capture_target_unavailable'}:{})}
 }
}
