import { describe, expect, it } from 'vitest'
import {
  KnowledgeCaptureRuleInputSchema,
  buildKnowledgeCapturePrompt,
  matchKnowledgeCaptureRules,
  matchesKnowledgeCaptureRule,
  type KnowledgeCaptureRule,
} from '../capture-rules.js'

function rule(overrides: Partial<KnowledgeCaptureRule> = {}): KnowledgeCaptureRule {
  return {
    id: '10000000-0000-4000-8000-000000000001',
    workspaceId: '20000000-0000-4000-8000-000000000001',
    name: 'Pricing research',
    matchPhrases: ['education offer', 'student discount'],
    instructions: 'Capture verified offer changes and expiry dates.',
    targetSourceId: null,
    pathPrefix: 'research/offers',
    defaultSensitivity: 'public',
    enabled: true,
    createdBy: null,
    createdAt: new Date('2026-08-23T00:00:00Z'),
    updatedAt: new Date('2026-08-23T00:00:00Z'),
    ...overrides,
  }
}

describe('[COMP:knowledge/capture-rules] deterministic matcher', () => {
  it('matches any configured phrase without case sensitivity', () => {
    expect(matchesKnowledgeCaptureRule(rule(), 'Compare the current STUDENT DISCOUNT for MacBook.')).toBe(true)
    expect(matchesKnowledgeCaptureRule(rule(), 'Compare employee purchase plans.')).toBe(false)
  })

  it('fails closed for disabled rules, empty text, and empty phrases', () => {
    expect(matchesKnowledgeCaptureRule(rule({ enabled: false }), 'student discount')).toBe(false)
    expect(matchesKnowledgeCaptureRule(rule(), '   ')).toBe(false)
    expect(matchesKnowledgeCaptureRule(rule({ matchPhrases: [''] }), 'anything')).toBe(false)
  })

  it('returns every matching category and no non-matches', () => {
    const decisions = rule({ id: 'rule-decisions', name: 'Decisions', matchPhrases: ['decided'] })
    const offers = rule({ id: 'rule-offers' })
    const people = rule({ id: 'rule-people', name: 'People', matchPhrases: ['new hire'] })
    expect(matchKnowledgeCaptureRules(
      [decisions, offers, people],
      'We decided to adopt the student discount offer.',
    ).map((candidate) => candidate.id)).toEqual(['rule-decisions', 'rule-offers'])
  })

  it('normalizes phrases and path prefixes at the API boundary', () => {
    const parsed = KnowledgeCaptureRuleInputSchema.parse({
      name: ' Pricing research ',
      matchPhrases: [' student discount ', 'student discount'],
      instructions: ' Capture verified changes. ',
      targetSourceId: null,
      pathPrefix: '/research/offers/',
    })
    expect(parsed).toMatchObject({
      name: 'Pricing research',
      matchPhrases: ['student discount'],
      instructions: 'Capture verified changes.',
      pathPrefix: 'research/offers',
      defaultSensitivity: 'internal',
      enabled: true,
    })
    expect(() => KnowledgeCaptureRuleInputSchema.parse({
      ...parsed,
      pathPrefix: '../secrets',
    })).toThrow()
  })

  it('builds a trusted prompt only for usable matches', () => {
    expect(buildKnowledgeCapturePrompt([])).toBe('')
    const prompt = buildKnowledgeCapturePrompt([{ ...rule(), targetLabel: 'Manual entries' }])
    expect(prompt).toContain('# Knowledge capture')
    expect(prompt).toContain('Pricing research')
    expect(prompt).toContain('Manual entries')
    expect(prompt).toContain('research/offers/...')
    expect(prompt).toContain('approval interface')
  })
})
