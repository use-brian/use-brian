/**
 * Canonical channel identity bindings - the WeChat early slice.
 *
 * Spec: docs/architecture/channels/wechat.md -> "Staff identity" and
 * docs/plans/wechat-staff-access.md §3 (migration 743). Generic tables from
 * docs/plans/channel-identity-binding.md §2: `identities` holds a provable
 * channel identity, `identity_bindings` maps it to ONE Brian account in ONE
 * workspace. A binding carries proof and revocation metadata only - never a
 * role, clearance, department or grant; every turn recomputes access from the
 * account's current membership.
 *
 * WeChat identity key: (provider='wechat', tenant_key=<iLink bot id>,
 * subject=<iLink sender id>). A WeChat binding is always workspace-scoped and
 * transport-bound: it pins the channel and the integration's
 * `identity_generation`, which rotates on every confirmed pairing,
 * credential replacement and transport invalidation (never on a cursor
 * write), so a re-pair revokes every proof made under the old transport.
 *
 * Proofs: `qr_pair` (the creator's explicit finalize of a self pairing) and
 * `link_code` (a code the signed-in account minted, delivered by the
 * QR-bound WeChat sender). Nothing here infers a binding from credentials,
 * history, sessions or the workspace owner.
 *
 * Writes run as system statements on the owner pool, behind authenticated
 * routes that already resolved the acting account from its session. Every
 * write re-checks membership, transport and conflicts INSIDE its
 * transaction, serialized on the bot id with a transaction advisory lock, so
 * a race yields one winner rather than last-writer-wins authority. Caller
 * projections and self revocation run through `queryWithRLS`.
 *
 * Component tag: [COMP:api/channel-identity-bindings].
 */

import { createHmac, randomInt } from 'node:crypto'
import type { PoolClient } from 'pg'
import { getPool, query, queryWithRLS } from './client.js'
import { decryptCredentials, encryptCredentials, type WechatCredentials } from './channel-integrations.js'
import { CHANNEL_CAPABILITIES, seedAliasForAssistant } from './channels-store.js'

// ── Constants ────────────────────────────────────────────────────

/** Unambiguous uppercase alphabet: no I, L, O, 0 or 1. */
export const LINK_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const LINK_CODE_LENGTH = 8
export const LINK_CODE_TTL_MS = 15 * 60_000
/** Mints per (account, channel) inside the rolling window. */
export const LINK_CODE_MINT_LIMIT = 5
/** Failed claims per (channel, sender) inside the rolling window. */
export const LINK_CODE_FAILURE_LIMIT = 5
const LIMIT_WINDOW = '15 minutes'

/** Domain string for the challenge digest key; distinct from credential use. */
const CHALLENGE_DIGEST_DOMAIN = 'use-brian/channel-identity-challenge/v1'

// ── Types ────────────────────────────────────────────────────────

export type WechatPairingMode = 'self' | 'admin_prepare'

/**
 * Durable proof that a WeChat turn acts as `accountId`. Captured at inbound
 * and re-checked at every authority boundary. Holds no credential and no
 * permission snapshot.
 */
export type WechatIdentityReceipt = {
  bindingId: string
  version: number
  accountId: string
  workspaceId: string
  channelId: string
  botId: string
  senderId: string
  transportGeneration: number
}

export type WechatPairingCredentials = {
  botToken: string
  baseUrl: string
  ilinkBotId: string
  boundUserId?: string
}

export type ProvisionWechatTransportInput = {
  workspaceId: string
  /** The authenticated pairing creator; never read from a request body. */
  actorUserId: string
  mode: WechatPairingMode
  pairingId: string
  defaultAssistantId: string | null
  credentials: WechatPairingCredentials
  displayName?: string
}

export type ProvisionWechatTransportResult =
  | {
      ok: true
      channelId: string
      reused: boolean
      /** True when this pairing already committed (retry after commit). */
      idempotent: boolean
      generation: number
      /** The creator's binding in `self` mode; null for `admin_prepare`. */
      binding: WechatIdentityReceipt | null
    }
  | {
      ok: false
      reason:
        | 'forbidden'
        | 'missing_sender'
        | 'other_workspace'
        | 'duplicate_transport'
        | 'binding_conflict'
        | 'assistant_not_in_workspace'
    }

export type MintWechatLinkCodeResult =
  | { ok: true; code: string; expiresAt: string; channelName: string | null }
  | { ok: false; reason: 'not_member' | 'not_found' | 'linked_elsewhere' | 'conflict' | 'rate_limited' }

export type ClaimWechatLinkCodeResult =
  | { ok: true; receipt: WechatIdentityReceipt; idempotent: boolean }
  | {
      ok: false
      reason:
        | 'transport_inactive'
        | 'wrong_sender'
        | 'conflict'
        | 'rate_limited'
        | 'invalid'
        | 'not_member'
        | 'linked_elsewhere'
    }

export type ResolveWechatSenderResult =
  | { kind: 'bound'; receipt: WechatIdentityReceipt }
  | { kind: 'unbound' }
  | { kind: 'conflict' }
  | { kind: 'transport_inactive' }

export type OwnWechatBindingState = 'linked' | 'revoked' | 'pairing_replaced' | 'access_removed'

