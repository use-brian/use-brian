/** Deployment key storage, separate from transport credentials and JWT_SECRET. [COMP:api/connector-actor-context] */
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { ApplicationPlatformError } from '@use-brian/shared'
import { getPool } from '../db/client.js'
import { decryptCredentials, encryptCredentials } from '../db/credential-crypto.js'
import type { ConnectorActorSigningKey } from './connector-actor-context.js'

type PrivateMaterial = { version: 1; pkcs8: string }
function issuerIdentity(issuer: string) {
  try {
    const url = new URL(issuer)
    if (issuer.length <= 2048 && url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search) return
  } catch { /* A deployment configuration error never exposes its value. */ }
  throw new ApplicationPlatformError('invalid_value', 'The connector issuer is invalid.')
}
export function createConnectorActorKeyStore(encryptionKey: Buffer, pool: Pool = getPool()) {
  if (encryptionKey.length !== 32) throw new ApplicationPlatformError('access_unavailable', 'Credential encryption is unavailable.')
  const key = Buffer.from(encryptionKey)
  return {
    /** Internal deployment primitive. Protected human/Brian setup must review/qualify before calling it. */
    async rotateSystem(issuer: string): Promise<{ kid: string }> {
      issuerIdentity(issuer)
      const pair = generateKeyPairSync('ed25519'), kid = randomUUID()
      const encrypted = encryptCredentials<PrivateMaterial>({ version: 1, pkcs8: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }, key)
      const publicJwk = { ...pair.publicKey.export({ format: 'jwk' }), kid, alg: 'EdDSA', use: 'sig' }
      const transaction = await pool.connect()
      try {
        await transaction.query('BEGIN')
        await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`connector-actor-key:${issuer}`])
        await transaction.query(`WITH retirement AS (SELECT clock_timestamp() AS at)
          UPDATE connector_actor_signing_keys SET status='retiring',retired_at=retirement.at,retain_until=retirement.at+interval '65 seconds'
          FROM retirement WHERE issuer=$1 AND status='active'`, [issuer])
        await transaction.query('INSERT INTO connector_actor_signing_keys(kid,issuer,encrypted_private_key,public_jwk) VALUES($1,$2,$3,$4)', [kid,issuer,encrypted,publicJwk])
        await transaction.query('COMMIT')
        return { kid }
      } catch { await transaction.query('ROLLBACK').catch(() => {}); throw new ApplicationPlatformError('access_unavailable', 'Connector key setup is unavailable.') }
      finally { transaction.release() }
    },
    async revokeSystem(issuer: string, kid: string): Promise<boolean> {
      issuerIdentity(issuer)
      const result = await pool.query("UPDATE connector_actor_signing_keys SET status='revoked',revoked_at=clock_timestamp() WHERE issuer=$1 AND kid=$2 AND status<>'revoked'", [issuer,kid])
      return result.rowCount === 1
    },
    async loadActiveKey(issuer: string): Promise<ConnectorActorSigningKey | null> {
      issuerIdentity(issuer)
      const result = await pool.query<{ kid: string; encrypted_private_key: Buffer; public_jwk: { x: string }; valid_from: Date }>(
        "SELECT kid,encrypted_private_key,public_jwk,valid_from FROM connector_actor_signing_keys WHERE issuer=$1 AND status='active' AND valid_from<=clock_timestamp()", [issuer])
      const row = result.rows[0]
      if (!row) return null
      try {
        const material = decryptCredentials<PrivateMaterial>(row.encrypted_private_key, key)
        if (material.version !== 1 || typeof material.pkcs8 !== 'string') return null
        const privateKey = createPrivateKey(material.pkcs8)
        if (privateKey.asymmetricKeyType !== 'ed25519' || createPublicKey(privateKey).export({ format: 'jwk' }).x !== row.public_jwk.x) return null
        return { kid: row.kid, privateKey, notBefore: Math.floor(row.valid_from.getTime() / 1000) }
      } catch { return null }
    },
    async keyCurrent(kid: string): Promise<boolean> {
      return (await pool.query("SELECT kid FROM connector_actor_signing_keys WHERE kid=$1 AND status='active' AND valid_from<=clock_timestamp()", [kid])).rows.length === 1
    },
    async publicJwks(issuer: string): Promise<{ keys: Array<Record<string, unknown>> }> {
      issuerIdentity(issuer)
      return (await pool.query<{ jwks: { keys: Array<Record<string, unknown>> } }>('SELECT connector_actor_public_jwks($1) AS jwks', [issuer])).rows[0].jwks
    },
  }
}
