import { randomBytes } from 'node:crypto'
import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { encryptCredentials } from '../../db/credential-crypto.js'
import { packShopifyTokens, unpackShopifyTokens } from '../../shopify/client.js'
import { refreshShopifyInstanceCredentials } from '../shopify-rotation.js'

const key = randomBytes(32)

/** A pool whose one client answers the rotation's reads from a fixed instance row. */
function poolFor(stored: unknown): Pool {
  const credentials = encryptCredentials(stored, key)
  const client = {
    async query(sql: string) {
      if (sql.includes('SELECT i.credentials')) return { rows: [{ credentials, setup_managed: false, account_digest: null }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    },
    release() {},
  }
  return { connect: async () => client } as unknown as Pool
}

describe('[COMP:api/shopify-rotation] Shopify credential rotation read', () => {
  // Hosted connect and the legacy refresh writers store `{ client_id, client_secret }`
  // with no `type`. The rotation path must return them as OAuth, or every
  // Shopify call on such an instance fails `connector_rotation_reconnect_required`.
  it.each([
    ['static token', { shopDomain: 'fixture.myshopify.com', accessToken: 'shpat_fixture' }],
    ['expiring token outside the refresh window', { shopDomain: 'fixture.myshopify.com', accessToken: 'shpat_fixture',
      refreshToken: 'refresh-fixture', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }],
  ])('returns an untyped stored pair as OAuth (%s)', async (_label, tokens) => {
    const result = await refreshShopifyInstanceCredentials(poolFor({ client_id: 'shopify_oauth', client_secret: packShopifyTokens(tokens) }), key, 'instance')
    expect(result?.type).toBe('oauth')
    const unpacked = result?.type === 'oauth' ? unpackShopifyTokens(result.client_secret) : null
    expect(unpacked?.accessToken).toBe('shpat_fixture')
  })

  it('returns a typed stored pair unchanged', async () => {
    const stored = { type: 'oauth', client_id: 'shopify_oauth', client_secret: packShopifyTokens({ shopDomain: 'fixture.myshopify.com', accessToken: 'shpat_fixture' }) }
    expect(await refreshShopifyInstanceCredentials(poolFor(stored), key, 'instance')).toEqual(stored)
  })
})
