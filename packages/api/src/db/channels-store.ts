/**
 * Channels store — workspace-owned channel installs + per-surface routing.
 *
 * Two tables (migration 153):
 *   - `channels`           — the workspace-owned connection (Slack install,
 *                            Telegram / WhatsApp bot). Owns clearance, the
 *                            enabled capability set, status, display name.
 *   - `channel_assistants` — routes chat per external surface. A row with
 *                            `external_surface_id = NULL` is the channel's
 *                            default (catch-all) assistant; a non-null row
 *                            routes one Slack channel / Telegram chat /
 *                            WhatsApp chat.
 *
 * Credentials stay on `channel_integrations`, which now links here via its
 * `channel_id` FK. This store never touches credentials.
 *
 * RLS posture — two access modes, deliberately:
 *   - User-facing reads/writes go through `queryWithRLS`. Migration 153's
 *     `channels_workspace_member` policy gates on workspace membership AND
 *     `sensitivity_rank(clearance) <= sensitivity_rank(member.clearance)`.
 *     The policy is `FOR ALL`, so its `USING` expression also serves as the
 *     INSERT/UPDATE `WITH CHECK` — a member therefore cannot create or raise
 *     a channel above their own clearance (the self-lockout guard from the
 *     migration plan is enforced by the policy, not by app code).
 *   - The inbound webhook hot path uses bare `query()`. It runs before the
 *     user is authenticated; upstream signature verification is the gate —
 *     same posture as `channel-integrations.ts`'s `getByChannelForWebhook`.
 *
 * See docs/architecture/channels/adapter-pattern.md.
 * Component tag: [COMP:channels/store].
 */

import { getPool, query, queryWithRLS } from './client.js'

// ── Types ──────────────────────────────────────────────────────

export type ChannelType = 'telegram' | 'slack' | 'whatsapp' | 'discord'
export type ChannelClearance = 'public' | 'internal' | 'confidential'
export type ChannelCapability = 'chat' | 'broadcast' | 'ingest'
export type ChannelStatus = 'active' | 'revoked' | 'invalid'
export type ChannelModelAlias = 'standard' | 'pro' | 'max'

export type Channel = {
  id: string
  workspaceId: string
  channelType: ChannelType
  clearance: ChannelClearance
  enabledCapabilities: ChannelCapability[]
  status: ChannelStatus
  displayName: string
  createdAt: Date
  updatedAt: Date
}

export type ChannelAssistant = {
  id: string
  channelId: string
  assistantId: string
  /** Slack channel / Telegram chat / WhatsApp chat ID. NULL = channel default. */
  externalSurfaceId: string | null
  /**
   * Per-routing model tier (migration 197). The webhook routes read this
   * for the resolved routing row instead of the per-assistant
   * `assistants.*_model_alias` column. Defaults to 'pro' for fresh rows
   * (migration 234); backfilled from the assistant's platform-specific default.
   */
  modelAlias: ChannelModelAlias
  createdAt: Date
}

/**
 * Per-platform capability availability — the set a channel of each type *can*
 * enable. A new channel's `enabled_capabilities` defaults to the full set;
 * `ingest` is the operator-toggleable one (Slack only — open question 4).
 * Mirrors the platform defaults the Phase B backfill (migration 154) used.
 */
export const CHANNEL_CAPABILITIES: Record<ChannelType, ChannelCapability[]> = {
  slack: ['chat', 'broadcast', 'ingest'],
  telegram: ['chat', 'broadcast'],
  whatsapp: ['chat', 'broadcast'],
  discord: ['chat', 'broadcast'],
}

/**
 * The `assistants` column holding a channel's default model tier, or null for
 * channels with no per-platform column (Discord — migration 258 added the
 * channel type but no `discord_model_alias`, so it seeds from the 'pro' default
 * like every other fresh routing row).
 */
function modelAliasColumnFor(channelType: ChannelType): string | null {
  switch (channelType) {
    case 'slack':
      return 'slack_model_alias'
    case 'telegram':
      return 'telegram_model_alias'
    case 'whatsapp':
      return 'whatsapp_model_alias'
    case 'discord':
      return null
  }
}

// ── Column aliases ─────────────────────────────────────────────

const CHANNEL_COLS = `
  id, workspace_id as "workspaceId", channel_type as "channelType",
  clearance, enabled_capabilities as "enabledCapabilities",
  status, display_name as "displayName",
  created_at as "createdAt", updated_at as "updatedAt"
`

