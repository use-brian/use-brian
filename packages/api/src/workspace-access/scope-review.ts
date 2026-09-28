/** Durable administrator review; no inference or automatic declassification.
 * [COMP:api/workspace-scope-review]
 */
import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { getPool } from '../db/client.js'
import { WorkspaceAccessError } from './policy.js'
import { notifyWorkspaceChange } from '../brain-stream/notify.js'
import { getDepartmentalReadinessSystem } from './readiness.js'
import type { ScopeReview, ScopeReviewContent, ScopeReviewImpact, ScopeReviewInventory, ScopeReviewKind, ScopeReviewSource, ScopeReviewSummary } from '@use-brian/shared'
import { departmentIsolationManifestCoverage } from '@use-brian/shared'
import {
  getScopeReviewCoverage,
  SCOPE_REVIEW_KINDS,
  SCOPE_REVIEW_REGISTRY_REVISION,
  sourceAdapter,
} from './scope-review-registry.js'

const kindSchema = z.enum(SCOPE_REVIEW_KINDS as [ScopeReviewKind, ...ScopeReviewKind[]])
type Kind = ScopeReviewKind
type Snapshot = ScopeReviewSource
const previewSchema = z.object({
  type:z.literal('scope.review.preview'),resourceKind:kindSchema,
  resourceIds:z.array(z.string().uuid()).min(1).max(100).refine(ids=>new Set(ids.map(id=>id.toLowerCase())).size===ids.length),
  action:z.enum(['confirm_general','assign_team','hold']),targetTeamId:z.string().uuid().nullable(),
  reason:z.string().trim().min(1).max(1000),
}).strict().refine(command=>(command.action==='assign_team')===(command.targetTeamId!==null))
const applySchema=z.object({type:z.enum(['scope.review.apply','scope.review.cancel']),reviewId:z.string().uuid(),
  expectedVersion:z.string().regex(/^[1-9][0-9]*$/),payloadHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict()
export const scopeReviewCommandSchema=z.union([previewSchema,applySchema])
type Job = ScopeReviewSummary
type Item=ScopeReview['items'][number]
const jobColumns=`id,workspace_id AS "workspaceId",resource_kind AS "resourceKind",action,target_team_id AS "targetTeamId",target_compartment AS "targetCompartment",reason,payload_hash AS "payloadHash",selection_revision::text AS "selectionRevision",policy_revision::text AS "policyRevision",version::text,status`
const itemColumns=`resource_id AS "resourceId",resource_version AS "resourceVersion",source_snapshot AS source,content_snapshot AS content,impact_snapshot AS impact,status,result_version AS "resultVersion",error_code AS "errorCode"`

async function requireAdmin(client:PoolClient,workspaceId:string,userId:string,write:boolean) {
  if(write)await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[workspaceId])
  const member=(await client.query<{role:string}>(`SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2${write?' FOR SHARE':''}`,[workspaceId,userId])).rows[0]
  if(!member)throw new WorkspaceAccessError('not_found',404)
  if(!['owner','admin'].includes(member.role))throw new WorkspaceAccessError('admin_required')
}
async function transaction<T>(workspaceId:string,userId:string,write:boolean,fn:(client:PoolClient)=>Promise<T>):Promise<T> {
  const client=await getPool().connect()
  try {
    await client.query(write?'BEGIN':'BEGIN ISOLATION LEVEL REPEATABLE READ')
    await requireAdmin(client,workspaceId,userId,write)
    const result=await fn(client);await client.query('COMMIT');return result
  }catch(error){
    await client.query('ROLLBACK')
    if(error instanceof WorkspaceAccessError)throw error
    if(['23503','23505','23514','P0001','40001','40P01'].includes((error as {code?:string}).code??''))throw new WorkspaceAccessError('scope_review_conflict',409)
    throw error
  }finally{client.release()}
}
async function source(client:PoolClient,workspaceId:string,kind:Kind,id:string):Promise<Snapshot|null>{
  return (await client.query<{source:Snapshot|null}>('SELECT read_scope_review_source($1,$2,$3) AS source',[workspaceId,kind,id])).rows[0].source
}
async function content(client:PoolClient,workspaceId:string,kind:Kind,id:string):Promise<ScopeReviewContent|null>{
  return (await client.query<{content:ScopeReviewContent|null}>('SELECT read_scope_review_content($1,$2,$3) AS content',[workspaceId,kind,id])).rows[0].content
}
async function policy(client:PoolClient,workspaceId:string):Promise<string>{
  return (await client.query<{revision:string}>('SELECT revision::text FROM workspace_access_policies WHERE workspace_id=$1',[workspaceId])).rows[0]?.revision??'1'
}
const manifestCoverage=departmentIsolationManifestCoverage()
async function completeCoverage(client:PoolClient,workspaceId:string){
  if(!manifestCoverage.complete)return false
  const coverage=await getScopeReviewCoverage(client,workspaceId)
  const reviewed=(await client.query<{revision:string|null}>('SELECT reviewed_inventory_revision::text AS revision FROM workspace_access_policies WHERE workspace_id=$1',[workspaceId])).rows[0]?.revision??null
  return coverage.unresolved==='0'&&reviewed===coverage.registryRevision
}
function canonical(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`
  if(value!==null&&typeof value==='object')return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}
function hash(job:Pick<Job,'workspaceId'|'resourceKind'|'action'|'targetTeamId'|'targetCompartment'|'reason'|'selectionRevision'>,snapshots:Snapshot[],impacts:Array<ScopeReviewImpact|null>=[],contents:Array<ScopeReviewContent|null>=[]):string{
  return createHash('sha256').update(canonical({workspaceId:job.workspaceId,resourceKind:job.resourceKind,action:job.action,
    targetTeamId:job.targetTeamId,targetCompartment:job.targetCompartment,reason:job.reason,selectionRevision:job.selectionRevision,snapshots,
    // Preserve old hashes for inspection/cancellation, never silently upgrade them.
    ...(impacts.some(impact=>impact!==null)?{impacts}:{}),
    ...(contents.some(item=>item!==null)?{contents}:{})})).digest('hex')
}

/** Block source validators on the entire predecessor chain before freezing reach. */
async function lockSourceAncestry(client:PoolClient,workspaceId:string,kind:Kind,id:string){
  const adapter=sourceAdapter(kind)
  if(adapter.actions.includes('assign_team')){
    await client.query(`SELECT r.id FROM ${adapter.table} r WHERE r.workspace_id=$1
      AND r.id IN(SELECT resource_id FROM scope_source_ancestors($1,$2,$3)) ORDER BY r.id FOR UPDATE`,[workspaceId,kind,id])
    return
  }
  await client.query(`SELECT r.id FROM ${adapter.from} WHERE ${adapter.workspacePredicate}
    AND r.id=$2 ORDER BY r.id FOR UPDATE OF r`,[workspaceId,id])
}

/** Same traversal as invalidation. Stabilize after locking, since a concurrent
 * derivation may have committed while its source row lock was being acquired. */
async function captureImpact(client:PoolClient,workspaceId:string,kind:Kind,id:string,action:Job['action'],held:boolean):Promise<ScopeReviewImpact>{
  if(sourceAdapter(kind).category==='impact'||action==='confirm_general'||(action==='hold'&&held))return {version:2,descendants:[],dependents:{}}
  const read=async()=> (await client.query<{resourceKind:Kind;resourceId:string}>(
    `SELECT resource_kind AS "resourceKind",resource_id AS "resourceId"
       FROM scope_descendant_resources($1,$2,$3)
      ORDER BY resource_kind,resource_id LIMIT 501`,[workspaceId,kind,id])).rows
  const locked=new Set<string>()
  let rows:Awaited<ReturnType<typeof read>>=[]
  for(let pass=0;pass<4;pass++){
    rows=await read()
    if(rows.length>500)throw new WorkspaceAccessError('scope_review_impact_too_large',409)
    const additions=rows.filter(row=>!locked.has(`${row.resourceKind}:${row.resourceId}`))
    if(additions.length===0)break
    for(const descendantKind of [...new Set(additions.map(row=>row.resourceKind))]){
      const ids=additions.filter(row=>row.resourceKind===descendantKind).map(row=>row.resourceId)
      const adapter=sourceAdapter(descendantKind)
      await client.query(`SELECT r.id FROM ${adapter.from} WHERE ${adapter.workspacePredicate}
        AND r.id=ANY($2::uuid[]) ORDER BY r.id FOR UPDATE OF r`,[workspaceId,ids])
      ids.forEach(resourceId=>locked.add(`${descendantKind}:${resourceId}`))
    }
  }
  rows=await read()
  if(rows.length>500)throw new WorkspaceAccessError('scope_review_impact_too_large',409)
  if(rows.some(row=>!locked.has(`${row.resourceKind}:${row.resourceId}`)))throw new WorkspaceAccessError('scope_review_changed',409)
  const descendants=[] as Extract<ScopeReviewImpact,{version:2}>['descendants']
  for(const row of rows){
    const snapshot=await source(client,workspaceId,row.resourceKind,row.resourceId)
    if(!snapshot)throw new WorkspaceAccessError('scope_review_changed',409)
    descendants.push({resourceKind:row.resourceKind,resourceId:row.resourceId,version:snapshot.version,held:snapshot.held})
  }
  const dependents:Record<string,string>={}
  if(kind==='workspace_file'){
    const counts=await client.query<{family:string;count:string}>(`SELECT family,count(*)::text AS count FROM (
      SELECT 'file_cache'::text family FROM file_cache WHERE workspace_id=$1 AND artifact_file_id=$2
      UNION ALL SELECT 'file_segment' FROM file_segments WHERE workspace_id=$1 AND file_id=$2
      UNION ALL SELECT 'recording' FROM recordings WHERE workspace_id=$1 AND (transcript_file_id=$2 OR media_file_id=$2)
      UNION ALL SELECT 'office_artifact' FROM office_artifact_versions WHERE workspace_id=$1 AND snapshot_file_id=$2
    ) impacted GROUP BY family ORDER BY family`,[workspaceId,id])
    for(const row of counts.rows)dependents[row.family]=row.count
  }else if(kind==='episode'){
    const counts=await client.query<{family:string;count:string}>(`SELECT family,count(*)::text AS count FROM (
      SELECT 'recording'::text family FROM recordings WHERE workspace_id=$1 AND id=$2
      UNION ALL SELECT 'transcript_segment' FROM transcript_segments WHERE workspace_id=$1 AND recording_id=$2
      UNION ALL SELECT 'blueprint_record' FROM blueprint_records WHERE workspace_id=$1 AND source_kind='recording' AND source_id=$2::text
    ) impacted GROUP BY family ORDER BY family`,[workspaceId,id])
    for(const row of counts.rows)dependents[row.family]=row.count
  }
  return {version:2,descendants,dependents}
}

function checkImpactLimit(impacts:ScopeReviewImpact[]){
  if(new Set(impacts.flatMap(impact=>impact.descendants.map(row=>`${'resourceKind' in row?row.resourceKind:'memory'}:${row.resourceId}`))).size>500)
    throw new WorkspaceAccessError('scope_review_impact_too_large',409)
}
async function view(client:PoolClient,workspaceId:string,id:string):Promise<ScopeReview>{
  const job=(await client.query<Job>(`SELECT ${jobColumns} FROM workspace_scope_reviews WHERE workspace_id=$1 AND id=$2`,[workspaceId,id])).rows[0]
  if(!job)throw new WorkspaceAccessError('not_found',404)
  const items=(await client.query<Item>(`SELECT ${itemColumns} FROM workspace_scope_review_items WHERE workspace_id=$1 AND review_id=$2 ORDER BY resource_id`,[workspaceId,id])).rows
  return {...job,items,completeCoverage:await completeCoverage(client,workspaceId),validForMs:30_000}
}

/** Content-bearing inventory over every frozen source and impact family. */
export async function getWorkspaceScopeInventory(workspaceId:string,userId:string,kind:unknown='memory',after?:string,reviewId?:string,reviewAfter?:string):Promise<ScopeReviewInventory>{
  const parsed=kindSchema.safeParse(kind)
  if(!parsed.success||(after&&!z.string().uuid().safeParse(after).success)||(reviewId&&!z.string().uuid().safeParse(reviewId).success)||(reviewAfter&&!z.string().uuid().safeParse(reviewAfter).success))throw new WorkspaceAccessError('invalid_command',400)
  return transaction(workspaceId,userId,false,async client=>{
    const adapter=sourceAdapter(parsed.data)
    const base=`FROM (SELECT r.id FROM ${adapter.from} WHERE ${adapter.workspacePredicate}) rows
      CROSS JOIN LATERAL (SELECT read_scope_review_source($1,$2,rows.id) AS body) evidence
      CROSS JOIN LATERAL (SELECT read_scope_review_content($1,$2,rows.id) AS body) display
      WHERE evidence.body IS NOT NULL AND display.body IS NOT NULL AND (
        coalesce((evidence.body->>'held')::boolean,false)
        OR evidence.body->>'sensitivity' IS NULL
        OR jsonb_typeof(evidence.body->'compartments') IS DISTINCT FROM 'array'
        OR jsonb_typeof(evidence.body->'projectIds') IS DISTINCT FROM 'array'
        OR (jsonb_array_length(evidence.body->'compartments')=0
          AND NOT EXISTS(SELECT 1 FROM scope_resource_states s
            WHERE s.workspace_id=$1 AND s.resource_kind=$2 AND s.resource_id=rows.id
              AND s.resource_version=evidence.body->>'version' AND s.review_state='reviewed')))`
    const rows=(await client.query<Omit<ScopeReviewInventory['items'][number],'allowedActions'>>(
      `SELECT rows.id,evidence.body->>'version' AS version,
        coalesce((evidence.body->>'held')::boolean,false) AS held,
        evidence.body->>'sensitivity' AS sensitivity,
        evidence.body->'compartments' AS compartments,
        evidence.body->'projectIds' AS "projectIds",
        evidence.body->>'userId' AS "userId",evidence.body->>'assistantId' AS "assistantId",
        (NOT coalesce((evidence.body->>'held')::boolean,false)
          AND evidence.body->>'sensitivity' IS NOT NULL
          AND jsonb_typeof(evidence.body->'compartments')='array'
          AND jsonb_typeof(evidence.body->'projectIds')='array') AS "canClassify",
        display.body AS content ${base}
        AND ($3::uuid IS NULL OR rows.id>$3) ORDER BY rows.id LIMIT 101`,
      [workspaceId,parsed.data,after??null])).rows
    const total=(await client.query<{count:string}>(`SELECT count(*)::text AS count ${base}`,[workspaceId,parsed.data])).rows[0].count
    // Resolve the anchor in this workspace and snapshot. Foreign and missing
    // IDs have identical outcomes; never interpret an invalid anchor as page one.
    if(reviewAfter&&!(await client.query('SELECT 1 FROM workspace_scope_reviews WHERE workspace_id=$1 AND id=$2',[workspaceId,reviewAfter])).rows.length)throw new WorkspaceAccessError('not_found',404)
    const reviewRows=(await client.query<Job>(`SELECT ${jobColumns} FROM workspace_scope_reviews
      WHERE workspace_id=$1 AND ($2::uuid IS NULL OR (created_at,id)<(
        SELECT created_at,id FROM workspace_scope_reviews WHERE workspace_id=$1 AND id=$2))
      ORDER BY created_at DESC,id DESC LIMIT 21`,[workspaceId,reviewAfter??null])).rows
    const recentReviews=reviewRows.slice(0,20)
    const coverage=await getScopeReviewCoverage(client,workspaceId)
    const policyRow=(await client.query<{revision:string;reviewedInventoryRevision:string|null;classificationMode:'legacy'|'review'|'strict'}>(`SELECT revision::text,reviewed_inventory_revision::text AS "reviewedInventoryRevision",classification_mode AS "classificationMode"
      FROM workspace_access_policies WHERE workspace_id=$1`,[workspaceId])).rows[0]
    const reviewed=policyRow?.reviewedInventoryRevision??null
    const coverageComplete=manifestCoverage.complete&&coverage.unresolved==='0'&&reviewed===coverage.registryRevision
    const readiness=await getDepartmentalReadinessSystem(workspaceId,client.query.bind(client))
    return {resourceKind:parsed.data,total,items:rows.slice(0,100).map(row=>({...row,allowedActions:[...adapter.actions]})),nextCursor:rows.length>100?rows[99].id:null,
      supportedKinds:[...SCOPE_REVIEW_KINDS],completeCoverage:coverageComplete,validForMs:30_000,recentReviews,nextReviewCursor:reviewRows.length>20?reviewRows[19].id:null,
      selectedReview:reviewId?await view(client,workspaceId,reviewId):null,
      policyRevision:policyRow?.revision??'1',classificationMode:policyRow?.classificationMode??'legacy',readiness,canActivateStrict:coverageComplete&&readiness.ready&&policyRow?.classificationMode!=='strict',
      registryRevision:String(SCOPE_REVIEW_REGISTRY_REVISION),reviewedInventoryRevision:reviewed,coverage,
      uncovered:[...manifestCoverage.missingCases,...manifestCoverage.missingCapabilities,
        ...(coverage.unresolved==='0'?[]:coverage.families.filter(family=>family.unresolved!=='0').map(family=>family.family)),
        ...(reviewed===coverage.registryRevision?[]:['reviewed_inventory_revision'])]}
  })
}
export async function getWorkspaceScopeReview(workspaceId:string,userId:string,id:string){
  if(!z.string().uuid().safeParse(id).success)throw new WorkspaceAccessError('not_found',404)
  return transaction(workspaceId,userId,false,client=>view(client,workspaceId,id))
}

export async function executeWorkspaceScopeReview(workspaceId:string,userId:string,input:unknown){
  const parsed=scopeReviewCommandSchema.safeParse(input)
  if(!parsed.success)throw new WorkspaceAccessError('invalid_command',400)
  const command=parsed.data
  const result=await transaction(workspaceId,userId,true,async client=>{
    await client.query('INSERT INTO workspace_access_policies(workspace_id) VALUES($1) ON CONFLICT DO NOTHING',[workspaceId])
    await client.query('SELECT workspace_id FROM workspace_access_policies WHERE workspace_id=$1 FOR UPDATE',[workspaceId])
    if(command.type==='scope.review.preview'){
      const adapter=sourceAdapter(command.resourceKind)
      if(!adapter.actions.includes(command.action))throw new WorkspaceAccessError('scope_review_action_unsupported',409)
      let targetCompartment:string|null=null
      if(command.targetTeamId){
        targetCompartment=(await client.query<{key:string}>("SELECT compartment_key AS key FROM workspace_groups WHERE workspace_id=$1 AND id=$2 AND kind='team' AND status='active' FOR SHARE",[workspaceId,command.targetTeamId])).rows[0]?.key??null
        if(!targetCompartment)throw new WorkspaceAccessError('not_found',404)
      }
      const snapshots:Snapshot[]=[],impacts:ScopeReviewImpact[]=[],contents:ScopeReviewContent[]=[]
      for(const id of command.resourceIds.map(id=>id.toLowerCase()).sort()){
        await lockSourceAncestry(client,workspaceId,command.resourceKind,id)
        const current=await source(client,workspaceId,command.resourceKind,id)
        if(!current)throw new WorkspaceAccessError('scope_review_selection_unavailable',409)
        const display=await content(client,workspaceId,command.resourceKind,id)
        if(!display)throw new WorkspaceAccessError('scope_review_selection_unavailable',409)
        if(command.action!=='hold'&&(current.held||current.sensitivity===null||current.compartments===null||current.projectIds===null||current.compartments.length>0||current.validTo||current.retractedAt))throw new WorkspaceAccessError('scope_review_release_required',409)
        snapshots.push(current)
        contents.push(display)
        impacts.push(await captureImpact(client,workspaceId,command.resourceKind,id,command.action,current.held))
        checkImpactLimit(impacts)
      }
      const id=randomUUID(),revision=await policy(client,workspaceId)
      const payloadHash=hash({...command,workspaceId,targetCompartment,selectionRevision:revision},snapshots,impacts,contents)
      await client.query(`INSERT INTO workspace_scope_reviews(id,workspace_id,created_by,resource_kind,action,target_team_id,target_compartment,reason,payload_hash,policy_revision,selection_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
        [id,workspaceId,userId,command.resourceKind,command.action,command.targetTeamId,targetCompartment,command.reason,payloadHash,revision])
      for(const [index,snapshot] of snapshots.entries())await client.query(`INSERT INTO workspace_scope_review_items(workspace_id,review_id,resource_kind,resource_id,resource_version,source_snapshot,content_snapshot,impact_snapshot) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb)`,[workspaceId,id,command.resourceKind,snapshot.resourceId,snapshot.version,JSON.stringify(snapshot),JSON.stringify(contents[index]),JSON.stringify(impacts[index])])
      await audit(client,workspaceId,userId,'scope.review.preview',id,revision,{action:command.action,targetTeamId:command.targetTeamId,payloadHash,items:snapshots,contents,impacts})
      return view(client,workspaceId,id)
    }
    await client.query('SELECT id FROM workspace_scope_reviews WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[workspaceId,command.reviewId])
    const job=await view(client,workspaceId,command.reviewId)
    if(job.payloadHash!==command.payloadHash||hash(job,job.items.map(item=>item.source),job.items.map(item=>item.impact),job.items.map(item=>item.content))!==job.payloadHash)throw new WorkspaceAccessError('scope_review_changed',409)
    if(BigInt(command.expectedVersion)>BigInt(job.version))throw new WorkspaceAccessError('scope_review_changed',409)
    if(command.expectedVersion!==job.version||['complete','stale','cancelled'].includes(job.status))return job
    if(command.type==='scope.review.cancel'){
      await client.query("UPDATE workspace_scope_review_items SET status='cancelled' WHERE workspace_id=$1 AND review_id=$2 AND status='pending'",[workspaceId,job.id])
      await client.query("UPDATE workspace_scope_reviews SET status='cancelled',version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2",[workspaceId,job.id])
      await audit(client,workspaceId,userId,'scope.review.cancel',job.id,await policy(client,workspaceId),{payloadHash:job.payloadHash})
      return view(client,workspaceId,job.id)
    }
    const pending=job.items.filter(item=>item.status==='pending')
    if(job.items.some(item=>!item.impact))throw new WorkspaceAccessError('scope_review_impact_missing',409)
    if(job.items.some(item=>!item.content))throw new WorkspaceAccessError('scope_review_content_missing',409)
    if(job.items.some(item=>item.impact?.version!==2))throw new WorkspaceAccessError('scope_review_impact_missing',409)
    // A previous page may have held descendants shared with the remaining roots.
    const previouslyHeld=new Set(job.items.filter(item=>item.status==='applied').flatMap(item=>item.impact!.descendants.map(row=>`${'resourceKind' in row?row.resourceKind:'memory'}:${row.resourceId}`)))
    let stale=(await policy(client,workspaceId))!==job.policyRevision
    if(job.targetTeamId&&!stale)stale=!(await client.query("SELECT 1 FROM workspace_groups WHERE workspace_id=$1 AND id=$2 AND kind='team' AND status='active' AND compartment_key=$3 FOR SHARE",[workspaceId,job.targetTeamId,job.targetCompartment])).rows.length
    for(const item of pending){
      if(stale)break
      await lockSourceAncestry(client,workspaceId,job.resourceKind,item.resourceId)
      const current=await source(client,workspaceId,job.resourceKind,item.resourceId)
      if(canonical(current)!==canonical(item.source))stale=true
      if(!stale&&canonical(await content(client,workspaceId,job.resourceKind,item.resourceId))!==canonical(item.content))stale=true
      if(!stale){
        const impact=await captureImpact(client,workspaceId,job.resourceKind,item.resourceId,job.action,current!.held)
        const expected={...item.impact!,descendants:item.impact!.descendants.map(row=>({...row,held:row.held||previouslyHeld.has(`${'resourceKind' in row?row.resourceKind:'memory'}:${row.resourceId}`)}))}
        if(canonical(impact)!==canonical(expected))stale=true
      }
    }
    if(stale){
      await client.query("UPDATE workspace_scope_review_items SET status='stale',error_code='scope_review_changed' WHERE workspace_id=$1 AND review_id=$2 AND status='pending'",[workspaceId,job.id])
      await client.query("UPDATE workspace_scope_reviews SET status='stale',version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2",[workspaceId,job.id])
      await audit(client,workspaceId,userId,'scope.review.stale',job.id,await policy(client,workspaceId),{payloadHash:job.payloadHash})
      return view(client,workspaceId,job.id)
    }
    const applied:Array<{before:Snapshot;after:Snapshot}>=[]
    let interrupted=false
    for(const item of pending.slice(0,25)){
      // An earlier item can invalidate a selected derived descendant in this
      // same page. Never certify that newly held descendant from an old preview.
      if(canonical(await source(client,workspaceId,job.resourceKind,item.resourceId))!==canonical(item.source)){
        interrupted=true;break
      }
      const adapter=sourceAdapter(job.resourceKind)
      if(job.action==='assign_team')await client.query(`UPDATE ${adapter.table} SET compartments=ARRAY[$3::text] WHERE workspace_id=$1 AND id=$2`,[workspaceId,item.resourceId,job.targetCompartment])
      if(job.action==='hold'){
        if(adapter.category==='source'&&!['session_message','feedback_event'].includes(job.resourceKind)){
          await client.query(`UPDATE ${adapter.table} SET scope_held=true WHERE workspace_id=$1 AND id=$2`,[workspaceId,item.resourceId])
          if(!item.source.held)await client.query('SELECT hold_scope_descendants($1,$2,$3)',[workspaceId,job.resourceKind,item.resourceId])
        }
      }
      const changed=(await source(client,workspaceId,job.resourceKind,item.resourceId))!
      await client.query(`INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(workspace_id,resource_kind,resource_id,resource_version) DO UPDATE SET review_state=excluded.review_state,classification_revision=excluded.classification_revision,holding_reason=excluded.holding_reason,updated_at=now()`,
        [workspaceId,job.resourceKind,item.resourceId,changed.version,job.action==='hold'?'held':'reviewed',await policy(client,workspaceId),job.action==='hold'?'administrator_review':null])
      const after=(await source(client,workspaceId,job.resourceKind,item.resourceId))!
      await client.query("UPDATE workspace_scope_review_items SET status='applied',result_version=$4 WHERE workspace_id=$1 AND review_id=$2 AND resource_id=$3",[workspaceId,job.id,item.resourceId,after.version])
      applied.push({before:item.source,after})
    }
    await client.query("UPDATE workspace_access_policies SET classification_mode=CASE WHEN classification_mode='legacy' THEN 'review' ELSE classification_mode END,revision=revision+1,updated_at=now() WHERE workspace_id=$1",[workspaceId])
    const revision=await policy(client,workspaceId)
    const coverage=await getScopeReviewCoverage(client,workspaceId)
    await client.query('UPDATE workspace_access_policies SET reviewed_inventory_revision=$2 WHERE workspace_id=$1',[workspaceId,coverage.unresolved==='0'?SCOPE_REVIEW_REGISTRY_REVISION:null])
    if(interrupted)await client.query("UPDATE workspace_scope_review_items SET status='stale',error_code='scope_review_changed' WHERE workspace_id=$1 AND review_id=$2 AND status='pending'",[workspaceId,job.id])
    await client.query('UPDATE workspace_scope_reviews SET status=$3,version=version+1,policy_revision=$4,updated_at=now() WHERE workspace_id=$1 AND id=$2',[workspaceId,job.id,interrupted?'stale':pending.length<=25?'complete':'running',revision])
    await audit(client,workspaceId,userId,'scope.review.apply',job.id,revision,{payloadHash:job.payloadHash,applied})
    return view(client,workspaceId,job.id)
  })
  notifyWorkspaceChange(workspaceId,'workspace_config','update')
  return result
}
async function audit(client:PoolClient,workspaceId:string,userId:string,kind:string,id:string,revision:string,changes:unknown){
  await client.query('INSERT INTO workspace_access_events(workspace_id,actor_user_id,kind,subject_id,policy_revision,changes) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[workspaceId,userId,kind,id,revision,JSON.stringify(changes)])
}
