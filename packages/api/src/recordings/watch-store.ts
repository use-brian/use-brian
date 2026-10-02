import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { getPool, query } from '../db/client.js'

export const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
export class WatchError extends Error {
  constructor(public status: number, message: string, public detail?: unknown) { super(message) }
}
export type Grant = {
  id: string; owner_id: string; device_id: string; workspace_id: string; assistant_id: string
  authMode?: 'relay'
  label: string; revoked_at: Date | null; expires_at: Date; access_expires_at: Date
}
export type Capture = {
  id: string; grant_id: string; client_id: string; metadata: { capturedAt: string; title: string; source: string }
  page_id: string; recording_id: string; state: 'open' | 'sealed' | 'finalized' | 'expired'
  page_prepared: boolean; page_prepare_started: boolean
  finalization: { expectedWindows: number; allowIncomplete: boolean; source: 'windows' | 'full' } | null
  expires_at: Date
}
export type FullUpload = { capture_id: string; checksum: string; bytes: number; duration_ms: number; audio: Buffer | null; received?: boolean }
export type Window = {
  capture_id: string; sequence: number; chunk_id: string; offset_ms: number; duration_ms: number
  checksum: string; audio: Buffer; bytes: number; transcript: Array<{ speaker: string | null; text: string }> | null; attempts: number
}
export function missingTimeRanges(windows: Pick<Window, 'offset_ms' | 'duration_ms'>[]) {
  let end = 0
  const ranges: Array<{ fromMs: number; toMs: number }> = []
  for (const w of windows) {
    if (w.offset_ms > end) ranges.push({ fromMs: end, toMs: w.offset_ms })
    end = w.offset_ms + w.duration_ms
  }
  return ranges
}
export const LIMITS = { windowBytes: 2 * 1024 * 1024, captureBytes: 64 * 1024 * 1024, ownerBytes: 128 * 1024 * 1024, windows: 1080, durationMs: 10800000, active: 3 }
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>
  return Object.keys(x).length === Object.keys(y).length && Object.keys(x).every(k => same(x[k], y[k]))
}
function credentials() {
  return { accessToken: `wra_${randomBytes(32).toString('base64url')}`, renewalToken: `wrr_${randomBytes(32).toString('base64url')}`, expiresIn: 900, audience: 'watch-recording-v1' }
}
export async function transaction<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await getPool().connect()
  try { await db.query('BEGIN'); const result = await work(db); await db.query('COMMIT'); return result }
  catch (e) { await db.query('ROLLBACK'); throw e } finally { db.release() }
}

