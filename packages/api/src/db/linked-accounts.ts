/**
 * Linked accounts store — compatibility shim over the
 * `linked_identities` + `channel_routes` split.
 *
 * Stage 6 of the team-connector promotion: `user_linked_accounts` has
 * been dropped. The store's interface is unchanged so every legacy
 * caller (telegram routes, whatsapp, slack, account route, auth flow)
 * keeps working. Behind the scenes:
 *
 *   Legacy user_linked_accounts row  →  assembled from:
 *     - linked_identities  (user_id, provider, provider_id, metadata, linked_at)
 *     - channel_routes     (assistant_id, provider, provider_id)  [optional]
 *
 * When the legacy row had a NULL assistant_id, no `channel_routes` row
 * existed and the returned `LinkedAccount.assistantId` is null.
 *
 * See docs/architecture/platform/auth.md → "Linked Accounts".
 * Component tag: [COMP:api/linked-accounts-store].
 */

import { query, queryWithRLS, getPool } from './client.js'

// ── Types ──────────────────────────────────────────────────────

export type LinkedAccount = {
  id: string
  userId: string
  assistantId: string | null
  provider: string
  providerId: string
  providerMetadata: Record<string, unknown> | null
  linkedAt: Date
}

export type LinkedAccountStore = {
  /**
   * Look up a linked account by provider identity.
   * No RLS — used by webhook handlers before user is known.
   */
  findByProvider(provider: string, providerId: string): Promise<LinkedAccount | null>

  /**
   * Create or update a linked account row.
   * No RLS — called after link code verification in the webhook handler.
   * On conflict (same provider + provider_id), overwrites assistant_id
   * and metadata — this is how users switch which assistant their
   * Telegram routes to.
   */
  upsert(params: {
    userId: string
    assistantId: string
    provider: string
    providerId: string
    providerMetadata?: Record<string, unknown>
  }): Promise<LinkedAccount>

  /**
   * Find linked account by assistant (for checking if this assistant
   * has an official bot connection).
   */
  findByAssistant(assistantId: string, provider: string): Promise<LinkedAccount | null>

  /** List linked accounts for a user. RLS-gated. */
  listForUser(actingUserId: string): Promise<LinkedAccount[]>

  /** Unlink an account. RLS-gated. */
  deleteForUser(actingUserId: string, id: string): Promise<boolean>
}

// ── Composite-row projection ──────────────────────────────────
//
// Each read joins `linked_identities` LEFT JOIN `channel_routes` on
// (provider, provider_id) — the identity side always exists, routing may
// be absent. We key the returned `id` on the identity row for legacy
// parity (the old UNIQUE constraint was on provider+provider_id, which
// both new tables inherit).

const COMPOSITE_COLS = `
  li.id,
  li.user_id        AS "userId",
  cr.assistant_id   AS "assistantId",
  li.provider,
  li.provider_id    AS "providerId",
  li.metadata       AS "providerMetadata",
  li.linked_at      AS "linkedAt"
` as const

const FROM_JOIN = `
  FROM linked_identities li
  LEFT JOIN channel_routes cr
    ON cr.provider = li.provider AND cr.provider_id = li.provider_id
` as const

type ComposedRow = LinkedAccount

// ── Factory ───────────────────────────────────────────────────

/** Reason codes for an identity-healing merge. Stored on `user_merges.reason`. */
export type MergeReason =
  | 'link-code'        // user claimed a code in the channel
  | 'email-discovery'  // provider profile revealed an email matching a real user
  | 'partner-claim'    // public-API partner-mediated claim
  | 'oauth-signup'     // sign-in with a provider that matched an existing shadow
  | 'backfill'         // one-time orphan reclamation script

/**
 * Atomically merge orphan shadow user(s) into a real user.
 *
 * The data-reassignment half is provider-agnostic; only the shadow lookup
 * is provider-shaped:
 *
 *   - `api` — uses `partnerKeyId`-namespaced auth_provider_id format
 *     `api:<keyId>:<externalUserId>`. See docs/architecture/features/shadow-claim.md.
 *   - everything else (`slack`, `telegram`, `whatsapp`, future channels) — finds
 *     users with either old-style `auth_provider=<provider>` or new-style
 *     `auth_provider='channel'` + `auth_provider_id='<provider>:<id>'`.
 *
 * After merging, writes one `user_merges` audit row per shadow and a
 * `linked_identities` row so the provider identity is preserved on the
 * real user even though the shadow user row is gone.
 *
 * See docs/architecture/platform/identity-healing.md.
 * Idempotent — safe to call when no shadow exists.
 */
