/**
 * Route tests for bulk group suggestion
 * (`POST /api/skills/categorize` + `/categorize/apply`).
 *
 * The split is the design: suggest PROPOSES and writes nothing, apply takes
 * the explicit assignments the user reviewed. These tests pin that split, and
 * pin that apply sends only `category` — a metadata-only update, so a bulk
 * re-file cannot carry the D2 trust stamp and silently activate every
 * Suggested skill it touches.
 *
 * Component tag: [COMP:api/skill-categorize]; spec:
 * docs/architecture/engine/skill-system.md → "Suggesting groups".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'
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
  getBySlug: vi.fn(),
}

const workspaceStore = { getRole: vi.fn() }
const workspaceSkillStore = { listForWorkspace: vi.fn(), update: vi.fn(), getByIdSystem: vi.fn() }

/** The slice of the stream options these tests read back. */
type StreamOpts = { messages: Array<{ role: string; content: string }> }

/** Stream stub in the provider's shape — one text block, then done. */
function providerReturning(text: string) {
  return {
    name: 'stub',
    models: ['standard'],
    createSession: vi.fn(),
    stream: vi.fn(async function* (_opts: StreamOpts) {
      yield { type: 'text_delta', text }
      yield {
        type: 'turn_complete',
        response: {
          content: [{ type: 'text', text }],
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
          model: 'standard',
        },
      }
    }),
  }
}

function categorizeApp(extra: Record<string, unknown> = {}) {
  return createTestApp(
    '/api/skills',
    skillRoutes({
      skillStore: skillStore as never,
      workspaceStore: workspaceStore as never,
      workspaceSkillStore: workspaceSkillStore as never,
      getWorkspacePlan: async () => 'pro',
      checkUsageBudget: async () => ({ status: 'ok' as const }),
      ...extra,
    } as never),
    { userId: 'u-1' },
  )
}

function wsSkill(over: Record<string, unknown> = {}) {
  return {
    rowId: 'a',
    name: 'Weekly status',
    description: 'How we write the weekly update',
    whenToUse: 'On Fridays',
    category: 'custom',
    state: 'active',
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  workspaceStore.getRole.mockResolvedValue('member')
  workspaceSkillStore.listForWorkspace.mockResolvedValue([wsSkill()])
  workspaceSkillStore.update.mockImplementation(async () => ({ rowId: 'a' }))
})

describe('[COMP:api/skill-categorize] POST /api/skills/categorize', () => {
  it('suggests a group per unsorted skill and writes nothing', async () => {
    const draftProvider = providerReturning('[{"i":1,"category":"communication","why":"writes an update"}]')

    const res = await request(categorizeApp({ draftProvider }))
      .post('/api/skills/categorize')
      .send({ workspaceId: 'w-1' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      considered: 1,
      suggestions: [
        {
          skillRowId: 'a',
          name: 'Weekly status',
          current: 'custom',
          suggested: 'communication',
          rationale: 'writes an update',
        },
      ],
    })
    expect(workspaceSkillStore.update).not.toHaveBeenCalled()
  })

  it('uses the workspace runtime without calling the platform provider', async () => {
    const draftProvider = providerReturning('[]')
    const customProvider = providerReturning('[{"i":1,"category":"communication"}]')
    const resolveWorkspaceCustomLlm = vi.fn().mockResolvedValue({
      provider: customProvider,
      selector: 'custom:profile-1',
    })
    const res = await request(categorizeApp({ draftProvider, resolveWorkspaceCustomLlm }))
      .post('/api/skills/categorize')
      .send({ workspaceId: 'w-1' })
    expect(res.status).toBe(200)
    expect(resolveWorkspaceCustomLlm).toHaveBeenCalledWith({ workspaceId: 'w-1', requestedTier: 'standard' })
    expect(draftProvider.stream).not.toHaveBeenCalled()
    expect(customProvider.stream).toHaveBeenCalledWith(expect.objectContaining({ model: 'custom:profile-1' }))
  })

  // Only the `custom` sink is in scope — a deliberate category is not
  // re-decided in bulk.
  it('leaves already-grouped and archived skills out of the batch', async () => {
    const draftProvider = providerReturning('[]')
    workspaceSkillStore.listForWorkspace.mockResolvedValue([
      wsSkill({ rowId: 'a', name: 'Already grouped', category: 'research' }),
      wsSkill({ rowId: 'b', name: 'Archived one', category: 'custom', state: 'archived' }),
      wsSkill({ rowId: 'c', name: 'Still unsorted', category: 'custom' }),
    ])

    const res = await request(categorizeApp({ draftProvider })).post('/api/skills/categorize').send({
      workspaceId: 'w-1',
    })

    expect(res.status).toBe(200)
    expect(res.body.considered).toBe(1)
    const prompt = draftProvider.stream.mock.calls[0]![0].messages[0]!.content
    expect(prompt).toContain('Still unsorted')
    expect(prompt).not.toContain('Already grouped')
    expect(prompt).not.toContain('Archived one')
  })

  it('short-circuits with no model call when nothing is unsorted', async () => {
    const draftProvider = providerReturning('[]')
    workspaceSkillStore.listForWorkspace.mockResolvedValue([wsSkill({ category: 'productivity' })])

    const res = await request(categorizeApp({ draftProvider })).post('/api/skills/categorize').send({
      workspaceId: 'w-1',
    })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ suggestions: [], considered: 0 })
    expect(draftProvider.stream).not.toHaveBeenCalled()
  })

  it('drops model output that names an unknown category or a bad index', async () => {
    const draftProvider = providerReturning(
      '[{"i":1,"category":"sales"},{"i":9,"category":"research"}]',
    )
    const res = await request(categorizeApp({ draftProvider })).post('/api/skills/categorize').send({
      workspaceId: 'w-1',
    })
    expect(res.status).toBe(200)
    expect(res.body.suggestions).toEqual([])
  })

  it('503s without a provider and 404s a non-member', async () => {
    const noProvider = await request(categorizeApp()).post('/api/skills/categorize').send({
      workspaceId: 'w-1',
    })
    expect(noProvider.status).toBe(503)

    workspaceStore.getRole.mockResolvedValue(null)
    const nonMember = await request(categorizeApp({ draftProvider: providerReturning('[]') }))
      .post('/api/skills/categorize')
      .send({ workspaceId: 'w-9' })
    expect(nonMember.status).toBe(404)
  })
})

