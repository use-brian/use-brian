import { beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { Capture, Grant, Window } from '../watch-store.js'
const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(), get: vi.fn(), assertLive: vi.fn(), upload: vi.fn(), windows: vi.fn(), seal: vi.fn(), sql: vi.fn(), insert: vi.fn(), createRecording: vi.fn(), captureParent: vi.fn(), getRecording: vi.fn(), concat: vi.fn(), validate: vi.fn(),
  workspaceDefault: vi.fn(), resolveBlueprint: vi.fn(),
}))
vi.mock('../watch-store.js', async importOriginal => {
  const original = await importOriginal<typeof import('../watch-store.js')>()
  return { ...original, watchStore: { get: mocks.get, windows: mocks.windows, seal: mocks.seal, assertLive: mocks.assertLive, upload: mocks.upload },
    withCaptureLock: async (_id: string, work: (db: {query: typeof mocks.sql}) => unknown) => work({ query: mocks.sql }) }
})
vi.mock('../../db/recording-jobs-store.js', () => ({ enqueueRecordingJob: mocks.enqueue }))
vi.mock('../../db/client.js', () => ({ query: mocks.sql }))
vi.mock('../../db/live-transcript-store.js', () => ({ insertLiveWindow: mocks.insert }))
vi.mock('../../db/recordings-store.js', () => ({ createRecording: mocks.createRecording, getRecordingSystem: mocks.getRecording }))
vi.mock('../../db/recording-intake-admission.js', () => ({ captureRecordingIntakeParent: mocks.captureParent }))
vi.mock('../ffmpeg.js', () => ({ concatAudioWindows: mocks.concat }))
vi.mock('../watch-media.js', () => ({ validateWatchAudio: mocks.validate }))
vi.mock('../../db/workspace-store.js', () => ({ getWorkspaceDefaultRecordingBlueprint: mocks.workspaceDefault }))
vi.mock('../../db/page-templates-store.js', () => ({ createDbPageTemplateStore: () => ({}) }))
vi.mock('../resolve-blueprint.js', () => ({ resolveRecordingBlueprint: mocks.resolveBlueprint }))
import { createWatchService, authorizeWatchDestination, defaultWatchBlueprint } from '../watch-service.js'

