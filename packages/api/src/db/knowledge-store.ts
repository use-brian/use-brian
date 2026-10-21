/**
 * Knowledge store — team-scoped knowledge entries + team knowledge sources.
 *
 * Entries are deduplicated at (workspace_id, path). Viewer-facing reads
 * take an `AccessContext` (WU-4.2b) and filter on workspace_id +
 * sensitivity_rank() (migration 065). The per-assistant dimension is gone
 * — an assistant sees its team's canonical entries subset to its
 * clearance at read time. System callers (sync worker, audit) bypass
 * clearance via the `*System` parallel methods.
 *
 * Note on `buildAccessPredicate` — the universal predicate's
 * visibility-double clauses reference `user_id` and `assistant_id`
 * columns which knowledge_entries does NOT carry (the table is purely
 * workspace-scoped by design — migration 082 dropped the per-assistant
 * dimension). So this store composes its own narrower predicate
 * (workspace_id + sensitivity) inline rather than calling the helper.
 *
 * Workflow event source — this store is the KB's write chokepoint (the
 * github/local sync worker, the assistant repo-writer's write-through, and
 * manual entry writes all funnel through `create` / `upsertByPath` /
 * `updateManualEntryContent` / `deleteByTeamAndPath`), so it is where
 * knowledge lifecycle events are published for the `knowledge` workflow event
 * source. Best-effort and fire-and-forget — see knowledge-event-fanout.ts.
 * Bulk teardown paths (`deleteBySource`, `deleteByTeamAndPathPrefix`) and the
 * id-only `delete` deliberately do NOT emit: source disconnection would fire
 * one event per entry for a change the user made at the source level, not the
 * entry level.
 *
 * See docs/architecture/features/knowledge-base.md and
 * docs/architecture/platform/sensitivity.md.
 */

import {ContextScopeAccumulator,deriveWriteScope,resourceScopeKey,type DerivedWriteEvidence,bindScopeSources,boundScopeSources,DerivedScopeError,type ScopeSource,type AccessContext,type Sensitivity,type SessionContextAuthority,pinAccessCeiling,intersectAccessCeilings} from '@use-brian/core'
import type { KnowledgeLifecycleAction, KnowledgeWriteActor } from '@use-brian/core'
import { query, getPool, getAppPool, applyRLSGucs, rollbackAndRelease } from './client.js'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { PoolClient, QueryResultRow } from 'pg'
import { currentAgentAccess,runWithAgentAccess } from './agent-access-context.js'
import {currentApplicationReadTransaction} from '../application-platform/execution-context.js'
import {writeRetainedContextFrame,readRetainedContextFrame,readRetainedQueryFrame} from './session-context-revisions.js'
import {validateCallerScopeEvidence} from '../context-scope/caller-evidence.js'
import { readAdmissionPolicy } from '../workspace-access/admission-policy-read.js'
import { admitKnowledgeWrite, lockKnowledgePrior, admitKnowledgeSourceConfiguration, type KnowledgeSourceBindingInput, type KnowledgeConfigureAuthority } from '../workspace-access/knowledge-create-admission.js'
import { WorkspaceAccessError } from '../workspace-access/policy.js'
import { captureKnowledgeSyncAuthority, knowledgeSyncCapture, admitKnowledgeSync } from '../workspace-access/knowledge-sync-admission.js'
import { publishKnowledgeLifecycle } from '../knowledge-event-fanout.js'
import {readNativeKnowledgeSource,type KnowledgeSourceProjection} from './knowledge-source-reader.js'
import {validateDerivedWriteInputs,recordDerivedResource} from './derived-scope-store.js'

// ── Types ──────────────────────────────────────────────────────

export type KnowledgeEntry = {
  scopeVersion?: string
  id: string
  workspaceId: string
  path: string
  title: string
  summary: string | null
  content: string
  tags: string[]
  relatedIds: string[]
  sensitivity: Sensitivity
  compartments: string[]
  projectIds: string[]
  metadata: Record<string, unknown>
  sourceId: string | null
  sourceSha: string | null
  createdBy: string | null
  createdAt: Date
  updatedAt: Date
}

export type KnowledgeSourceType = 'github' | 'local'

export type KnowledgeSource = {
  configuredByUserId: string | null
  bindingSensitivity: Sensitivity | null
  bindingCompartments: string[] | null
  bindingProjectIds: string[] | null
  syncRunId: string | null
  syncDirty: boolean
  bindingVersion: string
  bindingHeld: boolean
  id: string
  workspaceId: string
  sourceType: KnowledgeSourceType
  repo: string
  branch: string
  rootPath: string
  lastSyncedSha: string | null
  lastSyncedAt: Date | null
  syncError: string | null
  /** The connector_instance this source syncs through. NULL = legacy by-workspace resolution. */
  connectorInstanceId: string | null
  /**
   * Cached PAT write-capability probe (migration 310): can the bound PAT
   * push to the repo? NULL = never probed — treated as read-only. Refreshed
   * by the sync worker each tick, at source creation, and on call-time 403.
   */
  writeAccess: boolean | null
  writeAccessCheckedAt: Date | null
  /**
   * Tier stamped on synced entries whose frontmatter has no explicit (valid)
   * `sensitivity:` (migration 410). Explicit frontmatter always wins.
   */
  defaultSensitivity: Sensitivity
  createdAt: Date
}

// ── Column lists ───────────────────────────────────────────────

// Unaliased — used by writes (INSERT ... RETURNING) and system callers
// that don't need a clearance-scoped related_ids filter.
/**
 * Publish one entry-shaped lifecycle event to the `knowledge` workflow event
 * source. Fire-and-forget; the fanout swallows its own errors.
 */
function emitLifecycle(
  row: Pick<
    KnowledgeEntry,
    'id' | 'workspaceId' | 'path' | 'title' | 'tags' | 'sensitivity' | 'sourceId' | 'scopeVersion'
  >,
  action: KnowledgeLifecycleAction,
  writtenBy: KnowledgeWriteActor | undefined,
  actorId: string | null,
): void {
  publishKnowledgeLifecycle({
    workspaceId: row.workspaceId,
    entryId: row.id,
    ...(row.scopeVersion ? { sourceVersion: row.scopeVersion } : {}),
    action,
    path: row.path,
    title: row.title,
    tags: row.tags ?? [],
    sensitivity: row.sensitivity,
    sourceId: row.sourceId ?? null,
    actorId,
    writtenBy,
  })
}

const ENTRY_COLUMNS = `
  id, workspace_id AS "workspaceId", scope_version::text AS "scopeVersion",
  path, title, summary, content, tags, related_ids AS "relatedIds",
  sensitivity, compartments, project_ids AS "projectIds",
  metadata, source_id AS "sourceId", source_sha AS "sourceSha",
  created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"
` as const


/** Canonical metadata from the same SQL snapshot as the selected payload. */
function knowledgeSourceExpression(alias: '' | 'ke' | 'ke2' = ''): string {
  const p = alias ? `${alias}.` : ''
  return `jsonb_build_object('workspaceId',${p}workspace_id,'userId',NULL,'assistantId',NULL,
    'sensitivity',${p}sensitivity,'compartments',${p}compartments,'projectIds',${p}project_ids,
    'resourceKind','knowledge_entry','resourceId',${p}id,'version',${p}scope_version::text)`
}

/** Only trusted canonical predicates are composed here, never request values. */
function knowledgeProjectedSources(predicate: string): string {
  return `(SELECT coalesce(jsonb_agg(${knowledgeSourceExpression('ke2')} ORDER BY ke2.id),'[]'::jsonb)
    FROM knowledge_entries ke2 WHERE ${predicate})`
}

function knowledgeSourceColumns(alias: '' | 'ke' | 'ke2' = '', contributors = "'[]'::jsonb"): string {
  return `${knowledgeSourceExpression(alias)} AS "__knowledgeScopeSource", ${contributors} AS "__knowledgeProjectionSources"`
}

/** Native viewer proof is the actual non-owner transaction, never the owner pool. */
async function withNativeKnowledgeViewer<T>(ctx:AccessContext,capture:(client:PoolClient)=>Promise<T>){
  // A genuine or serialized application binding cannot become a native read.
  if (currentApplicationReadTransaction(ctx) || ctx.systemRead || !ctx.userId) throw new DerivedScopeError('scope_evidence_missing')
  return runWithAgentAccess({workspaceId:ctx.workspaceId,userId:ctx.userId,
    clearance:ctx.clearance ?? currentAgentAccess()?.clearance ?? 'confidential',
    compartments:ctx.compartments,projectIds:ctx.projectIds,visibilityAssistantIds:ctx.visibilityAssistantIds,
    departmentRead:ctx.departmentRead,sharedAudience:ctx.sharedAudience},async()=>{
    const client=await getAppPool().connect()
    try {
      await client.query('BEGIN')
      await applyRLSGucs(client,ctx.userId)
      const result=await capture(client)
      await client.query('COMMIT')
      return result
    }finally{await rollbackAndRelease(client)}
  })
}

async function queryKnowledgeViewer<T extends QueryResultRow>(ctx:AccessContext,sql:string,params?:unknown[],sourceRows=true,metadataOnly=false,point?:KnowledgePointFrame){
 return withNativeKnowledgeViewer(ctx,client=>queryKnowledgeRows<T>(client,sql,params,sourceRows,metadataOnly,point))
}

const KNOWLEDGE_FIELDS=['id','path','title','summary','content','tags','relatedIds','metadata','sourceId','sourceSha','createdBy','createdAt','updatedAt'] as const
type KnowledgeField=typeof KNOWLEDGE_FIELDS[number]
const querySource=z.object({workspaceId:z.string().uuid(),userId:z.string().uuid().nullable(),assistantId:z.string().uuid().nullable(),
 sensitivity:z.enum(['public','internal','confidential']),compartments:z.array(z.string()),projectIds:z.array(z.string().uuid()),
 resourceKind:z.enum(['application_field','external_source']),resourceId:z.string().uuid(),version:z.string().min(1)}).strict()
