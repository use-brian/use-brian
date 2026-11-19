import { describe, it, expect, vi } from 'vitest'
import { compactConversation } from '../compact.js'
import type { CompactionTopicGroup } from '../compact.js'
import type { Message, LLMProvider, StreamFn } from '../../providers/types.js'
import { bindScopeSources, boundScopeSources } from '../../security/source-evidence.js'
import type { ScopeSource } from '../../security/derived-scope.js'

const key = `topic:v2:${'a'.repeat(64)}`
function fixture(text = '## TOPIC: t0 [ACTIVE]\nPlanning trip.\n## TOPIC: t1\nLegacy facts.\n## TOPIC: unassigned\nUnknown context.') {
  const groups: CompactionTopicGroup[] = [
    { topicLabel: key, messageIndexes: [0, 1, 4], messageSpan: { fromSequence: 10, toSequence: 80, turnCount: 2 } },
    { topicLabel: 'Legacy CASE!', messageIndexes: [2], messageSpan: { fromSequence: 30, toSequence: 30, turnCount: 1 } },
  ]
  const messages: Message[] = Array.from({ length: 6 }, (_, i) => ({ role: i === 1 ? 'assistant' : 'user', content: `Message ${i}` }))
  const stream = vi.fn<StreamFn>(async function* () { yield { type: 'text_delta', text } })
  const provider = { stream } as unknown as LLMProvider
  return { groups, messages, stream, options: { provider, model: 'mock', systemPrompt: '', messages, profile: 'multi-topic' as const, topicGroups: groups } }
}

