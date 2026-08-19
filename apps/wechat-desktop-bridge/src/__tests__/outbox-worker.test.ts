/**
 * [COMP:app/wechat-desktop-bridge] outbox worker: item handling + acks.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { silentLogger } from '../log.js'
import { createOutboxWorker } from '../outbox-worker.js'
import type { OutboxItem } from '../protocol-types.js'
import { fakeAgent, fakeBridge, type FakeAgent, type FakeBridge } from './fakes.js'

let agent: FakeAgent
let bridge: FakeBridge
let disconnects: number

function worker() {
  return createOutboxWorker({
    agent,
    bridge,
    log: silentLogger,
    sleep: async () => {},
    onDisconnect: async () => {
      disconnects++
    },
  })
}

const msgItem = (text: string, format: 'plain' | 'markdown' = 'markdown'): OutboxItem => ({
  id: 'item-1',
  type: 'message',
  peerId: 'wxid_example1',
  createdAt: new Date(0).toISOString(),
  payload: { text, format },
})

beforeEach(() => {
  agent = fakeAgent()
  bridge = fakeBridge()
  disconnects = 0
})

describe('[COMP:app/wechat-desktop-bridge] outbox worker', () => {
  it('sends a message item to the peer with markdown flattened and acks ok', async () => {
    const res = await worker().handleItem(msgItem('**Hi** there, see [docs](https://example.com)'))
    expect(agent.sent).toEqual([{ chatId: 'wxid_example1', text: 'Hi there, see docs (https://example.com)' }])
    expect(res).toEqual({ id: 'item-1', ok: true })
  })

  it('passes plain text through untouched', async () => {
    await worker().handleItem(msgItem('**literal**', 'plain'))
    expect(agent.sent[0]!.text).toBe('**literal**')
  })

  it('chunks long text at 4000 chars and sends sequentially', async () => {
    const long = Array.from({ length: 900 }, (_, i) => `line ${i}`).join('\n')
    expect(long.length).toBeGreaterThan(4000)
    await worker().handleItem(msgItem(long, 'plain'))
    expect(agent.sent.length).toBeGreaterThan(1)
    for (const s of agent.sent) expect(s.text!.length).toBeLessThanOrEqual(4000)
    expect(agent.sent.map((s) => s.text).join('\n')).toBe(long)
  })

  it('acks ok:false with the container error when a send fails', async () => {
    agent.sendResult = { success: false, error: 'chat not found in UI' }
    const res = await worker().handleItem(msgItem('hello', 'plain'))
    expect(res).toEqual({ id: 'item-1', ok: false, error: 'chat not found in UI' })
  })

  it('acks ok:false when the container throws', async () => {
    agent.sendMessage = async () => {
      throw new Error('agent-wechat /api/messages/send responded 503')
    }
    const res = await worker().handleItem(msgItem('hello', 'plain'))
    expect(res.ok).toBe(false)
    expect(res.error).toContain('503')
  })

  it('sends documents as file sends', async () => {
    const item: OutboxItem = {
      id: 'item-2',
      type: 'message',
      peerId: 'wxid_example1',
      createdAt: new Date(0).toISOString(),
      payload: { text: '', format: 'plain', documents: [{ filename: 'a.pdf', mime: 'application/pdf', dataBase64: 'aGVsbG8=' }] },
    }
    const res = await worker().handleItem(item)
    expect(agent.sent).toEqual([{ chatId: 'wxid_example1', file: { data: 'aGVsbG8=', filename: 'a.pdf' } }])
    expect(res.ok).toBe(true)
  })

  it('ignores typing and input items but acks them', async () => {
    const w = worker()
    const typing = await w.handleItem({ id: 't1', type: 'typing', peerId: 'wxid_example1', createdAt: '', payload: { on: true } })
    const input = await w.handleItem({ id: 'i1', type: 'input', peerId: null, createdAt: '', payload: { requestId: 'r1', value: '1234' } })
    expect(typing).toEqual({ id: 't1', ok: true })
    expect(input).toEqual({ id: 'i1', ok: true })
    expect(agent.sent).toHaveLength(0)
  })

  it('a disconnect item triggers logout via onDisconnect', async () => {
    const res = await worker().handleItem({ id: 'd1', type: 'disconnect', peerId: null, createdAt: '', payload: {} })
    expect(disconnects).toBe(1)
    expect(res).toEqual({ id: 'd1', ok: true })
  })

  it('the loop polls, handles in order and acks the batch', async () => {
    bridge.queue.push([msgItem('one', 'plain'), { id: 'd1', type: 'disconnect', peerId: null, createdAt: '', payload: {} }])
    const w = worker()
    w.start()
    // Let the loop drain the queue.
    for (let i = 0; i < 20 && bridge.acks.length === 0; i++) await new Promise((r) => setImmediate(r))
    w.stop()
    expect(agent.sent.map((s) => s.text)).toEqual(['one'])
    expect(bridge.acks[0]).toEqual([
      { id: 'item-1', ok: true },
      { id: 'd1', ok: true },
    ])
    expect(disconnects).toBe(1)
  })
})
