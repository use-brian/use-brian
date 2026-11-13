import { afterEach, describe, expect, it, vi } from 'vitest'
import { canPrepareStandardSplit, settleChatAssessments } from '../chat-split-preparation.js'

const ordinary = { message: 'A fictional request long enough for the canonical splitter to assess.', requestedModel: 'standard', userPlan: 'free', researchMode: false, operateSiteIntent: false, assistantKind: 'primary', docSurface: false }
afterEach(() => vi.useRealTimers())

describe('bounded Standard split preparation', () => {
  it('requires an invariant Standard branch even after budget downgrade', () => {
    expect(canPrepareStandardSplit(ordinary)).toBe(true)
    expect(canPrepareStandardSplit({ ...ordinary, requestedModel: undefined })).toBe(true)
    expect(canPrepareStandardSplit({ ...ordinary, requestedModel: 'pro', userPlan: 'pro' })).toBe(false)
    expect(canPrepareStandardSplit({ ...ordinary, requestedModel: 'max', userPlan: 'max_5x' })).toBe(false)
  })
  it.each([
    { message: 'short' }, { researchMode: true }, { operateSiteIntent: true },
    { assistantKind: 'app' }, { docSurface: true }, { requestedModel: 'custom:fixture' },
    { requestedModel: 'qwen3.7-plus' },
  ])('retains the late path for %j', change => {
    expect(canPrepareStandardSplit({ ...ordinary, ...change })).toBe(false)
  })
  it('overlaps the three canonical decisions rather than summing their waits', async () => {
    vi.useFakeTimers()
    const wait = (ms: number, value: string) => () => new Promise<string>(resolve => setTimeout(() => resolve(value), ms))
    const start = Date.now()
    const pending = settleChatAssessments(wait(2700, 'research'), wait(4000, 'topic'), wait(3300, 'split'))
    let settled = false
    void pending.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(3999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toEqual(['research', 'topic', 'split'].map(value => ({ status: 'fulfilled', value })))
    expect(Date.now() - start).toBe(4000)
  })
  it('records completed but discarded speculative usage once before a sibling refusal escapes', async () => {
    const refusal = Object.assign(new Error('Fictional refusal'), { reason: 'authority_changed' })
    const completed = { model: 'fictional-model', usage: { inputTokens: 8, outputTokens: 4 } }
    const record = vi.fn().mockResolvedValue(undefined)
    const assessments = await settleChatAssessments(async () => { throw refusal }, async () => undefined,
      async () => completed, record)
    expect(record).toHaveBeenCalledExactlyOnceWith(completed)
    expect(assessments[0]).toEqual({ status: 'rejected', reason: refusal })
    expect(assessments[2]).toEqual({ status: 'fulfilled', value: completed })
  })
  it('does not charge absent or interrupted preparation', async () => {
    const record = vi.fn().mockResolvedValue(undefined)
    await settleChatAssessments(async () => undefined, async () => undefined, async () => undefined, record)
    await settleChatAssessments(async () => undefined, async () => undefined, async () => { throw new Error('Fictional cancellation') }, record)
    expect(record).not.toHaveBeenCalled()
  })
  it('joins every losing branch before propagating an authority refusal', async () => {
    vi.useFakeTimers()
    const refusal = Object.assign(new Error('Fictional refusal'), { reason: 'authority_changed' })
    let drained = false
    const pending = settleChatAssessments(async () => { throw refusal }, async () => undefined,
      () => new Promise<void>(resolve => setTimeout(() => { drained = true; resolve() }, 300)))
    let settled = false
    void pending.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(299)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const results = await pending
    expect(drained).toBe(true)
    expect(results[0]).toEqual({ status: 'rejected', reason: refusal })
    expect(vi.getTimerCount()).toBe(0)
  })
})
