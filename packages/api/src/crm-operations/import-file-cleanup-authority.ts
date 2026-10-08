/** Current and saved departmental admission for reviewed cleanup. [COMP:crm/file-cleanup] */
import type {PoolClient} from 'pg'
import {CrmOperationsError,deriveResourceScope,resourceScopeKey,type CrmOperationsContext,type ResourceScope,type ScopeSource} from '@use-brian/core'
import {getPool} from '../db/client.js'
import {assertAssociationSourceAuthority} from '../association/source-scope.js'

export async function renewCrmFileCleanupAuthority(context:CrmOperationsContext,scope:ResourceScope|null):Promise<void> {
  if(!scope)return
  if(context.actor.kind!=='user')throw new CrmOperationsError('not_authorized','A department-bound member is required.')
  await assertAssociationSourceAuthority(getPool(),context.workspaceId,
    {credentialKind:'user',credentialId:context.actor.userId,actingUserId:context.actor.userId},{scope,sources:[]})
}
export async function readCrmFileCleanupAuthority(client:PoolClient,context:CrmOperationsContext,fileId:string,
  saved?:ResourceScope|null,queued=false):Promise<ResourceScope|null> {
  const v2=(await client.query('SELECT department_read_v2 FROM workspaces WHERE id=$1',[context.workspaceId])).rows[0]?.department_read_v2
  if(v2===false)return null
  if(context.actor.kind!=='user'||saved===null)throw new CrmOperationsError('not_authorized','The cleanup source scope is unavailable.')
  const actor={credentialKind:'user' as const,credentialId:context.actor.userId,actingUserId:context.actor.userId}
  if(saved)await assertAssociationSourceAuthority(client,context.workspaceId,actor,{scope:saved,sources:[]})
  if(queued){if(!saved)throw new CrmOperationsError('not_authorized','The cleanup receipt scope is unavailable.');return saved}
  const read=async(kind:string,id:string)=>{
    const source=(await client.query<{source:(ScopeSource&{held:boolean})|null}>(
      'SELECT read_scope_review_source($1,$2,$3) AS source',[context.workspaceId,kind,id])).rows[0]?.source
    if(!source||source.held!==false)throw new CrmOperationsError('not_authorized','The cleanup source scope is unavailable.')
    await assertAssociationSourceAuthority(client,context.workspaceId,actor,{scope:source,sources:[]})
    return source
  }
  const file=await read('workspace_file',fileId)
  let scope=deriveResourceScope({producer:'crm.file-cleanup',sources:[file]})
  let after:string|null=null
  for(;;) {
    const page:{rows:Array<{id:string}>}=await client.query(`SELECT DISTINCT r.entity_id AS id FROM crm_import_rows r
      JOIN crm_import_jobs j ON j.id=r.job_id AND j.workspace_id=r.workspace_id
      WHERE j.workspace_id=$1 AND j.staged_file_id=$2 AND r.entity_id IS NOT NULL
      AND ($3::uuid IS NULL OR r.entity_id>$3) ORDER BY r.entity_id LIMIT 256`,[context.workspaceId,fileId,after])
    for(const {id} of page.rows)scope=deriveResourceScope({producer:'crm.file-cleanup',sources:[
      {...scope,resourceKind:'cleanup-floor',resourceId:fileId,version:'current'},await read('entity',id),
    ]})
    if(page.rows.length<256)break
    after=page.rows.at(-1)!.id
  }
  if(saved&&resourceScopeKey(scope)!==resourceScopeKey(saved))throw new CrmOperationsError('conflict','Review the current source file before proceeding.',{reason:'file_cleanup_preview_stale'})
  return scope
}
