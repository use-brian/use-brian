/** [COMP:api/channel-recording]
 * An installation's recorder is distinct from the actor receiving a group reply.
 * Spec: channels/adapter-pattern.md, Personal recording destinations.
 */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { maxSensitivity, type ResourceScope } from '@use-brian/core'
import { parseTopicChannelId, type TelegramTextDelivery } from '@use-brian/channels'
import { getPool, query } from './db/client.js'
import { readSessionById, type Session } from './db/sessions.js'
import { appendChannelRoomMessage } from './channel-room/messages.js'
import { admitChannelRoom, admitSessionCreate } from './workspace-access/session-create-admission.js'
import { WorkspaceAccessError } from './workspace-access/policy.js'
import type { ChannelIntegrationConfig } from './db/channel-integrations.js'
import { hasTelegramWorkspaceConversationBinding, telegramConfiguredConversation } from './telegram-conversation-admission.js'

export type RecordingPolicy = {
  id: string; conversationId: string; enabled: boolean; destination: 'personal' | 'workspace';
  projectId: string | null; revision: number; sessionId: string | null;
}
export type RecordingAdmission = { policy: RecordingPolicy; session: Session; ownerUserId: string; workspaceId: string }
const cols = `id,conversation_id AS "conversationId",enabled,destination,project_id AS "projectId",
 revision,session_id AS "sessionId"`
const unavailable = () => new WorkspaceAccessError('recording_destination_unavailable', 409)

async function liveOwner(db: Pick<PoolClient, 'query'>, integrationId: string) {
  return (await db.query<{ ownerUserId: string; workspaceId: string; botId: string }>(`SELECT ci.bot_user_id AS "botId",ci.recording_owner_user_id AS "ownerUserId",c.workspace_id AS "workspaceId"
    FROM channel_integrations ci JOIN channels c ON c.id=ci.channel_id
    JOIN workspace_members wm ON wm.workspace_id=c.workspace_id AND wm.user_id=ci.recording_owner_user_id
    WHERE ci.id=$1 AND ci.status='active' AND c.status='active' AND ci.channel_type='telegram' AND ci.bot_user_id IS NOT NULL FOR SHARE OF ci,c,wm`, [integrationId])).rows[0]
}

async function lockWorkspace(db: PoolClient, integrationId: string) {
  await db.query(`SELECT w.id FROM workspaces w WHERE w.id=(SELECT c.workspace_id FROM channels c
    JOIN channel_integrations ci ON ci.channel_id=c.id WHERE ci.id=$1) FOR UPDATE`, [integrationId])
}

