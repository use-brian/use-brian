import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ContextScopeAccumulator } from '@use-brian/agent-runtime/security/context-scope.js'
import { createExecutionContext, type ExecutionContext } from '@use-brian/agent-runtime/security/execution-context.js'
import { type LLMProvider } from '@use-brian/agent-runtime/providers/types.js'
import { type Tool } from '@use-brian/agent-runtime/tools/types.js'
import { currentAgentAccess, runWithAgentAccess } from '../../db/agent-access-context.js'
import { configureBriefTurnContext, type BriefTurn } from '../../briefs/context.js'
import { captureTurnModelPreparation, type TurnRunPreparationInput } from '../../turn/prepare.js'
import { WorkspaceAccessError } from '../../workspace-access/policy.js'
import { configureHarnessTurnContext, resolveHarnessTurn } from '../turn-context.js'
import type { HarnessRevision } from '../contracts.js'

const storage = vi.hoisted(() => ({ lineage: vi.fn(), tree: vi.fn(), definition: vi.fn(), history: vi.fn() }))
vi.mock('../../db/project-harness-store.js', () => ({ createProjectHarnessStore: () => storage }))

const userId = '31000000-0000-4000-8000-000000000001'
const workspaceId = '31000000-0000-4000-8000-000000000002'
const projectId = '31000000-0000-4000-8000-000000000003'
const otherId = '31000000-0000-4000-8000-000000000004'
const assistantId = '31000000-0000-4000-8000-000000000005'
const revision: HarnessRevision = { id: otherId, workspaceId, projectId, scope: { kind: 'project' }, revision: 1,
  definition: { schemaVersion: 1, rules: [{ key: 'safety', kind: 'invariant', value: 'Preserve authorization', override: false }], codeChecks: [], acceptanceScenarios: [] },
  createdBy: userId, createdAt: '2026-01-01T00:00:00Z' }
const readTool: Tool = { name: 'getProjectHarnessContext', description: 'Read the scoped harness', inputSchema: z.object({}), isReadOnly: true, isConcurrencySafe: true, requiresConfirmation: false, execute: async () => ({ data: {} }) }
const tools = new Map([[readTool.name, readTool]])
const provider = { name: 'fixture', models: ['fixture'] } as LLMProvider

function fixture(projectIds = [projectId], identity?: ExecutionContext['identity']) {
  const authority = { assertCurrent: vi.fn(async () => {}), execute: async <T>(work: () => Promise<T>) => work() }
  const access = { userId, workspaceId, assistantId, assistantKind: 'standard' as const, clearance: 'internal' as const,
    compartments: [`project:${projectId}`, `project:${otherId}`], mutationCompartments: [`project:${projectId}`, `project:${otherId}`],
    projectIds: [projectId, otherId], visibilityAssistantIds: [assistantId] }
  const ec = createExecutionContext({ identity: identity ?? { kind: 'attended', principal: { kind: 'workspace_member', userId, authenticationKind: 'native_session' } },
    ownership: { kind: 'workspace', workspaceId }, access, authority, writeDefaults: { compartments: [], projectIds },
    lifecycle: { sessionId: otherId, channelType: 'web', channelId: otherId, abortSignal: new AbortController().signal },
    attribution: { billingUserId: otherId } })
  const accumulator = new ContextScopeAccumulator()
  const input: TurnRunPreparationInput = { systemPrompt: 'policy', messages: [{ role: 'user', content: 'Request' }], candidateTools: tools }
  const prepare = (inputOverride: Partial<TurnRunPreparationInput> = {}) => {
    const preparation = captureTurnModelPreparation({ kind: 'execution', toolProfile: 'web', execution: ec, assertCurrent: authority.assertCurrent },
      { provider, configuredProviders: undefined, resolveWorkspaceCustomLlm: null, resolveLegacyByoKey: null, buildLegacyByoProvider: null },
      { sessionId: otherId, assistantId, signal: ec.lifecycle.abortSignal, effect: operation => operation() })
    return preparation.captureRun({ ...input, ...inputOverride }, { provider, model: 'fixture' } as never, accumulator)()
  }
  return { ec, authority, accumulator, input, prepare }
}

