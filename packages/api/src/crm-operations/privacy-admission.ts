/** Transaction guard for privacy validation and mutation. [COMP:crm/privacy-admission] */
import type {PoolClient} from 'pg'
import {CrmOperationsError} from '@use-brian/core/crm/operations-types.js'

/** Call before domain row locks. All covered DML takes shared admission in SQL. */
export async function acquireCrmPrivacyAdmission(client:PoolClient,workspaceId:string):Promise<void> {
  const result=await client.query<{acquired:boolean}>(
    "SELECT pg_try_advisory_xact_lock(hashtextextended('crm-privacy-admission:'||$1::uuid::text,0)) AS acquired",
    [workspaceId],
  )
  if(!result.rows[0]?.acquired)throw new CrmOperationsError('conflict',
    'CRM records are being changed. Retry the privacy operation.',{reason:'privacy_operation_busy'})
}

/** Hold through provider acceptance so privacy cannot split send and receipt. */
export async function acquireCrmPrivacyWriterAdmission(client:PoolClient,workspaceId:string):Promise<void> {
  const result=await client.query<{acquired:boolean}>(
    "SELECT pg_try_advisory_xact_lock_shared(hashtextextended('crm-privacy-admission:'||$1::uuid::text,0)) AS acquired",
    [workspaceId],
  )
  if(!result.rows[0]?.acquired)throw new CrmOperationsError('conflict',
    'CRM privacy work is in progress. Retry the write.',{reason:'privacy_operation_busy'})
}
