/**
 * Route tests for the skill support-file bundle
 * (`GET/PUT/DELETE /api/skills/:id/files`).
 *
 * These routes are the human half of `workspace_skill_files`: before them the
 * rows were write-once at import, so the background curator's
 * `add_support_file` could attach a file the owning user could never see,
 * edit, or delete.
 *
 * Component tag: [COMP:api/skill-support-files]; spec:
 * docs/architecture/engine/skill-system.md → "Support files".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'
import { skillRoutes } from '../skills.js'
import { IMPORT_MAX_SUPPORT_FILES } from '../../skills/import-service.js'

const skillStore = {
  listPublished: vi.fn(),
  listStarred: vi.fn(),
  listOwned: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  publish: vi.fn(),
  unpublish: vi.fn(),
  star: vi.fn(),
  unstar: vi.fn(),
  getBySlug: vi.fn(),
}

const workspaceStore = { getRole: vi.fn() }
const workspaceSkillStore = { getByIdSystem: vi.fn() }
const workspaceSkillFilesStore = { list: vi.fn(), upsert: vi.fn(), delete: vi.fn() }

function filesApp(extra: Record<string, unknown> = {}) {
  return createTestApp(
    '/api/skills',
    skillRoutes({
      skillStore: skillStore as never,
      workspaceStore: workspaceStore as never,
      workspaceSkillStore: workspaceSkillStore as never,
      workspaceSkillFilesStore: workspaceSkillFilesStore as never,
      ...extra,
    } as never),
    { userId: 'u-1' },
  )
}

function fileRow(over: Record<string, unknown> = {}) {
  return {
    id: 'f-1',
    workspaceSkillId: 's-1',
    kind: 'reference',
    name: 'tone.md',
    content: 'Write plainly.',
    description: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  workspaceStore.getRole.mockResolvedValue('member')
  workspaceSkillStore.getByIdSystem.mockResolvedValue({ rowId: 's-1', workspaceId: 'w-1' })
  workspaceSkillFilesStore.list.mockResolvedValue([])
})

describe('[COMP:api/skill-support-files] GET /api/skills/:id/files', () => {
  it('lists the bundle, including files only the curator wrote', async () => {
    workspaceSkillFilesStore.list.mockResolvedValue([
      fileRow(),
      fileRow({ kind: 'template', name: 'weekly.md', content: '# Week', description: 'starter' }),
    ])

    const res = await request(filesApp()).get('/api/skills/s-1/files')

    expect(res.status).toBe(200)
    expect(res.body.files).toEqual([
      {
        kind: 'reference',
        name: 'tone.md',
        content: 'Write plainly.',
        description: null,
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
      {
        kind: 'template',
        name: 'weekly.md',
        content: '# Week',
        description: 'starter',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    ])
    expect(workspaceSkillFilesStore.list).toHaveBeenCalledWith('s-1', { actingUserId: 'u-1' })
  })

  it('404s a skill in a workspace the caller is not a member of', async () => {
    workspaceStore.getRole.mockResolvedValue(null)
    const res = await request(filesApp()).get('/api/skills/s-1/files')
    expect(res.status).toBe(404)
    expect(workspaceSkillFilesStore.list).not.toHaveBeenCalled()
  })

  it('404s a skill that does not exist', async () => {
    workspaceSkillStore.getByIdSystem.mockResolvedValue(null)
    const res = await request(filesApp()).get('/api/skills/nope/files')
    expect(res.status).toBe(404)
  })

  it('501s when the deployment has no files store', async () => {
    const res = await request(filesApp({ workspaceSkillFilesStore: undefined })).get(
      '/api/skills/s-1/files',
    )
    expect(res.status).toBe(501)
  })
})

describe('[COMP:api/skill-support-files] PUT /api/skills/:id/files', () => {
  it('creates a file with 201 and echoes the stored row', async () => {
    workspaceSkillFilesStore.upsert.mockResolvedValue(fileRow())

    const res = await request(filesApp())
      .put('/api/skills/s-1/files')
      .send({ kind: 'reference', name: 'tone.md', content: 'Write plainly.' })

    expect(res.status).toBe(201)
    expect(res.body.file).toMatchObject({ kind: 'reference', name: 'tone.md' })
    expect(workspaceSkillFilesStore.upsert).toHaveBeenCalledWith('u-1', expect.objectContaining({
      workspaceSkillId: 's-1',
      kind: 'reference',
      name: 'tone.md',
      content: 'Write plainly.',
      description: null,
      path: null,
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }))
  })

  it('answers 200 when replacing an existing (kind, name)', async () => {
    workspaceSkillFilesStore.list.mockResolvedValue([fileRow()])
    workspaceSkillFilesStore.upsert.mockResolvedValue(fileRow({ content: 'Write very plainly.' }))

    const res = await request(filesApp())
      .put('/api/skills/s-1/files')
      .send({ kind: 'reference', name: 'tone.md', content: 'Write very plainly.' })

    expect(res.status).toBe(200)
  })

  it('400s an invalid kind, a pointer-breaking name, and empty content', async () => {
    const app = filesApp()
    for (const body of [
      { kind: 'binary', name: 'logo.png', content: 'x' },
      { kind: 'reference', name: 'to{ne}.md', content: 'x' },
      { kind: 'reference', name: 'tone.md', content: '' },
    ]) {
      const res = await request(app).put('/api/skills/s-1/files').send(body)
      expect(res.status).toBe(400)
    }
    expect(workspaceSkillFilesStore.upsert).not.toHaveBeenCalled()
  })

  // The curator's `add_support_file` bypasses this validator and POINTER_RE
  // allows slashes, so a path-like name must round-trip rather than 400 the
  // first time a human edits the file.
  it('accepts a path-like name the curator could have written', async () => {
    workspaceSkillFilesStore.upsert.mockResolvedValue(fileRow({ name: 'a/b.md' }))
    const res = await request(filesApp())
      .put('/api/skills/s-1/files')
      .send({ kind: 'reference', name: 'a/b.md', content: 'x' })
    expect(res.status).toBe(201)
  })

  // The count cap is a property of the resulting SET, so a replace must stay
  // legal at the cap while a genuinely new file is refused.
  it('enforces the count cap against the resulting set, not the request', async () => {
    const atCap = Array.from({ length: IMPORT_MAX_SUPPORT_FILES }, (_, i) =>
      fileRow({ name: `f${i}.md` }),
    )
    workspaceSkillFilesStore.list.mockResolvedValue(atCap)
    workspaceSkillFilesStore.upsert.mockResolvedValue(fileRow({ name: 'f0.md' }))

    const replace = await request(filesApp())
      .put('/api/skills/s-1/files')
      .send({ kind: 'reference', name: 'f0.md', content: 'replaced' })
    expect(replace.status).toBe(200)

    const added = await request(filesApp())
      .put('/api/skills/s-1/files')
      .send({ kind: 'reference', name: 'brand-new.md', content: 'nope' })
    expect(added.status).toBe(400)
  })

  it('404s a non-member before touching the store', async () => {
    workspaceStore.getRole.mockResolvedValue(null)
    const res = await request(filesApp())
      .put('/api/skills/s-1/files')
      .send({ kind: 'reference', name: 'tone.md', content: 'x' })
    expect(res.status).toBe(404)
    expect(workspaceSkillFilesStore.upsert).not.toHaveBeenCalled()
  })
})

describe('[COMP:api/skill-support-files] DELETE /api/skills/:id/files', () => {
  it('deletes by kind + name', async () => {
    workspaceSkillFilesStore.delete.mockResolvedValue(true)
    const res = await request(filesApp()).delete(
      '/api/skills/s-1/files?kind=reference&name=tone.md',
    )
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ deleted: true })
    expect(workspaceSkillFilesStore.delete).toHaveBeenCalledWith(
      'u-1',
      's-1',
      'reference',
      'tone.md',
    )
  })

  it('404s an unknown file and 400s a missing or bad selector', async () => {
    workspaceSkillFilesStore.delete.mockResolvedValue(false)
    const missing = await request(filesApp()).delete(
      '/api/skills/s-1/files?kind=reference&name=ghost.md',
    )
    expect(missing.status).toBe(404)

    const noSelector = await request(filesApp()).delete('/api/skills/s-1/files')
    expect(noSelector.status).toBe(400)

    const badKind = await request(filesApp()).delete('/api/skills/s-1/files?kind=binary&name=a.png')
    expect(badKind.status).toBe(400)
  })

  it('404s a non-member', async () => {
    workspaceStore.getRole.mockResolvedValue(null)
    const res = await request(filesApp()).delete('/api/skills/s-1/files?kind=reference&name=t.md')
    expect(res.status).toBe(404)
    expect(workspaceSkillFilesStore.delete).not.toHaveBeenCalled()
  })
})
