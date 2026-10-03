import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { applyOps, transcribeAudio, type Page, type SavedView } from '@use-brian/core'
vi.mock('@use-brian/core', async importOriginal => ({
  ...await importOriginal<typeof import('@use-brian/core')>(),
  transcribeAudio: vi.fn(async () => ({ text: 'Hey Brian configured ASR', model: 'asr-configured', usage: null })),
}))
import { LIVE_MARKER_ID_PREFIX, hasLiveMarkerBlock } from '@use-brian/shared'
import {
  notesRegionOps,
  parseTranscriptLines,
  recordingLiveRoutes,
} from '../recording-live.js'

const USER_ID = '00000000-0000-0000-0000-000000000001'
const WORKSPACE_ID = '00000000-0000-0000-0000-000000000002'

function view(id: string, page: Page, workspaceId = WORKSPACE_ID): SavedView {
  return {
    id,
    workspaceId,
    createdBy: USER_ID,
    name: 'Planning notes',
    nameOrigin: 'user',
    description: null,
    icon: null,
    entity: 'tasks',
    viewType: 'table',
    state: 'saved',
    binding: { entity: 'tasks', viewType: 'table' },
    page,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as SavedView
}

function harness(options: { role?: string | null; enabled?: boolean; withFiles?: boolean; defaultTranscriber?: boolean } = {}) {
  const pages = new Map<string, Page>()
  const views = new Map<string, SavedView>()
  const createDraft = vi.fn(async (input: { page: Page; workspaceId: string; name: string; anchorKey?: string }) => {
    const created = view(input.anchorKey ? 'folder-new' : 'page-new', input.page, input.workspaceId)
    created.name = input.name
    created.anchorKey = input.anchorKey ?? null
    pages.set(created.id, input.page)
    views.set(created.id, created)
    return created
  })
  const updatePage = vi.fn(async (_userId: string, pageId: string, page: Page) => {
    pages.set(pageId, page)
    return true
  })
  const update = vi.fn(async (_userId: string, id: string, fields: Record<string, unknown>) => {
    const existing = views.get(id)
    if (!existing) return null
    Object.assign(existing as unknown as Record<string, unknown>, fields)
    return existing
  })
  const transcribeWindow = vi.fn().mockResolvedValue({
    text: 'Speaker 1: We agreed to ship Friday.\nSpeaker 2: I will draft the plan.',
    model: 'asr-test',
    usage: { inputTokens: 2, outputTokens: 6 },
  })
  const reviseNotes = vi.fn().mockResolvedValue({
    text: '### Decisions\n- Ship Friday\n\n### Action items\n- Speaker 2 drafts the plan',
    model: 'background-test',
    usage: { inputTokens: 12, outputTokens: 5 },
  })
  const recordUsage = vi.fn().mockResolvedValue(undefined)
  const windowRows: Array<Record<string, unknown>> = []
  const liveWindows = {
    insert: vi.fn(async (input: Record<string, unknown>) => {
      windowRows.push(input)
      return true
    }),
    has: vi.fn(async (chunkId: string) => windowRows.some((row) => row.chunkId === chunkId)),
    listByPage: vi.fn(async (_ws: string, pageId: string) =>
      windowRows.filter((row) => row.pageId === pageId),
    ),
    listBySession: vi.fn(async (_ws: string, sessionId: string) =>
      windowRows.filter((row) => row.sessionId === sessionId),
    ),
    clearAudio: vi.fn(async () => {}),
  }
  const blobs = new Map<string, Buffer>()
  const gcs = {
    writeBlob: vi.fn(async (key: string, bytes: Buffer) => {
      blobs.set(key, bytes)
    }),
    readBlob: vi.fn(async (key: string) =>
      blobs.has(key) ? { bytes: blobs.get(key)!, mime: 'audio/webm', metadata: {} } : null,
    ),
    deleteBlob: vi.fn(async (key: string) => {
      blobs.delete(key)
    }),
  }
  const filesResolver = {
    forWorkspace: vi.fn(async () => ({ gcs, bucket: 'test-bucket', uriScheme: 'gs' })),
    forUri: vi.fn(),
  }
  const createEpisode = vi.fn(async () => ({ id: '00000000-0000-0000-0000-00000000e901' }))
  const parent = { workspaceId: WORKSPACE_ID, resourceKind: 'workspace_file', resourceId: 'canonical-file', version: '1', mime: 'audio/mp4', assistantId: null }
  const captureParent = vi.fn().mockResolvedValue(parent)
  const createRecording = vi.fn(async (_input, provenance) => {
    expect(provenance).toEqual({ actorUserId: USER_ID, parent })
    return { id: '00000000-0000-0000-0000-00000000e901', status: 'awaiting_upload' }
  })
  const updateRecording = vi.fn().mockResolvedValue({ kind: 'meeting' })
  const filesApi = { writeBytes: vi.fn().mockResolvedValue({ ok: true, value: { id: 'canonical-file', workspaceId: WORKSPACE_ID, mime: 'audio/mp4' } }) }
  const getRecording = vi.fn(async (_userId: string, id: string) =>
    id === 'rec-1' ? { id, workspaceId: WORKSPACE_ID } : null,
  )
  const concatWindows = vi.fn(async (buffers: Buffer[]) => ({
    buffer: Buffer.concat(buffers),
    mime: 'audio/mp4',
  }))
  const findIdByAnchorKey = vi.fn(async (_userId: string, workspaceId: string, key: string) =>
    [...views.values()].find((row) => row.workspaceId === workspaceId && row.anchorKey === key)?.id ?? null,
  )
  const deps = {
    getRole: vi.fn().mockResolvedValue('role' in options ? options.role : 'member'),
    savedViewStore: {
      findIdByAnchorKey,
      createDraft,
      getById: vi.fn(async (_userId: string, id: string) => views.get(id) ?? null),
      getPage: vi.fn(async (_userId: string, id: string) => pages.get(id) ?? null),
      updatePage,
      update,
    },
    provider: { name: 'test', models: [], stream: vi.fn(), createSession: vi.fn() },
    backgroundModel: 'background-test',
    voiceTranscription: { enabled: options.enabled ?? true, apiKey: 'configured-key', backend: 'gemini', model: 'configured-model' },
    usageStore: { recordUsage },
    ...(options.withFiles === false ? {} : { filesResolver }),
    transcribeWindow: options.defaultTranscriber ? undefined : transcribeWindow,
    reviseNotes,
    liveWindows,
    liveInteraction: { getCapture: vi.fn(), ingest: vi.fn(async () => {}) },
    getRecording,
    filesApi,
    captureParent,
    updateRecording,
    createRecording,
    concatWindows,
  }
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as typeof req & { userId: string }).userId = USER_ID
    next()
  })
  app.use('/api/recordings', recordingLiveRoutes(deps as never))
  return {
    app, deps, pages, views, createDraft, updatePage, update, findIdByAnchorKey,
    transcribeWindow, reviseNotes, recordUsage,
    liveWindows, windowRows, gcs, blobs, createEpisode, createRecording, concatWindows,
  }
}