const CHANNEL_ASSISTANT_COLS = `
  id, channel_id as "channelId", assistant_id as "assistantId",
  external_surface_id as "externalSurfaceId",
  model_alias as "modelAlias",
  created_at as "createdAt"
`

// ── Webhook hot path (system-level, no RLS) ────────────────────

/**
 * Fetch a channel by id for the inbound webhook hot path. System-level
 * (no RLS) — the webhook resolves a channel before any user is known.
 * Returns null if the channel no longer exists.
 */
export async function getChannelForWebhook(channelId: string): Promise<Channel | null> {
  const result = await query<Channel>(
    `SELECT ${CHANNEL_COLS} FROM channels WHERE id = $1 LIMIT 1`,
    [channelId],
  )
  return result.rows[0] ?? null
}

/**
 * Resolve which routing row answers on a given external surface.
 *
 * Surface-specific routing wins; the `external_surface_id IS NULL` row is
 * the channel's catch-all default. Returns null when neither a matching
 * surface row nor a default exists — i.e. the channel has no chat routing
 * (a broadcast-only channel, or one not yet configured).
 *
 * Pure so the routing rule can be unit-tested without a database. The
 * `pickAssistantForSurface` shim below preserves the older "just the
 * assistantId" contract for callers that don't need the model alias.
 */
export function pickRoutingForSurface(
  rows: ChannelAssistant[],
  externalSurfaceId: string | null,
): ChannelAssistant | null {
  if (externalSurfaceId !== null) {
    const surfaceMatch = rows.find((r) => r.externalSurfaceId === externalSurfaceId)
    if (surfaceMatch) return surfaceMatch
  }
  return rows.find((r) => r.externalSurfaceId === null) ?? null
}

export function pickAssistantForSurface(
  rows: ChannelAssistant[],
  externalSurfaceId: string | null,
): string | null {
  return pickRoutingForSurface(rows, externalSurfaceId)?.assistantId ?? null
}

/**
 * Webhook routing resolution: load a channel's `channel_assistants` rows and
 * pick the routing row for `externalSurfaceId`. System-level (no RLS) — runs
 * on the pre-auth webhook path. Returns the full routing row so callers can
 * read `modelAlias` for the per-routing model tier.
 */
export async function resolveRoutingForSurface(
  channelId: string,
  externalSurfaceId: string | null,
): Promise<ChannelAssistant | null> {
  const result = await query<ChannelAssistant>(
    `SELECT ${CHANNEL_ASSISTANT_COLS} FROM channel_assistants WHERE channel_id = $1`,
    [channelId],
  )
  return pickRoutingForSurface(result.rows, externalSurfaceId)
}

export async function resolveAssistantForSurface(
  channelId: string,
  externalSurfaceId: string | null,
): Promise<string | null> {
  const result = await query<ChannelAssistant>(
    `SELECT ${CHANNEL_ASSISTANT_COLS} FROM channel_assistants WHERE channel_id = $1`,
    [channelId],
  )
  return pickAssistantForSurface(result.rows, externalSurfaceId)
}

// ── Channel reads (RLS-gated) ──────────────────────────────────

/** List the channels in a workspace the acting user is cleared to see. */
export async function listChannelsForWorkspace(
  userId: string,
  workspaceId: string,
): Promise<Channel[]> {
  const result = await queryWithRLS<Channel>(
    userId,
    `SELECT ${CHANNEL_COLS} FROM channels
     WHERE workspace_id = $1
     ORDER BY created_at ASC`,
    [workspaceId],
  )
  return result.rows
}

/**
 * Fetch one channel. Returns null if it doesn't exist OR the acting user is
 * not cleared to see it — callers cannot distinguish, which is the intended
 * RLS behavior.
 */
export async function getChannelForUser(
  userId: string,
  channelId: string,
): Promise<Channel | null> {
  const result = await queryWithRLS<Channel>(
    userId,
    `SELECT ${CHANNEL_COLS} FROM channels WHERE id = $1 LIMIT 1`,
    [channelId],
  )
  return result.rows[0] ?? null
}

// ── Channel writes (RLS-gated) ─────────────────────────────────

/**
 * Partial-update a channel. RLS gates the write; raising `clearance` above
 * the acting user's own tier is rejected by the policy's `WITH CHECK`.
 * `updated_at` is bumped by the `channels_set_updated_at` trigger. Returns
 * null if the row doesn't exist or isn't visible to the user; an empty
 * `fields` is a no-op that returns the current row.
 */