export type OwnWechatBinding = {
  bindingId: string
  workspaceId: string
  channelId: string
  channelName: string | null
  state: OwnWechatBindingState
  linkedAt: string
  revokedAt: string | null
}

export type WechatChannelIdentitySummary = {
  channelId: string
  channelName: string | null
  state: 'linked' | 'unlinked' | 'revoked' | 'conflict'
  /** Owner/admin projection only. */
  account: { id: string; name: string | null; email: string | null } | null
  linkedAt: string | null
}

export type WechatTransportRow = {
  channelId: string
  workspaceId: string
  botId: string
  generation: number
  credentials: WechatCredentials
  conflict: boolean
}

// ── Session keys ─────────────────────────────────────────────────

const SESSION_KEY = /^wechat:([0-9a-f-]{36}):b:([0-9a-f-]{36}):v(\d+):g(\d+)$/i

/**
 * Session key for a verified staff turn. The physical peer id stays the
 * delivery target; the session, confirmation scope and caches key on this,
 * so a rebind or another bot never reaches the previous principal's state.
 */
export function wechatSessionChannelId(receipt: Pick<WechatIdentityReceipt,
  'channelId' | 'bindingId' | 'version' | 'transportGeneration'>): string {
  return `wechat:${receipt.channelId}:b:${receipt.bindingId}:v${receipt.version}:g${receipt.transportGeneration}`
}

export function parseWechatSessionChannelId(value: string | undefined | null): {
  channelId: string
  bindingId: string
  version: number
  transportGeneration: number
} | null {
  const match = value ? SESSION_KEY.exec(value) : null
  if (!match) return null
  return {
    channelId: match[1],
    bindingId: match[2],
    version: Number(match[3]),
    transportGeneration: Number(match[4]),
  }
}

// ── Codes ────────────────────────────────────────────────────────

export function generateLinkCode(): string {
  let code = ''
  for (let i = 0; i < LINK_CODE_LENGTH; i += 1) {
    code += LINK_CODE_ALPHABET[randomInt(LINK_CODE_ALPHABET.length)]
  }
  return code
}

/** Accepts case and stray separators; returns null when it cannot be a code. */
export function normalizeLinkCode(raw: string): string | null {
  const code = raw.toUpperCase().replace(/[\s-]/g, '')
  if (code.length !== LINK_CODE_LENGTH) return null
  for (const ch of code) if (!LINK_CODE_ALPHABET.includes(ch)) return null
  return code
}

/** `LINK <code>` exactly - the only WeChat text that is a control command. */
export function parseWechatLinkCommand(text: string): { code: string | null } | null {
  const match = /^\s*link\s+(\S(?:.*\S)?)\s*$/i.exec(text)
  if (!match) return null
  return { code: normalizeLinkCode(match[1]) }
}

// ── Store ────────────────────────────────────────────────────────

export type ChannelIdentityBindingStore = ReturnType<typeof createChannelIdentityBindingStore>

type Tx = Pick<PoolClient, 'query'>

async function withTransaction<T>(fn: (client: Tx) => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

async function lockBot(client: Tx, botId: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`wechat-bot:${botId}`])
}

async function roleIn(client: Tx, userId: string, workspaceId: string): Promise<'owner' | 'admin' | 'member' | null> {
  const row = await client.query<{ role: 'owner' | 'admin' | 'member' }>(
    `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [workspaceId, userId],
  )
  return row.rows[0]?.role ?? null
}

/** Active WeChat integrations holding this bot, across every workspace. */
async function activeOwnerCount(client: Tx, botId: string): Promise<number> {
  const row = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM channel_integrations ci
       JOIN channels c ON c.id = ci.channel_id
      WHERE ci.channel_type = 'wechat' AND ci.bot_user_id = $1
        AND ci.status = 'active' AND c.status = 'active'`,
    [botId],
  )
  return Number(row.rows[0]?.n ?? 0)
}

async function upsertIdentity(client: Tx, botId: string, senderId: string): Promise<string> {
  const row = await client.query<{ id: string }>(
    `INSERT INTO identities (provider, tenant_key, subject)
     VALUES ('wechat', $1, $2)
     ON CONFLICT ON CONSTRAINT identities_provider_tenant_subject_key
       DO UPDATE SET updated_at = now()
     RETURNING id`,
    [botId, senderId],
  )
  return row.rows[0].id
}

async function upsertBinding(client: Tx, input: {
  identityId: string
  accountId: string
  workspaceId: string
  channelId: string
  generation: number
  proof: 'qr_pair' | 'link_code'
  createdBy: string
}): Promise<{ id: string; version: number }> {
  const row = await client.query<{ id: string; version: string }>(
    `INSERT INTO identity_bindings
       (identity_id, account_id, workspace_id, channel_id, transport_generation, proof, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT ON CONSTRAINT identity_bindings_identity_workspace_key DO UPDATE SET
       account_id = EXCLUDED.account_id,
       channel_id = EXCLUDED.channel_id,
       transport_generation = EXCLUDED.transport_generation,
       proof = EXCLUDED.proof,
       created_by = EXCLUDED.created_by,
       version = identity_bindings.version + 1,
       revoked_at = NULL
     RETURNING id, version::text AS version`,
    [input.identityId, input.accountId, input.workspaceId, input.channelId,
      input.generation, input.proof, input.createdBy],
  )
  return { id: row.rows[0].id, version: Number(row.rows[0].version) }
}

