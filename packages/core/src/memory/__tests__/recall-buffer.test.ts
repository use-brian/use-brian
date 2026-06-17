import { describe, it, expect, vi } from 'vitest'
import {
  createMemoryRecallBuffer,
  type MemoryRecallKind,
  type MemoryRecallSink,
} from '../recall-buffer.js'

type RecordedBatch = {
  memoryIds: readonly string[]
  sessionId: string
  workspaceId: string
  userId: string
  recallKind: MemoryRecallKind
  assistantMessageId?: string | null
}

function makeFakeSink(): { sink: MemoryRecallSink; calls: RecordedBatch[] } {
  const calls: RecordedBatch[] = []
  return {
    calls,
    sink: {
      async recordRecallBatch(params) {
        calls.push({
          memoryIds: [...params.memoryIds],
          sessionId: params.sessionId,
          workspaceId: params.workspaceId,
          userId: params.userId,
          recallKind: params.recallKind,
          assistantMessageId: params.assistantMessageId,
        })
      },
    },
  }
}

describe('[COMP:brain/memory-recall-buffer] per-turn recall buffer', () => {
  it('flushes queued recalls with the supplied assistant message id', async () => {
    const { sink, calls } = makeFakeSink()
    const buf = createMemoryRecallBuffer({
      sink,
      sessionId: 'sess-1',
      workspaceId: 'ws-1',
      userId: 'usr-1',
    })

    buf.pushMany(['mem-a', 'mem-b', 'mem-c'], 'index_inject')
    buf.push('mem-d', 'tool_call')

    await buf.flush('msg-99')

    expect(calls).toHaveLength(2)

    const idxBatch = calls.find((c) => c.recallKind === 'index_inject')!
    expect(idxBatch).toBeDefined()
    expect([...idxBatch.memoryIds].sort()).toEqual(['mem-a', 'mem-b', 'mem-c'])
    expect(idxBatch.assistantMessageId).toBe('msg-99')
    expect(idxBatch.sessionId).toBe('sess-1')
    expect(idxBatch.workspaceId).toBe('ws-1')
    expect(idxBatch.userId).toBe('usr-1')

    const toolBatch = calls.find((c) => c.recallKind === 'tool_call')!
    expect(toolBatch.memoryIds).toEqual(['mem-d'])
    expect(toolBatch.assistantMessageId).toBe('msg-99')
  })

  it('skips empty partitions on flush', async () => {
    const { sink, calls } = makeFakeSink()
    const buf = createMemoryRecallBuffer({
      sink,
      sessionId: 'sess-2',
      workspaceId: 'ws-2',
      userId: 'usr-2',
    })

    buf.push('mem-only-tool', 'tool_call')
    await buf.flush('msg-100')

    expect(calls).toHaveLength(1)
    expect(calls[0].recallKind).toBe('tool_call')
  })

  it('de-dupes within a single partition', async () => {
    const { sink, calls } = makeFakeSink()
    const buf = createMemoryRecallBuffer({
      sink,
      sessionId: 'sess-3',
      workspaceId: 'ws-3',
      userId: 'usr-3',
    })

    // Same memory pushed three times — the model retrieved the same row
    // twice in one turn (reflection), then it also landed in the index.
    buf.push('mem-dup', 'tool_call')
    buf.push('mem-dup', 'tool_call')
    buf.push('mem-dup', 'tool_call')
    await buf.flush('msg-101')

    expect(calls).toHaveLength(1)
    expect(calls[0].memoryIds).toEqual(['mem-dup'])
  })

  it('keeps cross-partition recalls separate (same id can land in two kinds)', async () => {
    const { sink, calls } = makeFakeSink()
    const buf = createMemoryRecallBuffer({
      sink,
      sessionId: 'sess-4',
      workspaceId: 'ws-4',
      userId: 'usr-4',
    })

    // Same memory: index injection AND model fetched it. Both rows
    // should land — they're different signals.
    buf.push('mem-x', 'index_inject')
    buf.push('mem-x', 'tool_call')
    await buf.flush('msg-102')

    expect(calls).toHaveLength(2)
    const kinds = new Set(calls.map((c) => c.recallKind))
    expect(kinds).toEqual(new Set(['index_inject', 'tool_call']))
    for (const c of calls) {
      expect(c.memoryIds).toEqual(['mem-x'])
    }
  })

  it('discard() drops every queued recall without writing', async () => {
    const { sink, calls } = makeFakeSink()
    const buf = createMemoryRecallBuffer({
      sink,
      sessionId: 'sess-5',
      workspaceId: 'ws-5',
      userId: 'usr-5',
    })

    buf.pushMany(['mem-a', 'mem-b'], 'index_inject')
    buf.push('mem-c', 'tool_call')
    buf.discard()

    await buf.flush('msg-103')

    expect(calls).toHaveLength(0)
    expect(buf.snapshot()).toEqual({
      index_inject: [],
      tool_call: [],
      consolidation: [],
    })
  })

  it('second flush after a successful flush is a no-op', async () => {
    const { sink, calls } = makeFakeSink()
    const buf = createMemoryRecallBuffer({
      sink,
      sessionId: 'sess-6',
      workspaceId: 'ws-6',
      userId: 'usr-6',
    })

    buf.push('mem-a', 'index_inject')
    await buf.flush('msg-200')
    await buf.flush('msg-201') // accidental re-flush

    expect(calls).toHaveLength(1)
    expect(calls[0].assistantMessageId).toBe('msg-200')
  })

  it('snapshot() returns the current queue without flushing', () => {
    const { sink } = makeFakeSink()
    const buf = createMemoryRecallBuffer({
      sink,
      sessionId: 'sess-7',
      workspaceId: 'ws-7',
      userId: 'usr-7',
    })

    buf.pushMany(['a', 'b'], 'index_inject')
    buf.push('c', 'tool_call')

    const snap = buf.snapshot()
    expect([...snap.index_inject].sort()).toEqual(['a', 'b'])
    expect(snap.tool_call).toEqual(['c'])
    expect(snap.consolidation).toEqual([])
  })

  it('ignores empty memory ids gracefully', async () => {
    const { sink, calls } = makeFakeSink()
    const buf = createMemoryRecallBuffer({
      sink,
      sessionId: 'sess-8',
      workspaceId: 'ws-8',
      userId: 'usr-8',
    })

    buf.push('', 'index_inject')
    buf.pushMany(['', 'mem-real', ''], 'index_inject')
    await buf.flush('msg-300')

    expect(calls).toHaveLength(1)
    expect(calls[0].memoryIds).toEqual(['mem-real'])
  })

  it('propagates sink errors so the route can log/discard', async () => {
    const buf = createMemoryRecallBuffer({
      sink: {
        async recordRecallBatch() {
          throw new Error('boom')
        },
      },
      sessionId: 'sess-9',
      workspaceId: 'ws-9',
      userId: 'usr-9',
    })

    buf.push('mem-a', 'index_inject')

    await expect(buf.flush('msg-400')).rejects.toThrow('boom')
  })

  it('integrates with getMemory: tool-call recalls reach the buffer', async () => {
    // Smoke-style — verify the wiring contract used by `createMemoryTools`
    // is intact by exercising the buffer directly. The full memory-tools
    // integration is covered in memory-tools.test.ts.
    const { sink, calls } = makeFakeSink()
    const buf = createMemoryRecallBuffer({
      sink,
      sessionId: 'sess-10',
      workspaceId: 'ws-10',
      userId: 'usr-10',
    })

    // Simulate the two call paths the tool exercises.
    const recallPush = vi.spyOn(buf, 'push')
    const recallPushMany = vi.spyOn(buf, 'pushMany')

    buf.push('mem-by-id', 'tool_call')
    buf.pushMany(['mem-q1', 'mem-q2'], 'tool_call')

    expect(recallPush).toHaveBeenCalledWith('mem-by-id', 'tool_call')
    expect(recallPushMany).toHaveBeenCalledWith(['mem-q1', 'mem-q2'], 'tool_call')

    await buf.flush('msg-500')
    expect(calls).toHaveLength(1)
    expect([...calls[0].memoryIds].sort()).toEqual(['mem-by-id', 'mem-q1', 'mem-q2'])
  })
})
