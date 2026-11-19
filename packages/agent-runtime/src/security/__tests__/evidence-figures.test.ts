import { describe, it, expect } from 'vitest'
import {
  EvidenceAccumulator,
  extractFigureKeys,
  extractFigureClaims,
} from '../evidence.js'

describe('[COMP:engine/grounding-gate] Figure canonicalization', () => {
  it('equates formats: 40,000 = 40000 = 4萬 = 四萬 = ４０，０００', () => {
    const canonical = (s: string) => [...extractFigureKeys(s)]
    expect(canonical('40,000')).toContain('n:40000')
    expect(canonical('40000')).toContain('n:40000')
    expect(canonical('4萬')).toContain('n:40000')
    expect(canonical('四萬')).toContain('n:40000')
    expect(canonical('４０，０００')).toContain('n:40000')
  })

  it('parses compound CJK numerals', () => {
    expect([...extractFigureKeys('十一萬')]).toContain('n:110000')
    expect([...extractFigureKeys('四萬五千')]).toContain('n:45000')
    expect([...extractFigureKeys('36.4萬')]).toContain('n:364000')
  })

  it('equates date formats: 7月23日 = July 23 = 2026-07-23', () => {
    expect([...extractFigureKeys('7月23日')]).toContain('d:7-23')
    expect([...extractFigureKeys('July 23rd')]).toContain('d:7-23')
    expect([...extractFigureKeys('2026-07-23')]).toContain('d:7-23')
  })

  it('extracts percentages', () => {
    expect([...extractFigureKeys('回贈 4.5%')]).toContain('p:4.5')
    expect([...extractFigureKeys('４．５％')]).toContain('p:4.5')
  })
})

describe('[COMP:engine/grounding-gate] Claim extraction is conservative', () => {
  it('flags currency, unit amounts, magnitudes, separated numbers, percents, dates', () => {
    const claims = extractFigureClaims(
      '簽滿 HK$20,000 送 40,000 里 (平均 HK$0.5/里), 至 7月23號, 回贈 4.5%, 高階要簽夠十一萬',
    )
    const canonicals = claims.map((c) => c.canonical)
    expect(canonicals).toContain('n:20000')
    expect(canonicals).toContain('n:40000')
    expect(canonicals).toContain('d:7-23')
    expect(canonicals).toContain('p:4.5')
    expect(canonicals).toContain('n:110000')
  })

  it('never flags bare small integers or counts', () => {
    expect(extractFigureClaims('the offer has 3 parts and 2 steps')).toHaveLength(0)
    expect(extractFigureClaims('42')).toHaveLength(0)
    expect(extractFigureClaims('我哋一齊研究下')).toHaveLength(0)
  })

  it('dedupes by canonical value', () => {
    const claims = extractFigureClaims('HK$40,000 即係 40,000 蚊')
    expect(claims.filter((c) => c.canonical === 'n:40000')).toHaveLength(1)
  })
})

describe('[COMP:engine/grounding-gate] Figure evidence accumulation', () => {
  it('attributes tool-observed figures to their source, first-seen wins', () => {
    const ev = new EvidenceAccumulator()
    ev.noteToolResult('迎新送 40,000 里', '{"query":"topic"}', {
      toolUseId: 't1',
      toolName: 'webSearch',
    })
    ev.noteToolResult('another page also says 40,000', '{"url":"x.com/a"}', {
      toolUseId: 't2',
      toolName: 'urlReader',
    })
    expect(ev.hasFigure('n:40000')).toBe(true)
    expect(ev.figureSource('n:40000')).toEqual({ toolUseId: 't1', toolName: 'webSearch' })
  })

  it('seeded material counts as evidence with null source', () => {
    const ev = new EvidenceAccumulator()
    ev.note('user said the threshold is 11萬')
    expect(ev.hasFigure('n:110000')).toBe(true)
    expect(ev.figureSource('n:110000')).toBeNull()
  })

  it('excludes input-echoed figures — searching a number cannot verify it', () => {
    const ev = new EvidenceAccumulator()
    ev.noteToolResult(
      'Search results for "迎新 40,000 里": no exact matches found',
      '{"query":"迎新 40,000 里"}',
      { toolUseId: 't1', toolName: 'webSearch' },
    )
    expect(ev.hasFigure('n:40000')).toBe(false)
  })

  it('never feeds errors (caller contract) and unknown figures stay unverified', () => {
    const ev = new EvidenceAccumulator()
    expect(ev.hasFigure('n:99999')).toBe(false)
    expect(ev.figureSource('n:99999')).toBeUndefined()
  })
})