async function startLive(h: ReturnType<typeof harness>) {
  const started = await request(h.app)
    .post('/api/recordings/live/start')
    .send({ workspaceId: WORKSPACE_ID, destination: 'new', title: 'Weekly sync' })
  expect(started.status).toBe(201)
  return started.body as {
    pageId: string
    title: string
    sessionId: string
    notesHeadingId: string
    markerBlockId: string
  }
}

function chunkRequest(
  h: ReturnType<typeof harness>,
  page: Awaited<ReturnType<typeof startLive>>,
  chunkId: string,
  offsetMs = 30_000,
) {
  return request(h.app)
    .post('/api/recordings/live/chunk')
    .field('workspaceId', WORKSPACE_ID)
    .field('pageId', page.pageId)
    .field('assistantId', 'assistant-1')
    .field('sessionId', page.sessionId)
    .field('notesHeadingId', page.notesHeadingId)
    .field('markerBlockId', page.markerBlockId)
    .field('chunkId', chunkId)
    .field('offsetMs', String(offsetMs))
    .field('durationMs', '30000')
    .attach('audio', Buffer.from('webm-window'), { filename: 'window.webm', contentType: 'audio/webm' })
}

describe('[COMP:recordings/live-page-route]', () => {
  it('creates one localized folder, preserves a rename and nests later meetings under it', async () => {
    const h = harness()
    const start = () => request(h.app).post('/api/recordings/live/start')
      .send({ workspaceId: WORKSPACE_ID, destination: 'meeting-notes', folderName: '会議メモ' })
    expect((await start()).status).toBe(201)
    expect(h.createDraft).toHaveBeenNthCalledWith(1, expect.objectContaining({
      name: '会議メモ', icon: '📁', anchorKey: 'meeting-notes-folder', state: 'saved',
    }))
    expect(h.createDraft).toHaveBeenNthCalledWith(2, expect.objectContaining({ nestParentId: 'folder-new' }))
    h.views.get('folder-new')!.name = 'Team meetings'
    expect((await start()).status).toBe(201)
    expect(h.createDraft).toHaveBeenCalledTimes(3)
    expect(h.createDraft).toHaveBeenLastCalledWith(expect.objectContaining({ nestParentId: 'folder-new' }))
    expect(h.views.get('folder-new')!.name).toBe('Team meetings')
  })

  it('converges on the visible folder when another start wins creation', async () => {
    const h = harness()
    h.findIdByAnchorKey.mockResolvedValueOnce(null).mockResolvedValueOnce('winner')
    h.views.set('winner', view('winner', { blocks: [] }))
    h.createDraft.mockRejectedValueOnce({ code: '23505' })
    const response = await request(h.app).post('/api/recordings/live/start')
      .send({ workspaceId: WORKSPACE_ID, destination: 'meeting-notes' })
    expect(response.status).toBe(201)
    expect(h.createDraft).toHaveBeenLastCalledWith(expect.objectContaining({ nestParentId: 'winner' }))
  })

  it('does not bypass a hidden folder or fall back to a flat note', async () => {
    const h = harness()
    h.createDraft.mockRejectedValueOnce({ code: '23505' })
    const response = await request(h.app).post('/api/recordings/live/start')
      .send({ workspaceId: WORKSPACE_ID, destination: 'meeting-notes' })
    expect(response.status).toBe(503)
    expect(h.createDraft).toHaveBeenCalledTimes(1)
  })

  it('does not create a folder for non-members or explicit root destinations', async () => {
    const denied = harness({ role: null })
    expect((await request(denied.app).post('/api/recordings/live/start')
      .send({ workspaceId: WORKSPACE_ID, destination: 'meeting-notes' })).status).toBe(403)
    expect(denied.createDraft).not.toHaveBeenCalled()
    const h = harness()
    await startLive(h)
    expect(h.findIdByAnchorKey).not.toHaveBeenCalled()
    expect(h.createDraft).toHaveBeenCalledOnce()
    expect(h.createDraft).toHaveBeenCalledWith(expect.objectContaining({ nestParentId: null }))
  })

  it('creates a saved meeting page carrying the live marker and no transcript blocks', async () => {
    const h = harness()
    h.views.set('parent', view('parent', { blocks: [] }))
    h.pages.set('parent', { blocks: [] })

    const response = await request(h.app)
      .post('/api/recordings/live/start')
      .send({ workspaceId: WORKSPACE_ID, destination: 'new', parentPageId: 'parent', title: 'Weekly sync' })

    expect(response.status).toBe(201)
    expect(response.body).toMatchObject({ pageId: 'page-new', title: 'Weekly sync' })
    expect(response.body.sessionId).toEqual(expect.any(String))
    expect(response.body.notesHeadingId).toEqual(expect.any(String))
    expect(response.body.markerBlockId.startsWith(LIVE_MARKER_ID_PREFIX)).toBe(true)
    const page = h.pages.get('page-new')!
    expect(hasLiveMarkerBlock(page.blocks)).toBe(true)
    // The transcript surface is the pane, not the page: only the notes
    // heading, the placeholder, and the marker are seeded.
    expect(page.blocks).toHaveLength(3)
    expect(h.createDraft).toHaveBeenCalledWith(expect.objectContaining({
      state: 'saved',
      nestParentId: 'parent',
      name: 'Weekly sync',
    }))
  })

  it('stores the window row and rewrites the notes region as structured blocks', async () => {
    const h = harness()
    const page = await startLive(h)

    const response = await chunkRequest(h, page, '00000000-0000-0000-0000-000000000099')
    expect(response.status).toBe(200)
    expect(response.body.ok).toBe(true)
    expect(response.body.lines).toEqual([
      { speaker: 'Speaker 1', text: 'We agreed to ship Friday.' },
      { speaker: 'Speaker 2', text: 'I will draft the plan.' },
    ])

    // The transcript never lands in the page; it lands in the windows store.
    expect(h.liveWindows.insert).toHaveBeenCalledWith(expect.objectContaining({
      chunkId: '00000000-0000-0000-0000-000000000099',
      sessionId: page.sessionId,
      pageId: page.pageId,
      offsetMs: 30_000,
      audioKey: expect.stringContaining(`recordings/live/${page.sessionId}/`),
    }))
    const doc = h.pages.get(page.pageId)!
    expect(doc.blocks.some((b) => (b as { text?: string }).text?.includes('We agreed to ship Friday'))).toBe(false)

    // The notes region between heading and marker is now structured markdown.
    const headingIndex = doc.blocks.findIndex((b) => b.id === page.notesHeadingId)
    const markerIndex = doc.blocks.findIndex((b) => b.id === page.markerBlockId)
    const region = doc.blocks.slice(headingIndex + 1, markerIndex)
    expect(region.some((b) => b.kind === 'heading' && (b as { text?: string }).text === 'Decisions')).toBe(true)
    expect(region.some((b) => b.kind === 'bulleted_list_item')).toBe(true)
    // The marker survives every revision — it is the pane's mount signal.
    expect(markerIndex).toBeGreaterThan(headingIndex)
    expect(h.recordUsage).toHaveBeenCalledTimes(2)
  })

  it('is idempotent when a client retries the same chunk id', async () => {
    const h = harness()
    const page = await startLive(h)
    await chunkRequest(h, page, 'chunk-1')
    h.transcribeWindow.mockClear()

    const response = await chunkRequest(h, page, 'chunk-1')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true, duplicate: true })
    expect(h.transcribeWindow).not.toHaveBeenCalled()
  })

  it('keeps the audio-bearing window row when transcription fails', async () => {
    const h = harness()
    const page = await startLive(h)
    h.transcribeWindow.mockRejectedValueOnce(new Error('asr down'))

    const response = await chunkRequest(h, page, 'chunk-asr-down')
    expect(response.status).toBe(503)
    // The bytes reached storage and the row records them for finalize.
    expect(h.liveWindows.insert).toHaveBeenCalledWith(expect.objectContaining({
      chunkId: 'chunk-asr-down',
      lines: [],
      audioKey: expect.any(String),
    }))
  })

  it('rejects live setup before page creation when transcription is disabled', async () => {
    const h = harness({ enabled: false })
    const response = await request(h.app)
      .post('/api/recordings/live/start')
      .send({ workspaceId: WORKSPACE_ID, destination: 'new' })
    expect(response.status).toBe(503)
    expect(h.createDraft).not.toHaveBeenCalled()
  })

  const captureId = '00000000-0000-0000-0000-000000000777'
  async function interactionHarness(options = {}) {
    const h = harness(options)
    const page = await startLive(h)
    h.deps.liveInteraction.getCapture.mockResolvedValue({ ownerId: USER_ID, workspaceId: WORKSPACE_ID,
      pageId: page.pageId, assistantId: 'assistant-1', state: 'listening' })
    const send = (source = 'microphone', chunk = 'interaction-audio') => chunkRequest(h, page, chunk)
      .field('interactionCaptureId', captureId).field('interactionSource', source)
    return { h, page, send }
  }

  it('transcribes mic-only once, bills once, ingests stable source IDs and uses only canonical pane windows', async () => {
    const { h, page, send } = await interactionHarness()
    const result = await send().field('missedWindows', '1')
    expect(result.status).toBe(200)
    expect(result.body.interactionError).toBeUndefined()
    expect(h.transcribeWindow).toHaveBeenCalledOnce()
    expect(h.deps.liveInteraction.ingest).toHaveBeenCalledWith(USER_ID, captureId, {
      id: `${page.sessionId}:interaction-audio:microphone`, source: 'microphone',
      text: result.body.transcript, startMs: 30000, endMs: 60000, discontinuity: true,
    })
    expect(h.recordUsage.mock.calls.filter(([u]) => u.source === 'overhead:transcription')).toHaveLength(1)
    const windows = await request(h.app).get('/api/recordings/live/windows').query({ workspaceId: WORKSPACE_ID, pageId: page.pageId })
    expect(windows.body.windows).toHaveLength(1)
    expect(windows.body.windows[0].lines).toEqual(result.body.lines)
    expect((await send()).body.duplicate).toBe(true)
    expect(h.transcribeWindow).toHaveBeenCalledOnce()
    expect(h.deps.liveInteraction.ingest).toHaveBeenCalledOnce()
  })

  it.each(['missing', 'failed', 'available'])('mixed audio never supplies microphone triggers: isolated mic %s', async mode => {
    const { h, send } = await interactionHarness()
    h.transcribeWindow.mockResolvedValueOnce({ text: 'Speaker 1: Hey Brian playback', model: 'asr-test', usage: { inputTokens: 2, outputTokens: 6 } })
    if (mode === 'failed') h.transcribeWindow.mockRejectedValueOnce(new Error('mic failed'))
    else h.transcribeWindow.mockResolvedValueOnce({ text: 'Hey Brian real mic', model: 'asr-test', usage: { inputTokens: 2, outputTokens: 6 } })
    const req = send('mixed')
    if (mode !== 'missing') req.attach('microphone', Buffer.from('isolated'), { filename: 'mic.webm', contentType: 'audio/webm' })
    const result = await req
    expect(result.status).toBe(200)
    expect(result.body.transcript).toContain('playback')
    expect(h.gcs.writeBlob).toHaveBeenCalled()
    expect(h.windowRows[0]?.lines).toEqual(result.body.lines)
    const calls = h.deps.liveInteraction.ingest.mock.calls as unknown as Array<[string, string, { source: string; text: string; discontinuity: boolean }]>
    expect(calls.map(c => c[2])).toEqual([
      expect.objectContaining({ source: 'system', text: 'Speaker 1: Hey Brian playback' }),
      expect.objectContaining({ source: 'microphone', text: mode === 'available' ? 'Hey Brian real mic' : '', discontinuity: mode !== 'available' }),
    ])
    expect(h.transcribeWindow).toHaveBeenCalledTimes(mode === 'missing' ? 1 : 2)
    if (mode === 'available') {
      expect(result.body.interactionError).toBeUndefined()
      expect(h.transcribeWindow).toHaveBeenLastCalledWith({ buffer: Buffer.from('isolated'), mime: 'audio/webm' })
      expect(h.recordUsage.mock.calls.filter(([u]) => u.source === 'overhead:transcription')).toHaveLength(2)
    } else expect(result.body.interactionError).toBe(true)
  })

  it('keeps the authorized main-chat assistant independent from the recorder upload assistant', async () => {
    const { h, page, send } = await interactionHarness()
    h.deps.liveInteraction.getCapture.mockResolvedValue({ ownerId: USER_ID, workspaceId: WORKSPACE_ID,
      pageId: page.pageId, assistantId: 'main-chat-assistant', state: 'listening' })
    const result = await send()
    expect(result.status).toBe(200)
    expect(result.body.interactionError).toBeUndefined()
    expect(h.deps.liveInteraction.ingest).toHaveBeenCalledOnce()
  })

  it.each(['ownerId', 'workspaceId', 'pageId', 'chatAccess', 'ingest'])('isolates interaction %s failure from audio and transcript', async failure => {
    const { h, send } = await interactionHarness()
    if (failure === 'chatAccess') h.deps.liveInteraction.getCapture.mockRejectedValue(new Error('denied'))
    else if (failure === 'ingest') h.deps.liveInteraction.ingest.mockRejectedValue(new Error('store unavailable'))
    else h.deps.liveInteraction.getCapture.mockResolvedValue({ ownerId: USER_ID, workspaceId: WORKSPACE_ID,
      pageId: 'page-new', assistantId: 'assistant-1', state: 'listening', [failure]: 'other' })
    const result = await send()
    expect(result.status).toBe(200)
    expect(result.body.interactionError).toBe(true)
    expect(h.windowRows[0]?.missedBefore).toBe(1)
    expect(result.body.lines.length).toBeGreaterThan(0)
    expect(h.windowRows[0]?.lines).toEqual(result.body.lines)
    expect(h.gcs.writeBlob).toHaveBeenCalledOnce()
    if (failure !== 'ingest') expect(h.deps.liveInteraction.ingest).not.toHaveBeenCalled()
  })

  it('honors pause discontinuity independently of missed windows', async () => {
    const { h, send } = await interactionHarness()
    const result = await send().field('discontinuity', 'true')
    expect(result.status).toBe(200)
    expect(result.body.interaction).toBeUndefined()
    expect(h.deps.liveInteraction.ingest).toHaveBeenCalledWith(USER_ID, captureId,
      expect.objectContaining({ discontinuity: true }))
  })

  it('uses the configured existing backend for both main and isolated audio', async () => {
    vi.mocked(transcribeAudio).mockClear()
    const { h, send } = await interactionHarness({ defaultTranscriber: true })
    expect((await send('mixed').attach('microphone', Buffer.from('isolated'),
      { filename: 'mic.webm', contentType: 'audio/webm' })).status).toBe(200)
    expect(transcribeAudio).toHaveBeenCalledTimes(2)
    for (const call of vi.mocked(transcribeAudio).mock.calls) expect(call[1]).toMatchObject({
      apiKey: 'configured-key', backend: 'gemini', model: 'configured-model',
    })
    expect(h.transcribeWindow).not.toHaveBeenCalled()
  })

  it('ingests before the window duplicate boundary and retries with the same source ID', async () => {
    const { h, send } = await interactionHarness()
    h.liveWindows.insert.mockRejectedValueOnce(new Error('crash boundary'))
    expect((await send()).status).toBe(503)
    expect(h.deps.liveInteraction.ingest).toHaveBeenCalledOnce()
    expect(h.deps.liveInteraction.ingest.mock.invocationCallOrder[0]).toBeLessThan(h.liveWindows.insert.mock.invocationCallOrder[0]!)
    expect((await send()).status).toBe(200)
    expect(h.deps.liveInteraction.ingest.mock.calls[0]).toEqual(h.deps.liveInteraction.ingest.mock.calls[1])
    expect((await send()).body.duplicate).toBe(true)
    expect(h.deps.liveInteraction.ingest).toHaveBeenCalledTimes(2)
  })

  it('persists a durable source gap after an ingestion failure without dropping the transcript', async () => {
    const { h, send } = await interactionHarness()
    h.deps.liveInteraction.ingest.mockRejectedValueOnce(new Error('transient'))
    const result = await send()
    expect(result.status).toBe(200)
    expect(result.body.interactionError).toBe(true)
    expect(h.deps.liveInteraction.ingest).toHaveBeenLastCalledWith(USER_ID, captureId,
      expect.objectContaining({ source: 'microphone', text: '', discontinuity: true }))
    expect(h.windowRows[0]?.lines).toEqual(result.body.lines)
  })

  it('lists a page’s windows for the live transcript pane', async () => {
    const h = harness()
    const page = await startLive(h)
    await chunkRequest(h, page, 'chunk-1', 0)
    await chunkRequest(h, page, 'chunk-2', 30_000)

    const response = await request(h.app)
      .get('/api/recordings/live/windows')
      .query({ workspaceId: WORKSPACE_ID, pageId: page.pageId })
    expect(response.status).toBe(200)
    expect(response.body.windows).toHaveLength(2)
    expect(response.body.windows[0]).toMatchObject({ chunkId: 'chunk-1', offsetMs: 0 })
    // The wire shape is the pane's contract — no audio keys leak.
    expect(response.body.windows[0].audioKey).toBeUndefined()
  })

  it('links a same-workspace recording to a page and rejects a foreign one', async () => {
    const h = harness()
    const page = await startLive(h)

    const linked = await request(h.app)
      .post('/api/recordings/live/link')
      .send({ pageId: page.pageId, recordingId: 'rec-1' })
    expect(linked.status).toBe(200)
    expect(h.update).toHaveBeenCalledWith(USER_ID, page.pageId, { linkedRecordingId: 'rec-1' })

    const foreign = await request(h.app)
      .post('/api/recordings/live/link')
      .send({ pageId: page.pageId, recordingId: 'rec-unknown' })
    expect(foreign.status).toBe(400)
  })

  it('finalizes stored windows into a recording and links the page', async () => {
    const h = harness()
    const page = await startLive(h)
    await chunkRequest(h, page, 'chunk-1', 0)
    await chunkRequest(h, page, 'chunk-2', 30_000)

    const response = await request(h.app)
      .post('/api/recordings/live/finalize')
      .send({
        workspaceId: WORKSPACE_ID,
        assistantId: 'assistant-1',
        sessionId: page.sessionId,
        pageId: page.pageId,
      })
    expect(response.status).toBe(201)
    expect(response.body).toMatchObject({
      recordingId: '00000000-0000-0000-0000-00000000e901',
      windowCount: 2,
      coverageMs: 60_000,
    })
    expect(h.concatWindows).toHaveBeenCalledOnce()
    expect(h.createEpisode).not.toHaveBeenCalled()
    expect(h.deps.filesApi.writeBytes).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID, userId: USER_ID }, expect.objectContaining({ mime: 'audio/mp4' }))
    expect(h.deps.createRecording).toHaveBeenCalledWith(expect.objectContaining({ kind: 'meeting' }), expect.objectContaining({ actorUserId: USER_ID }))
    expect(h.deps.updateRecording).not.toHaveBeenCalled()
    expect(h.update).toHaveBeenCalledWith(USER_ID, page.pageId, {
      linkedRecordingId: '00000000-0000-0000-0000-00000000e901',
    })
  })

  it.each(['tools', 'publication', 'adoption'])('preserves source audio after %s failure', async failure => {
    const h = harness()
    const page = await startLive(h)
    await chunkRequest(h, page, 'chunk-1', 0)
    if (failure === 'tools') h.concatWindows.mockRejectedValueOnce(new Error('ffmpeg prerequisite failed: spawn ffmpeg ENOENT'))
    if (failure === 'publication') h.deps.filesApi.writeBytes.mockResolvedValueOnce({ ok: false, error: { kind: 'quota_exceeded' } } as never)
    if (failure === 'adoption') h.deps.captureParent.mockRejectedValueOnce(new Error('recording_intake_source_changed'))
    const response = await request(h.app).post('/api/recordings/live/finalize').send({ workspaceId: WORKSPACE_ID, assistantId: 'a', sessionId: page.sessionId })
    expect(response.status).toBe(503)
    expect(response.body.error).toBe(failure === 'tools' ? 'recording_media_tools_unavailable' : 'recording_upload_preparation_failed')
    expect(h.gcs.deleteBlob).not.toHaveBeenCalled()
    expect(h.liveWindows.clearAudio).not.toHaveBeenCalled()
    expect(h.blobs.size).toBe(1)
  })

  it('409s a finalize with no stored windows', async () => {
    const h = harness()
    const response = await request(h.app)
      .post('/api/recordings/live/finalize')
      .send({ workspaceId: WORKSPACE_ID, assistantId: 'assistant-1', sessionId: 'nope' })
    expect(response.status).toBe(409)
    expect(response.body.error).toBe('no_stored_windows')
  })
})

