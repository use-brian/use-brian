import { Decimal } from 'decimal.js'
import { z } from 'zod'
import { buildTool } from '../types.js'

// Isolate configuration from other Decimal users. Decimal arithmetic avoids
// binary floating-point surprises such as 0.1 + 0.2 = 0.30000000000000004.
const Arithmetic = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP })
const MAX_LENGTH = 2048
const MAX_DEPTH = 64
const MAX_EXPONENT = 1000

/** Restricted recursive-descent grammar; never evaluates JavaScript or names. */
function evaluate(expression: string): string {
  if (!expression.trim() || expression.length > MAX_LENGTH) {
    throw new Error(`Expression must contain 1–${MAX_LENGTH} characters.`)
  }
  let position = 0
  let depth = 0

  function whitespace(): void {
    while (/\s/.test(expression[position] ?? '') && position < expression.length) position++
  }

  function take(token: string): boolean {
    whitespace()
    if (expression[position] !== token) return false
    position++
    return true
  }

  function checked(value: Decimal): Decimal {
    if (!value.isFinite() || (!value.isZero() && Math.abs(value.e) > MAX_EXPONENT)) {
      throw new Error(`Result must be finite with a decimal exponent between -${MAX_EXPONENT} and ${MAX_EXPONENT}.`)
    }
    return value
  }

  function sum(): Decimal {
    let value = product()
    while (true) {
      if (take('+')) value = checked(value.plus(product()))
      else if (take('-')) value = checked(value.minus(product()))
      else return value
    }
  }

  function product(): Decimal {
    let value = unary()
    while (true) {
      if (take('*')) value = checked(value.times(unary()))
      else if (take('/')) {
        const divisor = unary()
        if (divisor.isZero()) throw new Error('Division by zero is not allowed.')
        value = checked(value.div(divisor))
      } else return value
    }
  }

  // Unary minus binds less tightly than powers: -2^2 = -(2^2).
  function unary(): Decimal {
    if (++depth > MAX_DEPTH) throw new Error('Expression nesting is too deep.')
    try {
      if (take('+')) return unary()
      if (take('-')) return unary().negated()
      return power()
    } finally {
      depth--
    }
  }

  function power(): Decimal {
    const base = primary()
    if (!take('^')) return base
    const exponent = unary() // Right associative: 2^3^2 = 2^(3^2).
    if (!exponent.isInteger() || exponent.abs().gt(MAX_EXPONENT)) {
      throw new Error(`Power must be an integer between -${MAX_EXPONENT} and ${MAX_EXPONENT}.`)
    }
    if (base.isZero() && exponent.isNegative()) throw new Error('Division by zero is not allowed.')
    return checked(base.pow(exponent))
  }

  function primary(): Decimal {
    if (take('(')) {
      const value = sum()
      if (!take(')')) throw new Error('Missing closing parenthesis.')
      return value
    }
    whitespace()
    const literal = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(expression.slice(position))?.[0]
    if (!literal) throw new Error(`Expected a number or parenthesis at position ${position + 1}.`)
    position += literal.length
    return checked(new Arithmetic(literal))
  }

  const result = sum()
  whitespace()
  if (position !== expression.length) {
    throw new Error(`Unexpected token at position ${position + 1}. Use only numbers, +, -, *, /, ^, and parentheses.`)
  }
  return result.toString()
}

export const calculateTool = buildTool({
  name: 'calculate',
  description: 'Calculate arithmetic deterministically. ALWAYS call this tool when answering arithmetic questions; do not calculate mentally. Supports decimal/scientific numbers, +, -, *, /, parentheses, and ^ with integer powers from -1000 to 1000. Write percentages explicitly as /100 (e.g. 200*15/100); no implicit multiplication, functions, units, or thousands separators. Uses 40 significant digits, rounding half up; repeating divisions and other long results are approximate. No Python, network, or computer access needed.',
  inputSchema: z.object({
    expression: z.string().min(1).max(MAX_LENGTH).describe('Arithmetic expression, e.g. "(12.5 + 7.5) * 3" or "200 * 15 / 100".'),
  }),
  isConcurrencySafe: true,
  isReadOnly: true,
  async execute(input) {
    try {
      return { data: { expression: input.expression, result: evaluate(input.expression), precision: 40 } }
    } catch (error) {
      return { data: error instanceof Error ? error.message : 'Invalid arithmetic expression.', isError: true }
    }
  },
})
