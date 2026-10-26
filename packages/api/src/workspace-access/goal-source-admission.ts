import { assertSourceModelInputAuthority,assertSourceModelOutputAuthority } from '../application-platform/model-source-authority.js'
import { assertCurrentAuthority,runWithAuthorityLease,executeWithCurrentAuthority,createAuthorityLease } from '../context-scope/authority-lease.js'
import { crmOperationsSha256 } from '@use-brian/core'
import { isDeepStrictEqual } from 'node:util'
import type { PoolClient } from 'pg'
import { bindScopeSources, ContextScopeAccumulator, AuthoritySourceSchema, createExecutionContext, executionToolContext, boundScopeSources, intersectAccessCeilings, type AuthoritySource, type ScopeSource, type ScopeEvidence, type SessionContextAuthority, type GoalRecord } from '@use-brian/core'
import { readRetainedContextFrame, writeRetainedContextFrame,writeRetainedGoalWorkflowContextFrame } from '../db/session-context-revisions.js'
import { readLegacyCanonicalCrmPoint } from '../db/crm-reader.js'
import { resolveBrowserTaskExecutionAuthority } from '../sandbox/task-execution-authority.js'
import { readExternalSourceAncestors } from '../application-platform/external-source-ancestry.js'
import { readApplicationFieldAncestors } from '../application-platform/field-evidence.js'
import { accessCeilingContains, pinAccessCeiling, pinAuthoringAuthority, parseAuthoringAuthority, type AuthoringAuthority, type GoalCreateParams } from '@use-brian/core'
import { getPool } from '../db/client.js'
import {taskNeedsIndependentSourceAuthoritySql} from '../db/task-reader.js'
import { currentAgentAccess, runWithAgentAccess } from '../db/agent-access-context.js'
import { buildAccessPredicate, buildCurrentMemberSourcePredicate, mutationActorAccess } from '../db/access-predicate.js'
import { resolveWorkflowAuthoringScope } from '../context-scope/workflow-authority.js'
import { lockOperationalPolicy } from './operational-admission.js'
import { WorkspaceAccessError } from './policy.js'

// Server capabilities, never serialized/model JSON. A retry must capture a new
// canonical source and rerun its producer; durable consent is never renewed.
type Proof = {
  userId: string; workspaceId: string; assistantId: string; taskId: string
  snapshot: string; contextGroupId: string | null; contextProjectId: string | null
  authority: AuthoringAuthority
  retained?: { sources: ScopeSource[]; sourceAuthority: Extract<AuthoritySource,{kind: 'session'}>; version: string; assistantKind: 'primary'|'standard'|'app' }
}
const proofs = new WeakMap<object, Proof>()
const retainedAuthorities = new WeakMap<object, SessionContextAuthority>()
const denied = () => new WorkspaceAccessError('goal_source_unsupported', 409)

function runtime(userId: string, workspaceId: string) {
  const access = currentAgentAccess()
  if (!access || access.userId !== userId || access.workspaceId !== workspaceId
    || access.sharedAudience || !Array.isArray(access.compartments)
    || !Array.isArray(access.mutationCompartments) || !Array.isArray(access.projectIds)
    || !Array.isArray(access.visibilityAssistantIds)) throw denied()
  mutationActorAccess(userId, workspaceId)
  return access
}

/** Metadata-only hold for Goal consumers that cannot carry retained Task source authority. */
export async function assertTaskGoalSourceCompatible(workspaceId:string,taskId:string,client?:Pick<PoolClient,'query'>):Promise<void>{
 const row=(await (client??getPool()).query<{retained:boolean}>(`SELECT EXISTS(SELECT 1 FROM tasks t
  WHERE t.workspace_id=$1 AND t.id=$2 AND (${taskNeedsIndependentSourceAuthoritySql('t')}
   OR EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=t.workspace_id AND d.resource_kind='task'
    AND d.resource_id IN(t.id,t.logical_id)))) AS retained`,[workspaceId,taskId])).rows[0]
 if(row?.retained!==false)throw denied()
}

/** Classification only: no payload or reusable authority. The canonical writer
 * locks both physical roots before calling this owner metadata read. */
