import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createMcpInputSchema, escapeMcpDiagnosticText, mcpArgumentError } from '../input-schema.js'
import { wrapMcpTools } from '../connector.js'
import { createMcpGateway } from '../gateway.js'
import { buildToolIndex, createMcpSearchTools } from '../tool-search.js'
import { buildTool, type ToolContext } from '../../tools/types.js'
import type { McpServerConfig, McpSettingsStore } from '../types.js'

const settingsStore: McpSettingsStore = {
  getPolicy: async () => null,
  setPolicy: async () => {},
  recordUsage: async () => {},
  recordUsageAndGetCount: async () => ({ timesAllowed: 0, timesDenied: 0 }),
}
const params = { settingsStore, assistantId: 'a1', userId: 'u1' }
const context = {
  assistantId: 'a1', userId: 'u1', sessionId: 's1', appId: 'Use Brian',
  channelType: 'web', channelId: 'c1', abortSignal: new AbortController().signal,
} as ToolContext
const nestedKey = 'options\0/~'
const missingKey = 'required\0'
const extraKey = 'extra\0\udfff'
const schema = {
  type: 'object',
  properties: {
    [nestedKey]: {
      type: 'object', properties: { [missingKey]: { type: 'string' } },
      required: [missingKey], additionalProperties: false,
    },
  },
  additionalProperties: false,
}
const args = Object.freeze({
  [nestedKey]: Object.freeze({ [extraKey]: 'untouched\0\ud800', 'literal\\u0000': true }),
  [extraKey]: Object.freeze(['value\0']),
})
function diagnostic(tool: string, inputSchema: z.ZodTypeAny = createMcpInputSchema(schema), input: unknown = args) {
  const parsed = inputSchema.safeParse(input)
  if (parsed.success) throw new Error('Expected validation failure')
  return mcpArgumentError(tool, parsed.error)
}

function expectSafe(text: unknown) {
  expect(typeof text).toBe('string')
  expect(text).not.toMatch(/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u)
}

describe('MCP argument diagnostic text', () => {
  it('losslessly escapes controls and lone surrogates, preserving printable Unicode and literal escapes', () => {
    const raw = 'plain café 😀 "quote"\0\b\f\n\r\t\u001b\u007f\u0085\ud800x\udfff\\u0000'
    const escaped = escapeMcpDiagnosticText(raw)
    expect(escaped).toBe('plain café 😀 "quote"\\u0000\\b\\f\\n\\r\\t\\u001b\\u007f\\u0085\\ud800x\\udfff\\\\u0000')
    expectSafe(escaped)
    // Quotes are intentionally printable; quote them only for this round trip.
    expect(JSON.parse(`"${escaped.replaceAll('"', '\\"')}"`)).toBe(raw)
    expect(escapeMcpDiagnosticText('\0')).not.toBe(escapeMcpDiagnosticText('\\u0000'))
  })

  it('escapes issue messages, paths and tool labels while keeping ordinary diagnostics compatible', () => {
    const error = new z.ZodError([{ code: 'custom', path: ['field\0', 2], message: 'bad\0\n\udfff\\u0000' }])
    const text = mcpArgumentError('tool\0\t\ud800', error)
    expectSafe(text)
    expect(text).toContain('"tool\\u0000\\t\\ud800"')
    expect(text).toContain('field\\u0000.2: bad\\u0000\\n\\udfff\\\\u0000')
    expect(mcpArgumentError('get_item', new z.ZodError([
      { code: 'custom', path: [], message: 'Invalid argument' },
      { code: 'custom', path: ['options', 'count'], message: 'must be integer' },
    ]))).toBe('ERROR: invalid arguments for "get_item": (args): Invalid argument; options.count: must be integer. Re-check this tool\'s parameter names and types in its mcp_search entry, then retry.')
  })

  it('escapes remote adapter additional-property, missing and decoded nested paths without changing data or schema', () => {
    const beforeArgs = JSON.stringify(args)
    const beforeSchema = JSON.stringify(schema)
    const text = diagnostic('get_item')
    expectSafe(text)
    expect(text).toContain('extra\\u0000\\udfff: must NOT have additional properties')
    expect(text).toContain('options\\u0000/~.required\\u0000: must have required property')
    expect(text).toContain('options\\u0000/~.extra\\u0000\\udfff: must NOT have additional properties')
    expect(text).toContain('options\\u0000/~.literal\\\\u0000: must NOT have additional properties')
    expect(JSON.stringify(args)).toBe(beforeArgs)
    expect(JSON.stringify(schema)).toBe(beforeSchema)
    expect(args[nestedKey][extraKey]).toBe('untouched\0\ud800')
  })

  it('uses the same formatter for remote dispatch, direct wrappers and the gateway', async () => {
    const dispatch = vi.fn(async () => ({}))
    const server: McpServerConfig = {
      name: 'external', url: 'https://example.invalid/mcp',
      tools: [{ name: 'get_item', description: 'Get an item', inputSchema: schema }],
    }
    const before = JSON.stringify(args)
    const [, call] = createMcpSearchTools({ ...params,
      index: buildToolIndex([{ kind: 'remote', server, serverUrl: server.url, callMcpTool: dispatch }]),
    })
    const [direct] = wrapMcpTools({ ...params, server, callMcpTool: dispatch })
    const gateway = createMcpGateway({ ...params, server, callMcpTool: dispatch })
    const results = [
      await call.execute({ server: server.name, tool: 'get_item', args }, context),
      await direct.execute(args, context),
      await gateway.execute({ action: 'call', tool_name: 'get_item', args }, context),
    ]
    for (const result of results) {
      expect(result.isError).toBe(true)
      expect(result.data).toBe(diagnostic('get_item'))
      expectSafe(result.data)
    }
    expect(JSON.stringify(args)).toBe(before)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('refuses local invalid arguments before resolving confirmation or executing transport', async () => {
    const execute = vi.fn(async () => ({ data: 'should not run' }))
    const resolveConfirmation = vi.fn(async () => true)
    const describeConfirmation = vi.fn(async () => ['should not run'])
    const notify = vi.fn()
    const inputSchema = z.object({ value: z.string() }).superRefine((_, ctx) => {
      ctx.addIssue({ code: 'custom', path: ['nested\0\ud800'], message: 'bad\0\n\udfff' })
    })
    const input = Object.freeze({ value: 'exact\0\ud800' })
    const tool = buildTool({ name: 'create_item', description: 'Create item', inputSchema,
      requiresConfirmation: true, resolveConfirmation, describeConfirmation, execute })
    const [, call] = createMcpSearchTools({ ...params,
      index: buildToolIndex([{ kind: 'local', serverName: 'local', tools: [tool] }]),
    })
    const result = await call.execute({ server: 'local', tool: tool.name, args: input },
      { ...context, notifyConfirmationRequired: notify })
    expect(result.isError).toBe(true)
    expect(result.data).toBe(diagnostic(tool.name, inputSchema, input))
    expectSafe(result.data)
    expect(input).toEqual({ value: 'exact\0\ud800' })
    expect(resolveConfirmation).not.toHaveBeenCalled()
    expect(describeConfirmation).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })
})
