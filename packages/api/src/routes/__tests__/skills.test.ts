/**
 * Unit tests for the skill management routes.
 * Component tag: [COMP:api/skills-route].
 *
 * Mocks `loadBuiltinSkills` and mounts skillRoutes() with an injected
 * mock store. Verifies GET /catalog (builtin + community + user-
 * published merge, registry-id dedup, starred flag, graceful degrade
 * when the skills table is absent), GET /mine, the POST / create
 * validation ladder + slug generation + 23505→409, and the PATCH /
 * DELETE / publish 404-on-miss paths.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'

vi.mock('@sidanclaw/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sidanclaw/core')>()
  return {
    loadBuiltinSkills: vi.fn(() => [
      { id: 'builtin-1', name: 'Built In', description: 'b', category: 'general', source: 'builtin' },
    ]),
    // routes/skills.ts constructs the POST /draft limiter at mount time.
    createRateLimiter: vi.fn(() => ({ check: () => true })),
    // draft-generator imports these; the draft path itself is tested without
    // this mock in skills-draft.test.ts.
    collectStream: vi.fn(),
    // draft-generator builds its reply schema from the real blueprint
    // extraction-spec shape at module load — a zod schema, keep it real.
    extractionSpecSchema: actual.extractionSpecSchema,
  }
})

import { skillRoutes } from '../skills.js'

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
}

const workspaceSkillStore = {
  listForWorkspace: vi.fn(),
  confirmSkill: vi.fn(),
  create: vi.fn(),
  getByIdSystem: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  publish: vi.fn(),
  unpublish: vi.fn(),
}

const workspaceStore = {
  getRole: vi.fn(),
}

const enablementStore = {
  listForSkill: vi.fn(),
  listForSkillIds: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
}

const listWorkspaceAssistants = vi.fn()

/** A complete WorkspaceSkill row fixture for the governance projection. */
function wsSkill(overrides: Record<string, unknown> = {}) {
  return {
    rowId: 'row-1',
    id: 'ship-it',
    workspaceId: 'w-1',
    slug: 'ship-it',
    name: 'Ship It',
    description: 'how we ship',
    whenToUse: 'when shipping',
    content: '# body',
    category: 'custom',
    requiresConnectors: [],
    source: 'user',
    state: 'active',
    confidence: 1,
    activatedAt: new Date('2026-06-01T00:00:00.000Z'),
    inductionSource: 'authored',
    sensitivity: 'internal',
    sensitivityOverridden: false,
    originatingAssistantId: null,
    verifiedByUserId: null,
    verifiedAt: undefined,
    rederivationCount: 0,
    lastInvokedAt: undefined,
    invocations: 0,
    succeeded: 0,
    userCorrectedAfter: 0,
    ...overrides,
  }
}

function app() {
  return createTestApp('/api/skills', skillRoutes({ skillStore: skillStore as never }), {
    userId: 'u-1',
  })
}

function noAuthApp() {
  return createTestApp('/api/skills', skillRoutes({ skillStore: skillStore as never }))
}

/** App wired with the V2 workspace-aware stores (Brain procedural surface). */
function wsApp() {
  return createTestApp(
    '/api/skills',
    skillRoutes({
      skillStore: skillStore as never,
      workspaceSkillStore: workspaceSkillStore as never,
      workspaceStore: workspaceStore as never,
    }),
    { userId: 'u-1' },
  )
}

/** App wired with EVERY store — the access endpoints + the D4 create branch
 *  (brain-skill-management plan §4). */
