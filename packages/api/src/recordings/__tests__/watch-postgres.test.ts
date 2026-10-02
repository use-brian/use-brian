import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
let pool: pg.Pool
vi.mock('../../db/client.js', () => ({ getPool: () => pool, query: (sql: string, params?: unknown[]) => pool.query(sql, params) }))
import { watchStore, withCaptureLock, sha256, LIMITS } from '../watch-store.js'
const exec = promisify(execFile)
// Run with real PostgreSQL binaries on PATH. This lane verifies multi-connection locks, not mocks/PGlite.
describe.skipIf(process.env.WATCH_POSTGRES_TEST !== '1')('watch real PostgreSQL concurrency/retention', () => {
  let dir: string, started = false
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'watch-pg-'))
    const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as {port: number}).port
    await new Promise<void>(resolve => server.close(() => resolve()))
    await exec('initdb', ['-D', join(dir, 'data'), '--auth=trust', '--username=watch_test', '--no-locale'])
    await exec('pg_ctl', ['-D', join(dir, 'data'), '-l', join(dir, 'postgres.log'), '-o', `-F -h 127.0.0.1 -p ${port} -k ${dir}`, '-w', 'start'])
    started = true
    pool = new pg.Pool({ host: '127.0.0.1', port, user: 'watch_test', database: 'postgres', max: 4 })
    await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY); CREATE TABLE workspaces(id uuid PRIMARY KEY); CREATE TABLE assistants(id uuid PRIMARY KEY);
      CREATE TABLE episodes(id uuid PRIMARY KEY,workspace_id uuid,assistant_id uuid,created_by_user_id uuid,source_kind text,occurred_at timestamptz);
      CREATE TABLE workspace_files(id uuid PRIMARY KEY,workspace_id uuid,created_by_user_id uuid,path text);
      CREATE TABLE saved_views(id uuid PRIMARY KEY,workspace_id uuid,created_by uuid,linked_recording_id uuid);`)
    await pool.query(await readFile(new URL('../../../migrations/650_watch_recording.sql', import.meta.url), 'utf8'))
  }, 120000)
  afterAll(async () => {
    await pool?.end()
    if (started) await exec('pg_ctl', ['-D', join(dir, 'data'), '-m', 'fast', '-w', 'stop'])
    if (dir) await rm(dir, { recursive: true, force: true })
  }, 60000)
  async function fixtures() {
    const ownerId = randomUUID(), workspaceId = randomUUID(), assistantId = randomUUID()
    await pool.query('INSERT INTO users VALUES($1)', [ownerId]); await pool.query('INSERT INTO workspaces VALUES($1)', [workspaceId]); await pool.query('INSERT INTO assistants VALUES($1)', [assistantId])
    const input = { ownerId, workspaceId, assistantId, deviceId: randomUUID(), label: 'Watch', deployment: 'test', provisioningKey: 'server-key' }
    const tokens = await watchStore.provision(input), g = await watchStore.authenticate(tokens.accessToken, 'test')
    const meta = { capturedAt: '2026-01-01T00:00:00Z', title: 'Capture', source: 'apple-watch' }
    const c = await watchStore.create(g, randomUUID(), meta)
    return { input, g, c, meta }
  }
  it('cleanup skips active capture work, while another capture runs; expiry prevents publication and later cleanup purges', async () => {
    const { g, c, meta } = await fixtures(), other = await watchStore.create(g, randomUUID(), meta), audio = Buffer.from('audio')
    await watchStore.receive(g, c, { sequence: 0, offsetMs: 0, durationMs: 1000, checksum: sha256(audio), audio })
    await watchStore.initializeUpload(g, c, { sha256: sha256(audio), bytes: audio.length, durationMs: 1000 })
    let entered!: () => void, release!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve }), barrier = new Promise<void>(resolve => { release = resolve })
    const running = withCaptureLock(c.id, async db => {
      entered(); await barrier
      await expect(watchStore.assertLive(c.id, db)).rejects.toMatchObject({ status: 410 })
    })
    await ready
    try {
      await withCaptureLock(other.id, async () => {}) // unrelated work is not globally blocked
      await expect(withCaptureLock(c.id, async () => {})).rejects.toMatchObject({ message: 'capture_busy' })
      await pool.query("UPDATE watch_captures SET expires_at=now()-interval '1 second' WHERE id=$1", [c.id])
      await watchStore.cleanup()
      expect((await watchStore.windows(c.id)).length).toBe(1) // advisory lock prevented concurrent deletion
      expect(await watchStore.upload(c.id)).not.toBeNull()
      expect((await pool.query('SELECT state FROM watch_captures WHERE id=$1', [c.id])).rows[0].state).toBe('open')
    } finally { release(); await running }
    await watchStore.cleanup()
    expect(await watchStore.windows(c.id)).toEqual([])
    expect(await watchStore.upload(c.id)).toBeNull()
    expect((await pool.query('SELECT state FROM watch_captures WHERE id=$1', [c.id])).rows[0].state).toBe('expired')
    expect((await pool.query("UPDATE watch_captures SET state='finalized' WHERE id=$1 AND state='sealed' AND expires_at>clock_timestamp() RETURNING id", [c.id])).rows).toEqual([])
  }, 30000)
  it('concurrent provisioning/session initialization and identical audio retries produce one identity/receipt', async () => {
    const { input, g, meta } = await fixtures()
    const grants = await Promise.all([watchStore.provision(input), watchStore.provision(input)])
    expect(grants[0].grantId).toBe(grants[1].grantId)
    const client = randomUUID(), captures = await Promise.all([watchStore.create(g, client, meta), watchStore.create(g, client, meta)])
    expect(captures[0].id).toBe(captures[1].id)
    const audio = Buffer.from('audio'), chunk = { sequence: 0, offsetMs: 0, durationMs: 1000, checksum: sha256(audio), audio }
    await Promise.all(captures.map(c => watchStore.receive(g, c, chunk)))
    expect(await watchStore.windows(captures[0].id)).toHaveLength(1)
  }, 30000)
  it('full-file reservations serialize against owner quotas and cannot be duplicated by URL renewal', async () => {
    const { g, c, meta } = await fixtures(), other = await watchStore.create(g, randomUUID(), meta)
    const audio = Buffer.from('audio')
    await watchStore.receive(g, c, { sequence: 0, offsetMs: 0, durationMs: 1000, checksum: sha256(audio), audio })
    const full = { sha256: sha256(audio), bytes: LIMITS.captureBytes, durationMs: 1000 }
    const outcomes = await Promise.allSettled([watchStore.initializeUpload(g, c, full), watchStore.initializeUpload(g, other, full)])
    expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(o => o.status === 'rejected')).toHaveLength(1)
    const winner = outcomes[0].status === 'fulfilled' ? c : other
    await watchStore.initializeUpload(g, winner, full)
    expect((await pool.query('SELECT count(*)::int AS n FROM watch_capture_uploads WHERE capture_id=ANY($1)', [[c.id, other.id]])).rows[0].n).toBe(1)
  }, 30000)
})
