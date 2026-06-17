/**
 * [COMP:api/views-import] + [COMP:api/views-export] — the doc format-conversion
 * routes: GET /views/:id/export and POST /workspaces/:wid/views/import.
 * Spec: docs/architecture/features/doc-conversion.md.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))

import { viewsRoutes } from '../views.js'
import type { Page, SavedView } from '@sidanclaw/core'

const WS = '00000000-0000-0000-0000-000000000010'
const UID = '00000000-0000-0000-0000-000000000020'

const SAMPLE_PAGE: Page = {
  blocks: [
    { kind: 'heading', id: 'h', level: 1, text: 'My Doc' },
    { kind: 'text', id: 't', text: 'Hello body' },
    { kind: 'bulleted_list_item', id: 'b', richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] } as never },
  ],
}

function fakeView(over: Partial<SavedView> = {}): SavedView {
  return {
    id: 'sv-1',
    workspaceId: WS,
    createdBy: UID,
    name: 'My Doc',
    nameOrigin: 'user',
    description: null,
    icon: null,
    entity: 'tasks',
    viewType: 'table',
    state: 'draft',
    binding: { entity: 'tasks', viewType: 'table' },
    page: SAMPLE_PAGE,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as unknown as SavedView
}

function makeApp(opts: {
  userId?: string | null
  role?: 'owner' | 'admin' | 'member' | null
  savedViewStore?: Record<string, unknown>
  docPageStore?: Record<string, unknown>
  ingestDocument?: ReturnType<typeof vi.fn>
}): express.Express {
  const role = 'role' in opts ? opts.role ?? null : 'member'
  const base = {
    savedViewStore: opts.savedViewStore ?? {},
    taskStore: {},
    crmStore: {},
    workflowRunStore: {},
    workspaceStore: { getRole: vi.fn().mockResolvedValue(role) },
    workspaceDirectory: {},
    softDeleteStore: {},
    ...(opts.docPageStore ? { docPageStore: opts.docPageStore } : {}),
    ...(opts.ingestDocument ? { ingestDocument: opts.ingestDocument } : {}),
  }
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    if (opts.userId !== null) (req as unknown as { userId: string }).userId = opts.userId ?? UID
    next()
  })
  app.use('/api', viewsRoutes(base as unknown as Parameters<typeof viewsRoutes>[0]))
  return app
}

beforeEach(() => vi.clearAllMocks())

describe('[COMP:api/views-export] GET /views/:id/export', () => {
  it('exports Markdown with a title and an attachment header', async () => {
    const getById = vi.fn().mockResolvedValue(fakeView())
    const app = makeApp({ savedViewStore: { getById } })
    const res = await request(app).get('/api/views/sv-1/export?format=md')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/markdown')
    expect(res.headers['content-disposition']).toContain('attachment')
    expect(res.text).toContain('# My Doc')
    expect(res.text).toContain('Hello body')
    expect(res.text).toContain('- one')
  })

  it('exports a .docx (PK-signed) with the OOXML content type', async () => {
    const getById = vi.fn().mockResolvedValue(fakeView())
    const app = makeApp({ savedViewStore: { getById } })
    const res = await request(app).get('/api/views/sv-1/export?format=docx').buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = []
      r.on('data', (c: Buffer) => chunks.push(c))
      r.on('end', () => cb(null, Buffer.concat(chunks)))
    })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('officedocument.wordprocessingml.document')
    expect((res.body as Buffer)[0]).toBe(0x50) // 'P'
    expect((res.body as Buffer)[1]).toBe(0x4b) // 'K'
  })

  it('rejects an unknown format', async () => {
    const getById = vi.fn().mockResolvedValue(fakeView())
    const app = makeApp({ savedViewStore: { getById } })
    const res = await request(app).get('/api/views/sv-1/export?format=pdf')
    expect(res.status).toBe(400)
  })

  it('prefers the live merged page from docPageStore', async () => {
    const getById = vi.fn().mockResolvedValue(fakeView())
    const getVersionedPage = vi.fn().mockResolvedValue({
      page: { blocks: [{ kind: 'text', id: 'x', text: 'Live edit' }] },
      version: 3,
      title: 'Live Title',
      nameOrigin: 'auto',
      icon: null,
    })
    const app = makeApp({ savedViewStore: { getById }, docPageStore: { getVersionedPage } })
    const res = await request(app).get('/api/views/sv-1/export?format=md')
    expect(res.text).toContain('# Live Title')
    expect(res.text).toContain('Live edit')
    expect(res.text).not.toContain('Hello body')
  })

  it('404s a missing view', async () => {
    const getById = vi.fn().mockResolvedValue(null)
    const app = makeApp({ savedViewStore: { getById } })
    const res = await request(app).get('/api/views/missing/export?format=md')
    expect(res.status).toBe(404)
  })
})

describe('[COMP:api/views-import] POST /workspaces/:wid/views/import', () => {
  it('imports a Markdown file into a new draft page', async () => {
    const createDraft = vi.fn().mockResolvedValue(fakeView({ id: 'new-page' }))
    const app = makeApp({ savedViewStore: { createDraft } })
    const res = await request(app)
      .post(`/api/workspaces/${WS}/views/import`)
      .field('target', 'page')
      .attach('file', Buffer.from('# Title\n\nA paragraph.\n\n- item'), 'report.md')
    expect(res.status).toBe(201)
    expect(res.body.pageId).toBe('new-page')
    expect(res.body.brainIngested).toBe(false)
    expect(createDraft).toHaveBeenCalledOnce()
    // Faithful import keeps the document's own name (frozen against auto-title).
    const arg = createDraft.mock.calls[0][0]
    expect(arg.name).toBe('report')
    expect(arg.nameOrigin).toBe('user')
    expect(arg.page.blocks.length).toBeGreaterThan(0)
  })

  it('rejects an unsupported file type', async () => {
    const app = makeApp({ savedViewStore: { createDraft: vi.fn() } })
    const res = await request(app)
      .post(`/api/workspaces/${WS}/views/import`)
      .attach('file', Buffer.from('binary'), 'photo.png')
    expect(res.status).toBe(400)
  })

  it('returns 503 for a brain-target import when ingest is not configured', async () => {
    const app = makeApp({ savedViewStore: { createDraft: vi.fn() } })
    const res = await request(app)
      .post(`/api/workspaces/${WS}/views/import`)
      .field('target', 'brain')
      .attach('file', Buffer.from('# Hi'), 'note.md')
    expect(res.status).toBe(503)
  })

  it('ingests to the brain and creates a page for target=both', async () => {
    const createDraft = vi.fn().mockResolvedValue(fakeView({ id: 'p2' }))
    const ingestDocument = vi.fn().mockResolvedValue(undefined)
    const app = makeApp({ savedViewStore: { createDraft }, ingestDocument })
    const res = await request(app)
      .post(`/api/workspaces/${WS}/views/import`)
      .field('target', 'both')
      .attach('file', Buffer.from('# Hi\n\nbody'), 'note.md')
    expect(res.status).toBe(201)
    expect(res.body.pageId).toBe('p2')
    expect(res.body.brainIngested).toBe(true)
    expect(ingestDocument).toHaveBeenCalledOnce()
    expect(ingestDocument.mock.calls[0][0].sourceLabel).toBe('note.md')
  })

  it('403s a non-member', async () => {
    const app = makeApp({ role: null, savedViewStore: { createDraft: vi.fn() } })
    const res = await request(app)
      .post(`/api/workspaces/${WS}/views/import`)
      .attach('file', Buffer.from('# Hi'), 'note.md')
    expect(res.status).toBe(403)
  })
})
