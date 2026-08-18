/**
 * [COMP:tools/tool-failure] — the shared first-party failure frame and the
 * parameterised "not found" shape (docs/architecture/engine/tool-executor.md
 * → "Failure copy").
 */

import { describe, it, expect } from 'vitest'
import { describeToolFailure, isTransientToolError, notFoundFailure, notFoundMessage, toolFailure } from '../tool-failure.js'

describe('[COMP:tools/tool-failure] describeToolFailure', () => {
  it('frames a plain error with tool + target and a no-retry-unchanged verdict', () => {
    const text = describeToolFailure(new Error('relation "entities" does not exist'), { tool: 'getEntity', target: 'entity `e1`' })
    expect(text).toBe('`getEntity` on entity `e1` failed: relation "entities" does not exist. Retrying the same arguments will not help — fix what the message names, or ask the user; do not retry unchanged.')
  })

  it('an input-shaped rejection says fix what the message names; a mutating tool says nothing was saved', () => {
    const text = describeToolFailure(new Error('invalid input syntax for type uuid: "abc"'), { tool: 'linkEntities', target: 'entity `abc`', mutating: true, next: 'Both ids must be existing brain row UUIDs (getEntity / searchBrain).' })
    expect(text).toContain('Nothing was saved or changed.')
    expect(text).toContain('Both ids must be existing brain row UUIDs (getEntity / searchBrain).')
    expect(text).toContain('Fix what that message names')
  })

  it('a transient infrastructure error allows one retry and warns a mutating tool that the write may have applied', () => {
    expect(isTransientToolError(new Error('Connection terminated unexpectedly'))).toBe(true)
    expect(isTransientToolError(Object.assign(new Error('x'), { code: '57014' }))).toBe(true)
    expect(isTransientToolError(new Error('boom'))).toBe(false)
    const text = describeToolFailure(new Error('statement timeout'), { tool: 'saveMemory', mutating: true })
    expect(text).toContain('transient infrastructure error')
    expect(text).toContain('The write may or may not have been applied')
    expect(text).toContain('Retry once after a short wait')
  })

  it('zod issues render as the executor\'s compact lines + "fix the named field"', () => {
    const zodLike = { issues: [{ path: ['as_of'], message: 'Invalid datetime', code: 'invalid_string' }] }
    const text = describeToolFailure(zodLike, { tool: 'brainQuery' })
    expect(text).toContain('did not run: the input failed validation')
    expect(text).toContain('as_of: Invalid datetime')
    expect(text).toContain('Fix the named field(s)')
  })

  it('toolFailure wraps as an isError result; non-Error throws are stringified', () => {
    const r = toolFailure('string error', { tool: 't' })
    expect(r.isError).toBe(true)
    expect(r.data).toContain('`t` failed: string error')
    expect(describeToolFailure(new Error(''), { tool: 't' })).toContain('`t` failed.')
  })
})

describe('[COMP:tools/tool-failure] notFoundMessage — the taskNotFoundMessage shape, parameterised', () => {
  it('names the id, the supersession rule, the id source, the discovery tool, and forbids the retry', () => {
    const text = notFoundMessage({ kind: 'Goal', id: 'g1', discoveryTool: 'listGoals', supersession: true, idSource: 'a listGoals result, never a title' })
    expect(text).toBe('Goal g1 not found in this workspace. If you edited this goal earlier, that edit returned a NEW id (every update supersedes the row) — reuse the id from that result. Ids come from a listGoals result, never a title. Call listGoals to re-resolve a current id. Do NOT retry this exact id.')
  })

  it('without a discovery tool it asks the user; extra rides between diagnosis and verdict', () => {
    const r = notFoundFailure({ kind: 'Worker', id: 'w9', extra: 'Workers are per-workspace; a worker from another workspace cannot be addressed here.' })
    expect(r.isError).toBe(true)
    expect(r.data).toBe('Worker w9 not found in this workspace. Workers are per-workspace; a worker from another workspace cannot be addressed here. Ask the user to confirm the id. Do NOT retry this exact id.')
  })
})