beforeEach(() => { vi.clearAllMocks(); storage.lineage.mockReset(); storage.lineage.mockResolvedValue([revision]) })
afterEach(() => { configureHarnessTurnContext(null); configureBriefTurnContext(null) })

describe('Project-only automatic harness grounding', () => {
  it('uses the single write-default Project, authenticated actor and retained evidence under the native ceiling', async () => {
    const f = fixture()
    const before = structuredClone(f.ec.security.access)
    storage.lineage.mockImplementation(async (...args) => {
      expect(args).toEqual([userId, workspaceId, projectId, { kind: 'project' }])
      expect(currentAgentAccess()).toMatchObject({ userId, workspaceId, clearance: 'internal', projectIds: [projectId], compartments: [`project:${projectId}`], visibilityAssistantIds: [assistantId] })
      return [revision]
    })
    await runWithAgentAccess({ ...f.ec.security.access, projectIds: [projectId], compartments: [`project:${projectId}`] }, async () => {
      const parent = currentAgentAccess()
      const result = await resolveHarnessTurn(f.ec, tools, f.accumulator)
      expect(result).toMatchObject({ name: 'project_harness', content: expect.stringContaining('Preserve authorization') })
      expect(result!.content).toContain('Project Brief remains authoritative')
      expect(result!.content).toContain('prepareProjectHarnessTask')
      expect(currentAgentAccess()).toEqual(parent)
    })
    expect(f.accumulator.evidence).toMatchObject({ sensitivity: 'internal', projectIds: [projectId], compartments: [`project:${projectId}`] })
    expect(f.ec.security.access).toEqual(before)
    expect(currentAgentAccess()).toBeUndefined()
    expect(storage.lineage).toHaveBeenCalledOnce()
    for (const read of [storage.tree, storage.definition, storage.history]) expect(read).not.toHaveBeenCalled()
    expect(f.authority.assertCurrent).toHaveBeenCalledTimes(2)
  })

  it.each([{ ids: [] }, { ids: [projectId, otherId] }])('does not infer a Project from readable grants when write defaults are $ids', async ({ ids }) => {
    const f = fixture(ids)
    expect(await resolveHarnessTurn(f.ec, tools, f.accumulator)).toBeNull()
    expect(storage.lineage).not.toHaveBeenCalled()
    expect(f.authority.assertCurrent).not.toHaveBeenCalled()
  })

  it('does not read when the harness context operation is not admitted (even if preparation is admitted)', async () => {
    const f = fixture()
    expect(await resolveHarnessTurn(f.ec, new Map([['prepareProjectHarnessTask', { name: 'prepareProjectHarnessTask' } as Tool]]), f.accumulator)).toBeNull()
    expect(storage.lineage).not.toHaveBeenCalled()
  })

  it.each(['brain_key', 'assistant_key', 'oauth_token', 'home_app'] as const)('supports canonical %s attribution without using the credential owner', async kind => {
    const f = fixture([projectId], { kind: 'programmatic', principal: { kind, credentialId: otherId, actorUserId: userId }, credentialOwnerUserId: otherId })
    expect(await resolveHarnessTurn(f.ec, tools, f.accumulator)).not.toBeNull()
    expect(storage.lineage).toHaveBeenCalledExactlyOnceWith(userId, workspaceId, projectId, { kind: 'project' })
  })

  it('supports delegated identity without widening its parent ceiling', async () => {
    const parent = fixture().ec.security.ceiling
    const f = fixture([projectId], { kind: 'delegated', actorUserId: userId, delegationId: otherId,
      parentCeiling: { ...parent, projectIds: [projectId], compartments: [`project:${projectId}`], mutationCompartments: [`project:${projectId}`] } })
    storage.lineage.mockImplementation(async () => {
      expect(currentAgentAccess()?.projectIds).toEqual([projectId])
      expect(currentAgentAccess()?.compartments).toEqual([`project:${projectId}`])
      return [revision]
    })
    expect(await resolveHarnessTurn(f.ec, tools, f.accumulator)).not.toBeNull()
  })

  it.each<ExecutionContext['identity']>([
    { kind: 'system', purpose: 'scheduled_job', jobId: otherId },
    { kind: 'programmatic', principal: { kind: 'public_share', credentialId: otherId, actorUserId: userId }, credentialOwnerUserId: otherId },
    { kind: 'programmatic', principal: { kind: 'assistant_key', credentialId: otherId }, credentialOwnerUserId: otherId },
    { kind: 'programmatic', principal: { kind: 'application', credentialId: otherId, actorUserId: userId, applicationId: otherId, subjectKind: 'member' }, credentialOwnerUserId: otherId },
    { kind: 'attended', principal: { kind: 'verified_channel_guest', userId, provider: 'test', externalId: otherId } },
  ])('does not auto-inject for excluded identity $kind / $principal.kind', async identity => {
    const f = fixture([projectId], identity)
    expect(await resolveHarnessTurn(f.ec, tools, f.accumulator)).toBeNull()
    expect(storage.lineage).not.toHaveBeenCalled()
  })

  it('skips personal ownership and system-read surfaces', async () => {
    const f = fixture()
    for (const ec of [{ ...f.ec, ownership: { kind: 'personal' as const, ownerUserId: userId } }, { ...f.ec, surface: { systemRead: true as const } }]) {
      expect(await resolveHarnessTurn(ec, tools, f.accumulator)).toBeNull()
    }
    expect(storage.lineage).not.toHaveBeenCalled()
  })

  it('skips unconfigured and legacy Projects, but never swallows outages, denial or oversize', async () => {
    const f = fixture()
    storage.lineage.mockResolvedValueOnce([])
    expect(await resolveHarnessTurn(f.ec, tools, f.accumulator)).toBeNull()
    storage.lineage.mockRejectedValueOnce(new WorkspaceAccessError('harness_requires_shared_project', 409))
    expect(await resolveHarnessTurn(f.ec, tools, f.accumulator)).toBeNull()
    for (const error of [new Error('database unavailable'), new WorkspaceAccessError('harness_not_found', 404)]) {
      storage.lineage.mockRejectedValueOnce(error)
      await expect(resolveHarnessTurn(f.ec, tools, f.accumulator)).rejects.toBe(error)
    }
    storage.lineage.mockResolvedValueOnce([{ ...revision, definition: { ...revision.definition,
      rules: Array.from({ length: 10 }, (_, i) => ({ key: `rule-${i}`, kind: 'invariant', value: 'X'.repeat(3000), override: false })) } }])
    await expect(resolveHarnessTurn(f.ec, tools, f.accumulator)).rejects.toMatchObject({ code: 'harness_context_too_large' })
  })

  it('requires the retained accumulator and matching workspace before reading', async () => {
    const f = fixture()
    await expect(resolveHarnessTurn(f.ec, tools)).rejects.toMatchObject({ code: 'harness_scope_accumulator_required' })
    await expect(resolveHarnessTurn({ ...f.ec, ownership: { kind: 'workspace', workspaceId: otherId } }, tools, f.accumulator)).rejects.toMatchObject({ code: 'harness_authority_required' })
    expect(storage.lineage).not.toHaveBeenCalled()
  })

  it.each(['pre', 'post'] as const)('fails explicitly on %s-read revocation and retains any observed evidence', async when => {
    const f = fixture()
    if (when === 'post') f.authority.assertCurrent.mockResolvedValueOnce(undefined)
    f.authority.assertCurrent.mockRejectedValue(new Error('revoked'))
    await expect(resolveHarnessTurn(f.ec, tools, f.accumulator)).rejects.toThrow('revoked')
    expect(storage.lineage).toHaveBeenCalledTimes(when === 'pre' ? 0 : 1)
    if (when === 'post') expect(f.accumulator.evidence.projectIds).toEqual([projectId])
  })

  it.each([
    { projectIds: [otherId] }, { compartments: [] }, { clearance: 'public' },
  ])('does not widen a surrounding read ceiling %j', async narrow => {
    const f = fixture()
    await expect(runWithAgentAccess({ ...f.ec.security.access, ...narrow }, () => resolveHarnessTurn(f.ec, tools, f.accumulator))).rejects.toMatchObject({ code: 'harness_not_found' })
    expect(storage.lineage).not.toHaveBeenCalled()
  })
})

