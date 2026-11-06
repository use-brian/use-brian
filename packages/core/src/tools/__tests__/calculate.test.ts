import { Decimal } from 'decimal.js'
import { describe, expect, it, vi } from 'vitest'
import { calculateTool } from '../base/calculate.js'

const ctx = {
  userId: 'test-user', assistantId: 'test-assistant', sessionId: 'test-session',
  appId: 'test', channelType: 'web', channelId: 'test-channel',
  abortSignal: new AbortController().signal,
}

async function calculate(expression: string) {
  return calculateTool.execute({ expression }, ctx)
}

describe('[COMP:tools/base] calculate', () => {
  it.each([
    ['2 + 3 * 4', '14'], ['(2 + 3) * 4', '20'],
    ['0.1 + 0.2', '0.3'], ['19.99 * 3', '59.97'],
    ['200 * 15 / 100', '30'], ['9007199254740993 + 1', '9007199254740994'],
    ['10 - 3 - 2', '5'], ['20 / 2 / 5', '2'],
    ['-2^2', '-4'], ['(-2)^2', '4'], ['2^3^2', '512'], ['2^-3', '0.125'],
    ['--2 + +3', '5'], ['1e3 + .5 + 2.5E-1', '1000.75'],
    ['\n ( 12.5 + 7.5 ) * 3\t', '60'], ['-0', '0'],
    ['1 / 3', `0.${'3'.repeat(40)}`],
  ])('evaluates %s', async (expression, expected) => {
    const result = await calculate(expression)
    expect(result.isError).toBeFalsy()
    expect(result.data).toEqual({ expression, result: expected, precision: 40 })
  })

  it.each([
    '', ' ', '1 +', '()', '(1 + 2', '1 + 2)', '1 2', '2(3)',
    '1,000 + 2', '15%', '2 ** 3', '1e', '0x10', 'NaN', 'Infinity',
    'Math.sqrt(4)', 'process.exit()', 'globalThis', '1; 2', '1 // 2',
    '1 / 0', '0 / 0', '0^-1', '2^0.5', '2^1001', '2^-1001',
    '1e1001', '1e-1001', '1e1000 * 10', '1e-1000 / 10',
    '('.repeat(65) + '1' + ')'.repeat(65), '-'.repeat(65) + '1',
    '1^'.repeat(65) + '1', '1'.repeat(2049),
  ])('rejects unsupported or unsafe input %s', async (expression) => {
    const result = await calculate(expression)
    expect(result.isError).toBe(true)
    expect(typeof result.data).toBe('string')
  })

  it('rejects JavaScript injection without executing any payload', async () => {
    const probe = vi.fn()
    vi.stubGlobal('__calculatorInjectionProbe', probe)
    const call = 'globalThis.__calculatorInjectionProbe()'
    try {
      for (const expression of [
        call, `1;${call}`, `1,${call}`, `1+(${call})`,
        `(()=>{${call}})()`, `eval("${call}")`, `Function("${call}")()`,
        `({}).constructor.constructor("${call}")()`,
        `[]['filter']['constructor']("${call}")()`,
        '`' + '${' + call + '}' + '`',
        'import("node:fs")', 'require("node:child_process")',
        '__proto__', 'constructor', '1/*comment*/+2', '1//comment\n+2',
        '1\\u002b2', '1\u0000+2', '１+２', '1\u202e+2',
        '1\u00a0+2', '1\u2028+2', '1\u200b+2',
      ]) {
        expect((await calculate(expression)).isError, expression).toBe(true)
      }
      expect(probe).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects non-string direct calls without invoking coercion hooks', async () => {
    const coerce = vi.fn(() => '1+2')
    for (const expression of [null, undefined, 123, [], {}, {
      toString: coerce, valueOf: coerce, [Symbol.toPrimitive]: coerce,
    }]) {
      // Deliberately bypass the model input schema and TypeScript boundary.
      const result = await calculateTool.execute({ expression: expression as unknown as string }, ctx)
      expect(result.isError).toBe(true)
    }
    expect(coerce).not.toHaveBeenCalled()
  })

  it('is read-only, concurrency-safe, and needs no capability', () => {
    expect(calculateTool.isReadOnly).toBe(true)
    expect(calculateTool.isConcurrencySafe).toBe(true)
    expect(calculateTool.requiresCapability).toBeUndefined()
  })

  it('isolates decimal configuration from other callers', async () => {
    const precision = Decimal.precision
    try {
      Decimal.set({ precision: 2 })
      expect((await calculate('123.45 + 0.01')).data).toMatchObject({ result: '123.46' })
      expect(Decimal.precision).toBe(2)
    } finally {
      Decimal.set({ precision })
    }
  })

  it('validates expression length and type in the input schema', () => {
    for (const expression of ['', '1'.repeat(2049), 123, null]) {
      expect(calculateTool.inputSchema.safeParse({ expression }).success).toBe(false)
    }
  })
})
