/**
 * The Office file-chat lane. [COMP:api/office-chat-lane]
 * Spec: docs/architecture/features/office.md -> "Brian conversation in the file";
 * docs/architecture/platform/sensitivity.md -> "File-chat lane (Office)".
 */
import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { createOfficeTools, type Tool, type ToolContext } from '@use-brian/core'
import {
  bindOfficeLaneTools,
  officeLaneContextBlock,
  officeLaneExecutionBounds,
  resolveOfficeLane,
  type OfficeLane,
  type OfficeLaneArtifact,
  type OfficeLaneDeps,
} from '../office-chat-lane.js'
import { resolveExecutionContextSystem } from '../../context-scope/execution-context.js'
import type { ResolvedTurnScope } from '../../context-scope/resolve-turn-scope.js'
import type { AuthorityLease } from '../../context-scope/authority-lease.js'
import { createOfficeService } from '../../office/service.js'
import type { ResolvedOfficeAccess } from '../../office/access.js'

const ARTIFACT = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const SESSION = '33333333-3333-4333-8333-333333333333'
const WORKSPACE = '44444444-4444-4444-8444-444444444444'
const TARGET = '55555555-5555-4555-8555-555555555555'

const artifact: OfficeLaneArtifact = {
  id: ARTIFACT, workspaceId: WORKSPACE, family: 'presentation', title: 'Quarterly review', headVersion: 3,
  lifecycleState: 'active', sensitivity: 'internal', compartments: ['sales'], projectIds: [],
}

function access(role: 'view' | 'comment' | 'edit'): ResolvedOfficeAccess {
  return {
    artifactId: ARTIFACT, workspaceId: WORKSPACE, mode: 'artifact', role, workspaceRole: 'member', lifecycleState: 'active',
    canView: true, canComment: role !== 'view', canEdit: role === 'edit', canRestore: false, canDeletePermanently: false,
    canElevate: false, canManageSharing: false,
  }
}

function deps(role: 'view' | 'comment' | 'edit' | null, job: OfficeLaneDeps extends { latestJob(a: string): Promise<infer J> } ? J : never = null): OfficeLaneDeps {
  return {
    findLink: async (sessionId) => sessionId === SESSION ? { artifactId: ARTIFACT, workspaceId: WORKSPACE, sessionId } : null,
    resolveAccess: async () => role ? access(role) : null,
    getArtifact: async () => artifact,
    latestJob: async () => job,
  }
}

describe('[COMP:api/office-chat-lane] admission', () => {
  it.each(['comment', 'edit'] as const)('admits a %s sender with the selection as a bounded hint', async (role) => {
    const result = await resolveOfficeLane({ userId: 'u', sessionId: SESSION, selection: { targetIds: [TARGET, TARGET, 'not-a-uuid'] } }, deps(role))
    expect('lane' in result).toBe(true)
    // An invalid selection is dropped whole; a valid one is de-duplicated.
    const valid = await resolveOfficeLane({ userId: 'u', sessionId: SESSION, selection: { targetIds: [TARGET, TARGET] } }, deps(role))
    expect('lane' in valid && valid.lane.selection).toEqual([TARGET])
  })

  it('refuses a View-only reader: they read the thread but cannot send', async () => {
    expect(await resolveOfficeLane({ userId: 'u', sessionId: SESSION }, deps('view'))).toEqual({ refused: expect.objectContaining({ code: 'office_chat_read_only' }) })
  })

  it('gives a caller who cannot read the file the same refusal as a missing thread', async () => {
    const denied = await resolveOfficeLane({ userId: 'u', sessionId: SESSION }, deps(null))
    const missing = await resolveOfficeLane({ userId: 'u', sessionId: OTHER }, deps('edit'))
    expect(denied).toEqual(missing)
    expect(denied).toEqual({ refused: { code: 'session_access_denied', error: 'Session not found' } })
  })

  it('starts no turn while a generation job is active: those sends are steering', async () => {
    for (const status of ['queued', 'running', 'needs_input']) {
      expect(await resolveOfficeLane({ userId: 'u', sessionId: SESSION }, deps('edit', { id: 'j', jobKind: 'create', status })))
        .toEqual({ refused: expect.objectContaining({ code: 'office_generation_active' }) })
    }
    expect('lane' in await resolveOfficeLane({ userId: 'u', sessionId: SESSION }, deps('edit', { id: 'j', jobKind: 'revise', status: 'running' }))).toBe(true)
    expect('lane' in await resolveOfficeLane({ userId: 'u', sessionId: SESSION }, deps('edit', { id: 'j', jobKind: 'create', status: 'completed' }))).toBe(true)
  })
})

const lease: AuthorityLease = {
  markOperationMayHaveExecuted() {},
  async assertCurrent() {},
  async execute<T>(operation: () => Promise<T>) { return operation() },
}

function senderScope(access: Partial<ResolvedTurnScope['access']>): ResolvedTurnScope {
  return {
    access: {
      workspaceId: WORKSPACE, userId: 'sender', assistantId: 'assistant', assistantKind: 'primary',
      clearance: 'confidential', compartments: null, mutationCompartments: null, projectIds: null, visibilityAssistantIds: null,
      ...access,
    },
    activeGroupId: null, activeProjectId: null, effectiveCompartments: [], effectiveProjectIds: [],
    writeCompartments: [], writeProjectIds: [], activeTeam: null, activeProject: null,
  }
}

