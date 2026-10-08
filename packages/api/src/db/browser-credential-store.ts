/**
 * Encrypted browser credential store. Administration exposes metadata only;
 * the trusted browser auth broker receives the decrypting resolver capability.
 *
 * [COMP:sandbox/browser-credentials]
 */
import { createHash } from 'node:crypto'
import type {
  BrowserCredentialFailureCode,
  BrowserCredentialMetadata,
  BrowserCredentialSecret,
  BrowserCredentialStore,
} from '@use-brian/core'
import { query } from './client.js'
import { decryptCredentials, encryptCredentials } from './credential-crypto.js'
import { createBrowserProfileStore, withBrowserProfileOwnerMutation } from './browser-profile-store.js'

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

    async upsert(params, expectedProfile) {
      const blob = encryptCredentials<BrowserCredentialSecret>(params.secret, opts.encryptionKey)
      const persist = async (execute: typeof query) => { const res = await execute<Row>(
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
      }
      return expectedProfile
        ? withBrowserProfileOwnerMutation(params.profileId, expectedProfile, client => persist(client.query.bind(client)))
        : persist(query)
    },

    async revoke({ profileId, credentialId }, expectedProfile) {
      const remove = async (execute: typeof query) => { const res = await execute(`DELETE FROM browser_credentials WHERE id = $1 AND profile_id = $2`, [
        credentialId,
        profileId,
      ])
      return (res.rowCount ?? 0) > 0
      }
      return expectedProfile
        ? withBrowserProfileOwnerMutation(profileId, expectedProfile, client => remove(client.query.bind(client)))
        : remove(query)
    },

    async resolve({ userId, workspaceId, profileId, site, credentialId }) {
      const profile = await createBrowserProfileStore().get(profileId)
      if (!profile || profile.workspaceId !== workspaceId || profile.ownerUserId !== userId) return null
      try {
        return await withBrowserProfileOwnerMutation(profileId, profile, async client => {
          const res = await client.query<Row & { encrypted_secret: Buffer }>(
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
            version: createHash('sha256').update(row.encrypted_secret).digest('hex'),
          }
        })
      } catch (error) {
        if ((error as { code?: string })?.code === 'profile_authority_denied') return null
        throw error
      }
    },

    async recordResult({ userId, workspaceId, profileId, credentialId, version, result, failureCode }) {
      const denied = () => Object.assign(new Error('Credential authority unavailable'), { code: 'profile_authority_denied' })
      const profile = await createBrowserProfileStore().get(profileId)
      if (!profile || profile.workspaceId !== workspaceId || profile.ownerUserId !== userId) throw denied()
      await withBrowserProfileOwnerMutation(profileId, profile, async client => {
        const saved = await client.query<{ encrypted_secret: Buffer }>(
          `SELECT encrypted_secret FROM browser_credentials WHERE id=$1 AND profile_id=$2
            AND workspace_id=$3 AND owner_user_id=$4 FOR UPDATE`, [credentialId, profileId, workspaceId, userId])
        const envelope = saved.rows[0]?.encrypted_secret
        if (!envelope || createHash('sha256').update(envelope).digest('hex') !== version) throw denied()
        if (result === 'success') {
          await client.query(
            `UPDATE browser_credentials
                SET status = 'active', last_used_at = now(), last_failure_code = NULL, updated_at = now()
              WHERE id = $1`,
            [credentialId],
          )
          return
        }
        await client.query(
          `UPDATE browser_credentials
              SET status = 'invalid', last_failure_code = $2, updated_at = now()
            WHERE id = $1`,
          [credentialId, failureCode ?? 'backend_error'],
        )
      })
    },
  }
}
