/**
 * Encrypted browser credential store. Administration exposes metadata only;
 * the trusted browser auth broker receives the decrypting resolver capability.
 *
 * [COMP:sandbox/browser-credentials]
 */
import type {
  BrowserCredentialFailureCode,
  BrowserCredentialMetadata,
  BrowserCredentialSecret,
  BrowserCredentialStore,
} from '@use-brian/core'
import { query } from './client.js'
import { decryptCredentials, encryptCredentials } from './credential-crypto.js'

type Row = {
  id: string
  workspace_id: string
  profile_id: string
  site: string
  login_url: string
  account_label: string | null
  encrypted_secret?: Buffer
  status: 'active' | 'invalid'
  last_used_at: Date | null
  last_failure_code: BrowserCredentialFailureCode | null
  created_at: Date
  updated_at: Date
}

function metadata(row: Row): BrowserCredentialMetadata {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    profileId: row.profile_id,
    site: row.site,
    loginUrl: row.login_url,
    accountLabel: row.account_label,
    status: row.status,
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    lastFailureCode: row.last_failure_code,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

export function createBrowserCredentialStore(opts: { encryptionKey: Buffer }): BrowserCredentialStore {
  if (opts.encryptionKey.length !== 32) {
    throw new Error(
      'browser-credential-store: BROWSER_CREDENTIAL_ENCRYPTION_KEY must be 32 bytes (aes-256-gcm)',
    )
  }

  const projection = `id, workspace_id, profile_id, site, login_url, account_label,
    status, last_used_at, last_failure_code, created_at, updated_at`

  return {
    async list({ profileId }) {
      const res = await query<Row>(
        `SELECT ${projection}
           FROM browser_credentials
          WHERE profile_id = $1
          ORDER BY created_at`,
        [profileId],
      )
      return res.rows.map(metadata)
    },

    async upsert(params) {
      const blob = encryptCredentials<BrowserCredentialSecret>(params.secret, opts.encryptionKey)
      const res = await query<Row>(
        `INSERT INTO browser_credentials
           (workspace_id, profile_id, owner_user_id, site, login_url, account_label, encrypted_secret)
         SELECT bp.workspace_id, bp.id, bp.owner_user_id, $4, $5, $6, $7
           FROM browser_profiles bp
          WHERE bp.id = $2
            AND bp.workspace_id = $1
            AND bp.owner_user_id = $3
         ON CONFLICT (profile_id, site)
         DO UPDATE SET login_url = EXCLUDED.login_url,
                       account_label = EXCLUDED.account_label,
                       encrypted_secret = EXCLUDED.encrypted_secret,
                       status = 'active',
                       last_failure_code = NULL,
                       updated_at = now()
         RETURNING ${projection}`,
        [
          params.workspaceId,
          params.profileId,
          params.ownerUserId,
          params.site,
          params.loginUrl,
          params.accountLabel?.trim() || null,
          blob,
        ],
      )
      if (!res.rows[0]) throw new Error('Browser profile is not owned by this user')
      return metadata(res.rows[0])
    },

    async revoke({ profileId, credentialId }) {
      const res = await query(`DELETE FROM browser_credentials WHERE id = $1 AND profile_id = $2`, [
        credentialId,
        profileId,
      ])
      return (res.rowCount ?? 0) > 0
    },

    async resolve({ userId, workspaceId, profileId, site, credentialId }) {
      const res = await query<Row & { encrypted_secret: Buffer }>(
        `SELECT ${projection}, encrypted_secret
           FROM browser_credentials
          WHERE profile_id = $1
            AND site = $2
            AND owner_user_id = $3
            AND workspace_id = $4
            AND status = 'active'
            ${credentialId ? 'AND id = $5' : ''}
          LIMIT 1`,
        credentialId
          ? [profileId, site, userId, workspaceId, credentialId]
          : [profileId, site, userId, workspaceId],
      )
      const row = res.rows[0]
      if (!row) return null
      return {
        metadata: metadata(row),
        secret: decryptCredentials<BrowserCredentialSecret>(row.encrypted_secret, opts.encryptionKey),
      }
    },

    async recordResult({ credentialId, result, failureCode }) {
      if (result === 'success') {
        await query(
          `UPDATE browser_credentials
              SET status = 'active', last_used_at = now(), last_failure_code = NULL, updated_at = now()
            WHERE id = $1`,
          [credentialId],
        )
        return
      }
      await query(
        `UPDATE browser_credentials
            SET status = 'invalid', last_failure_code = $2, updated_at = now()
          WHERE id = $1`,
        [credentialId, failureCode ?? 'backend_error'],
      )
    },
  }
}
