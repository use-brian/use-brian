import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { buildToolIndex, createMcpSearchTools } from '../../mcp/tool-search.js'
import type { McpSettingsStore } from '../../mcp/types.js'
import { buildTool, type ToolContext } from '../../tools/types.js'
import type { ContentBlock, LLMProvider, StreamChunk } from '../../providers/types.js'
import type { QueryEvent } from '../../engine/query-loop.js'
import type { TurnLedger } from '../../engine/turn-ledger.js'

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
    const result = await runPreflight({
      provider, model: 'fixture', message: 'Check next month travel in calendar and email',
      tools, maxWorkerTurns: 4,
      context: {
        userId: 'user-example', assistantId: 'assistant-example', workspaceId: 'workspace-example',
        sessionId: 'session-example', appId: 'test', channelType: 'telegram', channelId: 'chat-example',
        abortSignal: new AbortController().signal, requestTools: tools, turnLedger: ledger,
      },
      onEvent: event => events.push(event),
    })
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
