import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { buildTool } from '../types.js'
import { filterToolsByCapabilities } from '../capability-gate.js'
import type { Tool } from '../types.js'

function makeTool(name: string, requiresCapability?: string): Tool {
  return buildTool({
    name,
    description: `test tool ${name}`,
    inputSchema: z.object({}),
    requiresCapability,
    execute: async () => ({ data: 'ok' }),
  })
}

function makeHiddenTool(name: string): Tool {
  return buildTool({
    name,
    description: `deprecated alias ${name}`,
    inputSchema: z.object({}),
    hiddenFromModel: true,
    execute: async () => ({ data: 'ok' }),
  })
}

describe('[COMP:tools/capability-gate] filterToolsByCapabilities', () => {
  const plainTool = makeTool('plain')
  const triageTool = makeTool('triage_reader', 'bug_triage')
  const costTool = makeTool('cost_peek', 'cost_audit')

  it('passes unrestricted tools through regardless of active caps', () => {
    const input = new Map<string, Tool>([['plain', plainTool]])
    const out = filterToolsByCapabilities(input, new Set())
    expect(out.size).toBe(1)
    expect(out.has('plain')).toBe(true)
  })

  it('drops capability-gated tools when the cap is not in the active set', () => {
    const input = new Map<string, Tool>([
      ['plain', plainTool],
      ['triage_reader', triageTool],
    ])
    const out = filterToolsByCapabilities(input, new Set())
    expect(out.size).toBe(1)
    expect(out.has('plain')).toBe(true)
    expect(out.has('triage_reader')).toBe(false)
  })

  it('keeps a capability-gated tool when the cap is active', () => {
    const input = new Map<string, Tool>([['triage_reader', triageTool]])
    const out = filterToolsByCapabilities(input, new Set(['bug_triage']))
    expect(out.size).toBe(1)
    expect(out.has('triage_reader')).toBe(true)
  })

  it('unrelated active cap does not unlock a differently-gated tool', () => {
    const input = new Map<string, Tool>([
      ['triage_reader', triageTool],
      ['cost_peek', costTool],
    ])
    const out = filterToolsByCapabilities(input, new Set(['bug_triage']))
    expect(out.size).toBe(1)
    expect(out.has('triage_reader')).toBe(true)
    expect(out.has('cost_peek')).toBe(false)
  })

  it('drops hiddenFromModel tools so the model never sees them (callable but hidden)', () => {
    // The scheduled-job verbs are folded into the workflow surface: kept
    // callable for back-compat, removed from the model's tool list.
    const input = new Map<string, Tool>([
      ['plain', plainTool],
      ['createScheduledJob', makeHiddenTool('createScheduledJob')],
    ])
    const out = filterToolsByCapabilities(input, new Set())
    expect(out.has('plain')).toBe(true)
    expect(out.has('createScheduledJob')).toBe(false)
  })

  it('drops hiddenFromModel tools regardless of active capabilities', () => {
    const input = new Map<string, Tool>([['scheduleWorkflow', makeHiddenTool('scheduleWorkflow')]])
    const out = filterToolsByCapabilities(input, new Set(['bug_triage', 'cost_audit']))
    expect(out.size).toBe(0)
  })

  it('returns a fresh map (input unchanged)', () => {
    const input = new Map<string, Tool>([
      ['plain', plainTool],
      ['triage_reader', triageTool],
    ])
    filterToolsByCapabilities(input, new Set())
    expect(input.size).toBe(2)
  })
})
