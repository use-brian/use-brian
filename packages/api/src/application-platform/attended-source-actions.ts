/** Source-owned attended commands with durable, actor-bound no-repeat receipts. [COMP:api/attended-source-actions] */
import { z } from 'zod'
import type { ExecutionContext, McpToolInfo } from '@use-brian/core'
import { SourceProtocolError, SOURCE_PROTOCOL_VERSION, sourceEffectDigest } from '@use-brian/brian-app/connector'
import { getPool } from '../db/client.js'
import type { SourceAccessClient, TrustedSourceRead } from './source-access.js'

export const attendedSourceActionsInput = z.object({
  tools: z.array(z.string().min(1).max(128)).min(1).max(100).refine(names => new Set(names).size === names.length),
  idempotencyMetadataKey: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}\/[a-z][a-z0-9_.-]{0,63}$/),
}).strict()
export type AttendedSourceActions = z.infer<typeof attendedSourceActionsInput>
const actionInput = z.object({operationId:z.string().uuid(),mode:z.enum(['execute','reconcile']),input:z.record(z.unknown())}).strict()
function denied(): never { throw new SourceProtocolError('source_access_denied') }

export function attendedActionCatalog(tool: McpToolInfo): McpToolInfo {
  return { ...tool, description: `${tool.description}\nUse a fresh UUID operationId for a distinct action. Reuse it with mode reconcile to check an uncertain outcome. Repeating execute with that ID only reconciles; it never repeats the action. Input must match the source schema.`,
    inputSchema: {type:'object',additionalProperties:false,required:['operationId','mode','input'],properties:{
      operationId:{type:'string',format:'uuid'},mode:{type:'string',enum:['execute','reconcile']},input:tool.inputSchema}} }
}

export async function executeAttendedSourceAction(options: { execution: ExecutionContext; profileId: string;
  config: AttendedSourceActions; tool: string; raw: Record<string, unknown>; client: SourceAccessClient; assertCurrent: () => Promise<void> }):
  Promise<{operationId:string;state:'applied'|'uncertain'|'not_started';retrySafe:false;receipt?:string;read?:TrustedSourceRead}> {
  const { execution, profileId, config, tool, client, assertCurrent } = options
  const parsed = actionInput.safeParse(options.raw)
  if (!parsed.success || !config.tools.includes(tool) || execution.surface.readOnly || execution.security.access.sharedAudience
    || execution.identity.kind !== 'attended' || execution.identity.principal.kind !== 'workspace_member') denied()
  const { operationId, mode, input } = parsed.data, { workspaceId, userId } = execution.security.access
  const digest = sourceEffectDigest({tool,input,idempotencyKey:operationId})
  await assertCurrent()
  const capabilities = await client.capabilities()
  if (!capabilities.reconciliation || capabilities.attendedActions?.idempotencyMetadataKey !== config.idempotencyMetadataKey) denied()
  const inserted = mode === 'execute' ? (await getPool().query<{id:string}>(`INSERT INTO connector_attended_commands
    (workspace_id,profile_id,actor_id,assistant_id,operation_id,tool,input_digest) VALUES($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT DO NOTHING RETURNING id`,[workspaceId,profileId,userId,execution.assistant.id,operationId,tool,digest])).rows[0] : undefined
  const row = (await getPool().query<{id:string;profile_id:string;tool:string;input_digest:string}>(`SELECT id,profile_id,tool,input_digest FROM connector_attended_commands
    WHERE workspace_id=$1 AND actor_id=$2 AND assistant_id=$3 AND operation_id=$4`,
  [workspaceId,userId,execution.assistant.id,operationId])).rows[0]
  if (!row) return { operationId, state: 'not_started' as const, retrySafe:false }
  if (row.profile_id !== profileId || row.tool !== tool || row.input_digest !== digest) denied()
  let read: TrustedSourceRead | undefined
  if (inserted) {
    // Reservation precedes the only dispatch. A crash or a second caller can
    // only reconcile the original source key, never obtain another sender.
    try { await assertCurrent(); read = await client.actionMcp(tool,input,config.idempotencyMetadataKey,row.id) }
    catch { await assertCurrent() }
  }
  let state: 'applied' | 'uncertain' = 'uncertain', receipt: string | undefined
  try {
    const result = await client.reconcile({version:SOURCE_PROTOCOL_VERSION,idempotencyKey:row.id})
    if (result.state === 'applied') { state = 'applied'; receipt = result.receipt }
  } catch { /* Unknown is not permission to send the command again. */ }
  await assertCurrent()
  if (state === 'applied') await getPool().query(`UPDATE connector_attended_commands SET state='applied',receipt=$2 WHERE id=$1`,[row.id,receipt])
  await assertCurrent()
  return { operationId, state, retrySafe:false, ...(receipt ? {receipt} : {}), ...(state === 'applied' && read ? {read} : {}) }
}
