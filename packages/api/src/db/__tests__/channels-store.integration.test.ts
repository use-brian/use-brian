import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import pg from 'pg'

/**
 * [COMP:channels/store] — DB-backed tests for channels-store.ts.
 *
 * Covers `findOrCreateChannelForConnect` (the connect-flow channel
 * provisioning — create path, re-install idempotency, per-platform
 * capability defaults) and the webhook resolution reads
 * (`getChannelForWebhook`, `resolveAssistantForSurface`).
 *
 * Requires a local `Use Brian` PostgreSQL database with migration 153/154/158
 * applied. Skips silently when unavailable.
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'Use Brian', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      await client.query('SELECT 1 FROM channels LIMIT 1')
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
  const r = await client.query(
    `INSERT INTO users (id, auth_provider, auth_provider_id)
     VALUES (gen_random_uuid(), 'test', 'channels-' || gen_random_uuid())
     RETURNING id`,
  )
  return r.rows[0].id
}

async function makeWorkspace(client: pg.PoolClient, ownerId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
     VALUES (gen_random_uuid(), 'channels-test-ws', 'test', $1, false)
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
  const r = await client.query(
    `INSERT INTO assistants (id, name, owner_user_id, workspace_id)
     VALUES (gen_random_uuid(), 'channels-test-assistant', $1, $2)
     RETURNING id`,
    [ownerId, workspaceId],
  )
  return r.rows[0].id
}

describeIf('[COMP:channels/store] findOrCreateChannelForConnect', () => {
  let store: typeof import('../channels-store.js')

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    store = await import('../channels-store.js')
  })

  it('creates a channel and seeds the default routing row', async () => {
    const client = await pool!.connect()
    let assistantId: string
    try {
      const owner = await makeUser(client)
      const ws = await makeWorkspace(client, owner)
      assistantId = await makeAssistant(client, owner, ws)
    } finally {
      client.release()
    }

    // Connect flow: the channel is created BEFORE any channel_integrations
    // row — its `channel_id` FK is NOT NULL since migration 158.
    const channelId = await store.findOrCreateChannelForConnect({
      assistantId,
      channelType: 'slack',
      displayName: 'Acme Slack',
    })
    expect(channelId).toBeTruthy()

    const channel = await store.getChannelForWebhook(channelId)
    expect(channel?.channelType).toBe('slack')
    expect(channel?.displayName).toBe('Acme Slack')
    // Slack gets the full capability set (CHANNEL_CAPABILITIES.slack).
    expect(channel?.enabledCapabilities.slice().sort()).toEqual(['broadcast', 'chat', 'ingest'])

    // The default (NULL-surface) routing row resolves to the connecting
    // assistant — for the channel default and for any unmapped surface.
    expect(await store.resolveAssistantForSurface(channelId, null)).toBe(assistantId)
    expect(await store.resolveAssistantForSurface(channelId, 'C-UNMAPPED')).toBe(assistantId)

    // The seeded routing row's model tier defaults to Pro (migration 234):
    // the assistant's `slack_model_alias` seed column is 'pro' by default and
    // `findOrCreateChannelForConnect` copies it onto the routing row.
    const aliasCheck = await pool!.connect()
    try {
      const r = await aliasCheck.query<{ model_alias: string }>(
        `SELECT model_alias FROM channel_assistants
          WHERE channel_id = $1 AND external_surface_id IS NULL`,
        [channelId],
      )
      expect(r.rows[0]?.model_alias).toBe('pro')
    } finally {
      aliasCheck.release()
    }
  })

  it('is idempotent — a re-connect returns the same channel, no duplicate', async () => {
    const client = await pool!.connect()
    let assistantId: string
    try {
      const owner = await makeUser(client)
      const ws = await makeWorkspace(client, owner)
      assistantId = await makeAssistant(client, owner, ws)
    } finally {
      client.release()
    }

    const first = await store.findOrCreateChannelForConnect({
      assistantId,
      channelType: 'telegram',
      displayName: 'Test Bot',
    })
    const second = await store.findOrCreateChannelForConnect({
      assistantId,
      channelType: 'telegram',
      displayName: 'Test Bot',
    })
    expect(second).toBe(first)

    const verify = await pool!.connect()
    try {
      const r = await verify.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM channels WHERE id = $1`,
        [first],
      )
      expect(r.rows[0].count).toBe('1')
    } finally {
      verify.release()
    }
  })

  it('applies per-platform capability defaults and the display-name fallback', async () => {
    const client = await pool!.connect()
    let assistantId: string
    try {
      const owner = await makeUser(client)
      const ws = await makeWorkspace(client, owner)
      assistantId = await makeAssistant(client, owner, ws)
    } finally {
      client.release()
    }

    // null displayName → display-name fallback.
    const channelId = await store.findOrCreateChannelForConnect({
      assistantId,
      channelType: 'telegram',
      displayName: null,
    })
    const channel = await store.getChannelForWebhook(channelId)
    // Telegram gets chat + broadcast but not ingest.
    expect(channel?.enabledCapabilities.slice().sort()).toEqual(['broadcast', 'chat'])
    expect(channel?.displayName).toBe('Telegram connection')
  })
})