function fullApp() {
  return createTestApp(
    '/api/skills',
    skillRoutes({
      skillStore: skillStore as never,
      workspaceSkillStore: workspaceSkillStore as never,
      workspaceStore: workspaceStore as never,
      workspaceSkillEnablementStore: enablementStore as never,
      listWorkspaceAssistants,
    }),
    { userId: 'u-1' },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('[COMP:api/skills-route] GET /catalog', () => {
  it('merges builtin + user-published skills, dedups registry ids, applies starred', async () => {
    skillStore.listPublished.mockResolvedValueOnce([
      { id: 'pub-1', name: 'Published' },
      { id: 'builtin-1', name: 'Dup of builtin' }, // collides with a builtin → dropped
    ])
    skillStore.listStarred.mockResolvedValueOnce(['pub-1'])
    const res = await request(app()).get('/api/skills/catalog')
    expect(res.status).toBe(200)
    const ids = res.body.skills.map((s: { id: string }) => s.id)
    expect(ids).toEqual(['builtin-1', 'pub-1']) // dup dropped, builtin kept
    const pub = res.body.skills.find((s: { id: string }) => s.id === 'pub-1')
    expect(pub.starred).toBe(true)
  })

  it('degrades gracefully to builtin skills when the skills table is absent', async () => {
    skillStore.listPublished.mockRejectedValueOnce(new Error('relation "skills" does not exist'))
    skillStore.listStarred.mockRejectedValueOnce(new Error('relation "skills" does not exist'))
    const res = await request(app()).get('/api/skills/catalog')
    expect(res.status).toBe(200)
    expect(res.body.skills.map((s: { id: string }) => s.id)).toEqual(['builtin-1'])
  })
})

describe('[COMP:api/skills-route] GET /mine', () => {
  it('rejects an unauthenticated request with 401', async () => {
    expect((await request(noAuthApp()).get('/api/skills/mine')).status).toBe(401)
  })

  it('returns the owned skills with a starred flag', async () => {
    skillStore.listOwned.mockResolvedValueOnce([{ id: 's-1' }])
    skillStore.listStarred.mockResolvedValueOnce(['s-1'])
    const res = await request(app()).get('/api/skills/mine')
    expect(res.body.skills[0]).toEqual({ id: 's-1', starred: true })
  })

  it('returns an empty list when the skills table is missing', async () => {
    skillStore.listOwned.mockRejectedValueOnce(new Error('no table'))
    const res = await request(app()).get('/api/skills/mine')
    expect(res.body).toEqual({ skills: [] })
  })
})

describe('[COMP:api/skills-route] POST /', () => {
  it('rejects a request with no name', async () => {
    const res = await request(app()).post('/api/skills').send({ content: 'body' })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('Name')
  })

  it('rejects a request with no content', async () => {
    const res = await request(app()).post('/api/skills').send({ name: 'Skill' })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('Content')
  })

  it('creates a skill (201) and derives a slug from the name', async () => {
    skillStore.create.mockResolvedValueOnce({ id: 's-new', slug: 'my-cool-skill' })
    const res = await request(app())
      .post('/api/skills')
      .send({ name: 'My Cool Skill!', content: 'do the thing' })
    expect(res.status).toBe(201)
    expect(skillStore.create).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({ slug: 'my-cool-skill', name: 'My Cool Skill!' }),
    )
  })

  it('maps a unique-violation (23505) to a 409', async () => {
    skillStore.create.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }))
    const res = await request(app())
      .post('/api/skills')
      .send({ name: 'Taken', content: 'body' })
    expect(res.status).toBe(409)
  })
})

describe('[COMP:api/skills-route] PATCH / DELETE / publish', () => {
  it('PATCH /:id returns 404 when the skill is not found', async () => {
    skillStore.update.mockResolvedValueOnce(null)
    const res = await request(app()).patch('/api/skills/s-x').send({ name: 'Renamed' })
    expect(res.status).toBe(404)
  })

  it('PATCH /:id rejects an empty-string name with 400', async () => {
    const res = await request(app()).patch('/api/skills/s-1').send({ name: '   ' })
    expect(res.status).toBe(400)
  })

  it('DELETE /:id returns 204 on success and 404 when nothing was removed', async () => {
    skillStore.delete.mockResolvedValueOnce(true)
    expect((await request(app()).delete('/api/skills/s-1')).status).toBe(204)
    skillStore.delete.mockResolvedValueOnce(false)
    expect((await request(app()).delete('/api/skills/ghost')).status).toBe(404)
  })

  it('POST /:id/publish returns 404 when the skill is not found', async () => {
    skillStore.publish.mockResolvedValueOnce(false)
    expect((await request(app()).post('/api/skills/s-x/publish')).status).toBe(404)
  })
})

