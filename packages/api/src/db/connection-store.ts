/**
 * Connection store — follow/follower model for assistants.
 *
 * follower follows following = follower can query following's data.
 * Status: pending (private account), accepted, blocked.
 *
 * Uses query() (not queryWithRLS) since connections cross user boundaries.
 * Auth checked at route level.
 *
 * See docs/plans/inter-assistant-communication.md.
 */

import { query } from './client.js'

// ── Types ──────────────────────────────────────────────────────

export type Connection = {
  id: string
  followerAssistantId: string
  followingAssistantId: string
  status: 'pending' | 'accepted' | 'blocked'
  /**
   * How this connection came to be:
   *   - 'user'      — explicit follow (handle search → follow). Trigger is
   *                   relevance-gated (bio + callerNote).
   *   - 'workspace' — auto-seeded primary→sibling edge (see
   *                   seedWorkspacePrimaryFollows). EXPLICIT-TRIGGER-ONLY:
   *                   the model must not speculatively delegate; only when
   *                   the user explicitly asks for that assistant's capability.
   * See docs/architecture/channels/inter-assistant.md → "Intra-workspace auto-follow".
   */
  origin: 'user' | 'workspace'
  /** Follower-side note: why this follower's owner follows the target. Used as a relevance hint by askAssistant. */
  callerNote: string | null
  /**
   * Mode binding. NULL = free (full access; see docs/architecture/integrations/a2a.md).
   * Set by the owner at follow-acceptance time or via setMode.
   */
  modeId: string | null
  createdAt: Date
  updatedAt: Date
  /** Joined fields for display. */
  followerAssistantName?: string
  followerOwnerHandle?: string
  followerIconSeed?: number
  followingAssistantName?: string
  followingOwnerHandle?: string
  followingBio?: string | null
  followingIconSeed?: number
}

/** For use in RETURNING clauses (no table alias) */
const RETURNING_COLUMNS = `
  id,
  follower_assistant_id AS "followerAssistantId",
  following_assistant_id AS "followingAssistantId",
  status,
  origin,
  caller_note AS "callerNote",
  mode_id AS "modeId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
` as const

/** For use in SELECT with table alias */
const CONNECTION_COLUMNS = `
  ac.id,
  ac.follower_assistant_id AS "followerAssistantId",
  ac.following_assistant_id AS "followingAssistantId",
  ac.status,
  ac.origin,
  ac.caller_note AS "callerNote",
  ac.mode_id AS "modeId",
  ac.created_at AS "createdAt",
  ac.updated_at AS "updatedAt"
` as const

const CONNECTION_COLUMNS_WITH_DETAILS = `
  ac.id,
  ac.follower_assistant_id AS "followerAssistantId",
  ac.following_assistant_id AS "followingAssistantId",
  ac.status,
  ac.origin,
  ac.caller_note AS "callerNote",
  ac.mode_id AS "modeId",
  ac.created_at AS "createdAt",
  ac.updated_at AS "updatedAt",
  follower_a.name AS "followerAssistantName",
  follower_u.handle AS "followerOwnerHandle",
  follower_a.icon_seed AS "followerIconSeed",
  following_a.name AS "followingAssistantName",
  following_u.handle AS "followingOwnerHandle",
  following_a.bio AS "followingBio",
  following_a.icon_seed AS "followingIconSeed"
` as const

// Team-owned assistants (post migration 089) have owner_user_id IS NULL
// and workspace_id set, so the user join must be LEFT to keep the row. The
// handle is null in that case; the API surface returns it as undefined
// and the UI falls back to the assistant name alone.
const JOINS = `
  JOIN assistants follower_a ON follower_a.id = ac.follower_assistant_id
  LEFT JOIN users follower_u ON follower_u.id = follower_a.owner_user_id
  JOIN assistants following_a ON following_a.id = ac.following_assistant_id
  LEFT JOIN users following_u ON following_u.id = following_a.owner_user_id
` as const

// ── Store ──────────────────────────────────────────────────────

