import { runWithAgentAccess } from '../../db/agent-access-context.js'
import { describe, expect, it, vi } from 'vitest'
import type { ContextScopeStore, ContextTeam, WorkspaceProject } from '../../db/context-scope-store.js'
import { resolveExecutionContextSystem } from '../execution-context.js'
import {
  ContextNotAvailableError,
  formatActiveWorkspaceContext,
  resolveTurnScopeSystem,
  resolveLiveAccessCeilingSystem,
  sessionMessageInputScope,
  turnOutputWrite,
  type TurnScopeAssistant,
} from '../resolve-turn-scope.js'
import { ContextScopeAccumulator, type ResourceScope, type ScopeSource } from '@use-brian/core'

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
    getProjectDetail: vi.fn(),
    listTeams: vi.fn(),
    listProjects: vi.fn(),
    createProject: vi.fn(),
    updateProject: vi.fn(),
    setProjectMember: vi.fn(),
    setProjectAssistant: vi.fn(),
    getAssistantContextConfig: vi.fn(),
    setAssistantContext: vi.fn(),
    archiveProject: vi.fn(),
    ...overrides,
  }
}

describe('[COMP:api/context-scope-resolver] resolveTurnScopeSystem', () => {
  it('stamps a public group input from the audience-bounded turn', () => {
    const scope = {
      access: {
        workspaceId: 'workspace-1', userId: 'user-1', assistantId: 'assistant-1',
        assistantKind: 'standard' as const, clearance: 'public' as const,
        compartments: [] as string[], mutationCompartments: [] as string[],
        projectIds: [] as string[], visibilityAssistantIds: ['assistant-1'],
      },
      activeGroupId: null,
      activeProjectId: null,
      effectiveCompartments: [] as string[],
      effectiveProjectIds: [] as string[],
      writeCompartments: [] as string[],
      writeProjectIds: [] as string[],
      activeTeam: null,
      activeProject: null,
    }
    expect(sessionMessageInputScope({
      scope,
      workspaceId: 'workspace-1',
      userId: 'user-1',
      assistantId: 'assistant-1',
      sharedAudience: true,
    })).toEqual({
      workspaceId: 'workspace-1',
      userId: null,
      assistantId: 'assistant-1',
      sensitivity: 'public',
      compartments: [],
      projectIds: [],
    })
  })

  it('refreshes live authority independently of inherited execution narrowing', async () => {
    const input = { userId: 'user-1', assistant: { ...assistant, kind: 'primary' as const,
      teamScopeMode: 'legacy' as const, projectScopeMode: 'all' as const } }
    const deps = { resolveReadCeilings: vi.fn().mockResolvedValue({ clearance: 'confidential', compartments: null, mutationCompartments: null }) }
    await runWithAgentAccess({ userId: 'user-1', workspaceId: 'workspace-1',
      clearance: 'public', compartments: [], projectIds: [], visibilityAssistantIds: [] }, async () => {
      expect(await resolveLiveAccessCeilingSystem(input, deps)).toMatchObject({
        clearance: 'confidential', compartments: null, projectIds: null, visibilityAssistantIds: null,
      })
      expect((await resolveTurnScopeSystem(input, deps)).access).toMatchObject({
        clearance: 'public', compartments: [], projectIds: [], visibilityAssistantIds: [],
      })
    })
  })
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
          mutationCompartments: [`team:${TEAM_ID}`, 'shared', 'member-only'],
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

  it('bounds nested primary resolution before connector exposure or prompt construction',async()=>{
    const result=await runWithAgentAccess({workspaceId:'workspace-1',userId:'user-1',clearance:'internal',compartments:['product'],projectIds:[],visibilityAssistantIds:['caller']},()=>resolveTurnScopeSystem({userId:'user-1',assistant:{...assistant,kind:'primary',teamScopeMode:'all',projectScopeMode:'all'}},{resolveReadCeilings:vi.fn().mockResolvedValue({clearance:'confidential',compartments:null,mutationCompartments:null})}))
    expect(result.access).toMatchObject({clearance:'internal',compartments:['product'],projectIds:[],visibilityAssistantIds:['caller']})
    expect(result.effectiveCompartments).toEqual(['product']);expect(result.effectiveProjectIds).toEqual([])
  })
  it('refuses actor replacement during nested scope resolution',async()=>{
    await expect(runWithAgentAccess({workspaceId:'workspace-1',userId:'actual-actor',clearance:'internal',compartments:[]},()=>resolveTurnScopeSystem({userId:'owner',assistant:{...assistant,teamScopeMode:'all',projectScopeMode:'all'}},{resolveReadCeilings:vi.fn().mockResolvedValue({clearance:'confidential',compartments:null,mutationCompartments:null})}))).rejects.toThrow('access_actor_mismatch')
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
          mutationCompartments: null,
        }),
      },
    )

    expect(resolved.activeGroupId).toBeNull()
    expect(resolved.activeProjectId).toBeNull()
    expect(formatActiveWorkspaceContext(resolved)).toBe('')
  })

  it('lets a shared-provider audience replace a stale session Team and Project binding', async () => {
    const contextStore = store()
    const resolved = await resolveTurnScopeSystem({
      userId: 'user-1',
      assistant: {
        ...assistant,
        teamScopeMode: 'legacy',
        projectScopeMode: 'all',
      },
      session: { contextGroupId: TEAM_ID, contextProjectId: PROJECT_ID },
      ignoreSessionBinding: true,
    }, {
      store: contextStore,
      resolveReadCeilings: vi.fn().mockResolvedValue({
        clearance: 'confidential',
        compartments: null,
        mutationCompartments: null,
      }),
    })

    expect(contextStore.getTeamSystem).not.toHaveBeenCalled()
    expect(contextStore.getProjectSystem).not.toHaveBeenCalled()
    expect(resolved.activeTeam).toBeNull()
    expect(resolved.activeProject).toBeNull()
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
          mutationCompartments: ['accounting'],
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
        mutationCompartments: [`team:${TEAM_ID}`],
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

  it('refuses an injected resolver that omits explicit mutation authority',async()=>{
    await expect(resolveTurnScopeSystem({userId:'user-1',assistant:{...assistant,teamScopeMode:'all',projectScopeMode:'all'}},
      {resolveReadCeilings:vi.fn().mockResolvedValue({clearance:'internal',compartments:['finance']})})).rejects.toThrow('authority_unavailable')
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

  it('builds an external channel execution context with no workspace read or write grants', async () => {
    const resolveWorkspaceRole = vi.fn(async () => null)
    const authority = {
      async assertCurrent() {},
      async execute<T>(operation: () => Promise<T>) { return operation() },
    }
    const createSessionLease = vi.fn(() => authority)
    const result = await resolveExecutionContextSystem({
      userId: 'external-user',
      assistant,
      memberMode: 'external',
      session: { contextGroupId: null, contextProjectId: null },
      identity: {
        kind: 'attended',
        principal: {
          kind: 'verified_channel_guest',
          userId: 'external-user',
          provider: 'feishu',
          externalId: 'channel-user-1',
        },
      },
      ownership: { kind: 'workspace', workspaceId: 'workspace-1' },
      lifecycle: {
        abortSignal: new AbortController().signal,
        sessionId: 'session-1',
        channelType: 'feishu',
        channelId: 'conversation-1',
      },
      sessionAuthority: {
        id: 'session-1',
        assistantId: assistant.id,
        userId: 'external-user',
        contextGroupId: null,
        contextProjectId: null,
        contextLockedAt: null,
      },
    }, {
      store: store(),
      resolveWorkspaceRole,
      createSessionLease,
    })

    expect(resolveWorkspaceRole).toHaveBeenCalledWith('external-user', 'workspace-1', true)
    expect(result.turnScope).toMatchObject({
      effectiveCompartments: [],
      effectiveProjectIds: [],
      writeCompartments: [],
      writeProjectIds: [],
    })
    expect(result.executionContext.security.access).toMatchObject({
      clearance: 'public',
      compartments: [],
      mutationCompartments: [],
      projectIds: [],
    })
    expect(result.executionContext.security.writeDefaults).toEqual({
      compartments: [],
      projectIds: [],
    })
    expect(createSessionLease).toHaveBeenCalledWith(expect.objectContaining({
      memberMode: 'external',
      userId: 'external-user',
    }))
  })

  it('ignores stale member Team and Project bindings for an external channel principal', async () => {
    const contextStore = store()
    const resolved = await resolveTurnScopeSystem({
      userId: 'external-user',
      assistant: {
        ...assistant,
        teamScopeMode: 'legacy',
        projectScopeMode: 'all',
      },
      memberMode: 'external',
      session: {
        contextGroupId: TEAM_ID,
        contextProjectId: PROJECT_ID,
        contextLockedAt: new Date('2026-09-29T00:00:00Z'),
      },
    }, {
      store: contextStore,
      resolveWorkspaceRole: vi.fn(async () => null),
    })

    expect(contextStore.getTeamSystem).not.toHaveBeenCalled()
    expect(contextStore.getProjectSystem).not.toHaveBeenCalled()
    expect(resolved).toMatchObject({
      activeTeam: null,
      activeProject: null,
      effectiveCompartments: [],
      effectiveProjectIds: [],
      writeCompartments: [],
      writeProjectIds: [],
      access: { clearance: 'public', compartments: [], projectIds: [] },
    })
  })

  it('keeps external renewal only while strict membership remains absent', async () => {
    let role: 'member' | null = null
    const resolveWorkspaceRole = vi.fn(async () => role)
    const input = {
      userId: 'external-user',
      assistant,
      memberMode: 'external' as const,
    }

    await expect(resolveLiveAccessCeilingSystem(input, {
      store: store(),
      resolveWorkspaceRole,
    })).resolves.toMatchObject({
      clearance: 'public',
      compartments: [],
      mutationCompartments: [],
      projectIds: [],
    })
    role = 'member'
    await expect(resolveLiveAccessCeilingSystem(input, {
      store: store(),
      resolveWorkspaceRole,
    })).rejects.toThrow('authority_unavailable')
  })

  it('requires strict membership when renewing an ordinary member lease', async () => {
    const resolveReadCeilings = vi.fn().mockResolvedValue({
      clearance: 'internal',
      compartments: [],
      mutationCompartments: [],
    })
    await resolveLiveAccessCeilingSystem({
      userId: 'user-1',
      assistant: { ...assistant, teamScopeMode: 'legacy', projectScopeMode: 'all' },
    }, { resolveReadCeilings })
    expect(resolveReadCeilings).toHaveBeenCalledWith(
      'user-1',
      'workspace-1',
      'confidential',
      null,
      true,
    )
  })
})

describe('[COMP:api/context-scope-resolver] turnOutputWrite', () => {
  const envelope: ResourceScope = {
    workspaceId: 'workspace-1', userId: 'user-1', assistantId: 'primary-1',
    sensitivity: 'internal', compartments: ['assistant-default'], projectIds: [],
  }
  const source = (overrides: Partial<ScopeSource>): ScopeSource => ({
    resourceKind: 'memory', resourceId: 'memory-1', version: '1',
    workspaceId: 'workspace-1', userId: null, assistantId: null,
    sensitivity: 'internal', compartments: [], projectIds: [], ...overrides,
  })

  it('certifies a derivation when every source shares one partition', () => {
    const accumulator = new ContextScopeAccumulator()
    accumulator.noteSource(source({ resourceKind: 'session_message', userId: 'user-1', assistantId: 'primary-1' }))
    accumulator.noteSource(source({ resourceId: 'memory-2' }))
    const write = turnOutputWrite({ producer: 'turn:web', accumulator, envelope })
    expect(write).toEqual({ derivation: { producer: 'turn:web', sources: accumulator.evidence.sources } })
  })

  it('stamps the session envelope, raised to the label floor, when a primary read across partitions', () => {
    // The turn's own message plus a workspace memory another assistant authored.
    const accumulator = new ContextScopeAccumulator()
    accumulator.noteSource(source({ resourceKind: 'session_message', userId: 'user-1', assistantId: 'primary-1' }))
    accumulator.noteSource(source({ resourceId: 'memory-2', userId: 'user-2', assistantId: 'other-assistant',
      sensitivity: 'confidential', compartments: ['team:finance'], projectIds: ['project-a'] }))
    expect(turnOutputWrite({ producer: 'turn:web', accumulator, envelope })).toEqual({
      scope: {
        workspaceId: 'workspace-1', userId: 'user-1', assistantId: 'primary-1',
        sensitivity: 'confidential', compartments: ['assistant-default', 'team:finance'], projectIds: ['project-a'],
      },
    })
  })

  it('uses the envelope when nothing bound was read, and keeps legacy unscoped turns unchanged', () => {
    const accumulator = new ContextScopeAccumulator()
    expect(turnOutputWrite({ producer: 'turn:web', accumulator, envelope })).toEqual({ scope: envelope })
    expect(turnOutputWrite({ producer: 'turn:web', accumulator, envelope: undefined }))
      .toEqual({ derivation: { producer: 'turn:web', sources: [] } })
  })
})