describe('[COMP:api/skills-route] GET /workspace', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const noAuth = createTestApp(
      '/api/skills',
      skillRoutes({
        skillStore: skillStore as never,
        workspaceSkillStore: workspaceSkillStore as never,
        workspaceStore: workspaceStore as never,
      }),
    )
    expect((await request(noAuth).get('/api/skills/workspace?workspaceId=w-1')).status).toBe(401)
  })

  it('requires a workspaceId query param (400)', async () => {
    const res = await request(wsApp()).get('/api/skills/workspace')
    expect(res.status).toBe(400)
  })

  it('returns 404 when the caller is not a workspace member', async () => {
    workspaceStore.getRole.mockResolvedValueOnce(null)
    const res = await request(wsApp()).get('/api/skills/workspace?workspaceId=w-1')
    expect(res.status).toBe(404)
    expect(workspaceSkillStore.listForWorkspace).not.toHaveBeenCalled()
  })

  it('projects governance fields and filters out archived skills', async () => {
    workspaceStore.getRole.mockResolvedValueOnce('member')
    const activatedAt = new Date('2026-06-01T00:00:00.000Z')
    workspaceSkillStore.listForWorkspace.mockResolvedValueOnce([
      {
        rowId: 'row-1',
        slug: 'ship-it',
        name: 'Ship It',
        description: 'how we ship',
        whenToUse: 'when shipping',
        content: '# body',
        state: 'active',
        confidence: 1,
        activatedAt,
        inductionSource: 'authored',
        sensitivity: 'internal',
        originatingAssistantId: 'a-1',
        verifiedByUserId: 'u-9',
        requiresConnectors: ['github'],
      },
      { rowId: 'row-2', slug: 'old', name: 'Old', state: 'archived', requiresConnectors: [] },
    ])
    const res = await request(wsApp()).get('/api/skills/workspace?workspaceId=w-1')
    expect(res.status).toBe(200)
    expect(workspaceSkillStore.listForWorkspace).toHaveBeenCalledWith('w-1', { actingUserId: 'u-1' })
    expect(res.body.skills).toHaveLength(1)
    expect(res.body.skills[0]).toMatchObject({
      rowId: 'row-1',
      slug: 'ship-it',
      state: 'active',
      inductionSource: 'authored',
      sensitivity: 'internal',
      activatedAt: activatedAt.toISOString(),
    })
  })
})

describe('[COMP:api/skills-route] POST /:id/confirm', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const noAuth = createTestApp(
      '/api/skills',
      skillRoutes({
        skillStore: skillStore as never,
        workspaceSkillStore: workspaceSkillStore as never,
        workspaceStore: workspaceStore as never,
      }),
    )
    expect((await request(noAuth).post('/api/skills/row-1/confirm').send({ workspaceId: 'w-1' })).status).toBe(401)
  })

  it('requires a workspaceId (400)', async () => {
    const res = await request(wsApp()).post('/api/skills/row-1/confirm').send({})
    expect(res.status).toBe(400)
  })

  it('returns 404 when the caller is not a workspace member', async () => {
    workspaceStore.getRole.mockResolvedValueOnce(null)
    const res = await request(wsApp()).post('/api/skills/row-1/confirm').send({ workspaceId: 'w-1' })
    expect(res.status).toBe(404)
    expect(workspaceSkillStore.confirmSkill).not.toHaveBeenCalled()
  })

  it('confirms the skill with the acting user + workspace + row id', async () => {
    workspaceStore.getRole.mockResolvedValueOnce('member')
    workspaceSkillStore.confirmSkill.mockResolvedValueOnce(undefined)
    const res = await request(wsApp()).post('/api/skills/row-1/confirm').send({ workspaceId: 'w-1' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(workspaceSkillStore.confirmSkill).toHaveBeenCalledWith('u-1', 'w-1', 'row-1')
  })
})