const knowledgeCapture=z.object({row:z.record(z.unknown()).nullable(),sources:z.array(querySource).min(1),
 source:z.object({workspaceId:z.string().uuid(),userId:z.null(),assistantId:z.null(),sensitivity:z.enum(['public','internal','confidential']),
  compartments:z.array(z.string()),projectIds:z.array(z.string().uuid()),resourceKind:z.literal('knowledge_entry'),resourceId:z.string().uuid(),version:z.string().min(1),
  held:z.literal(false).optional(),validTo:z.null().optional(),retractedAt:z.null().optional()}).strict().optional()}).strict()

const knowledgeNativeSource=querySource.extend({resourceKind:z.literal('knowledge_entry')})
const knowledgePointCapture=z.object({values:z.record(z.unknown()),sources:z.array(querySource).min(1),nativeSources:z.array(knowledgeNativeSource).min(1),
 policyVersion:z.string().regex(/^[a-f0-9]{64}$/),recordVersion:z.string().min(1)}).strict()
const knowledgePointValues=z.object({id:z.string().uuid(),path:z.string(),title:z.string(),summary:z.string().nullable(),content:z.string(),
 tags:z.array(z.string()),relatedIds:z.array(z.string().uuid()),metadata:z.record(z.unknown()),sourceId:z.string().uuid().nullable(),sourceSha:z.string().nullable(),
 createdBy:z.string().uuid().nullable(),createdAt:z.string().datetime({offset:true}).transform(value=>new Date(value)),
 updatedAt:z.string().datetime({offset:true}).transform(value=>new Date(value))}).strict()

/** Query evaluation sees only a captured, current, field-admitted native domain. */
async function queryKnowledgeCollection<T extends QueryResultRow>(ctx:AccessContext,authority:SessionContextAuthority|undefined,
 fields:readonly KnowledgeField[],sql:string,params:unknown[],sourceRows=true){
 if(currentApplicationReadTransaction(ctx)||ctx.systemRead||!ctx.userId)throw new DerivedScopeError('scope_evidence_missing')
 ctx=structuredClone(ctx);params=structuredClone(params)
 if(authority){
  const e=authority.execution
  if(e.identity.kind!=='attended'||e.identity.principal.kind!=='workspace_member'||e.security.access.userId!==ctx.userId
   ||e.security.access.workspaceId!==ctx.workspaceId||e.assistant.id!==ctx.assistantId)throw new DerivedScopeError('scope_evidence_missing')
  await e.security.authority.assertCurrent()
 }
 const discover=async(client?:PoolClient)=>{
  const statement=`SELECT ${knowledgeSourceColumns('ke')} FROM knowledge_entries ke ORDER BY ke.id LIMIT 4097`
  const result=await(client?queryKnowledgeRows<{id:string}>(client,statement,[],true,true):queryKnowledgeViewer<{id:string}>(ctx,statement,[],true,true))
  if(result.rows.length>4096)throw new DerivedScopeError('scope_evidence_missing')
  return result
 }
 const roots=authority?boundScopeSources((await discover()).rows):[]
 const run=async(client:PoolClient)=>{
  let ceiling=authority?.execution.security.ceiling
  if(authority){
   const requested=pinAccessCeiling({...authority.execution.security.access,...Object.fromEntries(Object.entries(ctx).filter(([,v])=>v!==undefined))})
   ceiling=intersectAccessCeilings(authority.execution.security.ceiling,requested)
   await runWithAgentAccess({...authority.execution.security.access,...ceiling},()=>applyRLSGucs(client,ctx.userId))
   if(JSON.stringify(boundScopeSources((await discover(client)).rows))!==JSON.stringify(roots))throw new DerivedScopeError('scope_source_changed')
  }
  const snapshots=(await client.query<{value:unknown}>('SELECT value FROM read_native_knowledge_query_projection($1,$2,$3,$4)',[ctx.workspaceId,[...fields],!!authority,appliesDenylist(ctx)?ctx.assistantId:null])).rows.map(row=>knowledgeCapture.parse(row.value))
  if(!snapshots.length||snapshots[0].row!==null||snapshots.some(row=>row.sources.some(source=>source.workspaceId!==ctx.workspaceId)))throw new DerivedScopeError('scope_evidence_missing')
  const sources=snapshots.flatMap(row=>row.sources)
  if(authority&&ceiling){
   await authority.execution.security.authority.assertCurrent()
   await validateCallerScopeEvidence({sources},ceiling,client)
  }else{
   const fields=sources.filter(source=>source.resourceKind==='application_field')
   const admitted=(await client.query<{allowed:boolean}>(`SELECT coalesce(bool_and(coalesce(
    read_admitted_application_field_snapshot($1,root.id,root.version)->>'held'='false',false)),false) AS allowed
    FROM unnest($2::uuid[],$3::text[]) root(id,version)`,[ctx.workspaceId,fields.map(source=>source.resourceId),fields.map(source=>source.version)])).rows[0]?.allowed
   if(admitted!==true)throw new DerivedScopeError('scope_source_changed')
  }
  const rows=snapshots.filter(row=>row.row!==null).map(row=>{
   if(!row.source||row.source.workspaceId!==ctx.workspaceId)throw new DerivedScopeError('scope_evidence_missing')
   const value=row.row!
   return{...value,id:row.source.resourceId,workspace_id:ctx.workspaceId,scope_version:row.source.version,sensitivity:row.source.sensitivity,
    compartments:row.source.compartments,project_ids:row.source.projectIds,related_ids:value.relatedIds??[],source_id:value.sourceId??null,
    source_sha:value.sourceSha??null,created_by:value.createdBy??null,created_at:value.createdAt??null,updated_at:value.updatedAt??null}
  })
  const index=params.length+1,values=[...params,JSON.stringify(rows)]
  const relation=`knowledge_viewer_rows AS MATERIALIZED (SELECT r.*,
   setweight(to_tsvector('english',coalesce(r.title,'')),'A') || setweight(to_tsvector('english',coalesce(r.summary,'')),'B') ||
   setweight(to_tsvector('english',coalesce(array_to_string(r.tags,' '),'')),'B') || setweight(to_tsvector('english',coalesce(r.content,'')),'C') AS search_vector
   FROM jsonb_to_recordset($${index}::jsonb) AS r(id uuid,workspace_id uuid,scope_version text,path text,title text,summary text,content text,tags text[],related_ids uuid[],
    sensitivity text,compartments text[],project_ids uuid[],metadata jsonb,source_id uuid,source_sha text,created_by uuid,created_at timestamptz,updated_at timestamptz))`
  // Original SQL matching/ranking/limit semantics operate inside the same real
  // non-owner transaction, over admitted values rather than the owner table.
  const result=await client.query<T & {__knowledgeScopeSource?:ScopeSource;__knowledgeProjectionSources?:ScopeSource[]}>(
   `WITH ${relation} ${sql.replace(/\bFROM\s+knowledge_entries\b/gi,'FROM knowledge_viewer_rows')}`,values)
  for(const row of result.rows){
   const own=row.__knowledgeScopeSource,contributors=row.__knowledgeProjectionSources
   delete row.__knowledgeScopeSource;delete row.__knowledgeProjectionSources
   if(sourceRows&&(!own||!Array.isArray(contributors)))throw new DerivedScopeError('scope_evidence_missing')
   bindScopeSources(row,[...sources,...(own?[own]:[]),...contributors??[]])
  }
  bindScopeSources(result.rows,[...sources,...result.rows.flatMap(row=>boundScopeSources(row))])
  return{value:result,sources}
 }
 if(authority)return readRetainedQueryFrame(authority,roots,run)
 return runWithAgentAccess({workspaceId:ctx.workspaceId,userId:ctx.userId,clearance:ctx.clearance??currentAgentAccess()?.clearance??'confidential',
  compartments:ctx.compartments,projectIds:ctx.projectIds,visibilityAssistantIds:ctx.visibilityAssistantIds,departmentRead:ctx.departmentRead,sharedAudience:ctx.sharedAudience},async()=>{
  const client=await getAppPool().connect()
  try{
   await client.query('BEGIN');await applyRLSGucs(client,ctx.userId)
   const admitted=(await client.query<{allowed:boolean}>(`SELECT pg_catalog.row_security_active('public.knowledge_entries'::regclass)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_class c ON c.oid='public.knowledge_entries'::regclass
     WHERE r.rolname IN(current_user,session_user) AND(r.rolsuper OR r.rolbypassrls OR pg_catalog.pg_has_role(r.oid,c.relowner,'USAGE')))
    AND EXISTS(SELECT 1 FROM public.workspace_members WHERE workspace_id=$1 AND user_id=$2) AS allowed`,[ctx.workspaceId,ctx.userId])).rows[0]?.allowed
   if(admitted!==true){await client.query('COMMIT');return{rows:[] as T[]}}
   const result=await run(client);await client.query('COMMIT');return result.value
  }
  finally{await rollbackAndRelease(client)}
 })
}

/** Retained history is metadata, never permission to synthesize missing observations. */
function knowledgeDerivationExists(alias:'ke'|'ke2'|'knowledge_entries',currentVersion=false):string{
 return `EXISTS(SELECT 1 FROM public.scope_derivations d WHERE d.workspace_id=${alias}.workspace_id
   AND d.resource_kind='knowledge_entry' AND d.resource_id=${alias}.id
   ${currentVersion?`AND d.resource_version=${alias}.scope_version::text`:''})`
}
function knowledgeCurrentEvidenceComplete(alias:'ke'|'ke2'|'knowledge_entries'):string{
 return `(NOT ${knowledgeDerivationExists(alias)} OR ${knowledgeDerivationExists(alias,true)})`
}

type KnowledgePointFrame={sources:readonly ScopeSource[];requiresNoDerivation?:boolean}

