import { describe, expect, it, vi } from 'vitest'
import { executionToolContext } from '@use-brian/agent-runtime/security/execution-context.js'
import { readdir, readFile } from 'node:fs/promises'
import { resolveExecutionContextSystem as resolveContext } from '../execution-context.js'
import type { ResolvedTurnScope } from '../resolve-turn-scope.js'
import type { AuthorityLease } from '../authority-lease.js'

// Unit scope/identity tests inject only metadata and assistant ports. The real
// PostgreSQL matrix exercises production factories with no authority substitutes.
const resolveExecutionContextSystem: typeof resolveContext = (input, deps) => resolveContext(input, {
  pinPolicyEpoch: async () => ({isCurrent: async () => true, matches: () => true}), resolveAssistant: async () => input.assistant, ...deps,
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
      pinPolicyEpoch: async () => ({isCurrent: async () => current, matches: () => current}),
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
    const read = (path: string) => readFile(new URL(path, root), 'utf8')
    // Kernel turns. The standalone `prepareAssistantRun` handoff is retired
    // (turn-kernel.md "Private final run preparation"): each lane resolves its
    // canonical ExecutionContext, binds it as the owner's one verified
    // `kind: 'execution'` invocation and hands final assembly to that owner's
    // `prepareRun`; the owner refuses any unprepared run. Web chat and the
    // channel pipeline reach classification through `routeAttendedTurn`
    // (attended-turn-routing.ts), which constructs no run (asserted below).
    const kernelLanes: Record<string, readonly string[]> = {
      'packages/api/src/routes/chat.ts': [
        'resolveExecutionContextSystem', 'openAssistantTurn(',
        "ownedTurn.bindModelPreparation({ kind: 'execution', toolProfile: 'web', execution: executionContext,",
        'ownedTurn.prepareRun({', 'executionToolContext', 'routeAttendedTurn({',
      ],
      'packages/api/src/routes/channel-pipeline.ts': [
        'resolveExecutionContextSystem', 'openAssistantTurn(',
        "turnOwner.bindModelPreparation({ kind: 'execution', toolProfile: 'channel', execution: executionContext,",
        'turnOwner.prepareRun({', 'executionToolContext', 'routeAttendedTurn({',
      ],
      'packages/api/src/routes/public-turn.ts': [
        'resolveExecutionContextSystem', 'openAssistantTurn(',
        "turnOwner.bindModelPreparation({ kind: 'execution', toolProfile: 'public', execution: executionContext,",
        'turnOwner.prepareRun({', 'executionToolContext',
      ],
      'packages/api/src/inter-assistant/executor.ts': [
        'resolveExecutionContextSystem', 'openAssistantTurn(',
        "owner.bindModelPreparation({ kind: 'execution', toolProfile: 'callee', execution: executionContext,",
        'owner.prepareRun({', 'executionToolContext',
      ],
      // Durable resume binds its canonical system execution (createExecutionContext).
      'packages/api/src/routes/session-resume-replay.ts': [
        'createExecutionContext', 'openAssistantTurn(',
        "owner.bindModelPreparation({ kind: 'execution', toolProfile: 'resume', execution,",
        'owner.prepareRun({', 'executionToolContext',
      ],
    }
    const productionPaths: Record<string, readonly string[]> = {
      ...kernelLanes,
      // The owner: one invocation shape, captured preparation, binding through
      // the canonical access wrapper, Brief, and refusal of an unprepared run.
      'packages/api/src/turn/kernel.ts': [
        'captureTurnModelPreparation(invocation', 'prepareRun(input: TurnRunPreparationInput)',
        'private retainedPreparationAccumulator: ContextScopeAccumulator | undefined',
        'this.retainedPreparationAccumulator = invocation.scopeAccumulator',
        'this.modelPreparation.captureRun(input, model, this.retainedPreparationAccumulator)',
        "throw new Error('The original run has not been prepared.')",
        "throw new Error('The original owner supplies the prepared run.')",
        'this.modelPreparation.assertLoopContext(supplied.context)',
      ],
      'packages/api/src/turn/prepare.ts': [
        "{ kind: 'execution'; toolProfile: 'web' | 'channel' | 'public' | 'callee' | 'resume'; execution: ExecutionContext;",
        'bindToolsToAgentAccess(unbound, projection', 'captureBriefRunPreparation()',
        'captureRun(input: TurnRunPreparationInput, model: PreparedTurnModel, accumulator?: ContextScopeAccumulator)',
        'retainedRunAccumulator = accumulator',
        'harnessPreparation.apply(execution, brief.tools, accumulator)',
        'candidate.executionContext !== execution || harnessRun && candidate.scopeAccumulator !== retainedRunAccumulator',
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
      'packages/api/src/boot/workflow.register.ts': [
        'resolveWorkflowRunScope', 'resolveExecutionContextSystem', 'externalClientPrincipal',
      ],
    }
    for (const [path, anchors] of Object.entries(productionPaths)) {
      const content = await read(path)
      for (const anchor of anchors) expect(content, `${path} must retain ${anchor}`).toContain(anchor)
    }

    // Closure: nothing else opens or runs a kernel turn. Every production file
    // that opens one is a listed lane, the loop runner is private to the
    // owner, no lane drives the query loop itself, the retired handoff is
    // gone, and the routing adapter constructs no run.
    const apiSource = new URL('packages/api/src/', root)
    const files = (await readdir(apiSource, { recursive: true }))
      .filter(file => file.endsWith('.ts') && !file.split('/').includes('__tests__'))
    const openers: string[] = []
    for (const file of files) {
      const content = await readFile(new URL(file, apiSource), 'utf8')
      const path = `packages/api/src/${file}`
      expect(content, `${path} must not use the retired handoff`).not.toContain('prepareAssistantRun')
      if (path !== 'packages/api/src/turn/kernel.ts') {
        expect(content, `${path} must not run the owner's private loop`).not.toContain('runAssistantTurnLoop')
        if (/\bopenAssistantTurn\(/.test(content)) openers.push(path)
      }
    }
    expect(openers.sort()).toEqual(Object.keys(kernelLanes).sort())
    for (const path of Object.keys(kernelLanes)) {
      expect(await read(path), `${path} must not drive the query loop outside its owner`).not.toMatch(/\bqueryLoop\(/)
    }
    const routing = await read('packages/api/src/routes/attended-turn-routing.ts')
    expect(routing).toContain('export async function routeAttendedTurn(')
    for (const construction of ['openAssistantTurn', 'prepareRun', 'bindModelPreparation', 'queryLoop(']) {
      expect(routing, `attended-turn-routing.ts must not construct a run (${construction})`).not.toContain(construction)
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

  it.each(['brain_key', 'assistant_key'] as const)('applies the stored room audience to %s without changing the actor identity', async kind => {
    const identity = { kind: 'programmatic' as const, principal: { kind, credentialId: 'credential-1', actorUserId: 'actor-1' }, credentialOwnerUserId: 'actor-1' }
    const result = await resolveExecutionContextSystem({
      ...base(), identity, sharedAudience: true, session: room,
      lifecycle: { ...base().lifecycle, channelType: kind === 'brain_key' ? 'programmatic' : 'assistant_mcp' },
    }, { resolveScope: async () => broadScope(), createLease: () => authority })
    expect(result.executionContext.identity).toEqual(identity)
    expect(result.executionContext.security.ceiling).toMatchObject({ userId: 'actor-1', clearance: 'public',
      compartments: ['project:forecast', 'team:finance'], projectIds: ['legacy-forecast'] })
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

  it('bounds Page comment reads and tool access by the shared thread before assembly', async () => {
    const result = await resolveExecutionContextSystem({
      ...base(), sharedAudience: true,
      session: { ...room, anchorKind: 'doc_thread', contextCompartments: [], contextProjectId: null },
    }, { resolveScope: async () => broadScope(true), createLease: () => authority })
    expect(result.executionContext.security.ceiling).toMatchObject({
      clearance: 'public', compartments: [], projectIds: [],
      departmentRead: { base: 'public', departments: {}, projects: {} },
    })
    expect(executionToolContext(result.executionContext, { appId: 'page-comment' })).toMatchObject({
      clearance: 'public', compartments: [], projectIds: [], sharedAudience: true,
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
