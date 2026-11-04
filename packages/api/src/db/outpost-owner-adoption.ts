import type pg from 'pg'
import { getPool } from './client.js'

/** [COMP:api/outpost-owner-adoption] Called only after native email verification. */
export async function adoptVerifiedLocalOwner(
  configured: { userId: string; email: string },
  verifiedEmail: string,
  pool?: Pick<pg.Pool, 'connect'>,
): Promise<string | null> {
  if (verifiedEmail !== configured.email) return null
  const client = await (pool ?? getPool()).connect()
  try {
    await client.query('BEGIN')
    const result = await client.query<{
      id: string; email: string | null; auth_provider: string; auth_provider_id: string
    }>('SELECT id, email, auth_provider, auth_provider_id FROM users WHERE id = $1 FOR UPDATE', [configured.userId])
    const owner = result.rows[0]
    if (!owner) throw new Error('outpost_owner_adoption_source_missing')
    const conflict = await client.query(
      `SELECT id FROM users WHERE id <> $1 AND
        (lower(email) = $2 OR (auth_provider = 'email' AND lower(auth_provider_id) = $2)) LIMIT 1`,
      [configured.userId, configured.email],
    )
    if (conflict.rows.length) throw new Error('outpost_owner_adoption_identity_conflict')
    if (owner.email === configured.email && owner.auth_provider === 'email' && owner.auth_provider_id === configured.email) {
      await client.query('COMMIT')
      return owner.id
    }
    if (owner.auth_provider !== 'local' || owner.auth_provider_id !== 'local-owner' || owner.email !== 'owner@local') {
      throw new Error('outpost_owner_adoption_source_changed')
    }
    await client.query(
      `UPDATE users SET email = $2, auth_provider = 'email', auth_provider_id = $2,
        auth_version = auth_version + 1 WHERE id = $1`,
      [configured.userId, configured.email],
    )
    await client.query(
      'UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, clock_timestamp()) WHERE user_id = $1',
      [configured.userId],
    )
    await client.query('COMMIT')
    return owner.id
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
