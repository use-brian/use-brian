import { describe, it, expect } from 'vitest'
import { WorkflowDefinitionSchema, WorkflowTriggerSchema } from '../schemas.js'

describe('[COMP:workflow/schemas] WorkflowDefinitionSchema', () => {
  it('accepts a linear two-step assistant_call → tool_call', () => {
    const def = {
      startStepId: 'summarize',
      steps: [
        {
          id: 'summarize',
          type: 'assistant_call',
          target: { assistantId: 'primary' },
          prompt: 'Summarize my recent memories.',
          storeOutputAs: 'summary',
          nextStepId: 'deliver',
        },
        {
          id: 'deliver',
          type: 'tool_call',
          toolName: 'saveMemory',
          arguments: { content: '{{vars.summary}}', category: 'work' },
        },
      ],
    }
    const result = WorkflowDefinitionSchema.safeParse(def)
    expect(result.success).toBe(true)
  })

  it('unwraps JSON-string steps (the steps-as-strings model prior, 2026-07-07 tolerance fix)', () => {
    // 4 prod authoring failures in 14 days: `steps.0: Expected object,
    // received string`. A JSON-serialised step object now parses.
    const def = {
      startStepId: 'step_1',
      steps: [
        JSON.stringify({
          id: 'step_1',
          type: 'assistant_call',
          target: { assistantId: 'primary' },
          prompt: 'do the thing',
        }),
      ],
    }
    const result = WorkflowDefinitionSchema.safeParse(def)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.steps[0]).toMatchObject({ id: 'step_1', type: 'assistant_call' })
    }
  })

  it('a non-JSON string step still fails with the normal validation error', () => {
    const def = { startStepId: 's1', steps: ['not json at all'] }
    const result = WorkflowDefinitionSchema.safeParse(def)
    expect(result.success).toBe(false)
  })

  it('accepts a branch with both legs', () => {
    const def = {
      startStepId: 'check',
      steps: [
        {
          id: 'check',
          type: 'branch',
          condition: { '==': [{ var: 'vars.x' }, 1] },
          nextStepIdIfTrue: 'yes',
          nextStepIdIfFalse: 'no',
        },
        { id: 'yes', type: 'tool_call', toolName: 'a', arguments: {} },
        { id: 'no', type: 'tool_call', toolName: 'b', arguments: {} },
      ],
    }
    expect(WorkflowDefinitionSchema.safeParse(def).success).toBe(true)
  })

  it('accepts a wait step with `until.duration`', () => {
    const def = {
      startStepId: 'sleep',
      steps: [
        {
          id: 'sleep',
          type: 'wait',
          until: { duration: { hours: 24 } },
          nextStepId: null,
        },
      ],
    }
    expect(WorkflowDefinitionSchema.safeParse(def).success).toBe(true)
  })

  it('accepts a wait step with `at.datetime`', () => {
    const def = {
      startStepId: 'sleep',
      steps: [
        {
          id: 'sleep',
          type: 'wait',
          at: { datetime: '2026-12-01T08:00:00', timezone: 'Asia/Hong_Kong' },
          nextStepId: null,
        },
      ],
    }
    expect(WorkflowDefinitionSchema.safeParse(def).success).toBe(true)
  })

  it('rejects a wait step with both `until` and `at`', () => {
    const def = {
      startStepId: 'sleep',
      steps: [
        {
          id: 'sleep',
          type: 'wait',
          until: { duration: { hours: 1 } },
          at: { datetime: '2026-01-01T00:00:00' },
        },
      ],
    }
    expect(WorkflowDefinitionSchema.safeParse(def).success).toBe(false)
  })

  it('rejects a wait step with neither `until` nor `at`', () => {
    const def = {
      startStepId: 'sleep',
      steps: [{ id: 'sleep', type: 'wait' }],
    }
    expect(WorkflowDefinitionSchema.safeParse(def).success).toBe(false)
  })

  it('rejects duplicate step ids', () => {
    const def = {
      startStepId: 'a',
      steps: [
        { id: 'a', type: 'tool_call', toolName: 't', arguments: {} },
        { id: 'a', type: 'tool_call', toolName: 't', arguments: {} },
      ],
    }
    const r = WorkflowDefinitionSchema.safeParse(def)
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message.includes('duplicate step id'))).toBe(true)
    }
  })

  it('rejects unknown nextStepId references', () => {
    const def = {
      startStepId: 'a',
      steps: [
        {
          id: 'a',
          type: 'tool_call',
          toolName: 't',
          arguments: {},
          nextStepId: 'ghost',
        },
      ],
    }
    const r = WorkflowDefinitionSchema.safeParse(def)
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message.includes('unknown step "ghost"'))).toBe(true)
    }
  })

  it('rejects when startStepId is missing from steps', () => {
    const def = {
      startStepId: 'ghost',
      steps: [{ id: 'a', type: 'tool_call', toolName: 't', arguments: {} }],
    }
    expect(WorkflowDefinitionSchema.safeParse(def).success).toBe(false)
  })

  it('rejects empty steps array', () => {
    expect(WorkflowDefinitionSchema.safeParse({ startStepId: 'x', steps: [] }).success).toBe(false)
  })

  it('rejects bad tool name characters', () => {
    const def = {
      startStepId: 'a',
      steps: [{ id: 'a', type: 'tool_call', toolName: 'bad name!', arguments: {} }],
    }
    expect(WorkflowDefinitionSchema.safeParse(def).success).toBe(false)
  })

  it('accepts MCP tool names containing dot, dash, and colon', () => {
    const def = {
      startStepId: 'a',
      steps: [{
        id: 'a',
        type: 'tool_call',
        toolName: 'mcp_Proton-calendar_list.events:v2',
        arguments: {},
      }],
    }
    expect(WorkflowDefinitionSchema.safeParse(def).success).toBe(true)
  })

  it('accepts an assistant_call step with a research-depth config', () => {
    const def = {
      startStepId: 'research',
      steps: [
        {
          id: 'research',
          type: 'assistant_call',
          target: { assistantId: 'primary' },
          prompt: 'Scout new accelerator programs.',
          depth: { tier: 'deep', maxToolCalls: 30 },
        },
      ],
    }
    expect(WorkflowDefinitionSchema.safeParse(def).success).toBe(true)
  })

  it('rejects an assistant_call step with an out-of-range depth', () => {
    const def = {
      startStepId: 'research',
      steps: [
        {
          id: 'research',
          type: 'assistant_call',
          target: { assistantId: 'primary' },
          prompt: 'Scout new accelerator programs.',
          depth: { maxTurns: 999 },
        },
      ],
    }
    expect(WorkflowDefinitionSchema.safeParse(def).success).toBe(false)
  })

  it('accepts an assistant_call target that is a concrete UUID', () => {
    const def = {
      startStepId: 'call',
      steps: [
        {
          id: 'call',
          type: 'assistant_call',
          target: { assistantId: '6b0d3df6-0000-4000-8000-000000000000' },
          prompt: 'Do the thing.',
        },
      ],
    }
    expect(WorkflowDefinitionSchema.safeParse(def).success).toBe(true)
  })

  it('rejects an assistant_call target that is a human-readable name, not a UUID or "primary"', () => {
    // Regression: a model-authored slug like "product-assistant" used to pass
    // the loose `.string().min(1)` schema, persist, and then blow up at run
    // time with Postgres "invalid input syntax for type uuid".
    const def = {
      startStepId: 'call',
      steps: [
        {
          id: 'call',
          type: 'assistant_call',
          target: { assistantId: 'product-assistant' },
          prompt: 'Review the logs.',
        },
      ],
    }
    const r = WorkflowDefinitionSchema.safeParse(def)
    expect(r.success).toBe(false)
  })

  // ── Page anchor ─────────────────────────────────────────────────────────

  const anchorStep = (page: unknown, id = 'call') => ({
    id,
    type: 'assistant_call',
    target: { assistantId: 'primary' },
    prompt: 'Edit the page.',
    ...(page !== undefined ? { page } : {}),
  })

  it('accepts page: {id} with a uuid', () => {
    const def = {
      startStepId: 'call',
      steps: [anchorStep({ id: '6b0d3df6-0000-4000-8000-000000000000' })],
    }
    expect(WorkflowDefinitionSchema.safeParse(def).success).toBe(true)
  })

  it('accepts page: {id} as exactly one whole-string interpolation token (Phase B)', () => {
    for (const id of ['{{vars.pageId}}', '{{input.pageId}}', '{{ input.page.id }}']) {
      const def = { startStepId: 'call', steps: [anchorStep({ id })] }
      expect(WorkflowDefinitionSchema.safeParse(def).success).toBe(true)
    }
  })

  it('rejects page: {id} that is neither a uuid nor a single whole-string token', () => {
    for (const id of [
      'not-a-page-id',
      'page-{{vars.pageId}}', // mixed string — the resolved value must be ONE id
      '{{vars.a}}{{vars.b}}',
      '{{prev.pageId}}', // only vars/input heads resolve
    ]) {
      const def = { startStepId: 'call', steps: [anchorStep({ id })] }
      expect(WorkflowDefinitionSchema.safeParse(def).success).toBe(false)
    }
  })

  it('accepts page: {create} with optional title + nestUnder', () => {
    const def = {
      startStepId: 'call',
      steps: [
        anchorStep({
          create: true,
          title: 'Research: {{input.topic}}',
          nestUnder: '6b0d3df6-0000-4000-8000-000000000000',
        }),
      ],
    }
    expect(WorkflowDefinitionSchema.safeParse(def).success).toBe(true)
  })

  it('accepts page: {create} with reuse: per-workflow / per-run', () => {
    for (const reuse of ['per-run', 'per-workflow']) {
      const def = {
        startStepId: 'call',
        steps: [anchorStep({ create: true, title: 'Maintenance Log', reuse })],
      }
      expect(WorkflowDefinitionSchema.safeParse(def).success).toBe(true)
    }
  })

  it('rejects page: {create} with an unknown reuse value', () => {
    const def = {
      startStepId: 'call',
      steps: [anchorStep({ create: true, reuse: 'forever' })],
    }
    expect(WorkflowDefinitionSchema.safeParse(def).success).toBe(false)
  })

  it('rejects unknown keys on any page variant (strict forward-compat guard)', () => {
    const def = {
      startStepId: 'call',
      steps: [anchorStep({ id: '6b0d3df6-0000-4000-8000-000000000000', mode: 'edit' })],
    }
    expect(WorkflowDefinitionSchema.safeParse(def).success).toBe(false)
  })

  it('accepts page: {fromStep} referencing an earlier create-step', () => {
    const def = {
      startStepId: 'make',
      steps: [
        anchorStep({ create: true, title: 'Report' }, 'make'),
        anchorStep({ fromStep: 'make' }, 'fill'),
      ],
    }
    expect(WorkflowDefinitionSchema.safeParse(def).success).toBe(true)
  })

  it('rejects page: {fromStep} referencing a step without page.create', () => {
    const def = {
      startStepId: 'a',
      steps: [anchorStep(undefined, 'a'), anchorStep({ fromStep: 'a' }, 'b')],
    }
    const r = WorkflowDefinitionSchema.safeParse(def)
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message.includes('page.create'))).toBe(true)
    }
  })

  it('rejects page: {fromStep} referencing a missing step', () => {
    const def = {
      startStepId: 'b',
      steps: [anchorStep({ fromStep: 'ghost' }, 'b')],
    }
    expect(WorkflowDefinitionSchema.safeParse(def).success).toBe(false)
  })

  it('rejects page: {fromStep} referencing itself', () => {
    const def = {
      startStepId: 'b',
      steps: [anchorStep({ fromStep: 'b' }, 'b')],
    }
    const r = WorkflowDefinitionSchema.safeParse(def)
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message.includes('itself'))).toBe(true)
    }
  })

  // ── deliver.thread (reply-in-thread delivery) ────────────────────────────

  function deliverStep(
    id: string,
    deliver?: {
      channelType: string
      channelId?: string
      channelIntegrationId?: string
      thread?: { fromStep: string }
      replyToTrigger?: true
    },
  ) {
    return {
      id,
      type: 'assistant_call',
      target: { assistantId: 'primary' },
      prompt: `step ${id}`,
      ...(deliver ? { deliver } : {}),
    }
  }

  it('accepts deliver.thread.fromStep referencing an earlier deliver-step on the same channel', () => {
    const def = {
      startStepId: 'parent',
      steps: [
        deliverStep('parent', { channelType: 'slack', channelId: 'C123' }),
        deliverStep('reply', { channelType: 'slack', channelId: 'C123', thread: { fromStep: 'parent' } }),
      ],
    }
    expect(WorkflowDefinitionSchema.safeParse(def).success).toBe(true)
  })

  it('accepts a telegram deliver.thread (reply chain)', () => {
    const def = {
      startStepId: 'parent',
      steps: [
        deliverStep('parent', { channelType: 'telegram', channelId: '42' }),
        deliverStep('reply', { channelType: 'telegram', channelId: '42', thread: { fromStep: 'parent' } }),
      ],
    }
    expect(WorkflowDefinitionSchema.safeParse(def).success).toBe(true)
  })

  it('accepts a Telegram destination pinned to one channel integration', () => {
    const def = {
      startStepId: 'send',
      steps: [deliverStep('send', {
        channelType: 'telegram',
        channelId: '-100555:topic:42',
        channelIntegrationId: '00000000-0000-4000-8000-000000000001',
      })],
    }
    expect(WorkflowDefinitionSchema.safeParse(def).success).toBe(true)
  })

  it('accepts a Feishu destination pinned to one channel integration', () => {
    const def = {
      startStepId: 'send',
      steps: [deliverStep('send', {
        channelType: 'feishu',
        channelId: 'oc_0123456789abcdef',
        channelIntegrationId: '00000000-0000-4000-8000-000000000001',
      })],
    }
    expect(WorkflowDefinitionSchema.safeParse(def).success).toBe(true)
  })

  it('accepts a source-bound WhatsApp trigger reply with no authored recipient', () => {
    const def = {
      startStepId: 'reply',
      steps: [deliverStep('reply', {
        channelType: 'whatsapp',
        replyToTrigger: true,
      })],
    }
    expect(WorkflowDefinitionSchema.safeParse(def).success).toBe(true)
  })

  it('rejects a WhatsApp trigger reply mixed with an authored recipient', () => {
    const def = {
      startStepId: 'reply',
      steps: [deliverStep('reply', {
        channelType: 'whatsapp',
        replyToTrigger: true,
        channelId: '15551234567',
      })],
    }
    expect(WorkflowDefinitionSchema.safeParse(def).success).toBe(false)
  })

  it('rejects channelIntegrationId on an unsupported destination', () => {
    const def = {
      startStepId: 'send',
      steps: [deliverStep('send', {
        channelType: 'slack',
        channelId: 'C123',
        channelIntegrationId: '00000000-0000-4000-8000-000000000001',
      })],
    }
    expect(WorkflowDefinitionSchema.safeParse(def).success).toBe(false)
  })

  it('rejects a threaded reply pinned to a different channel integration', () => {
    const def = {
      startStepId: 'parent',
      steps: [
        deliverStep('parent', {
          channelType: 'telegram',
          channelId: '-100555:topic:42',
          channelIntegrationId: '00000000-0000-4000-8000-000000000001',
        }),
        deliverStep('reply', {
          channelType: 'telegram',
          channelId: '-100555:topic:42',
          channelIntegrationId: '00000000-0000-4000-8000-000000000002',
          thread: { fromStep: 'parent' },
        }),
      ],
    }
    expect(WorkflowDefinitionSchema.safeParse(def).success).toBe(false)
  })

  it('rejects deliver.thread on a whatsapp delivery (no threaded replies)', () => {
    const def = {
      startStepId: 'parent',
      steps: [
        deliverStep('parent', { channelType: 'whatsapp', channelId: 'jid@s.whatsapp.net' }),
        deliverStep('reply', {
          channelType: 'whatsapp',
          channelId: 'jid@s.whatsapp.net',
          thread: { fromStep: 'parent' },
        }),
      ],
    }
    const r = WorkflowDefinitionSchema.safeParse(def)
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message.includes('only supported for slack'))).toBe(true)
    }
  })

  it('rejects deliver.thread.fromStep referencing a step without a deliver target', () => {
    const def = {
      startStepId: 'a',
      steps: [
        deliverStep('a'),
        deliverStep('b', { channelType: 'slack', channelId: 'C123', thread: { fromStep: 'a' } }),
      ],
    }
    const r = WorkflowDefinitionSchema.safeParse(def)
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message.includes('deliver'))).toBe(true)
    }
  })

  it('rejects deliver.thread.fromStep referencing a different channel', () => {
    const def = {
      startStepId: 'a',
      steps: [
        deliverStep('a', { channelType: 'slack', channelId: 'C999' }),
        deliverStep('b', { channelType: 'slack', channelId: 'C123', thread: { fromStep: 'a' } }),
      ],
    }
    const r = WorkflowDefinitionSchema.safeParse(def)
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message.includes('different channel'))).toBe(true)
    }
  })

  it('rejects deliver.thread.fromStep referencing itself', () => {
    const def = {
      startStepId: 'a',
      steps: [deliverStep('a', { channelType: 'slack', channelId: 'C123', thread: { fromStep: 'a' } })],
    }
    const r = WorkflowDefinitionSchema.safeParse(def)
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message.includes('itself'))).toBe(true)
    }
  })
})

