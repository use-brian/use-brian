/** Metadata-only recovery through the existing immutable scope review lifecycle.
 * [COMP:api/application-legacy-review]
 */
import {z} from 'zod'
import type {PoolClient} from 'pg'
import type {ExecutionContext} from '@use-brian/core'
import {ApplicationPlatformError} from '@use-brian/shared'
import {assertNativeApplicationGovernance} from './governance.js'

export const applicationLegacyViewInput=z.object({reviewId:z.string().uuid()}).strict()
export const applicationLegacyApplyInput=z.object({
 reviewId:z.string().uuid(),expectedVersion:z.string().regex(/^[1-9][0-9]*$/),payloadHash:z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
export type ApplicationLegacyCommand=
 | ({kind:'legacy.view'}&z.infer<typeof applicationLegacyViewInput>)
 | ({kind:'legacy.apply'|'legacy.cancel'}&z.infer<typeof applicationLegacyApplyInput>)

/** SQL rechecks the actual current native actor, assistant, role and every
 * reviewed snapshot. No raw held-row helper or caller-provided evidence is used. */
export async function executeApplicationLegacyReview(client:PoolClient,execution:ExecutionContext,command:ApplicationLegacyCommand) {
 if(!['legacy.view','legacy.apply','legacy.cancel'].includes(command.kind))throw new ApplicationPlatformError('invalid_value','The management command is invalid.')
 assertNativeApplicationGovernance(execution)
 const {workspaceId}=execution.security.access,assistantId=execution.assistant.id
 await client.query("SELECT set_config('app.application_assistant_id',$1,true),set_config('app.v2_assistant_id',$1,true)",[assistantId])
 let result
 if(command.kind==='legacy.view')result=await client.query('SELECT application_legacy_review_view($1,$2,$3) AS value',[workspaceId,assistantId,command.reviewId])
 else result=await client.query('SELECT application_legacy_review_apply($1,$2,$3,$4,$5,$6) AS value',
  [workspaceId,assistantId,command.reviewId,command.expectedVersion,command.payloadHash,command.kind==='legacy.cancel'])
 return result.rows[0].value as Record<string,unknown>
}