async function destinationScope(db: PoolClient, input: { integrationId: string; conversationId: string; assistantId: string },
  owner: { ownerUserId: string; workspaceId: string }, policy: RecordingPolicy) {
  const assistant = (await db.query<{ clearance: string }>('SELECT clearance FROM assistants WHERE id=$1 AND workspace_id=$2 FOR SHARE', [input.assistantId,owner.workspaceId])).rows[0]
  if (!assistant) throw unavailable()
  if (policy.destination === 'personal') {
    const source = await admitChannelRoom(db, { assistantId: input.assistantId, userId: owner.ownerUserId,
      workspaceId: owner.workspaceId, channelType: 'telegram', channelId: input.conversationId, channelIntegrationId: input.integrationId })
    await db.query("SELECT set_config('app.session_creation_admission','',true)")
    return source
  }
  if (policy.projectId) {
    const grant = await db.query(`SELECT 1 FROM project_shared_scopes ps JOIN workspace_projects p ON p.id=ps.project_id
      JOIN workspaces w ON w.id=p.workspace_id WHERE p.id=$1 AND p.workspace_id=$2 AND p.status='active'
      AND ps.status='active' AND w.project_shared_spaces AND w.department_read_v2
      AND project_member_live(p.id,'user',$3) AND project_member_live(p.id,'assistant',$4)`,
    [policy.projectId,owner.workspaceId,owner.ownerUserId,input.assistantId])
    if (!grant.rows.length) throw unavailable()
  }
  const chosen = await admitSessionCreate(db, { assistantId: input.assistantId, userId: owner.ownerUserId,
    workspaceId: owner.workspaceId, channelType: 'web', channelId: randomUUID(), appOrigin: 'chat', effectiveClearance: assistant.clearance,
    contextGroupId: null, contextProjectId: policy.projectId, contextCompartments: [] as string[] }, true)
  const group = await admitChannelRoom(db, { assistantId: input.assistantId, userId: owner.ownerUserId,
    workspaceId: owner.workspaceId, channelType: 'telegram', channelId: input.conversationId, channelIntegrationId: input.integrationId })
  if ((group.contextProjectId && group.contextProjectId !== policy.projectId)
    || group.contextCompartments.some(c => !(chosen.contextCompartments ?? []).includes(c))) throw unavailable()
  const effectiveClearance = maxSensitivity((chosen.effectiveClearance ?? 'internal') as ResourceScope['sensitivity'], group.effectiveClearance as ResourceScope['sensitivity'])
  // Both guards must admit the final destination floor. The canonical
  // channel receipt still proves the provider binding; the recording receipt
  // additionally proves the owner, Project, epoch and exact final labels.
  await db.query(`SELECT set_config('app.session_creation_admission',
    CASE WHEN nullif(current_setting('app.session_creation_admission',true),'') IS NULL THEN ''
    ELSE (current_setting('app.session_creation_admission',true)::jsonb || jsonb_build_object('sensitivity',$1::text))::text END,true)`, [effectiveClearance])
  return { effectiveClearance, contextGroupId: chosen.contextGroupId ?? null,
    contextProjectId: policy.projectId, contextCompartments: [...new Set([
      ...chosen.contextCompartments ?? [], ...(policy.projectId ? [`project:${policy.projectId}`] : []),
    ])] }
}

/** Fail closed before archives, workflow events, discussion capture or media intake. */
export async function telegramRecordingEnabled(integrationId: string, conversationId: string): Promise<boolean> {
  const db = getPool()
  const owner = await liveOwner(db, integrationId)
  if (!owner) return false
  const result = await db.query<{ enabled: boolean; ownerId: string }>('SELECT enabled,owner_user_id AS "ownerId" FROM channel_recording_policies WHERE workspace_id=$1 AND bot_id=$2 AND conversation_id=$3', [owner.workspaceId,owner.botId,conversationId])
  return result.rows[0] ? result.rows[0].enabled && result.rows[0].ownerId === owner.ownerUserId : true
}

/** One epoch per destination; replay identity spans epochs and deleted sessions. */
export async function admitTelegramRecording(input: {
  integrationId: string; conversationId: string; assistantId: string; providerMessageId: string; text: string; senderUserId: string;
}): Promise<RecordingAdmission | null> {
  return appendTelegramRecording(input)
}

type RecordingMessage = {
  integrationId: string; conversationId: string; assistantId: string; providerMessageId: string; text: string;
  senderUserId?: string; role?: 'user' | 'assistant'; publishedSenderName?: string; expectedPolicy?: { id: string; revision: number };
}

