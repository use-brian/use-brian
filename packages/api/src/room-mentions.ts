/**
 * Room human `@mention` resolver + recorder (docs/plans/room-human-mentions.md).
 *
 * `@Jane Doe` in a workspace room writes a durable, clearance-safe Inbox row
 * for Jane; it is inert to the turn machinery (D-H2) — assistant addressing
 * stays exactly what `detectRoomAddress` / `roomResponseGroup` already decide
 * elsewhere. This module is the ONE place that partitions a room message's
 * `@mentions` into notifiable members vs. below-clearance-and-unreachable
 * ones (T-H1), and the ONE place that writes/retracts the resulting rows, so
 * the three call sites (`POST /:id/messages`, `POST /api/chat`,
 * `PATCH /:id/messages/:messageId`) can't drift.
 *
 * Deliberately imports only `./db/client.js` (raw `query`) and
 * `./db/doc-notifications-store.js` (the room-mention store, itself only
 * dependent on `client.js`) — NOT `./db/users.js` or `./db/workspace-store.js`.
 * Several route tests mock those two modules with partial export lists
 * (no `listAccessibleAssistants` / `createWorkspaceStore`); pulling them in
 * here would make `chat.ts`/`sessions.ts` import chains resolve `undefined`
 * factories in suites that never intended to exercise room mentions. Roster
 * rows are fetched with two direct, narrow queries instead (see
 * `fetchRoomMentionRosters`), and defensively filtered — several existing
 * route tests stub `client.js`'s `query()` with a single canned row shape
 * for EVERY call, so a roster query can come back with a row that has no
 * usable `name`; treating that as "no such target" (not a crash) is what
 * keeps this addition invisible to suites that don't mock it.
 *
 * [COMP:api/room-mentions]
 */

import type { Sensitivity } from '@use-brian/core'
import { canRead } from '@use-brian/core'
import {
  resolveMentionSpans,
  MAX_ROOM_RESPONDERS,
  type MentionSpan,
} from '@use-brian/shared/mention-matching'
import { query } from './db/client.js'
import { createDbDocNotificationsStore } from './db/doc-notifications-store.js'

const docNotificationsStore = createDbDocNotificationsStore()

// ── Rosters ──────────────────────────────────────────────────────

export type RoomMentionAssistant = { id: string; name: string }
export type RoomMentionMember = { id: string; name: string; clearance: Sensitivity }

type RoomMentionCandidate =
  | ({ mentionKind: 'assistant' } & RoomMentionAssistant)
  | ({ mentionKind: 'member' } & RoomMentionMember)

/**
 * The room's assistant + member rosters, straight off the DB — the workspace
 * assistant list (not access-filtered: every workspace member reaches every
 * workspace assistant, so filtering by the actor is a no-op that would just
 * add a dependency on `listAccessibleAssistants`) and every workspace member
 * with their clearance (system read — full-roster visibility, same shape as
 * `WorkspaceStore.listMembers`, reimplemented narrowly here per the module
 * header's import-surface note).
 *
 * Rows missing a usable id/name are dropped rather than passed to the
 * matcher, which would throw on `undefined.trim()`.
 */
/**
 * Exported for `GET /api/sessions/:id/mentionable` (T-H4), which needs the
 * SAME two rosters this module resolves mentions against — reusing this
 * keeps the roster query and the matcher's roster from drifting apart.
 */
export async function fetchRoomMentionRosters(
  workspaceId: string,
): Promise<{ assistants: RoomMentionAssistant[]; members: RoomMentionMember[] }> {
  const [assistantRows, memberRows] = await Promise.all([
    query<{ id: string; name: string | null }>(
      `SELECT id, name FROM assistants WHERE workspace_id = $1`,
      [workspaceId],
    ),
    query<{ id: string; name: string | null; clearance: Sensitivity | null }>(
      `SELECT wm.user_id AS id, u.name AS name, wm.clearance
         FROM workspace_members wm
         JOIN users u ON u.id = wm.user_id
        WHERE wm.workspace_id = $1`,
      [workspaceId],
    ),
  ])
  const assistants = assistantRows.rows.filter(
    (r): r is { id: string; name: string } =>
      typeof r.id === 'string' && typeof r.name === 'string' && r.name.trim().length > 0,
  )
  const members = memberRows.rows.filter(
    (r): r is { id: string; name: string; clearance: Sensitivity } =>
      typeof r.id === 'string' &&
      typeof r.name === 'string' &&
      r.name.trim().length > 0 &&
      (r.clearance === 'public' || r.clearance === 'internal' || r.clearance === 'confidential'),
  )
  return { assistants, members }
}

