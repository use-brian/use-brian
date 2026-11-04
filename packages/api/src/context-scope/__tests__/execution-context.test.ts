import { describe, expect, it, vi } from 'vitest'
import { executionToolContext } from '@use-brian/core'
import { readFile } from 'node:fs/promises'
import { resolveExecutionContextSystem as resolveContext } from '../execution-context.js'
import type { ResolvedTurnScope } from '../resolve-turn-scope.js'
import type { AuthorityLease } from '../authority-lease.js'

// Unit scope/identity tests inject only metadata and assistant ports. The real
// PostgreSQL matrix exercises production factories with no authority substitutes.
const resolveExecutionContextSystem: typeof resolveContext = (input, deps) => resolveContext(input, {
  pinPolicyEpoch: async () => async () => true, resolveAssistant: async () => input.assistant, ...deps,
})

const authority: AuthorityLease = {
  markOperationMayHaveExecuted() {},
  async assertCurrent() {},
  async execute<T>(operation: () => Promise<T>) { return operation() },
}

const scope: ResolvedTurnScope = {
  access: {
    workspaceId: 'workspace-1',
    userId: 'actor-1',
    assistantId: 'assistant-1',
    assistantKind: 'standard',
    clearance: 'internal',
    compartments: [],
    mutationCompartments: [],
    projectIds: [],
    visibilityAssistantIds: ['assistant-1'],
  },
  activeGroupId: null,
  activeProjectId: null,
  effectiveCompartments: [],
  effectiveProjectIds: [],
  writeCompartments: [],
  writeProjectIds: [],
  activeTeam: null,
  activeProject: null,
}

function base() {
  return {
    userId: 'actor-1',
    assistant: {
      id: 'assistant-1',
      workspaceId: 'workspace-1',
      kind: 'standard' as const,
      clearance: 'internal' as const,
      compartments: [] as string[],
    },
    identity: {
      kind: 'attended' as const,
      principal: { kind: 'workspace_member' as const, userId: 'actor-1' },
    },
    ownership: { kind: 'workspace' as const, workspaceId: 'workspace-1' },
    lifecycle: {
      abortSignal: new AbortController().signal,
      sessionId: 'session-1',
      channelType: 'web',
      channelId: 'channel-1',
    },
  }
}

