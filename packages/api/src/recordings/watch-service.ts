import type { FilesApi, SavedViewStore } from '@use-brian/core'
import { LIVE_MARKER_ID_PREFIX } from '@use-brian/shared'
import { query } from '../db/client.js'
import type { PoolClient } from 'pg'
import { enqueueRecordingJob } from '../db/recording-jobs-store.js'
import { createRecording, getRecordingSystem } from '../db/recordings-store.js'
import { getWorkspaceDefaultRecordingBlueprint } from '../db/workspace-store.js'
import { createDbPageTemplateStore } from '../db/page-templates-store.js'
import { resolveRecordingBlueprint } from './resolve-blueprint.js'
import { captureRecordingIntakeParent } from '../db/recording-intake-admission.js'
import { validateWatchAudio } from './watch-media.js'
import { concatAudioWindows } from './ffmpeg.js'
import { parseTranscriptLines } from '../routes/recording-live.js'
import { watchStore, WatchError, withCaptureLock, missingTimeRanges, type Grant, type Capture, type Window } from './watch-store.js'

export async function authorizeWatchDestination(g: Pick<Grant, 'owner_id' | 'workspace_id' | 'assistant_id'> & { id?: string; authMode?: 'relay' }) {
  // Any assistant the owner can use in this workspace: a current member who is not
  // blocked from it. A non-primary destination must be cleared to read the internal
  // audio the watch writes, or it could never see its own recording.
  const result = await query(`SELECT 1 FROM workspace_members m JOIN assistants a ON a.workspace_id=m.workspace_id
    WHERE m.user_id=$1 AND m.workspace_id=$2 AND a.id=$3
      AND public.assistant_placement_visible($1,a.id)
      AND (a.kind='primary' OR a.clearance IN ('internal','confidential'))
      AND NOT ($1=ANY(a.blocked_user_ids))`, [g.owner_id, g.workspace_id, g.assistant_id])
  if (!result.rows.length) throw new WatchError(403, 'destination_unavailable')
  if (g.id) {
    const current = await query('SELECT 1 FROM recording_device_grants WHERE id=$1 AND revoked_at IS NULL AND (expires_at>now() OR $2::boolean)', [g.id, g.authMode === 'relay'])
    if (!current.rows.length) throw new WatchError(401, 'invalid_device_access')
  }
}

/**
 * The blueprint a watch recording is processed with. A watch has no picker, so,
 * like a channel recording, it takes the workspace default (null = transcript
 * only). A stale or inaccessible default must never block the recording.
 */
export async function defaultWatchBlueprint(g: Pick<Grant, 'owner_id' | 'workspace_id'>): Promise<string | null> {
  const selection = await getWorkspaceDefaultRecordingBlueprint(g.workspace_id)
  if (!selection) return null
  try {
    return (await resolveRecordingBlueprint(createDbPageTemplateStore(), { userId: g.owner_id, workspaceId: g.workspace_id, selection })).id
  } catch {
    return null
  }
}

