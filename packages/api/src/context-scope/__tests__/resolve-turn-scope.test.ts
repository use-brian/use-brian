import { describe, expect, it, vi } from 'vitest'
import type { ContextScopeStore, ContextTeam, WorkspaceProject } from '../../db/context-scope-store.js'
import {
  ContextNotAvailableError,
  formatActiveWorkspaceContext,
  resolveTurnScopeSystem,
  type TurnScopeAssistant,
} from '../resolve-turn-scope.js'

const TEAM_ID = '11111111-1111-4111-8111-111111111111'
const PROJECT_ID = '22222222-2222-4222-8222-222222222222'

const assistant: TurnScopeAssistant = {
  id: 'assistant-1',
  workspaceId: 'workspace-1',
  kind: 'standard',
  clearance: 'confidential',
  compartments: null,
  defaultCompartments: ['assistant-default'],
  teamScopeMode: 'assigned',
  projectScopeMode: 'assigned',
}

function team(overrides: Partial<ContextTeam> = {}): ContextTeam {
  return {
    id: TEAM_ID,
    workspaceId: 'workspace-1',
    name: 'Sales',
    key: 'sales',
    description: null,
    color: null,
    status: 'active',
    compartmentKey: `team:${TEAM_ID}`,
    readAll: false,
    readBundle: [`team:${TEAM_ID}`, 'shared'],
    ...overrides,
  }
}

function project(overrides: Partial<WorkspaceProject> = {}): WorkspaceProject {
  return {
    id: PROJECT_ID,
    workspaceId: 'workspace-1',
    name: 'Atlas',
    normalizedName: 'atlas',
    description: null,
    icon: null,
    status: 'active',
    entityId: null,
    createdBy: 'user-1',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  }
}

function store(overrides: Partial<ContextScopeStore> = {}): ContextScopeStore {
  return {
    resolveMemberTeamPrincipalSystem: vi.fn(),
    resolveAssistantPrincipalSystem: vi.fn().mockResolvedValue({
      teamMode: 'assigned',
      teamGrant: [`team:${TEAM_ID}`, 'shared'],
      projectMode: 'assigned',
      projectGrant: [PROJECT_ID],
      defaultGroupId: null,
      defaultProjectId: null,
    }),
    getTeamSystem: vi.fn().mockResolvedValue(team()),
    getProjectSystem: vi.fn().mockResolvedValue(project()),
    listTeams: vi.fn(),
    listProjects: vi.fn(),
    createProject: vi.fn(),
    setAssistantContext: vi.fn(),
    archiveProject: vi.fn(),
    ...overrides,
  }
}

describe('[COMP:api/context-scope-resolver] resolveTurnScopeSystem', () => {
  it('intersects member, assistant, selected Team, and active Project grants', async () => {
    const resolved = await resolveTurnScopeSystem(
      {
        userId: 'user-1',
        assistant,
        session: { contextGroupId: TEAM_ID, contextProjectId: PROJECT_ID },
      },
      {
        store: store(),
        resolveReadCeilings: vi.fn().mockResolvedValue({
          clearance: 'internal',
          compartments: [`team:${TEAM_ID}`, 'shared', 'member-only'],
        }),
      },
    )

    expect(resolved.access).toMatchObject({
      clearance: 'internal',
      compartments: ['shared', `team:${TEAM_ID}`],
      projectIds: [PROJECT_ID],
    })
    expect(resolved.writeCompartments).toEqual([`team:${TEAM_ID}`])
    expect(resolved.writeProjectIds).toEqual([PROJECT_ID])
    expect(formatActiveWorkspaceContext(resolved)).toContain('Team: Sales')
    expect(formatActiveWorkspaceContext(resolved)).toContain('Project: Atlas')
  })

  it('does not apply a newly configured assistant default to an existing NULL-bound session', async () => {
    const resolved = await resolveTurnScopeSystem(
      {
        userId: 'user-1',
        assistant: {
          ...assistant,
          teamScopeMode: 'legacy',
          projectScopeMode: 'all',
          defaultWorkspaceGroupId: TEAM_ID,
          defaultProjectId: PROJECT_ID,
        },
        session: { contextGroupId: null, contextProjectId: null },
      },
      {
        resolveReadCeilings: vi.fn().mockResolvedValue({
          clearance: 'confidential',
          compartments: null,
        }),
      },
    )

    expect(resolved.activeGroupId).toBeNull()
    expect(resolved.activeProjectId).toBeNull()
    expect(formatActiveWorkspaceContext(resolved)).toBe('')
  })

  it('refuses a Team selection outside the effective principal grant', async () => {
    await expect(resolveTurnScopeSystem(
      {
        userId: 'user-1',
        assistant,
        session: { contextGroupId: TEAM_ID },
      },
      {
        store: store(),
        resolveReadCeilings: vi.fn().mockResolvedValue({
          clearance: 'internal',
          compartments: ['accounting'],
        }),
      },
    )).rejects.toMatchObject({
      code: 'context_not_available',
      axis: 'team',
      reason: 'outside_grant',
    })
  })

  it('refuses archived context for new work but permits a locked historical session', async () => {
    const archivedStore = store({
      getProjectSystem: vi.fn().mockResolvedValue(project({ status: 'archived' })),
    })
    const deps = {
      store: archivedStore,
      resolveReadCeilings: vi.fn().mockResolvedValue({
        clearance: 'internal' as const,
        compartments: [`team:${TEAM_ID}`],
      }),
    }

    await expect(resolveTurnScopeSystem({
      userId: 'user-1',
      assistant,
      session: { contextProjectId: PROJECT_ID },
    }, deps)).rejects.toMatchObject({ code: 'context_not_available', reason: 'archived' })

    const historical = await resolveTurnScopeSystem({
      userId: 'user-1',
      assistant,
      session: { contextProjectId: PROJECT_ID, contextLockedAt: new Date() },
    }, deps)
    expect(historical.activeProjectId).toBe(PROJECT_ID)
  })

  it('preserves the published assistant-full lane without a member floor', async () => {
    const resolveReadCeilings = vi.fn()
    const resolved = await resolveTurnScopeSystem({
      userId: 'external-user',
      assistant: { ...assistant, teamScopeMode: 'legacy', projectScopeMode: 'all' },
      memberMode: 'assistant',
      systemRead: true,
    }, { resolveReadCeilings })

    expect(resolveReadCeilings).not.toHaveBeenCalled()
    expect(resolved.access).toMatchObject({
      clearance: 'confidential',
      compartments: null,
      projectIds: null,
      systemRead: true,
    })
  })

  it('preserves a finite legacy assistant Team ceiling in assistant-full mode', async () => {
    const resolveReadCeilings = vi.fn()
    const resolved = await resolveTurnScopeSystem({
      userId: 'external-user',
      assistant: {
        ...assistant,
        teamScopeMode: 'legacy',
        compartments: [`team:${TEAM_ID}`],
        projectScopeMode: 'all',
      },
      memberMode: 'assistant',
      systemRead: true,
    }, { resolveReadCeilings })

    expect(resolveReadCeilings).not.toHaveBeenCalled()
    expect(resolved.effectiveCompartments).toEqual([`team:${TEAM_ID}`])
    expect(resolved.access.compartments).toEqual([`team:${TEAM_ID}`])
  })
})
