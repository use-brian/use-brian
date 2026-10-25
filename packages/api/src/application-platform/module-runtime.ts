/** Current module roles at the canonical transaction, never a client role claim. [COMP:api/application-management] */
import type { ApplicationOperationContext } from '@use-brian/core'
import { ApplicationPlatformError } from '@use-brian/shared'
import type { PoolClient } from 'pg'
export async function assertApplicationModuleRole(context:ApplicationOperationContext<PoolClient>,moduleKey:string,roleKey:string):Promise<void> {
 const denied=()=>new ApplicationPlatformError('access_unavailable','The module operation is unavailable.')
 if(!/^[a-z][a-z0-9_.-]{0,127}$/.test(moduleKey)||!/^[a-z][a-z0-9_.-]{0,127}$/.test(roleKey)||context.execution.lifecycle.abortSignal.aborted)throw denied()
 await context.execution.security.authority.assertCurrent()
 const {workspaceId,userId}=context.execution.security.access
 const row=(await context.transaction.query<{actor:string;assistant:string;allowed:boolean}>(`SELECT nullif(current_setting('app.current_user_id',true),'') AS actor,
 nullif(current_setting('app.v2_assistant_id',true),'') AS assistant,read_application_module_role($1,$2,$3) AS allowed`,[workspaceId,moduleKey,roleKey])).rows[0]
 if(row?.actor!==userId||row.assistant!==context.execution.assistant.id||row.allowed!==true)throw denied()
 await context.execution.security.authority.assertCurrent()
}

export async function lockApplicationModuleRecords(context:ApplicationOperationContext<PoolClient>,moduleKey:string,ids:readonly string[]):Promise<void>{
 const denied=()=>new ApplicationPlatformError('access_unavailable','The module operation is unavailable.')
 if(!/^[a-z][a-z0-9_.-]{0,127}$/.test(moduleKey)||ids.length<1||ids.length>100||new Set(ids).size!==ids.length||ids.some(id=>!/^[0-9a-f-]{36}$/.test(id))||context.execution.lifecycle.abortSignal.aborted)throw denied()
 await context.execution.security.authority.assertCurrent()
 const row=(await context.transaction.query<{actor:string;assistant:string;allowed:boolean}>(`SELECT nullif(current_setting('app.current_user_id',true),'') AS actor,
 nullif(current_setting('app.v2_assistant_id',true),'') AS assistant,application_lock_module_records($1,$2,$3::uuid[]) AS allowed`,[context.execution.security.access.workspaceId,moduleKey,[...ids].sort()])).rows[0]
 if(row?.actor!==context.execution.security.access.userId||row.assistant!==context.execution.assistant.id||row.allowed!==true)throw denied()
 await context.execution.security.authority.assertCurrent()
}
