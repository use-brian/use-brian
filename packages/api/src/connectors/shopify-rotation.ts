import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { decryptCredentials, encryptCredentials } from '../db/credential-crypto.js'
import type { ConnectorCredentials } from '../db/connector-store.js'
import { getConnectorConfig } from '../connector-config.js'
import { isManagedShopifyTokens, unpackShopifyTokens, packShopifyTokens, shopifyAppCredentialsFromTokens, refreshShopifyTokens, type ShopifyTokens } from '../shopify/client.js'
import { connectorSetupProviders } from './setup-providers.js'
import { ConnectorSetupLockRetry, lockConnectorSetupWorkspaces } from './setup-locks.js'
import { ConnectorSetupError, type VerifiedAccount } from './setup-service.js'

const digest = (a: VerifiedAccount) => createHash('sha256').update(JSON.stringify({ subject: a.subject, tenant: a.tenant,
  roots: [...a.roots].sort(), permissions: [...a.permissions].sort(), adapter: a.adapter, adapterVersion: a.adapterVersion })).digest('hex')
type OAuth = Extract<ConnectorCredentials, { type: 'oauth' }>
type Claim = { kind: 'usable'; credentials: ConnectorCredentials | null } | {
  kind: 'refresh'; previous: OAuth; current: ShopifyTokens; initial: Buffer; fingerprint: string; encryptedResult: Buffer | null
}

/** Serialize across processes on one checked-out connection (including max=1
 * pools). Commit an uncertain fence BEFORE consuming a refresh token. A crash
 * or lost response never reuses that token. Persist returned material encrypted
 * before verification, so retries repeat verification/publication, NOT exchange.
 * No transaction/row lock is held across either provider network call. */
