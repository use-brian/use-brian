import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type {
  LLMProvider,
  Message,
  ProviderRequest,
  ProviderSession,
  StreamChunk,
} from '../../providers/types.js'
import { buildTool, type Tool, type ToolContext } from '../../tools/types.js'
import {
  createDelegateDocEditTool,
  isolateDocEditToolContext,
  runDocEditAgent,
} from '../edit-agent.js'

const parentContext: ToolContext = {
  userId: 'user-1',
  assistantId: 'assistant-1',
  sessionId: 'session-1',
  appId: 'Use Brian',
  channelType: 'web',
  channelId: 'channel-1',
  workspaceId: 'workspace-1',
  docViewId: 'page-1',
  userMessageText: 'Rewrite the intro',
  abortSignal: new AbortController().signal,
  requestTools: new Map(),
  workerManager: {} as ToolContext['workerManager'],
  createToolInvocationApproval: vi.fn(),
  outboundAttachments: {} as ToolContext['outboundAttachments'],
}

function toolTurn(
  name: string,
  input: Record<string, unknown>,
  narration?: string,
): StreamChunk[] {
  return [
    { type: 'message_start', model: 'fake-model' },
    ...(narration ? [{ type: 'text_delta' as const, text: narration }] : []),
    { type: 'tool_use_start', id: 'call-1', name },
    { type: 'tool_use_delta', id: 'call-1', input: JSON.stringify(input) },
    { type: 'tool_use_end', id: 'call-1' },
    {
      type: 'message_end',
      stopReason: 'tool_use',
      usage: { inputTokens: 20, outputTokens: 5 },
    },
  ]
}

function textTurn(text: string, model = 'fake-model'): StreamChunk[] {
  return [
    { type: 'message_start', model },
    { type: 'text_delta', text },
    {
      type: 'message_end',
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: text.length },
    },
  ]
}

function providerFrom(
  respond: (request: ProviderRequest, call: number) => StreamChunk[],
  requests: ProviderRequest[],
): LLMProvider {
  let call = 0
  return {
    name: 'fake',
    models: ['cheap', 'standard'],
    async *stream(request) {
      // queryLoop appends to its stateless history after the call; snapshot the
      // request so this test observes the actual boundary at call time.
      requests.push({
        ...request,
        messages: [...request.messages],
        tools: request.tools ? [...request.tools] : undefined,
      })
      yield* respond(request, call++)
    },
    createSession(): ProviderSession {
      return {
        async *send(_messages: Message[]) {
          throw new Error('context-clean editor must be stateless')
        },
      }
    },
  }
}

function patchTool(seenContexts: ToolContext[]): Tool {
  return buildTool({
    name: 'patchPage',
    description: 'Patch a page.',
    inputSchema: z.object({ pageId: z.string() }),
    async execute(_input, context) {
      seenContexts.push(context)
      return { data: { pageId: 'page-1', changed: [{ id: 'intro' }] } }
    },
  })
}