describe('[COMP:recordings/live-page-route] parseTranscriptLines', () => {
  it('splits Speaker N labels and leaves other prefixes in the text', () => {
    expect(parseTranscriptLines('Speaker 1: hello\nNote: not a speaker\nspeaker 2: hi')).toEqual([
      { speaker: 'Speaker 1', text: 'hello' },
      { speaker: null, text: 'Note: not a speaker' },
      { speaker: 'Speaker 2', text: 'hi' },
    ])
  })

  it('drops empty lines and unwraps markdown bold labels', () => {
    expect(parseTranscriptLines('**Speaker 1: hey**\n\n  \n plain')).toEqual([
      { speaker: 'Speaker 1', text: 'hey' },
      { speaker: null, text: 'plain' },
    ])
  })

  it('replaces a speaker placeholder throughout the window when the transcript identifies a name', () => {
    expect(parseTranscriptLines([
      'Speaker 4: Before the introduction.',
      'Speaker 2: Sorry, what was your name?',
      'Speaker 4 (Holly): You can call me Holly.',
      'Speaker 4: Yes.',
    ].join('\n'))).toEqual([
      { speaker: 'Holly', text: 'Before the introduction.' },
      { speaker: 'Speaker 2', text: 'Sorry, what was your name?' },
      { speaker: 'Holly', text: 'You can call me Holly.' },
      { speaker: 'Holly', text: 'Yes.' },
    ])
  })

  it('supports full-width name qualifiers and keeps conflicting identities as placeholders', () => {
    expect(parseTranscriptLines([
      'Speaker 1（小莉）：你可以叫我小莉。',
      'Speaker 1: 你好。',
      'Speaker 2 (Alex): Hello.',
      'Speaker 2 (Sam): Sorry, that was wrong.',
    ].join('\n'))).toEqual([
      { speaker: '小莉', text: '你可以叫我小莉。' },
      { speaker: '小莉', text: '你好。' },
      { speaker: 'Speaker 2', text: 'Hello.' },
      { speaker: 'Speaker 2', text: 'Sorry, that was wrong.' },
    ])
  })
})

describe('[COMP:recordings/live-page-route] notesRegionOps', () => {
  const page: Page = {
    blocks: [
      { id: 'h', kind: 'heading', level: 2, text: 'Meeting notes' },
      { id: 'old-1', kind: 'text', text: 'old' },
      { id: 'old-2', kind: 'text', text: 'older' },
      { id: 'live:m', kind: 'text', variant: 'caption', text: 'marker' },
      { id: 'tail', kind: 'text', text: 'user content' },
    ],
  }

  it('replaces exactly the region between heading and marker', () => {
    const ops = notesRegionOps(page, 'h', 'live:m', [
      { id: 'n1', kind: 'heading', level: 3, text: 'Decisions' },
      { id: 'n2', kind: 'bulleted_list_item' },
    ])!
    const next = applyOps(page, ops).page
    expect(next.blocks.map((b) => b.id)).toEqual(['h', 'n1', 'n2', 'live:m', 'tail'])
  })

  it('returns null when an anchor is missing or out of order', () => {
    expect(notesRegionOps(page, 'missing', 'live:m', [])).toBeNull()
    expect(notesRegionOps(page, 'live:m', 'h', [])).toBeNull()
  })
})
