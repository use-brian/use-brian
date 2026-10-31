// [COMP:api/channel-room] A converged provider group is ONE workspace room
// (unified-sessions §4.4, D1-D4, D15, D16).
//
// A Slack channel or thread, a Telegram group or topic, a Discord channel, a
// Feishu chat, a Teams conversation or a BYON WhatsApp group becomes a
// workspace session anchored to the channel (`anchor_kind='channel'`) when a
// channel integration bound the group to the assistant's workspace (D15).
// Every sender shares it: an un-addressed message persists as a room post and
// runs no turn (D4), an addressed one runs one coalesced turn under room
// admission. Senders who are not members are guests (D1). The per-user group
// sessions the room replaces are archived as read-only personal history and
// never merged (D16).
//
// Spec: docs/architecture/channels/adapter-pattern.md -> "Channel rooms";
// docs/architecture/channels/channel-user-identity.md -> "Guests in a room".

import type { PoolClient } from 'pg'
import { resolveGroupAudienceSystem, DeliveryAudienceUnverifiedError } from '../context-scope/delivery-authority.js'
import { maxSensitivity, scopeGrantContains, type AccessCeiling, type ResourceScope } from '@use-brian/core'
import { getPool, query } from '../db/client.js'
import { readSessionById, type Session, type SessionMessage } from '../db/sessions.js'
import { sessionKindSql, transportPolicy, type Transport } from '../session-kind.js'
import { admitChannelRoom } from '../workspace-access/session-create-admission.js'
import { getWorkspaceRoleSystem } from '../db/workspace-store.js'
import { noopPublishSessionEvent, type PublishSessionEvent } from '../session-event-port.js'
import { appendChannelRoomMessage } from './messages.js'

/** The workspace that owns a group's room, through its channel integration (D15). */
export type ChannelRoomBinding = {
  workspaceId: string
  channelIntegrationId: string
}

/** Payload of the room ambient-capture hook (the same shape web rooms use). */
export type ChannelRoomCapturePost = {
  sessionId: string
  workspaceId: string
  assistantId: string
  senderUserId: string
  senderName: string | null
  text: string
  effectiveClearance: string | null
  compartments: string[]
  projectIds: string[]
  contextBindingOrigin: 'legacy' | 'explicit' | 'reviewed' | 'held'
  classificationMode: 'legacy' | 'review' | 'strict'
}

type ChannelRoomRuntime = {
  capturePost?: (post: ChannelRoomCapturePost) => void
  publishSessionEvent: PublishSessionEvent
}

const runtime: ChannelRoomRuntime = { publishSessionEvent: noopPublishSessionEvent }

/**
 * Register the room's process-wide collaborators once, at boot: the brain
 * capture used for web room posts (D4) and the session event bus, so live
 * watchers of a channel room see posts arrive like a web room's.
 */
export function configureChannelRooms(config: Partial<ChannelRoomRuntime>): void {
  if (config.capturePost) runtime.capturePost = config.capturePost
  if (config.publishSessionEvent) runtime.publishSessionEvent = config.publishSessionEvent
}

/**
 * Does this group message belong to a room, and which workspace owns it?
 * Null when the conversation is not a group, the transport does not converge,
 * the assistant has no workspace, or no integration bound the group to the
 * assistant's workspace: those stay on the legacy per-user path (D15; an
 * unbound official-bot group keeps it until an admin binds it).
 */
export async function resolveRoomBinding(params: {
  assistant: { id: string; workspaceId?: string | null }
  channelType: string
  channelIntegrationId?: string | null
  isGroupChat: boolean
}): Promise<ChannelRoomBinding | null> {
  const workspaceId = params.assistant.workspaceId
  if (!params.isGroupChat || !workspaceId || !params.channelIntegrationId) return null
  if (!transportPolicy(params.channelType as Transport).rooms.converge) return null
  try {
    const bound = await query(
      `SELECT 1 FROM channel_integrations ci JOIN channels c ON c.id = ci.channel_id
        WHERE ci.id = $1 AND c.workspace_id = $2 AND ci.channel_type = $3`,
      [params.channelIntegrationId, workspaceId, params.channelType],
    )
    return bound.rows.length ? { workspaceId, channelIntegrationId: params.channelIntegrationId } : null
  } catch (err) {
    // A failed lookup is not an unbound group: say so, then keep the group on
    // an explicit failure rather than bypassing the room's audience policy.
    console.error(`[channel-room] binding lookup failed for ${params.channelType} integration ${params.channelIntegrationId}:`, err)
    throw err
  }
}

