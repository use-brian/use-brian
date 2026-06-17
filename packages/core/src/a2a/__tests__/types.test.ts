/**
 * Type-level tests for the A2A module.
 *
 * These tests verify TypeScript compile-time invariants — the discriminated
 * unions narrow correctly, the mode discriminator works, and every TaskState
 * value is assignable. Behavior tests for schemas live in schemas.test.ts.
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import type {
  CallerIdentity,
  Capability,
  ConsultRequest,
  A2AMessage,
  Part,
  SpecialistCard,
  Task,
  TaskState,
} from '../types.js'

describe('[COMP:a2a/types] Type vocabulary', () => {
  it('Part discriminated union narrows on `kind`', () => {
    const text: Part = { kind: 'text', text: 'hello' }
    const file: Part = {
      kind: 'file',
      mimeType: 'image/png',
      ref: { type: 'inline', bytes: 'aGVsbG8=' },
    }
    const data: Part = { kind: 'data', data: { foo: 1 } }

    function describeKind(p: Part): string {
      switch (p.kind) {
        case 'text':
          return p.text
        case 'file':
          return p.mimeType
        case 'data':
          return Object.keys(p.data).join(',')
      }
    }

    expect(describeKind(text)).toBe('hello')
    expect(describeKind(file)).toBe('image/png')
    expect(describeKind(data)).toBe('foo')
  })

  it('every TaskState value is assignable', () => {
    const states: TaskState[] = [
      'submitted',
      'working',
      'input_required',
      'auth_required',
      'completed',
      'failed',
      'canceled',
    ]
    expect(states).toHaveLength(7)
  })

  it('free-mode ConsultRequest compiles without capabilityId', () => {
    const caller: CallerIdentity = {
      workspaceId: 'ws_a',
      assistantId: 'asst_primary',
      userId: 'user_1',
      channelType: 'web',
    }
    const message: A2AMessage = {
      messageId: 'm_1',
      role: 'user',
      parts: [{ kind: 'text', text: 'hi' }],
    }
    const request: ConsultRequest = {
      target: { workspaceId: 'ws_b', assistantId: 'asst_alice' },
      message,
      caller,
      chain: { path: [], depth: 0, budget: 10 },
    }
    expect(request.target.capabilityId).toBeUndefined()
  })

  it('restricted-mode ConsultRequest compiles with capabilityId', () => {
    const request: ConsultRequest = {
      target: {
        workspaceId: 'ws_a',
        assistantId: 'asst_distribution',
        capabilityId: 'distribution.threads.publishPost',
      },
      message: {
        messageId: 'm_1',
        role: 'user',
        parts: [{ kind: 'data', data: { text: 'hello world' } }],
      },
      caller: {
        workspaceId: 'ws_a',
        assistantId: 'asst_primary',
        userId: 'user_1',
        channelType: 'workflow',
      },
      chain: { path: ['asst_primary'], depth: 1, budget: 9 },
    }
    expect(request.target.capabilityId).toBe('distribution.threads.publishPost')
  })

  it('Task.history is optional (free-mode multi-turn vs restricted-mode skip)', () => {
    const restrictedTask: Task = {
      taskId: 't_1',
      contextId: 'ctx_1',
      status: { state: 'completed', timestamp: '2026-05-08T00:00:00Z' },
      artifacts: [],
    }
    const freeTask: Task = {
      taskId: 't_2',
      contextId: 'ctx_2',
      status: { state: 'completed', timestamp: '2026-05-08T00:00:00Z' },
      artifacts: [],
      history: [
        {
          messageId: 'm_1',
          role: 'user',
          parts: [{ kind: 'text', text: 'hi' }],
        },
      ],
    }
    expect(restrictedTask.history).toBeUndefined()
    expect(freeTask.history).toHaveLength(1)
  })

  it('Capability.exposedTools encodes leafness (no consultAssistant = leaf)', () => {
    const leaf: Capability = {
      id: 'distribution.threads.publishPost',
      name: 'Publish to Threads',
      description: 'Publish a post to Threads.',
      inputSchema: z.object({ text: z.string() }),
      exposedTools: ['threadsCreatePost', 'threadsScheduledMedia'],
    }
    const nonLeaf: Capability = {
      id: 'brand.review.scoreContent',
      name: 'Brand voice review',
      description: 'Score draft content against brand guidelines.',
      inputSchema: z.object({ content: z.string() }),
      exposedTools: ['searchKnowledge', 'consultAssistant'],
    }
    expect(leaf.exposedTools).not.toContain('consultAssistant')
    expect(nonLeaf.exposedTools).toContain('consultAssistant')
  })

  it('SpecialistCard carries capabilities (not skills) — naming distinct from existing skills/ module', () => {
    const card: SpecialistCard = {
      assistantId: 'asst_distribution',
      workspaceId: 'ws_a',
      name: 'Threads distribution',
      description: 'Publishes to Threads.',
      capabilities: [],
      acceptsFreeChat: false,
    }
    // This is a structural / readability assertion — if this file ever has a
    // `skills` field on SpecialistCard, the rename has been undone.
    expect('capabilities' in card).toBe(true)
    expect('skills' in card).toBe(false)
  })
})
