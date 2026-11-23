import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { APP_LEVEL_ASSISTANT_ID } from '@use-brian/shared'
import { readToolPolicies } from '@use-brian/agent-runtime/mcp/policy.js'
import { getPool } from '../../db/client.js'
import { createDbMcpSettingsStore } from '../../db/mcp-settings-store.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
afterAll(() => pool.end())

describe('[COMP:api/mcp-surface] PostgreSQL policy batch', () => {
  it('reads a set of exact scope pairs and names in one statement', async () => {
    const userId = randomUUID()
    const otherUserId = randomUUID()
    const assistantId = randomUUID()
    const serverName = `shopify:${randomUUID()}`
    await pool.query('INSERT INTO users(id, auth_provider_id) SELECT id, id::text FROM unnest($1::uuid[]) id', [[userId, otherUserId]])
    const store = createDbMcpSettingsStore()
    for (const row of [
      { assistantId: APP_LEVEL_ASSISTANT_ID, serverName: 'shopify', toolName: 'listProducts', policy: 'ask' },
      { assistantId, serverName, toolName: 'listProducts', policy: 'allow' },
      { assistantId, serverName: 'shopify', toolName: 'listProducts', policy: 'block' },
      { assistantId, serverName: 'shopify', toolName: 'getProduct', policy: 'block' },
      { assistantId: APP_LEVEL_ASSISTANT_ID, serverName, toolName: 'getProduct', policy: 'block' },
      { assistantId, serverName, toolName: 'unrequested', policy: 'block' },
      { assistantId, serverName, toolName: 'getProduct', policy: 'allow', userId: otherUserId },
    ] as const) {
      await store.setPolicy({ userId, classification: 'read', ...row })
    }

    const query = vi.spyOn(pool, 'query')
    try {
      const keys = { assistantId, userId, serverName, appServerName: 'shopify', assistantFallbackServerName: 'shopify' }
      expect(await readToolPolicies(store, keys, [
        { name: 'listProducts', defaultPolicy: 'allow' },
        { name: 'getProduct', defaultPolicy: 'allow' },
        { name: 'addProductImage', defaultPolicy: 'ask' },
      ])).toEqual([
        { appPolicy: 'ask', assistantPolicy: 'allow', effectivePolicy: 'ask' },
        { appPolicy: 'allow', assistantPolicy: 'block', effectivePolicy: 'block' },
        { appPolicy: 'ask', assistantPolicy: 'ask', effectivePolicy: 'ask' },
      ])
      expect(query).toHaveBeenCalledTimes(1)
    } finally {
      query.mockRestore()
    }
  })
})
