/** [COMP:api/channel-recording] Reviewed release of provider-visible legacy text. */
import { z } from 'zod'
import { queryWithRLS, getAppPool, applyRLSGucs, rollbackAndRelease } from './db/client.js'
import { recordingDestinationScope } from './channel-recording.js'
import { WorkspaceAccessError } from './workspace-access/policy.js'

const candidate = z.object({
  sessionId: z.string().uuid(), conversationId: z.string(), assistantId: z.string().uuid(),
  assistantName: z.string().nullable(), title: z.string().nullable(), messageCount: z.number().int(),
  skippedMessageCount: z.number().int(), snapshotToken: z.string(), sensitivity: z.string(),
  compartments: z.array(z.string()), projectId: z.string().uuid().nullable(), projectName: z.string().nullable(),
})
const telegramRecordingRecoveryPreviewSchema = z.object({ candidates: z.array(candidate) })
export async function previewTelegramRecordingRecovery(input: { actorId: string; workspaceId: string; channelId: string }) {
  const result = await queryWithRLS<{ result: unknown }>(input.actorId,
    'SELECT preview_telegram_recording_recovery($1,$2,$3) AS result', [input.actorId,input.workspaceId,input.channelId])
  return telegramRecordingRecoveryPreviewSchema.parse(result.rows[0]?.result)
}
export async function applyTelegramRecordingRecovery(input: {
  actorId: string; workspaceId: string; channelId: string; sessionId: string; snapshotToken: string;
}) {
  const client = await getAppPool().connect()
  try {
    await client.query('BEGIN')
    await applyRLSGucs(client,input.actorId)
    // Share the normal Work-recording admission and current audience resolver.
    // Its one-use session creation receipt is consumed by the DB apply below.
    await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[input.workspaceId])
    const state = await client.query<{ result: unknown }>('SELECT telegram_recording_recovery_snapshot($1,$2,$3,$4) AS result',
      [input.actorId,input.workspaceId,input.channelId,input.sessionId])
    const snapshot = candidate.extend({ integrationId: z.string().uuid(), botId: z.string(),
      sourceSnapshot: z.object({ contextGroupId: z.string().uuid().nullable(), contextProjectId: z.string().uuid().nullable(),
        effectiveClearance: z.string(), contextCompartments: z.array(z.string()) }) }).safeParse(state.rows[0]?.result)
    if (!snapshot.success || snapshot.data.snapshotToken !== input.snapshotToken) throw new WorkspaceAccessError('recording_recovery_unavailable',409)
    const current = snapshot.data
    const scope = await recordingDestinationScope(client,{ integrationId: current.integrationId, conversationId: current.conversationId,
      assistantId: current.assistantId },{ ownerUserId: input.actorId,workspaceId: input.workspaceId },
    { id: input.sessionId,conversationId: current.conversationId,enabled: true,destination: 'workspace',projectId: current.projectId,revision: 1,sessionId: null })
    if (scope.effectiveClearance !== current.sourceSnapshot.effectiveClearance
      || scope.contextGroupId !== current.sourceSnapshot.contextGroupId || scope.contextProjectId !== current.sourceSnapshot.contextProjectId
      || JSON.stringify([...scope.contextCompartments].sort()) !== JSON.stringify([...current.sourceSnapshot.contextCompartments].sort())) {
      throw new WorkspaceAccessError('recording_recovery_unavailable',409)
    }
    const result = await client.query<{ result: unknown }>('SELECT apply_telegram_recording_recovery($1,$2,$3,$4,$5) AS result',
      [input.actorId,input.workspaceId,input.channelId,input.sessionId,input.snapshotToken])
    const receipt = z.object({ sessionId: z.string().uuid(), policyId: z.string().uuid(), revision: z.number().int() }).parse(result.rows[0]?.result)
    await client.query('COMMIT')
    return receipt
  } finally { await rollbackAndRelease(client) }
}
