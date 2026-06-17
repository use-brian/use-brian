import { describe, it, expect } from 'vitest'
import {
  synthesizeMissingToolResults,
  ensureToolResultPairing,
  stripUnsignedToolUses,
  SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
} from '../tool-pairing.js'
import type { ContentBlock, Message } from '../../providers/types.js'

// Small factory helpers to keep test setup terse.
const toolUse = (id: string, name = 'getMemory', providerSignature?: string): ContentBlock => ({
  type: 'tool_use',
  id,
  name,
  input: {},
  ...(providerSignature ? { providerSignature } : {}),
})
const toolResult = (toolUseId: string, name = 'getMemory', content = 'ok'): ContentBlock => ({
  type: 'tool_result',
  toolUseId,
  name,
  content,
})
const text = (s: string): ContentBlock => ({ type: 'text', text: s })

describe('[COMP:engine/tool-pairing] synthesizeMissingToolResults', () => {
  it('returns empty when every tool_use is already resolved', () => {
    const assistant: ContentBlock[] = [toolUse('a'), toolUse('b')]
    const results: ContentBlock[] = [toolResult('a'), toolResult('b')]
    expect(synthesizeMissingToolResults(assistant, results, 'aborted')).toEqual([])
  })

  it('synthesises only the missing tool_uses', () => {
    const assistant: ContentBlock[] = [toolUse('a'), toolUse('b'), toolUse('c')]
    const results: ContentBlock[] = [toolResult('a')]
    const synth = synthesizeMissingToolResults(assistant, results, 'aborted')
    expect(synth).toHaveLength(2)
    expect(synth.map((b) => (b as Extract<ContentBlock, { type: 'tool_result' }>).toolUseId)).toEqual(['b', 'c'])
    for (const s of synth) {
      expect(s.type).toBe('tool_result')
      if (s.type === 'tool_result') {
        expect(s.isError).toBe(true)
        expect(s.content).toBe('aborted')
      }
    }
  })

  it('ignores non-tool_use blocks in the assistant content', () => {
    const assistant: ContentBlock[] = [text('hello'), toolUse('a'), text('world')]
    const synth = synthesizeMissingToolResults(assistant, [], 'aborted')
    expect(synth).toHaveLength(1)
    expect(synth[0]).toMatchObject({ type: 'tool_result', toolUseId: 'a', isError: true })
  })

  it('ignores non-tool_result blocks when counting existing results', () => {
    // A user message with text interleaved with tool_results should still
    // correctly identify the tool_use_ids already covered.
    const assistant: ContentBlock[] = [toolUse('a'), toolUse('b')]
    const results: ContentBlock[] = [text('noise'), toolResult('a')]
    const synth = synthesizeMissingToolResults(assistant, results, 'lost')
    expect(synth).toHaveLength(1)
    expect((synth[0] as Extract<ContentBlock, { type: 'tool_result' }>).toolUseId).toBe('b')
  })
})

