/** Snapshot-consistent streamed CRM exports. [COMP:crm/privacy-export] */
import {createHash,randomUUID} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import type {Response} from 'express'
import {once} from 'node:events'
import {CrmOperationsContextSchema,CrmOperationsUuidSchema,CrmOperationsError,requireCrmIntegrationOperation,type CrmOperationsContext,type ResourceScope} from '@use-brian/core'
import {getPool} from '../db/client.js'
import {readCrmIntegrationCredential} from '../db/crm-integration-store.js'
import {prepareCrmSuppressionPrivacy} from './suppression-tombstones.js'
import {prepareCrmPrivacyCopies} from './privacy-copy-resolver.js'
import {CRM_PRIVACY_COVERAGE,crmPrivacyClassification,crmPrivacyDomainSql,type CrmPrivacyScope} from './privacy-coverage.js'
import {assertCrmPrivacySubjectAuthority,assertCrmPrivacyWorkspaceAuthority,crmPrivacySourceActor} from './privacy-subject-authority.js'
import {assertAssociationSourceAuthority} from '../association/source-scope.js'

export type CrmPrivacyExportOptions = {contactId?:string;signal?:AbortSignal}
const failure=(reason:string,domain?:string)=>new CrmOperationsError('conflict','CRM privacy export could not be completed.',{reason,...(domain?{domain}:{})})
function checkAbort(signal?:AbortSignal):void {
  if(signal?.aborted)throw failure('privacy_export_cancelled')
}
async function authorize(client:Pool|PoolClient,context:CrmOperationsContext):Promise<void> {
  if(context.actor.kind==='user') {
    if(!context.authority.canConfigure || !['owner','admin'].includes(context.authority.role))throw new CrmOperationsError('not_authorized','Privacy export requires owner/admin session authority.')
    const row=await client.query("SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2",[context.workspaceId,context.actor.userId])
    if(!['owner','admin'].includes(row.rows[0]?.role))throw new CrmOperationsError('not_authorized','A current workspace owner or admin is required for CRM privacy export.')
    return
  }
  if(context.actor.kind==='integration_key' && context.authority.integration?.credentialId===context.actor.credentialId) {
    requireCrmIntegrationOperation(context.authority.integration,'crm.privacy.export')
    const current=await readCrmIntegrationCredential(client,context.workspaceId,context.actor.credentialId)
    requireCrmIntegrationOperation(current,'crm.privacy.export')
    return
  }
  throw new CrmOperationsError('not_authorized','This principal has no CRM privacy-export authority.')
}

