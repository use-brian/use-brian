import { describe, expect, it, vi } from 'vitest'
import {
  createWorkspaceDecisionRouteResolver,
  parseOperatorDecisionDefault,
} from '../workspace-decision-routing.js'

const context = {
  workspaceId: 'workspace-fictional',
  kind: 'execution' as const,
  evaluationSegment: 'global',
  operation: {
    id: 'fixture.intent',
    version: '2',
    stateVersion: '3',
    questionVersion: '4',
  },
  questionKinds: ['choice' as const],
}

describe('[COMP:decisions/workspace-routing] workspace decision route resolver', () => {
  it('requires a complete, active operator-default pair', () => {
    expect(parseOperatorDecisionDefault(undefined, undefined)).toBeUndefined()
    expect(parseOperatorDecisionDefault('operator_hybrid', 'typesafe-jev-1.13')).toEqual({
      mode: 'operator_hybrid',
      modelAlias: 'typesafe-jev-1.13',
    })
    expect(() => parseOperatorDecisionDefault('operator_hybrid', undefined)).toThrow(/required together/)
    expect(() => parseOperatorDecisionDefault(undefined, 'typesafe-jev-1.13')).toThrow(/required together/)
    expect(() => parseOperatorDecisionDefault('hybrid', 'typesafe-jev-1.13')).toThrow(/required together/)
    expect(() => parseOperatorDecisionDefault('operator_hybrid', 'not-a-model')).toThrow(/active decision model/)
  })

  it('makes the operator default authoritative for execution and full-sample shadow for observation', async () => {
    const getSystem = vi.fn(async () => null)
    const resolver = createWorkspaceDecisionRouteResolver({
      store: { getSystem },
      configuredAdapterIds: () => ['typesafe'],
      operatorDefault: { mode: 'operator_hybrid', modelAlias: 'typesafe-jev-1.13' },
    })

    await expect(resolver(context)).resolves.toMatchObject({
      mode: 'hybrid',
      primaryModelId: 'typesafe-jev-1.13',
      operatorOverride: true,
      allowOperationalFailover: true,
      allowInvalidResponseRecovery: true,
      profile: {
        status: 'operator_override',
        evidence: 'operator_override',
        operationId: 'fixture.intent',
      },
    })
    await expect(resolver({ ...context, kind: 'observation' })).resolves.toMatchObject({
      mode: 'shadow',
      primaryModelId: 'typesafe-jev-1.13',
      profile: {
        status: 'operator_override',
        evidence: 'operator_override',
        shadowSampleRate: 1,
      },
    })
    expect(getSystem).toHaveBeenCalledTimes(2)
  })

  it('lets an explicit workspace LLM-only row override the deployment default', async () => {
    const resolver = createWorkspaceDecisionRouteResolver({
      store: { getSystem: vi.fn(async () => ({
        workspaceId: context.workspaceId,
        mode: 'llm_only' as const,
        modelAlias: null,
        updatedAt: 'now',
      })) },
      configuredAdapterIds: () => ['typesafe'],
      operatorDefault: { mode: 'operator_hybrid', modelAlias: 'typesafe-jev-1.13' },
    })
    await expect(resolver(context)).resolves.toEqual({ mode: 'llm_only' })
  })

  it('fails closed when the operator-default adapter is unavailable', async () => {
    const resolver = createWorkspaceDecisionRouteResolver({
      store: { getSystem: vi.fn(async () => null) },
      configuredAdapterIds: () => [],
      operatorDefault: { mode: 'operator_hybrid', modelAlias: 'typesafe-jev-1.13' },
    })
    await expect(resolver(context)).resolves.toEqual({ mode: 'llm_only' })
  })

  it('builds a version-matched 10% shadow profile for a configured adapter', async () => {
    const resolver = createWorkspaceDecisionRouteResolver({
      store: { getSystem: vi.fn(async () => ({
        workspaceId: context.workspaceId,
        mode: 'shadow' as const,
        modelAlias: 'typesafe-jev-1.13',
        updatedAt: 'now',
      })) },
      configuredAdapterIds: () => ['typesafe'],
    })

    await expect(resolver(context)).resolves.toMatchObject({
      mode: 'shadow',
      primaryModelId: 'typesafe-jev-1.13',
      profile: {
        mode: 'shadow' as const,
        operationId: 'fixture.intent',
        operationVersion: '2',
        stateVersion: '3',
        questionVersion: '4',
        modelCatalogId: 'typesafe-jev-1.13',
        modelWireId: 'jev-1.13.0',
        status: 'evaluation',
        evidence: 'synthetic',
        maxAttempts: 2,
        shadowSampleRate: 0.1,
      },
    })
  })

  it('fails closed when the saved adapter is unavailable', async () => {
    const resolver = createWorkspaceDecisionRouteResolver({
      store: { getSystem: vi.fn(async () => ({
        workspaceId: context.workspaceId,
        mode: 'shadow' as const,
        modelAlias: 'typesafe-jev-1.13',
        updatedAt: 'now',
      })) },
      configuredAdapterIds: () => [],
    })
    await expect(resolver(context)).resolves.toEqual({ mode: 'llm_only' })
  })

  it('uses an exact approved profile for hybrid execution', async () => {
    const profile = {
      id: 'approved-fixture-intent',
      version: '1',
      mode: 'hybrid' as const,
      operationId: context.operation.id,
      operationVersion: context.operation.version,
      stateVersion: context.operation.stateVersion,
      questionVersion: context.operation.questionVersion,
      modelCatalogId: 'typesafe-jev-1.13',
      modelWireId: 'jev-1.13.0',
      evaluationSegment: 'global',
      status: 'approved' as const,
      evidence: 'recorded' as const,
      totalTimeoutMs: 120_000,
      primaryTimeoutMs: 1_000,
      maxAttempts: 2 as const,
    }
    const getApprovedExact = vi.fn(async () => profile)
    const resolver = createWorkspaceDecisionRouteResolver({
      store: { getSystem: vi.fn(async () => ({
        workspaceId: context.workspaceId,
        mode: 'hybrid' as const,
        modelAlias: 'typesafe-jev-1.13',
        updatedAt: 'now',
      })) },
      profileStore: { getApprovedExact },
      configuredAdapterIds: () => ['typesafe'],
    })

    await expect(resolver(context)).resolves.toEqual({
      mode: 'hybrid',
      primaryModelId: 'typesafe-jev-1.13',
      profile,
    })
    expect(getApprovedExact).toHaveBeenCalledWith(expect.objectContaining({
      evaluationSegment: 'global',
    }))
  })

  it('downgrades hybrid to shadow when exact evidence is absent or unreadable', async () => {
    const onError = vi.fn()
    const getApprovedExact = vi.fn()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('registry unavailable'))
    const resolver = createWorkspaceDecisionRouteResolver({
      store: { getSystem: vi.fn(async () => ({
        workspaceId: context.workspaceId,
        mode: 'hybrid' as const,
        modelAlias: 'typesafe-jev-1.13',
        updatedAt: 'now',
      })) },
      profileStore: { getApprovedExact },
      configuredAdapterIds: () => ['typesafe'],
      onError,
    })

    await expect(resolver(context)).resolves.toMatchObject({ mode: 'shadow' })
    await expect(resolver(context)).resolves.toMatchObject({ mode: 'shadow' })
    expect(onError).toHaveBeenCalledOnce()
  })

  it('keeps observation callers in bounded shadow without consulting authority evidence', async () => {
    const getApprovedExact = vi.fn()
    const resolver = createWorkspaceDecisionRouteResolver({
      store: { getSystem: vi.fn(async () => ({
        workspaceId: context.workspaceId,
        mode: 'hybrid' as const,
        modelAlias: 'typesafe-jev-1.13',
        updatedAt: 'now',
      })) },
      profileStore: { getApprovedExact },
      configuredAdapterIds: () => ['typesafe'],
    })

    await expect(resolver({ ...context, kind: 'observation' })).resolves.toMatchObject({
      mode: 'shadow',
      profile: { shadowSampleRate: 0.1 },
    })
    expect(getApprovedExact).not.toHaveBeenCalled()
  })

  it('preserves an injected operator resolver when no workspace preference exists', async () => {
    const fallback = vi.fn(async () => ({ mode: 'llm_only' as const }))
    const resolver = createWorkspaceDecisionRouteResolver({
      store: { getSystem: vi.fn(async () => null) },
      configuredAdapterIds: () => ['typesafe'],
      fallback,
    })
    await expect(resolver(context)).resolves.toEqual({ mode: 'llm_only' })
    expect(fallback).toHaveBeenCalledWith(context)
  })

  it('fails closed on a settings read error', async () => {
    const onError = vi.fn()
    const resolver = createWorkspaceDecisionRouteResolver({
      store: { getSystem: vi.fn(async () => { throw new Error('database unavailable') }) },
      configuredAdapterIds: () => ['typesafe'],
      onError,
    })
    await expect(resolver(context)).resolves.toEqual({ mode: 'llm_only' })
    expect(onError).toHaveBeenCalledOnce()
  })
})
