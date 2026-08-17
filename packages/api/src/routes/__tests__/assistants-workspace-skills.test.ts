import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))

vi.mock('../../db/users.js', () => ({
  resolveAssistantAccess: vi.fn(),
}))

// Built-ins are read from disk. Pin them to one known entry so the assertions
// below are about the WORKSPACE group, not about whatever ships in the repo.
vi.mock('@use-brian/core', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    loadBuiltinSkills: () => [
      {
        id: 'using-brian',
        name: 'Using Brian',
        description: 'Built-in.',
        category: 'productivity',
        requiresConnectors: [],
        source: 'builtin',
      },
    ],
  }
})

import { assistantRoutes } from '../assistants.js'
import { queryWithRLS } from '../../db/client.js'
import { resolveAssistantAccess } from '../../db/users.js'

const mockQueryWithRLS = vi.mocked(queryWithRLS)
const mockAccess = vi.mocked(resolveAssistantAccess)

const ASSISTANT_WS = 'ws-home'
const OTHER_WS = 'ws-elsewhere'

/** One workspace skill row. `rowId` addresses the allowlist, `slug` the legacy override. */
function wsSkill(over: Partial<Record<string, unknown>> = {}) {
  return {
    rowId: 'row-1',
    id: 'weekly-digest',
    slug: 'weekly-digest',
    workspaceId: ASSISTANT_WS,
    name: 'Weekly digest',
    description: 'Summarise the week.',
    category: 'productivity',
    requiresConnectors: [],
    source: 'user',
    state: 'active',
    ...over,
  }
}

const skillStore = {
  listOwned: vi.fn(),
  listForWorkspaceContent: vi.fn(),
  listForAssistant: vi.fn(),
  setEnabled: vi.fn(),
  clearEnabled: vi.fn(),
  listStarred: vi.fn(),
}

const workspaceSkillStore = {
  listForWorkspace: vi.fn(),
  getByIdSystem: vi.fn(),
}

const enablementStore = {
  listForAssistant: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
}

const capabilityStore = {
  listActive: vi.fn(),
  hasActive: vi.fn(),
  listAllActive: vi.fn(),
  listHistoryForAssistant: vi.fn(),
  grant: vi.fn(),
  revoke: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  mockAccess.mockResolvedValue({
    assistant: { id: 'a-1', name: 'A', workspaceId: ASSISTANT_WS },
    role: 'member',
  } as never)
  // The app_type lookup in GET.
  mockQueryWithRLS.mockResolvedValue({ rows: [{ app_type: null }] } as never)
  skillStore.listForAssistant.mockResolvedValue([])
  skillStore.listStarred.mockResolvedValue([])
  skillStore.clearEnabled.mockResolvedValue(true)
  workspaceSkillStore.listForWorkspace.mockResolvedValue([])
  enablementStore.listForAssistant.mockResolvedValue([])
})

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as unknown as { userId: string }).userId = 'u-1'
    next()
  })
  app.use('/api/assistants', assistantRoutes({
    skillStore: skillStore as never,
    workspaceSkillStore: workspaceSkillStore as never,
    workspaceSkillEnablementStore: enablementStore as never,
    capabilityStore: capabilityStore as never,
  }))
  return app
}

