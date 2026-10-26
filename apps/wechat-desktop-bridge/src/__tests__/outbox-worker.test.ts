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

describe('[COMP:app/wechat-desktop-bridge] R4 lost outbound acknowledgement', () => {
  it.each(['text', 'document'] as const)('reconciles a completed %s send after acknowledgement loss without repeating it', async (kind) => {
    const agent = fakeAgent()
    const bridge = fakeBridge()
    const item: OutboxItem = {
      id: 'outbound-operation-fictional',
      type: 'message',
      peerId: 'wxid_fictional_recipient',
      createdAt: new Date(0).toISOString(),
      payload: {
        text: kind === 'text' ? 'synthetic-outbound-sentinel' : '',
        format: 'plain',
        ...(kind === 'document' ? { documents: [{ filename: 'fictional.txt', mime: 'text/plain', dataBase64: Buffer.from('synthetic-file-sentinel').toString('base64') }] } : {}),
      },
    }
    // The bridge transport simulates an item becoming claimable again after
    // its first acknowledgement is lost. The worker and formatter are real;
    // the API lease clock/database are outside this focused regression.
    bridge.queue.push([item], [item])
    let attempts = 0
    let finish!: () => void
    const finished = new Promise<void>((resolve) => { finish = resolve })
    const worker = createOutboxWorker({
      agent, bridge, log: silentLogger,
      onDisconnect: async () => {},
      sleep: async () => { await new Promise((resolve) => setImmediate(resolve)) },
    })
    bridge.ack = async () => {
      attempts++
      if (attempts === 1) throw new Error('synthetic acknowledgement transport loss')
      worker.stop()
      finish()
    }
    worker.start()
    try {
      await finished
    } finally {
      worker.stop()
    }
    expect(attempts).toBe(2)
    // Numeric-only failure output never dumps protected outbound bytes.
    expect(agent.sent.length).toBe(1)
  })
})

describe('[COMP:app/wechat-desktop-bridge] retained acknowledgement controls', () => {
  it('keeps a failed send result while retrying its acknowledgement', async () => {
    const agent = fakeAgent()
    const bridge = fakeBridge()
    agent.sendResult = { success: false, error: 'synthetic send refusal' }
    bridge.queue.push([msgItem('synthetic payload', 'plain')])
    let attempts = 0
    let previous: unknown
    let sameResult = false
    let originalFailedResult = false
    let finish!: () => void
    const finished = new Promise<void>((resolve) => { finish = resolve })
    const w = createOutboxWorker({ agent, bridge, log: silentLogger, sleep: async () => {}, onDisconnect: async () => {} })
    bridge.ack = async (results) => {
      attempts++
      if (attempts === 1) { previous = results; throw new Error('synthetic ack loss') }
      sameResult = results === previous
      originalFailedResult = results[0]?.ok === false
      w.stop()
      finish()
    }
    w.start()
    try { await finished } finally { w.stop() }
    expect(agent.sent.length).toBe(1)
    expect(attempts).toBe(2)
    expect(sameResult).toBe(true)
    expect(originalFailedResult).toBe(true)
  })

  it('stops an acknowledgement retry after shutdown without polling another item', async () => {
    const agent = fakeAgent()
    const bridge = fakeBridge()
    bridge.queue.push([msgItem('first', 'plain')], [msgItem('second', 'plain')])
    let finish!: () => void
    const finished = new Promise<void>((resolve) => { finish = resolve })
    const w = createOutboxWorker({ agent, bridge, log: silentLogger, sleep: async () => {}, onDisconnect: async () => {} })
    let attempts = 0
    bridge.ack = async () => { attempts++; w.stop(); finish(); throw new Error('synthetic ack loss') }
    w.start()
    try { await finished; await new Promise((resolve) => setImmediate(resolve)) } finally { w.stop() }
    expect(agent.sent.length).toBe(1)
    expect(attempts).toBe(1)
    expect(bridge.queue.length).toBe(1)
  })

  it('keeps invalid bridge credentials fatal after a completed send', async () => {
    const agent = fakeAgent()
    const bridge = fakeBridge()
    bridge.queue.push([msgItem('first', 'plain')], [msgItem('second', 'plain')])
    let finish!: () => void
    const finished = new Promise<void>((resolve) => { finish = resolve })
    let fatalCalls = 0
    const w = createOutboxWorker({
      agent, bridge, log: silentLogger, sleep: async () => {}, onDisconnect: async () => {},
      onFatal: () => { fatalCalls++; finish() },
    })
    bridge.ack = async () => { throw Object.assign(new Error('synthetic credential refusal'), { name: 'FatalConfigError' }) }
    w.start()
    try { await finished } finally { w.stop() }
    expect(agent.sent.length).toBe(1)
    expect(fatalCalls).toBe(1)
    expect(bridge.queue.length).toBe(1)
  })

  it('polls later work only after the retained batch acknowledgement succeeds', async () => {
    const agent = fakeAgent()
    const bridge = fakeBridge()
    bridge.queue.push([msgItem('first', 'plain')], [{ ...msgItem('second', 'plain'), id: 'item-2' }])
    const trace: string[] = []
    const send = agent.sendMessage
    agent.sendMessage = async (params) => { trace.push('send'); return send(params) }
    let finish!: () => void
    const finished = new Promise<void>((resolve) => { finish = resolve })
    let attempts = 0
    const w = createOutboxWorker({ agent, bridge, log: silentLogger, sleep: async () => {}, onDisconnect: async () => {} })
    bridge.ack = async () => {
      trace.push('ack')
      attempts++
      if (attempts === 1) throw new Error('synthetic ack loss')
      if (attempts === 3) { w.stop(); finish() }
    }
    w.start()
    try { await finished } finally { w.stop() }
    expect(trace).toEqual(['send', 'ack', 'ack', 'send', 'ack'])
    expect(agent.sent.length).toBe(2)
  })
})