export const watchStore = {
  async provision(input: { ownerId: string; deviceId: string; workspaceId: string; assistantId: string; label: string; provisioningKey: string }) {
    return transaction(async db => {
      await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [input.ownerId])
      const existing = (await db.query<Grant & { access_hash: string }>(`SELECT * FROM recording_device_grants
        WHERE owner_id=$1 AND device_id=$2 AND workspace_id=$3 AND revoked_at IS NULL FOR UPDATE`,
      [input.ownerId, input.deviceId, input.workspaceId])).rows[0]
      const id = existing?.id ?? randomUUID()
      // Reproducible only with the server secret; no stored plaintext/encrypted token cache.
      const derive = (kind: string) => createHmac('sha256', input.provisioningKey).update(JSON.stringify(['watch-provision-v1', id, kind])).digest('base64url')
      const tokens = { accessToken: `wra_${derive('access')}`, renewalToken: `wrr_${derive('renewal')}`, expiresIn: 900, audience: 'watch-recording-v1' }
      if (existing) {
        if (existing.assistant_id !== input.assistantId || existing.label !== input.label) throw new WatchError(409, 'provisioning_conflict')
        if (new Date(existing.expires_at).getTime() <= Date.now()) throw new WatchError(409, 'grant_expired_use_relay')
        if (existing.access_hash !== sha256(tokens.accessToken)) throw new WatchError(409, 'grant_already_rotated_use_relay')
        return { grantId: id, ...tokens, expiresIn: Math.max(0, Math.floor((new Date(existing.access_expires_at).getTime() - Date.now()) / 1000)) }
      }
      const count = await db.query('SELECT count(*)::int AS n FROM recording_device_grants WHERE owner_id=$1 AND revoked_at IS NULL AND expires_at>now()', [input.ownerId])
      if (count.rows[0].n >= 10) throw new WatchError(429, 'device_limit')
      await db.query(`INSERT INTO recording_device_grants(id,owner_id,device_id,workspace_id,assistant_id,label,access_hash,access_expires_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '15 minutes',now()+interval '90 days')`,
      [id, input.ownerId, input.deviceId, input.workspaceId, input.assistantId, input.label, sha256(tokens.accessToken)])
      await db.query('INSERT INTO recording_device_renewals(hash,grant_id) VALUES($1,$2)', [sha256(tokens.renewalToken), id])
      return { grantId: id, ...tokens }
    })
  },
  async relay(ownerId: string, grantId: string): Promise<Grant> {
    const { rows } = await query<Grant>(`SELECT * FROM recording_device_grants WHERE id=$1 AND owner_id=$2 AND revoked_at IS NULL`, [grantId, ownerId])
    if (!rows[0]) throw new WatchError(404, 'relay_grant_not_found')
    // Expired device credentials/grant do not prevent a currently authenticated owner recovering audio.
    return { ...rows[0], authMode: 'relay' }
  },
  async authenticate(token: string): Promise<Grant> {
    if (!/^wra_[A-Za-z0-9_-]{43}$/.test(token)) throw new WatchError(401, 'invalid_device_access')
    const { rows } = await query<Grant>(`SELECT * FROM recording_device_grants WHERE access_hash=$1 AND revoked_at IS NULL AND expires_at>now() AND access_expires_at>now()`, [sha256(token)])
    if (!rows[0]) throw new WatchError(401, 'invalid_device_access')
    return rows[0]
  },
  async renew(token: string, authorize: (grant: Grant) => Promise<void>) {
    if (!/^wrr_[A-Za-z0-9_-]{43}$/.test(token)) throw new WatchError(401, 'invalid_device_renewal')
    const found = await query<Grant>(`SELECT g.* FROM recording_device_grants g JOIN recording_device_renewals r ON r.grant_id=g.id WHERE r.hash=$1`, [sha256(token)])
    if (!found.rows[0]) throw new WatchError(401, 'invalid_device_renewal')
    await authorize(found.rows[0])
    const tokens = credentials()
    const ok = await transaction(async db => {
      const { rows } = await db.query(`SELECT g.*,r.used_at FROM recording_device_grants g JOIN recording_device_renewals r ON r.grant_id=g.id WHERE r.hash=$1 FOR UPDATE OF g,r`, [sha256(token)])
      const grant = rows[0]
      if (!grant || grant.revoked_at || new Date(grant.expires_at).getTime() <= Date.now()) return false
      if (grant.used_at) {
        await db.query('UPDATE recording_device_grants SET revoked_at=now() WHERE id=$1', [grant.id])
        return false // Commit reuse revocation rather than throwing and rolling it back.
      }
      await db.query('UPDATE recording_device_renewals SET used_at=now() WHERE hash=$1', [sha256(token)])
      await db.query('INSERT INTO recording_device_renewals(hash,grant_id) VALUES($1,$2)', [sha256(tokens.renewalToken), grant.id])
      await db.query("UPDATE recording_device_grants SET access_hash=$2,access_expires_at=now()+interval '15 minutes' WHERE id=$1", [grant.id, sha256(tokens.accessToken)])
      return true
    })
    if (!ok) throw new WatchError(401, 'invalid_device_renewal')
    return { grantId: found.rows[0].id, ...tokens }
  },
  async list(ownerId: string) {
    return (await query('SELECT id AS "grantId",device_id AS "deviceId",workspace_id AS "workspaceId",assistant_id AS "assistantId",label,revoked_at AS "revokedAt",expires_at AS "expiresAt" FROM recording_device_grants WHERE owner_id=$1 ORDER BY created_at DESC', [ownerId])).rows
  },
  async revoke(ownerId: string, id: string) {
    await query('UPDATE recording_device_grants SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1 AND owner_id=$2', [id, ownerId])
  },
  /** Bound work per invocation; boot runs this every 15 minutes and creation also sweeps lazily. */
  async cleanup() {
    const expired = await query<{id: string}>("SELECT id FROM watch_captures WHERE expires_at<=clock_timestamp() AND state<>'expired' ORDER BY expires_at LIMIT 20")
    let removed = 0
    for (const { id } of expired.rows) {
      const cleaned = await transaction(async db => {
        // Same key as provider/finalize/upload work. Never delete a capture's bytes under that work.
        const lock = await db.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,650)) AS locked', [id])
        if (!lock.rows[0].locked) return
        const current = await db.query("SELECT id FROM watch_captures WHERE id=$1 AND expires_at<=clock_timestamp() AND state<>'expired' FOR UPDATE", [id])
        if (!current.rows.length) return
        await db.query('DELETE FROM watch_capture_windows WHERE capture_id=$1', [id])
        await db.query('DELETE FROM watch_capture_uploads WHERE capture_id=$1', [id])
        await db.query("UPDATE watch_captures SET state='expired' WHERE id=$1 AND expires_at<=clock_timestamp()", [id])
        return true
      })
      if (cleaned && ++removed === 5) break
    }
    await query(`DELETE FROM recording_device_renewals WHERE hash IN (
      SELECT r.hash FROM recording_device_renewals r JOIN recording_device_grants g ON g.id=r.grant_id
      WHERE g.expires_at<=now() LIMIT 1000)`)
  },
  async create(grant: Grant, clientId: string, metadata: Capture['metadata']): Promise<Capture> {
    await watchStore.cleanup()
    return transaction(async db => {
      await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [grant.owner_id])
      const existing = await db.query<Capture>('SELECT * FROM watch_captures WHERE grant_id=$1 AND client_id=$2', [grant.id, clientId])
      if (existing.rows[0]) {
        if (new Date(existing.rows[0].expires_at).getTime() <= Date.now()) throw new WatchError(410, 'capture_expired')
        if (!same(existing.rows[0].metadata, metadata)) throw new WatchError(409, 'capture_metadata_conflict')
        return existing.rows[0]
      }
      const count = await db.query(`SELECT count(*)::int AS n FROM watch_captures c JOIN recording_device_grants g ON g.id=c.grant_id WHERE g.owner_id=$1 AND c.state IN ('open','sealed') AND c.expires_at>now()`, [grant.owner_id])
      if (count.rows[0].n >= LIMITS.active) throw new WatchError(429, 'active_capture_limit')
      return (await db.query<Capture>('INSERT INTO watch_captures(id,grant_id,client_id,metadata,page_id,recording_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [randomUUID(), grant.id, clientId, metadata, randomUUID(), randomUUID()])).rows[0]
    })
  },
  async get(grant: Grant, clientId: string): Promise<Capture> {
    const { rows } = await query<Capture>('SELECT * FROM watch_captures WHERE grant_id=$1 AND client_id=$2', [grant.id, clientId])
    if (!rows[0]) throw new WatchError(404, 'capture_not_found')
    if (rows[0].state === 'expired' || new Date(rows[0].expires_at).getTime() <= Date.now()) throw new WatchError(410, 'capture_expired')
    return rows[0]
  },
  async assertLive(id: string, db?: PoolClient) {
    const sql = "SELECT id FROM watch_captures WHERE id=$1 AND state<>'expired' AND expires_at>clock_timestamp()"
    const result = db ? await db.query(sql, [id]) : await query(sql, [id])
    if (!result.rows.length) throw new WatchError(410, 'capture_expired')
  },
  async upload(id: string, includeAudio = false): Promise<FullUpload | null> {
    const columns = includeAudio ? '*' : 'capture_id,checksum,bytes,duration_ms,(audio IS NOT NULL) AS received'
    return (await query<FullUpload>(`SELECT ${columns} FROM watch_capture_uploads WHERE capture_id=$1`, [id])).rows[0] ?? null
  },
  async initializeUpload(grant: Grant, capture: Capture, input: { sha256: string; bytes: number; durationMs: number }): Promise<FullUpload> {
    return transaction(async db => {
      await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [grant.owner_id])
      const c = (await db.query<Capture>('SELECT * FROM watch_captures WHERE id=$1 AND grant_id=$2 FOR UPDATE', [capture.id, grant.id])).rows[0]
      if (!c) throw new WatchError(404, 'capture_not_found')
      await watchStore.assertLive(c.id, db)
      const existing = (await db.query<FullUpload>('SELECT capture_id,checksum,bytes,duration_ms,(audio IS NOT NULL) AS received FROM watch_capture_uploads WHERE capture_id=$1', [c.id])).rows[0]
      if (existing) {
        if (existing.checksum !== input.sha256 || existing.bytes !== input.bytes || existing.duration_ms !== input.durationMs) throw new WatchError(409, 'full_upload_conflict')
        return existing
      }
      if (c.state !== 'open') throw new WatchError(409, 'capture_sealed')
      const totals = (await db.query(`SELECT
        (SELECT coalesce(sum(w.bytes),0) FROM watch_capture_windows w JOIN watch_captures c ON c.id=w.capture_id JOIN recording_device_grants g ON g.id=c.grant_id WHERE g.owner_id=$1) +
        (SELECT coalesce(sum(u.bytes),0) FROM watch_capture_uploads u JOIN watch_captures c ON c.id=u.capture_id JOIN recording_device_grants g ON g.id=c.grant_id WHERE g.owner_id=$1) AS total`, [grant.owner_id])).rows[0]
      if (Number(totals.total) + input.bytes > LIMITS.ownerBytes) throw new WatchError(413, 'audio_quota')
      const stored = (await db.query<FullUpload>(`INSERT INTO watch_capture_uploads(capture_id,checksum,bytes,duration_ms)
        SELECT id,$2,$3,$4 FROM watch_captures WHERE id=$1 AND state='open' AND expires_at>clock_timestamp() RETURNING *`, [c.id, input.sha256, input.bytes, input.durationMs])).rows[0]
      if (!stored) throw new WatchError(410, 'capture_expired')
      return stored
    })
  },
  async receiveFull(grant: Grant, captureId: string, audio: Buffer, db: PoolClient) {
    // The upload path holds the capture advisory lock, including while reading/probing the body.
    const result = await db.query(`UPDATE watch_capture_uploads u SET audio=coalesce(u.audio,$3)
      FROM watch_captures c WHERE c.id=u.capture_id AND c.id=$1 AND c.grant_id=$2
        AND c.state<>'expired' AND (c.state='open' OR u.audio IS NOT NULL) AND c.expires_at>clock_timestamp() AND u.bytes=$4 AND u.checksum=$5
      RETURNING u.capture_id`, [captureId, grant.id, audio, audio.length, sha256(audio)])
    if (!result.rows.length) throw new WatchError(410, 'capture_expired_or_upload_changed')
  },
  async hasWindow(id: string, sequence: number) {
    return (await query('SELECT 1 FROM watch_capture_windows WHERE capture_id=$1 AND sequence=$2', [id, sequence])).rows.length > 0
  },
  async windows(id: string, audio = true): Promise<Window[]> {
    const columns = audio ? '*' : 'capture_id,sequence,chunk_id,offset_ms,duration_ms,checksum,bytes,transcript,attempts'
    return (await query<Window>(`SELECT ${columns} FROM watch_capture_windows WHERE capture_id=$1 ORDER BY sequence`, [id])).rows
  },
  async seal(grant: Grant, clientId: string, input: NonNullable<Capture['finalization']>): Promise<Capture> {
    return transaction(async db => {
      const c = (await db.query<Capture>('SELECT * FROM watch_captures WHERE grant_id=$1 AND client_id=$2 FOR UPDATE', [grant.id, clientId])).rows[0]
      if (!c) throw new WatchError(404, 'capture_not_found')
      await watchStore.assertLive(c.id, db)
      if (c.finalization) {
        if (!same(c.finalization, input)) throw new WatchError(409, 'finalization_conflict')
        return c
      }
      const rows = (await db.query<Pick<Window, 'sequence' | 'offset_ms' | 'duration_ms'>>('SELECT sequence,offset_ms,duration_ms FROM watch_capture_windows WHERE capture_id=$1 ORDER BY sequence', [c.id])).rows
      if (input.source === 'full') {
        const upload = (await db.query<FullUpload>('SELECT bytes,duration_ms,(audio IS NOT NULL) AS received FROM watch_capture_uploads WHERE capture_id=$1', [c.id])).rows[0]
        if (!upload?.received) throw new WatchError(409, 'full_upload_missing')
        if (rows.some(w => w.offset_ms + w.duration_ms > upload.duration_ms + 1000)) throw new WatchError(409, 'full_upload_coverage_conflict')
      } else {
        if (!rows.length) throw new WatchError(409, 'no_windows')
        if (rows.some(w => w.sequence >= input.expectedWindows)) throw new WatchError(409, 'unexpected_windows')
        const received = new Set(rows.map(w => w.sequence))
        const missing = Array.from({length: input.expectedWindows}, (_, i) => i).filter(i => !received.has(i))
        if (missing.length && !input.allowIncomplete) throw new WatchError(409, 'missing_windows', { missingSequences: missing })
        const gaps = missingTimeRanges(rows)
        if (gaps.length && !input.allowIncomplete) throw new WatchError(409, 'missing_audio_time', { missingTimeRanges: gaps })
      }
      const sealed = (await db.query<Capture>("UPDATE watch_captures SET state='sealed',finalization=$2 WHERE id=$1 AND state='open' AND expires_at>clock_timestamp() RETURNING *", [c.id, input])).rows[0]
      if (!sealed) throw new WatchError(410, 'capture_expired')
      return sealed
    })
  },
  async receive(grant: Grant, capture: Capture, input: { sequence: number; offsetMs: number; durationMs: number; checksum: string; audio: Buffer }) {
    await transaction(async db => {
      await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [grant.owner_id])
      const c = (await db.query<Capture>('SELECT * FROM watch_captures WHERE id=$1 AND grant_id=$2 FOR UPDATE', [capture.id, grant.id])).rows[0]
      if (!c) throw new WatchError(404, 'capture_not_found')
      await watchStore.assertLive(c.id, db)
      const previous = (await db.query<Window>('SELECT * FROM watch_capture_windows WHERE capture_id=$1 AND sequence=$2', [capture.id, input.sequence])).rows[0]
      if (previous) {
        if (previous.checksum !== input.checksum || previous.offset_ms !== input.offsetMs || previous.duration_ms !== input.durationMs || previous.bytes !== input.audio.length) throw new WatchError(409, 'window_conflict')
        return
      }
      if (c.state !== 'open') throw new WatchError(409, 'capture_sealed')
      if (new Date(c.expires_at).getTime() <= Date.now()) throw new WatchError(410, 'capture_expired')
      // All earlier/later windows, not only immediate neighbors (delivery can be sparse).
      const overlap = await db.query('SELECT 1 FROM watch_capture_windows WHERE capture_id=$1 AND ((sequence<$2 AND offset_ms+duration_ms>$3) OR (sequence>$2 AND offset_ms<$4)) LIMIT 1', [c.id, input.sequence, input.offsetMs, input.offsetMs + input.durationMs])
      if (overlap.rows.length) throw new WatchError(409, 'window_timing_conflict')
      const totals = (await db.query(`SELECT coalesce(sum(w.bytes),0)::bigint AS total,coalesce(sum(w.bytes) FILTER(WHERE c.id=$2),0)::bigint AS capture FROM watch_capture_windows w JOIN watch_captures c ON c.id=w.capture_id JOIN recording_device_grants g ON g.id=c.grant_id WHERE g.owner_id=$1 AND w.audio IS NOT NULL`, [grant.owner_id, c.id])).rows[0]
      const reserved = (await db.query('SELECT coalesce(sum(u.bytes),0) AS total FROM watch_capture_uploads u JOIN watch_captures c ON c.id=u.capture_id JOIN recording_device_grants g ON g.id=c.grant_id WHERE g.owner_id=$1', [grant.owner_id])).rows[0]
      if (Number(totals.total) + Number(reserved.total) + input.audio.length > LIMITS.ownerBytes || Number(totals.capture) + input.audio.length > LIMITS.captureBytes) throw new WatchError(413, 'audio_quota')
      const stored = await db.query(`INSERT INTO watch_capture_windows(capture_id,sequence,chunk_id,offset_ms,duration_ms,checksum,audio,bytes)
        SELECT id,$2,$3,$4,$5,$6,$7,$8 FROM watch_captures WHERE id=$1 AND state='open' AND expires_at>clock_timestamp() RETURNING capture_id`, [c.id, input.sequence, randomUUID(), input.offsetMs, input.durationMs, input.checksum, input.audio, input.audio.length])
      if (!stored.rows.length) throw new WatchError(410, 'capture_expired')
    })
  },
}

