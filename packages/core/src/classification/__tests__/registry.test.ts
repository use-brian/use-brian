import { describe, expect, it } from 'vitest'

import { createClassifierRegistry } from '../registry.js'
import type {
  ClassifierCandidate,
  ClassifierMatch,
  ClassifierNegativeRule,
  ClassifierRule,
} from '../types.js'

type K = 'person' | 'company' | 'repository'

function detRule(
  id: string,
  produces: K,
  matchPredicate: (c: ClassifierCandidate) => boolean,
): ClassifierRule<K> {
  return {
    id,
    produces,
    tier: 'deterministic',
    confidence: 1.0,
    boundaries: ['extraction'],
    applies: matchPredicate,
    evaluate: (c) =>
      matchPredicate(c)
        ? ({
            rule_id: id,
            value: produces,
            confidence: 1.0,
            tier: 'deterministic',
          } satisfies ClassifierMatch<K>)
        : null,
  }
}

function probRule(
  id: string,
  produces: K,
  confidence: number,
  matchPredicate: (c: ClassifierCandidate) => boolean,
): ClassifierRule<K> {
  return {
    id,
    produces,
    tier: 'probabilistic',
    confidence,
    boundaries: ['extraction', 'tool', 'inbox', 'connector', 'self_heal'],
    applies: matchPredicate,
    evaluate: (c) =>
      matchPredicate(c)
        ? { rule_id: id, value: produces, confidence, tier: 'probabilistic' }
        : null,
  }
}

function negRule(id: string, blocks: K[], predicate: (c: ClassifierCandidate) => boolean): ClassifierNegativeRule<K> {
  return {
    id,
    blocks,
    tier: 'deterministic',
    boundaries: ['extraction', 'tool', 'inbox', 'connector', 'self_heal'],
    applies: predicate,
    reason: `blocked by ${id}`,
  }
}

describe('[COMP:classification/registry] createClassifierRegistry', () => {
  it('rejects duplicate rule ids at registration', () => {
    expect(() =>
      createClassifierRegistry<K>([
        detRule('a', 'person', () => true),
        detRule('a', 'company', () => true),
      ]),
    ).toThrow(/duplicate rule id/)
  })

  it('rejects rules with empty boundaries', () => {
    const bad: ClassifierRule<K> = {
      id: 'no-boundaries',
      produces: 'person',
      tier: 'deterministic',
      confidence: 1.0,
      boundaries: [],
      applies: () => true,
      evaluate: () => null,
    }
    expect(() => createClassifierRegistry<K>([bad])).toThrow(/empty boundaries/)
  })

  it('only fires rules whose boundary matches', () => {
    const reg = createClassifierRegistry<K>([
      {
        ...detRule('extraction-only', 'person', () => true),
        boundaries: ['extraction'],
      },
      {
        ...detRule('tool-only', 'company', () => true),
        boundaries: ['tool'],
      },
    ])
    const ms = reg.classify({ primary: 'x' }, 'extraction')
    expect(ms).toHaveLength(1)
    expect(ms[0]?.value).toBe('person')
  })

  it('applicableSources restricts rule firing by source.kind', () => {
    const reg = createClassifierRegistry<K>([
      {
        ...detRule('github-only', 'repository', () => true),
        applicableSources: ['github_sync'],
      },
    ])
    expect(reg.classify({ primary: 'x', source: { kind: 'email_thread' } }, 'extraction')).toHaveLength(0)
    expect(reg.classify({ primary: 'x', source: { kind: 'github_sync' } }, 'extraction')).toHaveLength(1)
  })

  it('classify returns matches sorted by confidence desc', () => {
    const reg = createClassifierRegistry<K>([
      probRule('weak', 'person', 0.5, () => true),
      probRule('strong', 'person', 0.95, () => true),
    ])
    const ms = reg.classify({ primary: 'x' }, 'extraction')
    expect(ms).toHaveLength(2)
    expect(ms[0]?.confidence).toBe(0.95)
    expect(ms[1]?.confidence).toBe(0.5)
  })

  it('decide composes positive + negative rules correctly', () => {
    const reg = createClassifierRegistry<K>([
      detRule('positive', 'person', () => true),
      negRule('negative', ['person'], () => true),
    ])
    const d = reg.decide({ primary: 'x' }, 'extraction')
    expect(d.kind).toBe('blocked')
  })

  it('ruleIds returns all registered rule ids', () => {
    const reg = createClassifierRegistry<K>([
      detRule('r1', 'person', () => true),
      probRule('r2', 'company', 0.5, () => true),
      negRule('r3', ['repository'], () => true),
    ])
    expect(reg.ruleIds().sort()).toEqual(['r1', 'r2', 'r3'])
  })

  it('returns no_signal when no rule applies', () => {
    const reg = createClassifierRegistry<K>([
      detRule('never', 'person', () => false),
    ])
    expect(reg.decide({ primary: 'x' }, 'extraction').kind).toBe('no_signal')
  })
})
