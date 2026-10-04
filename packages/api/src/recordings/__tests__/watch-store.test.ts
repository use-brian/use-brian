import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'

const db = new PGlite()
vi.mock('../../db/client.js', () => ({
  query: async (sql: string, params?: unknown[]) => db.query(sql, params),
  getPool: () => ({ connect: async () => ({ query: (sql: string, params?: unknown[]) => db.query(sql, params), release() {} }) }),
}))
import { watchStore, sha256 } from '../watch-store.js'
const ownerId = randomUUID(), workspaceId = randomUUID(), assistantId = randomUUID(), standardId = randomUUID(), deviceId = randomUUID()
async function grant() {
  const tokens = await watchStore.provision({ ownerId, workspaceId, assistantId, deviceId: randomUUID(), provisioningKey: 'test-server-key', label: 'Watch' })
  return { tokens, g: await watchStore.authenticate(tokens.accessToken) }
}
const meta = { capturedAt: '2026-01-01T00:00:00Z', title: 'Meeting', source: 'apple-watch' }
const audio = Buffer.from('audio')
const input = (sequence: number) => ({ sequence, offsetMs: sequence * 1000, durationMs: 1000, checksum: sha256(audio), audio })

beforeAll(async () => {
  await db.exec(`CREATE TABLE users(id uuid PRIMARY KEY); CREATE TABLE workspaces(id uuid PRIMARY KEY); CREATE TABLE assistants(id uuid PRIMARY KEY,kind text NOT NULL DEFAULT 'primary'); CREATE TABLE episodes(id uuid PRIMARY KEY,workspace_id uuid,assistant_id uuid,created_by_user_id uuid,source_kind text,occurred_at timestamptz);`)
  await db.exec('CREATE TABLE workspace_files(id uuid PRIMARY KEY,workspace_id uuid,assistant_id uuid,created_by_user_id uuid,created_by_assistant_id uuid,path text); CREATE TABLE saved_views(id uuid PRIMARY KEY,workspace_id uuid,created_by uuid,linked_recording_id uuid);')
  await db.query('INSERT INTO users VALUES($1)', [ownerId])
  await db.query('INSERT INTO workspaces VALUES($1)', [workspaceId])
  await db.query('INSERT INTO assistants VALUES($1)', [assistantId])
  await db.query("INSERT INTO assistants VALUES($1,'standard')", [standardId])
  for (const name of ['653_watch_recording.sql', '657_watch_assistant_destinations.sql']) {
    await db.exec(readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8'))
  }
}, 60000)
afterAll(async () => { await db.close() })

describe('watch persisted security and receipts (real SQL)', () => {
  it('provisioning replay returns the same grant and secrets, never resets a rotated grant', async () => {
    const input = { ownerId, workspaceId, assistantId, deviceId, label: 'Watch', provisioningKey: 'test-server-key' }
    const first = await watchStore.provision(input)
    const second = await watchStore.provision(input)
    expect(second.grantId).toBe(first.grantId)
    expect(second.accessToken).toBe(first.accessToken)
    expect(second.renewalToken).toBe(first.renewalToken)
    expect((await db.query('SELECT id FROM recording_device_grants WHERE device_id=$1', [deviceId])).rows).toHaveLength(1)
    await expect(watchStore.provision({ ...input, label: 'Changed' })).rejects.toMatchObject({ message: 'provisioning_conflict' })
    // Another assistant in the same workspace is a separate destination grant, not a conflict.
    const other = await watchStore.provision({ ...input, assistantId: standardId })
    expect(other.grantId).not.toBe(first.grantId)
    expect((await watchStore.provision({ ...input, assistantId: standardId })).grantId).toBe(other.grantId)
    await watchStore.revoke(ownerId, other.grantId)
    await watchStore.renew(first.renewalToken, async () => {})
    await expect(watchStore.provision(input)).rejects.toMatchObject({ message: 'grant_already_rotated_use_relay' })
    await watchStore.revoke(ownerId, first.grantId)
  })
  it('human relay recovers the same grant after credential/grant expiry but never after revocation', async () => {
    const { tokens, g } = await grant()
    await db.query("UPDATE recording_device_grants SET expires_at=now()-interval '1 day',access_expires_at=now()-interval '1 day' WHERE id=$1", [g.id])
    await expect(watchStore.authenticate(tokens.accessToken)).rejects.toMatchObject({ status: 401 })
    const relay = await watchStore.relay(ownerId, g.id)
    expect(relay).toMatchObject({ id: g.id, authMode: 'relay', workspace_id: workspaceId })
    const clientId = randomUUID(), c = await watchStore.create(relay, clientId, meta)
    expect((await watchStore.get(g, clientId)).id).toBe(c.id)
    await expect(watchStore.relay(randomUUID(), g.id)).rejects.toMatchObject({ status: 404 })
    await watchStore.revoke(ownerId, g.id)
    await expect(watchStore.relay(ownerId, g.id)).rejects.toMatchObject({ status: 404 })
    await db.query("UPDATE watch_captures SET expires_at=now()-interval '1 day' WHERE id=$1", [c.id])
  })
  it('stamps original capturedAt during canonical episode INSERT before provenance is read', async () => {
    const { g } = await grant(), c = await watchStore.create(g, randomUUID(), meta)
    await watchStore.receive(g, c, input(0))
    await watchStore.seal(g, c.client_id, { expectedWindows: 1, allowIncomplete: false, source: 'windows' })
    await db.exec('BEGIN')
    await db.query("SELECT set_config('app.current_user_id',$1,true),set_config('app.media_intake_parent','{}',true)", [ownerId])
    const inserted = await db.query<{occurred_at: Date}>(`INSERT INTO episodes(id,workspace_id,assistant_id,created_by_user_id,source_kind,occurred_at) VALUES($1,$2,$3,$4,'recording',now()) RETURNING occurred_at`, [c.recording_id, workspaceId, null, ownerId])
    expect(new Date(inserted.rows[0].occurred_at).toISOString()).toBe('2026-01-01T00:00:00.000Z')
    await db.exec('COMMIT')
    // Other recordings retain their caller-provided timestamp; no global web behavior change.
    const unrelated = await db.query<{occurred_at: Date}>(`INSERT INTO episodes(id,workspace_id,assistant_id,created_by_user_id,source_kind,occurred_at) VALUES($1,$2,$3,$4,'recording','2025-03-02T01:00:00Z') RETURNING occurred_at`, [randomUUID(), workspaceId, assistantId, ownerId])
    expect(new Date(unrelated.rows[0].occurred_at).toISOString()).toBe('2025-03-02T01:00:00.000Z')
    // A reserved watch ID cannot be published by another actor or before sealing.
    await db.query('DELETE FROM episodes WHERE id=$1', [c.recording_id])
    await db.exec('BEGIN')
    await db.query("SELECT set_config('app.current_user_id',$1,true),set_config('app.media_intake_parent','{}',true)", [randomUUID()])
    await expect(db.query(`INSERT INTO episodes(id,workspace_id,assistant_id,created_by_user_id,source_kind,occurred_at) VALUES($1,$2,$3,$4,'recording',now())`, [c.recording_id, workspaceId, null, ownerId])).rejects.toThrow('watch_recording_provenance_mismatch')
    await db.exec('ROLLBACK')
    await db.query("UPDATE watch_captures SET expires_at=now()-interval '1 day' WHERE id=$1", [c.id])
  })
  it('stores only hashed credentials, rejects unknown tokens, rotates and commits replay revocation', async () => {
    const { tokens, g } = await grant()
    expect((await db.query<{access_hash:string}>('SELECT access_hash FROM recording_device_grants WHERE id=$1', [g.id])).rows[0].access_hash).toBe(sha256(tokens.accessToken))
    await expect(watchStore.authenticate(`wra_${sha256('unknown-token').slice(0, 43)}`)).rejects.toMatchObject({ status: 401 })
    const rotated = await watchStore.renew(tokens.renewalToken, async () => {})
    await expect(watchStore.authenticate(tokens.accessToken)).rejects.toMatchObject({ status: 401 })
    expect((await watchStore.authenticate(rotated.accessToken)).id).toBe(g.id)
    await expect(watchStore.renew(tokens.renewalToken, async () => {})).rejects.toMatchObject({ status: 401 })
    await expect(watchStore.authenticate(rotated.accessToken)).rejects.toMatchObject({ status: 401 })
  })
  it('revocation is owner-scoped and membership loss blocks renewal', async () => {
    const { tokens, g } = await grant()
    await watchStore.revoke(randomUUID(), g.id)
    await expect(watchStore.authenticate(tokens.accessToken)).resolves.toMatchObject({ id: g.id })
    await expect(watchStore.renew(tokens.renewalToken, async () => { throw new Error('membership removed') })).rejects.toThrow('membership removed')
    await watchStore.revoke(ownerId, g.id)
    await expect(watchStore.authenticate(tokens.accessToken)).rejects.toMatchObject({ status: 401 })
  })
  it('client id is durable and grant-scoped; conflicting metadata cannot redirect it', async () => {
    const { g } = await grant(), id = randomUUID()
    const c = await watchStore.create(g, id, meta)
    expect((await watchStore.create(g, id, meta)).id).toBe(c.id)
    await expect(watchStore.create(g, id, { ...meta, title: 'Different' })).rejects.toMatchObject({ status: 409 })
    const otherGrant = { ...g, id: randomUUID() }
    await expect(watchStore.get(otherGrant, id)).rejects.toMatchObject({ status: 404 })
    await expect(watchStore.receive(otherGrant, c, input(0))).rejects.toMatchObject({ status: 404 })
    await db.query("UPDATE watch_captures SET expires_at=now()-interval '1 day' WHERE id=$1", [c.id])
    await expect(watchStore.create(g, id, meta)).rejects.toMatchObject({ status: 410 })
  })
  it('durably accepts out-of-order delivery, deduplicates, reports gaps, seals once', async () => {
    const { g } = await grant(), id = randomUUID(), c = await watchStore.create(g, id, meta)
    await watchStore.receive(g, c, input(2))
    await watchStore.receive(g, c, input(0))
    await watchStore.receive(g, c, input(0))
    expect((await watchStore.windows(c.id)).map(w => w.sequence)).toEqual([0, 2])
    expect((await watchStore.windows(c.id))[0].audio).toEqual(new Uint8Array(audio))
    await expect(watchStore.receive(g, c, { ...input(0), checksum: sha256('different') })).rejects.toMatchObject({ message: 'window_conflict' })
    await expect(watchStore.receive(g, c, { ...input(1), offsetMs: 500 })).rejects.toMatchObject({ message: 'window_timing_conflict' })
    const f = { expectedWindows: 3, allowIncomplete: false, source: 'windows' as const }
    await expect(watchStore.seal(g, id, f)).rejects.toMatchObject({ message: 'missing_windows', detail: { missingSequences: [1] } })
    expect((await watchStore.get(g, id)).state).toBe('open')
    await watchStore.receive(g, c, input(1))
    expect((await watchStore.seal(g, id, f)).state).toBe('sealed')
    expect((await watchStore.seal(g, id, f)).id).toBe(c.id)
    await expect(watchStore.seal(g, id, { ...f, expectedWindows: 4 })).rejects.toMatchObject({ message: 'finalization_conflict' })
    await expect(watchStore.receive(g, c, input(3))).rejects.toMatchObject({ message: 'capture_sealed' })
    await watchStore.receive(g, c, input(1)) // late exact replay is safe
    await db.query("UPDATE watch_captures SET expires_at=now()-interval '1 day' WHERE id=$1", [c.id])
    await watchStore.cleanup()
    expect(await watchStore.windows(c.id)).toEqual([])
    await expect(watchStore.get(g, id)).rejects.toMatchObject({ status: 410 })
  })
  it('requires explicit incomplete policy and rejects unexpected extra indices', async () => {
    const { g } = await grant(), id = randomUUID(), c = await watchStore.create(g, id, meta)
    await watchStore.receive(g, c, input(2))
    await expect(watchStore.seal(g, id, { expectedWindows: 2, allowIncomplete: true, source: 'windows' })).rejects.toMatchObject({ message: 'unexpected_windows' })
    expect((await watchStore.seal(g, id, { expectedWindows: 3, allowIncomplete: true, source: 'windows' })).state).toBe('sealed')
  })
  it('reserves a bounded immutable full upload, renews by descriptor replay and seals the same capture', async () => {
    const { g } = await grant(), c = await watchStore.create(g, randomUUID(), meta)
    const descriptor = { sha256: sha256(audio), bytes: audio.length, durationMs: 1000 }
    const first = await watchStore.initializeUpload(g, c, descriptor)
    expect((await watchStore.initializeUpload(g, c, descriptor)).capture_id).toBe(first.capture_id)
    await expect(watchStore.initializeUpload(g, c, { ...descriptor, bytes: descriptor.bytes + 1 })).rejects.toMatchObject({ message: 'full_upload_conflict' })
    const f = { expectedWindows: 0, allowIncomplete: false, source: 'full' as const }
    await expect(watchStore.seal(g, c.client_id, f)).rejects.toMatchObject({ message: 'full_upload_missing' })
    const client = { query: (sql: string, params: unknown[]) => db.query(sql, params) } as never
    await watchStore.receiveFull(g, c.id, audio, client)
    await watchStore.receiveFull(g, c.id, audio, client)
    expect((await watchStore.upload(c.id))?.received).toBe(true)
    expect((await watchStore.seal(g, c.client_id, f)).recording_id).toBe(c.recording_id)
    await expect(watchStore.seal(g, c.client_id, { ...f, source: 'windows' })).rejects.toMatchObject({ message: 'finalization_conflict' })
    await db.query("UPDATE watch_captures SET expires_at=now()-interval '1 day' WHERE id=$1", [c.id])
    await expect(watchStore.receiveFull(g, c.id, audio, client)).rejects.toMatchObject({ status: 410 })
    await watchStore.cleanup()
    expect(await watchStore.upload(c.id)).toBeNull()
  })
  it('freezes a non-primary destination partition per capture and enforces it at the SQL boundary', async () => {
    const primary = await grant()
    expect((await watchStore.create(primary.g, randomUUID(), meta)).scope_assistant_id).toBeNull()
    const tokens = await watchStore.provision({ ownerId, workspaceId, assistantId: standardId, deviceId: randomUUID(), provisioningKey: 'test-server-key', label: 'Watch' })
    const g = await watchStore.authenticate(tokens.accessToken), c = await watchStore.create(g, randomUUID(), meta)
    expect(c.scope_assistant_id).toBe(standardId)
    await watchStore.receive(g, c, input(0))
    await watchStore.seal(g, c.client_id, { expectedWindows: 1, allowIncomplete: false, source: 'windows' })
    const file = (assistant: string | null, author: string | null) => db.query('INSERT INTO workspace_files(id,workspace_id,assistant_id,created_by_user_id,created_by_assistant_id,path) VALUES($1,$2,$3,$4,$5,$6)',
      [randomUUID(), workspaceId, assistant, ownerId, author, `/recordings/watch/${c.id}.m4a`])
    // Device audio lands only in the frozen partition and stays human-authored.
    await expect(file(null, null)).rejects.toThrow('watch_capture_publication_closed')
    await expect(file(standardId, standardId)).rejects.toThrow('watch_capture_publication_closed')
    await file(standardId, null)
    const episode = async (assistant: string | null) => {
      await db.exec('BEGIN')
      await db.query("SELECT set_config('app.current_user_id',$1,true),set_config('app.media_intake_parent','{}',true)", [ownerId])
      try { return await db.query<{occurred_at: Date}>(`INSERT INTO episodes(id,workspace_id,assistant_id,created_by_user_id,source_kind,occurred_at) VALUES($1,$2,$3,$4,'recording',now()) RETURNING occurred_at`, [c.recording_id, workspaceId, assistant, ownerId]) }
      finally { await db.exec('ROLLBACK') }
    }
    await expect(episode(null)).rejects.toThrow('watch_recording_provenance_mismatch')
    expect(new Date((await episode(standardId)).rows[0].occurred_at).toISOString()).toBe('2026-01-01T00:00:00.000Z')
    await db.query("UPDATE watch_captures SET expires_at=now()-interval '1 day' WHERE grant_id IN ($1,$2)", [g.id, primary.g.id])
  })
  it('rejects SQL publication after expiry and cannot create a previously prepared page', async () => {
    const { g } = await grant(), c = await watchStore.create(g, randomUUID(), meta)
    await db.query("UPDATE watch_captures SET page_prepare_started=true,page_prepared=true,state='sealed',expires_at=now()-interval '1 day' WHERE id=$1", [c.id])
    await expect(db.query('INSERT INTO saved_views(id,workspace_id,created_by) VALUES($1,$2,$3)', [c.page_id, workspaceId, ownerId])).rejects.toThrow('watch_page_already_prepared')
    await expect(db.query('INSERT INTO workspace_files(id,workspace_id,created_by_user_id,path) VALUES($1,$2,$3,$4)', [randomUUID(), workspaceId, ownerId, `/recordings/watch/${c.id}.m4a`])).rejects.toThrow('watch_capture_publication_closed')
    await watchStore.cleanup()
    expect((await db.query<{state:string}>('SELECT state FROM watch_captures WHERE id=$1', [c.id])).rows[0].state).toBe('expired')
    const changed = await db.query("UPDATE watch_captures SET state='finalized' WHERE id=$1 AND state='sealed' AND expires_at>clock_timestamp() RETURNING id", [c.id])
    expect(changed.rows).toEqual([])
  })
  it('enforces the owner active-session quota across device grants', async () => {
    const { g } = await grant()
    const c = await watchStore.create(g, randomUUID(), meta)
    await watchStore.receive(g, c, { ...input(0), offsetMs: 1000 })
    await expect(watchStore.seal(g, c.client_id, { expectedWindows: 1, allowIncomplete: false, source: 'windows' })).rejects.toMatchObject({ message: 'missing_audio_time' })
    // Quota uses persisted byte counts, independent of arrival order.
    await db.query('UPDATE watch_capture_windows SET bytes=2097152 WHERE capture_id=$1', [c.id])
    for (let i = 1; i < 32; i++) {
      await db.query('INSERT INTO watch_capture_windows(capture_id,sequence,chunk_id,offset_ms,duration_ms,checksum,audio,bytes) VALUES($1,$2,$3,$4,1000,$5,$6,2097152)', [c.id, i, randomUUID(), (i + 1) * 1000, sha256(audio), audio])
    }
    await expect(watchStore.receive(g, c, { ...input(32), offsetMs: 33000 })).rejects.toMatchObject({ message: 'audio_quota' })
    await watchStore.create(g, randomUUID(), meta)
    await expect(watchStore.create(g, randomUUID(), meta)).rejects.toMatchObject({ message: 'active_capture_limit' })
  })
})
