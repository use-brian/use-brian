import { describe, it, expect } from 'vitest'
import { jaroWinkler, normalizeName, resolveEntity } from '../resolver.js'
import type { EntityCandidate } from '../types.js'
import type { LLMProvider, StreamChunk } from '../../providers/types.js'

function mockProvider(response: string): LLMProvider {
  return {
    createSession() {
      return { thoughtSignature: undefined } as never
    },
    async *stream(): AsyncGenerator<StreamChunk> {
      yield { type: 'text_delta', text: response } as StreamChunk
      yield {
        type: 'message_end',
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      } as StreamChunk
    },
  } as unknown as LLMProvider
}

function throwingProvider(): LLMProvider {
  return {
    createSession() {
      return { thoughtSignature: undefined } as never
    },
    // eslint-disable-next-line require-yield
    async *stream(): AsyncGenerator<StreamChunk> {
      throw new Error('LLM unavailable')
    },
  } as unknown as LLMProvider
}

const acmeInc: EntityCandidate = {
  id: 'e1',
  kind: 'company',
  display_name: 'Acme Inc.',
  canonical_id: 'acme.com',
}
const acmeAi: EntityCandidate = {
  id: 'e2',
  kind: 'company',
  display_name: 'Acme AI',
  canonical_id: 'acme.ai',
}
const acmeCorpDup: EntityCandidate = {
  id: 'e3',
  kind: 'company',
  display_name: 'acme inc',
  canonical_id: 'acme-eu.com',
}
const sarah: EntityCandidate = {
  id: 'p1',
  kind: 'person',
  display_name: 'Sarah Park',
  canonical_id: 'sarah@acme.com',
}