export async function updateChannel(
  userId: string,
  channelId: string,
  fields: {
    clearance?: ChannelClearance
    enabledCapabilities?: ChannelCapability[]
    status?: ChannelStatus
    displayName?: string
  },
): Promise<Channel | null> {
  const sets: string[] = []
  const values: unknown[] = []
  let idx = 1

  if (fields.clearance !== undefined) {
    sets.push(`clearance = $${idx}`)
    values.push(fields.clearance)
    idx++
  }
  if (fields.enabledCapabilities !== undefined) {
    sets.push(`enabled_capabilities = $${idx}`)
    values.push(fields.enabledCapabilities)
    idx++
  }
  if (fields.status !== undefined) {
    sets.push(`status = $${idx}`)
    values.push(fields.status)
    idx++
  }
  if (fields.displayName !== undefined) {
    sets.push(`display_name = $${idx}`)
    values.push(fields.displayName)
    idx++
  }

  if (sets.length === 0) {
    return getChannelForUser(userId, channelId)
  }

  values.push(channelId)
  const result = await queryWithRLS<Channel>(
    userId,
    `UPDATE channels SET ${sets.join(', ')}
     WHERE id = $${idx}
     RETURNING ${CHANNEL_COLS}`,
    values,
  )
  return result.rows[0] ?? null
}

/** Delete a channel. RLS-gated. Cascades to `channel_integrations` and
 *  `channel_assistants`. Returns false if no row was deleted. */
export async function deleteChannel(userId: string, channelId: string): Promise<boolean> {
  const result = await queryWithRLS(
    userId,
    `DELETE FROM channels WHERE id = $1`,
    [channelId],
  )
  return (result.rowCount ?? 0) > 0
}

// ── Channel-assistant routing (RLS-gated) ──────────────────────

/** List the assistant routing rows for a channel the user can see. */
export async function listChannelAssistants(
  userId: string,
  channelId: string,
): Promise<ChannelAssistant[]> {
  const result = await queryWithRLS<ChannelAssistant>(
    userId,
    `SELECT ${CHANNEL_ASSISTANT_COLS} FROM channel_assistants
     WHERE channel_id = $1
     ORDER BY external_surface_id NULLS FIRST`,
    [channelId],
  )
  return result.rows
}

/**
 * Attach an assistant to a channel for chat routing. `externalSurfaceId`
 * omitted / null makes it the channel's default assistant. RLS gates the
 * insert; the `channel_assistants_workspace_match` trigger rejects an
 * assistant from a different workspace than the channel. The partial unique
 * indexes reject a second default, or a second mapping for the same surface.
 *
 * `modelAlias` seeds the per-routing model tier (migration 197). When the
 * caller omits it, the column default ('pro', migration 234) is used.
 */
export async function attachAssistant(
  userId: string,
  params: {
    channelId: string
    assistantId: string
    externalSurfaceId?: string | null
    modelAlias?: ChannelModelAlias
  },
): Promise<ChannelAssistant> {
  if (params.modelAlias) {
    const result = await queryWithRLS<ChannelAssistant>(
      userId,
      `INSERT INTO channel_assistants (channel_id, assistant_id, external_surface_id, model_alias)
       VALUES ($1, $2, $3, $4)
       RETURNING ${CHANNEL_ASSISTANT_COLS}`,
      [params.channelId, params.assistantId, params.externalSurfaceId ?? null, params.modelAlias],
    )
    return result.rows[0]
  }
  const result = await queryWithRLS<ChannelAssistant>(
    userId,
    `INSERT INTO channel_assistants (channel_id, assistant_id, external_surface_id)
     VALUES ($1, $2, $3)
     RETURNING ${CHANNEL_ASSISTANT_COLS}`,
    [params.channelId, params.assistantId, params.externalSurfaceId ?? null],
  )
  return result.rows[0]
}

/**
 * Patch a routing row's `model_alias`. Today this is the only mutable field
 * on `channel_assistants` (assistant + surface assignments are immutable —
 * callers re-attach to change them). Returns null when the row doesn't
 * exist or RLS hides it.
 */
export async function updateChannelAssistant(
  userId: string,
  channelAssistantId: string,
  fields: { modelAlias?: ChannelModelAlias },
): Promise<ChannelAssistant | null> {
  if (fields.modelAlias === undefined) {
    const existing = await queryWithRLS<ChannelAssistant>(
      userId,
      `SELECT ${CHANNEL_ASSISTANT_COLS} FROM channel_assistants WHERE id = $1`,
      [channelAssistantId],
    )
    return existing.rows[0] ?? null
  }
  const result = await queryWithRLS<ChannelAssistant>(
    userId,
    `UPDATE channel_assistants SET model_alias = $1
     WHERE id = $2
     RETURNING ${CHANNEL_ASSISTANT_COLS}`,
    [fields.modelAlias, channelAssistantId],
  )
  return result.rows[0] ?? null
}

