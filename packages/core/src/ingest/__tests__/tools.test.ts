/**
 * [COMP:brain/ingest-tools] Agent-mediated ingest-rule management tools.
 *
 * Five chat tools (`listConnectorInstances` / `listIngestRules` /
 * `addIngestRule` / `updateIngestRule` / `deleteIngestRule`) that let the
 * model + operator co-edit the Pipeline C routing rules for a connected
 * source. Tests cover Zod input validation at the boundary, snake_case →
 * camelCase pass-through to the `IngestRuleEditorStore`, the
 * `episode_sensitivity: null` clear semantics, RLS user-id threading, and
 * the tool safety-metadata flags (read tools concurrency-safe, write tools
 * not). The store is a `vi.fn()`-recorder fake — no DB.
 *
 * Spec: docs/architecture/brain/ingest-pipeline.md → "Agent-mediated rule
 * management" + "Per-rule Episode sensitivity override".
 */

import { describe, expect, it, vi } from 'vitest'
import {
  createIngestRuleTools,
  type AddIngestRuleInput,
  type ConnectorInstanceSummary,
  type IngestRuleEditorStore,
  type IngestRuleSummary,
  type UpdateIngestRuleInput,
} from '../tools.js'
import type { ToolContext } from '../../tools/types.js'

// ── Fixtures ─────────────────────────────────────────────────────────

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'
const USER_ID = 'user-1'
const CI_ID = '11111111-1111-4111-8111-111111111111'
const RULE_ID = '22222222-2222-4222-8222-222222222222'

const ctx: ToolContext = {
  userId: USER_ID,
  assistantId: 'asst-1',
  sessionId: 'sess-1',
  appId: 'Use Brian',
  channelType: 'web',
  channelId: 'web-1',
  workspaceId: WORKSPACE_ID,
  abortSignal: new AbortController().signal,
}

function makeInstance(
  overrides: Partial<ConnectorInstanceSummary> = {},
): ConnectorInstanceSummary {
  return {
    id: CI_ID,
    scope: 'workspace',
    provider: 'slack',
    label: 'Acme Slack',
    ingestionEnabled: true,
    ...overrides,
  }
}

function makeRule(overrides: Partial<IngestRuleSummary> = {}): IngestRuleSummary {
  return {
    id: RULE_ID,
    connectorInstanceId: CI_ID,
    source: 'slack',
    ruleOrder: 0,
    filterType: 'channel_match',
    filterParams: { values: ['C-founder'] },
    routingMode: 'scheduled',
    routingSchedule: '0 9 * * *',
    routingTimezone: 'UTC',
    alert: false,
    episodeSensitivity: 'confidential',
    ...overrides,
  }
}

// ── Fake store (vi.fn recorders) ─────────────────────────────────────

type FakeStore = IngestRuleEditorStore & {
  listConnectorInstances: ReturnType<typeof vi.fn>
  listRules: ReturnType<typeof vi.fn>
  addRule: ReturnType<typeof vi.fn>
  updateRule: ReturnType<typeof vi.fn>
  deleteRule: ReturnType<typeof vi.fn>
}

function makeFakeStore(seed?: {
  instances?: ConnectorInstanceSummary[]
  rules?: IngestRuleSummary[]
}): FakeStore {
  return {
    listConnectorInstances: vi.fn(async () => seed?.instances ?? [makeInstance()]),
    listRules: vi.fn(async () => seed?.rules ?? [makeRule()]),
    addRule: vi.fn(async (_userId: string, input: AddIngestRuleInput) =>
      makeRule({
        connectorInstanceId: input.connectorInstanceId,
        filterType: input.filterType,
        filterParams: input.filterParams,
        routingMode: input.routingMode,
        routingSchedule: input.routingSchedule ?? null,
        episodeSensitivity: input.episodeSensitivity ?? null,
      }),
    ),
    updateRule: vi.fn(async (_userId: string, input: UpdateIngestRuleInput) =>
      makeRule({
        id: input.ruleId,
        episodeSensitivity: input.patch.episodeSensitivity ?? null,
      }),
    ),
    deleteRule: vi.fn(async () => undefined),
  }
}

