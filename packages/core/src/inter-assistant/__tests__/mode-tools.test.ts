/**
 * Unit tests for mode-based inter-assistant tool filtering.
 * Component tag: [COMP:inter-assistant/mode-tools].
 *
 * Verifies filterToolsForMode: a null mode returns a copy of the full
 * tool map (free mode), a bound mode keeps only its exposedTools by
 * exact name, empty exposedTools yields nothing, missing names are
 * skipped silently, and tool values pass through by reference.
 *
 * Verifies filterToolsByAllowList: an undefined allow-list returns a copy
 * of the full map, a set list keeps only those names (exact match), an
 * empty list yields nothing, and unknown names are skipped silently.
 */

import { describe, it, expect } from 'vitest'
import { filterToolsForMode, filterToolsByAllowList } from '../mode-tools.js'
import type { AssistantMode } from '../../a2a/types.js'
import type { Tool } from '../../tools/types.js'

function tool(name: string): Tool {
  return { name } as unknown as Tool
}

function mode(exposedTools: string[]): AssistantMode {
  return {
    id: 'm-1',
    assistantId: 'a-1',
    name: 'Test mode',
    description: null,
    exposedTools,
    freshness: 'live',
    requireApproval: false,
    allowOnwardConsults: false,
    knowledgeMaxSensitivity: null,
    memoryCategories: null,
    createdAt: new Date('2026-05-15T00:00:00Z'),
    updatedAt: new Date('2026-05-15T00:00:00Z'),
  }
}

describe('[COMP:inter-assistant/mode-tools] filterToolsForMode', () => {
  it('returns a copy of the full map for a null (free) mode', () => {
    const tools = new Map<string, Tool>([['a', tool('a')], ['b', tool('b')]])
    const out = filterToolsForMode(tools, null)
    expect([...out.keys()].sort()).toEqual(['a', 'b'])
    expect(out).not.toBe(tools) // a new Map, not the input
  })

  it('keeps only tools listed in the mode exposedTools', () => {
    const tools = new Map<string, Tool>([
      ['a', tool('a')],
      ['b', tool('b')],
      ['c', tool('c')],
    ])
    const out = filterToolsForMode(tools, mode(['a', 'c']))
    expect([...out.keys()].sort()).toEqual(['a', 'c'])
  })

  it('matches tool names exactly — no prefix/substring match', () => {
    const tools = new Map<string, Tool>([
      ['search', tool('search')],
      ['searchMemory', tool('searchMemory')],
    ])
    const out = filterToolsForMode(tools, mode(['searchMemory']))
    expect([...out.keys()]).toEqual(['searchMemory'])
  })

  it('yields an empty map when exposedTools is empty', () => {
    const tools = new Map<string, Tool>([['a', tool('a')]])
    expect(filterToolsForMode(tools, mode([])).size).toBe(0)
  })

  it('silently skips an exposed name that is not in the tool map', () => {
    const tools = new Map<string, Tool>([['a', tool('a')]])
    const out = filterToolsForMode(tools, mode(['a', 'nonexistent']))
    expect([...out.keys()]).toEqual(['a'])
  })

  it('passes the tool value through by reference', () => {
    const ta = tool('a')
    const out = filterToolsForMode(new Map<string, Tool>([['a', ta]]), mode(['a']))
    expect(out.get('a')).toBe(ta)
  })
})

describe('[COMP:inter-assistant/mode-tools] filterToolsByAllowList', () => {
  it('returns a copy of the full map when the allow-list is undefined', () => {
    const tools = new Map<string, Tool>([['a', tool('a')], ['b', tool('b')]])
    const out = filterToolsByAllowList(tools, undefined)
    expect([...out.keys()].sort()).toEqual(['a', 'b'])
    expect(out).not.toBe(tools) // a new Map, not the input
  })

  it('keeps only tools whose name is in the allow-list', () => {
    const tools = new Map<string, Tool>([
      ['a', tool('a')],
      ['b', tool('b')],
      ['c', tool('c')],
    ])
    const out = filterToolsByAllowList(tools, ['a', 'c'])
    expect([...out.keys()].sort()).toEqual(['a', 'c'])
  })

  it('yields an empty map for an empty allow-list', () => {
    const tools = new Map<string, Tool>([['a', tool('a')]])
    expect(filterToolsByAllowList(tools, []).size).toBe(0)
  })

  it('silently skips an allowed name that is not in the tool map', () => {
    const tools = new Map<string, Tool>([['a', tool('a')]])
    const out = filterToolsByAllowList(tools, ['a', 'ghost'])
    expect([...out.keys()]).toEqual(['a'])
  })

  it('matches tool names exactly — no prefix/substring match', () => {
    const tools = new Map<string, Tool>([
      ['search', tool('search')],
      ['searchMemory', tool('searchMemory')],
    ])
    const out = filterToolsByAllowList(tools, ['searchMemory'])
    expect([...out.keys()]).toEqual(['searchMemory'])
  })
})
