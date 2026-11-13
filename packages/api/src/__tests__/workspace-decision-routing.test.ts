import { describe, expect, it, vi } from 'vitest'
import {
  classifierFirstGrant,
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

  it.each(['', '  '])('treats a blank optional operation scope as unset (%j)', scope => {
    expect(parseOperatorDecisionDefault(undefined, undefined, scope)).toBeUndefined()
    for (const mode of ['operator_hybrid', 'classifier_first']) {
      expect(parseOperatorDecisionDefault(mode, 'typesafe-jev-1.13', scope)).toEqual({
        mode, modelAlias: 'typesafe-jev-1.13',
      })
    }
  })

  it('limits an operator default to explicitly named operations', async () => {
    const operatorDefault = parseOperatorDecisionDefault('operator_hybrid', 'typesafe-jev-1.13', 'chat.tool-selection')
    expect(operatorDefault?.operationIds).toEqual(['chat.tool-selection'])
    expect(() => parseOperatorDecisionDefault(undefined, undefined, 'chat.tool-selection')).toThrow(/required together/)
    expect(() => parseOperatorDecisionDefault('operator_hybrid', 'typesafe-jev-1.13', 'chat.tool-selection,')).toThrow(/exact operation/)
    const resolver = createWorkspaceDecisionRouteResolver({
      store: { getSystem: vi.fn(async () => null) }, configuredAdapterIds: () => ['typesafe'], operatorDefault,
    })
    await expect(resolver(context)).resolves.toEqual({ mode: 'llm_only' })
    await expect(resolver({ ...context, operation: { ...context.operation, id: 'chat.tool-selection' } })).resolves.toMatchObject({
      mode: 'hybrid', operatorOverride: true,
    })
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

  it('builds a version-matched default-sample shadow profile for a configured adapter', async () => {
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

  it('keeps observation callers in default-sample shadow without consulting authority evidence', async () => {
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


describe('[COMP:decisions/workspace-routing] explicit classifier-first authority', () => {
  const modelAlias = 'typesafe-jev-1.13'
  const operatorDefault = { mode: 'classifier_first' as const, modelAlias }
  const setting = (mode: 'hybrid' | 'shadow' | 'llm_only', alias: string | null = modelAlias) => ({
    workspaceId: context.workspaceId, mode, modelAlias: alias, updatedAt: 'now',
  })
  const approvedProfile = {
    id: 'approved-outside-scope', version: '1', mode: 'hybrid' as const,
    operationId: context.operation.id, operationVersion: '2', stateVersion: '3', questionVersion: '4',
    modelCatalogId: modelAlias, modelWireId: 'jev-1.13.0', evaluationSegment: 'global',
    status: 'approved' as const, evidence: 'recorded' as const,
    totalTimeoutMs: 120_000, primaryTimeoutMs: 1_000, maxAttempts: 2 as const,
  }

  it('parses an explicit new-mode pair and deduplicates exact scope', () => {
    expect(parseOperatorDecisionDefault(' classifier_first ', ` ${modelAlias} `)).toEqual(operatorDefault)
    expect(parseOperatorDecisionDefault('classifier_first', modelAlias, 'fixture.intent, chat.tool-selection,fixture.intent'))
      .toEqual({ ...operatorDefault, operationIds: ['fixture.intent', 'chat.tool-selection'] })
    expect(parseOperatorDecisionDefault(' ', ' ')).toBeUndefined()
  })

  it.each([
    ['classifier_first', undefined, undefined], [undefined, modelAlias, undefined],
    ['CLASSIFIER_FIRST', modelAlias, undefined], ['classifier-first', modelAlias, undefined],
    ['', modelAlias, undefined], [undefined, undefined, 'fixture.intent'],
  ])('rejects partial/invalid configuration (%s, %s, %s)', (mode, model, scope) => {
    expect(() => parseOperatorDecisionDefault(mode, model, scope)).toThrow(/required together/)
  })

  it.each(['not-a-model', 'gemini-3.6-flash-standard'])('rejects non-decision model %s', model => {
    expect(() => parseOperatorDecisionDefault('classifier_first', model)).toThrow(/active decision model/)
  })

  it.each(['fixture.*', 'fixture.intent,', ',fixture.intent', 'Fixture.intent', 'fixture.intent other'])
    ('rejects non-exact operation scope %j', scope => {
      expect(() => parseOperatorDecisionDefault('classifier_first', modelAlias, scope)).toThrow(/exact operation/)
    })

  it('grants only the exact new-mode model and a nonempty explicit scope', () => {
    expect(classifierFirstGrant(operatorDefault, modelAlias)).toEqual({ operationIds: null })
    const operationIds = ['fixture.intent']
    const grant = classifierFirstGrant({ ...operatorDefault, operationIds }, modelAlias)
    expect(grant).toEqual({ operationIds })
    expect(grant?.operationIds).not.toBe(operationIds)
    for (const alias of [null, 'typesafe-jev-1.13 ', 'not-a-model']) {
      expect(classifierFirstGrant(operatorDefault, alias)).toBeNull()
    }
    expect(classifierFirstGrant(undefined, modelAlias)).toBeNull()
    expect(classifierFirstGrant({ ...operatorDefault, mode: 'operator_hybrid' }, modelAlias)).toBeNull()
    expect(classifierFirstGrant({ ...operatorDefault, operationIds: [] }, modelAlias)).toBeNull()
  })

  it.each([false, true])('routes every execution through exact operator metadata (saved hybrid=%s)', async saved => {
    const getApprovedExact = vi.fn(async () => { throw new Error('must not consult approval') })
    const resolver = createWorkspaceDecisionRouteResolver({
      store: { getSystem: vi.fn(async () => saved ? setting('hybrid') : null) },
      profileStore: { getApprovedExact }, configuredAdapterIds: () => ['typesafe'], operatorDefault,
    })
    for (let index = 0; index < 12; index++) {
      const route = await resolver(context)
      expect(route).toEqual({
        mode: 'hybrid', primaryModelId: modelAlias, operatorOverride: true,
        allowOperationalFailover: true, allowInvalidResponseRecovery: true,
        profile: {
          id: `operator-default:${modelAlias}:fixture.intent`, version: '1', mode: 'hybrid',
          operationId: 'fixture.intent', operationVersion: '2', stateVersion: '3', questionVersion: '4',
          modelCatalogId: modelAlias, modelWireId: 'jev-1.13.0', evaluationSegment: 'global',
          status: 'operator_override', evidence: 'operator_override', totalTimeoutMs: 120_000,
          primaryTimeoutMs: 1_000, maxAttempts: 2, policy: { authority: 'deployment_operator_override' },
        },
      })
    }
    const observation = await resolver({ ...context, kind: 'observation' })
    expect(observation).toMatchObject({ mode: 'shadow', profile: { mode: 'shadow', shadowSampleRate: 1,
      status: 'operator_override', evidence: 'operator_override' } })
    expect(observation).not.toHaveProperty('operatorOverride')
    expect(getApprovedExact).not.toHaveBeenCalled()
  })

  it.each(['llm_only', 'shadow'] as const)('preserves explicit %s opt-out', async mode => {
    const getApprovedExact = vi.fn()
    const resolver = createWorkspaceDecisionRouteResolver({
      store: { getSystem: vi.fn(async () => setting(mode, mode === 'llm_only' ? null : modelAlias)) },
      profileStore: { getApprovedExact }, configuredAdapterIds: () => ['typesafe'], operatorDefault,
    })
    const route = await resolver(context)
    if (mode === 'llm_only') expect(route).toEqual({ mode: 'llm_only' })
    else expect(route).toMatchObject({ mode: 'shadow', profile: { shadowSampleRate: 0.1, evidence: 'synthetic' } })
    expect(route).not.toHaveProperty('operatorOverride')
    expect(getApprovedExact).not.toHaveBeenCalled()
  })

  it.each(['approved', 'missing', 'unreadable', 'unavailable'] as const)
    ('keeps out-of-scope saved hybrid subject to exact evidence (%s)', async evidence => {
      const getApprovedExact = vi.fn(async () => {
        if (evidence === 'unreadable') throw new Error('registry unavailable')
        return evidence === 'approved' ? approvedProfile : null
      })
      const onError = vi.fn()
      const resolver = createWorkspaceDecisionRouteResolver({
        store: { getSystem: vi.fn(async () => setting('hybrid')) },
        ...(evidence !== 'unavailable' ? { profileStore: { getApprovedExact } } : {}),
        configuredAdapterIds: () => ['typesafe'], onError,
        operatorDefault: { ...operatorDefault, operationIds: ['chat.tool-selection'] },
      })
      const route = await resolver(context)
      if (evidence === 'approved') expect(route).toEqual({ mode: 'hybrid', primaryModelId: modelAlias, profile: approvedProfile })
      else expect(route).toMatchObject({ mode: 'shadow', profile: { shadowSampleRate: 0.1 } })
      expect(route).not.toHaveProperty('operatorOverride')
      expect(onError).toHaveBeenCalledTimes(evidence === 'unreadable' ? 1 : 0)
      if (evidence !== 'unavailable') expect(getApprovedExact).toHaveBeenCalledWith({
        operation: context.operation, modelCatalogId: modelAlias, modelWireId: 'jev-1.13.0', evaluationSegment: 'global',
      })
      getApprovedExact.mockClear()
      const observation = await resolver({ ...context, kind: 'observation' })
      expect(observation).toMatchObject({ mode: 'shadow', profile: { shadowSampleRate: 0.1 } })
      expect(observation).not.toHaveProperty('operatorOverride')
      expect(getApprovedExact).not.toHaveBeenCalled()
    })

  it.each([
    { modelAlias: 'typesafe-jev-1.13', adapterId: 'typesafe', wireId: 'jev-1.13.0' },
    { modelAlias: 'openai-decisions-gpt-6-luna', adapterId: 'openai-decisions', wireId: 'gpt-6-luna' },
  ])('keeps explicit $modelAlias shadow at its saved sample rate and non-authoritative under a matching classifier-first override', async ({ modelAlias, adapterId, wireId }) => {
    for (const shadowSampleRate of [undefined, 0.1, 1] as const) {
      const getApprovedExact = vi.fn()
      const resolver = createWorkspaceDecisionRouteResolver({
        store: { getSystem: vi.fn(async () => ({ ...setting('shadow', modelAlias), shadowSampleRate })) },
        profileStore: { getApprovedExact },
        configuredAdapterIds: () => [adapterId],
        operatorDefault: { mode: 'classifier_first', modelAlias, operationIds: [context.operation.id] },
      })

      for (const kind of ['execution', 'observation'] as const) {
        const route = await resolver({ ...context, kind })
        expect(route).toMatchObject({
          mode: 'shadow', primaryModelId: modelAlias,
          profile: {
            mode: 'shadow', shadowSampleRate: shadowSampleRate ?? 0.1,
            operationId: context.operation.id, operationVersion: context.operation.version,
            stateVersion: context.operation.stateVersion, questionVersion: context.operation.questionVersion,
            modelCatalogId: modelAlias, modelWireId: wireId,
            status: 'evaluation', evidence: 'synthetic',
          },
        })
        expect(route).not.toHaveProperty('operatorOverride')
        expect(route).not.toHaveProperty('allowOperationalFailover')
        expect(route).not.toHaveProperty('allowInvalidResponseRecovery')
        expect(route.profile).not.toHaveProperty('policy.authority')
      }
      expect(getApprovedExact).not.toHaveBeenCalled()
    }
  })

  it('does not broaden legacy operator_hybrid to an explicit hybrid selection', async () => {
    const resolver = createWorkspaceDecisionRouteResolver({
      store: { getSystem: vi.fn(async () => setting('hybrid')) }, configuredAdapterIds: () => ['typesafe'],
      operatorDefault: { ...operatorDefault, mode: 'operator_hybrid' },
    })
    const route = await resolver(context)
    expect(route).toMatchObject({ mode: 'shadow', profile: { shadowSampleRate: 0.1 } })
    expect(route).not.toHaveProperty('operatorOverride')
  })

  it('does not grant authority from an adapter alone, nonmatching model, or empty scope', async () => {
    for (const preference of [undefined, { ...operatorDefault, modelAlias: 'other-model' }, { ...operatorDefault, operationIds: [] }]) {
      const resolver = createWorkspaceDecisionRouteResolver({
        store: { getSystem: vi.fn(async () => setting('hybrid')) }, configuredAdapterIds: () => ['typesafe'],
        operatorDefault: preference,
      })
      const route = await resolver(context)
      expect(route).toMatchObject({ mode: 'shadow', profile: { shadowSampleRate: 0.1 } })
      expect(route).not.toHaveProperty('operatorOverride')
    }
  })

  it.each([false, true])('fails closed when the adapter is unavailable (saved hybrid=%s)', async saved => {
    const resolver = createWorkspaceDecisionRouteResolver({
      store: { getSystem: vi.fn(async () => saved ? setting('hybrid') : null) },
      configuredAdapterIds: () => [], operatorDefault,
    })
    expect(await resolver(context)).toEqual({ mode: 'llm_only' })
  })

  it('fails closed on settings failure rather than treating it as no row', async () => {
    const onError = vi.fn(), fallback = vi.fn()
    const failure = new Error('settings unavailable')
    const resolver = createWorkspaceDecisionRouteResolver({
      store: { getSystem: vi.fn(async () => { throw failure }) },
      configuredAdapterIds: () => ['typesafe'], operatorDefault, onError, fallback,
    })
    expect(await resolver(context)).toEqual({ mode: 'llm_only' })
    expect(onError).toHaveBeenCalledWith(failure, context)
    expect(fallback).not.toHaveBeenCalled()
  })

  it('does not apply workspace authority without a workspace or outside no-row scope', async () => {
    const getSystem = vi.fn(async () => null)
    const fallback = vi.fn(async () => ({ mode: 'llm_only' as const }))
    const resolver = createWorkspaceDecisionRouteResolver({ store: { getSystem }, fallback,
      configuredAdapterIds: () => ['typesafe'], operatorDefault: { ...operatorDefault, operationIds: ['other.intent'] } })
    expect(await resolver({ ...context, workspaceId: undefined })).toEqual({ mode: 'llm_only' })
    expect(getSystem).not.toHaveBeenCalled()
    expect(await resolver(context)).toEqual({ mode: 'llm_only' })
    expect(fallback).toHaveBeenCalledTimes(2)
  })
})

describe('explicit workspace classifier-first', () => {
  it.each(['typesafe-jev-1.13', 'openai-decisions-gpt-6-luna'])('selects %s without deployment authority or approval', async modelAlias => {
    for (const operatorDefault of [undefined, { mode: 'classifier_first' as const, modelAlias: modelAlias === 'typesafe-jev-1.13' ? 'openai-decisions-gpt-6-luna' : 'typesafe-jev-1.13', operationIds: [] }]) {
      const getApprovedExact = vi.fn()
      const resolver = createWorkspaceDecisionRouteResolver({
        store: { getSystem: async () => ({ workspaceId: context.workspaceId, mode: 'classifier_first', modelAlias, updatedAt: 'now' }) },
        configuredAdapterIds: () => ['typesafe', 'openai-decisions'], operatorDefault,
        profileStore: { getApprovedExact },
      })
      const route = await resolver(context)
      expect(route).toMatchObject({ mode: 'hybrid', primaryModelId: modelAlias, operatorOverride: true,
        allowOperationalFailover: true, allowInvalidResponseRecovery: true,
        profile: { mode: 'hybrid', status: 'operator_override', evidence: 'operator_override',
          operationId: context.operation.id, operationVersion: '2', stateVersion: '3', questionVersion: '4',
          evaluationSegment: 'global', modelCatalogId: modelAlias, policy: { authority: 'workspace_admin_override' } } })
      expect(route.profile?.modelWireId).toBe(modelAlias === 'typesafe-jev-1.13' ? 'jev-1.13.0' : 'gpt-6-luna')
      const observation = await resolver({ ...context, kind: 'observation' })
      expect(observation).toMatchObject({ mode: 'shadow', primaryModelId: modelAlias, profile: { mode: 'shadow', shadowSampleRate: 1 } })
      expect(observation.operatorOverride).toBeUndefined()
      expect(getApprovedExact).not.toHaveBeenCalled()
    }
  })

  it.each(['missing-adapter', 'invalid-alias', 'missing-alias', 'store-error'])('fails closed for %s despite a deployment default', async failure => {
    const resolver = createWorkspaceDecisionRouteResolver({
      store: { getSystem: async () => {
        if (failure === 'store-error') throw new Error('unavailable')
        return { workspaceId: context.workspaceId, mode: 'classifier_first', modelAlias: failure === 'invalid-alias' ? 'invalid' : failure === 'missing-alias' ? null : 'typesafe-jev-1.13', updatedAt: 'now' }
      } },
      configuredAdapterIds: () => failure === 'missing-adapter' ? [] : ['typesafe'],
      operatorDefault: { mode: 'classifier_first', modelAlias: 'typesafe-jev-1.13' },
    })
    await expect(resolver(context)).resolves.toEqual({ mode: 'llm_only' })
  })
})
