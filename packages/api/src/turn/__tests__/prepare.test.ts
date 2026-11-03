import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ContextScopeAccumulator,
  createExecutionContext,
  executionToolContext,
  type CurrentAuthorityBoundary,
  type LLMProvider,
  type Tool,
} from '@use-brian/core'
import { prepareAssistantRun } from '../prepare.js'
import { configureBriefTurnContext, resolveBriefTurn } from '../../briefs/context.js'
import { createNativeAttendedOutputBoundary, tryAssertNativePreparationCurrent, type NativeAttendedOutputBoundary } from '../../application-platform/model-source-authority.js'

const provider = { name: 'fixture', models: ['fixture'] } as LLMProvider
const tool = { name: 'readThing' } as Tool

function execution(authority: CurrentAuthorityBoundary) {
  return createExecutionContext({
    identity: {
      kind: 'attended',
      principal: { kind: 'workspace_member', userId: 'user-1', authenticationKind: 'native_session' },
    },
    ownership: { kind: 'workspace', workspaceId: 'workspace-1' },
    access: {
      workspaceId: 'workspace-1',
      userId: 'user-1',
      assistantId: 'assistant-1',
      assistantKind: 'standard',
      clearance: 'internal',
      compartments: [],
      mutationCompartments: [],
      projectIds: [],
      visibilityAssistantIds: ['assistant-1'],
    },
    writeDefaults: { compartments: [], projectIds: [] },
    authority,
    lifecycle: {
      abortSignal: new AbortController().signal,
      sessionId: 'session-1',
      channelType: 'web',
      channelId: 'channel-1',
    },
  })
}