/** Consumers must verify the final manifest; interrupted output is not an export. */
export async function* streamCrmPrivacyExport(rawContext:CrmOperationsContext,options:CrmPrivacyExportOptions={}):AsyncGenerator<string> {
  const context=CrmOperationsContextSchema.parse(rawContext)
  const contactId=options.contactId ? CrmOperationsUuidSchema.parse(options.contactId):null
  const scope:CrmPrivacyScope=contactId?'contact':'workspace'
  checkAbort(options.signal)
  const client=await getPool().connect()
  let domain:string|undefined,transactionOpen=false
  let subjectScope:ResourceScope|null=null
  const renewSubject=async()=>{
    await authorize(getPool(),context)
    if(subjectScope)await assertAssociationSourceAuthority(getPool(),context.workspaceId,
      crmPrivacySourceActor(context),{scope:subjectScope,sources:[]})
  }
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    transactionOpen=true
    await client.query("SET LOCAL statement_timeout='30s'")
    await authorize(getPool(),context)
    if(contactId) {
      const person=await client.query("SELECT id FROM entities WHERE workspace_id=$1 AND id=$2 AND kind='person'",[context.workspaceId,contactId])
      if(!person.rowCount)throw new CrmOperationsError('not_found','The CRM contact is unavailable.')
      const v2=(await client.query('SELECT department_read_v2 FROM workspaces WHERE id=$1',[context.workspaceId])).rows[0]?.department_read_v2
      if(context.actor.kind==='user'||v2!==false)subjectScope=await assertCrmPrivacySubjectAuthority(client,context,contactId)
      await prepareCrmSuppressionPrivacy(client,context.workspaceId,contactId)
    }else subjectScope=await assertCrmPrivacyWorkspaceAuthority(client,context)
    await prepareCrmPrivacyCopies(client,context.workspaceId,contactId)
    const stamp=(await client.query<{snapshotAt:Date}>('SELECT transaction_timestamp() AS "snapshotAt"')).rows[0]!
    const exportId=randomUUID(),aggregate=createHash('sha256'),coverage=[]
    let total=0
    await renewSubject()
    yield JSON.stringify({type:'header',schema:'crm-privacy-v2',exportId,workspaceId:context.workspaceId,scope,contactId,
      snapshotAt:stamp.snapshotAt.toISOString(),checksum:'sha256-utf8-record-lines-with-newline'})+'\n'
    for(const entry of CRM_PRIVACY_COVERAGE) {
      checkAbort(options.signal)
      domain=entry.domain
      const classification=crmPrivacyClassification(entry,scope),hash=createHash('sha256')
      let count=0
      if(classification!=='excluded') {
        await client.query('DECLARE privacy_export_rows NO SCROLL CURSOR FOR '+crmPrivacyDomainSql(entry,scope),[context.workspaceId,contactId])
        for(;;) {
          checkAbort(options.signal)
          const row=(await client.query<{payload:string|null;bytes:number}>('FETCH FORWARD 1 FROM privacy_export_rows')).rows[0]
          if(!row)break
          if(row.payload===null)throw failure('privacy_export_row_too_large',domain)
          await renewSubject()
          // Preserve PostgreSQL numeric precision and JSON without parsing and
          // reserializing record values through JavaScript.
          const line='{"type":"record","domain":'+JSON.stringify(domain)+',"record":'+row.payload+'}\n'
          hash.update(line);aggregate.update(line);count++;total++
          yield line
        }
        await client.query('CLOSE privacy_export_rows')
      }
      coverage.push({domain,classification,count,sha256:hash.digest('hex'),reason:entry.reason,
        excludedColumns:entry.excludedColumns,redactedColumns:scope==='contact'?Object.keys(entry.subjectRedactions):[]})
    }
    checkAbort(options.signal)
    await renewSubject()
    // Commit before emitting success. A failed snapshot transaction must never
    // leave a complete manifest that asserts the export was valid.
    await client.query('COMMIT')
    transactionOpen=false
    yield JSON.stringify({type:'manifest',schema:'crm-privacy-v2',exportId,complete:true,totalRecords:total,
      sha256:aggregate.digest('hex'),coverage,
      excludedDomains:[
        {domain:'unrelated_brain_and_chat',reason:'This is a CRM slice, not a whole-brain or conversation export.'},
        {domain:'unattributed_import_rows',reason:'Failed or legacy import rows without an explicit entity link require source review; matching arbitrary CSV payloads is not subject attribution.'},
        {domain:'unattributed_free_text',reason:'Only explicit CRM references establish subject attribution; incidental mentions require separate review.'},
        {domain:'external_file_bytes',reason:'The export includes attributed file inventory; shared raw files require separate access and privacy review.'},
      ],
      relatedFacilities:[
        {kind:'crm_legacy_export',method:'GET',path:'/api/crm/'+context.workspaceId+'/operations/privacy-export'},
        {kind:'crm_records_csv',method:'GET',path:'/api/crm/'+context.workspaceId+'/export'},
        {kind:'page_export',method:'GET',pathTemplate:'/api/views/{viewId}/export',requiresSeparateAuthorization:true},
        {kind:'workspace_data_reset',method:'DELETE',path:'/api/workspaces/'+context.workspaceId+'/data',destructive:true,isExport:false},
      ]})+'\n'
  } catch(error) {
    if(error instanceof CrmOperationsError || (error && typeof error==='object' && 'code' in error && error.code==='integration_scope_denied'))throw error
    throw failure('privacy_export_failed',domain)
  } finally {
    if(transactionOpen)await client.query('ROLLBACK').catch(()=>{})
    client.release()
  }
}

/** Shared HTTP adapter: preflight before headers, backpressure and disconnect cleanup. */
export async function sendCrmPrivacyExport(res:Response,context:CrmOperationsContext,options:Omit<CrmPrivacyExportOptions,'signal'>={}):Promise<void> {
  const abort=new AbortController()
  const close=()=>abort.abort()
  res.once('close',close)
  const stream=streamCrmPrivacyExport(context,{...options,signal:abort.signal})
  try {
    const first=await stream.next()
    if(first.done)throw failure('privacy_export_empty')
    res.set('Cache-Control','no-store')
    res.type('application/x-ndjson')
    res.set('Content-Disposition','attachment; filename="crm-privacy-'+(options.contactId ?? context.workspaceId)+'.ndjson"')
    const write=async(chunk:string)=>{
      checkAbort(abort.signal)
      if(!res.write(chunk))await once(res,'drain',{signal:abort.signal})
    }
    await write(first.value)
    for await(const chunk of stream)await write(chunk)
    res.end()
  } catch(error) {
    if(res.headersSent){res.destroy();return}
    throw error
  } finally {
    abort.abort()
    res.off('close',close)
    await stream.return(undefined).catch(()=>{})
  }
}
