/**
 * Connection store — the assistant follow graph.
 *
 * follower follows following = follower can consult following via
 * askAssistant. Post the 2026-07-24 network teardown the graph is
 * workspace-internal only: the single writer is the idempotent
 * `seedWorkspacePrimaryFollows` (primary → sibling, accepted,
 * origin='workspace'), and the readers are the in-process A2A tools
 * (listConnectedAssistants / askAssistant). There is no follow UI, no
 * pending/accept lifecycle, and no cross-workspace edge.
 *
 * Uses query() (not queryWithRLS) since connections cross user boundaries.
 *
 * See docs/architecture/channels/inter-assistant.md.
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
   *   - 'user'      — legacy explicit follow (the follow UI is retired; rows
   *                   may persist). Trigger is relevance-gated (bio + callerNote).
   *   - 'workspace' — auto-seeded primary→sibling edge (see
   *                   seedWorkspacePrimaryFollows). EXPLICIT-TRIGGER-ONLY:
   *                   the model must not speculatively delegate; only when
   *                   the user explicitly asks for that assistant's capability.
   * See docs/architecture/channels/inter-assistant.md → "Intra-workspace auto-follow".
   */
  origin: 'user' | 'workspace'
  /** Follower-side note: why this follower's owner follows the target. Used as a relevance hint by askAssistant. */
  callerNote: string | null
  createdAt: Date
  updatedAt: Date
  /** Joined fields for display. */
  followingAssistantName?: string
  followingOwnerHandle?: string
  followingBio?: string | null
  followingIconSeed?: number
}

const CONNECTION_COLUMNS_WITH_DETAILS = `
  ac.id,
  ac.follower_assistant_id AS "followerAssistantId",
  ac.following_assistant_id AS "followingAssistantId",
  ac.status,
  ac.origin,
  ac.caller_note AS "callerNote",
  ac.created_at AS "createdAt",
  ac.updated_at AS "updatedAt",
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
  JOIN assistants following_a ON following_a.id = ac.following_assistant_id
  LEFT JOIN users following_u ON following_u.id = following_a.owner_user_id
` as const

// ── Store ──────────────────────────────────────────────────────

export type ConnectionStore = {
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

  /** Who I follow (my outgoing, accepted). */
  getFollowing(assistantId: string): Promise<Connection[]>

  /** Check if follower has accepted access to following. */
  isFollowing(followerAssistantId: string, followingAssistantId: string): Promise<boolean>
}

export function createConnectionStore(): ConnectionStore {
  return {
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
  }
}
