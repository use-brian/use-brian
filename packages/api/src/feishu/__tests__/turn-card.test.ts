import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FeishuApi } from '@use-brian/channels'
import { FeishuTurnCard } from '../turn-card.js'

function fake() {
  const port = {
    open: vi.fn(async () => ({ cardId: 'card_1', messageId: 'om_card' })),
    update: vi.fn(async (_id: string, _text: string, _sequence: number) => {}),
    finish: vi.fn(async (_id: string, _text: string, _sequence: number) => {}),
  }
  return { port, api: { streamingCards: port } as unknown as FeishuApi }
}

describe('[COMP:api/feishu-turn-card] streaming lifecycle', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('flushes the latest rapid status on the trailing timer, without waiting in the event hook', async () => {
    vi.useFakeTimers()
    const { port, api } = fake()
    const card = (await FeishuTurnCard.open(api, 'oc_chat', 'Thinking...', { replyTo: 'om_current', replyInThread: false }))!
    card.status('Saving task')
    card.status('✓ Task saved')
    expect(port.update).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(600)
    expect(port.update).toHaveBeenCalledExactlyOnceWith('card_1', '✓ Task saved', 1)
    expect(port.open).toHaveBeenCalledWith('oc_chat', 'Thinking...', { replyTo: 'om_current', replyInThread: false })
    await card.finish('Done')
    expect(port.finish).toHaveBeenCalledWith('card_1', 'Done', 3)
    card.status('Late progress')
    await vi.advanceTimersByTimeAsync(2000)
    expect(port.update).toHaveBeenCalledTimes(2)
  })

  it('waits for an in-flight update and cancels pending progress before finalizing', async () => {
    vi.useFakeTimers()
    const { port, api } = fake()
    let release!: () => void
    port.update.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
    const card = (await FeishuTurnCard.open(api, 'oc_chat', 'Thinking...'))!
    card.status('Working')
    await vi.advanceTimersByTimeAsync(600)
    card.status('Old progress')
    const done = card.finish('Final answer')
    expect(port.finish).not.toHaveBeenCalled()
    release()
    await done
    await vi.advanceTimersByTimeAsync(2000)
    expect(port.update.mock.calls).toEqual([['card_1', 'Working', 1], ['card_1', 'Final answer', 2]])
    expect(port.finish).toHaveBeenCalledWith('card_1', 'Final answer', 3)
  })

  it('stops failed progress but still finalizes, and surfaces terminal failure for fallback', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { port, api } = fake()
    port.update.mockRejectedValueOnce(new Error('private provider payload'))
    const card = (await FeishuTurnCard.open(api, 'oc_chat', 'Thinking...'))!
    card.status('Working')
    await vi.advanceTimersByTimeAsync(600)
    card.status('More work')
    await vi.advanceTimersByTimeAsync(600)
    expect(port.update).toHaveBeenCalledTimes(1)
    port.finish.mockRejectedValueOnce(new Error('unavailable'))
    await expect(card.finish('Answer')).rejects.toThrow('unavailable')
    await expect(card.finish('Response sent below.')).resolves.toBe('om_card')
    expect(port.finish.mock.calls.map((call) => call[2])).toEqual([2, 3])
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('private provider payload'))
  })

  it('falls back when CardKit is unavailable or creation is denied', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await FeishuTurnCard.open({} as FeishuApi, 'oc_chat', 'Thinking...')).toBeUndefined()
    const { port, api } = fake()
    port.open.mockRejectedValueOnce(new Error('permission denied'))
    expect(await FeishuTurnCard.open(api, 'oc_chat', 'Thinking...')).toBeUndefined()
  })
})
