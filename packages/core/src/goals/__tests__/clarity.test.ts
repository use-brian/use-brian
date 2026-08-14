import { describe, it, expect, vi } from 'vitest'
import { createGoalClarityAssessor, parseClarityVerdict } from '../clarity.js'
import type { LLMProvider, StreamChunk } from '../../providers/types.js'

/**
 * [COMP:goals/clarity] The confirmation clarity gate (task-goal-seeker.md §12).
 * Lenient + fail-open: only an explicit `clear:false` blocks; everything else
 * (parse failure, model error, missing field) confirms.
 */

function mockProvider(response: string, seenRequests?: Array<Record<string, unknown>>): LLMProvider {
  return {
    createSession() {
      return { thoughtSignature: undefined } as never
    },
    async *stream(request: Record<string, unknown>): AsyncGenerator<StreamChunk> {
      seenRequests?.push(request)
      yield { type: 'message_start', model: String(request.model ?? 'mock') } as StreamChunk
      yield { type: 'text_delta', text: response } as StreamChunk
      yield {
        type: 'message_end',
        stopReason: 'end_turn',
        usage: { inputTokens: 5, outputTokens: 2 },
      } as StreamChunk
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
    const assess = createGoalClarityAssessor({ provider: mockProvider('{"clear":true}'), model: 'mock', modelTier: 'standard', resolveLlm: null })
    expect((await assess({ outcome: 'Email the Q3 report to Acme' })).clear).toBe(true)
  })

  it('blocks a vague outcome with a clarifying question', async () => {
    const assess = createGoalClarityAssessor({
      provider: mockProvider('{"clear":false,"question":"How will we know the business has grown enough?"}'),
      model: 'mock',
      modelTier: 'standard',
      resolveLlm: null,
    })
    const v = await assess({ outcome: 'grow the business' })
    expect(v.clear).toBe(false)
    expect(v.clarifyingQuestion).toContain('grown')
  })

  it('fails open (clear) when the model errors', async () => {
    const assess = createGoalClarityAssessor({ provider: throwingProvider(), model: 'mock', modelTier: 'standard', resolveLlm: null })
    expect((await assess({ outcome: 'anything' })).clear).toBe(true)
  })

  it('forwards usage to onUsage with the confirming userId', async () => {
    let seenUser: string | undefined = 'unset'
    const assess = createGoalClarityAssessor({
      provider: mockProvider('{"clear":true}'),
      model: 'mock',
      modelTier: 'standard',
      resolveLlm: null,
      onUsage: (_usage, context) => {
        seenUser = context.userId
      },
    })
    await assess({ outcome: 'x', userId: 'u1' })
    expect(seenUser).toBe('u1')
  })

  it('uses the workspace runtime instead of a throwing platform provider', async () => {
    const seenRequests: Array<Record<string, unknown>> = []
    const onUsage = vi.fn()
    const resolveLlm = vi.fn().mockResolvedValue({
      provider: mockProvider('{"clear":false,"question":"What result is required?"}', seenRequests),
      model: 'custom:model',
      modelTier: 'pro',
      providerKeySource: 'user',
      inputTokenLimit: 8192,
      maxTokens: 1024,
    })
    const assess = createGoalClarityAssessor({
      provider: throwingProvider(),
      model: 'platform',
      modelTier: 'standard',
      resolveLlm,
      onUsage,
    })
    const result = await assess({ outcome: 'improve things', workspaceId: 'w1', userId: 'u1', assistantId: 'a1' })
    expect(resolveLlm).toHaveBeenCalledWith('w1')
    expect(result.clear).toBe(false)
    expect(seenRequests[0]).toMatchObject({ model: 'custom:model', inputTokenLimit: 8192, maxTokens: 400 })
    expect(onUsage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: 'u1',
      workspaceId: 'w1',
      assistantId: 'a1',
      model: 'custom:model',
      modelTier: 'pro',
      providerKeySource: 'user',
    }))
  })
})
