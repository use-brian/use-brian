import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { applyOps, type Page, type SavedView } from '@use-brian/core'
import { recordingLiveRoutes } from '../recording-live.js'

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

function harness(options: { role?: string | null; enabled?: boolean } = {}) {
  const pages = new Map<string, Page>()
  const views = new Map<string, SavedView>()
  const createDraft = vi.fn(async (input: { page: Page; workspaceId: string; name: string }) => {
    const created = view('page-new', input.page, input.workspaceId)
    created.name = input.name
    pages.set(created.id, input.page)
    views.set(created.id, created)
    return created
  })
  const updatePage = vi.fn(async (_userId: string, pageId: string, page: Page) => {
    pages.set(pageId, page)
    return true
  })
  const transcribeWindow = vi.fn().mockResolvedValue({
    text: 'We agreed to ship Friday.',
    model: 'asr-test',
    usage: { inputTokens: 2, outputTokens: 6 },
  })
  const reviseNotes = vi.fn().mockResolvedValue({
    text: 'Decision: ship Friday.',
    model: 'background-test',
    usage: { inputTokens: 12, outputTokens: 5 },
  })
  const recordUsage = vi.fn().mockResolvedValue(undefined)
  const deps = {
    getRole: vi.fn().mockResolvedValue('role' in options ? options.role : 'member'),
    savedViewStore: {
      createDraft,
      getById: vi.fn(async (_userId: string, id: string) => views.get(id) ?? null),
      getPage: vi.fn(async (_userId: string, id: string) => pages.get(id) ?? null),
      updatePage,
    },
    provider: { name: 'test', models: [], stream: vi.fn(), createSession: vi.fn() },
    backgroundModel: 'background-test',
    voiceTranscription: { enabled: options.enabled ?? true, apiKey: '' },
    usageStore: { recordUsage },
    transcribeWindow,
    reviseNotes,
  }
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as typeof req & { userId: string }).userId = USER_ID
    next()
  })
  app.use('/api/recordings', recordingLiveRoutes(deps as never))
  return { app, pages, views, createDraft, updatePage, transcribeWindow, reviseNotes, recordUsage }
}

describe('[COMP:recordings/live-page-route]', () => {
  it('creates a saved meeting page under the selected parent', async () => {
    const h = harness()
    h.views.set('parent', view('parent', { blocks: [] }))
    h.pages.set('parent', { blocks: [] })

    const response = await request(h.app)
      .post('/api/recordings/live/start')
      .send({ workspaceId: WORKSPACE_ID, destination: 'new', parentPageId: 'parent', title: 'Weekly sync' })

    expect(response.status).toBe(201)
    expect(response.body).toMatchObject({ pageId: 'page-new', title: 'Weekly sync' })
    expect(response.body.notesBlockId).toEqual(expect.any(String))
    expect(response.body.transcriptAfterId).toEqual(expect.any(String))
    expect(h.createDraft).toHaveBeenCalledWith(expect.objectContaining({
      state: 'saved',
      nestParentId: 'parent',
      name: 'Weekly sync',
    }))
  })

  it('appends a transcript window and replaces rolling notes atomically', async () => {
    const h = harness()
    const started = await request(h.app)
      .post('/api/recordings/live/start')
      .send({ workspaceId: WORKSPACE_ID, destination: 'new', title: 'Weekly sync' })

    const response = await request(h.app)
      .post('/api/recordings/live/chunk')
      .field('workspaceId', WORKSPACE_ID)
      .field('pageId', started.body.pageId)
      .field('assistantId', 'assistant-1')
      .field('notesBlockId', started.body.notesBlockId)
      .field('transcriptAfterId', started.body.transcriptAfterId)
      .field('chunkId', '00000000-0000-0000-0000-000000000099')
      .field('offsetMs', '30000')
      .field('durationMs', '30000')
      .attach('audio', Buffer.from('webm-window'), { filename: 'window.webm', contentType: 'audio/webm' })

    expect(response.status).toBe(200)
    expect(response.body.transcriptAfterId).toBe('00000000-0000-0000-0000-000000000099')
    const page = h.pages.get(started.body.pageId)!
    expect(page.blocks.find((block) => block.id === started.body.notesBlockId)).toMatchObject({
      kind: 'text',
      text: 'Decision: ship Friday.',
    })
    expect(page.blocks.find((block) => block.id === response.body.transcriptAfterId)).toMatchObject({
      kind: 'text',
      text: '[0:30] We agreed to ship Friday.',
    })
    expect(h.transcribeWindow).toHaveBeenCalledOnce()
    expect(h.reviseNotes).toHaveBeenCalledWith({
      previousNotes: '',
      transcript: 'We agreed to ship Friday.',
    })
    expect(h.recordUsage).toHaveBeenCalledTimes(2)
  })

  it('is idempotent when a client retries the same chunk id', async () => {
    const h = harness()
    const page: Page = {
      blocks: [
        { id: 'notes', kind: 'text', text: 'Existing notes' },
        { id: 'anchor', kind: 'text', text: 'Provisional' },
        { id: 'chunk-1', kind: 'text', text: '[0:00] Already here' },
      ],
    }
    h.pages.set('page-1', page)
    h.views.set('page-1', view('page-1', page))

    const response = await request(h.app)
      .post('/api/recordings/live/chunk')
      .field('workspaceId', WORKSPACE_ID)
      .field('pageId', 'page-1')
      .field('assistantId', 'assistant-1')
      .field('notesBlockId', 'notes')
      .field('transcriptAfterId', 'anchor')
      .field('chunkId', 'chunk-1')
      .field('offsetMs', '0')
      .field('durationMs', '30000')
      .attach('audio', Buffer.from('webm-window'), { filename: 'window.webm', contentType: 'audio/webm' })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ duplicate: true, transcriptAfterId: 'chunk-1' })
    expect(h.transcribeWindow).not.toHaveBeenCalled()
  })

  it('rejects live setup before page creation when transcription is disabled', async () => {
    const h = harness({ enabled: false })
    const response = await request(h.app)
      .post('/api/recordings/live/start')
      .send({ workspaceId: WORKSPACE_ID, destination: 'new' })
    expect(response.status).toBe(503)
    expect(h.createDraft).not.toHaveBeenCalled()
  })
})