export async function mergeShadowUser(
  realUserId: string,
  providerId: string,
  provider: string = 'telegram',
  options: {
    partnerKeyId?: string
    reason?: MergeReason
    evidence?: Record<string, unknown>
  } = {},
): Promise<{ merged: boolean; shadowUserId?: string }> {
  const reason: MergeReason = options.reason ?? 'link-code'
  const evidenceJson = options.evidence ? JSON.stringify(options.evidence) : null

  // Find shadow user(s) for this provider ID. The api branch requires
  // partnerKeyId because the auth_provider_id is namespaced by API key —
  // see public-api.ts (`api:${keyRow.id}:${externalUserId}`).
  let shadows: { rows: { id: string; email: string | null; name: string | null; authProvider: string; authProviderId: string; createdAt: Date }[] }
  if (provider === 'api') {
    if (!options.partnerKeyId) {
      throw new Error("mergeShadowUser: provider='api' requires partnerKeyId")
    }
    shadows = await query(
      `SELECT id, email, name, auth_provider AS "authProvider",
              auth_provider_id AS "authProviderId", created_at AS "createdAt"
       FROM users
       WHERE id != $1
         AND auth_provider = 'channel'
         AND auth_provider_id = 'api:' || $3 || ':' || $2`,
      [realUserId, providerId, options.partnerKeyId],
    )
  } else {
    shadows = await query(
      `SELECT id, email, name, auth_provider AS "authProvider",
              auth_provider_id AS "authProviderId", created_at AS "createdAt"
       FROM users
       WHERE id != $1
         AND (
           (auth_provider = $3 AND auth_provider_id = $2)
           OR (auth_provider = 'channel' AND auth_provider_id = $3 || ':' || $2)
         )`,
      [realUserId, providerId, provider],
    )
  }

  if (shadows.rows.length === 0) {
    return { merged: false }
  }

  const client = await getPool().connect()
  try {
    await client.query('BEGIN')

    for (const shadow of shadows.rows) {
      const sid = shadow.id

      // 1. Reassign sessions that don't conflict with the real user's
      await client.query(
        `UPDATE sessions SET user_id = $1
         WHERE user_id = $2
           AND NOT EXISTS (
             SELECT 1 FROM sessions s2
             WHERE s2.user_id = $1
               AND s2.assistant_id = sessions.assistant_id
               AND s2.channel_type = sessions.channel_type
               AND s2.channel_id = sessions.channel_id
               AND COALESCE(s2.app_id, '') = COALESCE(sessions.app_id, '')
           )`,
        [realUserId, sid],
      )
      // Delete remaining conflicting shadow sessions (cascade deletes messages)
      await client.query(`DELETE FROM sessions WHERE user_id = $1`, [sid])

      // 2. Reassign memories (skip duplicates)
      await client.query(
        `UPDATE memories SET user_id = $1
         WHERE user_id = $2
           AND NOT EXISTS (
             SELECT 1 FROM memories m2
             WHERE m2.user_id = $1
               AND m2.assistant_id = memories.assistant_id
               AND COALESCE(m2.app_id, '') = COALESCE(memories.app_id, '')
               AND m2.summary = memories.summary
           )`,
        [realUserId, sid],
      )
      await client.query(`DELETE FROM memories WHERE user_id = $1`, [sid])

      // 3. Reassign user_souls (skip if real user already has one)
      await client.query(
        `UPDATE user_souls SET user_id = $1
         WHERE user_id = $2
           AND NOT EXISTS (
             SELECT 1 FROM user_souls us2
             WHERE us2.user_id = $1
               AND us2.assistant_id = user_souls.assistant_id
               AND COALESCE(us2.app_id, '') = COALESCE(user_souls.app_id, '')
           )`,
        [realUserId, sid],
      )
      await client.query(`DELETE FROM user_souls WHERE user_id = $1`, [sid])

      // 4. Audit row — captures source snapshot before the user row is gone.
      await client.query(
        `INSERT INTO user_merges
           (target_user_id, source_user_id, provider, provider_id,
            reason, source_user_snapshot, evidence)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
        [
          realUserId,
          sid,
          provider,
          providerId,
          reason,
          JSON.stringify({
            id: sid,
            email: shadow.email,
            name: shadow.name,
            authProvider: shadow.authProvider,
            authProviderId: shadow.authProviderId,
            createdAt: shadow.createdAt,
          }),
          evidenceJson,
        ],
      )

      // 5. Preserve the provider identity on the real user. Without this the
      // channel identity disappears with the shadow row and the next webhook
      // would create a fresh shadow.
      await client.query(
        `INSERT INTO linked_identities (user_id, provider, provider_id, metadata)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (provider, provider_id) DO UPDATE SET
           user_id = EXCLUDED.user_id,
           linked_at = now()`,
        [
          realUserId,
          provider,
          providerId,
          JSON.stringify({ reason, mergedFromShadow: sid }),
        ],
      )

      // 6. Finally, delete the shadow user row (cascades clear any residue)
      await client.query(`DELETE FROM users WHERE id = $1`, [sid])
    }

    await client.query('COMMIT')
    return { merged: true, shadowUserId: shadows.rows[0].id }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

export function createDbLinkedAccountStore(): LinkedAccountStore {
  return {
    async findByProvider(provider, providerId) {
      const result = await query<ComposedRow>(
        `SELECT ${COMPOSITE_COLS}
         ${FROM_JOIN}
         WHERE li.provider = $1 AND li.provider_id = $2
         LIMIT 1`,
        [provider, providerId],
      )
      return result.rows[0] ?? null
    },

    async upsert(params) {
      const client = await getPool().connect()
      try {
        await client.query('BEGIN')

        // Identity side — upsert (provider, provider_id) → user_id / metadata.
        const identityResult = await client.query<ComposedRow>(
          `INSERT INTO linked_identities (user_id, provider, provider_id, metadata)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (provider, provider_id) DO UPDATE SET
             user_id  = EXCLUDED.user_id,
             metadata = EXCLUDED.metadata,
             linked_at = now()
           RETURNING
             id,
             user_id     AS "userId",
             NULL::uuid  AS "assistantId",
             provider,
             provider_id AS "providerId",
             metadata    AS "providerMetadata",
             linked_at   AS "linkedAt"`,
          [
            params.userId,
            params.provider,
            params.providerId,
            params.providerMetadata ? JSON.stringify(params.providerMetadata) : null,
          ],
        )
        const identity = identityResult.rows[0]

        // Routing side — upsert (provider, provider_id) → assistant_id.
        // UNIQUE is on (provider, provider_id); re-linking moves routing.
        await client.query(
          `INSERT INTO channel_routes (assistant_id, provider, provider_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (provider, provider_id) DO UPDATE SET
             assistant_id = EXCLUDED.assistant_id`,
          [params.assistantId, params.provider, params.providerId],
        )

        await client.query('COMMIT')
        // Return the composed view with the routing we just wrote.
        return { ...identity, assistantId: params.assistantId }
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },

    async findByAssistant(assistantId, provider) {
      const result = await query<ComposedRow>(
        `SELECT ${COMPOSITE_COLS}
         ${FROM_JOIN}
         WHERE cr.assistant_id = $1 AND li.provider = $2
         LIMIT 1`,
        [assistantId, provider],
      )
      return result.rows[0] ?? null
    },

    async listForUser(actingUserId) {
      const result = await queryWithRLS<ComposedRow>(
        actingUserId,
        `SELECT ${COMPOSITE_COLS}
         ${FROM_JOIN}
         ORDER BY li.linked_at ASC`,
      )
      return result.rows
    },

    async deleteForUser(actingUserId, id) {
      // The composite row's `id` is the `linked_identities.id`. Deleting
      // the identity is the user-visible unlink — the routing row is
      // cleared too so messages stop being delivered. Matches legacy
      // behavior where a single DELETE wiped the whole composite row.
      const client = await getPool().connect()
      try {
        await client.query('BEGIN')

        // Capture (provider, provider_id) for the routing cleanup.
        const identityRow = await client.query<{ provider: string; provider_id: string }>(
          `SELECT provider, provider_id FROM linked_identities WHERE id = $1`,
          [id],
        )
        if (identityRow.rows.length === 0) {
          await client.query('COMMIT')
          return false
        }
        const { provider, provider_id: providerId } = identityRow.rows[0]

        // Delete identity — RLS-gated so a foreign user can't delete.
        // Switch to queryWithRLS-equivalent: set the session var, execute, then reset.
        await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [actingUserId])
        const identityDelete = await client.query(
          `DELETE FROM linked_identities WHERE id = $1`,
          [id],
        )
        if ((identityDelete.rowCount ?? 0) === 0) {
          await client.query('ROLLBACK')
          return false
        }

        await client.query(
          `DELETE FROM channel_routes WHERE provider = $1 AND provider_id = $2`,
          [provider, providerId],
        )

        await client.query('COMMIT')
        return true
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },
  }
}