// ── listConnectorInstances ───────────────────────────────────────────

describe('[COMP:brain/ingest-tools] listConnectorInstances', () => {
  it('threads the acting user id and workspace id into the store', async () => {
    const store = makeFakeStore()
    const { listConnectorInstances } = createIngestRuleTools(store)
    const result = await listConnectorInstances.execute({}, ctx)
    expect(result.isError).toBeFalsy()
    expect(store.listConnectorInstances).toHaveBeenCalledWith(USER_ID, {
      provider: undefined,
      workspaceId: WORKSPACE_ID,
    })
    expect(result.data).toEqual([makeInstance()])
  })

  it('passes an optional provider filter through', async () => {
    const store = makeFakeStore()
    const { listConnectorInstances } = createIngestRuleTools(store)
    await listConnectorInstances.execute({ provider: 'github' }, ctx)
    expect(store.listConnectorInstances).toHaveBeenCalledWith(USER_ID, {
      provider: 'github',
      workspaceId: WORKSPACE_ID,
    })
  })

  it('passes workspaceId=undefined when the context has no workspace', async () => {
    const store = makeFakeStore()
    const { listConnectorInstances } = createIngestRuleTools(store)
    await listConnectorInstances.execute({}, { ...ctx, workspaceId: null })
    expect(store.listConnectorInstances).toHaveBeenCalledWith(USER_ID, {
      provider: undefined,
      workspaceId: undefined,
    })
  })

  it('rejects an unknown provider at the Zod layer', () => {
    const { listConnectorInstances } = createIngestRuleTools(makeFakeStore())
    const parsed = listConnectorInstances.inputSchema.safeParse({ provider: 'gmail' })
    expect(parsed.success).toBe(false)
  })

  it('rejects unknown keys (strict schema)', () => {
    const { listConnectorInstances } = createIngestRuleTools(makeFakeStore())
    const parsed = listConnectorInstances.inputSchema.safeParse({ unexpected: 1 })
    expect(parsed.success).toBe(false)
  })

  it('is read-only and concurrency-safe', () => {
    const { listConnectorInstances } = createIngestRuleTools(makeFakeStore())
    expect(listConnectorInstances.isReadOnly).toBe(true)
    expect(listConnectorInstances.isConcurrencySafe).toBe(true)
  })
})

// ── listIngestRules ──────────────────────────────────────────────────

describe('[COMP:brain/ingest-tools] listIngestRules', () => {
  it('passes the connector instance id through to the store', async () => {
    const store = makeFakeStore()
    const { listIngestRules } = createIngestRuleTools(store)
    const result = await listIngestRules.execute({ connector_instance_id: CI_ID }, ctx)
    expect(store.listRules).toHaveBeenCalledWith(USER_ID, CI_ID)
    expect(result.data).toEqual([makeRule()])
  })

  it('rejects a non-UUID connector instance id at the Zod layer', () => {
    const { listIngestRules } = createIngestRuleTools(makeFakeStore())
    const parsed = listIngestRules.inputSchema.safeParse({ connector_instance_id: 'nope' })
    expect(parsed.success).toBe(false)
  })

  it('is read-only and concurrency-safe', () => {
    const { listIngestRules } = createIngestRuleTools(makeFakeStore())
    expect(listIngestRules.isReadOnly).toBe(true)
    expect(listIngestRules.isConcurrencySafe).toBe(true)
  })
})

// ── addIngestRule ────────────────────────────────────────────────────

