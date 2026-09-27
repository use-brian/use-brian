import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTelegramDiscussionStore, observeTelegramDiscussion } from '../telegram-discussion-context.js'
import type { query } from '../db/client.js'

// Isolated schema: exercise the actual migration and SQL without modifying
// application records. Skip explicitly when no test Postgres is reachable.
const connectionString = process.env.DATABASE_URL ?? 'postgres:///sidanclaw'
const probe = new pg.Client({ connectionString, connectionTimeoutMillis: 1000 })
const available = await probe.connect().then(() => true, () => false)
await probe.end()
const schema = `tg_context_${randomUUID().replaceAll('-', '')}`
let client: pg.Client
let store: ReturnType<typeof createTelegramDiscussionStore>
const a = randomUUID(), b = randomUUID()
async function connect() {
  client = new pg.Client({ connectionString })
  await client.connect()
  await client.query(`SET search_path TO ${schema}`)
  store = createTelegramDiscussionStore(client.query.bind(client) as typeof query)
}

describe.skipIf(!available)('durable Telegram source context (Postgres)', () => {
  beforeAll(async () => {
    await connect()
    await client.query(`CREATE SCHEMA ${schema}`)
    await client.query('CREATE TABLE channel_integrations (id uuid PRIMARY KEY)')
    await client.query(readFileSync(new URL('../../migrations/563_telegram_discussion_context.sql', import.meta.url), 'utf8'))
    await client.query('INSERT INTO channel_integrations VALUES ($1),($2)', [a, b])
  })
  afterAll(async () => {
    await client.query(`DROP SCHEMA ${schema} CASCADE`)
    await client.end()
  })
  it('survives a new DB connection/store, replays, and nested lookups for distinct roots', async () => {
    await observeTelegramDiscussion(store, a, { channel_post: { message_id: 7, chat: { id: -10, type: 'channel' }, text: 'Post seven' } })
    await observeTelegramDiscussion(store, a, { message: { message_id: 30, chat: { id: -20, type: 'supergroup' }, is_automatic_forward: true,
      forward_origin: { type: 'channel', chat: { id: -10 }, message_id: 7 } } })
    await store.saveRoot(a, '-20', '40', '-10', '8', 'Other root')
    await client.end()
    await connect()
    expect(await store.read(a, '-20', '30')).toBe('Post seven')
    expect(await store.read(a, '-20', '40')).toBe('Other root')
    await store.saveRoot(a, '-20', '30', '-10', '7', null)
    expect(await store.read(a, '-20', '30')).toBe('Post seven')
    expect((await client.query('SELECT * FROM telegram_discussion_roots WHERE integration_id=$1', [a])).rowCount).toBe(2)
  })
  it('isolates integrations with identical Telegram ids and never guesses missing mappings', async () => {
    await store.savePost(b, '-10', '7', 'Tenant B')
    expect(await store.read(b, '-20', '30')).toBeNull()
    await store.saveRoot(b, '-20', '30', '-10', '7', null)
    expect(await store.read(b, '-20', '30')).toBe('Tenant B')
    expect(await store.read(a, '-20', '30')).toBe('Post seven')
    expect(await store.read(a, '-99', '30')).toBeNull()
    await store.saveRoot(a, '-20', '50', '-10', null, null)
    expect(await store.read(a, '-20', '50')).toBeNull()
  })
  it('supports late channel deliveries and sender-only privacy snapshots without changing verified mappings', async () => {
    await store.saveRoot(a, '-20', '60', '-10', '9', null)
    expect(await store.read(a, '-20', '60')).toBeNull()
    await store.savePost(a, '-10', '9', 'Late delivery')
    expect(await store.read(a, '-20', '60')).toBe('Late delivery')
    await store.saveRoot(a, '-20', '60', '-99', '9', 'Wrong source')
    expect(await store.read(a, '-20', '60')).toBe('Late delivery')
    await store.saveRoot(a, '-20', '70', '-10', null, 'Privacy snapshot')
    await store.saveRoot(a, '-20', '70', '-10', '10', null)
    expect(await store.read(a, '-20', '70')).toBe('Privacy snapshot')
  })
  it('enables RLS without member policies and cascades integration deletion', async () => {
    const tables = await client.query(`SELECT relrowsecurity FROM pg_class WHERE relnamespace=$1::regnamespace AND relkind='r' AND relname LIKE 'telegram_%'`, [schema])
    expect(tables.rows).toEqual([{ relrowsecurity: true }, { relrowsecurity: true }])
    expect((await client.query('SELECT * FROM pg_policies WHERE schemaname=$1', [schema])).rowCount).toBe(0)
    await client.query('DELETE FROM channel_integrations WHERE id=$1', [b])
    expect(await store.read(b, '-20', '30')).toBeNull()
    expect((await client.query('SELECT * FROM telegram_channel_posts WHERE integration_id=$1', [b])).rowCount).toBe(0)
  })
})
