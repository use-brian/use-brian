/** Trusted current metadata resolver for the deployed purchase module. [COMP:examples/application-references] */
import type {ApplicationOperationContext} from '@use-brian/brian-app/module'
import type {PoolClient} from 'pg'
import type {PurchaseSchemaIds} from './module.js'
export async function resolvePurchaseSchemaIds(context:ApplicationOperationContext<PoolClient>,error:()=>Error):Promise<PurchaseSchemaIds>{
 if(context.execution.lifecycle.abortSignal.aborted)throw error()
 await context.execution.security.authority.assertCurrent()
 const row=(await context.transaction.query<{actor:string;assistant:string;ids:PurchaseSchemaIds|null}>(`SELECT nullif(current_setting('app.current_user_id',true),'') AS actor,
 nullif(current_setting('app.v2_assistant_id',true),'') AS assistant,purchasing_read_schema_bindings($1) AS ids`,[context.execution.security.access.workspaceId])).rows[0]
 if(row?.actor!==context.execution.security.access.userId||row.assistant!==context.execution.assistant.id||!row.ids
 ||Object.keys(row.ids).sort().join(',')!=='lineItemTypeId,orderTypeId,requestTypeId'
 ||Object.values(row.ids).some(id=>typeof id!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)))throw error()
 await context.execution.security.authority.assertCurrent()
 return {requestTypeId:row.ids.requestTypeId,lineItemTypeId:row.ids.lineItemTypeId,orderTypeId:row.ids.orderTypeId}
}