describe('[COMP:api/execution-context] trusted execution resolution', () => {
  it('rejects a policy change across trusted ceiling construction without creating a lease', async () => {
    let current = true
    const createLease = vi.fn(() => authority)
    await expect(resolveExecutionContextSystem(base(), {
      pinPolicyEpoch: async () => async () => current,
      resolveScope: async () => { current = false; return scope },
      createLease,
    })).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(createLease).not.toHaveBeenCalled()
  })

  it('resolves a current assistant inside the metadata bracket', async () => {
    const current = { ...base().assistant, clearance: 'public' as const }
    const resolveScope = vi.fn(async () => scope)
    await resolveExecutionContextSystem(base(), { resolveAssistant: async () => current, resolveScope, createLease: () => authority })
    expect(resolveScope).toHaveBeenCalledWith(expect.objectContaining({ assistant: current }), expect.anything())
  })

  it('resolves scope before constructing a context and keeps empty grants finite', async () => {
    const resolveScope = vi.fn(async () => scope)
    const result = await resolveExecutionContextSystem(base(), {
      resolveScope,
      createLease: () => authority,
    })
    expect(resolveScope).toHaveBeenCalledOnce()
    expect(result.executionContext.security.ceiling.compartments).toEqual([])
    expect(result.executionContext.security.authority).toBe(authority)
  })

  it('intersects a recipient ceiling before constructing prompt and tool authority', async () => {
    const createLease = vi.fn(() => authority)
    const scoped: ResolvedTurnScope = {
      ...scope,
      access: {
        ...scope.access,
        clearance: 'confidential',
        compartments: ['finance'],
        mutationCompartments: ['finance'],
        projectIds: ['project-1'],
      },
      effectiveCompartments: ['finance'],
      effectiveProjectIds: ['project-1'],
      writeCompartments: ['finance'],
      writeProjectIds: ['project-1'],
      activeTeam: {
        id: 'team-1', name: 'Finance', key: 'finance',
        compartmentKey: 'finance', status: 'active',
      },
      activeProject: { id: 'project-1', name: 'Forecast', status: 'active' },
    }
    const result = await resolveExecutionContextSystem({
      ...base(),
      maximumAccess: {
        workspaceId: 'workspace-1',
        userId: 'actor-1',
        clearance: 'public',
        compartments: [],
        mutationCompartments: [],
        projectIds: [],
        visibilityAssistantIds: null,
      },
    }, {
      resolveScope: async () => scoped,
      createLease,
    })

    expect(result.turnScope).toMatchObject({
      effectiveCompartments: [],
      effectiveProjectIds: [],
      writeCompartments: [],
      writeProjectIds: [],
      activeTeam: null,
      activeProject: null,
    })
    expect(result.executionContext.security.access).toMatchObject({
      clearance: 'public',
      compartments: [],
      mutationCompartments: [],
      projectIds: [],
    })
    expect(createLease).toHaveBeenCalledWith(
      expect.objectContaining({ clearance: 'public', compartments: [], projectIds: [] }),
      expect.any(Function),
      expect.any(Function),
    )
  })

  it('does not substitute a programmatic credential owner for its verified actor', async () => {
    const result = await resolveExecutionContextSystem({
      ...base(),
      identity: {
        kind: 'programmatic',
        principal: { kind: 'brain_key', credentialId: 'key-1', actorUserId: 'actor-1' },
        credentialOwnerUserId: 'owner-1',
      },
      attribution: { credentialOwnerUserId: 'owner-1', billingUserId: 'payer-1' },
    }, {
      resolveScope: async () => scope,
      createLease: () => authority,
    })
    expect(result.executionContext.security.access.userId).toBe('actor-1')
    expect(result.executionContext.attribution.credentialOwnerUserId).toBe('owner-1')
  })

  it('fails when the trusted resolver omits a required mutation axis', async () => {
    await expect(resolveExecutionContextSystem(base(), {
      resolveScope: async () => ({
        ...scope,
        access: { ...scope.access, mutationCompartments: undefined },
      }),
      createLease: () => authority,
    })).rejects.toThrow('execution_context_missing:mutation_compartments')
  })

  it('passes credential revalidation to the existing session lease factory', async () => {
    const credentialCurrent = vi.fn(async () => true)
    const maximumAccessCurrent = vi.fn(async () => ({
      workspaceId: 'workspace-1',
      userId: 'actor-1',
      clearance: 'public' as const,
      compartments: [] as string[],
      mutationCompartments: [] as string[],
      projectIds: [] as string[],
      visibilityAssistantIds: null,
    }))
    const createSessionLease = vi.fn(() => authority)
    await resolveExecutionContextSystem({
      ...base(),
      memberMode: 'external',
      ignoreSessionBinding: true,
      sessionAuthority: {
        id: 'session-1',
        assistantId: 'assistant-1',
        userId: 'actor-1',
        contextGroupId: null,
        contextProjectId: null,
        contextLockedAt: null,
      },
      credentialCurrent,
      maximumAccessCurrent,
    }, {
      resolveScope: async () => scope,
      createSessionLease,
    })
    expect(createSessionLease).toHaveBeenCalledWith(expect.objectContaining({
      credentialCurrent,
      maximumAccessCurrent,
      userId: 'actor-1',
      memberMode: 'external',
      ignoreSessionBinding: true,
    }))
  })

  it('keeps every production model, MCP, worker, and workflow path on validated construction', async () => {
    const root = new URL('../../../../../', import.meta.url)
    const productionPaths: Record<string, readonly string[]> = {
      'packages/api/src/routes/chat.ts': [
        'resolveExecutionContextSystem', 'prepareAssistantRun', 'executionToolContext',
      ],
      'packages/api/src/routes/channel-pipeline.ts': [
        'resolveExecutionContextSystem', 'prepareAssistantRun', 'executionToolContext',
      ],
      'packages/api/src/routes/public-turn.ts': [
        'resolveExecutionContextSystem', 'prepareAssistantRun', 'executionToolContext',
      ],
      'packages/api/src/inter-assistant/executor.ts': [
        'resolveExecutionContextSystem', 'prepareAssistantRun', 'executionToolContext',
      ],
      'packages/api/src/brain-mcp/tools.ts': [
        'resolveExecutionContextSystem', 'executionToolContext',
      ],
      'packages/core/src/workers/worker.ts': [
        'createExecutionContext', 'executionToolContext', 'parentCeiling',
      ],
      'packages/core/src/workflow/executor.ts': [
        'runtimeScope?.executionContext', 'executionToolContext',
      ],
      'packages/api/src/context-scope/workflow-authority.ts': [
        'createExecutionContext', "purpose:'workflow'", 'authority:lease',
      ],
      'packages/api/src/boot.ts': [
        'resolveWorkflowRunScope', 'resolveExecutionContextSystem', 'externalClientPrincipal',
      ],
    }
    for (const [path, anchors] of Object.entries(productionPaths)) {
      const content = await readFile(new URL(path, root), 'utf8')
      for (const anchor of anchors) expect(content, `${path} must retain ${anchor}`).toContain(anchor)
    }
  })
})


