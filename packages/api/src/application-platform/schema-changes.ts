/** Saved generic schema reviews over canonical rows. [COMP:api/application-records] */
import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { propertyDefSchema, validateDocApplicationSchema, validateDocApplicationValues,
  type CellValue, type ExecutionContext, type PropertyDef } from '@use-brian/core'
import { ApplicationPlatformError } from '@use-brian/shared'
import { createDbDocEntityStore } from '../db/doc-entity-store.js'

function actorKey(execution:ExecutionContext) {
  return createHash('sha256').update(JSON.stringify({identity:execution.identity,assistant:execution.assistant})).digest('hex')
}
async function governanceRevision(client:PoolClient,execution:ExecutionContext,typeId:string) {
  const result=await client.query<{ revision: string }>('SELECT application_schema_governance_revision($1,$2,$3) AS revision',
    [execution.security.access.workspaceId,typeId,execution.assistant.id])
  if (!/^[0-9a-f]{64}$/.test(result.rows[0]?.revision ?? '')) throw new ApplicationPlatformError('access_unavailable','The schema governance is unavailable.')
  return result.rows[0].revision
}
async function scan(client:PoolClient,workspaceId:string,typeId:string,properties:PropertyDef[]) {
  const hash=createHash('sha256'),ids:string[]=[]
  let cursor:string|undefined,records=0,invalid=0
  for(;;) {
    const result=await client.query<{id:string;record_version:string;data:Record<string,CellValue>}>(`SELECT id,record_version::text,data FROM entity_instances
      WHERE workspace_id=$1 AND entity_type_id=$2 AND ($3::uuid IS NULL OR id>$3::uuid) ORDER BY id LIMIT 100 FOR SHARE`,[workspaceId,typeId,cursor??null])
    for(const row of result.rows) {
      ids.push(row.id);records+=1;hash.update(`${row.id}:${row.record_version}\n`)
      try {validateDocApplicationValues(properties,row.data,row.data)}catch {invalid+=1}
    }
    if(result.rows.length<100)break
    cursor=result.rows[result.rows.length-1].id
  }
  const visible=await client.query<{admitted:boolean}>('SELECT application_generic_schema_rows_visible($1,$2,$3) AS admitted',[typeId,workspaceId,ids])
  if(visible.rows[0]?.admitted!==true)throw new ApplicationPlatformError('access_unavailable','Schema review requires current access to every affected record.')
  return {hash:hash.digest('hex'),records,invalid}
}
export async function previewApplicationSchema(client:PoolClient,execution:ExecutionContext,typeId:string,expectedVersion:number,rawProperties:PropertyDef[]) {
  const properties=rawProperties.map(property=>propertyDefSchema.parse(property));validateDocApplicationSchema(properties)
  const {workspaceId,userId}=execution.security.access
  await client.query('SELECT id FROM entity_types WHERE id=$1 AND workspace_id=$2 FOR SHARE',[typeId,workspaceId])
  const authorityRevision=await governanceRevision(client,execution,typeId)
  const canonical=createDbDocEntityStore({actorUserId:userId,transaction:client}),schema=await canonical.getEntityType(workspaceId,typeId)
  if(!schema)throw new ApplicationPlatformError('access_unavailable','The schema is unavailable.')
  if(schema.schemaVersion!==expectedVersion)throw new ApplicationPlatformError('schema_version_conflict','The schema changed. Refresh the preview.')
  const state=await scan(client,workspaceId,typeId,properties),id=randomUUID()
  await client.query(`INSERT INTO application_schema_change_reviews
    (id,workspace_id,entity_type_id,actor_user_id,actor_key,expected_schema_version,proposed_properties,record_set_hash,invalid_records,review_assistant_id,reviewed_authority_revision)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[id,workspaceId,typeId,userId,actorKey(execution),expectedVersion,JSON.stringify(properties),state.hash,state.invalid,execution.assistant.id,authorityRevision])
  return {id,entityTypeId:typeId,expectedSchemaVersion:expectedVersion,before:schema.properties,proposed:properties,
    affectedRecords:state.records,invalidRecords:state.invalid,canApply:state.invalid===0}
}
export async function applyApplicationSchema(client:PoolClient,execution:ExecutionContext,previewId:string) {
  const {workspaceId,userId}=execution.security.access
  const result=await client.query<{entity_type_id:string;expected_schema_version:number;proposed_properties:PropertyDef[];record_set_hash:string;invalid_records:number;applied_version:number|null;expired:boolean;review_assistant_id:string|null;reviewed_authority_revision:string|null;applied_authority_revision:string|null}>(
    `SELECT *,expires_at<=now() AS expired FROM application_schema_change_reviews
      WHERE id=$1 AND workspace_id=$2 AND actor_user_id=$3 AND actor_key=$4 FOR UPDATE`,[previewId,workspaceId,userId,actorKey(execution)])
  const review=result.rows[0]
  if(!review)throw new ApplicationPlatformError('access_unavailable','The schema review is unavailable.')
  const canonical=createDbDocEntityStore({actorUserId:userId,transaction:client})
  await client.query('SELECT id FROM entity_types WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[review.entity_type_id,workspaceId])
  const authorityRevision=await governanceRevision(client,execution,review.entity_type_id)
  if(review.review_assistant_id!==execution.assistant.id || !(review.applied_version===null ? review.reviewed_authority_revision : review.applied_authority_revision)
    || authorityRevision!==(review.applied_version===null ? review.reviewed_authority_revision : review.applied_authority_revision)) {
    throw new ApplicationPlatformError('schema_version_conflict','The reviewed authority changed. Refresh the preview.')
  }
  const schema=await canonical.getEntityType(workspaceId,review.entity_type_id)
  if(!schema)throw new ApplicationPlatformError('access_unavailable','The schema is unavailable.')
  if(review.applied_version!==null)return {entityTypeId:schema.id,schemaVersion:review.applied_version,applied:true}
  if(review.expired||schema.schemaVersion!==review.expected_schema_version)throw new ApplicationPlatformError('schema_version_conflict','The review expired or the schema changed. Refresh the preview.')
  const current=await scan(client,workspaceId,schema.id,review.proposed_properties)
  if(current.hash!==review.record_set_hash)throw new ApplicationPlatformError('schema_version_conflict','Affected records changed. Refresh the preview.')
  if(review.invalid_records||current.invalid)throw new ApplicationPlatformError('invalid_value','Existing values require authorized repair before this schema can apply.')
  const applied=await canonical.updateEntityType(workspaceId,schema.id,{properties:review.proposed_properties},{actorUserId:userId,expectedSchemaVersion:review.expected_schema_version})
  await client.query('SELECT application_finish_schema_review($1,$2)',[previewId,applied.schemaVersion])
  return {entityTypeId:applied.id,schemaVersion:applied.schemaVersion,applied:true}
}
