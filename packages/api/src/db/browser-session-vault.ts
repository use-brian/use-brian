/**
 * Encrypted DB-backed browser session vault.
 *
 * [COMP:sandbox/session-vault]
 */
import type { SessionBundle, SessionVault, VaultSessionInfo } from '@use-brian/core'
import { query } from './client.js'
import { decryptCredentials, encryptCredentials } from './credential-crypto.js'

export type BrowserSessionVault = SessionVault & {
  purgeInactive(): Promise<number>
}

export function createBrowserSessionVault(opts: { encryptionKey: Buffer }): BrowserSessionVault {
  if (opts.encryptionKey.length !== 32) {
    throw new Error('browser-session-vault: BROWSER_VAULT_ENCRYPTION_KEY must be 32 bytes (aes-256-gcm)')
  }

  return {
    async get({ profileId, site }) {
      const res = await query<{ encrypted_bundle: Buffer }>(
        `SELECT encrypted_bundle FROM browser_sessions
          WHERE profile_id = $1 AND site = $2 AND status = 'active'`,
        [profileId, site],
      )
      const row = res.rows[0]
      return row ? decryptCredentials<SessionBundle>(row.encrypted_bundle, opts.encryptionKey) : null
    },

    async put({ profileId, site, bundle }) {
      const blob = encryptCredentials(bundle, opts.encryptionKey)
      await query(
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
      )
    },

    async markDead({ profileId, site }) {
      await query(
        `UPDATE browser_sessions SET status = 'dead', updated_at = now()
          WHERE profile_id = $1 AND site = $2`,
        [profileId, site],
      )
    },

    async touch({ profileId, site }) {
      await query(
        `UPDATE browser_sessions SET last_used_at = now(), updated_at = now()
          WHERE profile_id = $1 AND site = $2`,
        [profileId, site],
      )
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

    async revoke({ profileId, site }) {
      await query(`DELETE FROM browser_sessions WHERE profile_id = $1 AND site = $2`, [profileId, site])
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