export type ConnectionStore = {
  /** Follow an assistant. If target is public, auto-accepted. If private, pending. */
  follow(followerAssistantId: string, followingAssistantId: string, autoAccept?: boolean): Promise<Connection>

  /**
   * Idempotently seed the intra-workspace follow plane: the workspace's
   * `kind='primary'` assistant follows every other assistant in the same
   * workspace (accepted, origin='workspace'). Re-evaluates the full sibling
   * set on every call, so it is safe to call after any assistant is created,
   * adopted, or moved into the workspace. Never downgrades an existing
   * origin='user' follow and never unblocks a blocked edge (ON CONFLICT DO
   * NOTHING). No-op for workspaces without a primary or without siblings.
   * Returns the number of new edges created.
   * See docs/architecture/channels/inter-assistant.md → "Intra-workspace auto-follow".
   */
  seedWorkspacePrimaryFollows(workspaceId: string): Promise<number>
  /** Unfollow (remove connection). */
  unfollow(followerAssistantId: string, followingAssistantId: string): Promise<boolean>
  /**
   * Accept a pending follow request, optionally binding a mode at acceptance.
   * Pass `modeId = undefined` (or null) to accept as free (full access).
   */
  acceptRequest(connectionId: string, modeId?: string | null): Promise<Connection | null>

  /**
   * Owner-initiated mode change for an accepted connection.
   * Pass `modeId = null` to clear (= free).
   */
  setMode(connectionId: string, modeId: string | null): Promise<Connection | null>

  /**
   * Look up the mode_id bound to an accepted connection (follower=caller,
   * following=callee). Returns:
   *   - mode_id string when a mode is bound
   *   - null when the connection is accepted but no mode is bound (free)
   *   - undefined when no accepted connection exists (caller can't access)
   *
   * Used by the in-process A2A transport's mode-resolver.
   */
  getConnectionModeId(
    callerAssistantId: string,
    calleeAssistantId: string,
  ): Promise<string | null | undefined>
  /** Reject a pending follow request (deletes it). */
  rejectRequest(connectionId: string): Promise<boolean>
  /** Block an assistant from following you. */
  blockAssistant(myAssistantId: string, blockedAssistantId: string): Promise<Connection>
  /** Unblock a blocked assistant. */
  unblock(myAssistantId: string, blockedAssistantId: string): Promise<boolean>

  /** Who I follow (my outgoing, accepted). */
  getFollowing(assistantId: string): Promise<Connection[]>
  /** My outgoing pending requests. */
  getPendingOutgoing(assistantId: string): Promise<Connection[]>
  /** Who follows me (incoming, accepted). */
  getFollowers(assistantId: string): Promise<Connection[]>
  /** Mutual: both follow each other (accepted). */
  getMutuals(assistantId: string): Promise<Connection[]>
  /** Pending follow requests for my assistant. */
  getPendingRequests(assistantId: string): Promise<Connection[]>

  /** Check if follower has accepted access to following. */
  isFollowing(followerAssistantId: string, followingAssistantId: string): Promise<boolean>
  /** Check if blocked. */
  isBlocked(myAssistantId: string, otherAssistantId: string): Promise<boolean>

  /**
   * Set the follower's note on a connection. Pass null to clear.
   * Returns the updated connection or null if the caller does not own the follower assistant.
   * Auth (assistant membership) is checked at the route layer.
   */
  setCallerNote(connectionId: string, note: string | null): Promise<Connection | null>

  /** Count followers (accepted). */
  followerCount(assistantId: string): Promise<number>
  /** Count following (accepted). */
  followingCount(assistantId: string): Promise<number>
}

