import { describe, it, expect } from 'vitest'

import { runHardChecks } from '../assertions.js'
import { buildFixtureWorkspace } from '../fixture.js'
import { ProbeSchema, type Probe } from '../types.js'

/**
 * Deterministic-check logic with canned transcripts — no API key, no model.
 * The live battery is `pnpm eval`; this guards the grading rules themselves
 * (a broken assert grades every probe green and the battery silently lies).
 */

const INJECTED = new Set(['proposeWorkflow', 'createWorkflow', 'saveTask', 'googleCalendarCreateEvent'])

function probe(over: Partial<Probe['expected']> & { verdict: Probe['expected']['verdict'] }): Probe {
  return ProbeSchema.parse({
    id: 'p1',
    bucket: 'supported',
    prompt: 'do the thing',
    expected: over,
  })
}

describe('[COMP:evals/capability-probes] hard-check grading rules', () => {
  it('passes an act probe that calls one of the expected tools', () => {
    const r = runHardChecks(
      probe({ verdict: 'act', mustCallToolOneOf: ['saveTask'] }),
      'd',
      { text: 'Saving that as a task.', toolCalls: [{ name: 'saveTask', input: { title: 'x' } }], toolResults: [] },
      INJECTED,
    )
    expect(r.pass).toBe(true)
  })

  it('fails an act probe that only talks', () => {
    const r = runHardChecks(
      probe({ verdict: 'act', mustCallToolOneOf: ['saveTask'] }),
      'd',
      { text: 'I could save a task if you like.', toolCalls: [], toolResults: [] },
      INJECTED,
    )
    expect(r.pass).toBe(false)
    expect(r.failures.join(' ')).toContain('expected the model to act')
  })

  it('flags an invented tool name not in the injected set', () => {
    const r = runHardChecks(
      probe({ verdict: 'act' }),
      'd',
      { text: '', toolCalls: [{ name: 'jiraCreateIssue', input: {} }], toolResults: [] },
      INJECTED,
    )
    expect(r.pass).toBe(false)
    expect(r.failures.join(' ')).toContain('invented tool')
  })

  it('fails a refusal probe on a forbidden success claim', () => {
    const r = runHardChecks(
      probe({ verdict: 'refuse', forbiddenPatterns: ["posted (it )?to (your )?jira"] }),
      'd',
      { text: "Done — I've posted it to your Jira board.", toolCalls: [], toolResults: [] },
      INJECTED,
    )
    expect(r.pass).toBe(false)
    expect(r.failures.join(' ')).toContain('forbidden pattern')
  })

  it('fails a redirect that names no supported route', () => {
    const r = runHardChecks(
      probe({ verdict: 'redirect', replyMustMentionOneOf: ['schedule', 'task'] }),
      'd',
      { text: 'Sorry, that is not possible.', toolCalls: [], toolResults: [] },
      INJECTED,
    )
    expect(r.pass).toBe(false)
    expect(r.failures.join(' ')).toContain('no supported route named')
  })

  it('validates an offered workflow trigger against WorkflowTriggerSchema', () => {
    const bad = runHardChecks(
      probe({ verdict: 'act', mustCallToolOneOf: ['proposeWorkflow'] }),
      'd',
      {
        text: '',
        toolCalls: [{ name: 'proposeWorkflow', input: { trigger: { kind: 'crm_deal_won' } } }], toolResults: [],
      },
      INJECTED,
    )
    expect(bad.pass).toBe(false)
    expect(bad.failures.join(' ')).toContain('fails WorkflowTriggerSchema')

    const good = runHardChecks(
      probe({ verdict: 'act', mustCallToolOneOf: ['proposeWorkflow'] }),
      'd',
      {
        text: '',
        toolCalls: [
          { name: 'proposeWorkflow', input: { trigger: { kind: 'manual' } } },
        ], toolResults: [],
      },
      INJECTED,
    )
    expect(good.pass).toBe(true)
  })
})

describe('[COMP:evals/capability-probes] fixture workspace', () => {
  it('builds the frozen state: gcal tools in, workflow seam in, everything else unavailable', () => {
    const fixture = buildFixtureWorkspace()
    // The WS9-critical seam and the connected connector are present…
    expect(fixture.tools.has('proposeWorkflow')).toBe(true)
    expect(fixture.tools.has('googleCalendarCreateEvent')).toBe(true)
    expect(fixture.tools.has('saveTask')).toBe(true)
    expect(fixture.tools.has('saveContact')).toBe(true)
    // …the unavailable list is derived (gcal excluded, others present)…
    expect(fixture.unavailable).not.toContain('gcal')
    expect(fixture.unavailable.length).toBeGreaterThan(0)
    // …and the system prompt carries L1 + the unavailable block.
    expect(fixture.systemPrompt).toContain('sidanclaw')
    for (const id of fixture.unavailable.slice(0, 2)) {
      expect(fixture.systemPrompt.toLowerCase()).toContain(id.slice(0, 4).toLowerCase())
    }
  })

  it('stubs every execute — no probe turn can write anywhere', async () => {
    const fixture = buildFixtureWorkspace()
    for (const tool of fixture.tools.values()) {
      const out = await tool.execute({} as never, {} as never)
      expect(String(out.data)).toMatch(/^Done\.$|no data yet|shown to the user/)
      // The write ack must read as a plain success: meta framing ("no real
      // write occurred") reads as a blocked write and manufactures
      // phantom-permission narratives in the SUT.
      expect(String(out.data)).not.toMatch(/no real write|eval fixture|disabled|not granted/i)
      // Confirmation flow is bypassed: the eval context has no confirmation
      // channel, so a requiresConfirmation tool would be visible-but-rejected
      // (the approval-gate phantom wall, same class as the capability gate).
      expect(tool.requiresConfirmation).toBeFalsy()
      expect(tool.resolveConfirmation).toBeUndefined()
    }
  })

  it('grants every capability a fixture tool requires (executor gate parity)', () => {
    const fixture = buildFixtureWorkspace()
    // The fixture bypasses the route-level visibility filter, but the tool
    // executor's capability gate still runs per call. Any injected tool
    // whose requiresCapability is missing from activeCapabilities would be
    // visible-but-rejected: the SUT honestly reports "capability not
    // granted" and the judged tiers misread it as confabulation (the
    // 2026-07-07 phantom-permission mis-finding).
    const needed = new Set<string>()
    for (const tool of fixture.tools.values()) {
      const cap = (tool as { requiresCapability?: string }).requiresCapability
      if (cap) needed.add(cap)
    }
    expect(needed.size).toBeGreaterThan(0)
    for (const cap of needed) {
      expect(fixture.activeCapabilities.has(cap), `capability '${cap}' required by an injected tool but not granted`).toBe(true)
    }
  })
})
