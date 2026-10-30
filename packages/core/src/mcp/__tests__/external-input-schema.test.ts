import { describe, expect, it, vi } from 'vitest'
import { createMcpInputSchema } from '../input-schema.js'
import { wrapMcpTools } from '../connector.js'
import { createMcpGateway } from '../gateway.js'
import { buildToolIndex, createMcpSearchTools } from '../tool-search.js'
import { jsonSchemaFromZod } from '../../engine/query-loop.js'
import type { McpServerConfig, McpSettingsStore } from '../types.js'
import type { ToolContext } from '../../tools/types.js'

const settingsStore: McpSettingsStore = {
  getPolicy: async () => null,
  setPolicy: async () => {},
  recordUsage: async () => {},
  recordUsageAndGetCount: async () => ({ timesAllowed: 0, timesDenied: 0 }),
}
const context = {
  assistantId: 'a1', userId: 'u1', sessionId: 's1', appId: 'Use Brian',
  channelType: 'web', channelId: 'c1', abortSignal: new AbortController().signal,
} as ToolContext
const schema = {
  type: 'object',
  properties: {
    item_id: { type: 'string' },
    options: { $ref: '#/$defs/options' },
  },
  required: ['item_id'],
  additionalProperties: false,
  $defs: {
    options: {
      type: 'object',
      properties: { mode: { enum: ['brief', 'full'] }, count: { type: 'integer', minimum: 1 } },
      additionalProperties: false,
    },
  },
}
const server: McpServerConfig = {
  name: 'external', url: 'https://example.invalid/mcp',
  tools: [{ name: 'get_item', description: 'Get an item', inputSchema: schema }],
}
const params = { settingsStore, assistantId: 'a1', userId: 'u1' }

