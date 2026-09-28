/** Directory edits share immutable review storage and transactional settlement. [COMP:api/organization-chart] */
import {randomUUID} from 'node:crypto'
import type {OrganizationChart,OrganizationCommand,OrganizationCommandReview} from '@use-brian/shared'
import {executeOrganizationCommandInTransaction,getOrganizationChartInTransaction} from '../db/org-chart-store.js'
import {notifyWorkspaceChange} from '../brain-stream/notify.js'
import {getWorkspaceAccessInTransaction} from './service.js'
import {hashCommandReviewIntent as hash,withCommandReviewTransaction as transaction} from './command-review.js'
import {organizationCommandIntentSchema,organizationCommandApplySchema} from './commands.js'
import {WorkspaceAccessError} from './policy.js'

type Row={id:string;payloadHash:string;intentHash:string;policyRevision:string;revision:string;command:OrganizationCommand;effects:OrganizationCommandReview['effects'];expiresAt:Date;status:'preview'|'applied'}
const columns=`id,payload_hash AS "payloadHash",intent_hash AS "intentHash",policy_revision::text AS "policyRevision",organization_revision::text AS revision,command,changes AS effects,expires_at AS "expiresAt",status`
const project=(row:Row,validForMs:number):OrganizationCommandReview=>({id:row.id,payloadHash:row.payloadHash,policyRevision:row.policyRevision,revision:row.revision,command:row.command,effects:row.effects,expiresAt:row.expiresAt.toISOString(),validForMs})

function effects(before:OrganizationChart,after:OrganizationChart):OrganizationCommandReview['effects'] {
  const names=(chart:OrganizationChart)=>new Map([...chart.units,...chart.teams,...chart.subjects].map(row=>[row.id,row.name]))
  const beforeNames=names(before),afterNames=names(after)
  const result:OrganizationCommandReview['effects']=[]
  for(const kind of ['unit','placement'] as const){
    const previous=kind==='unit'?before.units:before.placements,next=kind==='unit'?after.units:after.placements
    const fields=kind==='unit'?['name','parentId','teamId','directoryVisibility','position']:['unitId','userId','assistantId','isPrimary','reportsToUserId','accountableUserId']
    for(const id of new Set([...previous,...next].map(row=>row.id))){
      const old=previous.find(row=>row.id===id),fresh=next.find(row=>row.id===id)
      const a:Record<string,unknown>=old??{},b:Record<string,unknown>=fresh??{}
      const value=(field:string,input:unknown,labels:Map<string,string>)=>input===undefined||input===null?[{kind:'code' as const,value:'none'}]:field.endsWith('Id')?[labels.get(String(input))?{kind:'text' as const,value:labels.get(String(input))!}:{kind:'code' as const,value:'unnamed'}]:[{kind:field==='directoryVisibility'||typeof input==='boolean'?'code' as const:'text' as const,value:typeof input==='boolean'?input?'enabled':'disabled':String(input)}]
      const changes=fields.filter(field=>hash(a[field]??null)!==hash(b[field]??null)).map(field=>({field,before:value(field,a[field],beforeNames),after:value(field,b[field],afterNames)}))
      if(!old||!fresh)changes.unshift({field:'exists',before:[{kind:'code',value:old?'enabled':'disabled'}],after:[{kind:'code',value:fresh?'enabled':'disabled'}]})
      if(!changes.length)continue
      const row=fresh??old!
      const name=kind==='unit'?String((row as {name:string}).name):afterNames.get(String(b.userId??b.assistantId))??beforeNames.get(String(a.userId??a.assistantId))??''
      result.push({kind,name,changes})
    }
  }
  return result
}

