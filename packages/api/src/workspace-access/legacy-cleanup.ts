/** Owner-reviewed selective erasure, never a full workspace reset.
 * [COMP:api/workspace-legacy-cleanup]
 */
import {randomUUID} from 'node:crypto'
import type {PoolClient} from 'pg'
import {z} from 'zod'
import {getPool} from '../db/client.js'
import {notifyWorkspaceChange} from '../brain-stream/notify.js'
import {assertContextActivationReady,getContextReadinessSystem} from '../context-scope/context-readiness.js'
import {hashCommandReviewIntent} from './command-review.js'
import {WorkspaceAccessError} from './policy.js'
import {SCOPE_REVIEW_KINDS,sourceAdapter,descendantAdapter} from './scope-review-registry.js'

const kinds=[...SCOPE_REVIEW_KINDS,'session','workflow','workflow_history','goal','assistant_binding'] as const
const selectionSchema=z.object({kind:z.enum(kinds),id:z.string().uuid().transform(id=>id.toLowerCase())}).strict()
const previewSchema=z.object({selections:z.array(selectionSchema).min(1).max(25)
 .refine(rows=>new Set(rows.map(row=>`${row.kind}:${row.id}`)).size===rows.length),reason:z.string().trim().min(1).max(1000),eraseUnclassifiedLegacy:z.boolean().default(false)}).strict()