describe('[COMP:brain/ingest-tools] addIngestRule', () => {
  it('maps snake_case input to the camelCase store contract', async () => {
    const store = makeFakeStore()
    const { addIngestRule } = createIngestRuleTools(store)
    await addIngestRule.execute(
      {
        connector_instance_id: CI_ID,
        filter_type: 'channel_match',
        filter_params: { values: ['C-founder'] },
        routing_mode: 'scheduled',
        routing_schedule: '0 9 * * *',
        routing_timezone: 'Asia/Hong_Kong',
        alert: true,
        episode_sensitivity: 'confidential',
        rule_order: 4,
      },
      ctx,
    )
    expect(store.addRule).toHaveBeenCalledWith(USER_ID, {
      connectorInstanceId: CI_ID,
      filterType: 'channel_match',
      filterParams: { values: ['C-founder'] },
      routingMode: 'scheduled',
      routingSchedule: '0 9 * * *',
      routingTimezone: 'Asia/Hong_Kong',
      alert: true,
      episodeSensitivity: 'confidential',
      ruleOrder: 4,
    })
  })

  it('defaults filter_params to an empty object and null-fills optional routing fields', async () => {
    const store = makeFakeStore()
    const { addIngestRule } = createIngestRuleTools(store)
    await addIngestRule.execute(
      {
        connector_instance_id: CI_ID,
        filter_type: 'always',
        routing_mode: 'realtime',
      },
      ctx,
    )
    const [, input] = store.addRule.mock.calls[0]
    expect(input.filterParams).toEqual({})
    expect(input.routingSchedule).toBeNull()
    expect(input.episodeSensitivity).toBeNull()
    expect(input.routingTimezone).toBeUndefined()
    expect(input.ruleOrder).toBeUndefined()
  })

  it('returns the created rule from the store', async () => {
    const store = makeFakeStore()
    const { addIngestRule } = createIngestRuleTools(store)
    const result = await addIngestRule.execute(
      {
        connector_instance_id: CI_ID,
        filter_type: 'channel_match',
        routing_mode: 'scheduled',
        routing_schedule: '0 9 * * *',
        episode_sensitivity: 'confidential',
      },
      ctx,
    )
    const rule = result.data as IngestRuleSummary
    expect(rule.filterType).toBe('channel_match')
    expect(rule.episodeSensitivity).toBe('confidential')
  })

  it('rejects an unknown routing_mode at the Zod layer', () => {
    const { addIngestRule } = createIngestRuleTools(makeFakeStore())
    const parsed = addIngestRule.inputSchema.safeParse({
      connector_instance_id: CI_ID,
      filter_type: 'always',
      routing_mode: 'delete',
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects an empty filter_type at the Zod layer', () => {
    const { addIngestRule } = createIngestRuleTools(makeFakeStore())
    const parsed = addIngestRule.inputSchema.safeParse({
      connector_instance_id: CI_ID,
      filter_type: '',
      routing_mode: 'realtime',
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects an unknown episode_sensitivity value at the Zod layer', () => {
    const { addIngestRule } = createIngestRuleTools(makeFakeStore())
    const parsed = addIngestRule.inputSchema.safeParse({
      connector_instance_id: CI_ID,
      filter_type: 'always',
      routing_mode: 'realtime',
      episode_sensitivity: 'secret',
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects a negative rule_order at the Zod layer', () => {
    const { addIngestRule } = createIngestRuleTools(makeFakeStore())
    const parsed = addIngestRule.inputSchema.safeParse({
      connector_instance_id: CI_ID,
      filter_type: 'always',
      routing_mode: 'realtime',
      rule_order: -1,
    })
    expect(parsed.success).toBe(false)
  })

  it('is a write tool (not read-only, not concurrency-safe)', () => {
    const { addIngestRule } = createIngestRuleTools(makeFakeStore())
    expect(addIngestRule.isReadOnly).toBe(false)
    expect(addIngestRule.isConcurrencySafe).toBe(false)
  })
})

// ── updateIngestRule ─────────────────────────────────────────────────

describe('[COMP:brain/ingest-tools] updateIngestRule', () => {
  it('maps the snake_case patch to the camelCase store patch', async () => {
    const store = makeFakeStore()
    const { updateIngestRule } = createIngestRuleTools(store)
    await updateIngestRule.execute(
      {
        rule_id: RULE_ID,
        patch: {
          routing_mode: 'realtime',
          routing_schedule: null,
          alert: true,
          episode_sensitivity: 'internal',
        },
      },
      ctx,
    )
    expect(store.updateRule).toHaveBeenCalledWith(USER_ID, {
      ruleId: RULE_ID,
      patch: {
        filterType: undefined,
        filterParams: undefined,
        routingMode: 'realtime',
        routingSchedule: null,
        routingTimezone: undefined,
        alert: true,
        episodeSensitivity: 'internal',
        ruleOrder: undefined,
      },
    })
  })

  it('threads episode_sensitivity: null through as a literal null to clear the override', async () => {
    const store = makeFakeStore()
    const { updateIngestRule } = createIngestRuleTools(store)
    await updateIngestRule.execute(
      { rule_id: RULE_ID, patch: { episode_sensitivity: null } },
      ctx,
    )
    const [, input] = store.updateRule.mock.calls[0]
    expect('episodeSensitivity' in input.patch).toBe(true)
    expect(input.patch.episodeSensitivity).toBeNull()
  })

  it('rejects an empty patch at the Zod layer', () => {
    const { updateIngestRule } = createIngestRuleTools(makeFakeStore())
    const parsed = updateIngestRule.inputSchema.safeParse({ rule_id: RULE_ID, patch: {} })
    expect(parsed.success).toBe(false)
  })

  it('rejects an unknown patch key (strict schema)', () => {
    const { updateIngestRule } = createIngestRuleTools(makeFakeStore())
    const parsed = updateIngestRule.inputSchema.safeParse({
      rule_id: RULE_ID,
      patch: { not_a_field: true },
    })
    expect(parsed.success).toBe(false)
  })

  it('is a write tool (not read-only, not concurrency-safe)', () => {
    const { updateIngestRule } = createIngestRuleTools(makeFakeStore())
    expect(updateIngestRule.isReadOnly).toBe(false)
    expect(updateIngestRule.isConcurrencySafe).toBe(false)
  })
})

// ── deleteIngestRule ─────────────────────────────────────────────────

describe('[COMP:brain/ingest-tools] deleteIngestRule', () => {
  it('passes the rule id through and echoes it back', async () => {
    const store = makeFakeStore()
    const { deleteIngestRule } = createIngestRuleTools(store)
    const result = await deleteIngestRule.execute({ rule_id: RULE_ID }, ctx)
    expect(store.deleteRule).toHaveBeenCalledWith(USER_ID, RULE_ID)
    expect(result.data).toEqual({ deleted: RULE_ID })
  })

  it('rejects a non-UUID rule id at the Zod layer', () => {
    const { deleteIngestRule } = createIngestRuleTools(makeFakeStore())
    const parsed = deleteIngestRule.inputSchema.safeParse({ rule_id: 'nope' })
    expect(parsed.success).toBe(false)
  })

  it('is a write tool (not read-only, not concurrency-safe)', () => {
    const { deleteIngestRule } = createIngestRuleTools(makeFakeStore())
    expect(deleteIngestRule.isReadOnly).toBe(false)
    expect(deleteIngestRule.isConcurrencySafe).toBe(false)
  })
})

// ── Tool aggregate / shape ───────────────────────────────────────────

describe('[COMP:brain/ingest-tools] createIngestRuleTools', () => {
  it('exposes all five tools with the documented names', () => {
    const tools = createIngestRuleTools(makeFakeStore())
    expect(tools.listConnectorInstances.name).toBe('listConnectorInstances')
    expect(tools.listIngestRules.name).toBe('listIngestRules')
    expect(tools.addIngestRule.name).toBe('addIngestRule')
    expect(tools.updateIngestRule.name).toBe('updateIngestRule')
    expect(tools.deleteIngestRule.name).toBe('deleteIngestRule')
  })

  it('keeps the filter vocabulary in tool descriptions, not requiring the system prompt', () => {
    // Tool-awareness rule: filter-type / routing-mode hints live in the
    // tool description so Layer 1 stays tool-agnostic.
    const { addIngestRule } = createIngestRuleTools(makeFakeStore())
    expect(addIngestRule.description).toMatch(/channel_match|is_dm|always/)
    expect(addIngestRule.description).toMatch(/realtime|scheduled|drop/)
  })
})