describe('canonical topic compaction', () => {
  it('preserves noncontiguous exact keys, host spans, unassigned context and safe prompt tokens', async () => {
    const f = fixture()
    const result = await compactConversation(f.options)
    expect(result.episodes?.map(e => [e.topicLabel, e.messageSpan])).toEqual(f.groups.map(g => [g.topicLabel, g.messageSpan]))
    const prompt = String(f.stream.mock.calls[0][0].messages.at(-1)?.content)
    expect(prompt).toContain('"messageIndexes":[0,1,4]')
    expect(prompt).toContain('"token":"unassigned","messageIndexes":[3,5]')
    expect(prompt).not.toContain(key)
    expect(prompt).not.toContain('Legacy CASE!')
    expect(result.boundaryMessage.content).toContain('Topic 1')
    expect(result.boundaryMessage.content).not.toContain(key)
    expect(result.boundaryMessage.content).toContain('Unknown context.')
    expect(result.episodes).toHaveLength(2)
  })

  it.each([
    '## TOPIC: renamed\nFacts',
    '## TOPIC: t0\nFacts',
    '## TOPIC: t0\nFacts\n## TOPIC: t0\nDuplicate\n## TOPIC: t1\nFacts\n## TOPIC: unassigned\nContext',
    '## TOPIC: t0\nFacts\n## TOPIC: t1\nFacts',
    '## TOPIC: t0\nFacts\n## TOPIC: t1\nFacts\n## TOPIC: unassigned\nContext\n## TOPIC: t2\nInvented',
  ])('degrades the entire response, not just partial sections', async text => {
    const result = await compactConversation(fixture(text).options)
    expect(result.episodes).toEqual([])
    expect(result.boundaryMessage.content).toContain(text)
    expect(result.boundaryMessage.content).toContain('parsing failed')
  })

  it('captures group keys, membership and spans before authority awaits, binding all sources', async () => {
    const f = fixture()
    const source: ScopeSource = { workspaceId: 'w', resourceKind: 'session_message', resourceId: 'm', version: '1', userId: null, assistantId: null, sensitivity: 'internal', compartments: [], projectIds: [] }
    bindScopeSources(f.messages[5], [source]) // unassigned evidence still binds every derived output
    const arraySource = { ...source, resourceId: 'array-evidence' }
    const optionsSource = { ...source, resourceId: 'options-evidence' }
    bindScopeSources(f.messages, [arraySource])
    const options = bindScopeSources({ ...f.options, assertInputAuthority: async () => {
      f.groups[0].topicLabel = 'mutated'
      f.groups[0].messageIndexes.splice(0, 3, 5)
      f.groups[0].messageSpan.toSequence = 999
    } }, [optionsSource])
    const result = await compactConversation(options)
    expect(result.episodes?.[0].topicLabel).toBe(key)
    expect(result.episodes?.[0].messageSpan.toSequence).toBe(80)
    expect(String(f.stream.mock.calls[0][0].messages.at(-1)?.content)).toContain('"messageIndexes":[0,1,4]')
    for (const output of [result, result.boundaryMessage, ...result.episodes!]) {
      expect(boundScopeSources(output)).toEqual(expect.arrayContaining([source, arraySource, optionsSource]))
    }
  })

  it('pins nested message contents, provider implementation, model and authority callback before awaiting', async () => {
    const f = fixture()
    const input = { query: { text: 'original Acorn query' } }
    f.messages[1].content = [{ type: 'tool_use', id: 'call', name: 'search', input }]
    const replacement = vi.fn<StreamFn>(async function* () { throw new Error('Replacement must not run') })
    const bypass = vi.fn(async () => {})
    const check = vi.fn(async () => {
      input.query.text = 'mutated query'
      f.messages[0].content = 'mutated message'
      options.model = 'mutated model'
      options.systemPrompt = 'mutated prompt'
      f.options.provider.stream = replacement
      options.assertInputAuthority = bypass
    })
    const options = { ...f.options, assertInputAuthority: check }
    const result = await compactConversation(options)
    const request = f.stream.mock.calls[0][0]
    expect(request.messages[0].content).toBe('Message 0')
    expect(request.messages[1].content).toEqual([{ type: 'tool_use', id: 'call', name: 'search', input: { query: { text: 'original Acorn query' } } }])
    expect(request.model).toBe('mock')
    expect(request.systemPrompt).toBe('')
    expect(request.assertInputAuthority).toBe(check)
    expect(result.model).toBe('mock')
    expect(check).toHaveBeenCalledTimes(2)
    expect(bypass).not.toHaveBeenCalled()
    expect(replacement).not.toHaveBeenCalled()
  })

  it.each([NaN, Infinity, -1, 6, 0.5, 2])('rejects invalid or overlapping host indices %s before dispatch', async index => {
    const f = fixture()
    f.groups[0].messageIndexes.push(index)
    await expect(compactConversation(f.options)).rejects.toThrow('index')
    expect(f.stream).not.toHaveBeenCalled()
  })

  it('rejects duplicate exact host keys and duplicate membership within a group', async () => {
    const f = fixture()
    f.groups[1].topicLabel = key
    await expect(compactConversation(f.options)).rejects.toThrow('key')
    const other = fixture()
    other.groups[0].messageIndexes.push(0)
    await expect(compactConversation(other.options)).rejects.toThrow('index')
    expect(f.stream).not.toHaveBeenCalled()
    expect(other.stream).not.toHaveBeenCalled()
  })

  it('does not merge case-distinct legacy keys', async () => {
    const f = fixture()
    f.groups[0].topicLabel = 'Exact Legacy'
    f.groups[1].topicLabel = 'exact legacy'
    const result = await compactConversation(f.options)
    expect(result.episodes?.map(e => e.topicLabel)).toEqual(['Exact Legacy', 'exact legacy'])
  })

  it('ignores model-declared spans in favor of host spans', async () => {
    const result = await compactConversation(fixture('## TOPIC: t0\nTrip.\nMESSAGE_SPAN: from=1 to=2 turns=999\n## TOPIC: t1\nLegacy.\n## TOPIC: unassigned\nContext.').options)
    expect(result.episodes?.[0].messageSpan).toEqual({ fromSequence: 10, toSequence: 80, turnCount: 2 })
  })
})
