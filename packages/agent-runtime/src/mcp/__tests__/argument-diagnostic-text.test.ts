import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createMcpInputSchema, escapeMcpDiagnosticText, mcpArgumentError } from '../input-schema.js'
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

})