/**
 * The room for one provider conversation, created on first contact. Creation
 * is admitted by the binding (`channel_room` receipt) and, in the same
 * transaction, archives the per-user sessions the room replaces (D16). The
 * assistant is the room's default responder, not part of its key (D8).
 */
export async function findOrCreateChannelRoom(params: ChannelRoomBinding & {
  assistantId: string
  channelType: string
  channelId: string
  starterUserId: string
}): Promise<{ room: Session; created: boolean }> {
  const existing = await findChannelRoom(params)
  if (existing) return { room: existing, created: false }
  const client = await getPool().connect()
  let id: string | null = null
  let created = false
  try {
    await client.query('BEGIN')
    id = await insertRoom(client, params)
    created = id !== null
    if (created) {
      await client.query(
        `UPDATE sessions s SET archived_at = now()
          WHERE s.channel_type = $2 AND s.channel_id = $3 AND ${sessionKindSql.legacyGroupRow('s')}
            AND s.assistant_id IN (SELECT a.id FROM assistants a WHERE a.workspace_id = $1)`,
        [params.workspaceId, params.channelType, params.channelId],
      )
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
  const room = id ? await readSessionById(id) : await findChannelRoom(params)
  if (!room) throw new Error('channel_room_unavailable')
  return { room, created }
}

async function findChannelRoom(params: { workspaceId: string; channelType: string; channelId: string }): Promise<Session | null> {
  const row = (await query<{ id: string }>(
    `SELECT s.id FROM sessions s
      WHERE s.workspace_id = $1 AND s.channel_type = $2 AND s.channel_id = $3 AND ${sessionKindSql.channelRoom('s')} AND s.recording_revision IS NULL`,
    [params.workspaceId, params.channelType, params.channelId],
  )).rows[0]
  return row ? readSessionById(row.id) : null
}

async function insertRoom(client: PoolClient, params: ChannelRoomBinding & {
  assistantId: string
  channelType: string
  channelId: string
  starterUserId: string
}): Promise<string | null> {
  const admitted = await admitChannelRoom(client, {
    assistantId: params.assistantId,
    userId: params.starterUserId,
    workspaceId: params.workspaceId,
    channelType: params.channelType,
    channelId: params.channelId,
    channelIntegrationId: params.channelIntegrationId,
  })
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO sessions (assistant_id, user_id, workspace_id, channel_type, channel_id,
        visibility, anchor_kind, anchor_ref, effective_clearance, context_group_id, context_compartments, context_project_id, clearance_source)
     VALUES ($1, $2, $3, $4, $5, 'workspace', 'channel', $5, $6, $7, $8, $9, 'anchor')
     ON CONFLICT ${sessionKindSql.channelRoomConflict()}
     DO NOTHING
     RETURNING id`,
    [params.assistantId, params.starterUserId, params.workspaceId, params.channelType, params.channelId,
      admitted.effectiveClearance, admitted.contextGroupId, admitted.contextCompartments, admitted.contextProjectId],
  )
  // A concurrent first message won the race: the admission receipt is
  // single-use and the conflict consumed nothing, so clear it explicitly.
  if (!inserted.rows.length) await client.query("SELECT set_config('app.session_creation_admission','',true)")
  return inserted.rows[0]?.id ?? null
}

/**
 * The input envelope of a room message: the ROOM's audience, whoever sent it.
 * A guest's message and a member's message are read by the same people.
 */
export function roomInputScope(room: Session, workspaceId: string, audience?: AccessCeiling): ResourceScope {
  return {
    workspaceId,
    userId: null,
    assistantId: null,
    sensitivity: audience?.clearance ?? (room.effectiveClearance ?? 'internal') as ResourceScope['sensitivity'],
    compartments: audience ? audience.compartments ?? [] : [...room.contextCompartments],
    projectIds: audience ? audience.projectIds ?? [] : room.contextProjectId ? [room.contextProjectId] : [],
  }
}

/** A new group policy cannot widen the room's web readers or discard an
 * existing history classification. Broader lateral requirements need review. */
export async function admitRoomInputScope(room: Session, scope: ResourceScope): Promise<void> {
  if (!scopeGrantContains(room.contextCompartments, scope.compartments)
      || !scopeGrantContains(room.contextProjectId ? [room.contextProjectId] : [], scope.projectIds)) {
    throw new Error('context_not_available')
  }
  const raised = maxSensitivity((room.effectiveClearance ?? 'internal') as ResourceScope['sensitivity'], scope.sensitivity)
  if (raised !== room.effectiveClearance || room.clearanceSource !== 'anchor') {
    const updated = await query<{ effectiveClearance: string }>(`UPDATE sessions SET
      effective_clearance=CASE WHEN sensitivity_rank(effective_clearance)<sensitivity_rank($2) THEN $2 ELSE effective_clearance END,
      clearance_source='anchor' WHERE id=$1
      RETURNING effective_clearance AS "effectiveClearance"`, [room.id, raised])
    room.effectiveClearance = updated.rows[0]?.effectiveClearance ?? raised
    room.clearanceSource = 'anchor'
  }
}

/**
 * Persist an un-addressed group message as a room post (D4): it joins the
 * room's context and runs no turn. Brain capture follows the room's capture
 * setting; when an admin switched it off the post is context only. A
 * provider redelivery of the same message id is a no-op.
 */
export async function postToChannelRoom(params: {
  room: Session
  inputScope?: ResourceScope
  workspaceId: string
  senderUserId: string
  senderName: string | null
  text: string
  channelMessageId?: string | null
  replyToText?: string | null
}): Promise<SessionMessage | null> {
  if (params.inputScope) await admitRoomInputScope(params.room, params.inputScope)
  const text = params.text.trim()
  if (!text) return null
  const result = await appendChannelRoomMessage({
    sessionId: params.room.id,
    role: 'user',
    content: [{ type: 'text', text }],
    replyToText: params.replyToText ?? null,
    channelMessageId: params.channelMessageId ?? null,
    senderUserId: params.senderUserId,
    scope: params.inputScope ?? roomInputScope(params.room, params.workspaceId),
  })
  if (!result.created) return null
  const stored = result.message
  runtime.publishSessionEvent({
    kind: 'user_message_saved',
    sessionId: params.room.id,
    payload: {
      id: stored.id,
      sequenceNum: stored.sequenceNum,
      senderUserId: params.senderUserId,
      content: stored.content,
    },
  })
  await captureChannelRoomInput(params)
  return stored
}

/** Both passive and addressed inputs use this after a NEW canonical append.
 * Capture consent and classification are room-owned, never speaker-private. */
export async function captureChannelRoomInput(params: {
  room: Session
  inputScope?: ResourceScope
  workspaceId: string
  senderUserId: string
  senderName: string | null
  text: string
}): Promise<void> {
  const text = params.text.trim()
  if (!text) return
  try {
    if (runtime.capturePost && await roomCaptureEnabled(params.room.id)) {
      runtime.capturePost({
        sessionId: params.room.id,
        workspaceId: params.workspaceId,
        assistantId: params.room.assistantId,
        senderUserId: params.senderUserId,
        senderName: params.senderName,
        text,
        effectiveClearance: params.inputScope?.sensitivity ?? params.room.effectiveClearance,
        compartments: params.inputScope?.compartments ?? params.room.contextCompartments,
        projectIds: params.inputScope?.projectIds ?? (params.room.contextProjectId ? [params.room.contextProjectId] : []),
        contextBindingOrigin: params.room.contextBindingOrigin ?? 'legacy',
        classificationMode: params.room.classificationMode ?? 'legacy',
      })
    }
  } catch (err) {
    // Ambient capture is asynchronous learning, not posting admission. Keep
    // the failure visible without discarding an already stored message.
    console.error('[channel-room] capture hook failed:', err)
  }
}

/** Is brain capture on for this room (D4)? Defaults on. */
export async function roomCaptureEnabled(roomId: string): Promise<boolean> {
  const row = (await query<{ capture: boolean }>('SELECT room_capture AS capture FROM sessions WHERE id = $1', [roomId])).rows[0]
  return row?.capture !== false
}

/** Switch a room's brain capture (D4). The caller has checked the admin role. */
export async function setRoomCapture(roomId: string, enabled: boolean): Promise<void> {
  await query(
    `UPDATE sessions s SET room_capture = $2 WHERE s.id = $1 AND ${sessionKindSql.channelRoom('s')} AND s.recording_revision IS NULL`,
    [roomId, enabled],
  )
}

/** Claim the room's one-time hydration from provider-visible history (D16). */
export async function claimRoomHydration(roomId: string): Promise<boolean> {
  const claimed = await query(
    'UPDATE sessions SET room_hydrated_at = now() WHERE id = $1 AND room_hydrated_at IS NULL RETURNING id',
    [roomId],
  )
  return claimed.rows.length > 0
}

/**
 * Display names for the room's speakers: member names from their profiles,
 * and guests by their platform handle (D1). The current sender's handle wins
 * when their profile has no name.
 */
export function roomSpeakerLabel(name: string | null | undefined, handle: string | null | undefined): string | null {
  const trimmed = name?.trim()
  if (trimmed) return trimmed
  const h = handle?.trim()
  return h ? h : null
}

/**
 * The un-addressed half of a room's inbound flow (§4.4, D4), for a route's
 * mention gate: when the group converges, persist the message as a room post
 * and report it handled; otherwise report
 * false and the route drops the message as before. Never runs a turn.
 */
export async function postPassiveChannelMessage(params: {
  assistant: { id: string; name: string; workspaceId?: string | null }
  channelType: string
  channelIntegrationId?: string | null
  isGroupChat: boolean
  /** The room's provider conversation (thread- or topic-qualified as today). */
  sessionChannelId: string
  senderUserId: string
  senderName: string | null
  text: string
  channelMessageId?: string | null
  replyToText?: string | null
  postNotice?: (text: string) => Promise<void>
}): Promise<boolean> {
  const binding = await resolveRoomBinding({
    assistant: params.assistant,
    channelType: params.channelType,
    channelIntegrationId: params.channelIntegrationId,
    isGroupChat: params.isGroupChat,
  })
  if (!binding) return false
  const { room } = await findOrCreateChannelRoom({
    ...binding,
    assistantId: params.assistant.id,
    channelType: params.channelType,
    channelId: params.sessionChannelId,
    starterUserId: params.senderUserId,
  })
  const audience = await resolveGroupAudienceSystem({ workspaceId: binding.workspaceId,
    assistantId: params.assistant.id, userId: params.senderUserId, channelType: params.channelType,
    channelId: params.sessionChannelId })
  if (!audience.allowed) throw new DeliveryAudienceUnverifiedError(audience.detail, audience.diagnostic)
  await postToChannelRoom({
    room,
    inputScope: roomInputScope(room, binding.workspaceId, audience.ceiling),
    workspaceId: binding.workspaceId,
    senderUserId: params.senderUserId,
    senderName: params.senderName,
    text: params.text,
    channelMessageId: params.channelMessageId,
    replyToText: params.replyToText,
  })
  return true
}

/** May this person answer a room turn's confirmation they did not address? (owner or admin) */
export async function isWorkspaceAdmin(userId: string, workspaceId: string): Promise<boolean> {
  const role = await getWorkspaceRoleSystem(userId, workspaceId, true)
  return role === 'owner' || role === 'admin'
}

const HISTORY_LINE_CHAR_CAP = 500
const HISTORY_CHAR_CAP = 12_000

/**
 * Format provider-visible history for a room's one-time hydration (D16). It
 * is untrusted text the group can already see, so it travels in the turn's
 * user-visible context envelope, bounded and labeled as such.
 */
export function formatProviderHistory(params: {
  transportLabel: string
  messages: Array<{ id: string; at: string; speaker: string; text: string }>
  excludeId?: string | null
}): string | null {
  const lines = [`# Recent ${params.transportLabel} messages`,
    'Coverage: the most recent messages the provider returned, before this conversation became a shared room.']
  let length = lines.join('\n\n').length
  let omitted = false
  for (const message of params.messages) {
    if (message.id === params.excludeId) continue
    const text = message.text.replace(/\s+/g, ' ').trim()
    if (!text) continue
    const clipped = text.length > HISTORY_LINE_CHAR_CAP ? `${text.slice(0, HISTORY_LINE_CHAR_CAP)}...` : text
    const line = `- [${message.at}] ${message.speaker}: ${clipped}`
    if (length + line.length + 2 > HISTORY_CHAR_CAP) { omitted = true; break }
    lines.push(line)
    length += line.length + 1
  }
  if (lines.length === 2) return null
  if (omitted) lines.push('[Older messages were omitted by the bounded reader.]')
  return lines.join('\n\n')
}

/**
 * The room an unattended delivery (a workflow `deliver` step, an A2A relay)
 * into a group should write to, so the group's later turns see what was posted
 * (§4.4). Null when the group has no room: the delivery keeps its per-user
 * session. A delivery never creates a room; the group's first message does.
 */
export async function findRoomForDelivery(params: {
  workspaceId: string
  channelType: string
  channelId: string
}): Promise<Session | null> {
  if (!transportPolicy(params.channelType as Transport).rooms.converge) return null
  return findChannelRoom(params)
}