async function laneContext(scope: ResolvedTurnScope) {
  const lane: OfficeLane = { artifact, access: access('edit'), job: null, selection: [] }
  return (await resolveExecutionContextSystem({
    userId: 'sender',
    assistant: { id: 'assistant', workspaceId: WORKSPACE, kind: 'primary', clearance: 'confidential', compartments: [] },
    identity: { kind: 'attended', principal: { kind: 'workspace_member', userId: 'sender' } },
    ownership: { kind: 'workspace', workspaceId: WORKSPACE },
    lifecycle: { abortSignal: new AbortController().signal, sessionId: SESSION, channelType: 'office_thread', channelId: 'c' },
    ...officeLaneExecutionBounds(lane, 'sender', deps('edit')),
  }, { resolveScope: async () => scope, createLease: () => lease })).executionContext
}

describe('[COMP:api/office-chat-lane] the turn is capped at the file', () => {
  it('never lets clearance or compartments exceed the file when the sender reaches further', async () => {
    const context = await laneContext(senderScope({}))
    expect(context.security.access.clearance).toBe('internal')
    expect(context.security.access.compartments).toEqual(['sales'])
    expect(context.security.access.mutationCompartments).toEqual(['sales'])
    expect(context.security.access.projectIds).toEqual([])
    expect(context.security.ceiling.clearance).toBe('internal')
    expect(context.security.writeDefaults).toEqual({ compartments: ['sales'], projectIds: [] })
  })

  it('keeps a narrower sender at their own reach', async () => {
    const context = await laneContext(senderScope({ clearance: 'public', compartments: ['sales'], mutationCompartments: ['sales'], projectIds: [] }))
    expect(context.security.access.clearance).toBe('public')
    expect(context.security.access.compartments).toEqual(['sales'])
  })

  it('fails closed rather than writing under narrower labels when the sender cannot write the file labels', async () => {
    await expect(laneContext(senderScope({ compartments: ['sales'], mutationCompartments: [] }))).rejects.toThrow('execution_write_default_outside_mutation_grant')
  })
})

function revisionTools(role: 'view' | 'comment' | 'edit') {
  const createJob = vi.fn(async (params: { artifactId: string }) => ({ id: `job-for-${params.artifactId}` }))
  const service = createOfficeService({
    getArtifact: async () => ({ id: ARTIFACT, workspaceId: WORKSPACE, family: 'presentation', mode: 'artifact', title: 't', headVersion: 3,
      sensitivity: 'internal', compartments: [], projectIds: [], defaultWorkspaceRole: 'comment', lifecycleState: 'active', expiresAt: null }),
    resolveAccess: async () => access(role),
    raiseScope: async () => true,
    createJob,
  } as never)
  const registry = new Map<string, Tool>(createOfficeTools({ port: service as never }).map((tool) => [tool.name, tool]))
  return { tools: bindOfficeLaneTools(new Map(registry), registry, ARTIFACT), createJob }
}

const toolContext = { userId: 'sender', assistantId: 'assistant', workspaceId: WORKSPACE, clearance: 'internal', compartments: [], projectIds: [], assistantDefaultCompartments: [], assistantDefaultProjectIds: [] } as unknown as ToolContext
const revise = (artifactId: string) => ({ artifactId, instruction: 'Tighten the title', targetIds: [TARGET], expectedVersion: 3, idempotencyKey: 'chat-turn-key-1' })

describe('[COMP:api/office-chat-lane] one revision path, bound to the file', () => {
  it('offers only the bound read and revise tools, without needing the office grant', () => {
    const { tools } = revisionTools('edit')
    expect([...tools.keys()].filter((name) => /Office|Pdf/.test(name)).sort()).toEqual(['getOfficeArtifact', 'reviseOfficeArtifact'])
    expect(tools.get('reviseOfficeArtifact')!.requiresCapability).toBeUndefined()
  })

  it('refuses another artifactId with a self-describing error and starts nothing', async () => {
    const { tools, createJob } = revisionTools('edit')
    const result = await tools.get('reviseOfficeArtifact')!.execute(revise(OTHER), toolContext)
    expect(result).toMatchObject({ isError: true })
    expect(String((result as { data: unknown }).data)).toContain(ARTIFACT)
    expect(createJob).not.toHaveBeenCalled()
  })

  it('Edit lands a direct revision, Comment a proposal, through the same service.revise', async () => {
    const edit = await revisionTools('edit').tools.get('reviseOfficeArtifact')!.execute(revise(ARTIFACT), toolContext)
    const comment = await revisionTools('comment').tools.get('reviseOfficeArtifact')!.execute(revise(ARTIFACT), toolContext)
    expect(edit).toMatchObject({ data: { jobId: `job-for-${ARTIFACT}`, mode: 'direct' } })
    expect(comment).toMatchObject({ data: { jobId: `job-for-${ARTIFACT}`, mode: 'proposal' } })
  })
})

describe('[COMP:api/office-chat-lane] context delivery', () => {
  it('names the file and the surface, carries the selection as a hint, and names no tool', () => {
    const block = officeLaneContextBlock({ artifact, access: access('comment'), job: null, selection: [TARGET] })
    expect(block).toContain(ARTIFACT)
    expect(block).toContain('**Office** surface')
    expect(block).toContain(TARGET)
    expect(block).toContain('proposal')
    expect(block).not.toMatch(/OfficeArtifact|getOffice|reviseOffice/)
  })

  it('delivers the block only through the private runtime context (system channel), never a user-role prefix', async () => {
    const source = await readFile(new URL('../chat.ts', import.meta.url), 'utf8')
    expect(source).toContain('privateRuntimeContextParts.push(officeLaneContextBlock(officeLane))')
    expect(source).not.toMatch(/userVisibleContextParts\.push\(officeLane/)
  })
})