describe('[COMP:api/skills-route] POST / — workspace-aware create + D4 enablement', () => {
  it('returns 404 when the caller is not a member of the target workspace', async () => {
    workspaceStore.getRole.mockResolvedValueOnce(null)
    const res = await request(fullApp())
      .post('/api/skills')
      .send({ name: 'Recap', content: '# body', workspaceId: 'w-1' })
    expect(res.status).toBe(404)
    expect(workspaceSkillStore.create).not.toHaveBeenCalled()
  })

  it('creates in the workspace and enables ALL assistants by default (D4)', async () => {
    workspaceStore.getRole.mockResolvedValueOnce('member')
    workspaceSkillStore.create.mockResolvedValueOnce(wsSkill({ rowId: 'row-9' }))
    listWorkspaceAssistants.mockResolvedValueOnce([
      { id: 'a-1', name: 'Gm' },
      { id: 'a-2', name: 'Doc' },
    ])
    const res = await request(fullApp())
      .post('/api/skills')
      .send({ name: 'Recap', content: '# body', workspaceId: 'w-1' })
    expect(res.status).toBe(201)
    expect(workspaceSkillStore.create).toHaveBeenCalledWith(
      'u-1',
      'w-1',
      expect.objectContaining({ slug: 'recap', name: 'Recap', content: '# body' }),
    )
    expect(enablementStore.enable).toHaveBeenCalledTimes(2)
    expect(enablementStore.enable).toHaveBeenCalledWith('row-9', 'a-1', 'u-1')
    expect(enablementStore.enable).toHaveBeenCalledWith('row-9', 'a-2', 'u-1')
    expect(res.body).toMatchObject({ rowId: 'row-9', enabledAssistantIds: ['a-1', 'a-2'] })
  })

  it('honors an explicit assistant subset and drops ids outside the workspace', async () => {
    workspaceStore.getRole.mockResolvedValueOnce('member')
    workspaceSkillStore.create.mockResolvedValueOnce(wsSkill({ rowId: 'row-9' }))
    listWorkspaceAssistants.mockResolvedValueOnce([
      { id: 'a-1', name: 'Gm' },
      { id: 'a-2', name: 'Doc' },
    ])
    const res = await request(fullApp())
      .post('/api/skills')
      .send({
        name: 'Recap',
        content: '# body',
        workspaceId: 'w-1',
        enabledAssistantIds: ['a-2', 'a-other-workspace'],
      })
    expect(res.status).toBe(201)
    expect(enablementStore.enable).toHaveBeenCalledTimes(1)
    expect(enablementStore.enable).toHaveBeenCalledWith('row-9', 'a-2', 'u-1')
    expect(res.body.enabledAssistantIds).toEqual(['a-2'])
  })

  it('passes a chosen sensitivity through to the store and rejects invalid values', async () => {
    const bad = await request(fullApp())
      .post('/api/skills')
      .send({ name: 'Recap', content: '# body', workspaceId: 'w-1', sensitivity: 'secret' })
    expect(bad.status).toBe(400)

    workspaceStore.getRole.mockResolvedValueOnce('member')
    workspaceSkillStore.create.mockResolvedValueOnce(wsSkill())
    listWorkspaceAssistants.mockResolvedValueOnce([])
    const res = await request(fullApp())
      .post('/api/skills')
      .send({ name: 'Recap', content: '# body', workspaceId: 'w-1', sensitivity: 'confidential' })
    expect(res.status).toBe(201)
    expect(workspaceSkillStore.create).toHaveBeenCalledWith(
      'u-1',
      'w-1',
      expect.objectContaining({ sensitivity: 'confidential' }),
    )
  })

  it('falls back to the legacy create when no workspaceId is sent', async () => {
    skillStore.create.mockResolvedValueOnce({ id: 'recap', name: 'Recap' })
    const res = await request(fullApp()).post('/api/skills').send({ name: 'Recap', content: '# body' })
    expect(res.status).toBe(201)
    expect(skillStore.create).toHaveBeenCalled()
    expect(workspaceSkillStore.create).not.toHaveBeenCalled()
    expect(enablementStore.enable).not.toHaveBeenCalled()
  })
})

describe('[COMP:api/skills-route] PATCH /:id — D2 trust + sensitivity', () => {
  it('rejects an invalid sensitivity (400)', async () => {
    const res = await request(app()).patch('/api/skills/s-1').send({ sensitivity: 'top-secret' })
    expect(res.status).toBe(400)
    expect(skillStore.update).not.toHaveBeenCalled()
  })

  it('passes sensitivity through to the store update', async () => {
    skillStore.update.mockResolvedValueOnce({ id: 's-1' })
    const res = await request(app())
      .patch('/api/skills/s-1')
      .send({ content: '# new body', sensitivity: 'public' })
    expect(res.status).toBe(200)
    expect(skillStore.update).toHaveBeenCalledWith(
      'u-1',
      's-1',
      expect.objectContaining({ content: '# new body', sensitivity: 'public' }),
    )
  })
})