/** Cross-replica serialization. Autocommit preserves receipt/progress across failures.
 * Callers must have at least two pool slots; embedded single-connection mode fails closed.
 */
const localCaptures = new Set<string>()
export async function withCaptureLock<T>(id: string, work: (db: PoolClient) => Promise<T>): Promise<T> {
  const pool = getPool()
  const poolMax = pool.options?.max ?? 4
  // Each job pins one advisory-lock connection and may briefly borrow another.
  // Leave at least one slot free, preventing pool exhaustion/deadlock across jobs.
  const capacity = Math.min(4, poolMax - 1)
  if (capacity < 1) throw new WatchError(503, 'watch_requires_pool_slots')
  if (localCaptures.has(id)) throw new WatchError(409, 'capture_busy')
  if (localCaptures.size >= capacity) throw new WatchError(503, 'watch_work_capacity')
  localCaptures.add(id)
  const db = await pool.connect().catch(e => { localCaptures.delete(id); throw e })
  let locked = false, broken = false
  try {
    locked = (await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,650)) AS locked', [id])).rows[0].locked
    if (!locked) throw new WatchError(409, 'capture_busy')
    return await work(db)
  } finally {
    if (locked) await db.query('SELECT pg_advisory_unlock(hashtextextended($1,650))', [id]).catch(() => { broken = true })
    db.release(broken)
    localCaptures.delete(id)
  }
}