describe('[COMP:workflow/failure-delivery] WorkflowDefinitionSchema', () => {
  const step = {
    id: 'collect',
    type: 'assistant_call' as const,
    target: { assistantId: 'primary' as const },
    prompt: 'collect',
  }

  it('accepts a static Slack failure destination', () => {
    expect(WorkflowDefinitionSchema.safeParse({
      startStepId: 'collect',
      steps: [step],
      failureDelivery: { channelType: 'slack', channelId: 'C123' },
    }).success).toBe(true)
  })

  it('rejects an inert integration id and a dangling thread parent', () => {
    expect(WorkflowDefinitionSchema.safeParse({
      startStepId: 'collect',
      steps: [step],
      failureDelivery: {
        channelType: 'slack',
        channelId: 'C123',
        channelIntegrationId: '00000000-0000-4000-8000-000000000010',
      },
    }).success).toBe(false)
    expect(WorkflowDefinitionSchema.safeParse({
      startStepId: 'collect',
      steps: [step],
      failureDelivery: {
        channelType: 'slack',
        channelId: 'C123',
        thread: { fromStep: 'missing' },
      },
    }).success).toBe(false)
  })
})

describe('[COMP:workflow/schemas] Parallel fan-out + layout', () => {
  const callStep = (id: string, nextStepId?: string | string[] | null) => ({
    id,
    type: 'assistant_call',
    target: { assistantId: 'primary' },
    prompt: `do ${id}`,
    ...(nextStepId !== undefined ? { nextStepId } : {}),
  })

  it('accepts a fan-out array with an implicit join', () => {
    const def = {
      startStepId: 'a',
      steps: [
        callStep('a', ['b', 'c']),
        callStep('b', 'j'),
        callStep('c', 'j'),
        callStep('j', null),
      ],
    }
    expect(WorkflowDefinitionSchema.safeParse(def).success).toBe(true)
  })

  it('rejects a fan-out entry referencing an unknown step', () => {
    const def = {
      startStepId: 'a',
      steps: [callStep('a', ['b', 'ghost']), callStep('b', null)],
    }
    const r = WorkflowDefinitionSchema.safeParse(def)
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message.includes('unknown step "ghost"'))).toBe(true)
    }
  })

  it('rejects duplicate fan-out targets', () => {
    const def = {
      startStepId: 'a',
      steps: [callStep('a', ['b', 'b']), callStep('b', null)],
    }
    const r = WorkflowDefinitionSchema.safeParse(def)
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message.includes('more than once'))).toBe(true)
    }
  })

  it('rejects a fan-out wider than the width cap', () => {
    const targets = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6']
    const def = {
      startStepId: 'a',
      steps: [callStep('a', targets), ...targets.map((t) => callStep(t, null))],
    }
    expect(WorkflowDefinitionSchema.safeParse(def).success).toBe(false)
  })

  it('rejects a cycle (explicit back-edge)', () => {
    const def = {
      startStepId: 'a',
      steps: [callStep('a', 'b'), callStep('b', 'a')],
    }
    const r = WorkflowDefinitionSchema.safeParse(def)
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message.includes('cycle'))).toBe(true)
    }
  })

  it('rejects a wait step on a parallel branch a sibling never rejoins', () => {
    const def = {
      startStepId: 'a',
      steps: [
        callStep('a', ['w', 'c']),
        { id: 'w', type: 'wait', until: { duration: { minutes: 5 } }, nextStepId: null },
        callStep('c', null),
      ],
    }
    const r = WorkflowDefinitionSchema.safeParse(def)
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message.includes('parallel branch'))).toBe(true)
    }
  })

  it('accepts a wait step after the join', () => {
    const def = {
      startStepId: 'a',
      steps: [
        callStep('a', ['b', 'c']),
        callStep('b', 'w'),
        callStep('c', 'w'),
        { id: 'w', type: 'wait', until: { duration: { minutes: 5 } }, nextStepId: null },
      ],
    }
    expect(WorkflowDefinitionSchema.safeParse(def).success).toBe(true)
  })

  it('accepts layout positions keyed by step id + __trigger', () => {
    const def = {
      startStepId: 'a',
      steps: [callStep('a', null)],
      layout: { a: { x: 120, y: 40 }, __trigger: { x: 0, y: 40 } },
    }
    const r = WorkflowDefinitionSchema.safeParse(def)
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.layout).toEqual({ a: { x: 120, y: 40 }, __trigger: { x: 0, y: 40 } })
    }
  })

  it('rejects layout entries for unknown steps and non-finite coordinates', () => {
    const unknownKey = {
      startStepId: 'a',
      steps: [callStep('a', null)],
      layout: { ghost: { x: 0, y: 0 } },
    }
    expect(WorkflowDefinitionSchema.safeParse(unknownKey).success).toBe(false)

    const badCoord = {
      startStepId: 'a',
      steps: [callStep('a', null)],
      layout: { a: { x: Number.NaN, y: 0 } },
    }
    expect(WorkflowDefinitionSchema.safeParse(badCoord).success).toBe(false)
  })
})

