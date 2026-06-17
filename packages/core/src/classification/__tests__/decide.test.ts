import { describe, expect, it } from 'vitest'

import { decide } from '../decide.js'
import type { ClassifierBlock, ClassifierMatch } from '../types.js'

type K = 'person' | 'company' | 'repository' | 'project'

function match(value: K, tier: 'deterministic' | 'probabilistic', confidence: number, ruleId = `${tier}-${value}`): ClassifierMatch<K> {
  return { rule_id: ruleId, value, tier, confidence }
}

function block(blocked: K[], ruleId = 'block'): ClassifierBlock<K> {
  return { rule_id: ruleId, blocked, reason: 'test block' }
}

describe('[COMP:classification/decide] decide()', () => {
  it('returns no_signal when no matches and no blocks', () => {
    const out = decide<K>([], [])
    expect(out.kind).toBe('no_signal')
  })

  it('returns override on a single deterministic match', () => {
    const m = match('repository', 'deterministic', 1.0)
    const out = decide<K>([m], [])
    expect(out.kind).toBe('override')
    if (out.kind === 'override') expect(out.match.value).toBe('repository')
  })

  it('picks highest-confidence deterministic when multiple fire', () => {
    const out = decide<K>(
      [match('person', 'deterministic', 0.95), match('company', 'deterministic', 1.0)],
      [],
    )
    expect(out.kind).toBe('override')
    if (out.kind === 'override') expect(out.match.value).toBe('company')
  })

  it('deterministic beats probabilistic regardless of confidence', () => {
    const out = decide<K>(
      [match('person', 'probabilistic', 0.99), match('company', 'deterministic', 0.5)],
      [],
    )
    expect(out.kind).toBe('override')
    if (out.kind === 'override') expect(out.match.value).toBe('company')
  })

  it('returns hint when only probabilistic matches survive', () => {
    const out = decide<K>(
      [match('person', 'probabilistic', 0.8), match('company', 'probabilistic', 0.6)],
      [],
    )
    expect(out.kind).toBe('hint')
    if (out.kind === 'hint') {
      expect(out.matches).toHaveLength(2)
      expect(out.matches[0]?.value).toBe('person')
      expect(out.matches[1]?.value).toBe('company')
    }
  })

  it('drops probabilistic matches below the hint floor (default 0.4)', () => {
    const out = decide<K>([match('person', 'probabilistic', 0.3)], [])
    expect(out.kind).toBe('no_signal')
  })

  it('respects custom hint floor', () => {
    const out = decide<K>([match('person', 'probabilistic', 0.5)], [], { hintFloor: 0.7 })
    expect(out.kind).toBe('no_signal')
  })

  it('negative rule blocks matching positive', () => {
    const out = decide<K>(
      [match('person', 'deterministic', 1.0)],
      [block(['person'])],
    )
    expect(out.kind).toBe('blocked')
    if (out.kind === 'blocked') expect(out.suppressedBy[0]?.blocked).toContain('person')
  })

  it('negative rule on one value lets other values through', () => {
    const out = decide<K>(
      [match('person', 'deterministic', 1.0), match('company', 'deterministic', 0.9)],
      [block(['person'])],
    )
    expect(out.kind).toBe('override')
    if (out.kind === 'override') expect(out.match.value).toBe('company')
  })

  it('returns blocked when only blocks fire and no matches survive', () => {
    const out = decide<K>([match('person', 'probabilistic', 0.8)], [block(['person'])])
    expect(out.kind).toBe('blocked')
  })

  it('returns hint with suppressedBy when probabilistic survive and a block fires', () => {
    const out = decide<K>(
      [match('person', 'probabilistic', 0.8), match('company', 'probabilistic', 0.7)],
      [block(['person'])],
    )
    expect(out.kind).toBe('hint')
    if (out.kind === 'hint') {
      expect(out.matches).toHaveLength(1)
      expect(out.matches[0]?.value).toBe('company')
      expect(out.suppressedBy?.[0]?.blocked).toContain('person')
    }
  })
})