/** Remove an assistant routing row. RLS-gated. Returns false if nothing was
 *  deleted (unknown id, or the channel isn't visible to the user). */
export async function detachAssistant(
  userId: string,
  channelAssistantId: string,
): Promise<boolean> {
  const result = await queryWithRLS(
    userId,
    `DELETE FROM channel_assistants WHERE id = $1`,
    [channelAssistantId],
  )
  return (result.rowCount ?? 0) > 0
}

// ── Connect-flow channel provisioning (system-level) ───────────

/**
 * Find-or-create the workspace channel for a BYO connect.
 *
 * The connect-flow counterpart to the Phase B backfill (migration 154), run
 * *before* the `channel_integrations` row is written — its `channel_id` is
 * `NOT NULL` since migration 158, so the channel must exist first. The caller
 * then `upsert`s the integration with the returned `channelId`.
 *
 * Re-install detection: if a channel of `channelType` already exists in the
 * assistant's workspace with this assistant as its default routing
 * (`channel_assistants.external_surface_id IS NULL`), reuse it — so a
 * reconnect refreshes credentials in place. Otherwise create a fresh channel
 * and seed its default `channel_assistants` row. A retried connect whose
 * earlier attempt created the channel but failed before the integration
 * upsert re-finds that channel here, so there is no orphan-on-retry.
 *
 * Both writes share one transaction. System-level — the connect route already
 * RLS-gated the caller as an owner/admin of the assistant. Messaging channels
 * only (slack / telegram / whatsapp).
 */