/** Revoke every active binding on a channel and its open link codes. */
async function revokeChannelProofs(client: Tx, channelId: string): Promise<string[]> {
  const revoked = await client.query<{ accountId: string }>(
    `UPDATE identity_bindings
        SET revoked_at = now(), version = version + 1
      WHERE channel_id = $1 AND revoked_at IS NULL
      RETURNING account_id AS "accountId"`,
    [channelId],
  )
  await client.query(
    `UPDATE channel_identity_challenges SET revoked_at = now()
      WHERE channel_id = $1 AND claimed_at IS NULL AND revoked_at IS NULL`,
    [channelId],
  )
  return revoked.rows.map((r) => r.accountId)
}

async function creatorBinding(client: Tx, input: {
  channelId: string
  workspaceId: string
  accountId: string
  generation: number
  botId: string
}): Promise<WechatIdentityReceipt | null> {
  const row = await client.query<{ id: string; version: string; senderId: string }>(
    `SELECT b.id, b.version::text AS version, i.subject AS "senderId"
       FROM identity_bindings b
       JOIN identities i ON i.id = b.identity_id
      WHERE b.channel_id = $1 AND b.workspace_id = $2 AND b.account_id = $3
        AND b.transport_generation = $4 AND b.revoked_at IS NULL
        AND i.provider = 'wechat' AND i.tenant_key = $5
      LIMIT 1`,
    [input.channelId, input.workspaceId, input.accountId, input.generation, input.botId],
  )
  const b = row.rows[0]
  return b ? {
    bindingId: b.id,
    version: Number(b.version),
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    botId: input.botId,
    senderId: b.senderId,
    transportGeneration: input.generation,
  } : null
}

const RECEIPT_SQL = `
  SELECT 1
    FROM identity_bindings b
    JOIN identities i ON i.id = b.identity_id
    JOIN channel_integrations ci ON ci.channel_id = b.channel_id
    JOIN channels c ON c.id = b.channel_id
   WHERE b.id = $1 AND b.version = $2 AND b.account_id = $3
     AND b.workspace_id = $4 AND b.channel_id = $5
     AND b.transport_generation = $6 AND b.revoked_at IS NULL
     AND i.provider = 'wechat' AND i.subject = $7
     AND ($8::text IS NULL OR i.tenant_key = $8)
     AND ($9::uuid IS NULL OR ci.id = $9)
     AND ci.channel_type = 'wechat' AND ci.status = 'active'
     AND ci.bot_user_id = i.tenant_key AND ci.identity_generation = b.transport_generation
     AND c.status = 'active' AND c.workspace_id = b.workspace_id
     AND NOT EXISTS (
       SELECT 1 FROM channel_integrations o
         JOIN channels oc ON oc.id = o.channel_id
        WHERE o.channel_type = 'wechat' AND o.bot_user_id = ci.bot_user_id
          AND o.status = 'active' AND oc.status = 'active' AND o.id <> ci.id
     )
   LIMIT 1`

/**
 * Is a captured receipt still the current, unrevoked binding of an active,
 * uncontested transport? The WeChat `credentialCurrent` callback.
 */
export async function isWechatReceiptCurrentSystem(receipt: WechatIdentityReceipt): Promise<boolean> {
  const row = await query(RECEIPT_SQL, [
    receipt.bindingId, receipt.version, receipt.accountId, receipt.workspaceId,
    receipt.channelId, receipt.transportGeneration, receipt.senderId, receipt.botId, null,
  ])
  return (row.rowCount ?? 0) > 0
}

/**
 * Delivery-authority recipient rule for WeChat: the physical peer must be the
 * QR-bound sender of an active binding for this account on this channel at
 * the current generation, and the session key must name that exact binding
 * version. Anything else - an old session, a raw peer id, a revoked or
 * re-paired binding - is not an authorized recipient.
 */
export async function isWechatRecipientCurrentSystem(input: {
  workspaceId: string
  accountId: string
  peerId: string
  sessionChannelId?: string
  channelIntegrationId?: string
}): Promise<boolean> {
  const key = parseWechatSessionChannelId(input.sessionChannelId)
  if (!key) return false
  const row = await query(RECEIPT_SQL, [
    key.bindingId, key.version, input.accountId, input.workspaceId, key.channelId,
    key.transportGeneration, input.peerId, null, input.channelIntegrationId ?? null,
  ])
  return (row.rowCount ?? 0) > 0
}