/** Only a real viewer transaction may select or compute Knowledge payloads. */
async function queryKnowledgeRows<T extends QueryResultRow>(client:PoolClient,sql:string,params:unknown[]|undefined,sourceRows=true,metadataOnly=false,point?:KnowledgePointFrame){
      let pointFloor=''
      if(point){
        const roots=point.sources.filter(source=>source.resourceKind==='knowledge_entry')
        const count=params?.length??0
        params=[...params??[],roots.map(source=>source.resourceId),roots.map(source=>source.version)]
        pointFloor=` AND (knowledge_entries.id,knowledge_entries.scope_version::text) IN (
          SELECT id,version FROM unnest($${count+1}::uuid[],$${count+2}::text[]) AS admitted(id,version))`
        pointFloor+=` AND ${knowledgeCurrentEvidenceComplete('knowledge_entries')}`
        if(point.requiresNoDerivation)pointFloor+=` AND NOT ${knowledgeDerivationExists('knowledge_entries')}`
      }
      // Materialize the actual RLS-visible native domain before protected
      // predicates/aggregates. A misconfigured owner connection admits no rows.
      const relation=`knowledge_viewer_rows AS MATERIALIZED (SELECT ${metadataOnly?'id,workspace_id,sensitivity,compartments,project_ids,scope_version,related_ids,source_id':'*'} FROM public.knowledge_entries
        WHERE workspace_id=nullif(current_setting('app.agent_workspace_id',true),'')::uuid ${pointFloor}
          AND pg_catalog.row_security_active('public.knowledge_entries'::regclass)
          AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_class c ON c.oid='public.knowledge_entries'::regclass
            WHERE r.rolname=current_user AND (r.rolsuper OR r.rolbypassrls OR pg_catalog.pg_has_role(r.oid,c.relowner,'USAGE'))))`
      const result=await client.query<T & {__knowledgeScopeSource?:ScopeSource;__knowledgeProjectionSources?:ScopeSource[]}>(
        `WITH ${relation} ${sql.replace(/\bFROM\s+knowledge_entries\b/gi,'FROM knowledge_viewer_rows')}`,params)
      for(const row of result.rows){
        const source=row.__knowledgeScopeSource,contributors=row.__knowledgeProjectionSources
        delete row.__knowledgeScopeSource
        delete row.__knowledgeProjectionSources
        if(sourceRows){
          if(!source||!Array.isArray(contributors))throw new DerivedScopeError('scope_evidence_missing')
          bindScopeSources(row,[source,...contributors])
        }
      }
      if(sourceRows)bindScopeSources(result.rows,result.rows.flatMap(row=>boundScopeSources(row)))
      return result
}

/** Canonical point metadata confers no current source rights. */
async function queryKnowledgePoint(ctx:AccessContext,where:string,params:unknown[],relatedScopeSql:string,
 authority?:SessionContextAuthority){
 if(currentApplicationReadTransaction(ctx)||ctx.systemRead||!ctx.userId)throw new DerivedScopeError('scope_evidence_missing')
 ctx=structuredClone(ctx);params=structuredClone(params)
 if(authority){
  const execution=authority.execution
  if(execution.identity.kind!=='attended'||execution.identity.principal.kind!=='workspace_member'
   ||execution.security.access.userId!==ctx.userId||execution.security.access.workspaceId!==ctx.workspaceId
   ||execution.assistant.id!==ctx.assistantId)throw new DerivedScopeError('scope_evidence_missing')
  await execution.security.authority.assertCurrent()
 }
 const related=knowledgeRelatedPredicate(3,relatedScopeSql)
 // The same canonical predicates select both the related projection and its
 // source obligations. Only metadata is discovered before current admission.
 const metadata=await queryKnowledgeViewer<{id:string;requiresAuthority:boolean;evidenceComplete:boolean}>(ctx,
  `SELECT ke.id,(${knowledgeDerivationExists('ke')} OR EXISTS(SELECT 1 FROM knowledge_entries ke2
     WHERE ${related} AND ${knowledgeDerivationExists('ke2')})) AS "requiresAuthority",
   (${knowledgeCurrentEvidenceComplete('ke')} AND NOT EXISTS(SELECT 1 FROM knowledge_entries ke2
     WHERE ${related} AND NOT ${knowledgeCurrentEvidenceComplete('ke2')})) AS "evidenceComplete",
   ${knowledgeSourceColumns('ke',knowledgeProjectedSources(related))} ${where}`,params,true,true)
 const candidate=metadata.rows[0]
 if(!candidate||candidate.evidenceComplete!==true)return{rows:[]}
 const sources=boundScopeSources(candidate),root=sources.find(source=>source.resourceId===candidate.id&&source.resourceKind==='knowledge_entry')
 if(!root)throw new DerivedScopeError('scope_evidence_missing')
 if(candidate.requiresAuthority&&!authority)return{rows:[]}
 const capture=async(client:PoolClient,ceiling?:SessionContextAuthority['execution']['security']['ceiling'])=>{
  const value=(await client.query<{value:unknown}>('SELECT read_native_knowledge_point_projection($1,$2,$3,$4) AS value',
   [ctx.workspaceId,candidate.id,root.version,!authority])).rows[0]?.value
  if(value===null)return{rows:[] as KnowledgeEntry[]}
  const captured=knowledgePointCapture.parse(value),observed=[...captured.sources,...captured.nativeSources]
  const own=captured.nativeSources.find(source=>source.resourceId===candidate.id)
  if(captured.recordVersion!==root.version||!own||own.version!==root.version||observed.some(source=>source.workspaceId!==ctx.workspaceId))throw new DerivedScopeError('scope_evidence_missing')
  if(authority&&ceiling){
   await authority.execution.security.authority.assertCurrent()
   await validateCallerScopeEvidence({sources:observed},ceiling,client)
  }else{
   const fields=captured.sources.filter(source=>source.resourceKind==='application_field')
   const admitted=(await client.query<{allowed:boolean}>(`SELECT coalesce(bool_and(coalesce(
    read_admitted_application_field_snapshot($1,source.id,source.version)->>'held'='false',false)),false) AS allowed
    FROM unnest($2::uuid[],$3::text[]) source(id,version)`,[ctx.workspaceId,fields.map(source=>source.resourceId),fields.map(source=>source.version)])).rows[0]?.allowed
   if(admitted!==true)throw new DerivedScopeError('scope_source_changed')
  }
  const values=knowledgePointValues.parse(captured.values)
  if(values.id!==candidate.id)throw new DerivedScopeError('scope_evidence_missing')
  const row:KnowledgeEntry={...values,workspaceId:ctx.workspaceId,scopeVersion:captured.recordVersion,
   sensitivity:own.sensitivity,compartments:[...own.compartments],projectIds:[...own.projectIds]}
  return{rows:bindScopeSources([bindScopeSources(row,observed)],observed)}
 }
 if(!authority)return withNativeKnowledgeViewer(ctx,client=>capture(client))
 return readRetainedContextFrame(authority,sources,async client=>{
  const requested=pinAccessCeiling({...authority.execution.security.access,
    ...Object.fromEntries(Object.entries(ctx).filter(([,value])=>value!==undefined))})
  const ceiling=intersectAccessCeilings(authority.execution.security.ceiling,requested)
  await runWithAgentAccess({...authority.execution.security.access,...ceiling},()=>applyRLSGucs(client,ctx.userId))
  await validateCallerScopeEvidence({sources:[...sources]},ceiling,client)
  const result=await capture(client,ceiling)
  await validateCallerScopeEvidence({sources:[...sources,...boundScopeSources(result.rows)]},ceiling,client)
  return result
 })
}

function knowledgeRelatedPredicate(clearanceIdx:number,relatedScopeSql:string):string{
 return `ke2.id = ANY(ke.related_ids) AND ke2.workspace_id = ke.workspace_id
    AND sensitivity_rank(ke2.sensitivity) <= sensitivity_rank($${clearanceIdx}) ${relatedScopeSql}`
}

/**
 * Column list for clearance-scoped reads. Expects the table aliased as `ke`.
 * `related_ids` is replaced with a subquery that drops any id whose entry is
 * above the caller's clearance — otherwise a public-cleared caller reading a
 * public entry learns UUIDs of confidential siblings via the related array.
 *
 * `$clearanceIdx` is the 1-based parameter position of the clearance value
 * in the enclosing query.
 */
function entryColumnsClearanceScoped(clearanceIdx: number, relatedScopeSql = '', otherContributors = "'[]'::jsonb"): string {
  const relatedPredicate=knowledgeRelatedPredicate(clearanceIdx,relatedScopeSql)
  const contributors=`${knowledgeProjectedSources(relatedPredicate)} || (${otherContributors})`
  return `
    ke.id, ke.workspace_id AS "workspaceId", ${knowledgeSourceColumns('ke',contributors)},
    ke.path, ke.title, ke.summary, ke.content, ke.tags,
    COALESCE((
      SELECT array_agg(ke2.id)
      FROM knowledge_entries ke2
      WHERE ${relatedPredicate}
    ), ARRAY[]::uuid[]) AS "relatedIds",
    ke.sensitivity, ke.compartments, ke.project_ids AS "projectIds", ke.metadata,
    ke.source_id AS "sourceId", ke.source_sha AS "sourceSha",
    ke.created_by AS "createdBy", ke.created_at AS "createdAt", ke.updated_at AS "updatedAt"
  `
}

const DEFAULT_CLEARANCE: Sensitivity = 'confidential'

function contentScopeProjection(ctx: AccessContext, startIdx: number): {
  params: string[][]
  sql: (alias?: string) => string
} {
  const axes: Array<{ column: 'compartments' | 'project_ids'; cast: 'text' | 'uuid'; values: string[] }> = []
  if (ctx.compartments !== undefined && ctx.compartments !== null) {
    axes.push({ column: 'compartments', cast: 'text', values: ctx.compartments })
  }
  if (ctx.projectIds !== undefined && ctx.projectIds !== null) {
    axes.push({ column: 'project_ids', cast: 'uuid', values: ctx.projectIds })
  }
  return {
    params: axes.map((axis) => axis.values),
    sql(alias = '') {
      const prefix = alias ? `${alias}.` : ''
      return axes
        .map((axis, offset) => `AND ${prefix}${axis.column} <@ $${startIdx + offset}::${axis.cast}[]`)
        .join('\n')
    },
  }
}

/**
 * SQL fragment: the entry's source is NOT on the reading assistant's
 * per-assistant denylist (`assistant_disabled_knowledge_sources`).
 * `assistantIdx` is the 1-based position of the `assistant_id` parameter in
 * the enclosing query. Manually-created entries (`source_id IS NULL`) never
 * match the subquery, so they are always visible. Applied only on the
 * assistant consumption path (search / browse / read), never on the
 * workspace-scoped brain/graph projections or the system sync reads.
 *
 * See docs/architecture/features/knowledge-base.md → "Per-assistant source scoping".
 */