let g: Grant, c: Capture, windows: Window[]
function window(sequence: number): Window {
  return { capture_id: c.id, sequence, chunk_id: randomUUID(), offset_ms: sequence * 1000, duration_ms: 1000, checksum: 'a'.repeat(64), audio: Buffer.from(`${sequence}`), bytes: 1, transcript: null, attempts: 0 }
}
function harness() {
  const pages = { getById: vi.fn(async () => ({ id: c.page_id, workspaceId: g.workspace_id })), createDraft: vi.fn(), update: vi.fn(async () => true) }
  const files = { stat: vi.fn(async () => ({ ok: false, error: { kind: 'not_found' } })), writeBytes: vi.fn(async () => ({ ok: true, value: { id: 'file', createdByUserId: g.owner_id, assistantId: null, mime: 'audio/mp4' } })) }
  const transcribe = vi.fn(async (buffer: Buffer) => `Speaker 1: window ${buffer}`), authorize = vi.fn(async () => {})
  const blueprint = vi.fn(async (): Promise<string | null> => null)
  const service = createWatchService({ pages: pages as never, files: files as never, transcribe, authorize, blueprint })
  return { pages, files, transcribe, authorize, blueprint, service }
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.enqueue.mockResolvedValue({ enqueued: true, jobId: 'retry-job' })
  g = { id: randomUUID(), owner_id: randomUUID(), workspace_id: randomUUID(), assistant_id: randomUUID() } as Grant
  c = { id: randomUUID(), page_id: randomUUID(), recording_id: randomUUID(), client_id: randomUUID(), state: 'open', page_prepared: true, page_prepare_started: true, expires_at: new Date(Date.now() + 3600000), metadata: { title: 'Meeting' } } as Capture
  windows = [window(0), window(1)]
  mocks.assertLive.mockImplementation(async () => { if (c.state === 'expired' || c.expires_at.getTime() <= Date.now()) throw Object.assign(new Error('capture_expired'), { status: 410 }) })
  mocks.upload.mockResolvedValue(null)
  mocks.get.mockImplementation(async () => { await mocks.assertLive(); return c })
  mocks.windows.mockImplementation(async () => windows)
  mocks.seal.mockImplementation(async (_g, _client, input) => { if (c.state !== 'finalized') c.state = 'sealed'; c.finalization = input; return c })
  mocks.sql.mockImplementation(async (sql: string, args: unknown[]) => {
    if (sql.includes('SET attempts=attempts+1')) windows[Number(args[1])].attempts++
    if (sql.includes('expires_at>clock_timestamp()') && (c.state === 'expired' || c.expires_at.getTime() <= Date.now())) return { rows: [] }
    if (sql.includes('INSERT INTO live_transcript_windows')) await mocks.insert({ chunkId: args[0], offsetMs: args[3] })
    if (sql.includes('SET transcript=$3')) windows[Number(args[1])].transcript = JSON.parse(String(args[2]))
    if (sql.includes('SET page_prepare_started=true')) c.page_prepare_started = true
    if (sql.includes('SET page_prepared=true')) c.page_prepared = true
    if (sql.includes("SET state='finalized'")) c.state = 'finalized'
    return { rows: [{ id: 'exists' }] }
  })
  mocks.captureParent.mockResolvedValue({ mime: 'audio/mp4', assistantId: null })
  mocks.createRecording.mockImplementation(async () => ({ id: c.recording_id }))
  mocks.getRecording.mockResolvedValue({ status: 'queued' })
  mocks.concat.mockResolvedValue({ buffer: Buffer.from('assembled'), mime: 'audio/mp4' })
})
describe('watch service recovery and ordering', () => {
  it('does not transcribe past an earlier gap', async () => {
    windows = [window(1)]
    const h = harness(), result = await h.service.retry(g, c.client_id)
    expect(h.transcribe).not.toHaveBeenCalled()
    expect(result.missingSequences).toEqual([0])
    expect(result.missingTimeRanges).toEqual([{ fromMs: 0, toMs: 1000 }])
  })
  it('failed transcription preserves receipt and later retry publishes in order', async () => {
    const h = harness()
    h.transcribe.mockRejectedValueOnce(new Error('provider down'))
    await expect(h.service.retry(g, c.client_id)).rejects.toThrow('provider down')
    expect(windows[0].audio).toEqual(Buffer.from('0'))
    expect(windows[0].transcript).toBeNull()
    expect(mocks.insert).not.toHaveBeenCalled()
    await h.service.retry(g, c.client_id)
    expect(mocks.insert.mock.calls.map(([input]) => input.offsetMs)).toEqual([0, 1000])
    expect(windows[0].attempts).toBe(2)
    const calls = h.transcribe.mock.calls.length
    await h.service.retry(g, c.client_id)
    expect(h.transcribe).toHaveBeenCalledTimes(calls) // replay uses saved model results
  })
  it('recovers a failed publication without calling the model again', async () => {
    const h = harness()
    mocks.insert.mockRejectedValueOnce(new Error('DB unavailable'))
    await expect(h.service.retry(g, c.client_id)).rejects.toThrow('DB unavailable')
    expect(windows[0].transcript).not.toBeNull()
    await h.service.retry(g, c.client_id)
    expect(h.transcribe).toHaveBeenCalledTimes(2)
    expect(mocks.insert.mock.calls[0][0].chunkId).toBe(mocks.insert.mock.calls[1][0].chunkId)
  })
  it('caps model work per request and refuses unbounded retries', async () => {
    windows = [0, 1, 2, 3].map(window)
    const h = harness()
    await h.service.retry(g, c.client_id)
    expect(h.transcribe).toHaveBeenCalledTimes(3)
    windows[3].attempts = 5
    await expect(h.service.retry(g, c.client_id)).rejects.toMatchObject({ message: 'transcription_retry_limit' })
  })
  it('finalizes to canonical intake, same page and one atomic existing-worker job; exact retry is a no-op', async () => {
    const h = harness(), input = { expectedWindows: 2, allowIncomplete: false }
    const result = await h.service.finalize(g, c.client_id, input)
    expect(result.recordingId).toBe(c.recording_id)
    expect(mocks.concat).toHaveBeenCalledWith([Buffer.from('0'), Buffer.from('1')], 'm4a')
    expect(mocks.createRecording.mock.calls[0][1]).toEqual({ actorUserId: g.owner_id, parent: { mime: 'audio/mp4', assistantId: null } })
    expect(h.pages.update).toHaveBeenCalledWith(g.owner_id, c.page_id, { linkedRecordingId: c.recording_id })
    const sql = mocks.sql.mock.calls.map(([s]) => s)
    expect(sql.slice(-5)).toEqual(['BEGIN', expect.stringContaining('INSERT INTO recording_jobs'), expect.stringContaining('UPDATE recordings'), expect.stringContaining("state='finalized'"), 'COMMIT'])
    await h.service.finalize(g, c.client_id, input)
    expect(mocks.createRecording).toHaveBeenCalledTimes(1)
    expect(mocks.concat).toHaveBeenCalledTimes(1)
  })
  it.each([['bp-1', 'the workspace default blueprint'], [null, 'no blueprint when the workspace has no default']])('queues %s (%s) with the brief filed under the capture page', async (selected, _case) => {
    const h = harness(); h.blueprint.mockResolvedValue(selected)
    await h.service.finalize(g, c.client_id, { expectedWindows: 2, allowIncomplete: false })
    expect(h.blueprint).toHaveBeenCalledWith(g)
    const job = mocks.sql.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO recording_jobs'))
    expect(job?.[1]).toEqual([c.recording_id, g.workspace_id, g.owner_id, selected, c.page_id])
  })
  it('explicitly queues finalized failed processing without requiring live transcription', async () => {
    const h = harness(); c.state = 'finalized'
    h.blueprint.mockResolvedValue('bp-1')
    const service = createWatchService({ pages: h.pages as never, files: h.files as never, authorize: h.authorize, blueprint: h.blueprint })
    await service.retry(g, c.client_id)
    expect(mocks.enqueue).toHaveBeenCalledWith({ recordingId: c.recording_id, workspaceId: g.workspace_id, actingUserId: g.owner_id, blueprintSlug: 'bp-1', parentPageId: c.page_id }, expect.objectContaining({ query: mocks.sql }))
    expect(mocks.sql.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', expect.stringContaining('FOR UPDATE'), expect.stringContaining("SET status='queued'"), 'COMMIT'])
    expect(h.authorize).toHaveBeenCalledTimes(2)
    expect(h.files.writeBytes).not.toHaveBeenCalled()
    expect(mocks.createRecording).not.toHaveBeenCalled()
  })
  it.each(['queued', 'processing', 'processed'])('does not enqueue finalized %s processing', async processing => {
    const h = harness(); c.state = 'finalized'
    mocks.getRecording.mockResolvedValue({ status: processing })
    mocks.sql.mockResolvedValue({ rows: [] }) // failed-only locked SELECT finds no row
    expect((await h.service.retry(g, c.client_id)).processing).toBe(processing)
    expect(mocks.enqueue).not.toHaveBeenCalled()
    expect(h.transcribe).not.toHaveBeenCalled()
  })
  it('does not overwrite worker status when an active job already exists', async () => {
    const h = harness(); c.state = 'finalized'
    mocks.enqueue.mockResolvedValue({ enqueued: false, jobId: null })
    await h.service.retry(g, c.client_id)
    expect(mocks.sql.mock.calls.some(([sql]) => sql.includes('UPDATE recordings'))).toBe(false)
  })
  it('rejects finalized retries after destination authorization is lost', async () => {
    const h = harness(); c.state = 'finalized'
    h.authorize.mockRejectedValue(new Error('destination_unavailable'))
    await expect(h.service.retry(g, c.client_id)).rejects.toThrow('destination_unavailable')
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })
  it('rolls back enqueue/status together if the capture expires during retry', async () => {
    const h = harness(); c.state = 'finalized'
    mocks.enqueue.mockImplementation(async () => {
      c.expires_at = new Date(0)
      return { enqueued: true, jobId: 'retry-job' }
    })
    await expect(h.service.retry(g, c.client_id)).rejects.toThrow('capture_expired')
    expect(mocks.sql.mock.calls.at(-1)?.[0]).toBe('ROLLBACK')
  })
  it('leaves sealed intent recoverable on storage failure; never enqueues prematurely', async () => {
    const h = harness()
    h.files.writeBytes.mockRejectedValueOnce(new Error('storage failed'))
    const input = { expectedWindows: 2, allowIncomplete: false }
    await expect(h.service.finalize(g, c.client_id, input)).rejects.toThrow('storage failed')
    expect(c.state).toBe('sealed')
    expect(mocks.createRecording).not.toHaveBeenCalled()
    await h.service.finalize(g, c.client_id, input)
    expect(c.state).toBe('finalized')
  })
  it('never resurrects a capture that expires during transcription or final media work', async () => {
    const h = harness()
    h.transcribe.mockImplementationOnce(async () => { c.expires_at = new Date(0); return 'late result' })
    await expect(h.service.retry(g, c.client_id)).rejects.toMatchObject({ status: 410 })
    expect(windows[0].transcript).toBeNull()
    expect(mocks.insert).not.toHaveBeenCalled()
    c.expires_at = new Date(Date.now() + 3600000)
    mocks.concat.mockImplementationOnce(async () => { c.expires_at = new Date(0); return { buffer: Buffer.from('late'), mime: 'audio/mp4' } })
    await expect(h.service.finalize(g, c.client_id, { expectedWindows: 2, allowIncomplete: false })).rejects.toMatchObject({ status: 410 })
    expect(h.files.writeBytes).not.toHaveBeenCalled()
    expect(mocks.createRecording).not.toHaveBeenCalled()
    expect(c.state).not.toBe('finalized')
  })
  it('checks expiry in final transaction and rolls back the enqueue instead of resurrecting expired state', async () => {
    const h = harness()
    const previous = mocks.sql.getMockImplementation()!
    mocks.sql.mockImplementation(async (sql, args) => {
      if (sql.includes('INSERT INTO recording_jobs')) c.expires_at = new Date(0)
      return previous(sql, args)
    })
    await expect(h.service.finalize(g, c.client_id, { expectedWindows: 2, allowIncomplete: false })).rejects.toMatchObject({ status: 410 })
    expect(mocks.sql.mock.calls.at(-1)?.[0]).toBe('ROLLBACK')
    expect(c.state).toBe('sealed')
  })
  it('creates a page only on the initial preparation, and cannot recreate a deleted prepared/finalized page', async () => {
    const h = harness()
    c.page_prepared = false; c.page_prepare_started = false
    h.pages.getById.mockResolvedValue(null as never)
    await h.service.prepare(g, c)
    expect(h.pages.createDraft).toHaveBeenCalledTimes(1)
    expect(h.pages.createDraft).toHaveBeenCalledWith(expect.objectContaining({ userId: g.owner_id }), { provenance: { kind: 'human-authored', actorId: g.owner_id } })
    await expect(h.service.prepare(g, c)).rejects.toMatchObject({ message: 'page_unavailable' })
    c.state = 'finalized'
    await expect(h.service.prepare(g, c)).rejects.toMatchObject({ message: 'page_unavailable' })
    await h.service.status(g, c.client_id) // reads never prepare/mutate pages
    expect(h.pages.createDraft).toHaveBeenCalledTimes(1)
  })
  it('does not recreate a page after ambiguous initial publication', async () => {
    const h = harness()
    c.page_prepared = false; c.page_prepare_started = true
    h.pages.getById.mockResolvedValue(null as never)
    await expect(h.service.prepare(g, c)).rejects.toMatchObject({ message: 'page_preparation_uncertain' })
    await expect(h.service.finalize(g, c.client_id, { expectedWindows: 2, allowIncomplete: false })).rejects.toMatchObject({ message: 'page_unavailable' })
    expect(c.state).toBe('open') // failed preparation is not frozen into a sealed capture
    expect(h.pages.createDraft).not.toHaveBeenCalled()
  })
  it('full-file finalize adopts the staged immutable bytes through the same canonical intake, never concatenates windows', async () => {
    const h = harness()
    mocks.upload.mockResolvedValue({ audio: Buffer.from('full'), received: true, bytes: 4, checksum: 'a'.repeat(64), duration_ms: 2000 })
    const result = await h.service.finalize(g, c.client_id, { expectedWindows: 0, allowIncomplete: false, source: 'full' })
    expect(result.recordingId).toBe(c.recording_id)
    expect(h.files.writeBytes).toHaveBeenCalledWith({ workspaceId: g.workspace_id, userId: g.owner_id }, expect.objectContaining({ bytes: Buffer.from('full') }))
    expect(mocks.concat).not.toHaveBeenCalled()
    expect(mocks.createRecording).toHaveBeenCalledTimes(1)
    await h.service.finalize(g, c.client_id, { expectedWindows: 0, allowIncomplete: false, source: 'full' })
    expect(mocks.createRecording).toHaveBeenCalledTimes(1)
  })
  it('publishes a non-primary destination into the capture partition, reading it back through that partition only', async () => {
    const h = harness(), scope = randomUUID()
    c.scope_assistant_id = scope
    h.files.writeBytes.mockResolvedValue({ ok: true, value: { id: 'file', createdByUserId: g.owner_id, assistantId: scope, mime: 'audio/mp4' } } as never)
    mocks.captureParent.mockResolvedValue({ mime: 'audio/mp4', assistantId: scope })
    await h.service.finalize(g, c.client_id, { expectedWindows: 2, allowIncomplete: false })
    const ctx = { workspaceId: g.workspace_id, userId: g.owner_id, scopeAssistantId: scope }
    expect(h.files.stat).toHaveBeenCalledWith(ctx, `/recordings/watch/${c.id}.m4a`)
    expect(h.files.writeBytes).toHaveBeenCalledWith(ctx, expect.objectContaining({ sensitivity: 'internal' }))
    expect(mocks.captureParent).toHaveBeenCalledWith({ actorUserId: g.owner_id, access: { workspaceId: g.workspace_id, userId: g.owner_id,
      assistantId: '', assistantKind: 'primary', visibilityAssistantIds: [scope] } }, g.workspace_id, 'file')
    expect(mocks.createRecording).toHaveBeenCalledWith(expect.objectContaining({ assistantId: scope }), expect.anything())
  })
  it('refuses media or intake outside the capture partition before creating a recording', async () => {
    const h = harness(), scope = randomUUID()
    c.scope_assistant_id = scope
    await expect(h.service.finalize(g, c.client_id, { expectedWindows: 2, allowIncomplete: false })).rejects.toMatchObject({ message: 'media_identity_conflict' })
    h.files.writeBytes.mockResolvedValue({ ok: true, value: { id: 'file', createdByUserId: g.owner_id, assistantId: scope, mime: 'audio/mp4' } } as never)
    await expect(h.service.finalize(g, c.client_id, { expectedWindows: 2, allowIncomplete: false })).rejects.toMatchObject({ message: 'media_identity_conflict' })
    expect(mocks.createRecording).not.toHaveBeenCalled()
  })
  it('authorizes any assistant the owner may use that is cleared for the internal audio', async () => {
    mocks.sql.mockResolvedValue({ rows: [{}] })
    await authorizeWatchDestination({ owner_id: g.owner_id, workspace_id: g.workspace_id, assistant_id: g.assistant_id })
    const [sql, params] = mocks.sql.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain("(a.kind='primary' OR a.clearance IN ('internal','confidential'))")
    expect(sql).toMatch(/workspace_members m JOIN assistants a/)
    expect(sql).toContain('blocked_user_ids')
    expect(params).toEqual([g.owner_id, g.workspace_id, g.assistant_id])
  })
  it('rechecks revocation before model publication and validates destination membership', async () => {
    const h = harness()
    h.authorize.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('revoked'))
    await expect(h.service.retry(g, c.client_id)).rejects.toThrow('revoked')
    expect(mocks.insert).not.toHaveBeenCalled()
    mocks.sql.mockResolvedValue({ rows: [] })
    await expect(authorizeWatchDestination(g)).rejects.toMatchObject({ status: 403 })
    mocks.sql.mockResolvedValueOnce({ rows: [{}] }).mockResolvedValueOnce({ rows: [] })
    await expect(authorizeWatchDestination(g)).rejects.toMatchObject({ status: 401 })
  })
})
describe('watch default blueprint', () => {
  it('uses the workspace default only when it resolves to an accessible blueprint', async () => {
    mocks.workspaceDefault.mockResolvedValue(null)
    expect(await defaultWatchBlueprint(g)).toBeNull()
    expect(mocks.resolveBlueprint).not.toHaveBeenCalled()
    mocks.workspaceDefault.mockResolvedValue('bp-1')
    mocks.resolveBlueprint.mockResolvedValue({ id: 'bp-1' })
    expect(await defaultWatchBlueprint(g)).toBe('bp-1')
    expect(mocks.resolveBlueprint).toHaveBeenCalledWith({}, { userId: g.owner_id, workspaceId: g.workspace_id, selection: 'bp-1' })
    mocks.resolveBlueprint.mockRejectedValue(new Error('not accessible'))
    expect(await defaultWatchBlueprint(g)).toBeNull()
  })
})
