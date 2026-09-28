import { describe, expect, it } from 'vitest'
import { ChannelQuestions, channelQuestionActions, resolveChannelQuestion, type QuestionBinding } from '../channel-questions.js'
import { TelegramQuestions } from '../telegram-questions.js'

const binding: QuestionBinding = {
  integrationId: 'integration', assistantId: 'assistant', userId: 'account',
  incoming: { channelId: 'room:thread', userId: 'sender', text: '', timestamp: 1, isGroupChat: true, raw: {} },
}
const withText = (text: string): QuestionBinding => ({ ...binding, incoming: { ...binding.incoming, text, messageId: 'current', timestamp: 2 } })

describe('shared conversational channel questions', () => {
  it('keeps the old class as an alias', () => expect(TelegramQuestions).toBe(ChannelQuestions))

  it.each(['1', ' Alpha ', 'alpha'])('normalizes typed %s to the native choice', text => {
    const store = new ChannelQuestions()
    const action = channelQuestionActions(binding, { question: 'Which?', options: ['Alpha', 'Beta'] }, store)![0]!
    expect(action.replyText).toBe('Alpha')
    const result = resolveChannelQuestion(withText(text), undefined, store)
    expect(result.kind).toBe('answer')
    expect(result.incoming).toEqual({ ...withText(text).incoming, text: 'Alpha' })
    expect(store.resolve(binding, action.data)).toBeNull()
    const next = store.create(binding, ['Alpha', 'Beta'])[0]!
    expect(resolveChannelQuestion(withText(''), next.data, store).incoming.text).toBe('Alpha')
  })

  it('checks all identities before consuming both native and typed answers', () => {
    const store = new ChannelQuestions()
    const action = store.create(binding, ['Alpha'])[0]!
    const wrongBindings = [
      { ...withText('1'), integrationId: 'other' },
      { ...withText('1'), assistantId: 'other' },
      { ...withText('1'), userId: 'other' },
      { ...binding, incoming: { ...withText('1').incoming, userId: 'other' } },
      { ...binding, incoming: { ...withText('1').incoming, channelId: 'room' } },
    ]
    for (const wrong of wrongBindings) {
      expect(store.resolve(wrong, action.data)).toBeNull()
      expect(store.resolve(wrong)).toBeNull()
    }
    expect(store.resolve(withText('1'))?.answer).toBe('Alpha')
  })

  it('does not consume malformed actions, empty text, or out-of-range numbers', () => {
    const store = new ChannelQuestions()
    const action = store.create(binding, ['Alpha'])[0]!
    for (const text of ['', ' ', '0', '2', 'ask:invalid']) expect(store.resolve(withText(text))).toBeNull()
    for (const data of [action.data + ':extra', action.data.replace(/:0$/, ':9'), 'wq:other:0']) {
      expect(resolveChannelQuestion(binding, data, store).kind).toBe('unavailable')
    }
    expect(store.resolve(withText('A different answer'))?.answer).toBe('A different answer')
    expect(store.resolve(binding, action.data)).toBeNull()
  })

  it('never lets an old token consume a newer question', () => {
    const store = new ChannelQuestions()
    const old = store.create(binding, ['Old'])[0]!
    store.create(binding, ['New'])
    expect(resolveChannelQuestion(withText(old.data), undefined, store).kind).toBe('unavailable')
    expect(store.resolve(withText('1'))?.answer).toBe('New')
  })

  it('expires at the boundary, bounds retention, and preserves text without state', () => {
    let now = 0
    const store = new ChannelQuestions(() => now)
    const action = store.create(binding, ['Alpha'])[0]!
    now = 24 * 60 * 60 * 1000
    expect(store.resolve(binding, action.data)).toBeNull()
    expect(resolveChannelQuestion(withText('1'), undefined, store).kind).toBe('message')
    const evicted = store.create(binding, ['Alpha'])[0]!
    for (let i = 0; i < 1000; i++) store.create({ ...binding, integrationId: String(i) }, ['Alpha'])
    expect(store.resolve(binding, evicted.data)).toBeNull()
  })

  it('invalidates old options for a new open question and does not register ordinary replies', () => {
    const store = new ChannelQuestions()
    const action = store.create(binding, ['Alpha'])[0]!
    expect(channelQuestionActions(binding, undefined, store)).toBeUndefined()
    expect(channelQuestionActions(binding, { question: 'Anything else?' }, store)).toEqual([])
    expect(store.resolve(binding, action.data)).toBeNull()
  })

  it('copies option and actor bindings and uses compact Unicode-safe tokens', () => {
    const store = new ChannelQuestions()
    const local = withText('')
    const options = ['😀'.repeat(50)]
    const action = store.create(local, options)[0]!
    options[0] = 'mutated'
    local.incoming.userId = 'mutated'
    expect(Buffer.byteLength(action.data)).toBeLessThanOrEqual(64)
    expect(store.resolve(binding, action.data)?.answer).toBe('😀'.repeat(50))
  })
})