describe('[COMP:doc/edit-agent] context-clean Doc editor', () => {
  it('starts with one brief + fresh page context and strips parent capabilities', async () => {
    const requests: ProviderRequest[] = []
    const seenContexts: ToolContext[] = []
    const provider = providerFrom((_request, call) => (
      call === 0
        ? toolTurn('patchPage', { pageId: 'page-1' }, 'I will expose my editing plan.')
        : textTurn('Rewrote the introduction.')
    ), requests)

    const result = await runDocEditAgent({
      provider,
      model: 'cheap',
      systemPrompt: 'isolated editor protocol',
      instruction: 'Rewrite the introduction with a sharper claim.',
      tools: new Map([['patchPage', patchTool(seenContexts)]]),
      context: parentContext,
      loadPageContext: async () => 'pageId=page-1 version=4\nintro: old copy',
    })

    expect(result).toMatchObject({
      status: 'completed',
      mutationTools: ['patchPage'],
      fallbackUsed: false,
      summary: 'Rewrote the introduction.',
    })
    expect(requests[0].messages).toHaveLength(1)
    expect(JSON.stringify(requests[0].messages)).toContain('Rewrite the introduction')
    expect(JSON.stringify(requests[0].messages)).toContain('version=4')
    expect(requests[0].systemPrompt).toBe('isolated editor protocol')
    expect(requests[0].tools?.map((tool) => tool.name)).toEqual(['patchPage'])

    expect(seenContexts).toHaveLength(1)
    expect(seenContexts[0].workspaceId).toBe('workspace-1')
    expect(seenContexts[0].requestTools).toBeUndefined()
    expect(seenContexts[0].workerManager).toBeUndefined()
    expect(seenContexts[0].createToolInvocationApproval).toBeUndefined()
    expect(seenContexts[0].outboundAttachments).toBeUndefined()
  })

  it('uses one fresh Standard fallback only when the cheap run made no mutation', async () => {
    const requests: ProviderRequest[] = []
    const seenContexts: ToolContext[] = []
    const pageLoads = vi.fn(async () => 'pageId=page-1 version=5')
    const provider = providerFrom((request, call) => {
      if (request.model === 'cheap') return textTurn('I need a stronger model.', 'cheap')
      return call === 1
        ? toolTurn('patchPage', { pageId: 'page-1' })
        : textTurn('Updated the page.', 'standard')
    }, requests)

    const result = await runDocEditAgent({
      provider,
      model: 'cheap',
      fallbackModel: 'standard',
      systemPrompt: 'isolated editor protocol',
      instruction: 'Update the page.',
      tools: new Map([['patchPage', patchTool(seenContexts)]]),
      context: parentContext,
      loadPageContext: pageLoads,
    })

    expect(result.status).toBe('completed')
    expect(result.fallbackUsed).toBe(true)
    expect(result.mutationTools).toEqual(['patchPage'])
    expect(pageLoads).toHaveBeenCalledTimes(2)
    expect(requests.map((request) => request.model)).toEqual([
      'cheap',
      'standard',
      'standard',
    ])
  })

  it('returns an error receipt when neither attempt mutates', async () => {
    const requests: ProviderRequest[] = []
    const provider = providerFrom((request) => (
      textTurn('No mutation applied.', request.model)
    ), requests)

    const result = await runDocEditAgent({
      provider,
      model: 'cheap',
      fallbackModel: 'standard',
      systemPrompt: 'isolated editor protocol',
      instruction: 'Do something underspecified.',
      tools: new Map(),
      context: parentContext,
      loadPageContext: async () => 'No active page.',
    })

    expect(result).toMatchObject({
      status: 'failed',
      mutationTools: [],
      fallbackUsed: true,
      error: 'No Doc mutation was applied.',
    })
  })

  it('gateway exposes only the compact brief schema and returns the receipt', async () => {
    const requests: ProviderRequest[] = []
    const provider = providerFrom((_request, call) => (
      call === 0
        ? toolTurn('patchPage', { pageId: 'page-1' })
        : textTurn('Done.')
    ), requests)
    const tool = createDelegateDocEditTool({
      provider,
      model: 'cheap',
      systemPrompt: 'isolated editor protocol',
      tools: new Map([['patchPage', patchTool([])]]),
      loadPageContext: async () => 'pageId=page-1 version=1',
    })

    expect(tool.name).toBe('delegateDocEdit')
    expect(tool.timeoutMs).toBe(180_000)
    expect(tool.inputSchema.safeParse({ instruction: 'Change the heading.' }).success).toBe(true)
    expect(tool.inputSchema.safeParse({ instruction: '', history: [] }).success).toBe(false)

    const result = await tool.execute({ instruction: 'Change the heading.' }, parentContext)
    expect(result.isError).toBe(false)
    expect(result.data).toMatchObject({ status: 'completed', mutationTools: ['patchPage'] })

    const duplicate = await tool.execute({ instruction: 'Change it again.' }, parentContext)
    expect(duplicate.isError).toBe(true)
    expect(duplicate.data).toMatchObject({ error: 'doc_edit_already_delegated' })
    expect(requests).toHaveLength(2)
  })

  it('the allow-list helper never carries nested execution surfaces', () => {
    const isolated = isolateDocEditToolContext(parentContext)
    expect(isolated.userId).toBe(parentContext.userId)
    expect(isolated.requestTools).toBeUndefined()
    expect(isolated.workerManager).toBeUndefined()
    expect(isolated.confirmationResolver).toBeUndefined()
    expect(isolated.notifyConfirmationRequired).toBeUndefined()
  })
})