async function appendTelegramRecording(input: RecordingMessage): Promise<RecordingAdmission | null> {
  const db = await getPool().connect()
  let policy: RecordingPolicy | undefined
  let owner: Awaited<ReturnType<typeof liveOwner>>
  try {
    await db.query('BEGIN')
    await lockWorkspace(db, input.integrationId)
    owner = await liveOwner(db, input.integrationId)
    if (!owner) throw unavailable()
    if (!input.expectedPolicy) await db.query(`INSERT INTO channel_recording_policies(integration_id,conversation_id,workspace_id,bot_id,owner_user_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [input.integrationId,input.conversationId,owner.workspaceId,owner.botId,owner.ownerUserId])
    policy = (await db.query<RecordingPolicy>(`SELECT ${cols} FROM channel_recording_policies WHERE workspace_id=$1 AND bot_id=$2 AND conversation_id=$3 AND owner_user_id=$4 FOR UPDATE`, [owner.workspaceId,owner.botId,input.conversationId,owner.ownerUserId])).rows[0]
    if (!policy?.enabled) throw unavailable()
    if (input.expectedPolicy && (input.expectedPolicy.id !== policy.id || input.expectedPolicy.revision !== policy.revision)) throw unavailable()
    if (input.role === 'assistant') {
      // A public provider receipt grants no ambient reach into another recorder.
      // Re-admit the target installation's exact conversation in this transaction.
      const { chatId, messageThreadId } = parseTopicChannelId(input.conversationId)
      const config = (await db.query<{ config: ChannelIntegrationConfig }>('SELECT config FROM channel_integrations WHERE id=$1 FOR SHARE', [input.integrationId])).rows[0]?.config ?? {}
      const scope = telegramConfiguredConversation(config, chatId, messageThreadId)
      if (scope === 'elsewhere' || scope !== 'owned' && !await hasTelegramWorkspaceConversationBinding(
        owner.workspaceId, chatId, input.conversationId, messageThreadId, {
          query: (sql, values) => db.query(sql, values),
          getWorkspaceRole: async (userId, workspaceId) => (await db.query('SELECT role FROM workspace_members WHERE user_id=$1 AND workspace_id=$2', [userId,workspaceId])).rows[0]?.role ?? null,
          now: Date.now,
        })) throw unavailable()
    }
    await db.query('UPDATE channel_recording_policies SET integration_id=$2 WHERE id=$1', [policy.id,input.integrationId])
    const prior = (await db.query<{ sessionId: string | null }>(`SELECT session_id AS "sessionId" FROM channel_recording_messages WHERE policy_id=$1 AND provider_message_id=$2`, [policy.id, input.providerMessageId])).rows[0]
    if (prior) { await db.query('COMMIT'); return null }
    const scope = await destinationScope(db,input,owner,policy)
    if (policy.sessionId) {
      const current = (await db.query<{ clearance: string; compartments: string[]; assistantId: string; projectId: string | null; groupId: string | null }>(
        'SELECT effective_clearance AS clearance,context_compartments AS compartments,assistant_id AS "assistantId",context_project_id AS "projectId",context_group_id AS "groupId" FROM sessions WHERE id=$1 FOR SHARE', [policy.sessionId])).rows[0]
      if (!current || current.assistantId !== input.assistantId || current.clearance !== scope.effectiveClearance
        || current.projectId !== scope.contextProjectId || current.groupId !== scope.contextGroupId
        || JSON.stringify([...current.compartments].sort()) !== JSON.stringify([...scope.contextCompartments].sort())) throw unavailable()
    }
    if (!policy.sessionId) {
      const id = randomUUID()
      await db.query("SELECT set_config('app.recording_session_admission',$1,true)", [JSON.stringify({
        policyId: policy.id, revision: policy.revision, sessionId: id, ownerId: owner.ownerUserId,
        workspaceId: owner.workspaceId, assistantId: input.assistantId, destination: policy.destination,
        conversationId: input.conversationId, ...scope,
      })])
      await db.query(`INSERT INTO sessions(id,assistant_id,user_id,workspace_id,channel_type,channel_id,app_id,app_origin,
        visibility,anchor_kind,anchor_ref,effective_clearance,clearance_source,context_group_id,context_project_id,context_compartments,
        recording_policy_id,recording_revision,room_capture)
        VALUES($1,$2,$3,$4,'telegram',$5,$6,'chat',$7,'channel',$5,$8,'anchor',$9,$10,$11,$12,$13,false)`,
      [id,input.assistantId,owner.ownerUserId,owner.workspaceId,input.conversationId,`recording:${id}`,policy.destination,
        scope.effectiveClearance,scope.contextGroupId,scope.contextProjectId,scope.contextCompartments,policy.id,policy.revision])
      await db.query('UPDATE channel_recording_policies SET session_id=$2 WHERE id=$1', [policy.id,id])
      policy.sessionId = id
    }
    await db.query('INSERT INTO channel_recording_messages(policy_id,provider_message_id,session_id) VALUES($1,$2,$3)', [policy.id,input.providerMessageId,policy.sessionId])
    const stored = (await db.query<{ clearance: ResourceScope['sensitivity']; compartments: string[]; projectId: string | null }>(
      'SELECT effective_clearance AS clearance,context_compartments AS compartments,context_project_id AS "projectId" FROM sessions WHERE id=$1', [policy.sessionId])).rows[0]
    await appendChannelRoomMessage({ sessionId: policy.sessionId!, role: input.role ?? 'user', content: [{ type: 'text', text: input.text }],
      senderUserId: input.senderUserId, publishedSenderName: input.publishedSenderName, channelMessageId: input.providerMessageId, scope: {
        workspaceId: owner.workspaceId, userId: policy.destination === 'personal' ? owner.ownerUserId : null,
        assistantId: null, sensitivity: stored.clearance, compartments: stored.compartments, projectIds: stored.projectId ? [stored.projectId] : [],
      } }, db)
    await db.query('COMMIT')
  } catch (error) { await db.query('ROLLBACK'); throw error } finally { db.release() }
  // Published receipt capture needs no transcript read or source-session join.
  if (input.role === 'assistant') return null
  const session = await readSessionById(policy.sessionId!)
  if (!session) throw unavailable()
  return { policy, session, ownerUserId: owner!.ownerUserId, workspaceId: owner!.workspaceId }
}

/** Copy only text already published into the provider conversation. Candidate
 * discovery is not admission: every target rechecks its live owner, provider
 * binding, destination and epoch under the canonical writer's locks. */
export async function recordDeliveredTelegramMessage(delivery: TelegramTextDelivery): Promise<void> {
  if (!/^-[0-9]+(?::(?:topic|discussion):[0-9]+)?$/.test(delivery.channelId)
    || !delivery.providerMessageId || !delivery.text) return
  const { chatId } = parseTopicChannelId(delivery.channelId)
  const candidates = await query<{ id: string; revision: number; integrationId: string; assistantId: string | null }>(
    `SELECT p.id,p.revision,p.integration_id AS "integrationId",COALESCE(s.assistant_id,route.assistant_id) AS "assistantId"
       FROM channel_recording_policies p JOIN channel_integrations ci ON ci.id=p.integration_id
       JOIN channels c ON c.id=ci.channel_id
       LEFT JOIN sessions s ON s.id=p.session_id AND s.recording_policy_id=p.id AND s.recording_revision=p.revision
       LEFT JOIN LATERAL (SELECT ca.assistant_id FROM channel_assistants ca WHERE ca.channel_id=c.id
         AND (ca.external_surface_id=$1 OR ca.external_surface_id=$2 OR ca.external_surface_id IS NULL)
         ORDER BY CASE WHEN ca.external_surface_id=$1 THEN 0 WHEN ca.external_surface_id=$2 THEN 1 ELSE 2 END,ca.id LIMIT 1) route ON true
      WHERE p.conversation_id=$1 AND p.enabled AND ci.channel_type='telegram' AND ci.status='active'
        AND c.status='active' AND c.workspace_id=p.workspace_id AND ci.bot_user_id=p.bot_id
        AND ci.recording_owner_user_id=p.owner_user_id ORDER BY p.workspace_id,p.id`, [delivery.channelId,chatId])
  const failures: Error[] = []
  for (const candidate of candidates.rows) {
    if (!candidate.assistantId) continue
    try {
      await appendTelegramRecording({ integrationId: candidate.integrationId,conversationId: delivery.channelId,
        assistantId: candidate.assistantId,providerMessageId: delivery.providerMessageId,text: delivery.text,
        role: 'assistant',publishedSenderName: delivery.botUsername ? `@${delivery.botUsername}` : '',
        expectedPolicy: { id: candidate.id,revision: candidate.revision } })
    } catch (error) {
      // Revocation, stop, destination changes and unowned provider conversations
      // are expected exclusions. Operational recording failures remain visible.
      if (error instanceof WorkspaceAccessError) continue
      const failure = new Error(`telegram_reply_recording_failed: policy=${candidate.id} integration=${candidate.integrationId} message=${delivery.providerMessageId}`, { cause: error })
      failures.push(failure)
    }
  }
  if (failures.length) throw new AggregateError(failures, 'telegram_reply_recording_failed')
}

export function recordingInputScope(recording: RecordingAdmission): ResourceScope {
  return { workspaceId: recording.workspaceId, userId: recording.policy.destination === 'personal' ? recording.ownerUserId : null,
    assistantId: null, sensitivity: (recording.session.effectiveClearance ?? 'internal') as ResourceScope['sensitivity'],
    compartments: recording.session.contextCompartments, projectIds: recording.session.contextProjectId ? [recording.session.contextProjectId] : [] }
}


export async function listChannelRecordings(integrationId: string, actorId: string) {
  const owner = await liveOwner(getPool(), integrationId)
  if (!owner || owner.ownerUserId !== actorId) throw unavailable()
  return (await query<RecordingPolicy>(`SELECT ${cols} FROM channel_recording_policies WHERE integration_id=$1 ORDER BY updated_at DESC`, [integrationId])).rows
}

/** Authenticated connector confirmation only; a reconnect never changes an existing owner. */
export async function confirmChannelRecordingOwner(integrationId: string, actorId: string) {
  const result = await query(`UPDATE channel_integrations ci SET recording_owner_user_id=$2
    FROM channels c, workspace_members wm WHERE ci.id=$1 AND ci.channel_id=c.id AND ci.channel_type='telegram'
    AND wm.workspace_id=c.workspace_id AND wm.user_id=$2 AND wm.role IN ('owner','admin')
    AND (ci.recording_owner_user_id IS NULL OR ci.recording_owner_user_id=$2) RETURNING ci.id`, [integrationId,actorId])
  if (!result.rows.length) throw unavailable()
}

export async function changeChannelRecording(input: { integrationId: string; actorId: string; id: string; revision: number;
  enabled: boolean; destination: 'personal' | 'workspace'; projectId: string | null }) {
  const db = await getPool().connect()
  try {
    await db.query('BEGIN')
    await lockWorkspace(db,input.integrationId)
    const owner = await liveOwner(db,input.integrationId)
    if (!owner || owner.ownerUserId !== input.actorId) throw unavailable()
    const current = (await db.query<RecordingPolicy>(`SELECT ${cols} FROM channel_recording_policies WHERE id=$1 AND integration_id=$2 FOR UPDATE`, [input.id,input.integrationId])).rows[0]
    if (!current || current.revision !== input.revision) throw new WorkspaceAccessError('recording_revision_conflict',409)
    if (input.destination === 'personal' && input.projectId) throw unavailable()
    if (input.enabled && input.destination === 'workspace') {
      const prior = (await db.query<{ assistantId: string }>('SELECT assistant_id AS "assistantId" FROM sessions WHERE recording_policy_id=$1 ORDER BY recording_revision DESC LIMIT 1', [input.id])).rows[0]
      if (!prior) throw unavailable()
      await destinationScope(db, { integrationId: input.integrationId, conversationId: current.conversationId, assistantId: prior.assistantId }, owner,
        { ...current, destination: input.destination, projectId: input.projectId })
    }
    // Project admission is repeated at the first write with the actual routed assistant.
    // No historical rows are relabelled, even for stop/resume of the same audience.
    const updated = (await db.query<RecordingPolicy>(`UPDATE channel_recording_policies SET enabled=$2,destination=$3,project_id=$4,
      revision=revision+1,session_id=NULL,updated_at=now() WHERE id=$1 RETURNING ${cols}`,
    [input.id,input.enabled,input.destination,input.projectId])).rows[0]
    await db.query('COMMIT')
    return updated
  } catch (error) { await db.query('ROLLBACK'); throw error } finally { db.release() }
}
