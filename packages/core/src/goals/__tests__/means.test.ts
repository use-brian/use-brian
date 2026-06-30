import { describe, it, expect } from 'vitest'
import { meansActs, resolveMeans } from '../means.js'

describe('[COMP:goals/means] means resolution', () => {
  it('an explicit workflow wins', () => {
    expect(resolveMeans({ workflowId: 'wf1', blueprintIds: ['bp1'], skillIds: ['sk1'] })).toEqual({
      kind: 'workflow',
      workflowId: 'wf1',
    })
  })

  it('falls back to the first blueprint, then the first skill', () => {
    expect(resolveMeans({ blueprintIds: ['bp1', 'bp2'] })).toEqual({ kind: 'blueprint', blueprintId: 'bp1' })
    expect(resolveMeans({ skillIds: ['sk1', 'sk2'] })).toEqual({ kind: 'skill', skillId: 'sk1' })
  })

  it('no means -> a monitor (none)', () => {
    expect(resolveMeans({})).toEqual({ kind: 'none' })
    expect(resolveMeans({ blueprintIds: [], skillIds: [] })).toEqual({ kind: 'none' })
  })

  it('meansActs: acting plans require metering; a monitor does not', () => {
    expect(meansActs({ kind: 'workflow', workflowId: 'w' })).toBe(true)
    expect(meansActs({ kind: 'blueprint', blueprintId: 'b' })).toBe(true)
    expect(meansActs({ kind: 'skill', skillId: 's' })).toBe(true)
    expect(meansActs({ kind: 'none' })).toBe(false)
  })
})
