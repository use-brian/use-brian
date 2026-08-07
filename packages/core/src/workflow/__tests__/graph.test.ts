import { describe, it, expect } from 'vitest'
import {
  stepSuccessors,
  buildSuccessorMap,
  buildReachability,
  findCycle,
  parallelRegionSteps,
} from '../graph.js'
import type { WorkflowDefinition, WorkflowStep } from '../types.js'

const call = (id: string, extra?: Partial<WorkflowStep>): WorkflowStep =>
  ({
    id,
    type: 'assistant_call',
    target: { assistantId: 'primary' },
    prompt: `do ${id}`,
    ...extra,
  }) as WorkflowStep

const def = (steps: WorkflowStep[], startStepId = steps[0].id): WorkflowDefinition => ({
  startStepId,
  steps,
})

describe('[COMP:workflow/graph] stepSuccessors', () => {
  it('resolves scalar nextStepId', () => {
    const d = def([call('a', { nextStepId: 'b' }), call('b')])
    expect(stepSuccessors(d.steps[0], ['a', 'b'])).toEqual(['b'])
  })

  it('resolves fan-out arrays to every target', () => {
    const d = def([call('a', { nextStepId: ['b', 'c'] }), call('b'), call('c')])
    expect(stepSuccessors(d.steps[0], ['a', 'b', 'c'])).toEqual(['b', 'c'])
  })

  it('explicit null is terminal', () => {
    expect(stepSuccessors(call('a', { nextStepId: null }), ['a', 'b'])).toEqual([])
  })

  it('absent nextStepId falls through sequentially; last step is terminal', () => {
    expect(stepSuccessors(call('a'), ['a', 'b'])).toEqual(['b'])
    expect(stepSuccessors(call('b'), ['a', 'b'])).toEqual([])
  })

  it('branch contributes both arms statically', () => {
    const branch: WorkflowStep = {
      id: 'br',
      type: 'branch',
      condition: { '==': [1, 1] },
      nextStepIdIfTrue: 'x',
      nextStepIdIfFalse: 'y',
    }
    expect(stepSuccessors(branch, ['br', 'x', 'y'])).toEqual(['x', 'y'])
  })
})

describe('[COMP:workflow/graph] findCycle', () => {
  it('returns null for a linear DAG', () => {
    expect(findCycle(def([call('a'), call('b'), call('c')]))).toBeNull()
  })

  it('returns null for a fan-out diamond', () => {
    const d = def([
      call('a', { nextStepId: ['b', 'c'] }),
      call('b', { nextStepId: 'j' }),
      call('c', { nextStepId: 'j' }),
      call('j', { nextStepId: null }),
    ])
    expect(findCycle(d)).toBeNull()
  })

  it('detects an explicit back-edge', () => {
    const d = def([call('a', { nextStepId: 'b' }), call('b', { nextStepId: 'a' })])
    const cycle = findCycle(d)
    expect(cycle).not.toBeNull()
    expect(cycle![0]).toBe(cycle![cycle!.length - 1])
  })

  it('detects a cycle formed by sequential fall-through + back-edge', () => {
    // a falls through to b; b jumps back to a.
    const d = def([call('a'), call('b', { nextStepId: 'a' })])
    expect(findCycle(d)).not.toBeNull()
  })

  it('ignores dangling references instead of crashing', () => {
    const d = def([call('a', { nextStepId: 'ghost' })])
    expect(findCycle(d)).toBeNull()
  })
})

describe('[COMP:workflow/graph] buildReachability', () => {
  it('includes the step itself and everything transitively downstream', () => {
    const d = def([
      call('a', { nextStepId: ['b', 'c'] }),
      call('b', { nextStepId: 'j' }),
      call('c', { nextStepId: 'j' }),
      call('j', { nextStepId: null }),
    ])
    const reach = buildReachability(d)
    expect([...reach.get('a')!].sort()).toEqual(['a', 'b', 'c', 'j'])
    expect([...reach.get('b')!].sort()).toEqual(['b', 'j'])
    expect([...reach.get('j')!]).toEqual(['j'])
  })

  it('buildSuccessorMap drops references to unknown steps', () => {
    const d = def([call('a', { nextStepId: ['b', 'ghost'] }), call('b')])
    expect(buildSuccessorMap(d).get('a')).toEqual(['b'])
  })
})

describe('[COMP:workflow/graph] parallelRegionSteps', () => {
  it('is empty for a purely sequential workflow', () => {
    expect(parallelRegionSteps(def([call('a'), call('b'), call('c')])).size).toBe(0)
  })

  it('marks branch arms of a fan-out but not the join or its descendants', () => {
    const d = def([
      call('a', { nextStepId: ['b', 'c'] }),
      call('b', { nextStepId: 'j' }),
      call('c', { nextStepId: 'j' }),
      call('j', { nextStepId: 'tail' }),
      call('tail', { nextStepId: null }),
    ])
    const unsafe = parallelRegionSteps(d)
    expect(unsafe.has('b')).toBe(true)
    expect(unsafe.has('c')).toBe(true)
    expect(unsafe.has('j')).toBe(false)
    expect(unsafe.has('tail')).toBe(false)
    expect(unsafe.has('a')).toBe(false)
  })

  it('marks every downstream step when a sibling branch never rejoins', () => {
    const d = def([
      call('a', { nextStepId: ['b', 'c'] }),
      call('b', { nextStepId: 'b2' }),
      call('b2', { nextStepId: null }),
      call('c', { nextStepId: null }),
    ])
    const unsafe = parallelRegionSteps(d)
    expect(unsafe.has('b')).toBe(true)
    expect(unsafe.has('b2')).toBe(true)
    expect(unsafe.has('c')).toBe(true)
  })

  it('a branch step routing two arms is NOT a fan-out', () => {
    const d = def([
      {
        id: 'br',
        type: 'branch',
        condition: { '==': [1, 1] },
        nextStepIdIfTrue: 'x',
        nextStepIdIfFalse: 'y',
      },
      call('x', { nextStepId: null }),
      call('y', { nextStepId: null }),
    ])
    expect(parallelRegionSteps(d).size).toBe(0)
  })
})