// ── Pure resolver (T-H1/T-H5) ───────────────────────────────────

export type RoomMentionResolution = {
  /**
   * Members to notify: clearance-passing, self-mention dropped, deduped,
   * capped at MAX_ROOM_RESPONDERS, in textual order.
   */
  memberIds: string[]
  /**
   * Members whose full display name WAS matched in the text but who fail the
   * room's clearance — the sender-facing "could not be reached" note (D-H4).
   * No `preview` text is ever built for these; the caller records nothing.
   */
  unreachable: { id: string; name: string }[]
  /**
   * Distinct assistants matched in the text, in textual order. Informational
   * only — assistant turn routing stays `detectRoomAddress` /
   * `roomResponseGroup`'s job, not this resolver's; exposed so a caller that
   * wants to reason about "who did this message address" doesn't need a
   * second pass over the roster.
   */
  assistants: RoomMentionAssistant[]
}

/**
 * Pure partition of a room message's `@mentions` (T-H1/T-H5).
 *
 * Assistants are ordered first in the merged roster: `resolveMentionSpans`'s
 * sort is stable, so on an exact name tie the assistant candidate (pushed
 * into its internal list first) wins over the member candidate (D-H3) — a
 * teammate can never silently swallow a turn.
 */
export function resolveRoomMentions(params: {
  text: string
  actorUserId: string
  assistants: RoomMentionAssistant[]
  members: RoomMentionMember[]
  /** The room's `sessions.effective_clearance`. Null/undefined gates nobody
   *  (mirrors `gateSessionRead`'s own guard). */
  sessionClearance: Sensitivity | null | undefined
}): RoomMentionResolution {
  const roster: RoomMentionCandidate[] = [
    ...params.assistants.map((a): RoomMentionCandidate => ({ ...a, mentionKind: 'assistant' })),
    ...params.members.map((m): RoomMentionCandidate => ({ ...m, mentionKind: 'member' })),
  ]
  const spans: MentionSpan<RoomMentionCandidate>[] = resolveMentionSpans(params.text, roster)

  const memberIds: string[] = []
  const unreachable: { id: string; name: string }[] = []
  const assistants: RoomMentionAssistant[] = []
  const seenMembers = new Set<string>()
  const seenAssistants = new Set<string>()

  for (const span of spans) {
    const target = span.assistant
    if (target.mentionKind === 'assistant') {
      if (!seenAssistants.has(target.id)) {
        seenAssistants.add(target.id)
        assistants.push({ id: target.id, name: target.name })
      }
      continue
    }
    if (target.id === params.actorUserId) continue // self-mention (both partitions)
    if (seenMembers.has(target.id)) continue
    seenMembers.add(target.id)
    const reachable = !params.sessionClearance || canRead(target.clearance, params.sessionClearance)
    if (!reachable) {
      unreachable.push({ id: target.id, name: target.name })
      continue
    }
    if (memberIds.length < MAX_ROOM_RESPONDERS) memberIds.push(target.id)
  }

  return { memberIds, unreachable, assistants }
}

// ── Recording (T-H2/T-H6) ───────────────────────────────────────

export type RecordRoomMentionsResult = {
  /** Members actually notified this call — the hook payload for badge fan-out. */
  recipientUserIds: string[]
  /** D-H4's sender-facing "could not be reached" note. */
  unreachable: { id: string; name: string }[]
}

/** Trim a preview to a single-line 160-char snippet — mirrors the store's
 *  private `clampPreview`, duplicated here only for the unchanged-name
 *  preview-only refresh path below, which cannot go through the store. */
function clampPreview(preview: string): string {
  const clean = preview.replace(/\s+/g, ' ').trim()
  return clean ? clean.slice(0, 160) : ''
}

/**
 * Resolve + record room mentions for a NEWLY CREATED session message
 * (T-H1/T-H2). Call exactly once per row creation — never once per POST:
 * the multi-assistant fan-out (T9) sends one POST per assistant target, but
 * only the first creates the row (`roomResponseGroup.sourceMessageId`), and
 * only that POST should call this.
 */
