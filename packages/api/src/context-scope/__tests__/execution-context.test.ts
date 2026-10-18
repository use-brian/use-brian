import { describe, expect, it, vi } from 'vitest'
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
