import { describe, it, expect } from 'vitest'
import { createGoalClarityAssessor, parseClarityVerdict } from '../clarity.js'
import type { LLMProvider, StreamChunk } from '../../providers/types.js'

/**
 * [COMP:goals/clarity] The confirmation clarity gate (task-goal-seeker.md §12).
 * Lenient + fail-open: only an explicit `clear:false` blocks; everything else
 * (parse failure, model error, missing field) confirms.
 */

function mockProvider(response: string): LLMProvider {
  return {
    createSession() {
      return { thoughtSignature: undefined } as never
    },
    async *stream(): AsyncGenerator<StreamChunk> {
      yield { type: 'text_delta', text: response } as StreamChunk
    },
  } as unknown as LLMProvider
}

function throwingProvider(): LLMProvider {
  return {
    createSession() {
      return {} as never
    },
    async *stream(): AsyncGenerator<StreamChunk> {
      throw new Error('model down')
    },
  } as unknown as LLMProvider
}

describe('[COMP:goals/clarity] parseClarityVerdict', () => {
  it('treats explicit clear:false as not clear and surfaces the question', () => {
    const v = parseClarityVerdict('{"clear": false, "question": "What does done look like?"}')
    expect(v.clear).toBe(false)
    expect(v.clarifyingQuestion).toBe('What does done look like?')
  })

  it('treats clear:true as clear', () => {
    expect(parseClarityVerdict('{"clear": true, "question": ""}').clear).toBe(true)
  })

  it('tolerates fenced / surrounding prose around the JSON', () => {
    expect(parseClarityVerdict('Here you go:\n```json\n{"clear": true}\n```').clear).toBe(true)
  })

  it('fails open on unparseable text', () => {
    expect(parseClarityVerdict('not json at all').clear).toBe(true)
  })

  it('fails open when `clear` is absent — only an explicit false blocks', () => {
    expect(parseClarityVerdict('{"question":"x"}').clear).toBe(true)
  })

  it('falls back to a default question when clear:false omits one', () => {
    const v = parseClarityVerdict('{"clear": false}')
    expect(v.clear).toBe(false)
    expect(v.clarifyingQuestion).toBeTruthy()
  })
})

describe('[COMP:goals/clarity] createGoalClarityAssessor', () => {
  it('returns clear for a concrete outcome', async () => {
    const assess = createGoalClarityAssessor({ provider: mockProvider('{"clear":true}'), model: 'mock' })
    expect((await assess({ outcome: 'Email the Q3 report to Acme' })).clear).toBe(true)
  })

  it('blocks a vague outcome with a clarifying question', async () => {
    const assess = createGoalClarityAssessor({
      provider: mockProvider('{"clear":false,"question":"How will we know the business has grown enough?"}'),
      model: 'mock',
    })
    const v = await assess({ outcome: 'grow the business' })
    expect(v.clear).toBe(false)
    expect(v.clarifyingQuestion).toContain('grown')
  })

  it('fails open (clear) when the model errors', async () => {
    const assess = createGoalClarityAssessor({ provider: throwingProvider(), model: 'mock' })
    expect((await assess({ outcome: 'anything' })).clear).toBe(true)
  })

  it('forwards usage to onUsage with the confirming userId', async () => {
    let seenUser: string | undefined = 'unset'
    const assess = createGoalClarityAssessor({
      provider: mockProvider('{"clear":true}'),
      model: 'mock',
      onUsage: (_usage, userId) => {
        seenUser = userId
      },
    })
    await assess({ outcome: 'x', userId: 'u1' })
    expect(seenUser).toBe('u1')
  })
})