export async function recordRoomMentionsForMessage(params: {
  workspaceId: string
  sessionId: string
  sessionMessageId: string
  text: string
  actorUserId: string
  sessionClearance: Sensitivity | null | undefined
}): Promise<RecordRoomMentionsResult> {
  const { assistants, members } = await fetchRoomMentionRosters(params.workspaceId)
  const resolved = resolveRoomMentions({
    text: params.text,
    actorUserId: params.actorUserId,
    assistants,
    members,
    sessionClearance: params.sessionClearance,
  })
  if (resolved.memberIds.length === 0) {
    return { recipientUserIds: [], unreachable: resolved.unreachable }
  }
  await docNotificationsStore.recordRoomMentions({
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    sessionMessageId: params.sessionMessageId,
    sessionClearance: params.sessionClearance,
    actorUserId: params.actorUserId,
    recipientUserIds: resolved.memberIds,
    preview: params.text,
  })
  return { recipientUserIds: resolved.memberIds, unreachable: resolved.unreachable }
}

export type ReconcileRoomMentionsResult = {
  /** Newly notified this edit (genuinely new, or re-added after having been
   *  read — the store's ON CONFLICT re-surfaces that same row). */
  added: string[]
  /** Retracted this edit (deletes only an UNREAD row; a read row survives
   *  per the store, and therefore is NOT in this list even though its name
   *  left the text — D-H6). */
  removed: string[]
  unreachable: { id: string; name: string }[]
}

/**
 * D-H6 diff-reconcile for an in-place room-message edit.
 *
 * Resolves both `oldText` (the row's text immediately before this edit) and
 * `newText` against the SAME rosters, then:
 *  - a name newly present → `recordRoomMentions` (covers both a genuinely
 *    new mention and a "re-add a name whose row was already read" re-surface
 *    — the store's `ON CONFLICT … DO UPDATE SET read_at = NULL` handles
 *    both identically, since neither has an existing row keyed by the CURRENT
 *    (oldText-resolved) mention set)
 *  - a name present in both → left alone except its `preview`, refreshed by
 *    a direct UPDATE that does NOT touch `read_at`. This deliberately does
 *    NOT call `recordRoomMentions` for these: that call's ON CONFLICT always
 *    clears `read_at`, which would incorrectly re-surface an already-read
 *    mention that was never removed. (Owed consolidation: a
 *    `refreshRoomMentionPreviews` store method would let this become a
 *    single call like the plan's phrasing suggests; not built because
 *    `doc-notifications-store.ts` is out of scope for this slice.)
 *  - a name no longer present → `retractRoomMentions` (deletes only while
 *    unread; a read row survives, per the store)
 */
export async function reconcileRoomMentionsForEdit(params: {
  workspaceId: string
  sessionId: string
  sessionMessageId: string
  oldText: string
  newText: string
  actorUserId: string
  sessionClearance: Sensitivity | null | undefined
}): Promise<ReconcileRoomMentionsResult> {
  const { assistants, members } = await fetchRoomMentionRosters(params.workspaceId)
  const resolveFor = (text: string) =>
    resolveRoomMentions({
      text,
      actorUserId: params.actorUserId,
      assistants,
      members,
      sessionClearance: params.sessionClearance,
    })
  const oldResolved = resolveFor(params.oldText)
  const newResolved = resolveFor(params.newText)

  const oldIds = new Set(oldResolved.memberIds)
  const newIds = new Set(newResolved.memberIds)
  const added = newResolved.memberIds.filter((id) => !oldIds.has(id))
  const removed = oldResolved.memberIds.filter((id) => !newIds.has(id))
  const unchanged = newResolved.memberIds.filter((id) => oldIds.has(id))

  if (added.length > 0) {
    await docNotificationsStore.recordRoomMentions({
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      sessionMessageId: params.sessionMessageId,
      sessionClearance: params.sessionClearance,
      actorUserId: params.actorUserId,
      recipientUserIds: added,
      preview: params.newText,
    })
  }
  if (removed.length > 0) {
    await docNotificationsStore.retractRoomMentions({
      sessionMessageId: params.sessionMessageId,
      recipientUserIds: removed,
    })
  }
  if (unchanged.length > 0) {
    await query(
      `UPDATE doc_notifications
          SET preview = $1
        WHERE session_message_id = $2 AND recipient_user_id = ANY($3::uuid[])`,
      [clampPreview(params.newText), params.sessionMessageId, unchanged],
    )
  }

  return { added, removed, unreachable: newResolved.unreachable }
}