export function createChannelIdentityBindingStore(credentialKey: Buffer) {
  const digestKey = createHmac('sha256', credentialKey).update(CHALLENGE_DIGEST_DOMAIN).digest()
  const digest = (channelId: string, code: string): Buffer =>
    createHmac('sha256', digestKey).update(`${channelId}\n${code}`).digest()

  return {
    /**
     * Pair finalize: provision or replace the bot's transport and, in `self`
     * mode, bind the QR-scanning WeChat account to the creator - one
     * transaction. Repeat calls with the same pairing id return the committed
     * result after re-checking the actor. Never binds in `admin_prepare`.
     */
    async provisionWechatTransport(input: ProvisionWechatTransportInput): Promise<ProvisionWechatTransportResult> {
      const botId = input.credentials.ilinkBotId
      const sender = input.credentials.boundUserId
      return withTransaction(async (client) => {
        await lockBot(client, botId)
        const role = await roleIn(client, input.actorUserId, input.workspaceId)
        if (!role || (input.mode === 'admin_prepare' && role !== 'owner' && role !== 'admin')) {
          return { ok: false, reason: 'forbidden' } as const
        }
        if (!sender) return { ok: false, reason: 'missing_sender' } as const

        const owners = await client.query<{
          integrationId: string; channelId: string; workspaceId: string; generation: string
          pairingId: string | null; active: boolean
        }>(
          `SELECT ci.id AS "integrationId", ci.channel_id AS "channelId", c.workspace_id AS "workspaceId",
                  ci.identity_generation::text AS generation, ci.last_identity_pairing_id AS "pairingId",
                  (ci.status = 'active' AND c.status = 'active') AS active
             FROM channel_integrations ci
             JOIN channels c ON c.id = ci.channel_id
            WHERE ci.channel_type = 'wechat' AND ci.bot_user_id = $1
            ORDER BY ci.created_at
            FOR UPDATE OF ci`,
          [botId],
        )
        if (owners.rows.some((r) => r.active && r.workspaceId !== input.workspaceId)) {
          return { ok: false, reason: 'other_workspace' } as const
        }
        const same = owners.rows.filter((r) => r.workspaceId === input.workspaceId)
        const activeSame = same.filter((r) => r.active)
        if (activeSame.length > 1) return { ok: false, reason: 'duplicate_transport' } as const
        const target = activeSame[0] ?? same[0] ?? null

        const encrypted = encryptCredentials({
          bot_token: input.credentials.botToken,
          base_url: input.credentials.baseUrl,
          ilink_bot_id: botId,
          bound_user_id: sender,
          get_updates_buf: '',
        } satisfies WechatCredentials, credentialKey)

        let channelId: string
        let generation: number
        let reused: boolean
        if (target && target.pairingId === input.pairingId) {
          // Retry after a committed finalize: no second rotation, no rebind.
          generation = Number(target.generation)
          const binding = input.mode === 'self'
            ? await creatorBinding(client, {
                channelId: target.channelId, workspaceId: input.workspaceId,
                accountId: input.actorUserId, generation, botId,
              })
            : null
          return { ok: true, channelId: target.channelId, reused: true, idempotent: true, generation, binding } as const
        }
        if (target) {
          const active = await client.query<{ accountId: string }>(
            `SELECT account_id AS "accountId" FROM identity_bindings
              WHERE channel_id = $1 AND revoked_at IS NULL FOR UPDATE`,
            [target.channelId],
          )
          const conflict = input.mode === 'self'
            ? active.rows.some((r) => r.accountId !== input.actorUserId)
            : active.rows.length > 0
          if (conflict) return { ok: false, reason: 'binding_conflict' } as const
          const updated = await client.query<{ generation: string }>(
            `UPDATE channel_integrations
                SET credentials = $2, status = 'active', bot_user_id = $3, team_name = $3,
                    identity_generation = identity_generation + 1,
                    last_identity_pairing_id = $4, updated_at = now()
              WHERE id = $1
              RETURNING identity_generation::text AS generation`,
            [target.integrationId, encrypted, botId, input.pairingId],
          )
          await revokeChannelProofs(client, target.channelId)
          channelId = target.channelId
          generation = Number(updated.rows[0].generation)
          reused = true
        } else {
          if (input.defaultAssistantId) {
            const assistant = await client.query<{ workspaceId: string | null }>(
              `SELECT workspace_id AS "workspaceId" FROM assistants WHERE id = $1`,
              [input.defaultAssistantId],
            )
            if (assistant.rows[0]?.workspaceId !== input.workspaceId) {
              return { ok: false, reason: 'assistant_not_in_workspace' } as const
            }
          }
          const created = await client.query<{ id: string }>(
            `INSERT INTO channels (workspace_id, channel_type, enabled_capabilities, display_name)
             VALUES ($1, 'wechat', $2, $3) RETURNING id`,
            [input.workspaceId, CHANNEL_CAPABILITIES.wechat,
              input.displayName?.trim() || `WeChat bot ${botId.split('@')[0]}`],
          )
          channelId = created.rows[0].id
          if (input.defaultAssistantId) {
            const alias = await seedAliasForAssistant(client as PoolClient, input.defaultAssistantId)
            await client.query(
              `INSERT INTO channel_assistants (channel_id, assistant_id, external_surface_id, model_alias)
               VALUES ($1, $2, NULL, $3)`,
              [channelId, input.defaultAssistantId, alias],
            )
          }
          await client.query(
            `INSERT INTO channel_integrations
               (channel_id, channel_type, team_id, team_name, bot_user_id, bot_username, credentials,
                status, identity_generation, last_identity_pairing_id)
             VALUES ($1, 'wechat', NULL, $2, $2, NULL, $3, 'active', 1, $4)`,
            [channelId, botId, encrypted, input.pairingId],
          )
          generation = 1
          reused = false
        }
        // Credentials changed: stale per-channel user resolutions must go.
        await client.query(
          `DELETE FROM channel_user_cache
            WHERE assistant_id IN (SELECT assistant_id FROM channel_assistants WHERE channel_id = $1)`,
          [channelId],
        )

        let binding: WechatIdentityReceipt | null = null
        if (input.mode === 'self') {
          const identityId = await upsertIdentity(client, botId, sender)
          const bound = await upsertBinding(client, {
            identityId, accountId: input.actorUserId, workspaceId: input.workspaceId,
            channelId, generation, proof: 'qr_pair', createdBy: input.actorUserId,
          })
          binding = {
            bindingId: bound.id, version: bound.version, accountId: input.actorUserId,
            workspaceId: input.workspaceId, channelId, botId, senderId: sender,
            transportGeneration: generation,
          }
        }
        return { ok: true, channelId, reused, idempotent: false, generation, binding } as const
      })
    },

    /** Mint a link code for the authenticated account on one WeChat channel. */
    async mintWechatLinkCode(input: {
      accountId: string
      workspaceId: string
      channelId: string
    }): Promise<MintWechatLinkCodeResult> {
      return withTransaction(async (client) => {
        if (!await roleIn(client, input.accountId, input.workspaceId)) {
          return { ok: false, reason: 'not_member' } as const
        }
        const transport = await client.query<{ botId: string; generation: string; channelName: string | null }>(
          `SELECT ci.bot_user_id AS "botId", ci.identity_generation::text AS generation,
                  c.display_name AS "channelName"
             FROM channels c
             JOIN channel_integrations ci ON ci.channel_id = c.id
            WHERE c.id = $1 AND c.workspace_id = $2 AND c.channel_type = 'wechat'
              AND c.status = 'active' AND ci.status = 'active'`,
          [input.channelId, input.workspaceId],
        )
        const t = transport.rows[0]
        if (!t?.botId) return { ok: false, reason: 'not_found' } as const
        await lockBot(client, t.botId)
        if (await activeOwnerCount(client, t.botId) > 1) return { ok: false, reason: 'conflict' } as const
        const other = await client.query(
          `SELECT 1 FROM identity_bindings
            WHERE channel_id = $1 AND revoked_at IS NULL AND account_id <> $2 LIMIT 1`,
          [input.channelId, input.accountId],
        )
        if ((other.rowCount ?? 0) > 0) return { ok: false, reason: 'linked_elsewhere' } as const
        const recent = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM channel_identity_challenges
            WHERE account_id = $1 AND channel_id = $2
              AND created_at > now() - interval '${LIMIT_WINDOW}'`,
          [input.accountId, input.channelId],
        )
        if (Number(recent.rows[0]?.n ?? 0) >= LINK_CODE_MINT_LIMIT) {
          return { ok: false, reason: 'rate_limited' } as const
        }
        await client.query(
          `UPDATE channel_identity_challenges SET revoked_at = now()
            WHERE account_id = $1 AND channel_id = $2 AND claimed_at IS NULL AND revoked_at IS NULL`,
          [input.accountId, input.channelId],
        )
        const code = generateLinkCode()
        const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS)
        await client.query(
          `INSERT INTO channel_identity_challenges
             (provider, workspace_id, channel_id, transport_generation, account_id, code_digest, expires_at)
           VALUES ('wechat', $1, $2, $3, $4, $5, $6)`,
          [input.workspaceId, input.channelId, Number(t.generation), input.accountId,
            digest(input.channelId, code), expiresAt],
        )
        return { ok: true, code, expiresAt: expiresAt.toISOString(), channelName: t.channelName } as const
      })
    },

    /**
     * Claim `LINK <code>` from the connector-authenticated inbound. Requires
     * the exact active transport, the QR-bound sender, a matching unexpired
     * code under the current generation, current membership of the target
     * account, and no other account's active binding. A failed attempt is
     * recorded (persisted limiter) and nothing else changes.
     */
    async claimWechatLinkCode(input: {
      channelId: string
      botId: string
      senderId: string
      code: string | null
    }): Promise<ClaimWechatLinkCodeResult> {
      const recordFailure = (client: Tx) => client.query(
        `INSERT INTO channel_identity_claim_failures (channel_id, subject) VALUES ($1, $2)`,
        [input.channelId, input.senderId],
      )
      return withTransaction(async (client) => {
        await lockBot(client, input.botId)
        const transport = await client.query<{
          workspaceId: string; botId: string | null; generation: string; credentials: Buffer
        }>(
          `SELECT c.workspace_id AS "workspaceId", ci.bot_user_id AS "botId",
                  ci.identity_generation::text AS generation, ci.credentials
             FROM channel_integrations ci
             JOIN channels c ON c.id = ci.channel_id
            WHERE ci.channel_id = $1 AND ci.channel_type = 'wechat'
              AND ci.status = 'active' AND c.status = 'active'
            FOR UPDATE OF ci`,
          [input.channelId],
        )
        const t = transport.rows[0]
        if (!t || t.botId !== input.botId) return { ok: false, reason: 'transport_inactive' } as const
        if (await activeOwnerCount(client, input.botId) > 1) return { ok: false, reason: 'conflict' } as const
        const failures = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM channel_identity_claim_failures
            WHERE channel_id = $1 AND subject = $2 AND failed_at > now() - interval '${LIMIT_WINDOW}'`,
          [input.channelId, input.senderId],
        )
        if (Number(failures.rows[0]?.n ?? 0) >= LINK_CODE_FAILURE_LIMIT) {
          return { ok: false, reason: 'rate_limited' } as const
        }
        const creds = decryptCredentials(t.credentials, credentialKey) as WechatCredentials
        if (!creds.bound_user_id || creds.bound_user_id !== input.senderId) {
          await recordFailure(client)
          return { ok: false, reason: 'wrong_sender' } as const
        }
        const generation = Number(t.generation)
        const challenge = input.code ? await client.query<{ id: string; accountId: string }>(
          `SELECT id, account_id AS "accountId" FROM channel_identity_challenges
            WHERE channel_id = $1 AND code_digest = $2 AND workspace_id = $3
              AND transport_generation = $4 AND claimed_at IS NULL AND revoked_at IS NULL
              AND expires_at > now()
            FOR UPDATE`,
          [input.channelId, digest(input.channelId, input.code), t.workspaceId, generation],
        ) : null
        const c = challenge?.rows[0]
        if (!c) {
          await recordFailure(client)
          return { ok: false, reason: 'invalid' } as const
        }
        if (!await roleIn(client, c.accountId, t.workspaceId)) {
          await client.query(`UPDATE channel_identity_challenges SET revoked_at = now() WHERE id = $1`, [c.id])
          return { ok: false, reason: 'not_member' } as const
        }
        const identityId = await upsertIdentity(client, input.botId, input.senderId)
        const existing = await client.query<{
          id: string; version: string; accountId: string; channelId: string | null
          generation: string | null; revoked: boolean
        }>(
          `SELECT id, version::text AS version, account_id AS "accountId", channel_id AS "channelId",
                  transport_generation::text AS generation, revoked_at IS NOT NULL AS revoked
             FROM identity_bindings WHERE identity_id = $1 AND workspace_id = $2 FOR UPDATE`,
          [identityId, t.workspaceId],
        )
        const prior = existing.rows[0]
        if (prior && !prior.revoked && prior.accountId !== c.accountId) {
          return { ok: false, reason: 'linked_elsewhere' } as const
        }
        // Another account may hold this channel through a different identity
        // only if the bound sender changed without a re-pair; refuse it too.
        const otherOnChannel = await client.query(
          `SELECT 1 FROM identity_bindings
            WHERE channel_id = $1 AND revoked_at IS NULL AND account_id <> $2 LIMIT 1`,
          [input.channelId, c.accountId],
        )
        if ((otherOnChannel.rowCount ?? 0) > 0) return { ok: false, reason: 'linked_elsewhere' } as const

        let bindingId: string
        let version: number
        let idempotent = false
        if (prior && !prior.revoked && prior.channelId === input.channelId
          && Number(prior.generation) === generation) {
          bindingId = prior.id
          version = Number(prior.version)
          idempotent = true
        } else {
          const bound = await upsertBinding(client, {
            identityId, accountId: c.accountId, workspaceId: t.workspaceId,
            channelId: input.channelId, generation, proof: 'link_code', createdBy: c.accountId,
          })
          bindingId = bound.id
          version = bound.version
        }
        await client.query(
          `UPDATE channel_identity_challenges SET claimed_at = now(), claimed_identity_id = $2 WHERE id = $1`,
          [c.id, identityId],
        )
        return {
          ok: true,
          idempotent,
          receipt: {
            bindingId, version, accountId: c.accountId, workspaceId: t.workspaceId,
            channelId: input.channelId, botId: input.botId, senderId: input.senderId,
            transportGeneration: generation,
          },
        } as const
      })
    },

    /** Exact sender resolution for an inbound WeChat message. No fallback. */
    async resolveWechatSender(input: {
      channelId: string
      botId: string
      senderId: string
    }): Promise<ResolveWechatSenderResult> {
      const transport = await query<{ workspaceId: string; botId: string | null; generation: string; owners: string }>(
        `SELECT c.workspace_id AS "workspaceId", ci.bot_user_id AS "botId",
                ci.identity_generation::text AS generation,
                (SELECT count(*) FROM channel_integrations o JOIN channels oc ON oc.id = o.channel_id
                  WHERE o.channel_type = 'wechat' AND o.bot_user_id = ci.bot_user_id
                    AND o.status = 'active' AND oc.status = 'active')::text AS owners
           FROM channel_integrations ci
           JOIN channels c ON c.id = ci.channel_id
          WHERE ci.channel_id = $1 AND ci.channel_type = 'wechat'
            AND ci.status = 'active' AND c.status = 'active'`,
        [input.channelId],
      )
      const t = transport.rows[0]
      if (!t || t.botId !== input.botId) return { kind: 'transport_inactive' }
      if (Number(t.owners) > 1) return { kind: 'conflict' }
      const generation = Number(t.generation)
      const binding = await query<{ id: string; version: string; accountId: string }>(
        `SELECT b.id, b.version::text AS version, b.account_id AS "accountId"
           FROM identities i
           JOIN identity_bindings b ON b.identity_id = i.id
          WHERE i.provider = 'wechat' AND i.tenant_key = $1 AND i.subject = $2
            AND b.workspace_id = $3 AND b.channel_id = $4
            AND b.transport_generation = $5 AND b.revoked_at IS NULL`,
        [input.botId, input.senderId, t.workspaceId, input.channelId, generation],
      )
      const b = binding.rows[0]
      if (!b) return { kind: 'unbound' }
      return {
        kind: 'bound',
        receipt: {
          bindingId: b.id, version: Number(b.version), accountId: b.accountId,
          workspaceId: t.workspaceId, channelId: input.channelId, botId: input.botId,
          senderId: input.senderId, transportGeneration: generation,
        },
      }
    },

    isWechatReceiptCurrent: isWechatReceiptCurrentSystem,

    /** Caller's own WeChat bindings, through the caller's RLS boundary. */
    async listOwnWechatBindings(userId: string, workspaceId: string | null): Promise<OwnWechatBinding[]> {
      const rows = await queryWithRLS<{
        id: string; workspaceId: string; channelId: string; channelName: string | null
        bindingGeneration: string; currentGeneration: string | null; integrationStatus: string | null
        channelStatus: string | null; createdAt: Date; updatedAt: Date; revokedAt: Date | null
      }>(
        userId,
        `SELECT b.id, b.workspace_id AS "workspaceId", b.channel_id AS "channelId",
                c.display_name AS "channelName", b.transport_generation::text AS "bindingGeneration",
                ci.identity_generation::text AS "currentGeneration", ci.status AS "integrationStatus",
                c.status AS "channelStatus", b.created_at AS "createdAt", b.updated_at AS "updatedAt",
                b.revoked_at AS "revokedAt"
           FROM identity_bindings b
           JOIN identities i ON i.id = b.identity_id
           LEFT JOIN channels c ON c.id = b.channel_id
           LEFT JOIN channel_integrations ci ON ci.channel_id = b.channel_id
          WHERE b.account_id = $1 AND i.provider = 'wechat'
            AND ($2::uuid IS NULL OR b.workspace_id = $2)
          ORDER BY b.updated_at DESC`,
        [userId, workspaceId],
      )
      return rows.rows.map((r) => ({
        bindingId: r.id,
        workspaceId: r.workspaceId,
        channelId: r.channelId,
        channelName: r.channelName,
        state: r.revokedAt ? 'revoked'
          : r.channelStatus === null ? 'access_removed'
            : r.integrationStatus !== 'active' || r.channelStatus !== 'active'
              || r.currentGeneration !== r.bindingGeneration ? 'pairing_replaced'
              : 'linked',
        linkedAt: new Date(r.updatedAt).toISOString(),
        revokedAt: r.revokedAt ? new Date(r.revokedAt).toISOString() : null,
      }))
    },

    /** Owner/admin per-channel summary. The route checks the role first. */
    async listWorkspaceWechatIdentitySummary(workspaceId: string): Promise<WechatChannelIdentitySummary[]> {
      const rows = await query<{
        channelId: string; channelName: string | null; owners: string; currentGeneration: string
        bindingId: string | null; bindingGeneration: string | null; revokedAt: Date | null
        accountId: string | null; accountName: string | null; accountEmail: string | null; linkedAt: Date | null
      }>(
        `SELECT c.id AS "channelId", c.display_name AS "channelName",
                (SELECT count(*) FROM channel_integrations o JOIN channels oc ON oc.id = o.channel_id
                  WHERE o.channel_type = 'wechat' AND o.bot_user_id = ci.bot_user_id
                    AND o.status = 'active' AND oc.status = 'active')::text AS owners,
                ci.identity_generation::text AS "currentGeneration",
                b.id AS "bindingId", b.transport_generation::text AS "bindingGeneration",
                b.revoked_at AS "revokedAt", b.account_id AS "accountId",
                u.name AS "accountName", u.email AS "accountEmail", b.updated_at AS "linkedAt"
           FROM channels c
           JOIN channel_integrations ci ON ci.channel_id = c.id
           LEFT JOIN LATERAL (
             SELECT * FROM identity_bindings x WHERE x.channel_id = c.id
              ORDER BY x.revoked_at NULLS FIRST, x.updated_at DESC LIMIT 1
           ) b ON true
           LEFT JOIN users u ON u.id = b.account_id
          WHERE c.workspace_id = $1 AND c.channel_type = 'wechat'
          ORDER BY c.created_at`,
        [workspaceId],
      )
      return rows.rows.map((r) => {
        const active = r.bindingId !== null && r.revokedAt === null
          && r.bindingGeneration === r.currentGeneration
        const state: WechatChannelIdentitySummary['state'] = Number(r.owners) > 1 ? 'conflict'
          : active ? 'linked'
            : r.bindingId !== null ? 'revoked'
              : 'unlinked'
        return {
          channelId: r.channelId,
          channelName: r.channelName,
          state,
          account: active && r.accountId
            ? { id: r.accountId, name: r.accountName, email: r.accountEmail }
            : null,
          linkedAt: active && r.linkedAt ? new Date(r.linkedAt).toISOString() : null,
        }
      })
    },

    /** Revoke the caller's own binding (RLS), then its open codes. Idempotent. */
    async revokeOwnWechatBinding(userId: string, bindingId: string): Promise<boolean> {
      const revoked = await queryWithRLS<{ channelId: string | null }>(
        userId,
        `UPDATE identity_bindings b
            SET version = CASE WHEN b.revoked_at IS NULL THEN b.version + 1 ELSE b.version END,
                revoked_at = COALESCE(b.revoked_at, now())
          WHERE b.id = $1 AND b.account_id = $2
            AND EXISTS (SELECT 1 FROM identities i WHERE i.id = b.identity_id AND i.provider = 'wechat')
          RETURNING b.channel_id AS "channelId"`,
        [bindingId, userId],
      )
      const row = revoked.rows[0]
      if (!row) return false
      if (row.channelId) {
        await query(
          `UPDATE channel_identity_challenges SET revoked_at = now()
            WHERE account_id = $1 AND channel_id = $2 AND claimed_at IS NULL AND revoked_at IS NULL`,
          [userId, row.channelId],
        )
      }
      return true
    },

    /** Owner/admin revocation of a channel's binding. Assigns nobody. */
    async revokeWechatChannelBinding(workspaceId: string, channelId: string): Promise<{
      found: boolean
      revokedAccountIds: string[]
    }> {
      return withTransaction(async (client) => {
        const channel = await client.query(
          `SELECT 1 FROM channels WHERE id = $1 AND workspace_id = $2 AND channel_type = 'wechat'`,
          [channelId, workspaceId],
        )
        if ((channel.rowCount ?? 0) === 0) return { found: false, revokedAccountIds: [] }
        return { found: true, revokedAccountIds: await revokeChannelProofs(client, channelId) }
      })
    },

    /** Delete/disconnect: rotate the generation and revoke every proof first. */
    async invalidateWechatTransport(channelId: string): Promise<void> {
      await withTransaction(async (client) => {
        await client.query(
          `UPDATE channel_integrations SET identity_generation = identity_generation + 1, updated_at = now()
            WHERE channel_id = $1 AND channel_type = 'wechat'`,
          [channelId],
        )
        await revokeChannelProofs(client, channelId)
      })
    },

    /** Connector restore source: active transports with generation + conflict flag. */
    async listActiveWechatTransportsSystem(): Promise<WechatTransportRow[]> {
      const rows = await query<{
        channelId: string; workspaceId: string; botId: string | null; generation: string
        credentials: Buffer; owners: string
      }>(
        `SELECT ci.channel_id AS "channelId", c.workspace_id AS "workspaceId", ci.bot_user_id AS "botId",
                ci.identity_generation::text AS generation, ci.credentials,
                (SELECT count(*) FROM channel_integrations o JOIN channels oc ON oc.id = o.channel_id
                  WHERE o.channel_type = 'wechat' AND o.bot_user_id = ci.bot_user_id
                    AND o.status = 'active' AND oc.status = 'active')::text AS owners
           FROM channel_integrations ci
           JOIN channels c ON c.id = ci.channel_id
          WHERE ci.channel_type = 'wechat' AND ci.status = 'active' AND c.status = 'active'`,
      )
      return rows.rows.map((r) => {
        const credentials = decryptCredentials(r.credentials, credentialKey) as WechatCredentials
        return {
          channelId: r.channelId,
          workspaceId: r.workspaceId,
          botId: r.botId ?? credentials.ilink_bot_id,
          generation: Number(r.generation),
          credentials,
          conflict: Number(r.owners) > 1,
        }
      })
    },

    /** Current transport generation, or null when the channel is not an active WeChat transport. */
    async getWechatTransportGeneration(channelId: string): Promise<number | null> {
      const row = await query<{ generation: string }>(
        `SELECT ci.identity_generation::text AS generation
           FROM channel_integrations ci
           JOIN channels c ON c.id = ci.channel_id
          WHERE ci.channel_id = $1 AND ci.channel_type = 'wechat'
            AND ci.status = 'active' AND c.status = 'active'`,
        [channelId],
      )
      return row.rows[0] ? Number(row.rows[0].generation) : null
    },

    /**
     * Persist the long-poll cursor only while `generation` is current. A
     * cursor is not a credential change: it never rotates the generation.
     * Returns false for a stale generation (a replaced loop).
     */
    async persistWechatCursor(channelId: string, generation: number | undefined, cursor: string): Promise<boolean> {
      return withTransaction(async (client) => {
        const row = await client.query<{ id: string; generation: string; credentials: Buffer }>(
          `SELECT id, identity_generation::text AS generation, credentials FROM channel_integrations
            WHERE channel_id = $1 AND channel_type = 'wechat' AND status = 'active'
            FOR UPDATE`,
          [channelId],
        )
        const current = row.rows[0]
        if (!current) return false
        if (generation !== undefined && Number(current.generation) !== generation) return false
        const creds = decryptCredentials(current.credentials, credentialKey) as WechatCredentials
        await client.query(
          `UPDATE channel_integrations SET credentials = $2, updated_at = now() WHERE id = $1`,
          [current.id, encryptCredentials({ ...creds, get_updates_buf: cursor }, credentialKey)],
        )
        return true
      })
    },
  }
}