const confirmationSchema=z.object({reviewId:z.string().uuid(),payloadHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict()
type Selection=z.infer<typeof selectionSchema>
type InternalSelection=Selection|{kind:'workflow_run';id:string}
type Reference={kind:string;id:string;version:string}
type WorkflowRunEvidence={id:string;workflowId:string;fingerprint:string}
type Source={version:string;compartments:string[]|null;held:boolean;[key:string]:unknown}
type Evidence={roots:Array<Selection&{fingerprint:string}>,descendants:Record<string,unknown>[],dependencies:unknown[],erasureFingerprints:Record<string,string>,candidates:Reference[],erasures:Reference[],unclassified:Reference[],eraseUnclassifiedLegacy:boolean,workflowRuns:WorkflowRunEvidence[],retained:string,reason:string}
type Review={id:string;workspace_id:string;actor_user_id:string;policy_revision:string;selection:Selection[];evidence:Evidence;payload_hash:string;expires_at:Date;status:'preview'|'applied'|'cancelled';receipt:unknown}
function fail(code:string,status=409):never{throw new WorkspaceAccessError(code,status)}
const equal=(a:unknown,b:unknown)=>hashCommandReviewIntent(a)===hashCommandReviewIntent(b)
const MAX_RETAINED=5_000
const isSource=(kind:string):kind is (typeof SCOPE_REVIEW_KINDS)[number]=>SCOPE_REVIEW_KINDS.includes(kind as (typeof SCOPE_REVIEW_KINDS)[number])

/** Only database identifiers, never a database error's message or query text. */
export class LegacyCleanupDatabaseError extends WorkspaceAccessError{
 readonly blocker:Record<string,string>
 constructor(code:string,status:number,error:{table?:unknown;constraint?:unknown;where?:unknown},sqlState:string){
  super(code,status);this.blocker={sqlState}
  for(const key of ['table','constraint'] as const){
   const value=error[key]
   if(typeof value==='string'&&/^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/.test(value))this.blocker[key]=value
  }
  if(typeof error.where==='string'){
   const name=error.where.match(/PL\/pgSQL function ([a-z_][a-z0-9_]{0,127})\(/)?.[1]
   if(name)this.blocker.function=name
  }
 }
}

async function owner(c:PoolClient,w:string,u:string){
 if(![w,u].every(id=>z.string().uuid().safeParse(id).success))fail('invalid_command',400)
 if(!(await c.query(`SELECT w.id FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id AND m.user_id=$2 AND m.role='owner'
  WHERE w.id=$1 AND w.owner_user_id=$2 FOR UPDATE OF w`,[w,u])).rowCount)fail('owner_required',403)
 await c.query("SELECT set_config('app.current_user_id',$1,true),set_config('TimeZone','UTC',true)",[u])
 const p=(await c.query<{revision:string}>('SELECT revision::text FROM workspace_access_policies WHERE workspace_id=$1 FOR UPDATE',[w])).rows[0]
 if(!p)fail('legacy_cleanup_policy_missing')
 return p.revision
}
async function transaction<T>(w:string,u:string,run:(c:PoolClient,revision:string)=>Promise<T>){
 const c=await getPool().connect()
 try{
  await c.query('BEGIN')
  await c.query("SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='30s'")
  const result=await run(c,await owner(c,w,u));await c.query('COMMIT');return result
 }catch(error){
  await c.query('ROLLBACK')
  if(error instanceof WorkspaceAccessError)throw error
  const database=error as {code?:string;table?:unknown;constraint?:unknown;where?:unknown},code=database.code
  if(code&&/^[0-9A-Z]{5}$/.test(code)){
   if(['23503','23505','23514','42501','P0001','22023','40001','40P01','55000'].includes(code))throw new LegacyCleanupDatabaseError('legacy_cleanup_blocked',409,database,code)
   if(code==='57014'||code==='55P03')throw new LegacyCleanupDatabaseError('legacy_cleanup_busy',503,database,code)
   throw new LegacyCleanupDatabaseError('legacy_cleanup_database_error',500,database,code)
  }
  throw error
 }finally{c.release()}
}
function adapter(row:InternalSelection){
 if(isSource(row.kind))return sourceAdapter(row.kind)
 const table={session:'sessions',workflow:'workflows',workflow_history:'workflows',workflow_run:'workflow_runs',goal:'goals',assistant_binding:'assistants'}[row.kind]
 return{table,from:`${table} r`,workspacePredicate:'r.workspace_id=$1'}
}
async function scope(c:PoolClient,w:string,kind:string,id:string){
 return(await c.query<{value:Source|null}>('SELECT read_scope_review_source($1,$2,$3) AS value',[w,kind,id])).rows[0].value
}
/** The DB hashes content; neither the preview nor the host receives its bytes. */
async function fingerprint(c:PoolClient,w:string,row:InternalSelection){
 const a=adapter(row)
 return(await c.query<{fingerprint:string}>(`SELECT encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex') AS fingerprint
  FROM ${a.from} WHERE ${a.workspacePredicate} AND r.id=$2 FOR UPDATE OF r`,[w,row.id])).rows[0]?.fingerprint??null
}
/** Protect every department, including private/held records. This is not an
 * inventory completion claim. An oversized protection set refuses cleanup. */
async function retained(c:PoolClient,w:string,unclassified:Reference[]=[]){
 const rows:Array<{kind:string;id:string;fingerprint:string}>=[]
 for(const kind of SCOPE_REVIEW_KINDS){
  const a=sourceAdapter(kind)
  const selected=await c.query<{id:string;fingerprint:string}>(`SELECT r.id::text,
   encode(sha256(convert_to(jsonb_build_array(to_jsonb(r),read_scope_review_source($1,$2,r.id))::text,'UTF8')),'hex') AS fingerprint
   FROM ${a.from} WHERE ${a.workspacePredicate}
   AND CASE WHEN jsonb_typeof(read_scope_review_source($1,$2,r.id)->'compartments')='array'
    THEN jsonb_array_length(read_scope_review_source($1,$2,r.id)->'compartments')>0 ELSE true END
   AND NOT(r.id=ANY($3::uuid[]))
   ORDER BY r.id LIMIT ${MAX_RETAINED+1} FOR SHARE OF r`,[w,kind,unclassified.filter(row=>row.kind===kind).map(row=>row.id)])
  rows.push(...selected.rows.map(row=>({kind,...row})))
  if(rows.length>MAX_RETAINED)fail('legacy_cleanup_retention_too_large')
 }
 // A dependent immutable revision can belong to a department even when its
 // parent is General. Its bytes and hold state are part of retention too.
 const extra=[
  ['session_context_scope_revisions','r.workspace_id=$1 AND cardinality(r.compartments)>0'],
  ['session_context_revision_contents',`r.workspace_id=$1 AND EXISTS(SELECT 1 FROM session_context_scope_revisions p
    WHERE p.workspace_id=r.workspace_id AND p.id=r.revision_id AND cardinality(p.compartments)>0)`],
  ['knowledge_entry_scope_revisions',`r.workspace_id=$1 AND (cardinality(r.compartments)>0 OR EXISTS(
    SELECT 1 FROM knowledge_entries p WHERE p.workspace_id=r.workspace_id AND p.id=r.entry_id AND cardinality(p.compartments)>0))`],
  ['knowledge_entry_revision_values',`r.workspace_id=$1 AND EXISTS(SELECT 1 FROM knowledge_entry_scope_revisions v
    JOIN knowledge_entries p ON p.workspace_id=v.workspace_id AND p.id=v.entry_id WHERE v.workspace_id=r.workspace_id
     AND v.id=r.revision_id AND (cardinality(v.compartments)>0 OR cardinality(p.compartments)>0))`],
  ['workspace_files',`r.workspace_id=$1 AND EXISTS(SELECT 1 FROM office_artifact_versions v JOIN office_artifacts p
    ON p.id=v.artifact_id AND p.workspace_id=v.workspace_id WHERE v.snapshot_file_id=r.id
     AND p.workspace_id=$1 AND coalesce(jsonb_array_length(read_scope_review_source($1,'office_artifact',p.id)->'compartments'),0)>0)`],
  ['recordings',`r.workspace_id=$1 AND (EXISTS(SELECT 1 FROM episodes p WHERE p.workspace_id=$1 AND p.id=r.id AND cardinality(p.compartments)>0)
    OR EXISTS(SELECT 1 FROM workspace_files p WHERE p.workspace_id=$1 AND p.id IN(r.transcript_file_id,r.media_file_id) AND cardinality(p.compartments)>0))`],
  ['file_segments',`r.workspace_id=$1 AND EXISTS(SELECT 1 FROM workspace_files p WHERE p.workspace_id=$1 AND p.id=r.file_id AND cardinality(p.compartments)>0)`],
  ['file_cache',`r.workspace_id=$1 AND EXISTS(SELECT 1 FROM workspace_files p WHERE p.workspace_id=$1 AND p.id=r.artifact_file_id AND cardinality(p.compartments)>0)`],
  ['sessions',"r.workspace_id=$1 AND (r.context_group_id IS NOT NULL OR r.context_project_id IS NOT NULL)"],
  ['workflows',"r.workspace_id=$1 AND (r.authoring_authority IS NOT NULL OR r.context_group_id IS NOT NULL OR r.context_project_id IS NOT NULL)"],
  ['workflow_runs',`r.workspace_id=$1 AND (r.context_group_id IS NOT NULL OR r.context_project_id IS NOT NULL
    OR cardinality(r.context_compartments)>0 OR cardinality(r.context_project_ids)>0
    OR CASE WHEN jsonb_typeof(r.execution_authority#>'{ceiling,compartments}')='array'
      THEN jsonb_array_length(r.execution_authority#>'{ceiling,compartments}')>0 ELSE false END)`],
  ['goals',"r.workspace_id=$1 AND (r.authoring_authority IS NOT NULL OR r.context_group_id IS NOT NULL OR r.context_project_id IS NOT NULL)"],
 ] as const
 for(const [table,predicate] of extra){
  const selected=await c.query<{id:string;fingerprint:string}>(`SELECT r.ctid::text AS id,
   encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex') AS fingerprint FROM ${table} r
   WHERE ${predicate} ORDER BY r.ctid LIMIT ${MAX_RETAINED+1} FOR SHARE OF r`,[w])
  rows.push(...selected.rows.map(row=>({kind:table,...row})))
  if(rows.length>MAX_RETAINED)fail('legacy_cleanup_retention_too_large')
 }
 return hashCommandReviewIntent(rows)
}
/** Check real FK reach, including rows whose own workspace is inconsistent.
 * No tenant content is returned. Empty branches stop immediately; cycles are
 * checked at their edge before traversal stops. Unknown/deep reach refuses. */
async function foreignKeyReach(c:PoolClient,w:string,row:InternalSelection,onSource:(kind:(typeof SCOPE_REVIEW_KINDS)[number],id:string)=>Promise<void>){
 const evidence:unknown[]=[]
 const quote=(s:string)=>`"${s.replaceAll('"','""')}"`
 const a=adapter(row)
 const walk=async(table:string,sql:string,seen:Set<string>,depth:number,budget:{n:number}):Promise<void>=>{
  const keys=(await c.query<{schema:string;table:string;columns:string[];parents:string[]}>(`SELECT ns.nspname AS schema,child.relname AS table,
   ARRAY(SELECT attname::text FROM unnest(f.conkey) WITH ORDINALITY key(num,ord) JOIN pg_attribute a ON a.attrelid=f.conrelid AND a.attnum=key.num ORDER BY ord) AS columns,
   ARRAY(SELECT attname::text FROM unnest(f.confkey) WITH ORDINALITY key(num,ord) JOIN pg_attribute a ON a.attrelid=f.confrelid AND a.attnum=key.num ORDER BY ord) AS parents
   FROM pg_constraint f JOIN pg_class child ON child.oid=f.conrelid JOIN pg_namespace ns ON ns.oid=child.relnamespace
   WHERE f.contype='f' AND f.confrelid=$1::regclass ORDER BY f.oid`,[table])).rows
  for(const key of keys){
   if(++budget.n>500||depth>8)fail('legacy_cleanup_dependency_budget')
   if(key.schema!=='public')fail('legacy_cleanup_dependency_unsupported')
   const child=`${quote(key.schema)}.${quote(key.table)}`
   const join=key.columns.map((column,i)=>`r.${quote(column)}=p.${quote(key.parents[i])}`).join(' AND ')
   const reached=`SELECT r.* FROM ${child} r WHERE EXISTS(SELECT 1 FROM (${sql}) p WHERE ${join})`
   const labels=["to_jsonb(r)->'compartments'","to_jsonb(r)->'required_compartments'","to_jsonb(r)#>'{source_scope,compartments}'","to_jsonb(r)#>'{scope_source,compartments}'"]
    .map(value=>`CASE WHEN jsonb_typeof(${value})='array' THEN jsonb_array_length(${value})>0 ELSE false END`).join(' OR ')
   const state=(await c.query<{present:boolean;foreign:boolean;scoped:boolean}>(`SELECT EXISTS(SELECT 1 FROM (${reached}) r) AS present,
    EXISTS(SELECT 1 FROM (${reached}) r WHERE to_jsonb(r)->>'workspace_id' IS NOT NULL
     AND to_jsonb(r)->>'workspace_id'<>$1::text) AS foreign,
    EXISTS(SELECT 1 FROM (${reached}) r WHERE ${labels}
     OR to_jsonb(r)->>'context_group_id' IS NOT NULL OR to_jsonb(r)->>'context_project_id' IS NOT NULL) AS scoped`,[w,row.id])).rows[0]
   if(state.foreign)fail('legacy_cleanup_foreign_dependency')
   if(state.scoped)fail('legacy_cleanup_retained_dependency')
   const frozen=(await c.query<{n:number;fingerprint:string}>(`SELECT count(*)::int AS n,
    encode(sha256(convert_to(coalesce(jsonb_agg(body ORDER BY body),'[]'::jsonb)::text,'UTF8')),'hex') AS fingerprint
    FROM (SELECT encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex') AS body
     FROM (${reached} LIMIT 501 FOR SHARE OF r) r) bounded`,[w,row.id])).rows[0]
   if(frozen.n>500)fail('legacy_cleanup_impact_too_large')
   evidence.push({table:child,columns:key.columns,parents:key.parents,...frozen})
   if(state.present)for(const kind of SCOPE_REVIEW_KINDS){
    const source=sourceAdapter(kind)
    if(source.table!==key.table)continue
    const ids=(await c.query<{id:string}>(`SELECT r.id FROM ${source.from} WHERE ${source.workspacePredicate}
     AND r.id IN(SELECT id FROM (${reached}) reached) ORDER BY r.id LIMIT 501`,[w,row.id])).rows
    for(const item of ids)await onSource(kind,item.id)
   }
   const reachKey=`${child}:${frozen.fingerprint}`
   if(state.present&&!seen.has(reachKey))await walk(child,reached,new Set([...seen,reachKey]),depth+1,budget)
  }
 }
 await walk(`public.${a.table}`,`SELECT r.* FROM ${a.from} WHERE ${a.workspacePredicate} AND r.id=$2`,new Set(),0,{n:0})
 return evidence
}
async function snapshot(c:PoolClient,w:string,selections:Selection[],reason:string,eraseUnclassifiedLegacy=false):Promise<Evidence>{
 const roots:Evidence['roots']=[],erasures=new Map<string,Reference>(),descendants=new Map<string,Record<string,unknown>>()
 const dependencies:unknown[]=[],erasureFingerprints:Record<string,string>={}
 const allowedUnclassified=new Set<string>(),unclassified=new Map<string,Reference>()
 if(eraseUnclassifiedLegacy){
  for(const row of selections)if(isSource(row.kind))allowedUnclassified.add(`${row.kind}:${row.id}`)
  const sessions=selections.filter(row=>row.kind==='session').map(row=>row.id)
  const messages=await c.query<{id:string}>(`SELECT m.id FROM session_messages m JOIN sessions s ON s.id=m.session_id
   WHERE s.workspace_id=$1 AND coalesce(m.workspace_id,s.workspace_id)=$1 AND s.id=ANY($2::uuid[])
    AND s.context_group_id IS NULL AND s.context_project_id IS NULL AND s.status<>'running'
   ORDER BY m.id LIMIT 501 FOR UPDATE OF m`,[w,sessions])
  if(messages.rows.length>500)fail('legacy_cleanup_impact_too_large')
  for(const row of messages.rows)allowedUnclassified.add(`session_message:${row.id}`)
 }
 const remember=async(kind:(typeof SCOPE_REVIEW_KINDS)[number],id:string)=>{
  if(erasures.has(`${kind}:${id}`))return
  const source=await scope(c,w,kind,id)
  if(!source)fail('legacy_cleanup_scoped_record')
  if(!Array.isArray(source.compartments)){
   if(source.compartments!==null||!allowedUnclassified.has(`${kind}:${id}`))fail('legacy_cleanup_scoped_record')
   unclassified.set(`${kind}:${id}`,{kind,id,version:source.version})
  }else if(source.compartments.length)fail('legacy_cleanup_scoped_record')
  erasures.set(`${kind}:${id}`,{kind,id,version:source.version})
  const hash=await fingerprint(c,w,{kind,id})
  if(!hash)fail('legacy_cleanup_changed')
  erasureFingerprints[`${kind}:${id}`]=hash
  if(erasures.size>500)fail('legacy_cleanup_impact_too_large')
 }
 const captureDescendants=async(kind:string,id:string)=>{
  const graph=(await c.query<{kind:string;id:string}>(`WITH RECURSIVE descendants(kind,id) AS (
       SELECT d.resource_kind,d.resource_id FROM scope_derivation_sources s
       JOIN scope_derivations d ON d.id=s.derivation_id AND d.workspace_id=s.workspace_id
       WHERE s.workspace_id=$1 AND s.source_kind=$2 AND s.source_id IN(
        SELECT $3::uuid ${kind==='workflow_run'||isSource(kind)&&sourceAdapter(kind).category==='source'?'UNION SELECT resource_id FROM scope_source_ancestors($1,$2,$3)':''})
       UNION SELECT d.resource_kind,d.resource_id FROM descendants p
       JOIN scope_derivation_sources s ON s.workspace_id=$1 AND s.source_kind=p.kind AND s.source_id=p.id
       JOIN scope_derivations d ON d.id=s.derivation_id AND d.workspace_id=s.workspace_id
      ) SELECT kind,id FROM descendants ORDER BY kind,id LIMIT 501`,[w,kind,id])).rows
  for(const node of graph){
   const a=descendantAdapter(node.kind)
   if(!a)fail('legacy_cleanup_impact_unsupported')
   await c.query(`SELECT r.id FROM ${a.from} WHERE ${a.workspacePredicate} AND r.id=$2 FOR UPDATE OF r`,[w,node.id])
   const current=(await c.query<{value:Record<string,unknown>|null}>('SELECT read_scope_review_impact_source($1,$2,$3) AS value',[w,node.kind,node.id])).rows[0].value
   if(!current)fail('legacy_cleanup_impact_unverifiable')
   // A scope ancestor cannot be erased underneath retained departmental data.
   if(isSource(node.kind as Selection['kind'])){
    const full=await scope(c,w,node.kind,node.id)
    if(full?.compartments?.length)fail('legacy_cleanup_retained_dependency')
    if(full)await remember(node.kind as (typeof SCOPE_REVIEW_KINDS)[number],node.id)
   }
   descendants.set(`${node.kind}:${node.id}`,{kind:node.kind,id:node.id,...current})
   if(descendants.size>500)fail('legacy_cleanup_impact_too_large')
  }
 }
 const addErasure=async(kind:(typeof SCOPE_REVIEW_KINDS)[number],id:string)=>{
  await remember(kind,id);await captureDescendants(kind,id)
 }
 const workflowRuns:WorkflowRunEvidence[]=[]
 for(const row of selections.filter(row=>row.kind==='workflow'||row.kind==='workflow_history')){
  const history=row.kind==='workflow_history'
  const runs=(await c.query<{id:string;workflow_id:string;status:string;scoped:boolean;unknown:boolean}>(`SELECT r.id,r.workflow_id,r.status,
   (r.context_group_id IS NOT NULL OR r.context_project_id IS NOT NULL OR cardinality(r.context_compartments)>0
    OR cardinality(r.context_project_ids)>0 OR CASE WHEN jsonb_typeof(r.execution_authority#>'{ceiling,compartments}')='array'
     THEN jsonb_array_length(r.execution_authority#>'{ceiling,compartments}')>0 ELSE false END
    OR CASE WHEN jsonb_typeof(r.vars#>'{__contextScopeEvidence,compartments}')='array'
     THEN jsonb_array_length(r.vars#>'{__contextScopeEvidence,compartments}')>0 ELSE false END) AS scoped,
   (r.context_compartments IS NULL OR r.context_project_ids IS NULL) AS unknown
   FROM workflow_runs r WHERE r.workspace_id=$1 AND r.workflow_id=$2
    ${history?'AND r.context_group_id IS NULL AND r.context_project_id IS NULL AND cardinality(r.context_compartments)=0 AND cardinality(r.context_project_ids)=0':''}
   ORDER BY r.id LIMIT 501 FOR UPDATE`,[w,row.id])).rows
  if(runs.length>500||workflowRuns.length+runs.length>500)fail('legacy_cleanup_impact_too_large')
  for(const run of runs){
   if(workflowRuns.some(row=>row.id===run.id))continue
   if(run.scoped)fail('legacy_cleanup_retained_dependency')
   if(run.unknown&&!eraseUnclassifiedLegacy)fail('legacy_cleanup_scoped_record')
   if(!['completed','failed','timeout'].includes(run.status))fail('legacy_cleanup_running')
   const ref={kind:'workflow_run' as const,id:run.id},hash=await fingerprint(c,w,ref)
   if(!hash)fail('legacy_cleanup_changed')
   workflowRuns.push({id:run.id,workflowId:run.workflow_id,fingerprint:hash})
   dependencies.push({kind:'workflow_run',id:run.id,rows:await foreignKeyReach(c,w,ref,remember)})
   await captureDescendants('workflow_run',run.id)
  }
 }
 workflowRuns.sort((a,b)=>a.id.localeCompare(b.id))
 const runIds=workflowRuns.map(row=>row.id)
 if((await c.query(`SELECT 1 FROM workflow_run_copy_sources WHERE source_run_id=ANY($1::uuid[])
  AND (workspace_id<>$2 OR NOT(run_id=ANY($1::uuid[]))) LIMIT 1`,[runIds,w])).rowCount)fail('legacy_cleanup_workflow_copy_dependency')
 for(const row of selections){
  const hash=await fingerprint(c,w,row)
  if(!hash)fail('legacy_cleanup_selection_unavailable')
  roots.push({...row,fingerprint:hash})
  if(row.kind!=='assistant_binding'&&row.kind!=='workflow_history')dependencies.push({kind:row.kind,id:row.id,rows:await foreignKeyReach(c,w,row,remember)})
  if(isSource(row.kind)){
   if(row.kind==='session_message'){
    const parent=(await c.query<{status:string;context_group_id:string|null;context_project_id:string|null}>(`SELECT s.status,s.context_group_id,s.context_project_id
     FROM sessions s JOIN session_messages m ON m.session_id=s.id WHERE m.id=$1 FOR UPDATE OF s`,[row.id])).rows[0]
    if(parent?.status==='running')fail('legacy_cleanup_running')
    if(parent?.context_group_id||parent?.context_project_id)fail('legacy_cleanup_scoped_record')
   }
   await addErasure(row.kind,row.id)
  }else if(row.kind==='session'){
   const session=(await c.query<{status:string;context_group_id:string|null;context_project_id:string|null;context_binding_origin:string}>('SELECT status,context_group_id,context_project_id,context_binding_origin FROM sessions WHERE workspace_id=$1 AND id=$2',[w,row.id])).rows[0]
   if(session.status==='running')fail('legacy_cleanup_running')
   if(session.context_group_id||session.context_project_id)fail('legacy_cleanup_scoped_record')
   const messages=(await c.query<{id:string}>('SELECT id FROM session_messages WHERE session_id=$1 ORDER BY id LIMIT 501 FOR UPDATE',[row.id])).rows
   if(messages.length>500)fail('legacy_cleanup_impact_too_large')
   for(const message of messages)await addErasure('session_message',message.id)
  }else if(row.kind==='assistant_binding'){
   const a=(await c.query<{context_binding_origin:string;team_scope_mode:string;compartments:string[]|null;home_department_id:string|null;default_workspace_group_id:string|null}>(
    'SELECT context_binding_origin,team_scope_mode,compartments,home_department_id,default_workspace_group_id FROM assistants WHERE workspace_id=$1 AND id=$2',[w,row.id])).rows[0]
   if(a.context_binding_origin!=='legacy'||a.team_scope_mode!=='legacy'||a.compartments!==null||!a.home_department_id
    ||a.default_workspace_group_id&&a.default_workspace_group_id!==a.home_department_id)fail('legacy_cleanup_binding_unsupported')
   if(!(await c.query("SELECT id FROM workspace_groups WHERE workspace_id=$1 AND id=$2 AND status='active' FOR SHARE",[w,a.home_department_id])).rowCount)fail('legacy_cleanup_binding_unsupported')
   await assertContextActivationReady(w,()=>getContextReadinessSystem(w,c.query.bind(c),{legacyInventory:false,scopeReview:false}))
  }else if(row.kind!=='workflow_history'){
   const a=adapter(row)
   if(!(await c.query(`SELECT id FROM ${a.table} WHERE workspace_id=$1 AND id=$2 AND authoring_authority IS NULL`,[w,row.id])).rowCount)fail('legacy_cleanup_selection_unavailable')
   if(row.kind==='workflow'){
    if((await c.query("SELECT id FROM workflow_runs WHERE workflow_id=$1 AND status IN('running','pending','awaiting_wait','awaiting_input') LIMIT 1",[row.id])).rowCount)fail('legacy_cleanup_running')
    if((await c.query('SELECT j.id FROM scheduled_jobs j JOIN assistants a ON a.id=j.assistant_id WHERE j.workflow_id=$1 AND a.workspace_id<>$2 LIMIT 1',[row.id,w])).rowCount)fail('legacy_cleanup_foreign_dependency')
   }
   if(row.kind==='goal'&&(await c.query("SELECT id FROM goals WHERE id=$1 AND status IN('running','awaiting_approval','done')",[row.id])).rowCount)fail('legacy_cleanup_running')
  }
 }
 const candidates=[...erasures.values()].sort((a,b)=>`${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`))
 const unknown=[...unclassified.values()].sort((a,b)=>`${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`))
 return{roots,dependencies,erasureFingerprints,candidates,erasures:candidates,unclassified:unknown,eraseUnclassifiedLegacy,workflowRuns,descendants:[...descendants.values()].sort((a,b)=>`${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)),retained:await retained(c,w,unknown),reason}
}
async function perform(c:PoolClient,w:string,selections:Selection[],workflowRuns:WorkflowRunEvidence[]=[]){
 const changes:Array<Selection&{action:'erased'|'bound'|'erased_history'}>=[]
 const runIds=workflowRuns.map(row=>row.id)
 if(runIds.length){
  await c.query('DELETE FROM workflow_run_copy_sources WHERE workspace_id=$1 AND run_id=ANY($2::uuid[])',[w,runIds])
  await c.query('DELETE FROM workflow_runs WHERE workspace_id=$1 AND id=ANY($2::uuid[])',[w,runIds])
  if((await c.query('SELECT 1 FROM workflow_runs WHERE id=ANY($1::uuid[]) LIMIT 1',[runIds])).rowCount)fail('legacy_cleanup_changed')
 }
 for(const row of selections){
  const a=adapter(row)
  if(row.kind==='assistant_binding'){
   await c.query(`UPDATE assistants SET team_scope_mode='all',default_workspace_group_id=home_department_id,
    context_binding_origin='reviewed',updated_at=now() WHERE workspace_id=$1 AND id=$2`,[w,row.id])
   changes.push({...row,action:'bound'})
  }else if(row.kind==='workflow_history'){
   changes.push({...row,action:'erased_history'})
  }else{
   // Existing row delete triggers retain canonical descendant invalidation,
   // content erasure and immutable-evidence guards. No trigger is disabled.
   if(row.kind==='workflow')await c.query('DELETE FROM scheduled_jobs j USING assistants a WHERE j.workflow_id=$1 AND a.id=j.assistant_id AND a.workspace_id=$2',[row.id,w])
   const result=await c.query(`DELETE FROM ${a.table} r USING (SELECT r.id FROM ${a.from}
    WHERE ${a.workspacePredicate} AND r.id=$2) selected WHERE r.id=selected.id`,[w,row.id])
   if(result.rowCount!==1)fail('legacy_cleanup_changed')
   changes.push({...row,action:'erased'})
  }
 }
 return changes
}
async function removedReferences(c:PoolClient,candidates:Reference[]){
 const present=new Set<string>()
 for(const kind of SCOPE_REVIEW_KINDS){
  const ids=candidates.filter(row=>row.kind===kind).map(row=>row.id)
  if(!ids.length)continue
  const rows=(await c.query<{id:string}>(`SELECT id FROM ${sourceAdapter(kind).table} WHERE id=ANY($1::uuid[])`,[ids])).rows
  for(const row of rows)present.add(`${kind}:${row.id}`)
 }
 return candidates.filter(row=>!present.has(`${row.kind}:${row.id}`))
}
async function simulate(c:PoolClient,w:string,selections:Selection[],evidence:Evidence){
 await c.query('SAVEPOINT cleanup_simulation')
 try{
  await perform(c,w,selections,evidence.workflowRuns)
  if(await retained(c,w,evidence.unclassified)!==evidence.retained)fail('legacy_cleanup_retained_dependency')
  return await removedReferences(c,evidence.candidates)
 }
 finally{await c.query('ROLLBACK TO SAVEPOINT cleanup_simulation');await c.query('RELEASE SAVEPOINT cleanup_simulation')}
}
function view(r:Review){return{id:r.id,payloadHash:r.payload_hash,status:r.status,expiresAt:r.expires_at.toISOString(),selections:r.selection,
 reason:r.evidence.reason,erasedReferences:r.evidence.erasures,erasedWorkflowRuns:(r.evidence.workflowRuns??[]).map(({id,workflowId})=>({id,workflowId})),unclassifiedReferences:r.evidence.unclassified??[],dependentCount:r.evidence.descendants.length,receipt:r.receipt}}
export async function previewLegacyCleanup(w:string,u:string,input:unknown){
 const parsed=previewSchema.safeParse(input);if(!parsed.success)fail('invalid_command',400)
 return transaction(w,u,async(c,revision)=>{
  const selections=parsed.data.selections.sort((a,b)=>`${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`))
  const evidence=await snapshot(c,w,selections,parsed.data.reason,parsed.data.eraseUnclassifiedLegacy)
  evidence.erasures=await simulate(c,w,selections,evidence)
  const id=randomUUID(),expiresAt=new Date(Date.now()+15*60_000)
  const payloadHash=hashCommandReviewIntent({id,w,u,revision,selections,evidence,expiresAt:expiresAt.toISOString()})
  const row=(await c.query<Review>(`INSERT INTO workspace_legacy_cleanup_reviews(id,workspace_id,actor_user_id,policy_revision,selection,evidence,payload_hash,expires_at)
   VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8) RETURNING *`,[id,w,u,revision,JSON.stringify(selections),JSON.stringify(evidence),payloadHash,expiresAt])).rows[0]
  return view(row)
 })
}
export async function applyLegacyCleanup(w:string,u:string,input:unknown,cancel=false){
 const parsed=confirmationSchema.safeParse(input);if(!parsed.success)fail('invalid_command',400)
 const result=await transaction(w,u,async(c,revision)=>{
  const r=(await c.query<Review>('SELECT * FROM workspace_legacy_cleanup_reviews WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3 FOR UPDATE',[w,u,parsed.data.reviewId])).rows[0]
  if(!r)fail('not_found',404)
  if(r.payload_hash!==parsed.data.payloadHash)fail('legacy_cleanup_changed')
  if(r.status==='applied')return view(r)
  if(r.status!=='preview')fail('legacy_cleanup_not_active')
  if(cancel)return view((await c.query<Review>("UPDATE workspace_legacy_cleanup_reviews SET status='cancelled' WHERE id=$1 RETURNING *",[r.id])).rows[0])
  if(r.expires_at.getTime()<=Date.now())fail('legacy_cleanup_expired')
  if(String(r.policy_revision)!==revision)fail('legacy_cleanup_changed')
  const current=await snapshot(c,w,r.selection,r.evidence.reason,r.evidence.eraseUnclassifiedLegacy)
  current.erasures=r.evidence.erasures
  if(!equal(current,r.evidence))fail('legacy_cleanup_changed')
  const changes=await perform(c,w,r.selection,current.workflowRuns)
  if(!equal(await removedReferences(c,current.candidates),r.evidence.erasures))fail('legacy_cleanup_changed')
  if(await retained(c,w,r.evidence.unclassified)!==r.evidence.retained)fail('legacy_cleanup_retained_dependency')
  const receipt={changes,retainedVerified:true}
  const applied=(await c.query<Review>("UPDATE workspace_legacy_cleanup_reviews SET status='applied',receipt=$2::jsonb WHERE id=$1 RETURNING *",[r.id,JSON.stringify(receipt)])).rows[0]
  await c.query("UPDATE workspace_access_policies SET reviewed_inventory_revision=NULL,revision=revision+1,updated_at=now() WHERE workspace_id=$1",[w])
  await c.query("INSERT INTO workspace_access_events(workspace_id,actor_user_id,kind,subject_id,policy_revision,changes) VALUES($1,$2,'legacy.cleanup.apply',$3,(SELECT revision FROM workspace_access_policies WHERE workspace_id=$1),$4::jsonb)",[w,u,r.id,JSON.stringify(receipt)])
  return view(applied)
 })
 if(!cancel)notifyWorkspaceChange(w,'workspace_config','update')
 return result
}
