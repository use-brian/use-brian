/** Bounded principal/resource migration only. No inventory certification or mode finalizer. */
import {randomUUID} from 'node:crypto'
import {z} from 'zod'
import type {PoolClient} from 'pg'
import type {DepartmentAccessCommand, DepartmentCommandReview} from '@use-brian/shared'
import {getPool} from '../db/client.js'
import {createDbContextScopeStore} from '../db/context-scope-store.js'
import {resolveOperationCeilingsSystem} from '../db/workspace-store.js'
import {executeWorkspaceScopeReviewInTransaction, getWorkspaceScopeReviewInTransaction} from './scope-review.js'
import {SCOPE_REVIEW_KINDS, sourceAdapter} from './scope-review-registry.js'
import {notifyWorkspaceChange} from '../brain-stream/notify.js'
import {departmentCommandApplySchema, departmentAccessCommandSchema} from './commands.js'
import {applyDepartmentCommand, prepareDepartmentCommand, hashCommandReviewIntent, withCommandReviewTransaction} from './command-review.js'
import {executeDepartmentAccessInTransaction, getWorkspaceAccessDirectoryInTransaction} from './service.js'
import {WorkspaceAccessError} from './policy.js'

export type PrincipalMigrationAction = Extract<DepartmentAccessCommand,{type:'member.access.set'|'department.member.set'|'department.assistant.set'|'assistant.audience.set'}>
const allowed = new Set(['member.access.set','department.member.set','department.assistant.set','assistant.audience.set'])
export const resourceMigrationActionSchema=z.object({
  type:z.literal('resource.scope'),resourceKind:z.enum(SCOPE_REVIEW_KINDS),resourceId:z.string().uuid().transform(id=>id.toLowerCase()),
  action:z.enum(['confirm_general','assign_team','hold','consolidate_default']),targetTeamId:z.string().uuid().transform(id=>id.toLowerCase()).optional(),
}).strict().refine(a=>['assign_team','consolidate_default'].includes(a.action)===(a.targetTeamId!==undefined))
export type ResourceMigrationAction=z.infer<typeof resourceMigrationActionSchema>
export type MigrationAction=PrincipalMigrationAction|ResourceMigrationAction
export const migrationItemApplySchema=z.union([departmentCommandApplySchema,z.object({
  kind:z.literal('resource'),reviewId:z.string().uuid(),expectedVersion:z.string().regex(/^[1-9][0-9]*$/),
  payloadHash:z.string().regex(/^[a-f0-9]{64}$/),expiresAt:z.string().datetime(),
}).strict()])
export type MigrationItemApply=z.infer<typeof migrationItemApplySchema>
const actionSchema=z.union([departmentAccessCommandSchema.refine(c=>allowed.has(c.type)),resourceMigrationActionSchema])
export const migrationPlanCreateSchema=z.object({targetMode:z.enum(['simple','departments']),idempotencyKey:z.string().uuid(),items:z.array(z.object({command:actionSchema,reason:z.string().trim().min(1).max(1000)}).strict()).max(25)}).strict()
const blockers=['full_inventory_required','intake_certification_required','mode_finalizer_unavailable']
type Plan={id:string;actor_user_id:string;status:string;proposal_hash:string;version:string;expires_at:Date;intended_population:{intentHash:string}}
type Item={id:string;proposed_action:MigrationAction;status:string;version:string;command_review_id:string|null;scope_review_id:string|null;reason:string;evidence_versions:{policyRevision:string;reviewKey:string};idempotency_key:string}
function fail(code:string):never{throw new WorkspaceAccessError(code,409)}
// Plans read only the actor's role, policy revision and visible people: the
// directory view. The full overview would also compose request/grant history
// and the departmental readiness audit, which no migration step consumes.
// Writers lock the policy; a plain read (`lock=false`) never row-locks the
// workspace, so listing plans cannot serialize behind or block other writers.
async function admin(c:PoolClient,w:string,u:string,lock=true){const view=await getWorkspaceAccessDirectoryInTransaction(c,w,u,lock);if(!view.canAdminister)throw new WorkspaceAccessError('admin_required');return view}
// Nonblocking session lock spans canonical transactions/checkpoints, never human
// input. Waiting on this lock while retaining a pooled connection can exhaust the
// pool and starve the winning operation's canonical review transaction.
// Thread the reserved session through every phase, including canonical helpers:
// a single-connection pool cannot lend a second client while this lock is held.
async function serialized<T>(w:string,run:(client:PoolClient)=>Promise<T>){
  const c=await getPool().connect();let locked=false
  try{
    locked=(await c.query<{locked:boolean}>("SELECT pg_try_advisory_lock(hashtextextended($1,620)) AS locked",[w])).rows[0].locked
    if(!locked)fail('migration_busy')
    return await run(c)
  }finally{
    try{if(locked)await c.query("SELECT pg_advisory_unlock(hashtextextended($1,620))",[w])}finally{c.release()}
  }
}
async function plan(c:PoolClient,w:string,id:string){const row=(await c.query<Plan>('SELECT * FROM workspace_access_migration_plans WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[w,id])).rows[0];if(!row)throw new WorkspaceAccessError('not_found',404);return row}
async function item(c:PoolClient,w:string,p:string,id:string){const row=(await c.query<Item>('SELECT * FROM workspace_access_migration_items WHERE workspace_id=$1 AND plan_id=$2 AND id=$3 FOR UPDATE',[w,p,id])).rows[0];if(!row)throw new WorkspaceAccessError('not_found',404);return row}
function active(p:Plan){if(['paused','cancelled','completed'].includes(p.status))fail('migration_not_active');if(p.expires_at.getTime()<=Date.now())fail('migration_expired')}
function subject(a:MigrationAction){if(a.type==='resource.scope')return {kind:a.resourceKind,id:a.resourceId};return 'userId' in a?{kind:'member',id:a.userId}:{kind:'assistant',id:a.assistantId}}
async function projection(c:PoolClient,w:string,u:string,a:PrincipalMigrationAction){
  const view=await getWorkspaceAccessDirectoryInTransaction(c,w,u),s=subject(a)
  if(s.kind==='member')return {kind:s.kind,person:view.people.find(p=>p.id===s.id),reach:await resolveOperationCeilingsSystem(s.id,w,'confidential',null,true,(sql,values)=>c.query(sql,values)),resourceAuthorizationRequired:true}
  const principal=await createDbContextScopeStore(c).resolveAssistantPrincipalSystem(s.id,w)
  // getAssistantContextConfig uses queryWithRLS even on a transaction-bound store.
  // Admin authorization was checked above; read the same projection on this session
  // so simulation sees its uncommitted changes and never borrows another client.
  const config=(await c.query<NonNullable<Awaited<ReturnType<ReturnType<typeof createDbContextScopeStore>['getAssistantContextConfig']>>>>(`
    SELECT a.team_scope_mode AS "teamMode",a.default_workspace_group_id AS "defaultGroupId",
      a.project_scope_mode AS "projectMode",a.default_project_id AS "defaultProjectId",
      COALESCE(array_agg(DISTINCT ga.group_id) FILTER (WHERE ga.group_id IS NOT NULL),'{}') AS "teamIds",
      COALESCE(array_agg(DISTINCT apg.project_id) FILTER (WHERE apg.project_id IS NOT NULL),'{}') AS "projectIds"
    FROM assistants a
    LEFT JOIN workspace_group_assistants ga ON ga.assistant_id=a.id
    LEFT JOIN assistant_project_grants apg ON apg.assistant_id=a.id
    WHERE a.id=$1 AND a.workspace_id=$2 GROUP BY a.id`,[s.id,w])).rows[0]??null
  return {kind:s.kind,principal,config,readCompartments:principal?.teamGrant,mutationCompartments:principal?.teamGrant,resourceAuthorizationRequired:true,humanIntersectionRequired:true}
}
async function simulate(c:PoolClient,w:string,u:string,a:PrincipalMigrationAction){
  if(a.type==='member.access.set'){
    const current=(await c.query('SELECT clearance FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[w,a.userId])).rows[0]
    if(!current||a.clearance!==current.clearance)fail('migration_clearance_change_forbidden')
  }
  const before=await projection(c,w,u,a)
  await c.query('SAVEPOINT migration_simulation')
  try{await executeDepartmentAccessInTransaction(c,w,u,a);return {before,after:await projection(c,w,u,a)}}
  finally{await c.query('ROLLBACK TO SAVEPOINT migration_simulation');await c.query('RELEASE SAVEPOINT migration_simulation')}
}
/** Reconcile receipts after a crash/lost response; never re-execute an item here. */
async function reconcile(c:PoolClient,w:string,p:string){
  await c.query(`UPDATE workspace_access_migration_items i SET status=CASE WHEN r.status='complete' THEN 'applied' ELSE r.status END,
    diagnostic_code=CASE WHEN r.status='stale' THEN 'scope_review_changed' ELSE NULL END
    FROM workspace_scope_reviews r WHERE i.workspace_id=$1 AND i.plan_id=$2 AND r.workspace_id=i.workspace_id
    AND r.id=i.scope_review_id AND r.status IN('complete','stale','cancelled') AND i.status<>CASE WHEN r.status='complete' THEN 'applied' ELSE r.status END`,[w,p])
  await c.query(`UPDATE workspace_access_migration_items i SET command_review_id=r.id FROM workspace_access_command_reviews r,workspace_access_migration_plans p WHERE i.workspace_id=$1 AND i.plan_id=$2 AND p.id=i.plan_id AND p.workspace_id=i.workspace_id AND r.workspace_id=i.workspace_id AND r.actor_user_id=p.actor_user_id AND r.idempotency_key=(i.evidence_versions->>'reviewKey')::uuid AND i.command_review_id IS DISTINCT FROM r.id`,[w,p])
  await c.query(`UPDATE workspace_access_migration_items i SET status='applied',diagnostic_code=NULL FROM workspace_access_command_reviews r WHERE i.workspace_id=$1 AND i.plan_id=$2 AND r.workspace_id=i.workspace_id AND r.id=i.command_review_id AND r.status='applied' AND i.status<>'applied'`,[w,p])
  await c.query(`UPDATE workspace_access_migration_plans SET summary_counts=jsonb_build_object('applied',(SELECT count(*) FROM workspace_access_migration_items WHERE plan_id=$2 AND status='applied'),'total',(SELECT count(*) FROM workspace_access_migration_items WHERE plan_id=$2),'blockers',$3::jsonb),status=CASE WHEN status IN ('paused','cancelled') THEN status WHEN NOT EXISTS(SELECT 1 FROM workspace_access_migration_items WHERE plan_id=$2) THEN 'draft' WHEN NOT EXISTS(SELECT 1 FROM workspace_access_migration_items WHERE plan_id=$2 AND status<>'applied') THEN 'blocked' ELSE status END WHERE workspace_id=$1 AND id=$2`,[w,p,JSON.stringify(blockers)])
}
export async function createMigrationPlan(w:string,u:string,input:unknown){
  const parsed=migrationPlanCreateSchema.safeParse(input);if(!parsed.success)throw new WorkspaceAccessError('invalid_command',400)
  const data=parsed.data,intentHash=hashCommandReviewIntent(data)
  return serialized(w,reservedClient=>withCommandReviewTransaction(async c=>{
    const view=await admin(c,w,u)
    const old=(await c.query<Plan>('SELECT * FROM workspace_access_migration_plans WHERE workspace_id=$1 AND actor_user_id=$2 AND idempotency_key=$3',[w,u,data.idempotencyKey])).rows[0]
    if(old){if(old.intended_population.intentHash!==intentHash)fail('access_idempotency_conflict');return old}
    const policy=(await c.query('SELECT access_mode,coalesce(reviewed_inventory_revision,1)::text AS inventory FROM workspace_access_policies WHERE workspace_id=$1',[w])).rows[0]
    const id=randomUUID(),hash=hashCommandReviewIntent({w,u,data,policyRevision:view.policyRevision})
    await c.query(`INSERT INTO workspace_access_migration_plans(id,workspace_id,actor_user_id,source_mode,target_mode,manifest_revision,schema_revision,policy_revision,inventory_revision,intended_population,proposal_hash,idempotency_key,expires_at,status,summary_counts) VALUES($1,$2,$3,$4,$5,'bounded-items-v1','626',$6,$7,$8,$9,$10,now()+interval '24 hours',$12,$11)`,[id,w,u,policy.access_mode,data.targetMode,view.policyRevision,policy.inventory,JSON.stringify({intentHash,inventoryComplete:false}),hash,data.idempotencyKey,JSON.stringify({total:data.items.length,applied:0,blockers}),data.items.length?'proposed':'draft'])
    for(const proposal of data.items){
      const a=proposal.command as MigrationAction,s=subject(a)
      let diff:{before:unknown;after:unknown}
      const unsupported=a.type==='resource.scope'&&!sourceAdapter(a.resourceKind).actions.includes(a.action)
      if(a.type==='resource.scope'){
        await c.query('SAVEPOINT resource_simulation')
        try{
          const review=await previewResource(c,w,u,unsupported?{...a,action:'hold',targetTeamId:undefined}:a,proposal.reason)
          diff=resourceEvidence(review)
          if(unsupported)diff.after={action:a.action,targetTeamId:a.targetTeamId??null,
            blocker:'scope_review_action_unsupported',allowedActions:sourceAdapter(a.resourceKind).actions}
        }
        finally{await c.query('ROLLBACK TO SAVEPOINT resource_simulation');await c.query('RELEASE SAVEPOINT resource_simulation')}
      }else diff=await simulate(c,w,u,a)
      const inserted=await c.query<{id:string}>(`INSERT INTO workspace_access_migration_items(workspace_id,plan_id,subject_kind,subject_id,proposed_action,reason,before_state,after_state,evidence_versions,dependency_versions,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,[w,id,s.kind,s.id,JSON.stringify(a),proposal.reason,JSON.stringify(diff.before),JSON.stringify(diff.after),JSON.stringify({policyRevision:view.policyRevision,reviewKey:randomUUID(),proposalHash:hashCommandReviewIntent({a,diff,policyRevision:view.policyRevision})}),JSON.stringify({inventoryComplete:false,blockers}),randomUUID()])
      if(unsupported)await c.query("UPDATE workspace_access_migration_items SET status='blocked',diagnostic_code='scope_review_action_unsupported' WHERE workspace_id=$1 AND plan_id=$2 AND id=$3",[w,id,inserted.rows[0].id])
    }
    return plan(c,w,id)
  },reservedClient))
}
export async function getMigrationPlan(w:string,u:string,id:string){return serialized(w,reservedClient=>withCommandReviewTransaction(async c=>{await admin(c,w,u);await plan(c,w,id);await reconcile(c,w,id);return {...await plan(c,w,id),items:(await c.query('SELECT * FROM workspace_access_migration_items WHERE workspace_id=$1 AND plan_id=$2 ORDER BY created_at,id',[w,id])).rows,blockers,cancellationNotice:'Applied changes are immediate; pausing or cancellation does not roll them back.'}},reservedClient))}
export async function listMigrationPlans(w:string,u:string,after?:string){if(after&&!z.string().uuid().safeParse(after).success)throw new WorkspaceAccessError('invalid_command',400);return withCommandReviewTransaction(async c=>{await admin(c,w,u,false);return (await c.query('SELECT * FROM workspace_access_migration_plans WHERE workspace_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 50',[w,after??null])).rows})}

/** One item per review. Re-simulate at current policy; never carry blanket approval forward. */
export async function prepareMigrationItem(w:string,u:string,p:string,id:string){return serialized(w,async reservedClient=>{
  const intent=await withCommandReviewTransaction(async c=>{
    const view=await admin(c,w,u),parent=await plan(c,w,p);if(parent.actor_user_id!==u)throw new WorkspaceAccessError('migration_actor_required');active(parent)
    await reconcile(c,w,p);const i=await item(c,w,p,id);if(i.status==='applied')fail('migration_item_applied')
    if(i.proposed_action.type==='resource.scope')return {resource:await prepareResource(c,w,u,p,i)}
    const a=i.proposed_action.type==='member.access.set'?{...i.proposed_action,expectedPolicyRevision:view.policyRevision}:i.proposed_action
    const diff=await simulate(c,w,u,a)
    const saved=(await c.query<{live:boolean}>(`SELECT expires_at>clock_timestamp() AS live FROM workspace_access_command_reviews
      WHERE workspace_id=$1 AND actor_user_id=$2 AND idempotency_key=$3`,[w,u,i.evidence_versions.reviewKey])).rows[0]
    const key=i.evidence_versions.policyRevision===view.policyRevision&&saved?.live!==false?i.evidence_versions.reviewKey:randomUUID()
    await c.query(`UPDATE workspace_access_migration_items SET proposed_action=$4,before_state=$5,after_state=$6,evidence_versions=$7,command_review_id=NULL,status='pending' WHERE workspace_id=$1 AND plan_id=$2 AND id=$3`,[w,p,id,JSON.stringify(a),JSON.stringify(diff.before),JSON.stringify(diff.after),JSON.stringify({policyRevision:view.policyRevision,reviewKey:key,proposalHash:hashCommandReviewIntent({a,diff,policyRevision:view.policyRevision})})])
    const proposals=(await c.query('SELECT id,proposed_action,before_state,after_state,evidence_versions FROM workspace_access_migration_items WHERE workspace_id=$1 AND plan_id=$2 ORDER BY id',[w,p])).rows
    await c.query("UPDATE workspace_access_migration_plans SET proposal_hash=$3,policy_revision=$4,generation=generation+1,status='awaiting_confirmation' WHERE workspace_id=$1 AND id=$2",[w,p,hashCommandReviewIntent(proposals),view.policyRevision])
    return {command:a,expectedPolicyRevision:view.policyRevision,idempotencyKey:key}
  },reservedClient)
  if(intent.resource)return intent.resource
  const review=await prepareDepartmentCommand(w,u,intent,reservedClient)
  return withCommandReviewTransaction(async c=>{await admin(c,w,u);const parent=await plan(c,w,p);if(parent.actor_user_id!==u)throw new WorkspaceAccessError('migration_actor_required');active(parent);await c.query('UPDATE workspace_access_migration_items SET command_review_id=$4 WHERE workspace_id=$1 AND plan_id=$2 AND id=$3',[w,p,id,review.id]);return {review,item:await item(c,w,p,id)}},reservedClient)
})}
export async function applyMigrationItem(w:string,u:string,p:string,id:string,confirmation:MigrationItemApply){
  if(!migrationItemApplySchema.safeParse(confirmation).success)throw new WorkspaceAccessError('invalid_command',400)
  if('kind' in confirmation)return applyResourceItem(w,u,p,id,confirmation)
  return serialized(w,async reservedClient=>{
  const action=await withCommandReviewTransaction(async c=>{
    await admin(c,w,u);const parent=await plan(c,w,p);if(parent.actor_user_id!==u)throw new WorkspaceAccessError('migration_actor_required');await reconcile(c,w,p);const i=await item(c,w,p,id)
    if(i.proposed_action.type==='resource.scope'||i.command_review_id!==confirmation.reviewId)fail('access_review_changed')
    // Receipt retries remain possible after pause/cancel, but cannot perform new writes.
    if(i.status!=='applied')active(parent)
    const r=(await c.query('SELECT actor_user_id,payload_hash FROM workspace_access_command_reviews WHERE workspace_id=$1 AND id=$2',[w,i.command_review_id])).rows[0]
    if(!r||r.actor_user_id!==u||r.payload_hash!==confirmation.payloadHash)fail('access_review_changed')
    return i.proposed_action
  },reservedClient)
  await applyDepartmentCommand(w,u,confirmation,action,reservedClient)
  return withCommandReviewTransaction(async c=>{await admin(c,w,u);await plan(c,w,p);await reconcile(c,w,p);return item(c,w,p,id)},reservedClient)
})}
/** Inspect the exact saved review for native confirmation; never prepares a replacement. */
export async function getMigrationItemReview(w:string,u:string,p:string,id:string,confirmation:MigrationItemApply){
  if(!migrationItemApplySchema.safeParse(confirmation).success)throw new WorkspaceAccessError('invalid_command',400)
  if('kind' in confirmation)return withCommandReviewTransaction(async c=>{
    const {review}=await savedResource(c,w,u,p,id,confirmation)
    return {kind:'resource' as const,review,expiresAt:confirmation.expiresAt,alreadyApplied:review.status==='complete'}
  })
  return withCommandReviewTransaction(async c=>{
    const view=await admin(c,w,u),parent=await plan(c,w,p)
    if(parent.actor_user_id!==u)throw new WorkspaceAccessError('migration_actor_required')
    const i=await item(c,w,p,id)
    if(i.command_review_id!==confirmation.reviewId)fail('access_review_changed')
    const r=(await c.query<{id:string;payload_hash:string;policy_revision:string;command:DepartmentAccessCommand;changes:DepartmentCommandReview['changes'];expires_at:Date;status:string}>(
      'SELECT id,payload_hash,policy_revision::text,command,changes,expires_at,status FROM workspace_access_command_reviews WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3',
      [w,u,confirmation.reviewId])).rows[0]
    if(!r||r.payload_hash!==confirmation.payloadHash)fail('access_review_changed')
    if(r.status==='applied')return {id:r.id,payloadHash:r.payload_hash,policyRevision:view.policyRevision,command:r.command,changes:[],expiresAt:r.expires_at.toISOString(),validForMs:view.validForMs,alreadyApplied:true}
    active(parent)
    const now=(await c.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now
    if(r.expires_at<=now)fail('access_review_expired')
    if(r.policy_revision!==view.policyRevision)fail('access_policy_conflict')
    return {id:r.id,payloadHash:r.payload_hash,policyRevision:r.policy_revision,command:r.command,changes:r.changes,expiresAt:r.expires_at.toISOString(),validForMs:Math.min(view.validForMs,r.expires_at.getTime()-now.getTime())}
  })
}

/** Stop future batches immediately. Immutable review bindings enforce the same
 * lifecycle on direct canonical applies; existing receipts remain replayable. */
export async function setMigrationPlanState(w:string,u:string,p:string,state:'paused'|'cancelled'|'proposed'){
  if(!['paused','cancelled','proposed'].includes(state))throw new WorkspaceAccessError('invalid_command',400)
  return serialized(w,reservedClient=>withCommandReviewTransaction(async c=>{
    await admin(c,w,u);const parent=await plan(c,w,p);await reconcile(c,w,p)
    if(parent.status==='cancelled'||parent.status==='completed')fail('migration_not_active')
    if(state==='proposed')active({...parent,status:'proposed'})
    if(parent.status!==state)await c.query(`UPDATE workspace_access_migration_items
      SET evidence_versions=jsonb_set(evidence_versions,'{reviewKey}',to_jsonb(gen_random_uuid()::text)),
        command_review_id=NULL,scope_review_id=NULL,status=CASE WHEN diagnostic_code='scope_review_action_unsupported' AND $3<>'cancelled' THEN 'blocked' ELSE $3 END WHERE workspace_id=$1 AND plan_id=$2 AND status<>'applied'`,[w,p,state==='cancelled'?'cancelled':'pending'])
    await c.query('UPDATE workspace_access_migration_plans SET status=CASE WHEN $3=\'proposed\' AND NOT EXISTS(SELECT 1 FROM workspace_access_migration_items WHERE plan_id=$2) THEN \'draft\' ELSE $3 END WHERE workspace_id=$1 AND id=$2',[w,p,state])
    return plan(c,w,p)
  },reservedClient))
}


async function previewResource(c:PoolClient,w:string,u:string,a:ResourceMigrationAction,reason:string){
  if(!sourceAdapter(a.resourceKind).actions.includes(a.action))fail('scope_review_action_unsupported')
  const review=await executeWorkspaceScopeReviewInTransaction(c,w,u,{type:'scope.review.preview',resourceKind:a.resourceKind,
    resourceIds:[a.resourceId],action:a.action,targetTeamId:a.targetTeamId??null,reason})
  // A migration cannot certify broadening beyond an inherited provenance floor.
  // The canonical engine still owns the mutation; missing floor-aware canonical
  // consolidation support is an explicit blocker, not an alternate relabel path.
  if(a.action==='consolidate_default'&&(await c.query(`SELECT 1 FROM scope_derivations d
    WHERE d.workspace_id=$1 AND d.resource_kind=$2
      AND d.resource_id IN(SELECT resource_id FROM scope_source_ancestors($1,$2,$3))
      AND NOT d.compartments <@ ARRAY[$4::text] LIMIT 1`,[w,a.resourceKind,a.resourceId,review.targetCompartment])).rows.length)fail('migration_source_floor_review_required')
  return review
}
type ResourceReview=Awaited<ReturnType<typeof previewResource>>
function resourceEvidence(review:ResourceReview){
  const root=review.items[0]
  return {before:{source:root.source,content:root.content},after:{action:review.action,targetTeamId:review.targetTeamId,
    targetCompartment:review.targetCompartment,impact:root.impact,allowedActions:sourceAdapter(review.resourceKind).actions,
    authorizationNotice:'Department scope is not resource authorization. Read and edit differ: collaboration grants are read-only. Private ownership, sensitivity, Projects and assistant ceilings still apply.'}}
}
async function prepareResource(c:PoolClient,w:string,u:string,p:string,i:Item){
  const a=i.proposed_action as ResourceMigrationAction
  const review=await previewResource(c,w,u,a,i.reason),diff=resourceEvidence(review),key=randomUUID()
  const expiry=(await c.query<{expiry:Date}>("SELECT least(clock_timestamp()+interval '15 minutes',expires_at,coalesce($3::timestamptz,expires_at)) AS expiry FROM workspace_access_migration_plans WHERE workspace_id=$1 AND id=$2",[w,p,review.expiresAt??null])).rows[0].expiry
  await c.query(`UPDATE workspace_access_migration_items SET scope_review_id=$4,before_state=$5,after_state=$6,evidence_versions=$7,status='pending',diagnostic_code=NULL WHERE workspace_id=$1 AND plan_id=$2 AND id=$3`,
    [w,p,i.id,review.id,JSON.stringify(diff.before),JSON.stringify(diff.after),JSON.stringify({policyRevision:review.policyRevision,reviewKey:key})])
  await c.query(`INSERT INTO workspace_access_migration_resource_reviews(workspace_id,review_id,item_id,review_key,expected_version,expires_at) VALUES($1,$2,$3,$4,$5,$6)`,[w,review.id,i.id,key,review.version,expiry])
  const proposals=(await c.query('SELECT id,proposed_action,before_state,after_state,evidence_versions FROM workspace_access_migration_items WHERE workspace_id=$1 AND plan_id=$2 ORDER BY id',[w,p])).rows
  await c.query("UPDATE workspace_access_migration_plans SET proposal_hash=$3,policy_revision=$4,generation=generation+1,status='awaiting_confirmation' WHERE workspace_id=$1 AND id=$2",[w,p,hashCommandReviewIntent(proposals),review.policyRevision])
  return {kind:'resource' as const,review,item:await item(c,w,p,i.id),confirmation:{kind:'resource' as const,reviewId:review.id,expectedVersion:review.version,payloadHash:review.payloadHash,expiresAt:expiry.toISOString()}}
}
export type ResourceMigrationConfirmation=Extract<MigrationItemApply,{kind:'resource'}>
type ResourceConfirmation=ResourceMigrationConfirmation
async function savedResource(c:PoolClient,w:string,u:string,p:string,id:string,confirmation:ResourceConfirmation){
  const current=await admin(c,w,u),parent=await plan(c,w,p)
  if(parent.actor_user_id!==u)throw new WorkspaceAccessError('migration_actor_required')
  await reconcile(c,w,p)
  const i=await item(c,w,p,id)
  if(i.proposed_action.type!=='resource.scope'||i.scope_review_id!==confirmation.reviewId)fail('access_review_changed')
  const binding=(await c.query<{expected_version:string;expires_at:Date}>(`SELECT expected_version::text,expires_at FROM workspace_access_migration_resource_reviews WHERE workspace_id=$1 AND item_id=$2 AND review_id=$3`,[w,id,confirmation.reviewId])).rows[0]
  const review=await getWorkspaceScopeReviewInTransaction(c,w,u,confirmation.reviewId)
  if(!binding||binding.expected_version!==confirmation.expectedVersion||binding.expires_at.toISOString()!==confirmation.expiresAt||review.payloadHash!==confirmation.payloadHash)fail('access_review_changed')
  if(review.status!=='complete'){
    active(parent)
    if(binding.expires_at<=(await c.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now)fail('scope_review_expired')
    if(review.version!==confirmation.expectedVersion||review.status!=='preview')fail('scope_review_changed')
    if(current.policyRevision!==review.policyRevision)fail('access_policy_conflict')
  }
  return {review,i}
}
async function applyResourceItem(w:string,u:string,p:string,id:string,confirmation:ResourceConfirmation){
  const result=await serialized(w,reservedClient=>withCommandReviewTransaction(async c=>{
    const saved=await savedResource(c,w,u,p,id,confirmation)
    const review=saved.review.status==='complete'?saved.review:await executeWorkspaceScopeReviewInTransaction(c,w,u,{
      type:'scope.review.apply',reviewId:confirmation.reviewId,expectedVersion:confirmation.expectedVersion,payloadHash:confirmation.payloadHash})
    await reconcile(c,w,p)
    return {...await item(c,w,p,id),kind:'resource' as const,review}
  },reservedClient))
  notifyWorkspaceChange(w,'workspace_config','update')
  return result
}

/** Principal results retain their original shape. Only resource results carry
 * kind:'resource'; callers must send the returned confirmation unchanged rather
 * than deriving expiry from ScopeReview.expiresAt (null for older actions). */
export type MigrationItemReviewResult=Awaited<ReturnType<typeof prepareMigrationItem>>
export type MigrationItemApplyResult=Awaited<ReturnType<typeof applyMigrationItem>>
