/**
 * Encrypted DB-backed browser session vault.
 *
 * [COMP:sandbox/session-vault]
 */
import type { BrowserProfileAuthority, SessionBundle, SessionVault, VaultSessionInfo } from '@use-brian/core'
import type { PoolClient } from 'pg'
import { query } from './client.js'
import { decryptCredentials, encryptCredentials } from './credential-crypto.js'
import { createBrowserProfileStore, withBrowserProfileOwnerMutation } from './browser-profile-store.js'

export type BrowserSessionVault = SessionVault & {
  purgeInactive(): Promise<number>
}

export function createBrowserSessionVault(opts: { encryptionKey: Buffer }): BrowserSessionVault {
  if (opts.encryptionKey.length !== 32) {
    throw new Error('browser-session-vault: BROWSER_VAULT_ENCRYPTION_KEY must be 32 bytes (aes-256-gcm)')
  }

  async function admit<T>(profileId: string, operation: (client: PoolClient) => Promise<T>, expectedProfile?: BrowserProfileAuthority): Promise<T> {
    const profile = expectedProfile ?? await createBrowserProfileStore().get(profileId)
    if (!profile) throw Object.assign(new Error('Profile authority unavailable'), { code: 'profile_authority_denied' })
    return withBrowserProfileOwnerMutation(profileId, profile, operation)
  }

  return {
    async get({ profileId, site }, expectedProfile) {
      try {
        return await admit(profileId, async client => {
          const res = await client.query<{ encrypted_bundle: Buffer }>(
            `SELECT encrypted_bundle FROM browser_sessions
              WHERE profile_id = $1 AND site = $2 AND status = 'active'`,
            [profileId, site],
          )
          const row = res.rows[0]
          return row ? decryptCredentials<SessionBundle>(row.encrypted_bundle, opts.encryptionKey) : null
        }, expectedProfile)
      } catch (error) {
        if ((error as { code?: string })?.code === 'profile_authority_denied') return null
        throw error
      }
    },

    async put({ profileId, site, bundle }, expectedProfile) {
      const blob = encryptCredentials(bundle, opts.encryptionKey)
      const persist = async (execute: typeof query) => { await execute(
        `INSERT INTO browser_sessions
           (user_id, workspace_id, profile_id, site, encrypted_bundle, status, captured_at, updated_at)
         SELECT bp.owner_user_id, bp.workspace_id, bp.id, $2, $3, 'active', now(), now()
           FROM browser_profiles bp WHERE bp.id = $1
         ON CONFLICT (profile_id, site)
         DO UPDATE SET encrypted_bundle = EXCLUDED.encrypted_bundle,
                       status = 'active',
                       captured_at = now(),
                       updated_at = now()`,
        [profileId, site, blob],
      ) }
      await admit(profileId, client => persist(client.query.bind(client)), expectedProfile)
    },

    async markDead({ profileId, site }, expectedProfile) {
      await admit(profileId, async client => { await client.query(
        `UPDATE browser_sessions SET status = 'dead', updated_at = now()
          WHERE profile_id = $1 AND site = $2`,
        [profileId, site],
      ) }, expectedProfile)
    },

    async touch({ profileId, site }, expectedProfile) {
      await admit(profileId, async client => { await client.query(
        `UPDATE browser_sessions SET last_used_at = now(), updated_at = now()
          WHERE profile_id = $1 AND site = $2`,
        [profileId, site],
      ) }, expectedProfile)
    },

    async list({ profileId }): Promise<VaultSessionInfo[]> {
      const res = await query<{
        site: string
        captured_at: Date
        last_used_at: Date | null
        status: string
      }>(
        `SELECT site, captured_at, last_used_at, status FROM browser_sessions
          WHERE profile_id = $1
          ORDER BY COALESCE(last_used_at, captured_at) DESC`,
        [profileId],
      )
      return res.rows.map((row) => ({
        site: row.site,
        capturedAt: row.captured_at.toISOString(),
        lastUsedAt: row.last_used_at?.toISOString() ?? null,
        status: row.status === 'dead' ? 'dead' : 'active',
      }))
    },

    async revoke({ profileId, site }, expectedProfile) {
      await admit(profileId, async client => {
        await client.query('DELETE FROM browser_sessions WHERE profile_id=$1 AND site=$2', [profileId, site])
      }, expectedProfile)
    },

    async purgeInactive() {
      const res = await query(
        `DELETE FROM browser_sessions bs
          USING workspaces w
          WHERE w.id = bs.workspace_id
            AND COALESCE(bs.last_used_at, bs.captured_at) <
                CASE WHEN w.plan = 'free'
                     THEN now() - interval '30 days'
                     ELSE now() - interval '90 days'
                END`,
        [],
      )
      return res.rowCount ?? 0
    },
  }
}