function sourceNotDisabled(assistantIdx: number, alias = 'ke'): string {
  return `NOT EXISTS (
    SELECT 1 FROM assistant_disabled_knowledge_sources adks
    WHERE adks.assistant_id = $${assistantIdx} AND adks.source_id = ${alias}.source_id
  )`
}

/**
 * Whether the per-assistant source denylist applies to this read. Primary /
 * reflector contexts (the workspace coordinator, and the brain explorer — which
 * sets `assistantKind='primary'` with a non-functional viewpoint id) span every
 * source, mirroring how the universal access predicate drops the `assistant_id`
 * partition for primary (see access-context.ts → "Primary widens"). Standard /
 * app assistants get per-assistant scoping. Skipping primary also keeps the
 * brain list (unfiltered) and the brain detail drawer (`getById`) consistent.
 */
function appliesDenylist(ctx: AccessContext): boolean {
  return ctx.assistantKind !== 'primary'
}

const SOURCE_COLUMNS = `
  id, workspace_id AS "workspaceId", source_type AS "sourceType",
  repo, branch, root_path AS "rootPath",
  last_synced_sha AS "lastSyncedSha", last_synced_at AS "lastSyncedAt",
  sync_error AS "syncError", connector_instance_id AS "connectorInstanceId",
  write_access AS "writeAccess", write_access_checked_at AS "writeAccessCheckedAt",
  default_sensitivity AS "defaultSensitivity",
  configured_by_user_id AS "configuredByUserId", binding_sensitivity AS "bindingSensitivity",
  binding_compartments AS "bindingCompartments", binding_project_ids AS "bindingProjectIds",
  sync_run_id AS "syncRunId", sync_dirty AS "syncDirty",
  binding_version::text AS "bindingVersion", binding_held AS "bindingHeld",
  created_at AS "createdAt"
` as const

// ── Store ──────────────────────────────────────────────────────

export type KnowledgeStore = {
  /** Internal worker port; captures a canonical binding before external I/O. */
  captureSourceSync(source: Pick<KnowledgeSource, 'id' | 'workspaceId' | 'sourceType' | 'repo' | 'branch' | 'rootPath' | 'connectorInstanceId' | 'lastSyncedSha'> & { bindingVersion?: string }): Promise<object | undefined>
  releaseSourceSync(authority: object): Promise<void>
  syncRequiresFullReconciliation(authority: object): boolean
  // Viewer-facing entry reads — gated by ctx (workspace + clearance).
  // `ctx.clearance === undefined` is treated as passthrough ('confidential').
  search(ctx: AccessContext, queryStr: string, limit?: number, authority?:SessionContextAuthority): Promise<KnowledgeEntry[]>
  listByPath(ctx: AccessContext, pathPrefix: string, authority?:SessionContextAuthority): Promise<KnowledgeEntry[]>
  getById(ctx: AccessContext, id: string, authority?: SessionContextAuthority): Promise<KnowledgeEntry | null>
  getByPath(ctx: AccessContext, path: string, authority?:SessionContextAuthority): Promise<KnowledgeEntry | null>
  listSummaries(ctx: AccessContext, authority?:SessionContextAuthority): Promise<Array<{ id: string; path: string; summary: string | null; sensitivity: Sensitivity; compartments: string[]; projectIds: string[] }>>
  /**
   * Brain list-view projection: id + title + path + sensitivity, capped at
   * `limit`. Empty `query` returns the most-recently-updated entries; a
   * non-empty `query` runs the same FTS as `search` so the brain `/list`
   * surface and the chat `searchKnowledge` tool agree on hits.
   */
  listForBrain(
    ctx: AccessContext,
    queryStr: string,
    limit: number,
    /**
     * Rows to skip — the knowledge arm of the Brain list's composite cursor
     * (`/api/brain/list`). Both orderings below carry an `id` tiebreaker so a
     * given offset lands on the same row every time; without it, rows tied on
     * `updated_at` (a bulk KB import) or on `ts_rank_cd` could reshuffle
     * between pages and the user would see duplicates and holes.
     */
    offset?: number,
    authority?:SessionContextAuthority,
  ): Promise<Array<{ id: string; title: string; path: string; sensitivity: Sensitivity; compartments: string[]; projectIds: string[] }>>
  /**
   * Graph-view projection: every visible knowledge entry plus its
   * clearance-scoped `relatedIds`. Powers the knowledge-as-node /
   * knowledge↔knowledge-edge layer of the brain graph. Capped at
   * `limit` rows; the graph route then merges this with the entity
   * sweep before truncating to the overall node cap.
   */
  listForGraph(
    ctx: AccessContext,
    limit: number,
    authority?:SessionContextAuthority,
  ): Promise<Array<{ id: string; title: string; path: string; sensitivity: Sensitivity; compartments: string[]; projectIds: string[]; relatedIds: string[] }>>
  /**
   * Resolve a set of entry ids to their display refs (id + title + path),
   * workspace- and clearance-scoped. Backs the brain knowledge detail's
   * `related` projection (wikilink targets in the entry reader). Order
   * follows `path` for a stable rail list.
   */
  listByIds(
    ctx: AccessContext,
    ids: string[],
    authority?:SessionContextAuthority,
  ): Promise<Array<{ id: string; title: string; path: string; sensitivity: Sensitivity; compartments: string[]; projectIds: string[] }>>
  listPaths(ctx: AccessContext, authority?:SessionContextAuthority): Promise<string[]>
  hasEntries(ctx: AccessContext, authority?:SessionContextAuthority): Promise<boolean>

  // System-level reads — privileged-service callers (sync worker,
  // audit) that bypass per-viewer projection. See permissions.md
  // § Privileged-service exception.
  getByPathSystem(workspaceId: string, path: string): Promise<KnowledgeEntry | null>
  listPathsSystem(workspaceId: string): Promise<string[]>

  create(params: {
    expectedPolicyRevision?: string
    derivation?:DerivedWriteEvidence
    workspaceId: string; path: string; title: string
    summary?: string | null; content: string; tags?: string[]; sensitivity: Sensitivity
    /** Compartment set (MLS category axis) to stamp on the row. Default '{}'. */
    compartments?: string[]
    projectIds?: string[]
    metadata?: Record<string, unknown>
    sourceId?: string | null; sourceSha?: string | null; createdBy?: string | null
    /**
     * Lifecycle-event provenance (the `knowledge` workflow event source).
     * `writtenBy: 'system'` marks an assistant-authored write, which becomes
     * `DispatchEvent.isBot` — the self-loop guard. Defaults to `user`.
     */
    writtenBy?: KnowledgeWriteActor
    /** Authenticated acting user; required in ready mode (or ambient actor). Legacy falls back to createdBy. */
    actorId?: string | null
  }, authority?:SessionContextAuthority): Promise<KnowledgeEntry>
  upsertByPath(params: {
    expectedPolicyRevision?: string
    workspaceId: string; path: string; title: string
    summary?: string | null; content: string; tags?: string[]; relatedIds?: string[]
    sensitivity: Sensitivity
    /**
     * Whether `sensitivity` came from an explicit frontmatter stamp (mig 410
     * provenance). Omitted (legacy caller) → stored as NULL = unknown,
     * treated as explicit by the default-sensitivity re-stamp walk.
     */
    sensitivityExplicit?: boolean
    /** Compartment set (MLS category axis) to stamp on the row. Default '{}'. */
    compartments?: string[]
    projectIds?: string[]
    metadata?: Record<string, unknown>; sourceId?: string | null; sourceSha?: string | null
    /**
     * Lifecycle-event provenance. The sync worker omits it (a mirrored human
     * commit is a `user` write); the assistant repo-writer's write-through
     * passes `'system'` so a KB-maintenance workflow watching this source does
     * not re-trigger on the assistant's own commit.
     */
    writtenBy?: KnowledgeWriteActor
    /** Authenticated acting user; required in ready mode (or ambient actor). */
    actorId?: string | null
  }, syncAuthority?: object): Promise<KnowledgeEntry>
  /**
   * Body-only update of a MANUAL entry (`source_id IS NULL` enforced in the
   * predicate — repo-synced entries change through the repo writer, never
   * here). Touches `content` + `updated_at` only, so tags / sensitivity /
   * compartments / related_ids survive untouched. Returns null when the id
   * doesn't resolve to a manual entry in the workspace.
   */
  updateManualEntryContent(
    workspaceId: string,
    id: string,
    content: string,
    scope?: { compartments?: string[]; projectIds?: string[]; actorId?: string; expectedPolicyRevision?: string },
  ): Promise<{ id: string; path: string } | null>
  delete(id: string): Promise<boolean>
  deleteBySource(sourceId: string): Promise<number>
  deleteByTeamAndPath(workspaceId: string, path: string, syncAuthority?: object): Promise<boolean>
  deleteByTeamAndPathPrefix(workspaceId: string, pathPrefix: string): Promise<number>
  updateRelatedIds(id: string, relatedIds: string[], syncAuthority?: object): Promise<void>
  hasEntriesForAssistant(assistantId: string): Promise<boolean>

  /**
   * Per-source entry counts for the workspace (Studio ▸ Knowledge rail).
   * `sourceId: null` = the manual pool. Sources with zero entries are absent.
   */
  countEntriesBySource(workspaceId: string): Promise<Array<{ sourceId: string | null; count: number }>>

  // Sources
  createSource(params: {
    workspaceId: string; sourceType: KnowledgeSourceType; repo: string; branch?: string; rootPath?: string
    /** The connector_instance whose PAT this source syncs through. */
    connectorInstanceId?: string | null
    binding?: KnowledgeSourceBindingInput
  }, authority?: KnowledgeConfigureAuthority): Promise<KnowledgeSource>
  getSource(id: string): Promise<KnowledgeSource | null>
  getSourceForViewer(ctx:AccessContext,id:string,authority:SessionContextAuthority):Promise<KnowledgeSourceProjection|null>
  listSources(workspaceId: string): Promise<KnowledgeSource[]>
  listSourcesForAssistant(assistantId: string): Promise<KnowledgeSource[]>
  deleteSource(id: string): Promise<boolean>
  updateSourceSync(id: string, sha: string, error?: string | null, syncAuthority?: object): Promise<void>
  /** Persist the PAT write-capability probe result (migration 310). */
  updateSourceWriteAccess(id: string, writeAccess: boolean, syncAuthority?: object): Promise<void>
  /**
   * Change a source's default sensitivity (mig 410) and reset
   * `last_synced_sha` to NULL so the next sync tick full-walks the tree —
   * re-parsing every file is the only authoritative way to re-stamp
   * non-explicit entries (legacy rows have unknown provenance, and an
   * incremental sync never revisits unchanged files). Returns the updated
   * source or null when the id is unknown.
   */
  updateSourceDefaultSensitivity(id: string, tier: Sensitivity): Promise<KnowledgeSource | null>
  getSourcesDueForSync(): Promise<KnowledgeSource[]>

  // Per-assistant source scoping (denylist). No row = source enabled for the
  // assistant. See docs/architecture/features/knowledge-base.md → "Per-assistant
  // source scoping".
  listDisabledSourceIds(assistantId: string): Promise<string[]>
  setSourceDisabled(params: {
    assistantId: string; sourceId: string; disabled: boolean; userId: string
  }): Promise<void>
}