// Regression for the fls.com.hk incident: a skill lives in a TEAM workspace
// that is not the editor's personal/primary workspace. The legacy userId-keyed
// store pinned resolvePrimaryWorkspace() (personal first), so the UPDATE/DELETE
// matched zero rows → 404 "Skill not found" and Delete silently no-op'd. When
// the workspace stores are injected the mutation routes must derive the
// workspace from the skill ROW (getByIdSystem) + gate on membership.
describe('[COMP:api/skills-route] PATCH / DELETE — workspace derived from the skill row', () => {
  it('PATCH updates in the SKILL workspace, not the caller primary workspace', async () => {
    workspaceSkillStore.getByIdSystem.mockResolvedValueOnce(
      wsSkill({ rowId: 'row-1', workspaceId: 'w-team' }),
    )
    workspaceStore.getRole.mockResolvedValueOnce('admin')
    workspaceSkillStore.update.mockResolvedValueOnce(
      wsSkill({ rowId: 'row-1', workspaceId: 'w-team' }),
    )
    const res = await request(wsApp())
      .patch('/api/skills/row-1')
      .send({ content: '# new body' })
    expect(res.status).toBe(200)
    expect(res.body.rowId).toBe('row-1')
    expect(workspaceSkillStore.update).toHaveBeenCalledWith(
      'u-1',
      'w-team',
      'row-1',
      expect.objectContaining({ content: '# new body' }),
    )
    // The legacy primary-workspace path must NOT be taken when ws stores exist.
    expect(skillStore.update).not.toHaveBeenCalled()
  })

  it('PATCH 404s on a missing row and on a non-member (never touches update)', async () => {
    workspaceSkillStore.getByIdSystem.mockResolvedValueOnce(null)
    const gone = await request(wsApp()).patch('/api/skills/ghost').send({ name: 'X' })
    expect(gone.status).toBe(404)

    workspaceSkillStore.getByIdSystem.mockResolvedValueOnce(wsSkill({ workspaceId: 'w-team' }))
    workspaceStore.getRole.mockResolvedValueOnce(null)
    const notMember = await request(wsApp()).patch('/api/skills/row-1').send({ name: 'X' })
    expect(notMember.status).toBe(404)

    expect(workspaceSkillStore.update).not.toHaveBeenCalled()
  })

  it('DELETE hard-deletes in the SKILL workspace (was a silent no-op before)', async () => {
    workspaceSkillStore.getByIdSystem.mockResolvedValueOnce(
      wsSkill({ rowId: 'row-1', workspaceId: 'w-team' }),
    )
    workspaceStore.getRole.mockResolvedValueOnce('admin')
    workspaceSkillStore.delete.mockResolvedValueOnce(true)
    const res = await request(wsApp()).delete('/api/skills/row-1')
    expect(res.status).toBe(204)
    expect(workspaceSkillStore.delete).toHaveBeenCalledWith('u-1', 'w-team', 'row-1')
    expect(skillStore.delete).not.toHaveBeenCalled()
  })
})