describe('[COMP:api/skill-categorize] POST /api/skills/categorize/apply', () => {
  it('applies each assignment as a metadata-only update', async () => {
    const res = await request(categorizeApp())
      .post('/api/skills/categorize/apply')
      .send({
        workspaceId: 'w-1',
        assignments: [
          { skillRowId: 'a', category: 'communication' },
          { skillRowId: 'b', category: 'research' },
        ],
      })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ updated: 2, failed: [] })
    // ONLY `category` — anything else in this patch would trip the D2 stamp
    // and activate every Suggested skill in the batch.
    expect(workspaceSkillStore.update).toHaveBeenNthCalledWith(1, 'u-1', 'w-1', 'a', {
      category: 'communication',
    })
    expect(workspaceSkillStore.update).toHaveBeenNthCalledWith(2, 'u-1', 'w-1', 'b', {
      category: 'research',
    })
  })

  it('reports rows that matched nothing instead of failing the batch', async () => {
    workspaceSkillStore.update.mockImplementation(async (_u: string, _w: string, id: string) =>
      id === 'a' ? { rowId: 'a' } : null,
    )

    const res = await request(categorizeApp())
      .post('/api/skills/categorize/apply')
      .send({
        workspaceId: 'w-1',
        assignments: [
          { skillRowId: 'a', category: 'research' },
          { skillRowId: 'gone', category: 'research' },
        ],
      })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ updated: 1, failed: ['gone'] })
  })

  it('keeps going when one update throws', async () => {
    workspaceSkillStore.update.mockImplementation(async (_u: string, _w: string, id: string) => {
      if (id === 'boom') throw new Error('db said no')
      return { rowId: id }
    })

    const res = await request(categorizeApp())
      .post('/api/skills/categorize/apply')
      .send({
        workspaceId: 'w-1',
        assignments: [
          { skillRowId: 'boom', category: 'research' },
          { skillRowId: 'b', category: 'research' },
        ],
      })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ updated: 1, failed: ['boom'] })
  })

  it('400s an unknown category or an empty batch, and 404s a non-member', async () => {
    const app = categorizeApp()
    const badCategory = await request(app)
      .post('/api/skills/categorize/apply')
      .send({ workspaceId: 'w-1', assignments: [{ skillRowId: 'a', category: 'sales' }] })
    expect(badCategory.status).toBe(400)

    const empty = await request(app)
      .post('/api/skills/categorize/apply')
      .send({ workspaceId: 'w-1', assignments: [] })
    expect(empty.status).toBe(400)

    workspaceStore.getRole.mockResolvedValue(null)
    const nonMember = await request(categorizeApp())
      .post('/api/skills/categorize/apply')
      .send({ workspaceId: 'w-9', assignments: [{ skillRowId: 'a', category: 'research' }] })
    expect(nonMember.status).toBe(404)
    expect(workspaceSkillStore.update).not.toHaveBeenCalled()
  })
})
