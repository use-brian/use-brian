/**
 * Unit tests for per-consult inter-assistant tool filtering.
 * Component tag: [COMP:inter-assistant/mode-tools].
 *
 * Verifies filterToolsByAllowList: an undefined allow-list returns a copy
 * of the full map, a set list keeps only those names (exact match), an
 * empty list yields nothing, and unknown names are skipped silently.
 * (The destination-side mode filter that used to live here was retired
 * 2026-07-24 with the assistant_modes system.)
 */

import { describe, it, expect } from 'vitest'
import { filterToolsByAllowList } from '../mode-tools.js'
import type { Tool } from '../../tools/types.js'

function tool(name: string): Tool {
  return { name } as unknown as Tool
}

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

  it('passes the tool value through by reference', () => {
    const ta = tool('a')
    const out = filterToolsByAllowList(new Map<string, Tool>([['a', ta]]), ['a'])
    expect(out.get('a')).toBe(ta)
  })
})
