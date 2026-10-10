import { describe, expect, it, vi } from 'vitest'
import {
  createExecutionContext,
  type CurrentAuthorityBoundary,
  type LLMProvider,
  type Tool,
} from '@use-brian/core'
import { prepareAssistantRun } from '../prepare.js'

const provider = { name: 'fixture', models: ['fixture'] } as LLMProvider
const tool = { name: 'readThing' } as Tool

function execution(authority: CurrentAuthorityBoundary) {
  return createExecutionContext({
    identity: {
      kind: 'attended',
      principal: { kind: 'workspace_member', userId: 'user-1' },
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
})
