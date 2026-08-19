/**
 * Custom channel bridge store — migration 450.
 *
 * Two internal-path tables (no RLS; keyed by channel and reachable only
 * through the bridge token or the workspace member routes, like
 * `wechat_context_tokens`):
 *
 *   custom_channel_bridge_state — the last `PUT /state` the bridge published
 *     plus `last_seen_at`. Studio derives `online` from `last_seen_at`
 *     (stale after 90 s) regardless of the published status: a `connected`
 *     from a bridge that stopped polling is not connected.
 *   custom_channel_outbox — DB-backed work queue the bridge long-polls.
 *     `claim` leases items for 60 s (at-least-once: an unacked item reappears
 *     after the lease); `ack` settles them; items expire 24 h unacked so a
 *     dead bridge never fires a year of replies on resurrection.
 *
 * See docs/architecture/channels/custom-channel.md → "Data".
 * Component tag: [COMP:api/custom-channel-store].
 */

import { query } from './client.js'

/** A bridge is "online" while its last_seen_at is younger than this. */
export const BRIDGE_ONLINE_WINDOW_MS = 90_000
/** Outbox lease granted to a claim — an unacked item reappears after this. */
export const OUTBOX_LEASE_SECONDS = 60

export type BridgeStatus = 'connecting' | 'needs_action' | 'connected' | 'disconnected' | 'error'

export type BridgeAction =
  | { kind: 'qr'; imageDataUrl?: string; url?: string; text?: string; expiresAt?: string }
  | { kind: 'input'; prompt: string; inputKind: 'numeric' | 'text'; requestId: string }
  | { kind: 'confirm_on_device'; message: string }

export type CustomChannelBridgeState = {
  status: BridgeStatus
  message?: string
  accountLabel?: string
  action?: BridgeAction
  bridgeVersion?: string
}

export type CustomChannelStateView = CustomChannelBridgeState & {
  channelId: string
  lastSeenAt: string | null
  updatedAt: string | null
  /** Derived: last_seen_at within BRIDGE_ONLINE_WINDOW_MS. */
  online: boolean
  /** Unacked, unexpired outbox items. */
  outboxDepth: number
}

export type OutboxItemType = 'message' | 'typing' | 'input' | 'disconnect'

export type OutboxEnqueueInput = {
  type: OutboxItemType
  /** Conversation the item targets; null for channel-level items (input / disconnect). */
  peerId: string | null
  payload: Record<string, unknown>
}

export type ClaimedOutboxItem = {
  id: string
  type: OutboxItemType
  peerId: string | null
  payload: Record<string, unknown>
  createdAt: string
}

export type OutboxAckResult = {
  id: string
  ok: boolean
  error?: string | null
  providerMessageId?: string | null
}

export type CustomChannelStore = {
  /** Idempotent upsert of the published state; also bumps last_seen_at. */
  putState(channelId: string, state: CustomChannelBridgeState): Promise<void>
  /** Last published state + lastSeenAt + online + outbox depth; null when nothing was ever published. */
  getState(channelId: string, now?: Date): Promise<CustomChannelStateView | null>
  /** Bump last_seen_at (long-poll / heartbeat); creates the row if missing. */
  touchSeen(channelId: string): Promise<void>
  /** Append an outbox item; returns its id (the channel message id for `message`). */
  enqueue(channelId: string, item: OutboxEnqueueInput): Promise<string>
  /** Lease up to `limit` claimable items for OUTBOX_LEASE_SECONDS (at-least-once). */
  claim(channelId: string, limit: number): Promise<ClaimedOutboxItem[]>
  /** Settle leased items; `ok:false` marks failed (never retried by us). Returns settled count. */
  ack(channelId: string, results: OutboxAckResult[]): Promise<number>
  /** Delete unacked items past expires_at; returns the dropped count (logged + counted by the caller). */
  expireStale(channelId?: string): Promise<Array<{ channelId: string; count: number }>>
}

type StateRow = {
  channel_id: string
  status: BridgeStatus
  message: string | null
  account_label: string | null
  action: BridgeAction | null
  bridge_version: string | null
  last_seen_at: Date | string | null
  updated_at: Date | string | null
  outbox_depth: string | number | null
}

type OutboxRow = {
  id: string
  item_type: OutboxItemType
  peer_id: string | null
  payload: Record<string, unknown>
  created_at: Date | string
}

