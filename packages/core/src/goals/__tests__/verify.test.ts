import { describe, it, expect } from 'vitest'
import { createGoalVerifier, parseVerifyVerdict } from '../verify.js'
import type { LLMProvider, StreamChunk } from '../../providers/types.js'

/**
 * [COMP:goals/verifier] The adversarial completion verifier (task-goal-seeker.md
 * §12). FAIL-CLOSED: only an explicit `verified:true` passes; any error, missing
 * field, or unparseable verdict is NOT verified, so a goal is never falsely
 * completed.
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

describe('[COMP:goals/verifier] parseVerifyVerdict (fail-closed)', () => {
  it('verifies only on an explicit verified:true', () => {
    expect(parseVerifyVerdict('{"verified": true}').verified).toBe(true)
  })

  it('refutes with the reason on verified:false', () => {
    const v = parseVerifyVerdict('{"verified": false, "refutation": "the email was not sent"}')
    expect(v.verified).toBe(false)
    expect(v.refutation).toBe('the email was not sent')
  })

  it('fails closed on unparseable text', () => {
    expect(parseVerifyVerdict('not json at all').verified).toBe(false)
  })

  it('fails closed when `verified` is absent (anything but explicit true)', () => {
    expect(parseVerifyVerdict('{"refutation":"x"}').verified).toBe(false)
  })

  it('supplies a default refutation when false omits one', () => {
    const v = parseVerifyVerdict('{"verified": false}')
    expect(v.verified).toBe(false)
    expect(v.refutation).toBeTruthy()
  })
})

describe('[COMP:goals/verifier] createGoalVerifier', () => {
  it('verifies a well-supported claim', async () => {
    const verify = createGoalVerifier({ provider: mockProvider('{"verified":true}'), model: 'mock' })
    const v = await verify({
      outcome: 'Email the Q3 report to Acme',
      because: 'Sent the report PDF to billing@acme.com',
      evidence: 'gmail: message 123 sent',
    })
    expect(v.verified).toBe(true)
  })

  it('refutes an unsupported claim and returns the refutation', async () => {
    const verify = createGoalVerifier({
      provider: mockProvider('{"verified":false,"refutation":"no evidence the email was actually sent"}'),
      model: 'mock',
    })
    const v = await verify({ outcome: 'Email the Q3 report to Acme', because: 'I think it is done' })
    expect(v.verified).toBe(false)
    expect(v.refutation).toContain('email')
  })

  it('fails CLOSED (not verified) when the model errors', async () => {
    const verify = createGoalVerifier({ provider: throwingProvider(), model: 'mock' })
    const v = await verify({ outcome: 'x', because: 'done' })
    expect(v.verified).toBe(false)
    expect(v.refutation).toBeTruthy()
  })

  it('forwards usage to onUsage with the confirming userId', async () => {
    let seenUser: string | undefined = 'unset'
    const verify = createGoalVerifier({
      provider: mockProvider('{"verified":true}'),
      model: 'mock',
      onUsage: (_usage, userId) => {
        seenUser = userId
      },
    })
    await verify({ outcome: 'x', because: 'y', userId: 'u1' })
    expect(seenUser).toBe('u1')
  })
})