export async function unboundNativeTaskGoalHost(goal:GoalRecord):Promise<{id:string;logicalId:string}|undefined>{
 if(goal.host?.type!=='task'||!goal.createdByUserId||!goal.authoringAuthority)return undefined
 return(await getPool().query<{id:string;logicalId:string}>(`SELECT live.id,live.logical_id AS "logicalId"
  FROM goals g JOIN tasks original ON original.id=$3 AND original.workspace_id=g.workspace_id
  JOIN tasks live ON live.id=g.host_id AND live.workspace_id=g.workspace_id AND live.logical_id=original.logical_id
  WHERE g.id=$1 AND g.workspace_id=$2 AND g.host_type='task' AND g.created_by_user_id=$4
   AND g.authoring_authority=$5::jsonb AND g.context_group_id IS NOT DISTINCT FROM $6::uuid
   AND g.context_project_id IS NOT DISTINCT FROM $7::uuid AND live.valid_to IS NULL AND live.retracted_at IS NULL
   AND NOT original.scope_held AND NOT live.scope_held AND original.retracted_at IS NULL
   AND NOT EXISTS(SELECT 1 FROM goal_task_source_authority proof WHERE proof.goal_id=g.id)
   AND NOT EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=g.workspace_id AND d.resource_kind='task'
    AND d.resource_id IN(original.id,original.logical_id,live.id))
   AND NOT (${taskNeedsIndependentSourceAuthoritySql('original')})
   AND NOT (${taskNeedsIndependentSourceAuthoritySql('live')})`,
 [goal.id,goal.workspaceId,goal.host.id,goal.createdByUserId,JSON.stringify(goal.authoringAuthority),goal.contextGroupId,goal.contextProjectId])).rows[0]
}

async function source(client: PoolClient, p: Pick<Proof, 'userId' | 'workspaceId' | 'assistantId' | 'taskId'>) {
  await assertTaskGoalSourceCompatible(p.workspaceId,p.taskId,client)
  const ambient = runtime(p.userId, p.workspaceId)
  if (!ambient.visibilityAssistantIds!.includes(p.assistantId)) throw denied()
  const access = { ...ambient, userId: p.userId, workspaceId: p.workspaceId,
    assistantId: p.assistantId, assistantKind: 'standard' as const }
  const read = buildAccessPredicate(access, { alias: 't', startIdx: 3 })
  const write = buildAccessPredicate(access, { alias: 't', startIdx: read.nextIdx, operation: 'mutation' })
  const member = buildCurrentMemberSourcePredicate(p.userId, { alias: 't', startIdx: write.nextIdx, operation: 'mutation' })
  const row = (await client.query<{ snapshot: string; compartments: string[]; projectIds: string[]; sensitivity: 'public' | 'internal' | 'confidential' }>(`
    SELECT to_jsonb(t)::text AS snapshot,t.compartments,t.project_ids AS "projectIds",t.sensitivity
    FROM tasks t WHERE t.id=$1 AND t.workspace_id=$2 AND t.valid_to IS NULL
      AND t.retracted_at IS NULL AND NOT t.scope_held AND t.parent_id IS NULL
      AND t.user_id IS NULL AND t.assistant_id IS NULL
      AND ${read.sql} AND ${write.sql} AND ${member.sql} FOR SHARE OF t`,
  [p.taskId, p.workspaceId, ...read.params, ...write.params, ...member.params])).rows[0]
  // Operational goals cannot yet retain a private/assistant partition, nor
  // multiple department/project bindings. Reject rather than broaden them.
  if (!row || row.compartments.length > 1 || row.projectIds.length > 1) throw denied()
  let contextGroupId: string | null = null
  if (row.compartments.length) {
    const group = (await client.query(`SELECT id FROM workspace_groups WHERE workspace_id=$1
      AND compartment_key=$2 AND kind='team' AND status='active' FOR SHARE`, [p.workspaceId, row.compartments[0]])).rows[0]
    if (!group) throw denied()
    contextGroupId = group.id
  }
  return { ...row, contextGroupId, contextProjectId: row.projectIds[0] ?? null }
}

/** Call BEFORE the judge, inside the actual task writer's runtime context.
 * No pool checkout is retained while running the producer. */
