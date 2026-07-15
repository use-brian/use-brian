/**
 * Route tests for the skill-import endpoints (POST /api/skills/import + the
 * GitHub browse reads) and the create-route supportFiles/importSource
 * extension. Component tag: [COMP:api/skill-import]; spec:
 * docs/architecture/engine/skill-system.md → "Importing skills (GitHub / URL)".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'
import { skillRoutes } from '../skills.js'

const SKILL_MD = [
  '---',
  'name: Release Notes',
  'description: Drafts release notes from merged PRs.',
  '---',
  'Collect merged PRs, then draft the notes.',
].join('\n')

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
const workspaceSkillStore = { create: vi.fn() }
const workspaceSkillFilesStore = { upsert: vi.fn() }
const fetchRawImport = vi.fn()

function importApp(extra: Record<string, unknown> = {}) {
  return createTestApp(
    '/api/skills',
    skillRoutes({
      skillStore: skillStore as never,
      workspaceStore: workspaceStore as never,
      workspaceSkillStore: workspaceSkillStore as never,
      workspaceSkillFilesStore: workspaceSkillFilesStore as never,
      fetchRawImport: fetchRawImport as never,
      ...extra,
    } as never),
    { userId: 'u-1' },
  )
}

/** A full-enough workspace skill for projectWorkspaceSkill. */
function mockSkill() {
  return {
    rowId: 'ws-skill-1',
    slug: 'release-notes',
    name: 'Release Notes',
    description: 'Drafts release notes from merged PRs.',
    whenToUse: null,
    content: 'Collect merged PRs, then draft the notes.',
    workspaceId: 'w-1',
    state: 'active',
    confidence: 1,
    activatedAt: new Date(),
    inductionSource: 'authored',
    sensitivity: 'internal',
    sensitivityOverridden: false,
    originatingAssistantId: null,
    verifiedByUserId: 'u-1',
    verifiedAt: new Date(),
    rederivationCount: 0,
    requiresConnectors: [],
    blueprintId: null,
    lastInvokedAt: null,
    invocations: 0,
    succeeded: 0,
    userCorrectedAfter: 0,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  workspaceStore.getRole.mockResolvedValue('member')
  fetchRawImport.mockResolvedValue(SKILL_MD)
})

describe('[COMP:api/skill-import] POST /api/skills/import', () => {
  it('parses a URL import into a draft without writing anything', async () => {
    const res = await request(importApp())
      .post('/api/skills/import')
      .send({
        workspaceId: 'w-1',
        source: { kind: 'url', url: 'https://github.com/acme/skills/blob/main/SKILL.md' },
      })

    expect(res.status).toBe(200)
    expect(res.body.dialect).toBe('agent-skills')
    expect(res.body.draft.name).toBe('Release Notes')
    expect(res.body.warnings).toEqual([])
    expect(res.body.importSource).toMatchObject({ kind: 'url', owner: 'acme' })
    expect(workspaceSkillStore.create).not.toHaveBeenCalled()
    expect(fetchRawImport).toHaveBeenCalledWith(
      'https://raw.githubusercontent.com/acme/skills/main/SKILL.md',
    )
  })

  it('400s a disallowed host with the allowlist named', async () => {
    const res = await request(importApp())
      .post('/api/skills/import')
      .send({ workspaceId: 'w-1', source: { kind: 'url', url: 'https://evil.example.com/s.md' } })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('raw.githubusercontent.com')
    expect(fetchRawImport).not.toHaveBeenCalled()
  })

  it('gates on workspace membership (404 for non-members) and body shape (400)', async () => {
    workspaceStore.getRole.mockResolvedValue(null)
    const nonMember = await request(importApp())
      .post('/api/skills/import')
      .send({ workspaceId: 'w-9', source: { kind: 'url', url: 'https://github.com/a/b/blob/m/x.md' } })
    expect(nonMember.status).toBe(404)

    const badBody = await request(importApp()).post('/api/skills/import').send({ workspaceId: 'w-1' })
    expect(badBody.status).toBe(400)
  })

  it('github-source imports answer 503 when connector stores are not wired', async () => {
    const res = await request(importApp())
      .post('/api/skills/import')
      .send({
        workspaceId: 'w-1',
        source: { kind: 'github', connectorInstanceId: 'ci-1', owner: 'a', repo: 'b', path: 'SKILL.md' },
      })
    expect(res.status).toBe(503)
  })
})

describe('[COMP:api/skill-import] GitHub browse endpoints', () => {
  it('instances answers 409 when the workspace has no usable GitHub connector', async () => {
    const res = await request(importApp()).get(
      '/api/skills/import/github/instances?workspaceId=w-1',
    )
    expect(res.status).toBe(409)
  })

  it('repos + contents answer 503 without connector stores', async () => {
    const repos = await request(importApp()).get(
      '/api/skills/import/github/repos?workspaceId=w-1&connectorInstanceId=ci-1',
    )
    expect(repos.status).toBe(503)

    const contents = await request(importApp()).get(
      '/api/skills/import/github/contents?workspaceId=w-1&connectorInstanceId=ci-1&owner=a&repo=b',
    )
    expect(contents.status).toBe(503)
  })
})

describe('[COMP:api/skill-import] POST /api/skills — supportFiles + importSource extension', () => {
  it('writes support files through the files store and threads importSource to create', async () => {
    workspaceSkillStore.create.mockResolvedValue(mockSkill())
    workspaceSkillFilesStore.upsert.mockResolvedValue({})

    const res = await request(importApp())
      .post('/api/skills')
      .send({
        workspaceId: 'w-1',
        name: 'Release Notes',
        content: 'Collect merged PRs.\n\n## Imported support files\n\n- {{reference:style.md}}',
        supportFiles: [{ kind: 'reference', name: 'style.md', content: 'House style.' }],
        importSource: { kind: 'github', owner: 'acme', repo: 'skills', path: 'notes' },
      })

    expect(res.status).toBe(201)
    expect(workspaceSkillStore.create).toHaveBeenCalledWith(
      'u-1',
      'w-1',
      expect.objectContaining({
        importSource: expect.objectContaining({ kind: 'github', owner: 'acme' }),
      }),
    )
    expect(workspaceSkillFilesStore.upsert).toHaveBeenCalledWith('u-1', {
      workspaceSkillId: 'ws-skill-1',
      kind: 'reference',
      name: 'style.md',
      content: 'House style.',
      description: null,
    })
  })

  it('rejects malformed support files and non-object importSource', async () => {
    const badKind = await request(importApp())
      .post('/api/skills')
      .send({
        workspaceId: 'w-1', name: 'X', content: 'y',
        supportFiles: [{ kind: 'binary', name: 'a', content: 'b' }],
      })
    expect(badKind.status).toBe(400)

    const dupe = await request(importApp())
      .post('/api/skills')
      .send({
        workspaceId: 'w-1', name: 'X', content: 'y',
        supportFiles: [
          { kind: 'reference', name: 'a.md', content: 'b' },
          { kind: 'reference', name: 'a.md', content: 'c' },
        ],
      })
    expect(dupe.status).toBe(400)

    const badSource = await request(importApp())
      .post('/api/skills')
      .send({ workspaceId: 'w-1', name: 'X', content: 'y', importSource: 'github' })
    expect(badSource.status).toBe(400)
    expect(workspaceSkillStore.create).not.toHaveBeenCalled()
  })
})