export async function refreshShopifyInstanceCredentials(pool: Pool, key: Buffer, id: string): Promise<ConnectorCredentials | null> {
  const c = await pool.connect()
  let advisoryLocked = false
  async function transaction<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        await c.query('BEGIN')
        await c.query("SELECT set_config('app.system_bypass','true',true)")
        const result = await fn()
        await c.query('COMMIT')
        return result
      } catch (error) {
        await c.query('ROLLBACK')
        if (error instanceof ConnectorSetupLockRetry && attempt < 3) continue
        throw error
      }
    }
  }
  try {
    await c.query("SELECT pg_advisory_lock(hashtextextended('shopify-refresh:' || $1,0))", [id])
    advisoryLocked = true
    const claim = await transaction<Claim>(async () => {
      await lockConnectorSetupWorkspaces(c, null, id)
      const row = (await c.query(`SELECT i.credentials,i.setup_managed,x.account_digest FROM connector_instance i
        LEFT JOIN connector_setup_identity x ON x.instance_id=i.id
        WHERE i.id=$1 AND i.provider='shopify' AND i.connected=true`, [id])).rows[0]
      if (!row?.credentials) return { kind: 'usable', credentials: null }
      const previous = decryptCredentials<ConnectorCredentials>(row.credentials, key)
      if (previous.type !== 'oauth') return { kind: 'usable', credentials: previous }
      const current = unpackShopifyTokens(previous.client_secret)
      if (!current || !isManagedShopifyTokens(current)) return { kind: 'usable', credentials: previous }
      const fingerprint = createHash('sha256').update(current.refreshToken!).digest('hex')
      const existing = (await c.query<{ status: string; encrypted_result: Buffer | null }>(`SELECT status,encrypted_result
        FROM connector_rotation_attempts WHERE instance_id=$1 AND refresh_fingerprint=$2 FOR UPDATE`, [id, fingerprint])).rows[0]
      if (existing) {
        if (existing.status === 'uncertain') throw new ConnectorSetupError('connector_rotation_uncertain')
        if (existing.status !== 'pending_verification' || !existing.encrypted_result) throw new ConnectorSetupError('connector_rotation_reconnect_required')
        return { kind: 'refresh', previous, current, initial: row.credentials, fingerprint, encryptedResult: existing.encrypted_result }
      }
      if (Date.parse(current.expiresAt!) - Date.now() > 120000) return { kind: 'usable', credentials: previous }
      if (row.setup_managed && !row.account_digest) throw new ConnectorSetupError('connector_rotation_review_required')
      // Do not consume an old unreviewed token if the publication backstop will
      // necessarily reject it in a ready workspace.
      if (!row.setup_managed && (await c.query(`SELECT 1 FROM workspace_access_policies p WHERE p.setup_state='ready'
        AND p.workspace_id IN (SELECT workspace_id FROM connector_instance WHERE id=$1
          UNION SELECT target_id FROM connector_grant WHERE connector_instance_id=$1) LIMIT 1`, [id])).rowCount) {
        throw new ConnectorSetupError('connector_rotation_review_required')
      }
      if (!(shopifyAppCredentialsFromTokens(current) ?? getConnectorConfig('shopify'))) throw new ConnectorSetupError('connector_rotation_app_required')
      await c.query(`INSERT INTO connector_rotation_attempts(instance_id,refresh_fingerprint,status) VALUES($1,$2,'uncertain')`, [id, fingerprint])
      return { kind: 'refresh', previous, current, initial: row.credentials, fingerprint, encryptedResult: null }
    })
    if (claim.kind === 'usable') return claim.credentials

    let encrypted = claim.encryptedResult
    if (!encrypted) {
      const cfg = shopifyAppCredentialsFromTokens(claim.current) ?? getConnectorConfig('shopify')
      if (!cfg) throw new ConnectorSetupError('connector_rotation_uncertain')
      try {
        // Durable fence already committed. This call is NEVER in a retry loop.
        const response = await refreshShopifyTokens({ shopDomain: claim.current.shopDomain, refreshToken: claim.current.refreshToken!, clientId: cfg.clientId, clientSecret: cfg.clientSecret })
        const next = { ...response, ...(claim.current.appClientId && claim.current.appClientSecret
          ? { appClientId: claim.current.appClientId, appClientSecret: claim.current.appClientSecret } : {}) }
        encrypted = encryptCredentials({ ...claim.previous, client_secret: packShopifyTokens(next) }, key)
        await transaction(async () => {
          await c.query(`UPDATE connector_rotation_attempts SET status='pending_verification',encrypted_result=$3
            WHERE instance_id=$1 AND refresh_fingerprint=$2 AND status='uncertain'`, [id, claim.fingerprint, encrypted])
        })
      } catch {
        // The provider might have consumed the token, including response loss.
        // Keep the durable fence; a fresh reviewed reconnect is the recovery.
        throw new ConnectorSetupError('connector_rotation_uncertain')
      }
    }
    const credentials = decryptCredentials<OAuth>(encrypted, key)
    const next = unpackShopifyTokens(credentials.client_secret)
    const requireReconnect = async (code: string): Promise<never> => {
      await transaction(async () => {
        await c.query(`UPDATE connector_rotation_attempts SET status='reconnect_required',encrypted_result=NULL
          WHERE instance_id=$1 AND refresh_fingerprint=$2`, [id, claim.fingerprint])
      })
      throw new ConnectorSetupError(code)
    }
    if (!next || next.shopDomain !== claim.current.shopDomain) return await requireReconnect('connector_rotation_identity_changed')
    // Reject unusable returned material without reusing the consumed token.
    if (!isManagedShopifyTokens(next) || !(Date.parse(next.expiresAt!) - Date.now() > 120000)) return await requireReconnect('connector_rotation_reconnect_required')
    // A transient identity service failure leaves pending_verification durable.
    const verified = await connectorSetupProviders().get('shopify')!.verify({ shopDomain: next.shopDomain, accessToken: next.accessToken }, { state: '' })
    if (!(Date.parse(next.expiresAt!) - Date.now() > 120000)) return await requireReconnect('connector_rotation_reconnect_required')
    const account = digest(verified.account)
    try {
      await transaction(async () => {
        await lockConnectorSetupWorkspaces(c, null, id)
        const live = (await c.query(`SELECT i.credentials,i.setup_version,i.setup_managed,x.account_digest
          FROM connector_instance i LEFT JOIN connector_setup_identity x ON x.instance_id=i.id
          WHERE i.id=$1 AND i.provider='shopify' AND i.connected=true`, [id])).rows[0]
        if (!live || !Buffer.from(live.credentials).equals(claim.initial)) throw new ConnectorSetupError('connector_rotation_changed')
        if (live.setup_managed) {
          if (live.account_digest !== account) throw new ConnectorSetupError('connector_rotation_identity_changed')
          await c.query(`INSERT INTO connector_setup_rotation_receipts(instance_id,transaction_id,expected_version,account_digest,credentials)
            VALUES($1,txid_current(),$2,$3,$4)`, [id, live.setup_version, account, encrypted])
        }
        if (!(Date.parse(next.expiresAt!) - Date.now() > 120000)) throw new ConnectorSetupError('connector_rotation_reconnect_required')
        await c.query("UPDATE connector_instance SET credentials=$2,health_status='ok',last_error=NULL WHERE id=$1", [id, encrypted])
        await c.query(`UPDATE connector_rotation_attempts SET status='published',encrypted_result=NULL
          WHERE instance_id=$1 AND refresh_fingerprint=$2`, [id, claim.fingerprint])
      })
    } catch (error) {
      if (error instanceof ConnectorSetupError && ['connector_rotation_changed', 'connector_rotation_identity_changed', 'connector_rotation_reconnect_required'].includes(error.code)) return await requireReconnect(error.code)
      throw error
    }
    // COMMIT itself can be slow. Fence the now-published tuple as well as the
    // consumed one before reporting reconnect; never return near-expiry auth.
    if (!(Date.parse(next.expiresAt!) - Date.now() > 120000)) {
      await transaction(async () => {
        const fingerprint = createHash('sha256').update(next.refreshToken!).digest('hex')
        await c.query(`INSERT INTO connector_rotation_attempts(instance_id,refresh_fingerprint,status)
          VALUES($1,$2,'reconnect_required') ON CONFLICT(instance_id,refresh_fingerprint)
          DO UPDATE SET status='reconnect_required',encrypted_result=NULL`, [id, fingerprint])
      })
      return await requireReconnect('connector_rotation_reconnect_required')
    }
    return credentials
  } catch (error) {
    if (error instanceof ConnectorSetupError) throw error
    throw new ConnectorSetupError('connector_rotation_failed')
  } finally {
    try { if (advisoryLocked) await c.query("SELECT pg_advisory_unlock(hashtextextended('shopify-refresh:' || $1,0))", [id]) }
    finally { c.release() }
  }
}