/** The unlocked probe chooses a connection only, never authorizes a write.
 * Recheck after the workspace-first lock; activation races fail closed. */
async function knowledgeWrite<T>(workspaceId: string, actorId: string | null | undefined,
  write: (client: PoolClient, ready: boolean, actor: string) => Promise<T>, readyBlocker?: string, requireActor = false): Promise<T> {
  const probe = await query<{ ready: boolean }>("SELECT setup_state='ready' AS ready FROM workspace_access_policies WHERE workspace_id=$1", [workspaceId])
  const readyConnection = probe.rows[0]?.ready === true
  if (readyConnection && readyBlocker) throw new Error(readyBlocker)
  const actor = currentAgentAccess()?.userId ?? actorId
  if ((readyConnection || requireActor) && !actor) throw new Error('knowledge_actor_required')
  if ((readyConnection || requireActor) && currentAgentAccess()?.userId && actorId && actorId !== actor) throw new WorkspaceAccessError('context_not_available', 404)
  const client = await (readyConnection || requireActor ? getAppPool() : getPool()).connect()
  try {
    await client.query('BEGIN')
    if (readyConnection || requireActor) await applyRLSGucs(client, actor!)
    await client.query("SELECT set_config('app.knowledge_event_actor',$1,true)", [actor ?? ''])
    await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId])
    const policy = await readAdmissionPolicy(client, workspaceId)
    const ready = policy?.setupState === 'ready'
    if (ready !== readyConnection) throw new WorkspaceAccessError('access_policy_conflict', 409)
    if (ready) await client.query('SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE', [workspaceId, actor])
    const result = await write(client, ready, actor ?? '')
    await client.query('COMMIT')
    return result
  } finally { await rollbackAndRelease(client) }
}

// Legacy/status writers also lock the workspace before touching the source row.
async function sourceQuery<T extends QueryResultRow = QueryResultRow>(id: string, sql: string, values: unknown[]) {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT id FROM workspaces WHERE id=(SELECT workspace_id FROM workspace_knowledge_sources WHERE id=$1) FOR UPDATE', [id])
    const result = await client.query<T>(sql, values)
    await client.query('COMMIT')
    return result
  } finally { await rollbackAndRelease(client) }
}

async function syncMutation(authority: object, operation: string, details: Record<string, unknown>) {
  const source = knowledgeSyncCapture(authority)
  return knowledgeWrite(source.workspaceId, source.configuredByUserId, async client => {
    let path = details.path as string | undefined
    if (operation === 'related') {
      const row = (await client.query<{ path: string }>('SELECT path FROM knowledge_entries WHERE workspace_id=$1 AND id=$2', [source.workspaceId, details.targetId])).rows[0]
      if (!row) throw new Error('knowledge_source_target_conflict')
      path = row.path
    }
    const admitted = await admitKnowledgeSync(client, authority, {
      workspaceId: source.workspaceId, sourceId: source.id, sourceSha: 'status',
      path: path ?? '', title: '', content: '', sensitivity: source.bindingSensitivity ?? source.defaultSensitivity,
      compartments: source.bindingCompartments ?? [], projectIds: source.bindingProjectIds ?? [],
    })
    return client.query<KnowledgeEntry>(`SELECT ${ENTRY_COLUMNS} FROM ${source.configuredByUserId ? 'apply_knowledge_source_sync' : 'apply_knowledge_source_sync_worker'}($1::jsonb,$2::jsonb)`,
      [JSON.stringify({ ...admitted, ...details, path: path ?? '', operation }), JSON.stringify(source)])
  }, undefined, !!source.configuredByUserId)
}