export function missingSequences(windows: Pick<Window, 'sequence'>[], expected: number): number[] {
  const received = new Set(windows.map(w => w.sequence))
  return Array.from({ length: expected }, (_, i) => i).filter(i => !received.has(i))
}
export type WatchService = ReturnType<typeof createWatchService>
export function createWatchService(deps: {
  pages: Pick<SavedViewStore, 'createDraft' | 'getById' | 'update'>
  files: Pick<FilesApi, 'stat' | 'writeBytes'>
  transcribe?: (audio: Buffer) => Promise<string>
  authorize?: typeof authorizeWatchDestination
  blueprint?: typeof defaultWatchBlueprint
}) {
  const authorize = deps.authorize ?? authorizeWatchDestination
  const blueprint = deps.blueprint ?? defaultWatchBlueprint
  async function ensurePage(g: Grant, c: Capture, db: PoolClient, initial = false) {
    await watchStore.assertLive(c.id, db)
    const existing = await deps.pages.getById(g.owner_id, c.page_id)
    if (existing && existing.workspaceId !== g.workspace_id) throw new WatchError(403, 'destination_unavailable')
    if (c.page_prepared) {
      if (!existing) throw new WatchError(409, 'page_unavailable')
      return
    }
    if (!initial || c.state !== 'open') throw new WatchError(409, 'page_unavailable')
    if (!existing) {
      // Persist creation intent FIRST. A crash is recoverable if the page exists;
      // an ambiguous missing page is never silently recreated after deletion.
      if (c.page_prepare_started) throw new WatchError(409, 'page_preparation_uncertain')
      const claimed = await db.query("UPDATE watch_captures SET page_prepare_started=true WHERE id=$1 AND NOT page_prepare_started AND state='open' AND expires_at>clock_timestamp() RETURNING id", [c.id])
      if (!claimed.rows.length) throw new WatchError(410, 'capture_expired')
      // The owner-approved device grant authors a new, source-free capture page.
      // Pass the real owner to canonical placement admission, never a client-supplied actor.
      await deps.pages.createDraft({ id: c.page_id, userId: g.owner_id, workspaceId: g.workspace_id,
        name: c.metadata.title, nameOrigin: 'user', entity: 'tasks', viewType: 'table', binding: { entity: 'tasks', viewType: 'table' },
        state: 'saved', writtenBy: 'user', page: { blocks: [{ id: `${LIVE_MARKER_ID_PREFIX}${c.id}`, kind: 'text', text: 'Watch recording — provisional transcript. Final audio processing starts after upload completes.' }] } },
      { provenance: { kind: 'human-authored', actorId: g.owner_id } })
    }
    const prepared = await db.query("UPDATE watch_captures SET page_prepared=true,page_prepare_started=true WHERE id=$1 AND state='open' AND expires_at>clock_timestamp() RETURNING id", [c.id])
    if (!prepared.rows.length) throw new WatchError(410, 'capture_expired')
  }
  async function prepare(g: Grant, capture: Capture) {
    await withCaptureLock(capture.id, async db => {
      const current = await watchStore.get(g, capture.client_id)
      await ensurePage(g, current, db, true)
    })
  }
  async function status(g: Grant, clientId: string) {
    const c = await watchStore.get(g, clientId)
    const rows = await watchStore.windows(c.id, false)
    const expected = c.finalization?.expectedWindows ?? (rows.length ? rows[rows.length - 1].sequence + 1 : 0)
    const full = await watchStore.upload(c.id)
    const recording = c.state === 'finalized' ? await getRecordingSystem(c.recording_id) : null
    return { clientId, sessionId: c.id, pageId: c.page_id, recordingId: c.state === 'finalized' ? c.recording_id : null,
      state: c.state, pagePrepared: c.page_prepared, fullUpload: full ? { sha256: full.checksum, bytes: full.bytes, durationMs: full.duration_ms, received: full.received === true } : null, expiresAt: c.expires_at, finalization: c.finalization, missingSequences: missingSequences(rows, expected), missingTimeRanges: missingTimeRanges(rows),
      windows: rows.map(w => ({ sequence: w.sequence, offsetMs: w.offset_ms, durationMs: w.duration_ms, sha256: w.checksum, bytes: w.bytes,
        transcription: w.transcript !== null ? 'ready' : w.attempts > 0 ? 'failed' : 'pending' })),
      processing: recording?.status ?? null }
  }
  async function retry(g: Grant, clientId: string) {
    const c = await watchStore.get(g, clientId)
    await withCaptureLock(c.id, async db => {
      const c = await watchStore.get(g, clientId)
      await authorize(g)
      if (c.state === 'finalized') {
        // Explicit recovery only: never republish media or alter canonical scope.
        const blueprintSlug = await blueprint(g)
        await db.query('BEGIN')
        try {
          const failed = await db.query(`SELECT id FROM recordings
            WHERE id=$1 AND workspace_id=$2 AND status='failed' AND valid_to IS NULL FOR UPDATE`,
          [c.recording_id, g.workspace_id])
          if (failed.rows.length) {
            const job = await enqueueRecordingJob({ recordingId: c.recording_id,
              workspaceId: g.workspace_id, actingUserId: g.owner_id, blueprintSlug, parentPageId: c.page_id }, db)
            // The active-job unique index also protects against non-watch enqueues.
            if (job.enqueued) await db.query("UPDATE recordings SET status='queued' WHERE id=$1 AND status='failed'", [c.recording_id])
          }
          await authorize(g)
          await watchStore.assertLive(c.id, db)
          await db.query('COMMIT')
        } catch (error) { await db.query('ROLLBACK'); throw error }
        return
      }
      if (!deps.transcribe) throw new WatchError(503, 'live_transcription_unavailable')
      await ensurePage(g, c, db)
      const rows = await watchStore.windows(c.id)
      let sequence = 0, processed = 0
      for (const w of rows) {
        if (w.sequence !== sequence++) break // Never publish past a missing window.
        let lines = w.transcript
        if (lines === null) {
          if (processed++ === 3) break // Bound synchronous provider work; call again to drain.
          if (w.attempts >= 5) throw new WatchError(409, 'transcription_retry_limit')
          await watchStore.assertLive(c.id, db)
          await db.query('UPDATE watch_capture_windows SET attempts=attempts+1 WHERE capture_id=$1 AND sequence=$2', [c.id, w.sequence])
          lines = parseTranscriptLines(await deps.transcribe!(w.audio))
          const saved = await db.query(`UPDATE watch_capture_windows w SET transcript=$3 FROM watch_captures c WHERE c.id=w.capture_id AND w.capture_id=$1 AND w.sequence=$2 AND c.state IN ('open','sealed') AND c.expires_at>clock_timestamp() RETURNING w.chunk_id`, [c.id, w.sequence, JSON.stringify(lines)])
          if (!saved.rows.length) throw new WatchError(410, 'capture_expired')
        }
        // Persist model result before publishing. Retrying publication cannot duplicate blocks.
        await authorize(g)
        const published = await db.query(`INSERT INTO live_transcript_windows
          (chunk_id,session_id,workspace_id,page_id,offset_ms,duration_ms,missed_before,lines,audio_key)
          SELECT $1,c.id,$3,c.page_id,$4,$5,0,$6::jsonb,NULL FROM watch_captures c
          WHERE c.id=$2 AND c.state IN ('open','sealed') AND c.expires_at>clock_timestamp()
          ON CONFLICT (chunk_id) DO UPDATE SET chunk_id=excluded.chunk_id RETURNING chunk_id`,
        [w.chunk_id, c.id, g.workspace_id, w.offset_ms, w.duration_ms, JSON.stringify(lines)])
        if (!published.rows.length) throw new WatchError(410, 'capture_expired')
      }
    })
    return status(g, clientId)
  }
  async function finalize(g: Grant, clientId: string, input: { expectedWindows: number; allowIncomplete: boolean; source?: 'windows' | 'full' }) {
    const initial = await watchStore.get(g, clientId)
    await withCaptureLock(initial.id, async db => {
      await authorize(g)
      // An interrupted initial page preparation must not become irreversibly sealed.
      const current = await watchStore.get(g, clientId)
      if (current.state !== 'finalized') await ensurePage(g, current, db)
      // Receipt and sealing share a row lock. Sealing commits before external work and is immutable.
      const c = await watchStore.seal(g, clientId, { ...input, source: input.source ?? 'windows' })
      if (c.state === 'finalized') return
      const rows = await watchStore.windows(c.id, c.finalization?.source !== 'full')
      // Original device audio is human-authored, not assistant-generated. Let the
      // canonical root-file adapter admit its scope; the recording inherits it.
      // A non-primary destination partitions it to the capture's frozen assistant.
      const scope = c.scope_assistant_id ?? null
      const ctx = { workspaceId: g.workspace_id, userId: g.owner_id, ...(scope ? { scopeAssistantId: scope } : {}) }
      const path = `/recordings/watch/${c.id}.m4a`
      let file = await deps.files.stat(ctx, path)
      if (!file.ok) {
        if (file.error.kind !== 'not_found') throw new WatchError(409, 'media_unavailable')
        const full = c.finalization?.source === 'full' ? await watchStore.upload(c.id, true) : null
        if (c.finalization?.source === 'full' && !full?.audio) throw new WatchError(409, 'full_upload_missing')
        const assembled = full?.audio ? { buffer: full.audio, mime: 'audio/mp4' } : await concatAudioWindows(rows.map(w => w.audio), 'm4a')
        await validateWatchAudio(assembled.buffer, null, 180 * 60000)
        await authorize(g)
        await watchStore.assertLive(c.id, db)
        file = await deps.files.writeBytes(ctx, { path, bytes: assembled.buffer, mime: assembled.mime, title: c.metadata.title, sensitivity: 'internal' })
      }
      if (!file.ok) throw new WatchError(file.error.kind === 'quota_exceeded' ? 413 : 409, 'media_publication_failed')
      if (file.value.createdByUserId !== g.owner_id || file.value.assistantId !== scope || file.value.createdByAssistantId != null || file.value.mime !== 'audio/mp4') throw new WatchError(409, 'media_identity_conflict')
      await watchStore.assertLive(c.id, db)
      // The human intake read must see the partition it publishes, and nothing wider.
      const authority = { actorUserId: g.owner_id, ...(scope ? { access: { workspaceId: g.workspace_id, userId: g.owner_id,
        assistantId: '', assistantKind: 'primary' as const, visibilityAssistantIds: [scope] } } : {}) }
      const parent = await captureRecordingIntakeParent(authority, g.workspace_id, file.value.id)
      if (parent.assistantId !== scope) throw new WatchError(409, 'media_identity_conflict')
      await watchStore.assertLive(c.id, db)
      const recording = await createRecording({ id: c.recording_id, workspaceId: g.workspace_id, mime: parent.mime,
        gcsKey: '', assistantId: parent.assistantId, createdByUserId: g.owner_id }, { ...authority, parent })
      if (recording.id !== c.recording_id) throw new WatchError(409, 'canonical_recording_conflict')
      await watchStore.assertLive(c.id, db)
      if (!await deps.pages.update(g.owner_id, c.page_id, { linkedRecordingId: recording.id })) throw new WatchError(409, 'page_unavailable')
      await authorize(g)
      // The brief (when the workspace has a default blueprint) is filed under the capture page.
      const blueprintId = await blueprint(g)
      // Atomically enqueue into the existing worker and mark finalized; a lost HTTP response cannot enqueue again.
      await db.query('BEGIN')
      try {
        await db.query(`INSERT INTO recording_jobs(recording_id,workspace_id,acting_user_id,blueprint_slug,parent_page_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [c.recording_id, g.workspace_id, g.owner_id, blueprintId, c.page_id])
        await db.query("UPDATE recordings SET status='queued' WHERE id=$1 AND status='awaiting_upload'", [c.recording_id])
        const finalized = await db.query("UPDATE watch_captures SET state='finalized',finalized_at=clock_timestamp() WHERE id=$1 AND state='sealed' AND expires_at>clock_timestamp() RETURNING id", [c.id])
        if (!finalized.rows.length) throw new WatchError(410, 'capture_expired')
        await db.query('COMMIT')
      } catch (e) { await db.query('ROLLBACK'); throw e }
    })
    return status(g, clientId)
  }
  return { prepare, status, retry, finalize }
}