function iso(value: Date | string | null | undefined): string | null {
  if (value == null) return null
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

export function createCustomChannelStore(): CustomChannelStore {
  return {
    async putState(channelId, state) {
      await query(
        `INSERT INTO custom_channel_bridge_state
           (channel_id, status, message, account_label, action, bridge_version, last_seen_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, now(), now())
         ON CONFLICT (channel_id) DO UPDATE SET
           status = EXCLUDED.status,
           message = EXCLUDED.message,
           account_label = EXCLUDED.account_label,
           action = EXCLUDED.action,
           bridge_version = EXCLUDED.bridge_version,
           last_seen_at = now(),
           updated_at = now()`,
        [
          channelId,
          state.status,
          state.message ?? null,
          state.accountLabel ?? null,
          state.action ? JSON.stringify(state.action) : null,
          state.bridgeVersion ?? null,
        ],
      )
    },

    async getState(channelId, now = new Date()) {
      const result = await query<StateRow>(
        `SELECT s.channel_id, s.status, s.message, s.account_label, s.action, s.bridge_version,
                s.last_seen_at, s.updated_at,
                (SELECT count(*) FROM custom_channel_outbox o
                  WHERE o.channel_id = s.channel_id AND o.acked_at IS NULL AND o.expires_at > now()) AS outbox_depth
           FROM custom_channel_bridge_state s
          WHERE s.channel_id = $1`,
        [channelId],
      )
      const row = result.rows[0]
      if (!row) return null
      const lastSeenAt = iso(row.last_seen_at)
      const online = lastSeenAt != null && now.getTime() - Date.parse(lastSeenAt) < BRIDGE_ONLINE_WINDOW_MS
      return {
        channelId: row.channel_id,
        status: row.status,
        message: row.message ?? undefined,
        accountLabel: row.account_label ?? undefined,
        action: row.action ?? undefined,
        bridgeVersion: row.bridge_version ?? undefined,
        lastSeenAt,
        updatedAt: iso(row.updated_at),
        online,
        outboxDepth: Number(row.outbox_depth ?? 0),
      }
    },

    async touchSeen(channelId) {
      await query(
        `INSERT INTO custom_channel_bridge_state (channel_id, last_seen_at)
         VALUES ($1, now())
         ON CONFLICT (channel_id) DO UPDATE SET last_seen_at = now()`,
        [channelId],
      )
    },

    async enqueue(channelId, item) {
      const result = await query<{ id: string }>(
        `INSERT INTO custom_channel_outbox (channel_id, peer_id, item_type, payload)
         VALUES ($1, $2, $3, $4::jsonb)
         RETURNING id`,
        [channelId, item.peerId, item.type, JSON.stringify(item.payload)],
      )
      return result.rows[0].id
    },

    async claim(channelId, limit) {
      const result = await query<OutboxRow>(
        `UPDATE custom_channel_outbox
            SET leased_until = now() + make_interval(secs => $3)
          WHERE id IN (
            SELECT id FROM custom_channel_outbox
             WHERE channel_id = $1
               AND acked_at IS NULL
               AND (leased_until IS NULL OR leased_until < now())
               AND expires_at > now()
             ORDER BY created_at
             LIMIT $2
             FOR UPDATE SKIP LOCKED
          )
          RETURNING id, item_type, peer_id, payload, created_at`,
        [channelId, limit, OUTBOX_LEASE_SECONDS],
      )
      return result.rows
        .map((r) => ({
          id: r.id,
          type: r.item_type,
          peerId: r.peer_id,
          payload: r.payload,
          createdAt: iso(r.created_at) ?? new Date().toISOString(),
        }))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    },

    async ack(channelId, results) {
      let settled = 0
      for (const r of results) {
        const result = await query(
          `UPDATE custom_channel_outbox
              SET acked_at = now(), ok = $3, error = $4, provider_message_id = $5
            WHERE channel_id = $1 AND id = $2 AND acked_at IS NULL`,
          [channelId, r.id, r.ok, r.ok ? null : (r.error ?? null), r.providerMessageId ?? null],
        )
        settled += result.rowCount ?? 0
      }
      return settled
    },

    async expireStale(channelId) {
      const result = await query<{ channel_id: string; count: string | number }>(
        channelId
          ? `WITH dropped AS (
               DELETE FROM custom_channel_outbox
                WHERE channel_id = $1 AND acked_at IS NULL AND expires_at <= now()
                RETURNING channel_id)
             SELECT channel_id, count(*) AS count FROM dropped GROUP BY channel_id`
          : `WITH dropped AS (
               DELETE FROM custom_channel_outbox
                WHERE acked_at IS NULL AND expires_at <= now()
                RETURNING channel_id)
             SELECT channel_id, count(*) AS count FROM dropped GROUP BY channel_id`,
        channelId ? [channelId] : [],
      )
      return result.rows.map((r) => ({ channelId: r.channel_id, count: Number(r.count) }))
    },
  }
}