describe('[COMP:workflow/schemas] WorkflowTriggerSchema', () => {
  it('accepts a manual trigger', () => {
    expect(WorkflowTriggerSchema.safeParse({ kind: 'manual' }).success).toBe(true)
  })

  it('accepts a webhook trigger', () => {
    expect(WorkflowTriggerSchema.safeParse({ kind: 'webhook' }).success).toBe(true)
  })

  it('accepts a schedule trigger', () => {
    const trigger = {
      kind: 'schedule',
      schedule: { type: 'daily', time: '09:00' },
      timezone: 'Asia/Hong_Kong',
    }
    expect(WorkflowTriggerSchema.safeParse(trigger).success).toBe(true)
  })

  it('accepts a schedule trigger with mode, delivery sugar, and a paired nag policy', () => {
    const trigger = {
      kind: 'schedule',
      schedule: { type: 'daily', time: '09:00' },
      timezone: 'Asia/Hong_Kong',
      mode: 'user',
      delivery: { channel: 'telegram' },
      policy: { silentUntilFire: true, nagIntervalMins: 15, nagUntilKeyword: 'done' },
    }
    expect(WorkflowTriggerSchema.safeParse(trigger).success).toBe(true)
  })

  it('accepts a schedule trigger with only silentUntilFire policy (no nag)', () => {
    const trigger = {
      kind: 'schedule',
      schedule: { type: 'daily', time: '09:00' },
      policy: { silentUntilFire: true },
    }
    expect(WorkflowTriggerSchema.safeParse(trigger).success).toBe(true)
  })

  it('rejects a schedule policy with nagIntervalMins but no nagUntilKeyword', () => {
    const trigger = {
      kind: 'schedule',
      schedule: { type: 'daily', time: '09:00' },
      policy: { nagIntervalMins: 15 },
    }
    expect(WorkflowTriggerSchema.safeParse(trigger).success).toBe(false)
  })

  it('rejects a schedule delivery to web (delivery sugar is messaging-only)', () => {
    const trigger = {
      kind: 'schedule',
      schedule: { type: 'daily', time: '09:00' },
      delivery: { channel: 'web' },
    }
    expect(WorkflowTriggerSchema.safeParse(trigger).success).toBe(false)
  })

  it('accepts an event trigger with a connector source', () => {
    const trigger = {
      kind: 'event',
      event: {
        sources: [
          { source: { type: 'connector', connectorInstanceId: 'ci-123', provider: 'github' } },
        ],
      },
    }
    expect(WorkflowTriggerSchema.safeParse(trigger).success).toBe(true)
  })

  it('accepts an event trigger with a channel source + match filter', () => {
    const trigger = {
      kind: 'event',
      event: {
        sources: [
          {
            source: { type: 'channel', channelIntegrationId: 'cint-1', channel: 'slack' },
            match: { keywords: ['incident'], inChannels: ['C1'], fromBots: true },
          },
        ],
      },
    }
    expect(WorkflowTriggerSchema.safeParse(trigger).success).toBe(true)
  })

  it('accepts a multi-source event trigger mixing connector and channel', () => {
    const trigger = {
      kind: 'event',
      event: {
        sources: [
          { source: { type: 'connector', connectorInstanceId: 'gh1', provider: 'github' } },
          { source: { type: 'channel', channelIntegrationId: 'sl1', channel: 'slack' } },
        ],
      },
    }
    expect(WorkflowTriggerSchema.safeParse(trigger).success).toBe(true)
  })

  it('accepts a task event source with a tag filter (canonical nested form)', () => {
    const trigger = {
      kind: 'event',
      event: {
        sources: [
          {
            source: { type: 'task' },
            match: { inChannels: ['created', 'tagged'], tags: ['triage'] },
          },
        ],
      },
    }
    const r = WorkflowTriggerSchema.safeParse(trigger)
    expect(r.success).toBe(true)
    if (r.success && r.data.kind === 'event') {
      expect(r.data.event.sources[0].source).toEqual({ type: 'task' })
    }
  })

  it('lifts the FLATTENED task-source entry the prod model emits back to the nested form', () => {
    // Regression: gemini-3-flash-preview intermittently flattens `source.type`
    // to the entry top level (`wf-task-tag-event` eval probe), which used to
    // fail validation with "Required" (missing `source`). z.preprocess lifts
    // the unambiguous flattened form before validation.
    const trigger = {
      kind: 'event',
      event: {
        sources: [
          {
            type: 'task',
            match: { inChannels: ['tagged'], tags: ['triage'] },
          },
        ],
      },
    }
    const r = WorkflowTriggerSchema.safeParse(trigger)
    expect(r.success).toBe(true)
    if (r.success && r.data.kind === 'event') {
      // Normalized to the canonical shape: source nested, match preserved.
      expect(r.data.event.sources[0]).toEqual({
        source: { type: 'task' },
        match: { inChannels: ['tagged'], tags: ['triage'] },
      })
    }
  })

  it('lifts a flattened connector-source entry (type + its own fields) to nested', () => {
    const trigger = {
      kind: 'event',
      event: {
        sources: [{ type: 'connector', connectorInstanceId: 'ci-123', provider: 'github' }],
      },
    }
    const r = WorkflowTriggerSchema.safeParse(trigger)
    expect(r.success).toBe(true)
    if (r.success && r.data.kind === 'event') {
      expect(r.data.event.sources[0].source).toEqual({
        type: 'connector',
        connectorInstanceId: 'ci-123',
        provider: 'github',
      })
    }
  })

  it('rejects an entry with neither `source` nor a valid top-level `type`', () => {
    // The flatten-lift is unambiguous-only: no `source` and no recognized
    // `type` discriminant stays untouched and fails as before.
    const trigger = {
      kind: 'event',
      event: { sources: [{ match: { tags: ['triage'] } }] },
    }
    expect(WorkflowTriggerSchema.safeParse(trigger).success).toBe(false)
  })

  it('does not lift a flattened entry whose top-level `type` is not a known source type', () => {
    // `type: 'database'` is not a source discriminant, so the entry is passed
    // through unchanged and fails validation (no `source`) rather than being
    // silently rewritten into a bogus source.
    const trigger = {
      kind: 'event',
      event: { sources: [{ type: 'database', connectorInstanceId: 'x' }] },
    }
    expect(WorkflowTriggerSchema.safeParse(trigger).success).toBe(false)
  })

  it('accepts a page event source filtered by lifecycle action', () => {
    const trigger = {
      kind: 'event',
      event: {
        sources: [
          {
            source: { type: 'page', pageId: '11111111-1111-1111-1111-111111111111' },
            match: { inChannels: ['created'] },
          },
        ],
      },
    }
    expect(WorkflowTriggerSchema.safeParse(trigger).success).toBe(true)
  })

  it('rejects a page source whose pageId is not a uuid', () => {
    const trigger = {
      kind: 'event',
      event: { sources: [{ source: { type: 'page', pageId: 'root' } }] },
    }
    expect(WorkflowTriggerSchema.safeParse(trigger).success).toBe(false)
  })

  it('rejects an event trigger with an empty sources list', () => {
    const trigger = { kind: 'event', event: { sources: [] } }
    expect(WorkflowTriggerSchema.safeParse(trigger).success).toBe(false)
  })

  it('[COMP:workflow/task-current-tags] accepts currentTags on task sources only', () => {
    expect(WorkflowTriggerSchema.safeParse({
      kind: 'event',
      event: {
        sources: [{
          source: { type: 'task' },
          match: { inChannels: ['completed'], currentTags: ['geo:route:brian'] },
        }],
      },
    }).success).toBe(true)
    expect(WorkflowTriggerSchema.safeParse({
      kind: 'event',
      event: {
        sources: [{
          source: { type: 'channel', channelIntegrationId: 'channel-1', channel: 'slack' },
          match: { currentTags: ['geo:route:brian'] },
        }],
      },
    }).success).toBe(false)
  })

  it('rejects an event source with an unknown type', () => {
    const trigger = {
      kind: 'event',
      event: { sources: [{ source: { type: 'database', connectorInstanceId: 'x' } }] },
    }
    expect(WorkflowTriggerSchema.safeParse(trigger).success).toBe(false)
  })

  it('rejects a connector source missing connectorInstanceId', () => {
    const trigger = {
      kind: 'event',
      event: { sources: [{ source: { type: 'connector', provider: 'github' } }] },
    }
    expect(WorkflowTriggerSchema.safeParse(trigger).success).toBe(false)
  })

  it('rejects an unknown trigger kind', () => {
    expect(WorkflowTriggerSchema.safeParse({ kind: 'cron' }).success).toBe(false)
  })
})