export async function prepareOrganizationCommand(workspaceId:string,userId:string,input:unknown):Promise<OrganizationCommandReview>{
  const parsed=organizationCommandIntentSchema.safeParse(input);if(!parsed.success)throw new WorkspaceAccessError('invalid_command',400)
  const intent=parsed.data,intentHash=hash(intent)
  return transaction(async client=>{
    const access=await getWorkspaceAccessInTransaction(client,workspaceId,userId,true)
    const current=await getOrganizationChartInTransaction(client,workspaceId,userId)
    const existing=(await client.query<Row>(`SELECT ${columns} FROM workspace_access_command_reviews WHERE workspace_id=$1 AND actor_user_id=$2 AND idempotency_key=$3`,[workspaceId,userId,intent.idempotencyKey])).rows[0]
    if(existing&&existing.intentHash!==intentHash)throw new WorkspaceAccessError('access_idempotency_conflict',409)
    if(existing?.status==='applied')return{...project(existing,current.validForMs),command:intent.command,effects:[],revision:current.revision,policyRevision:access.policyRevision,alreadyApplied:true}
    if(!current.canManage)throw new WorkspaceAccessError('admin_required')
    if(current.revision!==intent.expectedRevision||access.policyRevision!==intent.expectedPolicyRevision)throw new WorkspaceAccessError('access_policy_conflict',409)
    const now=(await client.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now
    if(existing){if(existing.expiresAt<=now)throw new WorkspaceAccessError('access_review_expired',409);return project(existing,Math.min(current.validForMs,existing.expiresAt.getTime()-now.getTime()))}
    await client.query('SAVEPOINT organization_preview')
    const simulated=await executeOrganizationCommandInTransaction(client,workspaceId,userId,intent.command)
    const changes=effects(current,simulated)
    await client.query('ROLLBACK TO SAVEPOINT organization_preview');await client.query('RELEASE SAVEPOINT organization_preview')
    const id=randomUUID(),expiresAt=new Date(now.getTime()+15*60_000),payloadHash=hash({workspaceId,userId,id,command:intent.command,revision:current.revision,policyRevision:access.policyRevision,effects:changes,expiresAt:expiresAt.toISOString()})
    const row=(await client.query<Row>(`INSERT INTO workspace_access_command_reviews(id,workspace_id,actor_user_id,idempotency_key,intent_hash,command,policy_revision,organization_revision,changes,payload_hash,expires_at)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb,$10,$11) RETURNING ${columns}`,[id,workspaceId,userId,intent.idempotencyKey,intentHash,JSON.stringify(intent.command),access.policyRevision,current.revision,JSON.stringify(changes),payloadHash,expiresAt])).rows[0]
    return project(row,Math.min(current.validForMs,15*60_000))
  })
}

export async function applyOrganizationCommand(workspaceId:string,userId:string,input:unknown):Promise<OrganizationChart>{
  const parsed=organizationCommandApplySchema.safeParse(input);if(!parsed.success)throw new WorkspaceAccessError('access_review_required',409)
  const result=await transaction(async client=>{
    const access=await getWorkspaceAccessInTransaction(client,workspaceId,userId,true)
    const current=await getOrganizationChartInTransaction(client,workspaceId,userId)
    const row=(await client.query<Row>(`SELECT ${columns} FROM workspace_access_command_reviews WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3 AND organization_revision IS NOT NULL FOR UPDATE`,[workspaceId,userId,parsed.data.reviewId])).rows[0]
    if(!row)throw new WorkspaceAccessError('not_found',404)
    if(row.payloadHash!==parsed.data.payloadHash)throw new WorkspaceAccessError('access_review_changed',409)
    if(row.status==='applied')return{...current,commandReceipt:{reviewId:row.id,replayed:true}}
    if(!current.canManage)throw new WorkspaceAccessError('admin_required')
    const now=(await client.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now
    if(row.expiresAt<=now)throw new WorkspaceAccessError('access_review_expired',409)
    if(row.revision!==current.revision||row.policyRevision!==access.policyRevision)throw new WorkspaceAccessError('access_policy_conflict',409)
    const applied=await executeOrganizationCommandInTransaction(client,workspaceId,userId,row.command)
    if(hash(effects(current,applied))!==hash(row.effects))throw new WorkspaceAccessError('access_review_changed',409)
    await client.query("UPDATE workspace_access_command_reviews SET status='applied',applied_at=clock_timestamp(),receipt=$4::jsonb WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3",[workspaceId,userId,row.id,JSON.stringify({appliedCommand:applied.appliedCommand})])
    return{...applied,commandReceipt:{reviewId:row.id,replayed:false}}
  })
  if(!result.commandReceipt?.replayed)notifyWorkspaceChange(workspaceId,'workspace_config','update')
  return result
}

export async function applyOrganizationCommandIntent(workspaceId:string,userId:string,input:unknown):Promise<OrganizationChart>{
  const parsed=organizationCommandIntentSchema.safeParse(input);if(!parsed.success)throw new WorkspaceAccessError('invalid_command',400)
  const proof=await transaction(async client=>{
    await getWorkspaceAccessInTransaction(client,workspaceId,userId)
    const row=(await client.query<Row>(`SELECT ${columns} FROM workspace_access_command_reviews WHERE workspace_id=$1 AND actor_user_id=$2 AND idempotency_key=$3`,[workspaceId,userId,parsed.data.idempotencyKey])).rows[0]
    if(!row)throw new WorkspaceAccessError('access_review_required',409)
    if(row.intentHash!==hash(parsed.data))throw new WorkspaceAccessError('access_idempotency_conflict',409)
    return{type:'org.command.apply' as const,reviewId:row.id,payloadHash:row.payloadHash}
  })
  return applyOrganizationCommand(workspaceId,userId,proof)
}