describe('[COMP:engine/tool-pairing] ensureToolResultPairing', () => {
  it('passes a well-formed history through unchanged', () => {
    const msgs: Message[] = [
      { role: 'user', content: [text('what is the weather?')] },
      { role: 'assistant', content: [toolUse('w1', 'weather')] },
      { role: 'user', content: [toolResult('w1', 'weather', '{"temp":22}')] },
      { role: 'assistant', content: [text('It is 22°C.')] },
    ]
    const repaired = ensureToolResultPairing(msgs)
    expect(repaired).toEqual(msgs)
  })

  it('inserts a synthetic user message when an assistant tool_use has no follow-up', () => {
    // Exactly the regression case from the orphan bug: the last assistant
    // turn is tool_use only, and nothing follows.
    const msgs: Message[] = [
      { role: 'user', content: [text('sth i mentioned before')] },
      { role: 'assistant', content: [toolUse('m1', 'getMemory'), toolUse('m2', 'getMemory')] },
    ]
    const repaired = ensureToolResultPairing(msgs)
    expect(repaired).toHaveLength(3)
    expect(repaired[2].role).toBe('user')
    const blocks = repaired[2].content as ContentBlock[]
    expect(blocks).toHaveLength(2)
    expect(blocks.every((b) => b.type === 'tool_result')).toBe(true)
    const ids = blocks
      .filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result')
      .map((b) => b.toolUseId)
    expect(ids.sort()).toEqual(['m1', 'm2'])
    for (const b of blocks) {
      if (b.type === 'tool_result') {
        expect(b.isError).toBe(true)
        expect(b.content).toBe(SYNTHETIC_TOOL_RESULT_PLACEHOLDER)
      }
    }
  })

  it('fills in only the missing tool_results when the follow-up is partial', () => {
    const msgs: Message[] = [
      { role: 'user', content: [text('search x')] },
      { role: 'assistant', content: [toolUse('a'), toolUse('b'), toolUse('c')] },
      { role: 'user', content: [toolResult('a', 'getMemory', 'ok')] },
    ]
    const repaired = ensureToolResultPairing(msgs)
    expect(repaired).toHaveLength(3)
    const userBlocks = repaired[2].content as ContentBlock[]
    const ids = userBlocks
      .filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result')
      .map((b) => b.toolUseId)
    expect(ids.sort()).toEqual(['a', 'b', 'c'])
  })

  it('strips orphan tool_result blocks that reference no prior tool_use', () => {
    const msgs: Message[] = [
      { role: 'user', content: [text('hello')] },
      { role: 'assistant', content: [text('hi')] },
      // Dangling tool_result — no prior tool_use to pair against.
      { role: 'user', content: [toolResult('ghost'), text('next question')] },
    ]
    const repaired = ensureToolResultPairing(msgs)
    expect(repaired).toHaveLength(3)
    const last = repaired[2].content as ContentBlock[]
    expect(last).toEqual([text('next question')])
  })

  it('drops user messages that become empty after stripping orphan tool_results', () => {
    const msgs: Message[] = [
      { role: 'user', content: [text('hello')] },
      { role: 'assistant', content: [text('hi')] },
      { role: 'user', content: [toolResult('ghost')] },
      { role: 'user', content: [text('real message')] },
    ]
    const repaired = ensureToolResultPairing(msgs)
    expect(repaired.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(repaired[2].content).toEqual([text('real message')])
  })

  it('is idempotent — running the repair twice is a no-op', () => {
    const msgs: Message[] = [
      { role: 'user', content: [text('x')] },
      { role: 'assistant', content: [toolUse('a')] },
    ]
    const once = ensureToolResultPairing(msgs)
    const twice = ensureToolResultPairing(once)
    expect(twice).toEqual(once)
  })

  it('preserves system messages in place', () => {
    const msgs: Message[] = [
      { role: 'system', content: [text('compact summary')] },
      { role: 'user', content: [text('then what?')] },
      { role: 'assistant', content: [toolUse('a')] },
    ]
    const repaired = ensureToolResultPairing(msgs)
    expect(repaired[0]).toEqual(msgs[0])
    expect(repaired).toHaveLength(4)
    expect(repaired[3].role).toBe('user')
  })

  it('drops fully-empty assistant rows on read (cgov regression self-heal)', () => {
    // Pre-fix the public-API route persisted `content: []` whenever the
    // queryLoop exited with an empty turn_complete. Those rows would
    // load on the next turn and break role-alternation. The repair pass
    // self-heals them.
    const msgs: Message[] = [
      { role: 'user', content: [text('hello')] },
      { role: 'assistant', content: [] },
      { role: 'user', content: [text('still there?')] },
    ]
    const repaired = ensureToolResultPairing(msgs)
    expect(repaired).toHaveLength(2)
    expect(repaired[0]).toEqual(msgs[0])
    expect(repaired[1]).toEqual(msgs[2])
  })

  it('passes string-shaped legacy content through untouched', () => {
    // Messages whose content is a plain string can't contain tool_use or
    // tool_result, so the repair pass has nothing to do. Preserve the
    // original shape — the Gemini provider already handles both forms.
    const msgs: Message[] = [
      { role: 'user', content: 'legacy text' },
      { role: 'assistant', content: 'legacy reply' },
    ]
    const repaired = ensureToolResultPairing(msgs)
    expect(repaired).toEqual(msgs)
  })

  it('handles the multi-turn tool-use case with interleaved assistant turns', () => {
    const msgs: Message[] = [
      { role: 'user', content: [text('q')] },
      { role: 'assistant', content: [toolUse('a')] },
      { role: 'user', content: [toolResult('a')] },
      { role: 'assistant', content: [toolUse('b')] },
      // No results for b — Turn 2 was left orphaned.
    ]
    const repaired = ensureToolResultPairing(msgs)
    expect(repaired).toHaveLength(5)
    const lastUser = repaired[4].content as ContentBlock[]
    expect(lastUser).toHaveLength(1)
    expect((lastUser[0] as Extract<ContentBlock, { type: 'tool_result' }>).toolUseId).toBe('b')
  })
})

describe('[COMP:engine/tool-pairing] stripUnsignedToolUses', () => {
  it('passes through signed tool_uses untouched', () => {
    const msgs: Message[] = [
      { role: 'user', content: [text('q')] },
      { role: 'assistant', content: [text('thinking'), toolUse('a', 'saveMemory', 'sig-a')] },
      { role: 'user', content: [toolResult('a', 'saveMemory', 'saved')] },
      { role: 'assistant', content: [text('done')] },
    ]
    expect(stripUnsignedToolUses(msgs)).toEqual(msgs)
  })

  it('drops unsigned tool_use blocks and their paired tool_result', () => {
    const msgs: Message[] = [
      { role: 'user', content: [text('q')] },
      // Unsigned tool_use — legacy row from before the signature fix.
      { role: 'assistant', content: [text('thinking'), toolUse('legacy-1', 'saveMemory')] },
      { role: 'user', content: [toolResult('legacy-1', 'saveMemory', 'saved')] },
      { role: 'assistant', content: [text('done')] },
    ]
    const stripped = stripUnsignedToolUses(msgs)
    // Four messages in, four out — but the assistant message kept only its
    // text, and the user turn that held the paired result was dropped since
    // it became empty after removing the orphan.
    expect(stripped).toHaveLength(3)
    expect(stripped[0]).toEqual(msgs[0])
    const secondContent = stripped[1].content as ContentBlock[]
    expect(secondContent).toHaveLength(1)
    expect(secondContent[0].type).toBe('text')
    expect(stripped[2]).toEqual(msgs[3])
  })

  it('drops an assistant message that was nothing but an unsigned tool_use', () => {
    const msgs: Message[] = [
      { role: 'user', content: [text('q')] },
      { role: 'assistant', content: [toolUse('x')] },
      { role: 'user', content: [toolResult('x')] },
    ]
    const stripped = stripUnsignedToolUses(msgs)
    expect(stripped).toHaveLength(1)
    expect(stripped[0]).toEqual(msgs[0])
  })

  it('keeps unrelated content blocks in a user turn that also held a dropped tool_result', () => {
    const msgs: Message[] = [
      { role: 'assistant', content: [toolUse('x')] },
      { role: 'user', content: [toolResult('x'), text('thanks')] },
    ]
    const stripped = stripUnsignedToolUses(msgs)
    expect(stripped).toHaveLength(1)
    const content = stripped[0].content as ContentBlock[]
    expect(content).toEqual([text('thanks')])
  })

  it('keeps a signed tool_use next to an unsigned one and only strips the latter', () => {
    const msgs: Message[] = [
      { role: 'assistant', content: [toolUse('signed', 'getMemory', 'sig-1'), toolUse('legacy', 'saveMemory')] },
      { role: 'user', content: [toolResult('signed'), toolResult('legacy')] },
    ]
    const stripped = stripUnsignedToolUses(msgs)
    expect(stripped).toHaveLength(2)
    const asst = stripped[0].content as ContentBlock[]
    expect(asst).toHaveLength(1)
    expect((asst[0] as Extract<ContentBlock, { type: 'tool_use' }>).id).toBe('signed')
    const usr = stripped[1].content as ContentBlock[]
    expect(usr).toHaveLength(1)
    expect((usr[0] as Extract<ContentBlock, { type: 'tool_result' }>).toolUseId).toBe('signed')
  })
})
