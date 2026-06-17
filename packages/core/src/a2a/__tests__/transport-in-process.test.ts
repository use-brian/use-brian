/**
 * Unit tests for the in-process A2A consult transport.
 * Component tag: [COMP:a2a/transport-in-process].
 *
 * Verifies createInProcessTransport().send: the cycle / depth / budget
 * chain guards, cross-workspace mode resolution (sharing-blocked + a
 * bound mode), the input_required short-circuit, and the free vs
 * restricted completed-Task shapes. Deps (mode lookups, runConsult,
 * clock) are injected, so every path is deterministic.
 */

import { describe, it, expect } from 'vitest'
import {
  createInProcessTransport,
  type InProcessTransportDeps,
} from '../transport-in-process.js'
import type { AssistantMode, ConsultRequest, ConsultResponse } from '../types.js'

function mode(over: Partial<AssistantMode> = {}): AssistantMode {
  return {
    id: 'mode-1',
    assistantId: 'callee-1',
    name: 'Restricted',
    description: null,
    exposedTools: [],
    freshness: 'live',
    requireApproval: false,
    allowOnwardConsults: false,
    knowledgeMaxSensitivity: null,
    memoryCategories: null,
    createdAt: new Date('2026-05-16T00:00:00Z'),
    updatedAt: new Date('2026-05-16T00:00:00Z'),
    ...over,
  }
}

function deps(over: Partial<InProcessTransportDeps> = {}): InProcessTransportDeps {
  return {
    getConnectionModeId: async () => null,
    getMode: async () => null,
    runConsult: async () => ({ text: 'ok' }),
    now: () => 1_700_000_000_000,
    ...over,
  }
}

function request(o: {
  callerWorkspace?: string
  targetWorkspace?: string
  capabilityId?: string
  path?: string[]
  depth?: number
  budget?: number
} = {}): ConsultRequest {
  const target: ConsultRequest['target'] = {
    workspaceId: o.targetWorkspace ?? 'ws-1',
    assistantId: 'callee-1',
  }
  if (o.capabilityId !== undefined) target.capabilityId = o.capabilityId
  return {
    target,
    message: { messageId: 'msg-1', role: 'user', parts: [{ kind: 'text', text: 'hi' }] },
    contextId: 'ctx-1',
    caller: {
      workspaceId: o.callerWorkspace ?? 'ws-1',
      assistantId: 'caller-1',
      userId: 'u-1',
      channelType: 'web',
    },
    chain: {
      path: o.path ?? [],
      depth: o.depth ?? 0,
      budget: o.budget ?? 10,
    },
  }
}

function failureText(res: ConsultResponse): string {
  const p = res.task.status.message?.parts[0]
  return p && p.kind === 'text' ? p.text : ''
}

function historyText(res: ConsultResponse): string {
  const p = res.task.history?.[0]?.parts[0]
  return p && p.kind === 'text' ? p.text : ''
}

describe('[COMP:a2a/transport-in-process] send — chain guards', () => {
  it('rejects when the destination is already in the chain path (cycle)', async () => {
    const t = createInProcessTransport(deps())
    const res = await t.send(request({ path: ['callee-1'] }))
    expect(res.task.status.state).toBe('failed')
    expect(failureText(res)).toContain('Cycle detected')
  })

  it('rejects a free-mode consult at the free depth limit', async () => {
    // Free mode (no capabilityId) caps depth at MAX_DEPTH_FREE = 1.
    const t = createInProcessTransport(deps())
    const res = await t.send(request({ depth: 1 }))
    expect(res.task.status.state).toBe('failed')
    expect(failureText(res)).toContain('Depth limit')
  })

  it('rejects when the consult budget is exhausted', async () => {
    const t = createInProcessTransport(deps())
    const res = await t.send(request({ budget: 0 }))
    expect(res.task.status.state).toBe('failed')
    expect(failureText(res)).toContain('budget')
  })
})

describe('[COMP:a2a/transport-in-process] send — mode resolution', () => {
  it('rejects a cross-workspace consult with no accepted connection', async () => {
    const t = createInProcessTransport(deps({ getConnectionModeId: async () => undefined }))
    const res = await t.send(request({ callerWorkspace: 'ws-A', targetWorkspace: 'ws-B' }))
    expect(res.task.status.state).toBe('failed')
    expect(failureText(res)).toContain('connection')
  })

  it('resolves a bound mode cross-workspace and hands it to runConsult', async () => {
    const m = mode({ id: 'mode-42' })
    let seenMode: AssistantMode | null = null
    const t = createInProcessTransport(
      deps({
        getConnectionModeId: async () => 'mode-42',
        getMode: async () => m,
        runConsult: async ({ mode: resolved }) => {
          seenMode = resolved
          return { text: 'answered' }
        },
      }),
    )
    const res = await t.send(request({ callerWorkspace: 'ws-A', targetWorkspace: 'ws-B' }))
    expect(res.task.status.state).toBe('completed')
    expect(seenMode).toBe(m)
  })
})

describe('[COMP:a2a/transport-in-process] send — result shaping', () => {
  it('returns a completed Task with conversation history for a free-mode consult', async () => {
    const t = createInProcessTransport(deps({ runConsult: async () => ({ text: 'the answer' }) }))
    const res = await t.send(request())
    expect(res.task.status.state).toBe('completed')
    expect(historyText(res)).toBe('the answer')
  })

  it('returns a completed Task with no history for a restricted-mode consult', async () => {
    // Restricted mode (capabilityId set); depth 1 is within MAX_DEPTH_RESTRICTED.
    const t = createInProcessTransport(deps())
    const res = await t.send(request({ capabilityId: 'cap-1', depth: 1 }))
    expect(res.task.status.state).toBe('completed')
    expect(res.task.history).toBeUndefined()
  })

  it('short-circuits to an input_required Task when runConsult queues for approval', async () => {
    const t = createInProcessTransport(
      deps({ runConsult: async () => ({ text: '', inputRequired: true }) }),
    )
    const res = await t.send(request())
    expect(res.task.status.state).toBe('input_required')
  })
})
