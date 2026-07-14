import { describe, it, expect } from 'vitest'
import { stepAdvisories } from '../advisories.js'
import type { WorkflowDefinition } from '../types.js'

function def(steps: WorkflowDefinition['steps']): WorkflowDefinition {
  return { startStepId: steps[0]!.id, steps }
}

describe('[COMP:workflow/authoring-advisories] stepAdvisories', () => {
  it('warns on researchMode and points at the numeric-depth escape, not a tier switch alone', () => {
    const advisories = stepAdvisories(
      def([
        {
          id: 's1',
          type: 'assistant_call',
          target: { assistantId: 'primary' },
          prompt: 'List HKTV Mall eco stores',
          researchMode: true,
        } as never,
      ]),
    )
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.path).toEqual(['definition', 'steps', 0])
    expect(advisories[0]!.message).toContain('research mode')
    expect(advisories[0]!.message).toContain('maxToolCalls')
    expect(advisories[0]!.message).toContain('without switching the step into the deep fan-out')
  })

  it('warns on contact-research-shaped prompts running on the default budget', () => {
    const advisories = stepAdvisories(
      def([
        {
          id: 's1',
          type: 'assistant_call',
          target: { assistantId: 'primary' },
          prompt:
            'For each store, research the decision maker: find their email address, LinkedIn, Instagram and phone number.',
        } as never,
      ]),
    )
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.message).toContain('default consult budget')
    expect(advisories[0]!.message).toContain('maxToolCalls')
    expect(advisories[0]!.message).toContain('not verified')
  })

  it('stays quiet when the step already raises its budget via depth', () => {
    const advisories = stepAdvisories(
      def([
        {
          id: 's1',
          type: 'assistant_call',
          target: { assistantId: 'primary' },
          prompt: 'Research the decision maker and find their email address and LinkedIn.',
          depth: { maxToolCalls: 30, maxTurns: 12 },
        } as never,
      ]),
    )
    expect(advisories).toEqual([])
  })

  it('stays quiet on non-research prompts and non-assistant_call steps', () => {
    const advisories = stepAdvisories(
      def([
        { id: 's1', type: 'tool_call', toolName: 'echo', arguments: {} } as never,
        {
          id: 's2',
          type: 'assistant_call',
          target: { assistantId: 'primary' },
          prompt: 'Summarize the tasks due this week.',
        } as never,
      ]),
    )
    expect(advisories).toEqual([])
  })
})