export async function findOrCreateChannelForConnect(params: {
  assistantId: string
  channelType: ChannelType
  /** Seeds `channels.display_name` on a fresh channel — e.g. the Slack team name. */
  displayName?: string | null
}): Promise<string> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')

    const ws = await client.query<{ workspace_id: string | null }>(
      `SELECT workspace_id FROM assistants WHERE id = $1`,
      [params.assistantId],
    )
    const workspaceId = ws.rows[0]?.workspace_id
    if (!workspaceId) {
      await client.query('ROLLBACK')
      throw new Error(
        `findOrCreateChannelForConnect: assistant ${params.assistantId} has no workspace`,
      )
    }

    // Re-install: reuse the channel of this type whose default assistant is
    // the connecting one.
    const existing = await client.query<{ id: string }>(
      `SELECT c.id FROM channels c
       JOIN channel_assistants ca ON ca.channel_id = c.id
       WHERE c.workspace_id = $1 AND c.channel_type = $2
         AND ca.assistant_id = $3 AND ca.external_surface_id IS NULL
       LIMIT 1`,
      [workspaceId, params.channelType, params.assistantId],
    )
    if (existing.rows.length > 0) {
      await client.query('COMMIT')
      return existing.rows[0].id
    }

    const displayName =
      params.displayName?.trim() ||
      `${params.channelType[0].toUpperCase()}${params.channelType.slice(1)} connection`

    const created = await client.query<{ id: string }>(
      `INSERT INTO channels (workspace_id, channel_type, enabled_capabilities, display_name)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [workspaceId, params.channelType, CHANNEL_CAPABILITIES[params.channelType], displayName],
    )
    const channelId = created.rows[0].id

    // Seed the routing row's model_alias from the assistant's
    // platform-specific default (Settings tab → Channel Models) so the
    // existing "set it once on the assistant" UX keeps working on first
    // connect. The per-routing picker only kicks in when overridden later.
    const aliasCol = modelAliasColumnFor(params.channelType)
    const aliasRow = aliasCol
      ? await client.query<{ alias: string | null }>(
          `SELECT ${aliasCol} AS alias FROM assistants WHERE id = $1`,
          [params.assistantId],
        )
      : null
    // Default channel tier is Pro (migration 234); the runtime resolver
    // clamps it down for plans that don't allow Pro, so this is safe.
    const seeded: ChannelModelAlias =
      (aliasRow?.rows[0]?.alias as ChannelModelAlias) ?? 'pro'

    await client.query(
      `INSERT INTO channel_assistants (channel_id, assistant_id, external_surface_id, model_alias)
       VALUES ($1, $2, NULL, $3)`,
      [channelId, params.assistantId, seeded],
    )

    await client.query('COMMIT')
    return channelId
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/**
 * Find-or-create a workspace channel for the studio/channels Add-channel flow
 * (channel-driven, no assistant in scope).
 *
 * Unlike `findOrCreateChannelForConnect`, this version is keyed by the
 * external bot identity (Slack `team_id`, Telegram `bot_user_id`), matching
 * the migration plan's `UNIQUE (channel_type, team_id, bot_user_id)` intent:
 * a re-install of the same bot reuses its channel and the caller's subsequent
 * `integrationStore.upsert` refreshes credentials in place. A *different* bot
 * of the same platform yields a separate named channel — one workspace can
 * hold many Slack installs.
 *
 * `defaultAssistantId` is optional: when set, also seeds a default
 * `channel_assistants` row so the channel can answer chats immediately.
 * Skipped for re-installs (existing routing wins). The
 * `channel_assistants_workspace_match` trigger rejects cross-workspace
 * assistants; the caller maps that to a 400.
 *
 * System-level — the caller has already gated on workspace membership via
 * `WorkspaceStore.getRole`. The transaction guards the channel + routing
 * inserts so a retried connect that crashed mid-write doesn't orphan a
 * channel with no routing in the failure window.
 */
export async function findOrCreateChannelForWorkspaceConnect(params: {
  workspaceId: string
  channelType: ChannelType
  displayName?: string | null
  /**
   * External bot identity for re-install detection. If a channel of this type
   * exists in the workspace whose existing `channel_integrations` row matches
   * one of these, reuse it.
   */
  externalIdentity?: { teamId?: string | null; botUserId?: string | null }
  /**
   * If set, also create a default `channel_assistants` row pointing at this
   * assistant. Skipped for re-installs (existing routing wins). The trigger
   * rejects an assistant from a different workspace. The seeded row's
   * `model_alias` is read off the assistant's platform-specific default
   * (Settings tab → Channel Models) — migration 197.
   */
  defaultAssistantId?: string | null
}): Promise<{ channelId: string; reused: boolean }> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')

    const teamId = params.externalIdentity?.teamId ?? null
    const botUserId = params.externalIdentity?.botUserId ?? null

    // Re-install: look for an existing channel in this workspace whose
    // integration carries this bot's identity. NULL identity fields are
    // ignored — we never re-install on "both fields null".
    if (teamId || botUserId) {
      const existing = await client.query<{ id: string }>(
        `SELECT c.id FROM channels c
         JOIN channel_integrations ci ON ci.channel_id = c.id
         WHERE c.workspace_id = $1 AND c.channel_type = $2
           AND (
             ($3::text IS NOT NULL AND ci.team_id      IS NOT NULL AND ci.team_id      = $3) OR
             ($4::text IS NOT NULL AND ci.bot_user_id IS NOT NULL AND ci.bot_user_id = $4)
           )
         LIMIT 1`,
        [params.workspaceId, params.channelType, teamId, botUserId],
      )
      if (existing.rows.length > 0) {
        await client.query('COMMIT')
        return { channelId: existing.rows[0].id, reused: true }
      }
    }

    const displayName =
      params.displayName?.trim() ||
      `${params.channelType[0].toUpperCase()}${params.channelType.slice(1)} connection`

    const created = await client.query<{ id: string }>(
      `INSERT INTO channels (workspace_id, channel_type, enabled_capabilities, display_name)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [params.workspaceId, params.channelType, CHANNEL_CAPABILITIES[params.channelType], displayName],
    )
    const channelId = created.rows[0].id

    if (params.defaultAssistantId) {
      // Seed the routing row's model_alias from the assistant's
      // platform-specific default (Settings tab → Channel Models). Keeps
      // the existing "set it once on the assistant" UX working for a fresh
      // connect — the per-routing picker only kicks in when the operator
      // overrides it later.
      const aliasCol = modelAliasColumnFor(params.channelType)
      const aliasRow = aliasCol
        ? await client.query<{ alias: string | null }>(
            `SELECT ${aliasCol} AS alias FROM assistants WHERE id = $1`,
            [params.defaultAssistantId],
          )
        : null
      // Default channel tier is Pro (migration 234); the runtime resolver
      // clamps it down for plans that don't allow Pro, so this is safe.
      const seeded: ChannelModelAlias =
        (aliasRow?.rows[0]?.alias as ChannelModelAlias) ?? 'pro'
      await client.query(
        `INSERT INTO channel_assistants (channel_id, assistant_id, external_surface_id, model_alias)
         VALUES ($1, $2, NULL, $3)`,
        [channelId, params.defaultAssistantId, seeded],
      )
    }

    await client.query('COMMIT')
    return { channelId, reused: false }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
