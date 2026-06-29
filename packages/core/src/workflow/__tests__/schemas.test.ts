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