describe('[COMP:api/skills-route] GET/PUT /:id/access', () => {
  it('returns 501 when the access stores are not wired', async () => {
    expect((await request(wsApp()).get('/api/skills/row-1/access')).status).toBe(501)
    expect(
      (await request(wsApp()).put('/api/skills/row-1/access').send({ enabledAssistantIds: [] }))
        .status,
    ).toBe(501)
  })

  it('returns 404 for a missing skill or a non-member', async () => {
    workspaceSkillStore.getByIdSystem.mockResolvedValueOnce(null)
    expect((await request(fullApp()).get('/api/skills/row-x/access')).status).toBe(404)

    workspaceSkillStore.getByIdSystem.mockResolvedValueOnce(wsSkill())
    workspaceStore.getRole.mockResolvedValueOnce(null)
    expect((await request(fullApp()).get('/api/skills/row-1/access')).status).toBe(404)
  })

  it('GET merges workspace assistants with the enablement rows', async () => {
    workspaceSkillStore.getByIdSystem.mockResolvedValueOnce(wsSkill())
    workspaceStore.getRole.mockResolvedValueOnce('member')
    listWorkspaceAssistants.mockResolvedValueOnce([
      { id: 'a-1', name: 'Gm' },
      { id: 'a-2', name: 'Doc' },
    ])
    enablementStore.listForSkill.mockResolvedValueOnce([
      { workspaceSkillId: 'row-1', assistantId: 'a-2' },
    ])
    const res = await request(fullApp()).get('/api/skills/row-1/access')
    expect(res.status).toBe(200)
    expect(res.body.assistants).toEqual([
      { id: 'a-1', name: 'Gm', enabled: false },
      { id: 'a-2', name: 'Doc', enabled: true },
    ])
  })

  it('PUT applies the desired set: enables missing, disables removed, ignores foreign ids', async () => {
    workspaceSkillStore.getByIdSystem.mockResolvedValueOnce(wsSkill())
    workspaceStore.getRole.mockResolvedValueOnce('member')
    listWorkspaceAssistants.mockResolvedValueOnce([
      { id: 'a-1', name: 'Gm' },
      { id: 'a-2', name: 'Doc' },
      { id: 'a-3', name: 'Ops' },
    ])
    // currently enabled: a-1, a-2 → desired: a-2, a-3 (+ a foreign id, dropped)
    enablementStore.listForSkill.mockResolvedValueOnce([
      { workspaceSkillId: 'row-1', assistantId: 'a-1' },
      { workspaceSkillId: 'row-1', assistantId: 'a-2' },
    ])
    const res = await request(fullApp())
      .put('/api/skills/row-1/access')
      .send({ enabledAssistantIds: ['a-2', 'a-3', 'a-foreign'] })
    expect(res.status).toBe(200)
    expect(enablementStore.enable).toHaveBeenCalledTimes(1)
    expect(enablementStore.enable).toHaveBeenCalledWith('row-1', 'a-3', 'u-1')
    expect(enablementStore.disable).toHaveBeenCalledTimes(1)
    expect(enablementStore.disable).toHaveBeenCalledWith('row-1', 'a-1', 'u-1')
    expect(res.body.assistants).toEqual([
      { id: 'a-1', name: 'Gm', enabled: false },
      { id: 'a-2', name: 'Doc', enabled: true },
      { id: 'a-3', name: 'Ops', enabled: true },
    ])
  })

  it('PUT validates the body shape (400)', async () => {
    const res = await request(fullApp())
      .put('/api/skills/row-1/access')
      .send({ enabledAssistantIds: 'all' })
    expect(res.status).toBe(400)
  })
})

describe('[COMP:api/skills-route] GET /workspace — library projection', () => {
  it('projects library columns + enabledAssistantIds from the bulk enablement query', async () => {
    workspaceStore.getRole.mockResolvedValueOnce('member')
    const last = new Date('2026-06-09T10:00:00.000Z')
    workspaceSkillStore.listForWorkspace.mockResolvedValueOnce([
      wsSkill({
        rowId: 'row-1',
        lastInvokedAt: last,
        invocations: 7,
        succeeded: 6,
        userCorrectedAfter: 1,
        rederivationCount: 2,
        sensitivityOverridden: true,
      }),
    ])
    enablementStore.listForSkillIds.mockResolvedValueOnce([
      { workspaceSkillId: 'row-1', assistantId: 'a-1' },
      { workspaceSkillId: 'row-1', assistantId: 'a-2' },
    ])
    const res = await request(fullApp()).get('/api/skills/workspace?workspaceId=w-1')
    expect(res.status).toBe(200)
    expect(enablementStore.listForSkillIds).toHaveBeenCalledWith(['row-1'], { actingUserId: 'u-1' })
    expect(res.body.skills[0]).toMatchObject({
      rowId: 'row-1',
      enabledAssistantIds: ['a-1', 'a-2'],
      lastInvokedAt: last.toISOString(),
      invocations: 7,
      succeeded: 6,
      userCorrectedAfter: 1,
      rederivationCount: 2,
      sensitivityOverridden: true,
    })
  })
})