export function createDbKnowledgeStore(): KnowledgeStore {
  return {
    async captureSourceSync(expected) {
      const current = (await query<KnowledgeSource>(`SELECT ${SOURCE_COLUMNS} FROM workspace_knowledge_sources WHERE workspace_id=$1 AND id=$2`, [expected.workspaceId, expected.id])).rows[0]
      if (!current) throw new Error('knowledge_source_changed')
      return knowledgeWrite(current.workspaceId, current.configuredByUserId, async client => {
        const claimed = (await client.query<KnowledgeSource>(`SELECT ${SOURCE_COLUMNS} FROM ${current.configuredByUserId ? 'claim_knowledge_source_sync' : 'claim_knowledge_source_sync_worker'}($1,$2,$3,$4::jsonb)`,
          [current.workspaceId, current.id, randomUUID(), JSON.stringify(expected)])).rows[0]
        return captureKnowledgeSyncAuthority(claimed, expected)
      }, current.configuredByUserId ? undefined : 'knowledge_source_admission_required', !!current.configuredByUserId)
    },
    syncRequiresFullReconciliation(authority) { return knowledgeSyncCapture(authority).syncDirty },
    async releaseSourceSync(authority) {
      const source = knowledgeSyncCapture(authority)
      await knowledgeWrite(source.workspaceId, source.configuredByUserId, async client => {
        await client.query(`SELECT ${source.configuredByUserId ? 'release_knowledge_source_sync' : 'release_knowledge_source_sync_worker'}($1,$2,$3)`, [source.workspaceId, source.id, source.syncRunId])
      }, undefined, !!source.configuredByUserId)
    },
    // ── Entries ──────────────────────────────────────────────

    async search(ctx, queryStr, limit = 10, authority?:SessionContextAuthority) {
      const clearance = ctx.clearance ?? DEFAULT_CLEARANCE
      const deny = appliesDenylist(ctx) ? `AND ${sourceNotDisabled(5)}` : ''
      const params: unknown[] = [ctx.workspaceId, queryStr, limit, clearance]
      if (appliesDenylist(ctx)) params.push(ctx.assistantId)
      const scope = contentScopeProjection(ctx, params.length + 1)
      params.push(...scope.params)
      const result = await queryKnowledgeCollection<KnowledgeEntry>(ctx,authority,KNOWLEDGE_FIELDS,
        `SELECT ${entryColumnsClearanceScoped(4, scope.sql('ke2'))},
                ts_rank_cd(ke.search_vector, plainto_tsquery('english', $2)) AS rank
         FROM knowledge_entries ke
         WHERE ke.workspace_id = $1
           AND ke.search_vector @@ plainto_tsquery('english', $2)
           AND sensitivity_rank(ke.sensitivity) <= sensitivity_rank($4)
           ${deny}
           ${scope.sql('ke')}
         ORDER BY rank DESC
         LIMIT $3`,
        params,
      )
      return result.rows
    },

    async listByPath(ctx, pathPrefix, authority?:SessionContextAuthority) {
      const clearance = ctx.clearance ?? DEFAULT_CLEARANCE
      // List direct children at a path with child counts for directory detection.
      // If pathPrefix is empty, list top-level entries (no '/' in path).
      // Otherwise, list entries whose path starts with pathPrefix/ and has no further '/'.
      if (!pathPrefix) {
        const denyKe = appliesDenylist(ctx) ? `AND ${sourceNotDisabled(3, 'ke')}` : ''
        const denyKe2 = appliesDenylist(ctx) ? `AND ${sourceNotDisabled(3, 'ke2')}` : ''
        const params: unknown[] = [ctx.workspaceId, clearance]
        if (appliesDenylist(ctx)) params.push(ctx.assistantId)
        const scope = contentScopeProjection(ctx, params.length + 1)
        params.push(...scope.params)
        const childPredicate=`ke2.workspace_id = ke.workspace_id AND ke2.path LIKE ke.path || '/%'
          AND sensitivity_rank(ke2.sensitivity) <= sensitivity_rank($2) ${denyKe2} ${scope.sql('ke2')}`
        const result = await queryKnowledgeCollection<KnowledgeEntry & { childCount: string }>(ctx,authority,KNOWLEDGE_FIELDS,
          `SELECT ${entryColumnsClearanceScoped(2, scope.sql('ke2'),knowledgeProjectedSources(childPredicate))},
                  (SELECT COUNT(*) FROM knowledge_entries ke2 WHERE ${childPredicate}) AS "childCount"
           FROM knowledge_entries ke
           WHERE ke.workspace_id = $1 AND ke.path NOT LIKE '%/%'
             AND sensitivity_rank(ke.sensitivity) <= sensitivity_rank($2)
             ${denyKe}
             ${scope.sql('ke')}
           ORDER BY ke.path ASC`,
          params,
        )
        return bindScopeSources(result.rows.map((r) => bindScopeSources({ ...r, childCount: Number(r.childCount) },boundScopeSources(r))),boundScopeSources(result.rows))
      }

      const prefix = pathPrefix.replace(/\/+$/, '') + '/'
      const denyKe = appliesDenylist(ctx) ? `AND ${sourceNotDisabled(4, 'ke')}` : ''
      const denyKe2 = appliesDenylist(ctx) ? `AND ${sourceNotDisabled(4, 'ke2')}` : ''
      const childParams: unknown[] = [ctx.workspaceId, prefix, clearance]
      if (appliesDenylist(ctx)) childParams.push(ctx.assistantId)
      const childScope = contentScopeProjection(ctx, childParams.length + 1)
      childParams.push(...childScope.params)
      const childPredicate=`ke2.workspace_id = ke.workspace_id AND ke2.path LIKE ke.path || '/%'
        AND sensitivity_rank(ke2.sensitivity) <= sensitivity_rank($3) ${denyKe2} ${childScope.sql('ke2')}`
      const result = await queryKnowledgeCollection<KnowledgeEntry & { childCount: string }>(ctx,authority,KNOWLEDGE_FIELDS,
        `SELECT ${entryColumnsClearanceScoped(3, childScope.sql('ke2'),knowledgeProjectedSources(childPredicate))},
                (SELECT COUNT(*) FROM knowledge_entries ke2 WHERE ${childPredicate}) AS "childCount"
         FROM knowledge_entries ke
         WHERE ke.workspace_id = $1
           AND ke.path LIKE $2 || '%'
           AND ke.path NOT LIKE $2 || '%/%'
           AND sensitivity_rank(ke.sensitivity) <= sensitivity_rank($3)
           ${denyKe}
           ${childScope.sql('ke')}
         ORDER BY ke.path ASC`,
        childParams,
      )
      const children = result.rows.map((r) => bindScopeSources({ ...r, childCount: Number(r.childCount) },boundScopeSources(r)))
      // Also include the index entry at the pathPrefix itself
      const indexParams: unknown[] = [ctx.workspaceId, pathPrefix.replace(/\/+$/, ''), clearance]
      if (appliesDenylist(ctx)) indexParams.push(ctx.assistantId)
      const indexScope = contentScopeProjection(ctx, indexParams.length + 1)
      indexParams.push(...indexScope.params)
      const indexEntry = await queryKnowledgeCollection<KnowledgeEntry>(ctx,authority,KNOWLEDGE_FIELDS,
        `SELECT ${entryColumnsClearanceScoped(3, indexScope.sql('ke2'))} FROM knowledge_entries ke
         WHERE ke.workspace_id = $1 AND ke.path = $2
           AND sensitivity_rank(ke.sensitivity) <= sensitivity_rank($3)
           ${denyKe}
           ${indexScope.sql('ke')}`,
        indexParams,
      )
      return bindScopeSources([...indexEntry.rows.map((r) => bindScopeSources({ ...r, childCount: 0 },boundScopeSources(r))), ...children],[...boundScopeSources(indexEntry.rows),...boundScopeSources(result.rows)])
    },

    async getById(ctx, id, authority) {
      const clearance = ctx.clearance ?? DEFAULT_CLEARANCE
      // Support both full UUID and prefix lookup. Workspace_id scope is
      // applied here too — a viewer in workspace A must not read entries
      // from workspace B even if they guess the ID prefix.
      const deny = appliesDenylist(ctx) ? `AND ${sourceNotDisabled(4)}` : ''
      const params: unknown[] = [id, ctx.workspaceId, clearance]
      if (appliesDenylist(ctx)) params.push(ctx.assistantId)
      const scope = contentScopeProjection(ctx, params.length + 1)
      params.push(...scope.params)
      const result = await queryKnowledgePoint(ctx,` FROM knowledge_entries ke
         WHERE ke.id::text LIKE $1 || '%'
           AND ke.workspace_id = $2
           AND sensitivity_rank(ke.sensitivity) <= sensitivity_rank($3)
           ${deny}
           ${scope.sql('ke')}
         LIMIT 1`,params,scope.sql('ke2'),authority)
      return result.rows[0] ?? null
    },

    async getByPath(ctx, path, authority?:SessionContextAuthority) {
      const clearance = ctx.clearance ?? DEFAULT_CLEARANCE
      const deny = appliesDenylist(ctx) ? `AND ${sourceNotDisabled(4)}` : ''
      const params: unknown[] = [ctx.workspaceId, path, clearance]
      if (appliesDenylist(ctx)) params.push(ctx.assistantId)
      const scope = contentScopeProjection(ctx, params.length + 1)
      params.push(...scope.params)
      const result = await queryKnowledgeCollection<KnowledgeEntry>(ctx,authority,KNOWLEDGE_FIELDS,
        `SELECT ${entryColumnsClearanceScoped(3, scope.sql('ke2'))} FROM knowledge_entries ke
         WHERE ke.workspace_id = $1 AND ke.path = $2
           AND sensitivity_rank(ke.sensitivity) <= sensitivity_rank($3)
           ${deny}
           ${scope.sql('ke')}`,
        params,
      )
      return result.rows[0] ?? null
    },

    async getByPathSystem(workspaceId, path) {
      const result = await query<KnowledgeEntry>(
        `SELECT ${ENTRY_COLUMNS} FROM knowledge_entries
         WHERE workspace_id = $1 AND path = $2`,
        [workspaceId, path],
      )
      return result.rows[0] ?? null
    },

    async create(params,authority) {
      params=structuredClone(params)
      const writeFields=['path','title','content',...(['summary','tags','metadata'] as const).filter(field=>params[field]!==undefined)]
      if(!authority&&(params.derivation||params.writtenBy==='system'))throw new DerivedScopeError('scope_evidence_missing')
      let derivedFloor:KnowledgeSourceBindingInput|undefined
      const write=async(client:PoolClient,ready:boolean,actor:string)=>{
        if(ready)params=await admitKnowledgeWrite(client,actor,params,undefined,derivedFloor)
        return client.query<KnowledgeEntry>(
          `INSERT INTO knowledge_entries
             (workspace_id, path, title, summary, content, tags, sensitivity, metadata, source_id, source_sha, created_by, compartments, project_ids)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           RETURNING ${ENTRY_COLUMNS}`,
          [
            params.workspaceId, params.path, params.title,
            params.summary ?? null, params.content, params.tags ?? [],
            params.sensitivity, JSON.stringify(params.metadata ?? {}),
            params.sourceId ?? null, params.sourceSha ?? null, params.createdBy ?? null,
            params.compartments ?? [],
            params.projectIds ?? [],
          ],
        )
      }
      const result=authority?await(async()=>{
        const {execution,accumulator}=authority
        if(!(accumulator instanceof ContextScopeAccumulator)||execution.security.access.workspaceId!==params.workspaceId
          ||params.createdBy!==execution.security.access.userId||params.actorId&&params.actorId!==execution.security.access.userId
          ||params.sourceId!=null||params.sourceSha!=null||!params.derivation)throw new DerivedScopeError('scope_evidence_missing')
        const consumed=new ContextScopeAccumulator(execution.security.provenance);consumed.note(accumulator.evidence)
        const sources=consumed.evidence.sources??[],key=(values:readonly ScopeSource[])=>JSON.stringify(values.map(source=>
          [source.resourceKind,source.resourceId,source.version,resourceScopeKey(source)]).sort())
        if(!sources.length||key(sources)!==key(params.derivation.sources))throw new DerivedScopeError('scope_evidence_missing')
        const derivation:DerivedWriteEvidence={producer:params.derivation.producer,sources}
        return writeRetainedContextFrame(authority,sources,async client=>{
          const floor=await validateDerivedWriteInputs(client,derivation,'read_entity_derivation_source')
          const derived=deriveWriteScope(derivation,{workspaceId:params.workspaceId,userId:null,assistantId:null,
            sensitivity:params.sensitivity,compartments:params.compartments??[],projectIds:params.projectIds??[]},execution.security.access.userId)
          derivedFloor={sensitivity:floor.sensitivity,compartments:floor.compartments,projectIds:floor.projectIds}
          params={...params,sensitivity:derived.sensitivity,compartments:derived.compartments,projectIds:derived.projectIds}
          const fieldsAllowed=async(id?:string,version?:string)=>(await client.query<{allowed:boolean}>(
            'SELECT native_knowledge_creation_fields_allowed($1,$2,$3,$4) AS allowed',
            [params.workspaceId,writeFields,id??null,version??null])).rows[0]?.allowed===true
          if(!await fieldsAllowed())throw new WorkspaceAccessError('access_unavailable')
          const policy=await readAdmissionPolicy(client,params.workspaceId),created=await write(client,policy?.setupState==='ready',execution.security.access.userId)
          const row=created.rows[0]
          if(!await fieldsAllowed(row.id,row.scopeVersion))throw new WorkspaceAccessError('access_unavailable')
          const root=(await client.query<{source:ScopeSource}>("SELECT read_entity_derivation_source($1,'knowledge_entry',$2) AS source",[params.workspaceId,row.id])).rows[0]?.source
          if(!root||root.resourceId!==row.id||root.version!==row.scopeVersion)throw new DerivedScopeError('scope_evidence_missing')
          await recordDerivedResource(client,derivation,root,execution.security.access.userId)
          return created
        })
      })():await knowledgeWrite(params.workspaceId,params.actorId??params.createdBy,write)
      const row=result.rows[0]
      emitLifecycle(row,'created',params.writtenBy,params.actorId??params.createdBy??null)
      if(!authority)return row
      try{
        const current=await createDbKnowledgeStore().getById(authority.execution.security.access,row.id,authority)
        if(!current)throw new DerivedScopeError('scope_source_changed')
        return current
      }catch(error){throw Object.assign(error instanceof Error?error:new Error('scope_source_changed'),{retrySafe:false,operationMayHaveExecuted:true})}
    },

    async upsertByPath(params, syncAuthority) {
      if (syncAuthority) {
        const source = knowledgeSyncCapture(syncAuthority)
        const outcome = await knowledgeWrite(params.workspaceId, source.configuredByUserId, async client => {
          const admitted = await admitKnowledgeSync(client, syncAuthority, params)
          const existed = (await client.query('SELECT id FROM knowledge_entries WHERE workspace_id=$1 AND path=$2', [params.workspaceId,params.path])).rows.length > 0
          const result = await client.query<KnowledgeEntry>(`SELECT ${ENTRY_COLUMNS} FROM ${source.configuredByUserId ? 'apply_knowledge_source_sync' : 'apply_knowledge_source_sync_worker'}($1::jsonb,$2::jsonb)`,
            [JSON.stringify(admitted), JSON.stringify(source)])
          return { row:result.rows[0], existed }
        }, undefined, !!source.configuredByUserId)
        emitLifecycle(outcome.row, outcome.existed ? 'updated' : 'created', params.writtenBy, params.actorId ?? source.configuredByUserId)
        return outcome.row
      }
      if (params.sourceId != null) throw new Error('knowledge_sync_authority_required')
      // `xmax = 0` is the standard upsert discriminator: a row inserted by
      // THIS statement has no updating transaction stamped on it, so the
      // predicate separates a create from an update without a second read.
      // Needed for the lifecycle action — the sync worker calls this for both.
      const result = await knowledgeWrite(params.workspaceId, params.actorId, async (client, ready, actor) => {
        if (ready) {
          const prior = await lockKnowledgePrior(client, params.workspaceId, params.path)
          params = await admitKnowledgeWrite(client, actor, params, prior)
        }
        return client.query<KnowledgeEntry & { __inserted: boolean }>(
          `INSERT INTO knowledge_entries
             (workspace_id, path, title, summary, content, tags, related_ids, sensitivity, sensitivity_explicit, metadata, source_id, source_sha, compartments, project_ids)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                   COALESCE($13::text[], ARRAY[]::text[]),
                   COALESCE($14::uuid[], ARRAY[]::uuid[]))
           ON CONFLICT (workspace_id, path) DO UPDATE SET
             title = EXCLUDED.title,
             summary = EXCLUDED.summary,
             content = EXCLUDED.content,
             tags = EXCLUDED.tags,
             related_ids = COALESCE(EXCLUDED.related_ids, knowledge_entries.related_ids),
             sensitivity = EXCLUDED.sensitivity,
             sensitivity_explicit = EXCLUDED.sensitivity_explicit,
             metadata = EXCLUDED.metadata,
             source_id = EXCLUDED.source_id,
             source_sha = EXCLUDED.source_sha,
             compartments = CASE WHEN $13::text[] IS NULL THEN knowledge_entries.compartments ELSE ARRAY(
               SELECT DISTINCT unnest(knowledge_entries.compartments || EXCLUDED.compartments) ORDER BY 1
             ) END,
             project_ids = CASE WHEN $14::uuid[] IS NULL THEN knowledge_entries.project_ids ELSE ARRAY(
               SELECT DISTINCT unnest(knowledge_entries.project_ids || EXCLUDED.project_ids) ORDER BY 1
             ) END
           RETURNING ${ENTRY_COLUMNS}, (xmax = 0) AS "__inserted"`,
          [
            params.workspaceId, params.path, params.title,
            params.summary ?? null, params.content, params.tags ?? [],
            params.relatedIds ?? [], params.sensitivity, params.sensitivityExplicit ?? null,
            JSON.stringify(params.metadata ?? {}),
            params.sourceId ?? null, params.sourceSha ?? null,
            params.compartments ?? null,
            params.projectIds ?? null,
          ],
        )
      })
      const { __inserted, ...row } = result.rows[0]
      emitLifecycle(
        row,
        __inserted ? 'created' : 'updated',
        params.writtenBy,
        params.actorId ?? null,
      )
      return row
    },

    async updateManualEntryContent(workspaceId, id, content, scope = {}) {
      const result = await knowledgeWrite(workspaceId, scope.actorId, async (client, ready, actor) => {
        if (ready) {
          const prior = await lockKnowledgePrior(client, workspaceId, id, true)
          if (!prior) throw new WorkspaceAccessError('context_not_available', 404)
          scope = { ...scope, ...await admitKnowledgeWrite(client, actor, { ...scope, workspaceId, sensitivity: prior.sensitivity }, prior) }
        }
        return client.query<
          Pick<KnowledgeEntry, 'id' | 'path' | 'title' | 'tags' | 'sensitivity' | 'sourceId' | 'scopeVersion'>
        >(
          `UPDATE knowledge_entries
           SET content = $1,
               compartments = ARRAY(SELECT DISTINCT unnest(compartments || $4::text[]) ORDER BY 1),
               project_ids = ARRAY(SELECT DISTINCT unnest(project_ids || $5::uuid[]) ORDER BY 1),
               updated_at = now()
           WHERE id = $2 AND workspace_id = $3 AND source_id IS NULL
           RETURNING id, path, title, tags, sensitivity, source_id AS "sourceId", scope_version::text AS "scopeVersion"`,
          [content, id, workspaceId, scope.compartments ?? [], scope.projectIds ?? []],
        )
      })
      const row = result.rows[0]
      if (!row) return null
      publishKnowledgeLifecycle({
        workspaceId,
        entryId: row.id,
        ...(row.scopeVersion ? { sourceVersion: row.scopeVersion } : {}),
        action: 'updated',
        path: row.path,
        title: row.title,
        tags: row.tags ?? [],
        sensitivity: row.sensitivity,
        sourceId: row.sourceId ?? null,
        actorId: null,
        // Sole caller is the assistant's `updateKnowledgeEntry` tool (manual
        // mode) — `system` by construction, so a KB-maintenance workflow does
        // not re-trigger on its own manual-entry edits.
        writtenBy: 'system',
      })
      return { id: row.id, path: row.path }
    },

    async delete(id) {
      const result = await query(
        `DELETE FROM knowledge_entries WHERE id = $1`,
        [id],
      )
      return (result.rowCount ?? 0) > 0
    },

    async deleteBySource(sourceId) {
      const result = await query(
        `DELETE FROM knowledge_entries WHERE source_id = $1`,
        [sourceId],
      )
      return result.rowCount ?? 0
    },

    async deleteByTeamAndPath(workspaceId, path, syncAuthority) {
      if (syncAuthority) {
        if (knowledgeSyncCapture(syncAuthority).workspaceId !== workspaceId) throw new Error('knowledge_source_changed')
        const row = (await syncMutation(syncAuthority, 'delete', { path })).rows[0]
        if (row) emitLifecycle(row, 'deleted', 'user', null)
        return !!row
      }
      throw new Error('knowledge_sync_authority_required')
    },

    async deleteByTeamAndPathPrefix(workspaceId, pathPrefix) {
      const result = await query(
        `DELETE FROM knowledge_entries
         WHERE workspace_id = $1 AND path LIKE $2 || '%'`,
        [workspaceId, pathPrefix],
      )
      return result.rowCount ?? 0
    },

    async updateRelatedIds(id, relatedIds, syncAuthority) {
      if (syncAuthority) { await syncMutation(syncAuthority, 'related', { targetId: id, relatedIds }); return }
      throw new Error('knowledge_sync_authority_required')
    },

    async listSummaries(ctx, authority?:SessionContextAuthority) {
      const clearance = ctx.clearance ?? DEFAULT_CLEARANCE
      const params: unknown[] = [ctx.workspaceId, clearance]
      const scope = contentScopeProjection(ctx, 3)
      params.push(...scope.params)
      const result = await queryKnowledgeCollection<{ id: string; path: string; summary: string | null; sensitivity: Sensitivity; compartments: string[]; projectIds: string[] }>(ctx,authority,['id','path','summary'],
        `SELECT ${knowledgeSourceColumns()}, id, path, summary, sensitivity, compartments, project_ids AS "projectIds" FROM knowledge_entries
         WHERE workspace_id = $1
           AND sensitivity_rank(sensitivity) <= sensitivity_rank($2)
           ${scope.sql()}
         ORDER BY path ASC`,
        params,
      )
      return result.rows
    },

    async listForBrain(ctx, queryStr, limit, offset = 0, authority?:SessionContextAuthority) {
      const clearance = ctx.clearance ?? DEFAULT_CLEARANCE
      const trimmed = queryStr.trim()
      const skip = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0
      if (trimmed.length === 0) {
        const params: unknown[] = [ctx.workspaceId, clearance, limit, skip]
        const scope = contentScopeProjection(ctx, 5)
        params.push(...scope.params)
        const result = await queryKnowledgeCollection<{ id: string; title: string; path: string; sensitivity: Sensitivity; compartments: string[]; projectIds: string[] }>(ctx,authority,trimmed?['id','title','path','summary','content','tags']:['id','title','path','updatedAt'],
          `SELECT ${knowledgeSourceColumns()}, id, title, path, sensitivity, compartments, project_ids AS "projectIds" FROM knowledge_entries
           WHERE workspace_id = $1
             AND sensitivity_rank(sensitivity) <= sensitivity_rank($2)
             ${scope.sql()}
           ORDER BY updated_at DESC, id
           LIMIT $3 OFFSET $4`,
          params,
        )
        return result.rows
      }
      const params: unknown[] = [ctx.workspaceId, trimmed, clearance, limit, skip]
      const scope = contentScopeProjection(ctx, 6)
      params.push(...scope.params)
      const result = await queryKnowledgeCollection<{ id: string; title: string; path: string; sensitivity: Sensitivity; compartments: string[]; projectIds: string[] }>(ctx,authority,trimmed?['id','title','path','summary','content','tags']:['id','title','path','updatedAt'],
        `SELECT ${knowledgeSourceColumns()}, id, title, path, sensitivity, compartments, project_ids AS "projectIds" FROM knowledge_entries
         WHERE workspace_id = $1
           AND search_vector @@ plainto_tsquery('english', $2)
           AND sensitivity_rank(sensitivity) <= sensitivity_rank($3)
           ${scope.sql()}
         ORDER BY ts_rank_cd(search_vector, plainto_tsquery('english', $2)) DESC, id
         LIMIT $4 OFFSET $5`,
        params,
      )
      return result.rows
    },

    async listForGraph(ctx, limit, authority?:SessionContextAuthority) {
      const clearance = ctx.clearance ?? DEFAULT_CLEARANCE
      const params: unknown[] = [ctx.workspaceId, clearance, limit]
      const scope = contentScopeProjection(ctx, 4)
      params.push(...scope.params)
      const relatedPredicate=`ke2.id = ANY(ke.related_ids) AND ke2.workspace_id = ke.workspace_id
        AND sensitivity_rank(ke2.sensitivity) <= sensitivity_rank($2) ${scope.sql('ke2')}`
      const result = await queryKnowledgeCollection<{
        id: string
        title: string
        path: string
        sensitivity: Sensitivity
        compartments: string[]
        projectIds: string[]
        relatedIds: string[]
      }>(ctx,authority,['id','title','path','relatedIds','updatedAt'],
        `SELECT
           ${knowledgeSourceColumns('ke',knowledgeProjectedSources(relatedPredicate))}, ke.id, ke.title, ke.path, ke.sensitivity, ke.compartments,
           ke.project_ids AS "projectIds",
           COALESCE((
             SELECT array_agg(ke2.id)
             FROM knowledge_entries ke2
             WHERE ${relatedPredicate}
           ), ARRAY[]::uuid[]) AS "relatedIds"
         FROM knowledge_entries ke
         WHERE ke.workspace_id = $1
           AND sensitivity_rank(ke.sensitivity) <= sensitivity_rank($2)
           ${scope.sql('ke')}
         ORDER BY ke.updated_at DESC
         LIMIT $3`,
        params,
      )
      return result.rows
    },

    async listByIds(ctx, ids, authority?:SessionContextAuthority) {
      if (ids.length === 0) return []
      const clearance = ctx.clearance ?? DEFAULT_CLEARANCE
      const params: unknown[] = [ctx.workspaceId, ids, clearance]
      const scope = contentScopeProjection(ctx, 4)
      params.push(...scope.params)
      const result = await queryKnowledgeCollection<{ id: string; title: string; path: string; sensitivity: Sensitivity; compartments: string[]; projectIds: string[] }>(ctx,authority,['id','title','path'],
        `SELECT ${knowledgeSourceColumns()}, id, title, path, sensitivity, compartments, project_ids AS "projectIds" FROM knowledge_entries
         WHERE workspace_id = $1
           AND id = ANY($2::uuid[])
           AND sensitivity_rank(sensitivity) <= sensitivity_rank($3)
           ${scope.sql()}
         ORDER BY path ASC`,
        params,
      )
      return result.rows
    },

    async listPaths(ctx, authority?:SessionContextAuthority) {
      const clearance = ctx.clearance ?? DEFAULT_CLEARANCE
      const params: unknown[] = [ctx.workspaceId, clearance]
      const scope = contentScopeProjection(ctx, 3)
      params.push(...scope.params)
      const result = await queryKnowledgeCollection<{ path: string }>(ctx,authority,['path'],
        `SELECT ${knowledgeSourceColumns()}, path FROM knowledge_entries
         WHERE workspace_id = $1
           AND sensitivity_rank(sensitivity) <= sensitivity_rank($2)
           ${scope.sql()}
         ORDER BY path ASC`,
        params,
      )
      return bindScopeSources(result.rows.map((r) => r.path),boundScopeSources(result.rows))
    },

    async listPathsSystem(workspaceId) {
      const result = await query<{ path: string }>(
        `SELECT path FROM knowledge_entries
         WHERE workspace_id = $1
         ORDER BY path ASC`,
        [workspaceId],
      )
      return result.rows.map((r) => r.path)
    },

    async hasEntries(ctx, authority?:SessionContextAuthority) {
      const clearance = ctx.clearance ?? DEFAULT_CLEARANCE
      const params: unknown[] = [ctx.workspaceId, clearance]
      const scope = contentScopeProjection(ctx, 3)
      params.push(...scope.params)
      const result = await queryKnowledgeCollection<{ exists: boolean }>(ctx,authority,[],
        `SELECT EXISTS(
           SELECT 1 FROM knowledge_entries
           WHERE workspace_id = $1
             AND sensitivity_rank(sensitivity) <= sensitivity_rank($2)
             ${scope.sql()}
         ) AS exists`,
        params, false,
      )
      return result.rows[0]?.exists ?? false
    },

    async hasEntriesForAssistant(assistantId) {
      const result = await query<{ exists: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM knowledge_entries ke
           JOIN assistants a ON a.workspace_id = ke.workspace_id
           WHERE a.id = $1
         ) AS exists`,
        [assistantId],
      )
      return result.rows[0]?.exists ?? false
    },

    // ── Sources ─────────────────────────────────────────────

    async countEntriesBySource(workspaceId) {
      const result = await query<{ sourceId: string | null; count: string }>(
        `SELECT source_id AS "sourceId", COUNT(*) AS count
         FROM knowledge_entries
         WHERE workspace_id = $1
         GROUP BY source_id`,
        [workspaceId],
      )
      return result.rows.map((r) => ({ sourceId: r.sourceId, count: Number(r.count) }))
    },

    async createSource(params, authority) {
      if (params.binding && !authority?.actorUserId) throw new Error('knowledge_source_admission_required')
      const result = await knowledgeWrite(params.workspaceId, authority?.actorUserId, async (client, ready) => {
        if (ready && (!params.binding || !authority?.actorUserId)) throw new Error('knowledge_source_admission_required')
        const binding = params.binding && authority
          ? await admitKnowledgeSourceConfiguration(client, params.workspaceId, authority, params.binding) : undefined
        return client.query<KnowledgeSource>(
          `INSERT INTO workspace_knowledge_sources
             (workspace_id, source_type, repo, branch, root_path, connector_instance_id,
              configured_by_user_id,binding_sensitivity,binding_compartments,binding_project_ids,default_sensitivity)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($8,'internal'))
           RETURNING ${SOURCE_COLUMNS}`,
          [params.workspaceId, params.sourceType, params.repo, params.branch ?? 'main', params.rootPath ?? '', params.connectorInstanceId ?? null,
            binding ? authority!.actorUserId : null, binding?.sensitivity ?? null, binding?.compartments ?? null, binding?.projectIds ?? null],
        )
      }, params.binding && authority ? undefined : 'knowledge_source_admission_required', !!authority)
      return result.rows[0]
    },

    getSourceForViewer:readNativeKnowledgeSource,

    async getSource(id) {
      const result = await query<KnowledgeSource>(
        `SELECT ${SOURCE_COLUMNS} FROM workspace_knowledge_sources WHERE id = $1`,
        [id],
      )
      return result.rows[0] ?? null
    },

    async listSources(workspaceId) {
      const result = await query<KnowledgeSource>(
        `SELECT ${SOURCE_COLUMNS} FROM workspace_knowledge_sources
         WHERE workspace_id = $1 ORDER BY created_at DESC`,
        [workspaceId],
      )
      return result.rows
    },

    async listSourcesForAssistant(assistantId) {
      const result = await query<KnowledgeSource>(
        `SELECT ${SOURCE_COLUMNS} FROM workspace_knowledge_sources
         WHERE workspace_id = (SELECT workspace_id FROM assistants WHERE id = $1)
         ORDER BY created_at DESC`,
        [assistantId],
      )
      return result.rows
    },

    async deleteSource(id) {
      const result = await sourceQuery(id,
        `DELETE FROM workspace_knowledge_sources WHERE id = $1`,
        [id],
      )
      return (result.rowCount ?? 0) > 0
    },

    async updateSourceSync(id, sha, error = null, syncAuthority) {
      if (syncAuthority) {
        if (knowledgeSyncCapture(syncAuthority).id !== id) throw new Error('knowledge_source_changed')
        await syncMutation(syncAuthority, error === null ? 'checkpoint' : 'error', { sourceSha: sha || 'status', error }); return
      }
      const result = await sourceQuery(id,
        `UPDATE workspace_knowledge_sources
         SET last_synced_sha = CASE WHEN $2::text IS NULL THEN $1 ELSE last_synced_sha END, last_synced_at = now(), sync_error = $2
         WHERE id = $3 AND configured_by_user_id IS NULL AND sync_run_id IS NULL
           AND NOT EXISTS(SELECT 1 FROM workspace_access_policies p WHERE p.workspace_id=workspace_knowledge_sources.workspace_id AND p.setup_state<>'legacy')`,
        [sha, error, id],
      )
      if (!result.rowCount) throw new Error('knowledge_sync_authority_required')
    },

    async updateSourceWriteAccess(id, writeAccess, syncAuthority) {
      if (syncAuthority) {
        if (knowledgeSyncCapture(syncAuthority).id !== id) throw new Error('knowledge_source_changed')
        await syncMutation(syncAuthority, 'probe', { writeAccess }); return
      }
      const result = await sourceQuery(id,
        `UPDATE workspace_knowledge_sources
         SET write_access = $1, write_access_checked_at = now()
         WHERE id = $2 AND configured_by_user_id IS NULL AND sync_run_id IS NULL
           AND NOT EXISTS(SELECT 1 FROM workspace_access_policies p WHERE p.workspace_id=workspace_knowledge_sources.workspace_id AND p.setup_state<>'legacy')`,
        [writeAccess, id],
      )
      if (!result.rowCount) throw new Error('knowledge_sync_authority_required')
    },

    async updateSourceDefaultSensitivity(id, tier) {
      const result = await sourceQuery<KnowledgeSource>(id,
        `UPDATE workspace_knowledge_sources
         SET default_sensitivity = $1, last_synced_sha = NULL
         WHERE id = $2
         RETURNING ${SOURCE_COLUMNS}`,
        [tier, id],
      )
      return result.rows[0] ?? null
    },

    async getSourcesDueForSync() {
      // Return all sources. The caller (sync worker) decides if sync is needed
      // by comparing HEAD SHA with last_synced_sha.
      const result = await query<KnowledgeSource>(
        `SELECT ${SOURCE_COLUMNS}
         FROM workspace_knowledge_sources
         ORDER BY created_at ASC`,
      )
      return result.rows
    },

    // ── Per-assistant source scoping (denylist) ──────────────

    async listDisabledSourceIds(assistantId) {
      const result = await query<{ source_id: string }>(
        `SELECT source_id FROM assistant_disabled_knowledge_sources WHERE assistant_id = $1`,
        [assistantId],
      )
      return result.rows.map((r) => r.source_id)
    },

    async setSourceDisabled({ assistantId, sourceId, disabled, userId }) {
      if (disabled) {
        await query(
          `INSERT INTO assistant_disabled_knowledge_sources (assistant_id, source_id, disabled_by_user_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (assistant_id, source_id) DO NOTHING`,
          [assistantId, sourceId, userId],
        )
      } else {
        await query(
          `DELETE FROM assistant_disabled_knowledge_sources WHERE assistant_id = $1 AND source_id = $2`,
          [assistantId, sourceId],
        )
      }
    },
  }
}
