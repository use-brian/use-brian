/**
 * Unit tests for inter-assistant mode resolution.
 * Component tag: [COMP:inter-assistant/mode-resolver].
 *
 * Verifies resolveMode's three outcomes — no_connection (undefined mode
 * id), free (null mode id), mode (bound id) — the deleted-mode race that
 * resolves to free, and the caller/callee id pass-through.
 */

import { describe, it, expect } from 'vitest'
import { resolveMode, type ModeResolverDeps } from '../mode-resolver.js'
import type { AssistantMode } from '../../a2a/types.js'

function mode(over: Partial<AssistantMode> = {}): AssistantMode {
  return {
    id: 'mode-1',
    assistantId: 'callee-1',
    name: 'Read-only',
    description: null,
    exposedTools: ['searchMemory'],
    freshness: 'live',
    requireApproval: false,
    allowOnwardConsults: false,
    knowledgeMaxSensitivity: null,
    memoryCategories: null,
    createdAt: new Date('2026-05-15T00:00:00Z'),
    updatedAt: new Date('2026-05-15T00:00:00Z'),
    ...over,
  }
}

function deps(over: Partial<ModeResolverDeps> = {}): ModeResolverDeps {
  return {
    getConnectionModeId: async () => null,
    getMode: async () => null,
    ...over,
  }
}

describe('[COMP:inter-assistant/mode-resolver] resolveMode', () => {
  it('returns no_connection when no accepted connection exists', async () => {
    const res = await resolveMode(
      deps({ getConnectionModeId: async () => undefined }),
      'caller-1',
      'callee-1',
    )
    expect(res).toEqual({ kind: 'no_connection' })
  })

  it('returns free when the connection exists with no mode bound', async () => {
    const res = await resolveMode(
      deps({ getConnectionModeId: async () => null }),
      'caller-1',
      'callee-1',
    )
    expect(res).toEqual({ kind: 'free' })
  })

  it('returns the bound mode, looked up by the connection mode id', async () => {
    const m = mode({ id: 'mode-42' })
    let seenModeId: string | null = null
    const res = await resolveMode(
      deps({
        getConnectionModeId: async () => 'mode-42',
        getMode: async (id) => {
          seenModeId = id
          return m
        },
      }),
      'caller-1',
      'callee-1',
    )
    expect(seenModeId).toBe('mode-42')
    expect(res).toEqual({ kind: 'mode', mode: m })
  })

  it('falls back to free when the bound mode id no longer resolves (delete race)', async () => {
    const res = await resolveMode(
      deps({
        getConnectionModeId: async () => 'ghost-mode',
        getMode: async () => null,
      }),
      'caller-1',
      'callee-1',
    )
    expect(res).toEqual({ kind: 'free' })
  })

  it('passes the caller and callee ids to the connection lookup', async () => {
    let seen: [string, string] | null = null
    await resolveMode(
      deps({
        getConnectionModeId: async (caller, callee) => {
          seen = [caller, callee]
          return null
        },
      }),
      'caller-A',
      'callee-B',
    )
    expect(seen).toEqual(['caller-A', 'callee-B'])
  })
})