it('[COMP:api/execution-context] caps a higher bot to the shared room before exposing prompt and tool authority', async () => {
  const result = await resolveExecutionContextSystem({ ...base(), sharedAudience: true,
    maximumAccess: { workspaceId: 'workspace-1', userId: 'actor-1', clearance: 'internal',
      compartments: [], mutationCompartments: [], projectIds: [], visibilityAssistantIds: null },
  }, { resolveScope: async () => ({ ...scope, access: { ...scope.access, clearance: 'confidential',
      compartments: null, mutationCompartments: null, projectIds: null } }), createLease: () => authority })
  expect(result.executionContext.security.ceiling).toMatchObject({ clearance: 'internal', compartments: [], projectIds: [] })
  expect(result.executionContext.security.access.sharedAudience).toBe(true)
})


describe('[COMP:api/execution-context] stored shared web room audience', () => {
  const room = {
    effectiveClearance: 'public',
    contextCompartments: ['team:finance', 'project:forecast'],
    contextProjectId: 'legacy-forecast',
  }
  function broadScope(v2 = false): ResolvedTurnScope {
    return {
      ...scope,
      access: {
        ...scope.access,
        clearance: 'confidential',
        compartments: null,
        mutationCompartments: null,
        projectIds: null,
        ...(v2 ? { departmentRead: {
          workspaceId: 'workspace-1', userId: 'actor-1', assistantId: 'assistant-1',
          base: 'confidential' as const,
          departments: { finance: 'confidential' as const, hr: 'internal' as const },
          projects: { forecast: 'member' as const, secret: 'member' as const },
          contextDepartment: null, binding: null, cap: null,
        } } : {}),
      },
      effectiveCompartments: null,
      effectiveProjectIds: null,
      writeCompartments: ['team:finance', 'team:hr', 'project:forecast', 'project:secret'],
      writeProjectIds: ['legacy-forecast', 'legacy-secret'],
    }
  }

  it('bounds legacy room clearance, labels, project ids and write defaults before prompt/tool projection', async () => {
    const createLease = vi.fn(() => authority)
    const result = await resolveExecutionContextSystem({
      ...base(), sharedAudience: true, session: room,
    }, { resolveScope: async () => broadScope(), createLease })
    const expected = {
      userId: 'actor-1', clearance: 'public',
      compartments: ['project:forecast', 'team:finance'],
      mutationCompartments: ['project:forecast', 'team:finance'],
      projectIds: ['legacy-forecast'],
    }
    expect(result.turnScope.access).toMatchObject(expected)
    expect(result.turnScope).toMatchObject({
      effectiveCompartments: expected.compartments,
      effectiveProjectIds: expected.projectIds,
      writeCompartments: ['team:finance', 'project:forecast'],
      writeProjectIds: expected.projectIds,
    })
    expect(result.executionContext.security.access).toMatchObject({ ...expected, sharedAudience: true })
    expect(result.executionContext.security.ceiling).toMatchObject(expected)
    expect(createLease).toHaveBeenCalledWith(expect.objectContaining(expected), expect.any(Function), expect.any(Function))
    const projected = executionToolContext(result.executionContext, { appId: 'app-1' })
    expect(projected).toMatchObject(expected)
    expect(projected.assistantDefaultCompartments).toEqual(expected.compartments)
    expect(projected.assistantDefaultProjectIds).toEqual(expected.projectIds)
  })

  it('caps general v2 rooms using trusted session authority metadata, including Department and Project admissions', async () => {
    const createSessionLease = vi.fn(() => authority)
    const result = await resolveExecutionContextSystem({
      ...base(), sharedAudience: true,
      sessionAuthority: {
        id: 'session-1', assistantId: 'assistant-1', userId: 'room-owner',
        contextGroupId: null, contextProjectId: null, contextLockedAt: null,
        effectiveClearance: 'public', contextCompartments: ['team:finance'],
      },
    }, { resolveScope: async () => broadScope(true), createSessionLease })
    expect(result.turnScope.access.departmentRead).toMatchObject({
      userId: 'actor-1', base: 'public', departments: { finance: 'public' }, projects: {},
    })
    expect(result.executionContext.security.ceiling).toMatchObject({
      userId: 'actor-1', clearance: 'public', compartments: ['team:finance'], projectIds: [],
      departmentRead: { base: 'public', departments: { finance: 'public' }, projects: {} },
    })
    expect(result.turnScope.writeCompartments).toEqual(['team:finance'])
    expect(result.turnScope.writeProjectIds).toEqual([])
    expect(createSessionLease).toHaveBeenCalledWith(expect.objectContaining({
      starting: expect.objectContaining({ userId: 'actor-1', clearance: 'public' }),
      durableSessionSource: false,
    }))
  })

  it('preserves the additional Project-room v2 exclusion of Departments', async () => {
    const result = await resolveExecutionContextSystem({
      ...base(), sharedAudience: true, session: room,
      pinnedWriteDefaults: {
        compartments: ['team:hr', 'project:forecast'], projectIds: ['legacy-secret', 'legacy-forecast'],
      },
    }, { resolveScope: async () => broadScope(true), createLease: () => authority })
    expect(result.turnScope.access.departmentRead).toMatchObject({
      base: 'public', departments: {}, projects: { forecast: 'member' },
    })
    expect(result.executionContext.security.writeDefaults).toEqual({
      compartments: ['project:forecast'], projectIds: ['legacy-forecast'],
    })
  })

  it('cannot widen a narrower actor grant or maximumAccess', async () => {
    const result = await resolveExecutionContextSystem({
      ...base(), sharedAudience: true, session: room,
      maximumAccess: {
        workspaceId: 'workspace-1', userId: 'actor-1', clearance: 'internal',
        compartments: ['team:finance'], mutationCompartments: [], projectIds: [], visibilityAssistantIds: null,
      },
    }, { resolveScope: async () => broadScope(true), createLease: () => authority })
    expect(executionToolContext(result.executionContext, { appId: 'app-1' })).toMatchObject({
      clearance: 'public', compartments: ['team:finance'], mutationCompartments: [], projectIds: [],
      assistantDefaultCompartments: [], assistantDefaultProjectIds: [],
    })
    const finite = await resolveExecutionContextSystem({
      ...base(), sharedAudience: true, session: room,
    }, { resolveScope: async () => scope, createLease: () => authority })
    expect(finite.executionContext.security.ceiling).toMatchObject({
      clearance: 'public', compartments: [], mutationCompartments: [], projectIds: [],
    })
  })

  it('leaves private web sessions unchanged even with stored room-like metadata', async () => {
    const original = broadScope(true)
    const result = await resolveExecutionContextSystem({
      ...base(), sharedAudience: false, session: room,
    }, { resolveScope: async () => original, createLease: () => authority })
    expect(result.turnScope).toBe(original)
    expect(result.executionContext.security.ceiling).toMatchObject({
      clearance: 'confidential', compartments: null, projectIds: null,
      departmentRead: original.access.departmentRead,
    })
  })

  it.each(['office_file', 'feed_draft', 'feed_thread'])('keeps the anchor audience for %s instead of empty session labels', async anchorKind => {
    const maximumAccess = {
      workspaceId: 'workspace-1', userId: 'actor-1', clearance: 'internal' as const,
      compartments: ['team:finance'], mutationCompartments: ['team:finance'],
      projectIds: ['anchor-project'], visibilityAssistantIds: null,
    }
    const result = await resolveExecutionContextSystem({
      ...base(), sharedAudience: true,
      session: { anchorKind, effectiveClearance: 'internal', contextCompartments: [], contextProjectId: null },
      maximumAccess,
      pinnedWriteDefaults: { compartments: ['team:finance'], projectIds: ['anchor-project'] },
    }, { resolveScope: async () => broadScope(true), createLease: () => authority })
    expect(result.executionContext.security.ceiling).toMatchObject({
      clearance: 'internal', compartments: ['team:finance'], projectIds: ['anchor-project'],
      departmentRead: { departments: { finance: 'internal' } },
    })
    expect(result.executionContext.security.writeDefaults).toEqual({
      compartments: ['team:finance'], projectIds: ['anchor-project'],
    })
    expect(result.executionContext.security.access.sharedAudience).toBe(true)
  })

  it('does not apply web-room semantics to external provider groups', async () => {
    const original = broadScope(true)
    const result = await resolveExecutionContextSystem({
      ...base(), sharedAudience: true, session: room, ignoreSessionBinding: true,
      lifecycle: { ...base().lifecycle, channelType: 'slack' },
      maximumAccess: {
        workspaceId: 'workspace-1', userId: 'actor-1', clearance: 'internal',
        compartments: ['team:hr', 'project:secret'], mutationCompartments: ['team:hr'],
        projectIds: ['provider-project'], visibilityAssistantIds: null,
      },
    }, { resolveScope: async () => original, createLease: () => authority })
    expect(result.executionContext.security.ceiling).toMatchObject({
      clearance: 'internal', compartments: ['project:secret', 'team:hr'],
      mutationCompartments: ['team:hr'], projectIds: ['provider-project'],
      departmentRead: { departments: { hr: 'internal' }, projects: { secret: 'member' } },
    })
    expect(result.executionContext.security.access.sharedAudience).toBe(true)
  })
})
