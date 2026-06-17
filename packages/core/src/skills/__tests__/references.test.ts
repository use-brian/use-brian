import { describe, it, expect } from 'vitest'
import { parseSkillReferences } from '../references.js'

describe('[COMP:skills/edge-references] Skill reference parser', () => {
  const E = '11111111-1111-4111-8111-111111111111'
  const M = '22222222-2222-4222-8222-222222222222'
  const K = '33333333-3333-4333-8333-333333333333'

  it('extracts wikilink-style entity references', () => {
    const refs = parseSkillReferences(`Follow up with [[entity:${E}]] before the call.`)
    expect(refs.entity).toEqual([E])
    expect(refs.memory).toEqual([])
    expect(refs.kb_chunk).toEqual([])
  })

  it('extracts markdown-mention-style references across all three kinds', () => {
    const refs = parseSkillReferences(
      `Use @[Acme](entity:${E}) and recall @[pref](memory:${M}) and @[doc](kb_chunk:${K}).`,
    )
    expect(refs.entity).toEqual([E])
    expect(refs.memory).toEqual([M])
    expect(refs.kb_chunk).toEqual([K])
  })

  it('dedupes repeated references and lowercases ids', () => {
    const refs = parseSkillReferences(`[[entity:${E}]] again [[entity:${E.toUpperCase()}]]`)
    expect(refs.entity).toEqual([E])
  })

  it('ignores unknown kinds and bare uuids (zero inference)', () => {
    const refs = parseSkillReferences(`task:${E}, file:${E}, and a bare ${M} are not references`)
    expect(refs).toEqual({ entity: [], memory: [], kb_chunk: [] })
  })

  it('does not match a kind glued to a preceding word char', () => {
    const refs = parseSkillReferences(`notentity:${E} should not match`)
    expect(refs.entity).toEqual([])
  })

  it('returns empty for empty content', () => {
    expect(parseSkillReferences('')).toEqual({ entity: [], memory: [], kb_chunk: [] })
  })
})
