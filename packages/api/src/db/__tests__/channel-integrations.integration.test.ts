/**
 * [COMP:api/channel-integrations-store] — DB-backed tests for the
 * `channel_integrations` webhook hot path.
 *
 * The pure crypto-roundtrip suite lives in `channel-integrations.test.ts`
 * and only covers `encryptCredentials` / `decryptCredentials`. This file
 * exercises the actual SQL — specifically `getByChannelForWebhook`, which
 * silently shipped with a reference to a column dropped by migration 158
 * (`assistant_id`). Every inbound BYO Telegram webhook 500'd until the
 * `OR assistant_id = $1` clause was removed; no test caught it because
 * no test executed the query against the live schema. This suite closes
 * that gap.
 *
 * Requires a local `sidanclaw` PostgreSQL database with migration 158
 * applied. Skips silently when unavailable so unit-test runs on machines
 * without Postgres still pass.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'sidanclaw', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      await client.query('SELECT 1 FROM channel_integrations LIMIT 1')
    } finally {
      client.release()
    }
    pool = p
    return true
  } catch {
    await p.end().catch(() => {})
    return false
  }
}

const ok = await canConnect()
const describeIf = ok ? describe : describe.skip

afterAll(async () => {
  if (pool) await pool.end()
})

async function makeUser(client: pg.PoolClient): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO users (id, auth_provider, auth_provider_id)
     VALUES (gen_random_uuid(), 'test', 'ci-' || gen_random_uuid())
     RETURNING id`,
  )
  return r.rows[0].id
}

async function makeWorkspace(client: pg.PoolClient, ownerId: string): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
     VALUES (gen_random_uuid(), 'ci-test-ws', 'test', $1, false)
     RETURNING id`,
    [ownerId],
  )
  return r.rows[0].id
}

async function makeAssistant(
  client: pg.PoolClient,
  ownerId: string,
  workspaceId: string,
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO assistants (id, name, owner_user_id, workspace_id)
     VALUES (gen_random_uuid(), 'ci-test-assistant', $1, $2)
     RETURNING id`,
    [ownerId, workspaceId],
  )
  return r.rows[0].id
}

describeIf('[COMP:api/channel-integrations-store] schema invariants (migration 158)', () => {
  it('the assistant_id column is gone — the webhook query must not reference it', async () => {
    const client = await pool!.connect()
    try {
      const r = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'channel_integrations'`,
      )
      const cols = r.rows.map((row) => row.column_name)
      expect(cols).toContain('channel_id')
      expect(cols).not.toContain('assistant_id')
    } finally {
      client.release()
    }
  })
})

describeIf('[COMP:api/channel-integrations-store] getByChannelForWebhook', () => {
  let storeMod: typeof import('../channel-integrations.js')
  let channelsStore: typeof import('../channels-store.js')

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    storeMod = await import('../channel-integrations.js')
    channelsStore = await import('../channels-store.js')
  })

  async function seedChannelWithIntegration(opts: {
    channelType: 'telegram' | 'slack'
    status?: 'active' | 'revoked'
  }): Promise<{
    channelId: string
    assistantId: string
    integrationId: string
    key: Buffer
    store: import('../channel-integrations.js').ChannelIntegrationStore
  }> {
    const client = await pool!.connect()
    let ownerId: string
    let workspaceId: string
    let assistantId: string
    try {
      ownerId = await makeUser(client)
      workspaceId = await makeWorkspace(client, ownerId)
      // The owner must be a workspace_member for the RLS-enforced app pool to
      // see the channel (the channel_integrations policy gates inserts on
      // `channel_id IN (SELECT id FROM channels)`, and channels are
      // member-visible). Prod adds the owner as a member at workspace creation;
      // the local superuser previously masked this gap by bypassing RLS.
      await client.query(
        `INSERT INTO workspace_members (id, workspace_id, user_id, role, clearance)
         VALUES (gen_random_uuid(), $1, $2, 'owner', 'confidential')`,
        [workspaceId, ownerId],
      )
      assistantId = await makeAssistant(client, ownerId, workspaceId)
    } finally {
      client.release()
    }

    const channelId = await channelsStore.findOrCreateChannelForConnect({
      assistantId,
      channelType: opts.channelType,
      displayName: `ci-${opts.channelType}`,
    })

    const key = randomBytes(32)
    const store = storeMod.createDbChannelIntegrationStore(key)
    const integration = await store.upsert({
      channelId,
      channelType: opts.channelType,
      teamId: null,
      teamName: null,
      botUserId: null,
      botUsername: opts.channelType === 'telegram' ? 'ci_test_bot' : null,
      credentials:
        opts.channelType === 'telegram'
          ? { bot_token: '1234567:fake', webhook_secret: randomBytes(16).toString('hex') }
          : { bot_token: 'xoxb-fake', signing_secret: 'fake-secret' },
      actingUserId: ownerId,
    })

    if (opts.status === 'revoked') {
      const c = await pool!.connect()
      try {
        await c.query(`UPDATE channel_integrations SET status='revoked' WHERE id=$1`, [integration.id])
      } finally {
        c.release()
      }
    }

    return { channelId, assistantId, integrationId: integration.id, key, store }
  }

  it('resolves an active integration by channel_id and decrypts credentials', async () => {
    const { channelId, store } = await seedChannelWithIntegration({ channelType: 'telegram' })

    const found = await store.getByChannelForWebhook(channelId, 'telegram')
    expect(found).not.toBeNull()
    expect(found!.channelId).toBe(channelId)
    expect(found!.channelType).toBe('telegram')
    // Credentials are decrypted in-place (the route reads bot_token off this).
    expect((found!.credentials as { bot_token: string }).bot_token).toBe('1234567:fake')
  })

  it('returns null when the slug is an assistant id — the route falls back to getCredentialsForAssistantSystem', async () => {
    // This is the regression that broke prod: pre-158 the slug was the
    // assistant id and the query matched on `assistant_id`. Post-158 the
    // column is gone; the store must return null cleanly so the route can
    // hit its `getCredentialsForAssistantSystem` fallback instead of 500'ing
    // on a parse error.
    const { assistantId, store } = await seedChannelWithIntegration({ channelType: 'telegram' })

    const found = await store.getByChannelForWebhook(assistantId, 'telegram')
    expect(found).toBeNull()
  })

  it('returns null for an unknown channel id', async () => {
    const { store } = await seedChannelWithIntegration({ channelType: 'telegram' })
    const found = await store.getByChannelForWebhook(randomUUID(), 'telegram')
    expect(found).toBeNull()
  })

  it('filters by channel_type — a telegram integration is invisible to a slack lookup', async () => {
    const { channelId, store } = await seedChannelWithIntegration({ channelType: 'telegram' })
    const wrongType = await store.getByChannelForWebhook(channelId, 'slack')
    expect(wrongType).toBeNull()
  })

  it('hides revoked integrations from the webhook lookup', async () => {
    const { channelId, store } = await seedChannelWithIntegration({
      channelType: 'telegram',
      status: 'revoked',
    })
    const found = await store.getByChannelForWebhook(channelId, 'telegram')
    expect(found).toBeNull()
  })
})