export async function captureTaskGoalSource(input: { userId: string; workspaceId: string; assistantId: string; taskId: string; authority?: SessionContextAuthority }): Promise<object> {
  if (input.authority) return captureRetainedTaskGoalSource(input, input.authority)
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const policy = await lockOperationalPolicy(client, input.workspaceId)
    if (policy?.setupState !== 'ready') throw denied()
    const row = await source(client, input)
    const existing = (await client.query<{ proof: Proof }>('SELECT proof FROM goal_task_source_authority WHERE task_id=$1 FOR UPDATE', [input.taskId])).rows[0]?.proof
    const ambient = runtime(input.userId, input.workspaceId)
    // Pin only the canonical source requirements from the actual finite runtime.
    // This is producer inheritance, NOT attended authoring/default capture.
    const authority: AuthoringAuthority = existing?.authority ?? pinAuthoringAuthority({ ...ambient,
      workspaceId: input.workspaceId, userId: input.userId, assistantId: input.assistantId, assistantKind: 'standard', clearance: row.sensitivity,
      compartments: row.compartments, mutationCompartments: row.compartments,
      projectIds: row.projectIds, visibilityAssistantIds: [input.assistantId] })
    const proof: Proof = { ...input, snapshot: row.snapshot, contextGroupId: row.contextGroupId,
      contextProjectId: row.contextProjectId, authority }
    if (existing && (existing.userId !== input.userId || existing.assistantId !== input.assistantId
      || existing.workspaceId !== input.workspaceId || existing.snapshot !== row.snapshot
      || existing.contextGroupId !== row.contextGroupId || existing.contextProjectId !== row.contextProjectId)) throw denied()
    if (!parseAuthoringAuthority(authority) || !accessCeilingContains(pinAccessCeiling({ ...ambient,
      userId: input.userId, workspaceId: input.workspaceId, assistantId: input.assistantId, assistantKind: 'standard' }), authority.ceiling)) throw denied()
    const scope = await resolveWorkflowAuthoringScope({ ...proof, authoringAuthority: authority }, client)
    if (!accessCeilingContains(pinAccessCeiling(scope.access), authority.ceiling)) throw denied()
    if (!existing) await client.query('INSERT INTO goal_task_source_authority(task_id,workspace_id,proof) VALUES($1,$2,$3::jsonb)', [input.taskId,input.workspaceId,JSON.stringify(proof)])
    const token = Object.freeze({})
    proofs.set(token, proof)
    await client.query('COMMIT')
    return token
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

/** Caller holds the policy barrier until the goal INSERT commits. */
export async function admitGoalSource(client: PoolClient, params: GoalCreateParams, token: object) {
  const proof = proofs.get(token)
  if (!proof) throw denied()
  const retained = retainedAuthorities.get(token)
  if (retained) return admitRetainedGoalSource(client, params, token, proof, retained)
  proofs.delete(token) // one attempt, including rollback/retry
  const policy = await lockOperationalPolicy(client, params.workspaceId)
  if (policy?.setupState !== 'ready' || proof.workspaceId !== params.workspaceId
    || proof.userId !== params.createdByUserId || params.host?.type !== 'task'
    || params.host.id !== proof.taskId || params.parentGoalId || params.recipeId
    || params.originSessionId || params.confirmed !== false || params.authoringAuthority != null
    || (params.contextGroupId !== undefined && params.contextGroupId !== proof.contextGroupId)
    || (params.contextProjectId !== undefined && params.contextProjectId !== proof.contextProjectId)) throw denied()
  if ((await client.query("SELECT id FROM goals WHERE workspace_id=$1 AND host_type='task' AND host_id=$2 LIMIT 1", [proof.workspaceId, proof.taskId])).rows.length) throw denied()
  const row = await source(client, proof)
  if (row.snapshot !== proof.snapshot || row.contextGroupId !== proof.contextGroupId
    || row.contextProjectId !== proof.contextProjectId) throw denied()
  const scope = await resolveWorkflowAuthoringScope({ ...proof, authoringAuthority: proof.authority }, client)
  if (!accessCeilingContains(pinAccessCeiling(scope.access), proof.authority.ceiling)) throw denied()
  return { ...params, contextGroupId: proof.contextGroupId, contextProjectId: proof.contextProjectId,
    authoringAuthority: proof.authority }
}

/** Only server producers can dereference a capability. Never expose to tools. */
export function taskGoalProducerInput(token: object): { title: string; attributes: Record<string, unknown> } {
  const proof = proofs.get(token)
  if (!proof) throw denied()
  const row = JSON.parse(proof.snapshot)
  return { title: row.title, attributes: row.attributes }
}

export async function bindTaskGoalSource(client: PoolClient, taskId: string, goalId: string) {
  const role=(await client.query<{owner:boolean}>("SELECT pg_has_role(current_user,c.relowner,'USAGE') AS owner FROM pg_class c WHERE c.oid='goals'::regclass")).rows[0]
  if(role?.owner===false){await client.query('SELECT bind_retained_task_goal_source($1,$2)',[taskId,goalId]);return}
  const result = await client.query('UPDATE goal_task_source_authority SET goal_id=$2 WHERE task_id=$1 AND goal_id IS NULL RETURNING task_id', [taskId,goalId])
  if (result.rowCount !== 1) throw denied()
}

export function executeTaskGoalProducer<T>(token: object, producer: (task: ReturnType<typeof taskGoalProducerInput>) => Promise<T>): Promise<T> {
  const proof = proofs.get(token)
  if (!proof) throw denied()
  const retained=retainedAuthorities.get(token)
  if(retained)return (async()=>{
    await assertRetainedTaskGoalCurrent(proof,retained)
    const context={...executionToolContext(retained.execution,{appId:'native'}),scopeAccumulator:new ContextScopeAccumulator({sources:proof.retained!.sources})}
    await assertSourceModelInputAuthority(context)
    const result=await runWithAgentAccess(proof.authority.ceiling,()=>producer(taskGoalProducerInput(token)))
    await assertSourceModelInputAuthority(context)
    await assertRetainedTaskGoalCurrent(proof,retained)
    return result
  })()
  runtime(proof.userId, proof.workspaceId)
  return runWithAgentAccess(proof.authority.ceiling, () => producer(taskGoalProducerInput(token)))
}

/** This port carries the original live objects, never model/source JSON. */
export function retainedTaskGoalWrite<T extends object>(token: object, write: (client: PoolClient) => Promise<T>): Promise<T> | undefined {
  const proof=proofs.get(token),authority=retainedAuthorities.get(token)
  if(!authority||!proof?.retained)return undefined
  return writeRetainedContextFrame(authority,proof.retained.sources,async client=>{
    await client.query("SELECT set_config('app.retained_task_goal',$1,true)",[proof.taskId])
    return bindScopeSources(await write(client),proof.retained!.sources)
  })
}

async function retainedTask(client:PoolClient,input:Pick<Proof,'userId'|'workspaceId'|'assistantId'|'taskId'>,authority:SessionContextAuthority) {
  const access=authority.execution.security.access
  const metadata=(await client.query<{version:string;compartments:string[];projectIds:string[];sensitivity:'public'|'internal'|'confidential'}>(`SELECT scope_version::text AS version,compartments,project_ids AS "projectIds",sensitivity
    FROM tasks WHERE id=$1 AND workspace_id=$2 AND parent_id IS NULL AND valid_to IS NULL AND retracted_at IS NULL
      AND NOT scope_held AND user_id IS NULL AND assistant_id IS NULL FOR SHARE`,[input.taskId,input.workspaceId])).rows[0]
  if(!metadata||metadata.compartments.length>1||metadata.projectIds.length>1)throw denied()
  const captured=await readLegacyCanonicalCrmPoint(access,'task',input.taskId,['title','attributes'],client)
  if(!captured||captured.projection.ref.version!==metadata.version)throw denied()
  const values=captured.projection.values
  if(typeof values.title!=='string'||!values.attributes||typeof values.attributes!=='object'||Array.isArray(values.attributes))throw denied()
  const group=metadata.compartments.length?(await client.query<{id:string}>("SELECT id FROM workspace_groups WHERE workspace_id=$1 AND compartment_key=$2 AND kind='team' AND status='active'",[input.workspaceId,metadata.compartments[0]])).rows[0]:undefined
  if(metadata.compartments.length&&!group)throw denied()
  const taskSource:ScopeSource={resourceKind:'task',resourceId:input.taskId,version:metadata.version,workspaceId:input.workspaceId,userId:null,assistantId:null,sensitivity:metadata.sensitivity,compartments:metadata.compartments,projectIds:metadata.projectIds}
  return {...metadata,snapshot:JSON.stringify({title:values.title,attributes:values.attributes}),contextGroupId:group?.id??null,contextProjectId:metadata.projectIds[0]??null,sources:[taskSource,...captured.sources]}
}

async function captureRetainedTaskGoalSource(input:Pick<Proof,'userId'|'workspaceId'|'assistantId'|'taskId'>,authority:SessionContextAuthority):Promise<object>{
  const execution=authority.execution,origin=AuthoritySourceSchema.safeParse(execution.security.authority.snapshotSource?.())
  if(!(authority.accumulator instanceof ContextScopeAccumulator)||execution.identity.kind!=='attended'||execution.identity.principal.kind!=='workspace_member'
    ||execution.identity.principal.userId!==input.userId||execution.security.access.userId!==input.userId||execution.security.access.workspaceId!==input.workspaceId||execution.assistant.id!==input.assistantId
    ||!origin.success||origin.data.kind!=='session'||origin.data.authorityUserId!==input.userId||origin.data.executingAssistantId!==input.assistantId
    ||origin.data.workspaceId!==input.workspaceId||origin.data.ignoreSessionBinding||origin.data.systemRead||execution.surface.readOnly)throw denied()
  const root=(await getPool().query<{source:ScopeSource&{held:boolean}}>("SELECT read_scope_source($1,'task',$2) AS source",[input.workspaceId,input.taskId])).rows[0]?.source
  if(!root||root.held!==false)throw denied()
  const roots=new ContextScopeAccumulator(execution.security.provenance);roots.note(authority.accumulator.evidence);roots.note({sources:[root]})
  const row=await readRetainedContextFrame(authority,roots.evidence.sources??[],client=>retainedTask(client,input,authority))
  roots.note({sources:row.sources});roots.note({sources:[...await readExternalSourceAncestors(input.workspaceId,roots.evidence.sources??[]),...await readApplicationFieldAncestors(input.workspaceId,roots.evidence.sources??[])]})
  const proof:Proof={userId:input.userId,workspaceId:input.workspaceId,assistantId:input.assistantId,taskId:input.taskId,
    snapshot:row.snapshot,contextGroupId:row.contextGroupId,contextProjectId:row.contextProjectId,authority:pinAuthoringAuthority({...execution.security.access,clearance:row.sensitivity,compartments:row.compartments,mutationCompartments:row.compartments,projectIds:row.projectIds,visibilityAssistantIds:[input.assistantId]}),
    retained:{sources:roots.evidence.sources??[],sourceAuthority:origin.data,version:row.version,assistantKind:execution.assistant.kind}}
  await assertRetainedTaskGoalCurrent(proof,authority)
  const existing=(await getPool().query<{proof:Proof}>('SELECT proof FROM goal_task_source_authority WHERE task_id=$1',[input.taskId])).rows[0]?.proof
  if(existing&&!isDeepStrictEqual(existing,proof))throw denied()
  if(!existing)await getPool().query('INSERT INTO goal_task_source_authority(task_id,workspace_id,proof) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING',[input.taskId,input.workspaceId,JSON.stringify(proof)])
  const saved=(await getPool().query<{proof:Proof}>('SELECT proof FROM goal_task_source_authority WHERE task_id=$1',[input.taskId])).rows[0]?.proof
  if(!saved||!isDeepStrictEqual(saved,proof))throw denied()
  const token=Object.freeze({});proofs.set(token,proof);retainedAuthorities.set(token,authority);return token
}

async function assertRetainedTaskGoalCurrent(proof:Proof,authority:SessionContextAuthority){
  if(!proof.retained)throw denied()
  return readRetainedContextFrame(authority,proof.retained.sources,async client=>{
    const row=await retainedTask(client,proof,authority)
    if(row.snapshot!==proof.snapshot||row.version!==proof.retained!.version||row.contextGroupId!==proof.contextGroupId||row.contextProjectId!==proof.contextProjectId)throw denied()
  })
}
async function admitRetainedGoalSource(client:PoolClient,params:GoalCreateParams,token:object,proof:Proof,authority:SessionContextAuthority){
  proofs.delete(token);retainedAuthorities.delete(token)
  const policy=await lockOperationalPolicy(client,params.workspaceId)
  if(policy?.setupState!=='ready'||params.workspaceId!==proof.workspaceId||params.createdByUserId!==proof.userId
    ||params.host?.type!=='task'||params.host.id!==proof.taskId||params.confirmed!==false||params.parentGoalId||params.recipeId||params.originSessionId||params.authoringAuthority
    ||params.contextGroupId!==undefined&&params.contextGroupId!==proof.contextGroupId||params.contextProjectId!==undefined&&params.contextProjectId!==proof.contextProjectId)throw denied()
  const row=await retainedTask(client,proof,authority)
  if(row.snapshot!==proof.snapshot||row.version!==proof.retained!.version)throw denied()
  return {...params,contextGroupId:proof.contextGroupId,contextProjectId:proof.contextProjectId,authoringAuthority:proof.authority}
}

/** Restore an authentic original session; a saved ceiling never creates its own origin. */
export async function resolveRetainedTaskGoalAuthority(goal:Pick<GoalRecord,'id'|'workspaceId'|'createdByUserId'|'host'|'authoringAuthority'>){
  const proof=(await getPool().query<{proof:Proof}>('SELECT proof FROM goal_task_source_authority WHERE goal_id=$1',[goal.id])).rows[0]?.proof
  if(!proof?.retained)return undefined
  if(goal.workspaceId!==proof.workspaceId||goal.createdByUserId!==proof.userId||goal.host?.type!=='task'||goal.host.id!==proof.taskId
    ||!isDeepStrictEqual(goal.authoringAuthority,proof.authority))throw denied()
  const lease=await resolveBrowserTaskExecutionAuthority({userId:proof.userId,workspaceId:proof.workspaceId,executionAuthority:proof.authority,sourceAuthority:proof.retained.sourceAuthority})
  const execution=createExecutionContext({identity:{kind:'attended',principal:{kind:'workspace_member',userId:proof.userId,authenticationKind:'native_session'}},ownership:{kind:'workspace',workspaceId:proof.workspaceId},
    access:{...proof.authority.ceiling,assistantId:proof.assistantId,assistantKind:proof.retained.assistantKind},authority:lease,
    provenance:{sources:proof.retained.sources},writeDefaults:{compartments:[],projectIds:[]},
    lifecycle:{sessionId:proof.retained.sourceAuthority.id,channelType:'goal',channelId:goal.id,abortSignal:new AbortController().signal,sessionPersisted:true}})
  const authority={execution,accumulator:new ContextScopeAccumulator({sources:proof.retained.sources})}
  await assertRetainedTaskGoalCurrent(proof,authority)
  return {authority,assertCurrent:()=>assertRetainedTaskGoalCurrent(proof,authority)}
}

/** Source-aware read under the current original invocation; no creator substitution. */
export async function readRetainedTaskGoal<T extends object|null>(goalId:string,authority:SessionContextAuthority,read:(client:PoolClient)=>Promise<T>):Promise<T>{
  const saved=(await getPool().query<{proof:Proof}>('SELECT proof FROM goal_task_source_authority WHERE goal_id=$1',[goalId])).rows[0]?.proof
  if(!saved?.retained||authority.execution.security.access.userId!==saved.userId||authority.execution.assistant.id!==saved.assistantId
    ||authority.execution.security.access.workspaceId!==saved.workspaceId)throw denied()
  return readRetainedContextFrame(authority,saved.retained.sources,async client=>{
    await client.query("SELECT set_config('app.retained_task_goal',$1,true)",[saved.taskId])
    const value=await read(client)
    return value?bindScopeSources(value,saved.retained!.sources):value
  })
}

/** Metadata only: a current caller may select this assistant only after actor matching. */
export async function retainedTaskGoalCaller(userId:string,goalId:string){
 const saved=(await getPool().query<{proof:Proof}>('SELECT proof FROM goal_task_source_authority WHERE goal_id=$1',[goalId])).rows[0]?.proof
 if(!saved?.retained||saved.userId!==userId)return undefined
 return{workspaceId:saved.workspaceId,assistantId:saved.assistantId,maximumAccess:saved.authority.ceiling}
}

/** Same immutable origin and current caller obligations as read, with exact host mutation authority. */
export async function writeRetainedTaskGoal<T extends object|null>(goalId:string,authority:SessionContextAuthority,write:(client:PoolClient)=>Promise<T>):Promise<T>{
 const saved=(await getPool().query<{proof:Proof}>('SELECT proof FROM goal_task_source_authority WHERE goal_id=$1',[goalId])).rows[0]?.proof
 const {execution}=authority
 if(!saved?.retained||execution.identity.kind!=='attended'||execution.identity.principal.kind!=='workspace_member'
  ||execution.identity.principal.userId!==saved.userId||execution.security.access.userId!==saved.userId
  ||execution.assistant.id!==saved.assistantId||execution.security.access.workspaceId!==saved.workspaceId)throw denied()
 return writeRetainedContextFrame(authority,saved.retained.sources,async client=>{
  await client.query("SELECT set_config('app.retained_task_goal',$1,true)",[saved.taskId])
  const access={...execution.security.access,...intersectAccessCeilings(execution.security.ceiling,saved.authority.ceiling)}
  const writeAccess=buildAccessPredicate(access,{alias:'t',startIdx:3,operation:'mutation'})
  const member=buildCurrentMemberSourcePredicate(saved.userId,{alias:'t',startIdx:writeAccess.nextIdx,operation:'mutation'})
  const current=await client.query(`SELECT t.id FROM tasks t WHERE t.id=$1 AND t.workspace_id=$2
   AND ${writeAccess.sql} AND ${member.sql} FOR SHARE OF t`,[saved.taskId,saved.workspaceId,...writeAccess.params,...member.params])
  if(current.rows.length!==1)throw denied()
  const result=await write(client)
  return result?bindScopeSources(result,saved.retained!.sources):result
 })
}

/** The same complete saved roots accompany model review and recipient response. */
export async function admitRetainedGoalBoundary(authority:SessionContextAuthority,value:GoalRecord,action:'context'|'deliver'){
 const original=await resolveRetainedTaskGoalAuthority(value)
 if(!original)throw denied()
 authority.accumulator.note({sources:boundScopeSources(value)})
 const context={...executionToolContext(authority.execution,{appId:'native-goal-review'}),scopeAccumulator:authority.accumulator}
 await(action==='context'?assertSourceModelInputAuthority(context):assertSourceModelOutputAuthority(context))
 await original.assertCurrent()
 await authority.execution.security.authority.assertCurrent()
}

/** Existing Task panel lookup: candidate identity is server-only until current read admission. */
export async function retainedTaskGoalForHost(userId:string,workspaceId:string,taskId:string){
 return(await getPool().query<{goalId:string}>(`SELECT goal_id AS "goalId" FROM goal_task_source_authority
  WHERE workspace_id=$1 AND task_id=$2 AND proof->>'userId'=$3 AND proof->'retained' IS NOT NULL AND goal_id IS NOT NULL`,[workspaceId,taskId,userId])).rows[0]?.goalId
}

/** Native-only retained Goal run adapter. The original sign-in is a parent,
 * never the workflow's executing identity. Canonical source rights stay in8099. */
type RetainedGoalRunMetadata={id:string;workspaceId:string;goalId:string;taskId:string;actor:string;assistantId:string;
 contextGroupId:string|null;contextProjectId:string|null;authoringAuthority:AuthoringAuthority;
 workflowAuthority:AuthoringAuthority;sources:ScopeSource[];stored:Record<string,unknown>;current:boolean;protected:boolean;varsEvidence:ScopeEvidence|null;varsEmpty:boolean;claimedAt:string|null;claimAttempts:number}
async function retainedGoalRunMetadata(runId:string):Promise<RetainedGoalRunMetadata|undefined>{
 const row=(await getPool().query<RetainedGoalRunMetadata>(`SELECT r.id,r.workspace_id AS "workspaceId",r.source_goal_id AS "goalId",
  g.host_id AS "taskId",g.created_by_user_id AS actor,s.proof->>'assistantId' AS "assistantId",
  g.context_group_id AS "contextGroupId",g.context_project_id AS "contextProjectId",g.authoring_authority AS "authoringAuthority",
  w.authoring_authority AS "workflowAuthority",
  (r.execution_authority ? 'retainedGoal' OR s.proof->'retained' IS NOT NULL
   OR r.source_goal_id IS NOT NULL AND g.id IS NULL
   OR EXISTS(SELECT 1 FROM tasks t WHERE g.host_type='task' AND t.id=g.host_id AND t.workspace_id=g.workspace_id
    AND (${taskNeedsIndependentSourceAuthoritySql('t')} OR EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=t.workspace_id AND d.resource_kind='task' AND d.resource_id IN(t.id,t.logical_id))))) AS protected,
  s.proof->'retained'->'sources' AS sources,r.execution_authority AS stored,r.claimed_at::text AS "claimedAt",r.claim_attempts AS "claimAttempts",r.vars->'__contextScopeEvidence' AS "varsEvidence",r.vars='{}'::jsonb AS "varsEmpty",
  (g.updated_at::text=r.execution_authority#>>'{retainedGoal,goalUpdatedAt}'
   AND encode(sha256(convert_to(jsonb_build_object('definition',w.definition,'authority',w.authoring_authority,
     'actor',w.created_by,'group',w.context_group_id,'project',w.context_project_id,'enabled',w.enabled)::text,'UTF8')),'hex')=r.execution_authority#>>'{retainedGoal,workflowFingerprint}'
   AND encode(sha256(convert_to(r.input::text,'UTF8')),'hex')=r.execution_authority#>>'{retainedGoal,inputFingerprint}'
   AND NOT(r.status='failed' AND coalesce(r.error->>'reason','')='workflow_cancelled') AND w.enabled) AS current
 FROM workflow_runs r LEFT JOIN goals g ON g.id=r.source_goal_id AND g.workspace_id=r.workspace_id
 LEFT JOIN goal_task_source_authority s ON s.goal_id=g.id
 LEFT JOIN workflows w ON w.id=r.workflow_id AND w.workspace_id=r.workspace_id WHERE r.id=$1`,[runId])).rows[0]
 if(!row?.protected)return undefined
 if(!row.goalId||!row.taskId||!row.actor||!row.assistantId||!Array.isArray(row.sources))throw denied()
 if(!row.varsEmpty&&!row.varsEvidence||row.varsEvidence&&!isDeepStrictEqual(new ContextScopeAccumulator(row.varsEvidence).evidence,new ContextScopeAccumulator({sources:row.sources}).evidence))throw denied()
 return row
}
export async function resolveRetainedGoalWorkflowRuntime(runId:string){
 const saved=await retainedGoalRunMetadata(runId)
 if(!saved)return undefined
 const frozen=saved.stored,token=frozen?.retainedGoal as Record<string,unknown>|undefined
 if(!saved.current||!token||Object.keys(token).sort().join(',')!=='goalUpdatedAt,inputFingerprint,workflowFingerprint'
  ||Object.values(token).some(value=>typeof value!=='string'||!value.length)
  ||Object.keys(frozen).sort().join(',')!=='assistantId,ceiling,retainedGoal,sourceGoal,version,workflowAuthoringAuthority'
  ||frozen.version!==1||frozen.assistantId!==saved.assistantId||!isDeepStrictEqual(frozen.ceiling,saved.authoringAuthority.ceiling)
  ||!isDeepStrictEqual(frozen.workflowAuthoringAuthority,saved.workflowAuthority)
  ||!isDeepStrictEqual(frozen.sourceGoal,{id:saved.goalId,contextGroupId:saved.contextGroupId,contextProjectId:saved.contextProjectId,authoringAuthority:saved.authoringAuthority})
  ||saved.sources.some(source=>source.resourceKind==='external_source')
  ||(await readExternalSourceAncestors(saved.workspaceId,saved.sources)).length)throw denied()
 const original=await resolveRetainedTaskGoalAuthority({id:saved.goalId,workspaceId:saved.workspaceId,
  createdByUserId:saved.actor,host:{type:'task',id:saved.taskId},authoringAuthority:saved.authoringAuthority})
 if(!original)throw denied()
 const ceiling=saved.authoringAuthority.ceiling
 const currentCeiling=async()=>{
  // This parent lease uses only the owner metadata/auth pool, never the app
  // frame whose source locks and mutation are currently in progress.
  await original.authority.execution.security.authority.assertCurrent()
  const current=await retainedGoalRunMetadata(runId)
  if(!current?.current||!isDeepStrictEqual(current.stored,frozen))return null
  if((await getPool().query("SELECT id FROM assistants WHERE id=$1 AND workspace_id=$2 AND kind='primary'",[saved.assistantId,saved.workspaceId])).rows.length!==1)return null
  const scope=await resolveWorkflowAuthoringScope({userId:saved.actor,workspaceId:saved.workspaceId,assistantId:saved.assistantId,
   authoringAuthority:saved.workflowAuthority,contextGroupId:saved.contextGroupId,contextProjectId:saved.contextProjectId})
  return intersectAccessCeilings(pinAccessCeiling(scope.access),ceiling)
 }
 const lease=createAuthorityLease(ceiling,currentCeiling),evidence=new ContextScopeAccumulator({sources:saved.sources}).evidence
 const source=AuthoritySourceSchema.parse({version:1,kind:'workflow',invocationId:lease.snapshotSource!().invocationId,
  runId,workspaceId:saved.workspaceId,authorityUserId:saved.actor,executingAssistantId:saved.assistantId,
  contextGroupId:saved.contextGroupId,contextProjectId:saved.contextProjectId,authorityFingerprint:crmOperationsSha256(frozen),
  inputFingerprint:crmOperationsSha256(evidence),persistedFingerprint:crmOperationsSha256(evidence)})
 lease.snapshotSource=()=>structuredClone(source)
 const execution=createExecutionContext({identity:{kind:'system',purpose:'workflow',jobId:runId},ownership:{kind:'workspace',workspaceId:saved.workspaceId},
  access:{...original.authority.execution.security.access,...ceiling,assistantId:saved.assistantId,assistantKind:original.authority.execution.assistant.kind},authority:lease,
  provenance:evidence,writeDefaults:{compartments:saved.contextGroupId?ceiling.mutationCompartments??[]:[],projectIds:saved.contextProjectId?[saved.contextProjectId]:[]},
  lifecycle:{sessionId:runId,channelType:'workflow',channelId:runId,abortSignal:new AbortController().signal,sessionPersisted:false},attribution:{billingUserId:saved.actor}})
 const authority={execution,accumulator:new ContextScopeAccumulator(evidence)}
 const frame=async<T>(retaining:boolean,operation:(client:PoolClient)=>Promise<T>)=>{
  const transact=retaining?writeRetainedGoalWorkflowContextFrame:readRetainedContextFrame
  return transact(authority,saved.sources,async client=>{
   await client.query("SELECT set_config('app.retained_task_goal',$1,true),set_config('app.v2_assistant_id',$2,true)",[saved.taskId,saved.assistantId])
   const check=async()=>{if((await client.query<{allowed:boolean}>('SELECT retained_goal_workflow_current($1,$2) AS allowed',[runId,retaining])).rows[0]?.allowed!==true)throw denied()}
   await check();await assertCurrentAuthority();const result=await operation(client);await check();await assertCurrentAuthority();return result
  })
 }
 await frame(false,async()=>undefined)
 retainedWorkflowWriteContexts.set(execution,{runId,taskId:saved.taskId,assistantId:saved.assistantId,sources:structuredClone(saved.sources)})
 const advanceLease=createAuthorityLease(ceiling,async()=>{
  const current=await retainedGoalRunMetadata(runId)
  if(!current||current.claimedAt!==saved.claimedAt||current.claimAttempts!==saved.claimAttempts)return null
  return currentCeiling()
 })
 advanceLease.snapshotSource=()=>structuredClone(source)
 const advanceExecution=createExecutionContext({identity:execution.identity,ownership:execution.ownership,access:execution.security.access,
  authority:advanceLease,provenance:evidence,writeDefaults:execution.security.writeDefaults,lifecycle:execution.lifecycle,attribution:execution.attribution})
 return{saved,authority:{execution:advanceExecution,accumulator:authority.accumulator},evidence,frame,executeWithAuthority:async<T>(operation:()=>Promise<T>)=>runWithAgentAccess(execution.security.access,()=>runWithAuthorityLease(advanceLease,()=>executeWithCurrentAuthority(async()=>{
  await frame(false,async()=>undefined);const result=await operation();await frame(false,async()=>undefined);return result
 }))) }
}
/** Undefined is the unchanged ordinary-native path; protected failures never fall through. */
export async function retainedGoalWorkflowFrame<T>(runId:string,retaining:boolean,operation:(client:PoolClient)=>Promise<T>):Promise<{value:T}|undefined>{
 const runtime=await resolveRetainedGoalWorkflowRuntime(runId)
 if(!runtime)return undefined
 await assertCurrentAuthority()
 const result={value:await runtime.frame(retaining,operation)}
 await assertCurrentAuthority();return result
}

const retainedWorkflowWriteContexts=new WeakMap<import('@use-brian/core').ExecutionContext,{runId:string;taskId:string;assistantId:string;sources:ScopeSource[]}>()
/** Canonical SQL, never caller-supplied verifier. Only exact host-minted live objects qualify. */
export async function admitRetainedGoalWorkflowWrite(execution:import('@use-brian/core').ExecutionContext,sources:readonly ScopeSource[],client:PoolClient){
 const bound=retainedWorkflowWriteContexts.get(execution)
 if(!bound||!isDeepStrictEqual(bound.sources,sources))throw denied()
 await client.query("SELECT set_config('app.retained_task_goal',$1,true),set_config('app.v2_assistant_id',$2,true)",[bound.taskId,bound.assistantId])
 if((await client.query<{allowed:boolean}>('SELECT retained_goal_workflow_current($1,true) AS allowed',[bound.runId])).rows[0]?.allowed!==true)throw denied()
}