describe('[COMP:workflow/schemas] trigger fan-out (array startStepId)', () => {
  const step = (id: string, nextStepId: string | string[] | null) => ({
    id,
    type: 'assistant_call',
    target: { assistantId: 'primary' },
    prompt: `do ${id}`,
    nextStepId,
  })

  it('accepts a distinct multi-entry start that rejoins', () => {
    const def = {
      startStepId: ['b', 'c'],
      steps: [step('b', 'j'), step('c', 'j'), step('j', null)],
    }
    expect(WorkflowDefinitionSchema.safeParse(def).success).toBe(true)
  })

  it('rejects dangling and duplicate entries', () => {
    expect(
      WorkflowDefinitionSchema.safeParse({
        startStepId: ['b', 'ghost'],
        steps: [step('b', null)],
      }).success,
    ).toBe(false)
    expect(
      WorkflowDefinitionSchema.safeParse({
        startStepId: ['b', 'b'],
        steps: [step('b', null)],
      }).success,
    ).toBe(false)
  })

  it('rejects a width-cap-busting entry list', () => {
    const ids = ['s1', 's2', 's3', 's4', 's5', 's6']
    expect(
      WorkflowDefinitionSchema.safeParse({
        startStepId: ids,
        steps: ids.map((id) => step(id, null)),
      }).success,
    ).toBe(false)
  })

  it('rejects a wait on a trigger-fan-out branch a sibling never rejoins', () => {
    const def = {
      startStepId: ['sleep', 'c'],
      steps: [
        {
          id: 'sleep',
          type: 'wait',
          until: { duration: { hours: 1 } },
          nextStepId: null,
        },
        step('c', null),
      ],
    }
    const r = WorkflowDefinitionSchema.safeParse(def)
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message.includes('parallel branch'))).toBe(true)
    }
  })
})

