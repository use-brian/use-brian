import { describe, it, expect } from 'vitest'
import { evaluate, evaluateBoolean, JsonLogicEvalError } from '../condition.js'

describe('[COMP:workflow/condition] JSONLogic subset', () => {
  describe('var + missing', () => {
    it('resolves a top-level var', () => {
      expect(evaluate({ var: 'vars.x' }, { vars: { x: 42 } })).toBe(42)
    })

    it('resolves a nested var path', () => {
      expect(evaluate({ var: 'vars.user.name' }, { vars: { user: { name: 'A' } } })).toBe('A')
    })

    it('returns the var fallback when missing', () => {
      expect(evaluate({ var: ['vars.missing', 'fallback'] }, { vars: {} })).toBe('fallback')
    })

    it('returns null when missing without fallback', () => {
      expect(evaluate({ var: 'vars.missing' }, { vars: {} })).toBe(null)
    })

    it('missing returns the list of missing paths', () => {
      const result = evaluate({ missing: ['vars.a', 'vars.b'] }, { vars: { a: 1 } })
      expect(result).toEqual(['vars.b'])
    })
  })

  describe('comparators', () => {
    it('==, ===, !=, !==', () => {
      expect(evaluate({ '==': [1, '1'] }, {})).toBe(true)
      expect(evaluate({ '===': [1, '1'] }, {})).toBe(false)
      expect(evaluate({ '!=': [1, 2] }, {})).toBe(true)
      expect(evaluate({ '!==': [1, '1'] }, {})).toBe(true)
    })

    it('<, <=, >, >= numeric', () => {
      expect(evaluate({ '<': [1, 2] }, {})).toBe(true)
      expect(evaluate({ '<=': [2, 2] }, {})).toBe(true)
      expect(evaluate({ '>': [3, 2] }, {})).toBe(true)
      expect(evaluate({ '>=': [3, 3] }, {})).toBe(true)
    })

    it('< chained 3-arg form', () => {
      expect(evaluate({ '<': [1, 2, 3] }, {})).toBe(true)
      expect(evaluate({ '<': [1, 3, 2] }, {})).toBe(false)
    })

    it('returns false for NaN inputs in numeric comparators', () => {
      expect(evaluate({ '<': ['x', 1] }, {})).toBe(false)
    })
  })

  describe('logical', () => {
    it('and short-circuits, returns last truthy', () => {
      expect(evaluate({ and: [true, true, 'last'] }, {})).toBe('last')
      expect(evaluate({ and: [true, 0, 'unreached'] }, {})).toBe(0)
    })

    it('or short-circuits, returns first truthy', () => {
      expect(evaluate({ or: [false, 0, 'first', 'unreached'] }, {})).toBe('first')
    })

    it('!, !! truthiness', () => {
      expect(evaluate({ '!': [false] }, {})).toBe(true)
      expect(evaluate({ '!!': [0] }, {})).toBe(false)
      expect(evaluate({ '!!': ['x'] }, {})).toBe(true)
    })

    it('if (cond, then, else)', () => {
      expect(evaluate({ if: [true, 'yes', 'no'] }, {})).toBe('yes')
      expect(evaluate({ if: [false, 'yes', 'no'] }, {})).toBe('no')
    })

    it('if (cond1, then1, cond2, then2, else)', () => {
      expect(evaluate({ if: [false, 'a', true, 'b', 'c'] }, {})).toBe('b')
    })
  })

  describe('in', () => {
    it('substring match for strings', () => {
      expect(evaluate({ in: ['ell', 'hello'] }, {})).toBe(true)
    })

    it('membership for arrays', () => {
      expect(evaluate({ in: [2, [1, 2, 3]] }, {})).toBe(true)
    })
  })

  describe('errors', () => {
    it('throws on unsupported operator', () => {
      expect(() => evaluate({ wonky: [1] }, {})).toThrow(JsonLogicEvalError)
    })

    it('throws on multi-key node', () => {
      expect(() => evaluate({ '==': [1, 1], '!=': [1, 2] }, {})).toThrow(JsonLogicEvalError)
    })
  })

  describe('evaluateBoolean', () => {
    it('coerces truthiness', () => {
      expect(evaluateBoolean({ var: 'vars.x' }, { vars: { x: 'yes' } })).toBe(true)
      expect(evaluateBoolean({ var: 'vars.x' }, { vars: { x: '' } })).toBe(false)
      expect(evaluateBoolean({ var: 'vars.x' }, { vars: { x: 0 } })).toBe(false)
      expect(evaluateBoolean({ var: 'vars.x' }, { vars: { x: [] } })).toBe(false)
      expect(evaluateBoolean({ var: 'vars.x' }, { vars: { x: [1] } })).toBe(true)
    })
  })

  it('worked example — branch on assistant_call output', () => {
    // Step "review" stored { approved: true, reason: '…' } as vars.review.
    // Branch condition: vars.review.approved == true.
    const condition = { '==': [{ var: 'vars.review.approved' }, true] }
    expect(evaluateBoolean(condition, { vars: { review: { approved: true, reason: 'ok' } } })).toBe(true)
    expect(evaluateBoolean(condition, { vars: { review: { approved: false } } })).toBe(false)
  })
})