describe('harness contribution in shared run preparation', () => {
  it('captures the resolver before the first admission await', async () => {
    const f = fixture()
    const custom = vi.fn(async () => ({ name: 'project_harness' as const, content: 'captured harness' }))
    const replacement = vi.fn(async () => null)
    configureHarnessTurnContext(custom)
    f.authority.assertCurrent.mockImplementationOnce(async () => { configureHarnessTurnContext(replacement) })
    const result = await f.prepare()
    expect(custom).toHaveBeenCalledExactlyOnceWith(f.ec, expect.any(Map), f.accumulator)
    expect(replacement).not.toHaveBeenCalled()
    expect(result.runtimeSystemContext).toBe('captured harness')
  })

  it('keeps runtime then Brief then harness order, the Brief tool guard and user-visible contributions unchanged', async () => {
    const f = fixture()
    const order: string[] = []
    configureBriefTurnContext(async () => { order.push('brief'); return { content: 'accepted direction', incomplete: true } as BriefTurn })
    configureHarnessTurnContext(async (_ec, bound, accumulator) => {
      order.push('harness')
      expect(accumulator).toBe(f.accumulator)
      expect(await bound.get('mutate')!.execute({}, {} as never)).toMatchObject({ isError: true, data: { error: 'brief_rules_unavailable' } })
      return { name: 'project_harness', content: 'engineering contract' }
    })
    const execute = vi.fn()
    const result = await f.prepare({ candidateTools: new Map([...tools, ['mutate', { ...readTool, name: 'mutate', isReadOnly: false, execute } as Tool]]),
      trustedContributions: [{ name: 'runtime', content: 'platform policy' }], userVisibleContributions: [{ name: 'attachment', content: 'visible attachment' }] })
    expect(order).toEqual(['brief', 'harness'])
    expect(result.runtimeSystemContext).toBe('platform policy\n\naccepted direction\n\nengineering contract')
    expect(result.grounding.userVisibleContext).toBe('visible attachment')
    expect(execute).not.toHaveBeenCalled()
  })

  it('checks canonical harness authority after assembly instead of returning a silently omitted contract', async () => {
    const f = fixture()
    configureHarnessTurnContext(resolveHarnessTurn)
    // Initial preparation, pre-read, post-read pass; the final preparation check revokes.
    f.authority.assertCurrent.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValue(new Error('revoked after read'))
    await expect(f.prepare()).rejects.toThrow('revoked after read')
    expect(storage.lineage).toHaveBeenCalledOnce()
    expect(f.accumulator.evidence.projectIds).toEqual([projectId])
  })

  it('does not assemble a fallback on a canonical read denial', async () => {
    const f = fixture()
    configureHarnessTurnContext(resolveHarnessTurn)
    storage.lineage.mockRejectedValue(new WorkspaceAccessError('harness_not_found', 404))
    await expect(f.prepare()).rejects.toMatchObject({ code: 'harness_not_found' })
  })

  it('rejects authority method replacement during admission before reading the harness', async () => {
    const f = fixture()
    configureHarnessTurnContext(resolveHarnessTurn)
    const replacement = vi.fn(async () => {})
    f.authority.assertCurrent.mockImplementationOnce(async () => { f.authority.assertCurrent = replacement })
    await expect(f.prepare()).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(replacement).not.toHaveBeenCalled()
    expect(storage.lineage).not.toHaveBeenCalled()
  })
})