describe('external MCP input schemas', () => {
  it.each(['http', 'stdio'] as const)('%s preserves the wire schema and rejects invalid arguments before dispatch', async transport => {
    const dispatch = vi.fn(async () => ({ ok: true }))
    const wrapped = wrapMcpTools({ ...params, server, callMcpTool: dispatch })
      .map(tool => ({ ...tool, name: 'get_item' }))
    const index = buildToolIndex([transport === 'http'
      ? { kind: 'remote', server, serverUrl: server.url, callMcpTool: dispatch }
      : { kind: 'local', serverName: server.name, tools: wrapped }])
    const [search, call] = createMcpSearchTools({ ...params, index })
    expect(index.entries[0].inputSchema).toEqual(schema)
    const result = await search.execute({ query: 'get item' }, context)
    expect(String(result.data)).toContain('item_id: string')
    expect(String(result.data)).toContain(JSON.stringify(schema))

    for (const args of [{ id: 'wrong' }, { item_id: 'ok', nonexistent: true }, { item_id: 42 },
      { item_id: 'ok', options: { mode: 'invalid' } }, { item_id: 'ok', options: { count: 0 } }]) {
      const result = await call.execute({ server: server.name, tool: 'get_item', args }, context)
      expect(result.isError).toBe(true)
      expect(String(result.data)).toContain('invalid arguments')
    }
    expect(dispatch).not.toHaveBeenCalled()
    const validArgs = { item_id: 'ok', options: { mode: 'full', count: 2 } }
    expect((await call.execute({ server: server.name, tool: 'get_item', args: validArgs }, context)).isError).toBeFalsy()
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(transport === 'http' ? server.url : server.name, 'get_item', validArgs)
  })

  it('preserves the stdio schema for directly exposed model tools and rejects direct invalid calls', async () => {
    const dispatch = vi.fn(async () => ({}))
    const [tool] = wrapMcpTools({ ...params, server, callMcpTool: dispatch })
    expect(jsonSchemaFromZod(tool.inputSchema)).toEqual(schema)
    expect(tool.inputSchema.safeParse({ id: 'wrong' }).success).toBe(false)
    const result = await tool.execute({ id: 'wrong' }, context)
    expect(String(result.data)).toContain('item_id')
    expect(String(result.data)).toContain('id:')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('validates canonical and legacy workflow aliases', async () => {
    const dispatch = vi.fn(async () => ({}))
    const tools = createMcpSearchTools({ ...params, keepDynamicToolsDirect: true,
      index: buildToolIndex([{ kind: 'remote', server, serverUrl: server.url, callMcpTool: dispatch }]),
    })
    for (const name of ['get_item', 'mcp_external_get_item']) {
      const tool = tools.find(tool => tool.name === name)!
      expect(jsonSchemaFromZod(tool.inputSchema)).toEqual(schema)
      expect(tool.inputSchema.safeParse({ id: 'wrong' }).success).toBe(false)
      expect((await tool.execute({ id: 'wrong' }, context)).isError).toBe(true)
    }
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('validates before requesting remote confirmation', async () => {
    const dispatch = vi.fn(async () => ({}))
    const notify = vi.fn()
    const writeServer = { ...server, tools: [{ ...server.tools[0], name: 'create_item' }] }
    const [, call] = createMcpSearchTools({ ...params,
      index: buildToolIndex([{ kind: 'remote', server: writeServer, serverUrl: server.url, callMcpTool: dispatch }]),
    })
    const result = await call.execute({ server: server.name, tool: 'create_item', args: { id: 'wrong' } },
      { ...context, notifyConfirmationRequired: notify })
    expect(String(result.data)).toContain('item_id')
    expect(notify).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('revalidates hook-modified outbound arguments', async () => {
    const dispatch = vi.fn(async () => ({}))
    const [, call] = createMcpSearchTools({ ...params,
      index: buildToolIndex([{ kind: 'remote', server, serverUrl: server.url, callMcpTool: dispatch }]),
      hooks: { preToolUse: async () => ({ action: 'modify', input: { wrong: 'value' } }) },
    })
    const result = await call.execute({ server: server.name, tool: 'get_item', args: { item_id: 'ok' } }, context)
    expect(String(result.data)).toContain('item_id')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('also validates calls through the legacy gateway', async () => {
    const dispatch = vi.fn(async () => ({}))
    const gateway = createMcpGateway({ ...params, server, callMcpTool: dispatch })
    expect(String((await gateway.execute({ action: 'list' }, context)).data)).toContain(JSON.stringify(schema))
    expect((await gateway.execute({ action: 'call', tool_name: 'get_item', args: { id: 'wrong' } }, context)).isError).toBe(true)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it.each([undefined, 'http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft/2019-09/schema',
    'https://json-schema.org/draft/2020-12/schema'])('supports JSON Schema dialect %s', dialect => {
    const adapter = createMcpInputSchema({ ...schema, ...(dialect ? { $schema: dialect } : {}) })
    expect(adapter.safeParse({ item_id: 'ok' }).success).toBe(true)
    expect(adapter.safeParse({ item_id: 'ok', options: { count: 0 } }).success).toBe(false)
  })

  it('supports compositions, nullable values, and conditional requirements', () => {
    const adapter = createMcpInputSchema({ type: 'object', properties: {
      mode: { enum: ['id', 'query'] }, value: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      limit: { type: 'integer', default: 10 },
    }, required: ['mode'], if: { properties: { mode: { const: 'id' } } }, then: { required: ['value'] } })
    expect(adapter.safeParse({ mode: 'id' }).success).toBe(false)
    expect(adapter.safeParse({ mode: 'id', value: null }).success).toBe(true)
    expect(adapter.safeParse({ mode: 'query' }).data).toEqual({ mode: 'query' })
    expect(adapter.safeParse({ mode: 'query', limit: '2' }).success).toBe(false)
  })

  it('respects schemas that allow additional properties', () => {
    expect(createMcpInputSchema({ type: 'object', properties: {} }).safeParse({ extension: true }).success).toBe(true)
  })

  it('fails closed on malformed or unresolved schemas', () => {
    for (const invalid of [{ type: 'not-a-type' }, { $ref: 'https://example.invalid/missing' }, { $async: true }]) {
      const adapter = createMcpInputSchema(invalid)
      const result = adapter.safeParse({})
      expect(result.success).toBe(false)
      expect(result.error?.issues[0].message).toContain('Cannot validate')
    }
  })

  it('isolates servers that reuse the same schema identifier', () => {
    const first = createMcpInputSchema({ $id: 'urn:tool:args', required: ['first'] })
    const second = createMcpInputSchema({ $id: 'urn:tool:args', required: ['second'] })
    expect(first.safeParse({ first: true }).success).toBe(true)
    expect(second.safeParse({ second: true }).success).toBe(true)
    expect(second.safeParse({ first: true }).success).toBe(false)
  })
})