export function createConnectionStore(): ConnectionStore {
  return {
    async follow(followerAssistantId, followingAssistantId, autoAccept = true) {
      // Check if blocked
      const blocked = await query<{ id: string }>(
        `SELECT id FROM assistant_connections
         WHERE follower_assistant_id = $1 AND following_assistant_id = $2 AND status = 'blocked'`,
        [followerAssistantId, followingAssistantId],
      )
      if (blocked.rows.length > 0) {
        throw new Error('blocked')
      }

      const status = autoAccept ? 'accepted' : 'pending'
      // An explicit user follow always lands as origin='user'. If an
      // auto-seeded origin='workspace' edge already exists, this UPSERT
      // upgrades it to 'user' (the stronger, relevance-triggered plane) —
      // never the reverse: seedWorkspacePrimaryFollows uses DO NOTHING.
      const result = await query<Connection>(
        `INSERT INTO assistant_connections (follower_assistant_id, following_assistant_id, status, origin)
         VALUES ($1, $2, $3, 'user')
         ON CONFLICT (follower_assistant_id, following_assistant_id) DO UPDATE
           SET status = CASE
             WHEN assistant_connections.status = 'blocked' THEN assistant_connections.status
             ELSE EXCLUDED.status
           END,
           origin = 'user',
           updated_at = now()
         RETURNING ${RETURNING_COLUMNS}`,
        [followerAssistantId, followingAssistantId, status],
      )
      return result.rows[0]
    },

    async seedWorkspacePrimaryFollows(workspaceId) {
      // Set-based + idempotent. The primary follows every sibling in the
      // workspace; ON CONFLICT DO NOTHING protects existing user follows and
      // blocked edges. Uses query() (no RLS) — the follow graph crosses user
      // boundaries, same as every other method here.
      const result = await query(
        `INSERT INTO assistant_connections
           (follower_assistant_id, following_assistant_id, status, origin)
         SELECT p.id, a.id, 'accepted', 'workspace'
         FROM assistants p
         JOIN assistants a
           ON a.workspace_id = p.workspace_id
          AND a.id <> p.id
         WHERE p.kind = 'primary'
           AND p.workspace_id = $1
         ON CONFLICT (follower_assistant_id, following_assistant_id) DO NOTHING`,
        [workspaceId],
      )
      return result.rowCount ?? 0
    },

    async unfollow(followerAssistantId, followingAssistantId) {
      const result = await query(
        `DELETE FROM assistant_connections
         WHERE follower_assistant_id = $1 AND following_assistant_id = $2 AND status != 'blocked'`,
        [followerAssistantId, followingAssistantId],
      )
      return (result.rowCount ?? 0) > 0
    },

    async acceptRequest(connectionId, modeId) {
      const result = await query<Connection>(
        `UPDATE assistant_connections
         SET status = 'accepted',
             mode_id = $2,
             updated_at = now()
         WHERE id = $1 AND status = 'pending'
         RETURNING ${RETURNING_COLUMNS}`,
        [connectionId, modeId ?? null],
      )
      return result.rows[0] ?? null
    },

    async setMode(connectionId, modeId) {
      const result = await query<Connection>(
        `UPDATE assistant_connections
         SET mode_id = $2, updated_at = now()
         WHERE id = $1 AND status = 'accepted'
         RETURNING ${RETURNING_COLUMNS}`,
        [connectionId, modeId],
      )
      return result.rows[0] ?? null
    },

    async getConnectionModeId(callerAssistantId, calleeAssistantId) {
      const result = await query<{ modeId: string | null }>(
        `SELECT mode_id AS "modeId" FROM assistant_connections
         WHERE follower_assistant_id = $1
           AND following_assistant_id = $2
           AND status = 'accepted'`,
        [callerAssistantId, calleeAssistantId],
      )
      if (result.rows.length === 0) return undefined
      return result.rows[0].modeId
    },

    async rejectRequest(connectionId) {
      const result = await query(
        `DELETE FROM assistant_connections WHERE id = $1 AND status = 'pending'`,
        [connectionId],
      )
      return (result.rowCount ?? 0) > 0
    },

    async blockAssistant(myAssistantId, blockedAssistantId) {
      // Upsert: if they follow me, set to blocked. Otherwise create blocked entry.
      const result = await query<Connection>(
        `INSERT INTO assistant_connections (follower_assistant_id, following_assistant_id, status)
         VALUES ($1, $2, 'blocked')
         ON CONFLICT (follower_assistant_id, following_assistant_id) DO UPDATE
           SET status = 'blocked', updated_at = now()
         RETURNING ${RETURNING_COLUMNS}`,
        [blockedAssistantId, myAssistantId],
      )
      return result.rows[0]
    },

    async unblock(myAssistantId, blockedAssistantId) {
      const result = await query(
        `DELETE FROM assistant_connections
         WHERE follower_assistant_id = $1 AND following_assistant_id = $2 AND status = 'blocked'`,
        [blockedAssistantId, myAssistantId],
      )
      return (result.rowCount ?? 0) > 0
    },

    async getFollowing(assistantId) {
      const result = await query<Connection>(
        `SELECT ${CONNECTION_COLUMNS_WITH_DETAILS}
         FROM assistant_connections ac ${JOINS}
         WHERE ac.follower_assistant_id = $1 AND ac.status = 'accepted'
         ORDER BY ac.created_at DESC`,
        [assistantId],
      )
      return result.rows
    },

    async getPendingOutgoing(assistantId) {
      const result = await query<Connection>(
        `SELECT ${CONNECTION_COLUMNS_WITH_DETAILS}
         FROM assistant_connections ac ${JOINS}
         WHERE ac.follower_assistant_id = $1 AND ac.status = 'pending'
         ORDER BY ac.created_at DESC`,
        [assistantId],
      )
      return result.rows
    },

    async getFollowers(assistantId) {
      const result = await query<Connection>(
        `SELECT ${CONNECTION_COLUMNS_WITH_DETAILS}
         FROM assistant_connections ac ${JOINS}
         WHERE ac.following_assistant_id = $1 AND ac.status = 'accepted'
         ORDER BY ac.created_at DESC`,
        [assistantId],
      )
      return result.rows
    },

    async getMutuals(assistantId) {
      const result = await query<Connection>(
        `SELECT ${CONNECTION_COLUMNS_WITH_DETAILS}
         FROM assistant_connections ac ${JOINS}
         WHERE ac.follower_assistant_id = $1 AND ac.status = 'accepted'
           AND EXISTS (
             SELECT 1 FROM assistant_connections ac2
             WHERE ac2.follower_assistant_id = ac.following_assistant_id
               AND ac2.following_assistant_id = $1
               AND ac2.status = 'accepted'
           )
         ORDER BY ac.created_at DESC`,
        [assistantId],
      )
      return result.rows
    },

    async getPendingRequests(assistantId) {
      const result = await query<Connection>(
        `SELECT ${CONNECTION_COLUMNS_WITH_DETAILS}
         FROM assistant_connections ac ${JOINS}
         WHERE ac.following_assistant_id = $1 AND ac.status = 'pending'
         ORDER BY ac.created_at DESC`,
        [assistantId],
      )
      return result.rows
    },

    async isFollowing(followerAssistantId, followingAssistantId) {
      const result = await query<{ exists: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM assistant_connections
           WHERE follower_assistant_id = $1 AND following_assistant_id = $2 AND status = 'accepted'
         ) AS exists`,
        [followerAssistantId, followingAssistantId],
      )
      return result.rows[0].exists
    },

    async isBlocked(myAssistantId, otherAssistantId) {
      const result = await query<{ exists: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM assistant_connections
           WHERE follower_assistant_id = $1 AND following_assistant_id = $2 AND status = 'blocked'
         ) AS exists`,
        [otherAssistantId, myAssistantId],
      )
      return result.rows[0].exists
    },

    async followerCount(assistantId) {
      const result = await query<{ count: string }>(
        `SELECT COUNT(*)::text FROM assistant_connections
         WHERE following_assistant_id = $1 AND status = 'accepted'`,
        [assistantId],
      )
      return parseInt(result.rows[0].count, 10)
    },

    async followingCount(assistantId) {
      const result = await query<{ count: string }>(
        `SELECT COUNT(*)::text FROM assistant_connections
         WHERE follower_assistant_id = $1 AND status = 'accepted'`,
        [assistantId],
      )
      return parseInt(result.rows[0].count, 10)
    },

    async setCallerNote(connectionId, note) {
      const trimmed = note === null ? null : note.trim().slice(0, 500) || null
      const result = await query<Connection>(
        `UPDATE assistant_connections
         SET caller_note = $2, updated_at = now()
         WHERE id = $1
         RETURNING ${RETURNING_COLUMNS}`,
        [connectionId, trimmed],
      )
      return result.rows[0] ?? null
    },
  }
}