describe('[COMP:api/client-principal-runtime] external-client definition boundary', () => {
  const apiKeyId = '00000000-0000-4000-8000-000000000010'
  const draftStep = {
    id: 'draft',
    type: 'assistant_call' as const,
    target: { assistantId: '00000000-0000-4000-8000-000000000011' },
    prompt: 'Draft a reply to {{input.event.text}}',
    storeOutputAs: 'draft',
  }

  it('accepts a static client, verified email pairing, and an administrator-authored sender map', () => {
    const staticResult = WorkflowDefinitionSchema.safeParse({
      startStepId: 'draft',
      principal: {
        kind: 'api_external_client',
        apiKeyId,
        assistantId: '00000000-0000-4000-8000-000000000011',
        resolve: { kind: 'static', externalUserId: 'client-17' },
      },
      steps: [draftStep],
    })
    expect(staticResult.success).toBe(true)

    const verifiedEmailResult = WorkflowDefinitionSchema.safeParse({
      startStepId: 'draft',
      principal: {
        kind: 'api_external_client',
        apiKeyId,
        assistantId: '00000000-0000-4000-8000-000000000011',
        resolve: { kind: 'verified_email_pairing' },
      },
      steps: [draftStep],
    })
    expect(verifiedEmailResult.success).toBe(true)

    const mapResult = WorkflowDefinitionSchema.safeParse({
      startStepId: 'draft',
      principal: {
        kind: 'api_external_client',
        apiKeyId,
        assistantId: '00000000-0000-4000-8000-000000000011',
        resolve: {
          kind: 'event_sender_map',
          clients: [
            { sender: 'client-a@customer.example', externalUserId: 'client-17' },
            { sender: 'client-b@customer.example', externalUserId: 'client-42' },
          ],
        },
      },
      steps: [draftStep],
    })
    expect(mapResult.success).toBe(true)
  })

  it('rejects duplicate sender routes case-insensitively', () => {
    const result = WorkflowDefinitionSchema.safeParse({
      startStepId: 'draft',
      principal: {
        kind: 'api_external_client',
        apiKeyId,
        assistantId: '00000000-0000-4000-8000-000000000011',
        resolve: {
          kind: 'event_sender_map',
          clients: [
            { sender: 'Client-A@customer.example', externalUserId: 'client-17' },
            { sender: 'client-a@customer.example', externalUserId: 'client-42' },
          ],
        },
      },
      steps: [draftStep],
    })
    expect(result.success).toBe(false)
  })

  it('accepts one frozen, always-reviewed IMAP reply after a reachable client draft', () => {
    const result = WorkflowDefinitionSchema.safeParse({
      startStepId: 'draft',
      principal: {
        kind: 'api_external_client',
        apiKeyId,
        assistantId: '00000000-0000-4000-8000-000000000011',
        resolve: { kind: 'static', externalUserId: 'client-17' },
      },
      steps: [
        { ...draftStep, nextStepId: 'review' },
        {
          id: 'review',
          type: 'tool_call',
          toolName: 'imapSendMessage__sales_1a2b3c4d',
          arguments: {
            to: ['{{input.event.sender}}'],
            subject: 'Re: {{input.event.subject}}',
            body: '{{vars.draft}}',
            inReplyTo: '{{input.event.message_id}}',
            account: 'contact@company.example',
          },
          approval: { required: true },
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  it.each([
    { name: 'auto send', patch: { approval: undefined } },
    { name: 'recipient override', patch: { arguments: { to: ['other@customer.example'], subject: '{{input.event.subject}}', body: '{{vars.draft}}', inReplyTo: '{{input.event.message_id}}' } } },
    { name: 'unthreaded', patch: { arguments: { to: ['{{input.event.sender}}'], subject: '{{input.event.subject}}', body: '{{vars.draft}}' } } },
    { name: 'copied recipient', patch: { arguments: { to: ['{{input.event.sender}}'], cc: ['audit@company.example'], subject: '{{input.event.subject}}', body: '{{vars.draft}}', inReplyTo: '{{input.event.message_id}}' } } },
    { name: 'unproduced body', patch: { arguments: { to: ['{{input.event.sender}}'], subject: '{{input.event.subject}}', body: '{{vars.missing}}', inReplyTo: '{{input.event.message_id}}' } } },
  ])('rejects reviewed reply escape: $name', ({ patch }) => {
    const result = WorkflowDefinitionSchema.safeParse({
      startStepId: 'draft',
      principal: {
        kind: 'api_external_client',
        apiKeyId,
        assistantId: '00000000-0000-4000-8000-000000000011',
        resolve: { kind: 'static', externalUserId: 'client-17' },
      },
      steps: [
        { ...draftStep, nextStepId: 'review' },
        {
          id: 'review',
          type: 'tool_call',
          toolName: 'imapSendMessage',
          arguments: {
            to: ['{{input.event.sender}}'],
            subject: '{{input.event.subject}}',
            body: '{{vars.draft}}',
            inReplyTo: '{{input.event.message_id}}',
          },
          approval: { required: true },
          ...patch,
        },
      ],
    })
    expect(result.success).toBe(false)
  })

  it.each([
    { ...draftStep, deliver: { channelType: 'slack', channelId: 'C123' } },
    { ...draftStep, session: 'persistent' },
    { ...draftStep, researchMode: true },
    { id: 'draft', type: 'tool_call', toolName: 'imapSendMessage', arguments: {} },
    { id: 'draft', type: 'wait', until: { duration: { minutes: 1 } } },
  ])('rejects draft-lane egress or widened context: $type', (step) => {
    const result = WorkflowDefinitionSchema.safeParse({
      startStepId: 'draft',
      principal: {
        kind: 'api_external_client',
        apiKeyId,
        assistantId: '00000000-0000-4000-8000-000000000011',
        resolve: { kind: 'static', externalUserId: 'client-17' },
      },
      steps: [step],
    })
    expect(result.success).toBe(false)
  })
})