describe('[COMP:api/assistant-run-preparation] shared preparation stages', () => {
  afterEach(() => { configureBriefTurnContext(null) })
  it('checks current authority, binds the supplied candidate set, and preserves provenance channels', async () => {
    const assertCurrent = vi.fn(async () => {})
    const authority: CurrentAuthorityBoundary = {
      assertCurrent,
      async execute<T>(operation: () => Promise<T>) { return operation() },
    }
    const bindTools = vi.fn((tools: Map<string, Tool>) => tools)
    const prepared = await prepareAssistantRun({
      executionContext: execution(authority),
      model: { provider, model: 'fixture' },
      candidateTools: new Map([[tool.name, tool]]),
      bindTools,
      trustedContributions: [
        { name: 'runtime', content: 'trusted facts' },
        { name: 'blank', content: '  ' },
      ],
      userVisibleContributions: [{ name: 'attachment', content: 'visible facts' }],
    })

    expect(assertCurrent).toHaveBeenCalledOnce()
    expect(bindTools).toHaveBeenCalledWith(expect.any(Map), prepared.executionContext)
    expect([...prepared.tools]).toEqual([[tool.name, tool]])
    expect(prepared.trustedContext).toBe('trusted facts')
    expect(prepared.userVisibleContext).toBe('visible facts')
    expect(prepared.contributionNames).toEqual({
      trusted: ['runtime', 'blank'],
      userVisible: ['attachment'],
    })
  })

  it('does not let a surface binder widen the validated context', async () => {
    const authority: CurrentAuthorityBoundary = {
      async assertCurrent() {},
      async execute<T>(operation: () => Promise<T>) { return operation() },
    }
    const prepared = await prepareAssistantRun({
      executionContext: execution(authority),
      model: { provider, model: 'fixture' },
      candidateTools: new Map([[tool.name, tool]]),
      bindTools: (tools: Map<string, Tool>, context) => {
        expect(context.security.ceiling.compartments).toEqual([])
        return tools
      },
    })
    expect(prepared.tools.size).toBe(1)
  })

  function nativePreparation(assertCurrent = vi.fn(async () => {})) {
    const authority: CurrentAuthorityBoundary = { assertCurrent, async execute<T>(operation: () => Promise<T>) { return operation() } }
    const ec = execution(authority), accumulator = new ContextScopeAccumulator()
    const context = { ...executionToolContext(ec, { appId: 'fictional-native-preparation' }), scopeAccumulator: accumulator }
    const boundary = createNativeAttendedOutputBoundary(ec, accumulator, {
      workspaceId: 'workspace-1', assistantId: 'assistant-1', userId: 'user-1', sessionId: 'session-1',
      channelType: 'web', channelId: 'channel-1', recipientType: 'individual',
    })
    const full = vi.fn(async () => {})
    const input = {
      executionContext: ec, model: { provider, model: 'fixture' }, candidateTools: new Map([[tool.name, tool]]),
      bindTools: vi.fn((tools: Map<string, Tool>) => tools),
      beforeAssembly: async (canonicalBrief: boolean) => {
        if (canonicalBrief && await tryAssertNativePreparationCurrent(boundary, context)) return
        await full()
      },
    }
    return { authority, ec, context, boundary, input, full }
  }

  it.each(['absent', 'canonical'] as const)('uses only the original lease for canonical personal assembly with %s Brief configuration', async mode => {
    configureBriefTurnContext(mode === 'canonical' ? resolveBriefTurn : null)
    const f = nativePreparation()
    const prepared = await prepareAssistantRun(f.input)
    expect(f.full).not.toHaveBeenCalled()
    expect(f.authority.assertCurrent).toHaveBeenCalledTimes(2)
    expect(prepared.tools.size).toBe(1)
  })

  it('keeps the full preflight before a captured custom Brief resolver', async () => {
    const order: string[] = []
    const custom = vi.fn(async () => { order.push('brief'); return null })
    configureBriefTurnContext(custom)
    const f = nativePreparation(vi.fn(async () => { configureBriefTurnContext(resolveBriefTurn) }))
    f.full.mockImplementation(async () => { order.push('full') })
    await prepareAssistantRun(f.input)
    expect(order).toEqual(['full', 'brief'])
    expect(custom).toHaveBeenCalledOnce()
  })

  it('does not invoke a custom Brief replacement installed during the preparation lease await', async () => {
    const custom = vi.fn(async () => null)
    const f = nativePreparation(vi.fn(async () => { configureBriefTurnContext(custom) }))
    await prepareAssistantRun(f.input)
    expect(f.full).not.toHaveBeenCalled()
    expect(custom).not.toHaveBeenCalled()
    await prepareAssistantRun(f.input)
    expect(f.full).toHaveBeenCalledOnce()
    expect(custom).toHaveBeenCalledOnce()
  })

  it('checks the pre-assembly guard before arbitrary candidate and binder callbacks', async () => {
    const f = nativePreparation()
    const candidateTools = vi.fn(() => f.input.candidateTools)
    const beforeAssembly = vi.fn(async () => { throw new Error('Fictional preparation refusal') })
    await expect(prepareAssistantRun({ ...f.input, candidateTools, beforeAssembly })).rejects.toThrow('Fictional preparation refusal')
    expect(candidateTools).not.toHaveBeenCalled()
    expect(f.input.bindTools).not.toHaveBeenCalled()
  })

  it('does not recognize a copied boundary as the native assembly owner', async () => {
    const f = nativePreparation()
    expect(await tryAssertNativePreparationCurrent({ ...f.boundary } as NativeAttendedOutputBoundary, f.context)).toBe(false)
  })

  it('rejects a replaced authority or accumulator instead of treating it as a new assembly owner', async () => {
    for (const replacement of ['authority', 'scopeAccumulator'] as const) {
      const f = nativePreparation()
      const context = { ...f.context, [replacement]: replacement === 'authority'
        ? { assertCurrent: vi.fn(async () => {}), execute: f.authority.execute } : new ContextScopeAccumulator() }
      await expect(tryAssertNativePreparationCurrent(f.boundary, context)).rejects.toMatchObject({ reason: 'authority_changed' })
      await expect(tryAssertNativePreparationCurrent(f.boundary, f.context)).rejects.toMatchObject({ reason: 'authority_changed' })
    }
  })

  it('refuses an authority method replaced before the private preparation handoff', async () => {
    const f = nativePreparation()
    f.authority.assertCurrent = vi.fn(async () => {})
    await expect(prepareAssistantRun(f.input)).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(f.authority.assertCurrent).not.toHaveBeenCalled()
    expect(f.input.bindTools).not.toHaveBeenCalled()
  })

  it('refuses method replacement while the original lease check is pending', async () => {
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const f = nativePreparation(vi.fn(() => pending))
    const result = tryAssertNativePreparationCurrent(f.boundary, f.context)
    f.authority.assertCurrent = vi.fn(async () => {})
    release()
    await expect(result).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(f.authority.assertCurrent).not.toHaveBeenCalled()
  })

  it('keeps original lease refusal sticky through later preparation attempts', async () => {
    const check = vi.fn(async (): Promise<void> => { throw new Error('Fictional revoked lease') })
    const f = nativePreparation(check)
    await expect(tryAssertNativePreparationCurrent(f.boundary, f.context)).rejects.toMatchObject({ reason: 'authority_changed' })
    check.mockResolvedValue(undefined)
    await expect(tryAssertNativePreparationCurrent(f.boundary, f.context)).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(check).toHaveBeenCalledOnce()
  })
})