describe('[COMP:routes/assistant-workspace-skills] Assistant-side workspace skill access', () => {
  describe('GET /:assistantId/skills', () => {
    it('lists the ASSISTANT\'s workspace, never the caller\'s personal one', async () => {
      workspaceSkillStore.listForWorkspace.mockResolvedValueOnce([wsSkill()])

      const res = await request(makeApp()).get('/api/assistants/a-1/skills')

      expect(res.status).toBe(200)
      // The root bug: `listOwned` pins resolvePrimaryWorkspace(userId) and
      // filters author_id, so a team-workspace assistant never saw its own
      // skills. It must not be reachable from this route at all.
      expect(skillStore.listOwned).not.toHaveBeenCalled()
      expect(workspaceSkillStore.listForWorkspace).toHaveBeenCalledWith(
        ASSISTANT_WS,
        { actingUserId: 'u-1' },
      )
      expect(res.body.workspaceSkills).toHaveLength(1)
      expect(res.body.workspaceSkills[0]).toMatchObject({ rowId: 'row-1', slug: 'weekly-digest' })
    })

    it('returns the two groups as separate arrays', async () => {
      workspaceSkillStore.listForWorkspace.mockResolvedValueOnce([wsSkill()])

      const res = await request(makeApp()).get('/api/assistants/a-1/skills')

      expect(res.body.skills.map((s: { id: string }) => s.id)).toEqual(['using-brian'])
      expect(res.body.workspaceSkills.map((s: { slug: string }) => s.slug)).toEqual(['weekly-digest'])
    })

    it('reports a workspace skill enabled when only the allowlist grants it', async () => {
      workspaceSkillStore.listForWorkspace.mockResolvedValueOnce([wsSkill()])
      enablementStore.listForAssistant.mockResolvedValueOnce([{ workspaceSkillId: 'row-1' }])

      const res = await request(makeApp()).get('/api/assistants/a-1/skills')

      expect(res.body.workspaceSkills[0].enabled).toBe(true)
    })

    it('reports a workspace skill enabled from a legacy true row with NO allowlist row', async () => {
      // These rows exist in production from the old personal-workspace toggle
      // and they DO offer the skill at runtime (`enabledSlugs` is OR'd in
      // injectSkills). Deriving `enabled` from allowlist presence alone would
      // display OFF for a skill that is in fact being offered.
      workspaceSkillStore.listForWorkspace.mockResolvedValueOnce([wsSkill()])
      enablementStore.listForAssistant.mockResolvedValueOnce([])
      skillStore.listForAssistant.mockResolvedValueOnce([{ skillId: 'weekly-digest', enabled: true }])

      const res = await request(makeApp()).get('/api/assistants/a-1/skills')

      expect(res.body.workspaceSkills[0].enabled).toBe(true)
    })

    it('reports disabled when a legacy false row vetoes an allowlist grant', async () => {
      workspaceSkillStore.listForWorkspace.mockResolvedValueOnce([wsSkill()])
      enablementStore.listForAssistant.mockResolvedValueOnce([{ workspaceSkillId: 'row-1' }])
      skillStore.listForAssistant.mockResolvedValueOnce([{ skillId: 'weekly-digest', enabled: false }])

      const res = await request(makeApp()).get('/api/assistants/a-1/skills')

      expect(res.body.workspaceSkills[0].enabled).toBe(false)
    })

    it('omits archived skills, which the runtime resolver never offers', async () => {
      workspaceSkillStore.listForWorkspace.mockResolvedValueOnce([
        wsSkill(),
        wsSkill({ rowId: 'row-2', id: 'absorbed', slug: 'absorbed', state: 'archived' }),
      ])

      const res = await request(makeApp()).get('/api/assistants/a-1/skills')

      expect(res.body.workspaceSkills.map((s: { slug: string }) => s.slug)).toEqual(['weekly-digest'])
    })

    it('500s rather than rendering an empty Workspace tab when the listing throws', async () => {
      workspaceSkillStore.listForWorkspace.mockRejectedValueOnce(new Error('relation does not exist'))

      const res = await request(makeApp()).get('/api/assistants/a-1/skills')

      // An empty tab is indistinguishable from "this workspace has no skills",
      // which is exactly the degrade-hides-a-failure anti-pattern.
      expect(res.status).toBe(500)
    })
  })

  describe('POST /:assistantId/workspace-skills/:id/enable', () => {
    it('writes the allowlist, keyed by row UUID', async () => {
      workspaceSkillStore.getByIdSystem.mockResolvedValueOnce(wsSkill())

      const res = await request(makeApp()).post('/api/assistants/a-1/workspace-skills/row-1/enable')

      expect(res.status).toBe(200)
      expect(enablementStore.enable).toHaveBeenCalledWith('row-1', 'a-1', 'u-1')
    })

    it('clears a stale legacy veto so the toggle actually takes effect', async () => {
      workspaceSkillStore.getByIdSystem.mockResolvedValueOnce(wsSkill())
      skillStore.listForAssistant.mockResolvedValueOnce([{ skillId: 'weekly-digest', enabled: false }])

      await request(makeApp()).post('/api/assistants/a-1/workspace-skills/row-1/enable')

      expect(skillStore.clearEnabled).toHaveBeenCalledWith('a-1', 'weekly-digest')
    })

    it('leaves the legacy table alone when there is no conflicting row', async () => {
      workspaceSkillStore.getByIdSystem.mockResolvedValueOnce(wsSkill())
      skillStore.listForAssistant.mockResolvedValueOnce([])

      await request(makeApp()).post('/api/assistants/a-1/workspace-skills/row-1/enable')

      expect(skillStore.clearEnabled).not.toHaveBeenCalled()
      expect(skillStore.setEnabled).not.toHaveBeenCalled()
    })

    it('404s a skill belonging to another workspace', async () => {
      // The allowlist PK is (workspace_skill_id, assistant_id) and its FKs check
      // existence, not workspace equality — so a member of two workspaces could
      // otherwise attach workspace A's skill to workspace B's assistant.
      workspaceSkillStore.getByIdSystem.mockResolvedValueOnce(wsSkill({ workspaceId: OTHER_WS }))

      const res = await request(makeApp()).post('/api/assistants/a-1/workspace-skills/row-1/enable')

      expect(res.status).toBe(404)
      expect(enablementStore.enable).not.toHaveBeenCalled()
    })
  })

  describe('POST /:assistantId/workspace-skills/:id/disable', () => {
    it('deletes the allowlist row', async () => {
      workspaceSkillStore.getByIdSystem.mockResolvedValueOnce(wsSkill())

      const res = await request(makeApp()).post('/api/assistants/a-1/workspace-skills/row-1/disable')

      expect(res.status).toBe(200)
      expect(enablementStore.disable).toHaveBeenCalledWith('row-1', 'a-1', 'u-1')
    })

    it('DELETES a legacy true row instead of writing enabled=false', async () => {
      // Writing `false` would mint a fresh veto row, which then silently defeats
      // a later enable from the skill editor's allowlist-only Access tab. The
      // disable path must never create a veto.
      workspaceSkillStore.getByIdSystem.mockResolvedValueOnce(wsSkill())
      skillStore.listForAssistant.mockResolvedValueOnce([{ skillId: 'weekly-digest', enabled: true }])

      await request(makeApp()).post('/api/assistants/a-1/workspace-skills/row-1/disable')

      expect(skillStore.clearEnabled).toHaveBeenCalledWith('a-1', 'weekly-digest')
      expect(skillStore.setEnabled).not.toHaveBeenCalled()
    })

    it('never writes to the legacy table on either path', async () => {
      workspaceSkillStore.getByIdSystem.mockResolvedValue(wsSkill())
      skillStore.listForAssistant.mockResolvedValue([{ skillId: 'weekly-digest', enabled: true }])

      await request(makeApp()).post('/api/assistants/a-1/workspace-skills/row-1/enable')
      await request(makeApp()).post('/api/assistants/a-1/workspace-skills/row-1/disable')

      expect(skillStore.setEnabled).not.toHaveBeenCalled()
    })

    it('404s a skill belonging to another workspace', async () => {
      workspaceSkillStore.getByIdSystem.mockResolvedValueOnce(wsSkill({ workspaceId: OTHER_WS }))

      const res = await request(makeApp()).post('/api/assistants/a-1/workspace-skills/row-1/disable')

      expect(res.status).toBe(404)
      expect(enablementStore.disable).not.toHaveBeenCalled()
    })
  })
})
