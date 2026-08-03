/**
 * Tool-input tolerance helpers — the fix for the stringly-typed-args failure
 * class observed in production (2026-07-07 ability audit §2.2): models emit
 * `include_archived: "true"`, `limit: "10"`, JSON-serialised workflow steps,
 * and domain strings where UUIDs belong.
 *
 * Spec: docs/architecture/engine/tool-input-tolerance.md
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  tolerantBoolean,
  tolerantNumber,
  tolerantInt,
  uuidId,
  tolerantObject,
  tolerantEnumArray,
} from '../schema-tolerance.js'

describe('[COMP:engine/tool-input-tolerance] schema tolerance helpers', () => {
  describe('tolerantBoolean', () => {
    it('accepts real booleans', () => {
      expect(tolerantBoolean().parse(true)).toBe(true)
      expect(tolerantBoolean().parse(false)).toBe(false)
    })

    it('maps "true"/"false" strings correctly — including the z.coerce.boolean trap', () => {
      expect(tolerantBoolean().parse('true')).toBe(true)
      // THE trap: Boolean('false') === true. This must map to false.
      expect(tolerantBoolean().parse('false')).toBe(false)
      expect(tolerantBoolean().parse('TRUE')).toBe(true)
      expect(tolerantBoolean().parse(' False ')).toBe(false)
    })

    it('rejects non-boolean words', () => {
      expect(() => tolerantBoolean().parse('yes')).toThrow()
      expect(() => tolerantBoolean().parse(1)).toThrow()
    })
  })

  describe('tolerantNumber / tolerantInt', () => {
    it('accepts numbers and numeric strings', () => {
      expect(tolerantNumber().parse(25)).toBe(25)
      expect(tolerantNumber().parse('25')).toBe(25)
      expect(tolerantInt({ min: 1, max: 100 }).parse('10')).toBe(10)
    })

    it('enforces int and bounds after coercion', () => {
      expect(() => tolerantInt().parse('2.7')).toThrow()
      expect(() => tolerantInt({ min: 1, max: 100 }).parse('101')).toThrow()
      expect(() => tolerantNumber().parse('ten')).toThrow()
    })
  })

  describe('uuidId', () => {
    it('accepts a UUID and rejects a domain with an instructive message', () => {
      expect(uuidId('workspace').parse('a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d')).toBe(
        'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      )
      // The prod failure: listEntityTypes({ workspaceId: "fls.com.hk" }).
      const res = uuidId('workspace').safeParse('fls.com.hk')
      expect(res.success).toBe(false)
      if (!res.success) {
        expect(res.error.issues[0]?.message).toContain('not a name, domain, or slug')
      }
    })
  })

  describe('tolerantObject', () => {
    const shape = z.object({ id: z.string(), type: z.literal('assistant_call') })

    it('accepts a real object and a JSON-string object', () => {
      const obj = { id: 's1', type: 'assistant_call' as const }
      expect(tolerantObject(shape).parse(obj)).toEqual(obj)
      expect(tolerantObject(shape).parse(JSON.stringify(obj))).toEqual(obj)
    })

    it('invalid JSON string still errors cleanly (raw value reaches the schema)', () => {
      expect(() => tolerantObject(shape).parse('{not json')).toThrow()
      expect(() => tolerantObject(shape).parse('"just a string"')).toThrow()
    })
  })

  describe('tolerantEnumArray', () => {
    // The listTasks `status` shape. A "single value or a list" param is exactly
    // what a model serialises loosely, and this one failed validation 35 times
    // in production between 2026-07-08 and 2026-08-03 — every occurrence inside
    // a workflow step, each silently emptying one person's digest section.
    const STATUSES = ['todo', 'in_progress', 'in_review', 'blocked', 'done', 'archived'] as const
    const status = tolerantEnumArray(STATUSES)

    it('accepts the strict forms unchanged — one member, or a real array', () => {
      expect(status.parse('todo')).toBe('todo')
      expect(status.parse(['todo', 'blocked'])).toEqual(['todo', 'blocked'])
    })

    it('does NOT wrap a valid single member into an array', () => {
      // The union accepts both shapes, so preserving what the model sent keeps
      // the recorded tool input honest.
      expect(status.parse('in_progress')).toBe('in_progress')
    })

    it('accepts a JSON-stringified array — the production failure', () => {
      expect(status.parse('["todo","in_progress","blocked"]')).toEqual([
        'todo',
        'in_progress',
        'blocked',
      ])
    })

    it('accepts a comma-separated list, with or without spaces', () => {
      expect(status.parse('todo,blocked')).toEqual(['todo', 'blocked'])
      expect(status.parse('todo, in_progress , blocked')).toEqual([
        'todo',
        'in_progress',
        'blocked',
      ])
    })

    it('still REJECTS a genuinely invalid member — tolerance is not coercion', () => {
      expect(status.safeParse('pending').success).toBe(false)
      expect(status.safeParse(['todo', 'pending']).success).toBe(false)
      expect(status.safeParse('["todo","pending"]').success).toBe(false)
      expect(status.safeParse(42).success).toBe(false)
    })

    it('a malformed JSON array falls through to a normal error, not a crash', () => {
      expect(status.safeParse('["todo",').success).toBe(false)
    })

    it('rejects an empty or whitespace-only list instead of inventing an empty filter', () => {
      // An empty array would silently mean "no status filter", quietly widening
      // the query rather than reporting the bad input.
      expect(status.safeParse('').success).toBe(false)
      expect(status.safeParse(' , , ').success).toBe(false)
    })
  })
})
