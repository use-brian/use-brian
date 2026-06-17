/**
 * Vendored JSONLogic subset for workflow `branch` step conditions.
 *
 * Why vendored: only ~50 lines, covers everything V1 needs, no extra dep,
 * no eval surface. The `json-logic-js` npm package is the standard
 * alternative and can be swapped in if/when more operators are needed.
 *
 * Supported operators:
 *   var  in  missing
 *   ==  ===  !=  !==  <  <=  >  >=
 *   !  !!  and  or  if
 *
 * Anything else throws `JsonLogicEvalError` so that authoring-time mistakes
 * surface as a step failure with a clear message rather than silently
 * evaluating to a falsy value.
 *
 * [COMP:workflow/condition]
 */

export class JsonLogicEvalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JsonLogicEvalError'
  }
}

export type ConditionData = {
  prev?: unknown
  vars?: Record<string, unknown>
  input?: Record<string, unknown>
}

/**
 * Evaluate a JSONLogic rule against `data`. The branch step uses
 * `{ prev, vars, input }`; tests can pass any object shape they need.
 */
export function evaluate(rule: unknown, data: ConditionData): unknown {
  // Primitives are returned as-is.
  if (rule === null || typeof rule !== 'object') return rule

  // Arrays evaluate each element (used inside operators).
  if (Array.isArray(rule)) return rule.map((r) => evaluate(r, data))

  const keys = Object.keys(rule as Record<string, unknown>)
  if (keys.length !== 1) {
    throw new JsonLogicEvalError(
      `JSONLogic node must have exactly one operator, got ${keys.length}: ${JSON.stringify(rule)}`,
    )
  }
  const [op] = keys
  const args = (rule as Record<string, unknown>)[op]
  const argList = Array.isArray(args) ? args : [args]

  switch (op) {
    case 'var': {
      const path = String(evaluate(argList[0], data) ?? '')
      const fallback = argList.length > 1 ? evaluate(argList[1], data) : null
      return resolvePath(data, path, fallback)
    }
    case 'missing': {
      // Returns the list of paths that are missing/undefined/null in data.
      const paths = argList.map((a) => String(evaluate(a, data) ?? ''))
      return paths.filter((p) => {
        const v = resolvePath(data, p, undefined)
        return v === undefined || v === null
      })
    }
    case '==':
      // eslint-disable-next-line eqeqeq
      return evaluate(argList[0], data) == evaluate(argList[1], data)
    case '===':
      return evaluate(argList[0], data) === evaluate(argList[1], data)
    case '!=':
      // eslint-disable-next-line eqeqeq
      return evaluate(argList[0], data) != evaluate(argList[1], data)
    case '!==':
      return evaluate(argList[0], data) !== evaluate(argList[1], data)
    case '<':
      return numerically(argList, data, (a, b) => a < b)
    case '<=':
      return numerically(argList, data, (a, b) => a <= b)
    case '>':
      return numerically(argList, data, (a, b) => a > b)
    case '>=':
      return numerically(argList, data, (a, b) => a >= b)
    case '!':
      return !truthy(evaluate(argList[0], data))
    case '!!':
      return truthy(evaluate(argList[0], data))
    case 'and': {
      // Short-circuit, returns the last evaluated value (matches json-logic-js).
      let last: unknown = true
      for (const a of argList) {
        last = evaluate(a, data)
        if (!truthy(last)) return last
      }
      return last
    }
    case 'or': {
      let last: unknown = false
      for (const a of argList) {
        last = evaluate(a, data)
        if (truthy(last)) return last
      }
      return last
    }
    case 'if': {
      // if(cond1, then1, cond2, then2, ..., else)
      let i = 0
      while (i < argList.length - 1) {
        const cond = evaluate(argList[i], data)
        if (truthy(cond)) return evaluate(argList[i + 1], data)
        i += 2
      }
      return i < argList.length ? evaluate(argList[i], data) : null
    }
    case 'in': {
      const needle = evaluate(argList[0], data)
      const haystack = evaluate(argList[1], data)
      if (typeof haystack === 'string') return haystack.includes(String(needle))
      if (Array.isArray(haystack)) return haystack.some((v) => v === needle)
      return false
    }
    default:
      throw new JsonLogicEvalError(`Unsupported JSONLogic operator: "${op}"`)
  }
}

function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0
  if (v === null || v === undefined) return false
  if (typeof v === 'string') return v.length > 0
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v)
  if (typeof v === 'boolean') return v
  return true
}

function numerically(
  args: unknown[],
  data: ConditionData,
  cmp: (a: number, b: number) => boolean,
): boolean {
  if (args.length < 2 || args.length > 3) {
    throw new JsonLogicEvalError(`numeric comparator expects 2 or 3 args, got ${args.length}.`)
  }
  const values = args.map((a) => Number(evaluate(a, data)))
  if (values.some((n) => Number.isNaN(n))) return false
  // 3-arg form: a < b < c (chained)
  if (values.length === 3) {
    return cmp(values[0], values[1]) && cmp(values[1], values[2])
  }
  return cmp(values[0], values[1])
}

function resolvePath(data: ConditionData, path: string, fallback: unknown): unknown {
  if (path === '' || path === undefined) return data
  const segments = path.split('.')
  let cursor: unknown = data
  for (const seg of segments) {
    if (cursor === null || cursor === undefined) return fallback
    if (typeof cursor !== 'object') return fallback
    cursor = (cursor as Record<string, unknown>)[seg]
  }
  return cursor === undefined ? fallback : cursor
}

/**
 * Convenience wrapper for branch evaluation — coerces the result to a
 * plain boolean using the same truthiness rules.
 */
export function evaluateBoolean(rule: unknown, data: ConditionData): boolean {
  return truthy(evaluate(rule, data))
}
