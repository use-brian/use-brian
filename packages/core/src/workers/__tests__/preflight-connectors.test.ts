import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { buildToolIndex, createMcpSearchTools } from '../../mcp/tool-search.js'
import type { McpSettingsStore } from '@use-brian/agent-runtime/mcp/types.js'
import { buildTool, type ToolContext } from '@use-brian/agent-runtime/tools/types.js'
import type { ContentBlock, LLMProvider, StreamChunk } from '@use-brian/agent-runtime/providers/types.js'
import type { QueryEvent } from '@use-brian/agent-runtime/engine/query-loop.js'
import type { TurnLedger } from '@use-brian/agent-runtime/engine/turn-ledger.js'

vi.mock('../splitter.js', () => ({
  classifySplit: async () => ({ tasks: ['calendar lookup', 'email lookup'], usage: null, model: null }),
}))

import { runPreflight } from '../preflight.js'

describe('[COMP:workers/preflight] connector read execution', () => {
  it('discovers and reads calendar and email through governed adapters with recorded results and no write access', async () => {
    const calendarRead = vi.fn(async (_input: unknown, context: ToolContext) => {
      expect(context.userId).toBe('user-example')
      expect(context.workspaceId).toBe('workspace-example')
      expect(context.requestTools?.has('mcp_call')).toBe(false)
      return { data: 'calendar booking: 2030-11-12' }
    })
    const emailRead = vi.fn(async () => ({ data: 'email confirmation: ABC123' }))
    const write = vi.fn(async () => ({ data: 'must not execute' }))
    const makeTool = (name: string, execute: (input: unknown, context: ToolContext) => Promise<{ data: string }>, isReadOnly = true) => buildTool({
      name, description: name, inputSchema: z.object({}), isReadOnly,
      isConcurrencySafe: true, requiresConfirmation: false, execute,
    })
    const tools = new Map(createMcpSearchTools({
      index: buildToolIndex([
        { kind: 'local', serverName: 'gcal', tools: [
          makeTool('googleCalendarListEvents', calendarRead),
          makeTool('googleCalendarCreateEvent', write, false),
        ] },
        { kind: 'local', serverName: 'imap', tools: [
          makeTool('imapSearchMessages', emailRead),
          makeTool('imapSendMessage', write, false),
        ] },
      ]),
      assistantId: 'assistant-example', userId: 'user-example',
      settingsStore: { getPolicy: async () => null } as unknown as McpSettingsStore,
      exposeLocalReadTools: true,
    }).map(tool => [tool.name, tool]))

    const provider: LLMProvider = {
      name: 'fixture', models: ['fixture'],
      createSession() { throw new Error('Workers must use the stateless provider') },
      async *stream(request): AsyncIterable<StreamChunk> {
        const names = request.tools?.map(tool => tool.name) ?? []
        expect(names).toContain('googleCalendarListEvents')
        expect(names).toContain('imapSearchMessages')
        expect(names).not.toContain('mcp_call')
        expect(names).not.toContain('googleCalendarCreateEvent')
        expect(names).not.toContain('imapSendMessage')
        const isCalendar = JSON.stringify(request.messages[0]).includes('calendar lookup')
        const readName = isCalendar ? 'googleCalendarListEvents' : 'imapSearchMessages'
        const blocks = request.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
        const results = blocks.filter((block): block is Extract<ContentBlock, { type: 'tool_result' }> => block.type === 'tool_result')
        const readResult = results.find(block => block.name === readName)
        yield { type: 'message_start', model: 'fixture' }
        if (readResult) {
          expect(readResult.isError).not.toBe(true)
          yield { type: 'text_delta', text: readResult.content }
          yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }
          return
        }
        const discovery = results.find(block => block.name === 'mcp_search')
        if (discovery) {
          expect(discovery.content).toContain(readName)
          expect(discovery.content).not.toContain('Use mcp_call')
        }
        const name = discovery ? readName : 'mcp_search'
        const args = discovery ? {} : { query: readName, limit: 1 }
        yield { type: 'tool_use_start', id: `${readName}-${results.length}`, name }
        yield { type: 'tool_use_delta', id: `${readName}-${results.length}`, input: JSON.stringify(args) }
        yield { type: 'tool_use_end', id: `${readName}-${results.length}` }
        yield { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const recordedTurns: Array<{ toolResults: ContentBlock[] }> = []
    const ledger: TurnLedger = {
      startTrace: () => ({
        traceId: 'trace-example', request() {}, retrieval() {}, event() {},
        turn: info => { recordedTurns.push(info) },
      }),
    }
    const events: QueryEvent[] = []
    const usage: Array<{ model: string; usage: { inputTokens: number; outputTokens: number } }> = []
    let releaseBilling!: () => void
    const billing = new Promise<void>(resolve => { releaseBilling = resolve })
    let complete = false
    const running = runPreflight({
      provider, model: 'fixture', message: 'Check next month travel in calendar and email',
      tools, maxWorkerTurns: 4,
      onUsage: async event => { usage.push(event); await billing },
      context: {
        userId: 'user-example', assistantId: 'assistant-example', workspaceId: 'workspace-example',
        sessionId: 'session-example', appId: 'test', channelType: 'telegram', channelId: 'chat-example',
        abortSignal: new AbortController().signal, requestTools: tools, turnLedger: ledger,
      },
      onEvent: event => events.push(event),
    }).then(result => { complete = true; return result })
    await vi.waitFor(() => expect(usage).toHaveLength(2))
    expect(complete).toBe(false)
    releaseBilling()
    const result = await running
    expect(usage.every(event => event.model === 'fixture' && event.usage.inputTokens > 0)).toBe(true)

    expect(result.type).toBe('researched')
    if (result.type !== 'researched') throw new Error('Missing research')
    expect(result.context).toContain('calendar booking: 2030-11-12')
    expect(result.context).toContain('email confirmation: ABC123')
    expect(calendarRead).toHaveBeenCalledOnce()
    expect(emailRead).toHaveBeenCalledOnce()
    expect(write).not.toHaveBeenCalled()
    const readResults = (blocks: ContentBlock[]) => blocks.filter(block =>
      block.type === 'tool_result' && ['googleCalendarListEvents', 'imapSearchMessages'].includes(block.name))
    expect(readResults(recordedTurns.flatMap(turn => turn.toolResults))).toHaveLength(2)
    expect(readResults(events.flatMap(event => event.type === 'tool_result' ? event.results : []))).toHaveLength(2)
    // Worker schema promotion must not mutate the parent's deferred adapters.
    expect(tools.get('imapSearchMessages')?.deferredSchemaOnly).toBe(true)
  })
})

it('[COMP:workers/preflight] retains the original accounting callback across deferred classification', async () => {
  const original = vi.fn(async () => {}), successor = vi.fn(async () => {})
  let classify!: (value: { tasks: string[]; usage: null; model: null }) => void
  const classified = new Promise<{ tasks: string[]; usage: null; model: null }>(resolve => { classify = resolve })
  const provider: LLMProvider = {
    name: 'fixture', models: ['fixture'], createSession() { throw new Error('Expected stateless worker') },
    async *stream(): AsyncIterable<StreamChunk> {
      yield { type: 'message_start', model: 'fixture' }
      yield { type: 'text_delta', text: 'Original finding' }
      yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 4, outputTokens: 2 } }
    },
  }
  const options: Parameters<typeof runPreflight>[0] = {
    provider, model: 'fixture', message: 'Look up one source', tools: new Map(), classify: () => classified,
    context: { userId: 'original-user', assistantId: 'original-assistant', workspaceId: 'original-workspace', sessionId: 'original-session',
      appId: 'fixture', channelType: 'web', channelId: 'original-channel', abortSignal: new AbortController().signal },
    onUsage: original,
  }
  const running = runPreflight(options)
  options.onUsage = successor
  classify({ tasks: ['one source'], usage: null, model: null })
  expect((await running).type).toBe('researched')
  expect(original).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ userId: 'original-user', assistantId: 'original-assistant', sessionId: 'original-session', usage: expect.objectContaining({ inputTokens: 4, outputTokens: 2 }) }))
  expect(successor).not.toHaveBeenCalled()
})