describe('[COMP:brain/entity-resolution] resolveEntity', () => {
  describe('tier 1: exact display_name (case-insensitive)', () => {
    it('resolves a single exact match', async () => {
      const result = await resolveEntity({
        mention: { kind: 'company', display_name: 'ACME INC.' },
        candidates: [acmeInc, acmeAi],
      })
      expect(result.status).toBe('resolved')
      if (result.status === 'resolved') {
        expect(result.tier).toBe('exact')
        expect(result.entityId).toBe('e1')
        expect(result.score).toBe(1)
        expect(result.flagged).toBeUndefined()
      }
    })

    it('returns ambiguous when multiple exact matches and no LLM supplied', async () => {
      const result = await resolveEntity({
        mention: { kind: 'company', display_name: 'Acme Inc' },
        candidates: [acmeInc, acmeAi, acmeCorpDup],
      })
      expect(result.status).toBe('ambiguous')
      if (result.status === 'ambiguous') {
        expect(result.tier).toBe('exact')
        expect(result.candidates.map((c) => c.id).sort()).toEqual(['e1', 'e3'])
      }
    })
  })

  describe('tier 2: canonical_id exact', () => {
    it('resolves by canonical_id when display_name does not match', async () => {
      const result = await resolveEntity({
        mention: { kind: 'company', display_name: 'totally different name', canonical_id: 'acme.com' },
        candidates: [acmeInc, acmeAi],
      })
      expect(result.status).toBe('resolved')
      if (result.status === 'resolved') {
        expect(result.tier).toBe('canonical_id')
        expect(result.entityId).toBe('e1')
      }
    })

    it('skips tier 2 cleanly when mention has no canonical_id', async () => {
      const result = await resolveEntity({
        mention: { kind: 'company', display_name: 'something else' },
        candidates: [acmeInc, acmeAi],
      })
      expect(result.status).toBe('no_match')
    })

    it('returns ambiguous when multiple canonical_id matches and no LLM', async () => {
      const dupCanon: EntityCandidate = { ...acmeAi, id: 'e2b', canonical_id: 'acme.com' }
      const result = await resolveEntity({
        mention: { kind: 'company', display_name: 'totally different', canonical_id: 'acme.com' },
        candidates: [acmeInc, dupCanon],
      })
      expect(result.status).toBe('ambiguous')
      if (result.status === 'ambiguous') {
        expect(result.tier).toBe('canonical_id')
        expect(result.candidates.length).toBe(2)
      }
    })
  })

  describe('tier 3: fuzzy Jaro-Winkler', () => {
    it('resolves a single fuzzy match above threshold and flags it', async () => {
      const result = await resolveEntity({
        mention: { kind: 'company', display_name: 'Acme Incorparated' },
        candidates: [acmeInc],
      })
      expect(result.status).toBe('resolved')
      if (result.status === 'resolved') {
        expect(result.tier).toBe('fuzzy')
        expect(result.flagged).toBe(true)
        expect(result.score).toBeGreaterThanOrEqual(0.85)
      }
    })

    it('returns no_match when best fuzzy score is below threshold', async () => {
      const result = await resolveEntity({
        mention: { kind: 'company', display_name: 'Zyxwvu Holdings' },
        candidates: [acmeInc, acmeAi],
      })
      expect(result.status).toBe('no_match')
    })

    it('returns ambiguous when multiple fuzzy matches and no LLM', async () => {
      const acmeIncorp: EntityCandidate = { ...acmeInc, id: 'e1b', display_name: 'Acme Incorparated' }
      const acmeIncorporated: EntityCandidate = { ...acmeInc, id: 'e1c', display_name: 'Acme Incorporated' }
      const result = await resolveEntity({
        mention: { kind: 'company', display_name: 'Acme Incorprated' },
        candidates: [acmeIncorp, acmeIncorporated],
      })
      expect(result.status).toBe('ambiguous')
      if (result.status === 'ambiguous') {
        expect(result.tier).toBe('fuzzy')
        expect(result.candidates.length).toBe(2)
      }
    })
  })

  describe('tier 4: LLM disambiguation', () => {
    it('promotes tier 1 ambiguous to resolved via LLM', async () => {
      const result = await resolveEntity({
        mention: { kind: 'company', display_name: 'Acme Inc' },
        candidates: [acmeInc, acmeCorpDup],
        llm: { provider: mockProvider('{"id":"e3"}'), model: 'mock-flash' },
      })
      expect(result.status).toBe('resolved')
      if (result.status === 'resolved') {
        expect(result.tier).toBe('llm')
        expect(result.entityId).toBe('e3')
        expect(result.usage).toBeDefined()
        expect(result.model).toBe('mock-flash')
      }
    })

    it('returns ambiguous when LLM responds with "ambiguous"', async () => {
      const result = await resolveEntity({
        mention: { kind: 'company', display_name: 'Acme Inc' },
        candidates: [acmeInc, acmeCorpDup],
        llm: { provider: mockProvider('{"id":"ambiguous"}'), model: 'mock-flash' },
      })
      expect(result.status).toBe('ambiguous')
      if (result.status === 'ambiguous') {
        expect(result.tier).toBe('exact')
        expect(result.usage).toBeDefined()
      }
    })

    it('returns ambiguous when LLM returns an id not in candidates', async () => {
      const result = await resolveEntity({
        mention: { kind: 'company', display_name: 'Acme Inc' },
        candidates: [acmeInc, acmeCorpDup],
        llm: { provider: mockProvider('{"id":"not-a-real-id"}'), model: 'mock-flash' },
      })
      expect(result.status).toBe('ambiguous')
    })

    it('returns ambiguous when LLM emits malformed JSON', async () => {
      const result = await resolveEntity({
        mention: { kind: 'company', display_name: 'Acme Inc' },
        candidates: [acmeInc, acmeCorpDup],
        llm: { provider: mockProvider('not json at all'), model: 'mock-flash' },
      })
      expect(result.status).toBe('ambiguous')
    })

    it('returns ambiguous when LLM call throws', async () => {
      const result = await resolveEntity({
        mention: { kind: 'company', display_name: 'Acme Inc' },
        candidates: [acmeInc, acmeCorpDup],
        llm: { provider: throwingProvider(), model: 'mock-flash' },
      })
      expect(result.status).toBe('ambiguous')
    })

    it('tolerates markdown-fenced JSON', async () => {
      const result = await resolveEntity({
        mention: { kind: 'company', display_name: 'Acme Inc' },
        candidates: [acmeInc, acmeCorpDup],
        llm: { provider: mockProvider('```json\n{"id":"e1"}\n```'), model: 'mock-flash' },
      })
      expect(result.status).toBe('resolved')
      if (result.status === 'resolved') expect(result.entityId).toBe('e1')
    })

    it('promotes tier 3 fuzzy multi-match to resolved via LLM', async () => {
      const acmeIncorp: EntityCandidate = { ...acmeInc, id: 'e1b', display_name: 'Acme Incorparated' }
      const acmeIncorporated: EntityCandidate = { ...acmeInc, id: 'e1c', display_name: 'Acme Incorporated' }
      const result = await resolveEntity({
        mention: { kind: 'company', display_name: 'Acme Incorprated' },
        candidates: [acmeIncorp, acmeIncorporated],
        llm: { provider: mockProvider('{"id":"e1c"}'), model: 'mock-flash' },
      })
      expect(result.status).toBe('resolved')
      if (result.status === 'resolved') {
        expect(result.tier).toBe('llm')
        expect(result.entityId).toBe('e1c')
      }
    })
  })

  describe('kind filter', () => {
    it('ignores candidates of the wrong kind across all tiers', async () => {
      const result = await resolveEntity({
        mention: { kind: 'person', display_name: 'Acme Inc.', canonical_id: 'acme.com' },
        candidates: [acmeInc, sarah],
      })
      // acmeInc shares display_name + canonical_id but is the wrong kind
      expect(result.status).toBe('no_match')
    })
  })
})

describe('[COMP:brain/entity-resolution] jaroWinkler', () => {
  it('returns 1.0 for identical strings', () => {
    expect(jaroWinkler('acme', 'acme')).toBe(1)
  })

  it('returns 0 for empty inputs', () => {
    expect(jaroWinkler('', 'acme')).toBe(0)
    expect(jaroWinkler('acme', '')).toBe(0)
  })

  it('matches the textbook MARTHA/MARHTA fixture', () => {
    expect(jaroWinkler('martha', 'marhta')).toBeGreaterThanOrEqual(0.95)
  })

  it('matches the textbook DIXON/DICKSONX fixture', () => {
    const score = jaroWinkler('dixon', 'dicksonx')
    expect(score).toBeGreaterThan(0.79)
    expect(score).toBeLessThan(0.84)
  })

  it('returns a low score for disjoint strings', () => {
    expect(jaroWinkler('abcde', 'fghij')).toBeLessThan(0.3)
  })
})

describe('[COMP:brain/entity-resolution] normalizeName', () => {
  it('lowercases, trims, and collapses whitespace', () => {
    expect(normalizeName('  ACME   Inc  ')).toBe('acme inc')
  })

  it('strips trailing punctuation', () => {
    expect(normalizeName('Acme Inc.')).toBe('acme inc')
    expect(normalizeName('“Acme”')).toBe('acme')
  })
})
