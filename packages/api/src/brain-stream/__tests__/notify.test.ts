/**
 * Tests for the NOTIFY emitter helpers.
 * [COMP:api/brain-stream-fanout]
 *
 * `notifyBrainChange` is the only consumer of `query()` and we mock that out
 * — the dispatch shape (channel name + JSON payload) is the contract we
 * need to lock. `notifyBrainWriteIfMatch` adds the tool-name → signal map +
 * no-op guards that the chat-route call sites and the MCP bridge depend on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls: Array<{ sql: string; params: unknown[] }> = []

vi.mock('../../db/client.js', () => ({
  query: async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params: params ?? [] })
    return { rows: [] }
  },
}))

import {
  BRAIN_WRITE_TOOL_SIGNALS,
  notifyBrainChange,
  notifyBrainInboxChange,
  notifyBrainWriteIfMatch,
} from '../notify.js'

beforeEach(() => {
  calls.length = 0
})

afterEach(() => {
  vi.useRealTimers()
})

describe('[COMP:api/brain-stream-fanout] notifyBrainChange', () => {
  it('fires SELECT pg_notify with the brain channel + JSON payload', async () => {
    await notifyBrainChange({
      workspaceId: 'ws-1',
      primitive: 'memory',
      rowId: 'mem-1',
      action: 'update',
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].sql).toBe('SELECT pg_notify($1, $2)')
    expect(calls[0].params[0]).toBe('brain_events')
    expect(JSON.parse(String(calls[0].params[1]))).toEqual({
      workspaceId: 'ws-1',
      primitive: 'memory',
      rowId: 'mem-1',
      action: 'update',
    })
  })

  it('no-ops on an empty workspaceId', async () => {
    await notifyBrainChange({
      workspaceId: '',
      primitive: 'memory',
      action: 'update',
    })
    expect(calls).toEqual([])
  })
})

describe('[COMP:api/brain-stream-fanout] notifyBrainWriteIfMatch', () => {
  it('fires for a brain-write tool on success', async () => {
    notifyBrainWriteIfMatch('ws-1', 'saveMemory', false, 'mem-9')
    // notify is fire-and-forget — yield once so the microtask runs.
    await Promise.resolve()
    await Promise.resolve()

    expect(calls).toHaveLength(1)
    const payload = JSON.parse(String(calls[0].params[1])) as Record<string, unknown>
    expect(payload.primitive).toBe('memory')
    expect(payload.action).toBe('update')
    expect(payload.rowId).toBe('mem-9')
  })

  it('does not fire when the tool errored', async () => {
    notifyBrainWriteIfMatch('ws-1', 'saveMemory', true)
    await Promise.resolve()
    expect(calls).toEqual([])
  })

  it('does not fire for a read tool', async () => {
    notifyBrainWriteIfMatch('ws-1', 'getMemory', false)
    await Promise.resolve()
    expect(calls).toEqual([])
  })

  it('does not fire without a workspaceId', async () => {
    notifyBrainWriteIfMatch(null, 'saveMemory', false)
    notifyBrainWriteIfMatch(undefined, 'saveMemory', false)
    notifyBrainWriteIfMatch('', 'saveMemory', false)
    await Promise.resolve()
    expect(calls).toEqual([])
  })

  it('covers every brain-write tool the chat + MCP surfaces can call', () => {
    // The server map is the source of truth for realtime parity — it must
    // include every brain-write tool that either the chat path (chat.ts
    // tool_result sites) or the MCP bridge (brain-mcp/tools.ts) executes.
    // Adding a new brain-write tool? Add it here and to BRAIN_WRITE_TOOL_SIGNALS.
    const expected = new Set([
      'saveMemory', 'deleteMemory',
      'saveTask', 'updateTask', 'closeTask', 'reopenTask',
      'saveContact', 'updateContact',
      'saveCompany', 'updateCompany',
      'saveDeal', 'updateDeal', 'advanceDealStage',
      'updateSelfProfile', 'createEntity',
      'fileWrite', 'fileAppend', 'fileSetMeta', 'fileDelete',
    ])
    for (const name of expected) {
      expect(BRAIN_WRITE_TOOL_SIGNALS[name]).toBeDefined()
    }
  })
})

describe('[COMP:api/brain-stream-fanout] notifyBrainInboxChange', () => {
  it('fires pg_notify for a web REST verify (action update) with the row id', async () => {
    notifyBrainInboxChange('ws-1', 'memory', 'mem-1', 'update')
    await Promise.resolve()
    await Promise.resolve()

    expect(calls).toHaveLength(1)
    expect(calls[0].sql).toBe('SELECT pg_notify($1, $2)')
    expect(calls[0].params[0]).toBe('brain_events')
    expect(JSON.parse(String(calls[0].params[1]))).toEqual({
      workspaceId: 'ws-1',
      primitive: 'memory',
      rowId: 'mem-1',
      action: 'update',
    })
  })

  it('fires pg_notify for a web REST delete (action delete)', async () => {
    notifyBrainInboxChange('ws-1', 'task', 'task-9', 'delete')
    await Promise.resolve()
    await Promise.resolve()

    expect(calls).toHaveLength(1)
    const payload = JSON.parse(String(calls[0].params[1])) as Record<string, unknown>
    expect(payload.primitive).toBe('task')
    expect(payload.action).toBe('delete')
    expect(payload.rowId).toBe('task-9')
  })

  it('remaps entity_link → edge and workspace_file → file', async () => {
    notifyBrainInboxChange('ws-1', 'entity_link', 'edge-1', 'update')
    notifyBrainInboxChange('ws-1', 'workspace_file', 'file-1', 'delete')
    await Promise.resolve()
    await Promise.resolve()

    expect(calls).toHaveLength(2)
    expect(JSON.parse(String(calls[0].params[1])).primitive).toBe('edge')
    expect(JSON.parse(String(calls[1].params[1])).primitive).toBe('file')
  })

  it('no-ops on a falsy workspaceId', async () => {
    notifyBrainInboxChange(null, 'memory', 'mem-1', 'update')
    notifyBrainInboxChange(undefined, 'memory', 'mem-1', 'update')
    notifyBrainInboxChange('', 'memory', 'mem-1', 'update')
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual([])
  })
})
