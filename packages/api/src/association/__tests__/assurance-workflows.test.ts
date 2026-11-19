import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  createCrmOperationsTools,
  type CrmOperationsReadPort,
} from '@use-brian/core/crm/operations-tools.js'
import type { CrmOperationsServicePort } from '@use-brian/core/crm/operations-types.js'
import { createCrmTools } from '@use-brian/core/crm/tools.js'
import type { CrmStore } from '@use-brian/core/crm/types.js'
import { createTaskTools } from '@use-brian/core/tasks/tools.js'
import type { TaskStore } from '@use-brian/core/tasks/types.js'
import { evaluateBoolean } from '@use-brian/core/workflow/condition.js'
import { interpolateValue } from '@use-brian/core/workflow/interpolation.js'
import {
  WorkflowDefinitionSchema,
  WorkflowTriggerSchema,
} from '@use-brian/core/workflow/schemas.js'
import type { Tool, ToolContext } from '@use-brian/agent-runtime/tools/types.js'
const fixture = JSON.parse(readFileSync(new URL('../../../../../scripts/crm/fixtures/association-workflows.json', import.meta.url), 'utf8'))
type Recipe = { key: string; enabled: boolean; trigger: unknown; definition: { startStepId: string; steps: Array<Record<string, any>> }; sampleInput: Record<string, any>; sampleVars: Record<string, any> }
const recipes = fixture.recipes as Recipe[]
const execute = vi.fn<CrmOperationsServicePort['execute']>().mockResolvedValue({ command: 'record_participation', record: { id: randomUUID() }, created: true, duplicate: false, emittedEventIds: [] })
const operationTools = createCrmOperationsTools({ reads: {} as CrmOperationsReadPort, service: { execute } })
const tools: Record<string, Tool> = { ...operationTools, ...createCrmTools({} as CrmStore), ...createTaskTools({} as TaskStore) }
const recipe = (key: string) => recipes.find(item => item.key === key)!
function inputFor(value: Recipe, step: Record<string, any>) { return interpolateValue(step.arguments, { input: value.sampleInput, vars: value.sampleVars }) }
function validate(tool: string, args: unknown) {
  return tools[tool].inputSchema.parse(args)
}
describe('[COMP:crm/assurance-workflows] Fictional typed workflow recipes', () => {
  it('ships exactly five disabled definitions using canonical workflow and event schemas', () => {
    expect(recipes.map(item => item.key)).toEqual(['submission_notification', 'event_registration', 'membership_onboarding', 'weekly_deal_digest', 'managed_outreach'])
    for (const item of recipes) {
      expect(item.enabled).toBe(false)
      expect(WorkflowDefinitionSchema.safeParse(item.definition).success, item.key).toBe(true)
      expect(WorkflowTriggerSchema.safeParse(item.trigger).success, item.key).toBe(true)
    }
  })
  it('validates every interpolated deterministic step against the registered native tool schema', () => {
    for (const item of recipes) for (const step of item.definition.steps) if (step.type === 'tool_call') {
      const args = inputFor(item, step)
      expect(JSON.stringify(args)).not.toContain('{{')
      expect(() => validate(step.toolName, args), `${item.key}/${step.id}`).not.toThrow()
    }
  })
  it('preserves stable event delivery identities and requires review before managed dispatch', () => {
    const item = recipe('submission_notification'), step = item.definition.steps[0]
    const first = validate(step.toolName, inputFor(item, step)), replay = validate(step.toolName, inputFor(item, step))
    expect(first).toEqual(replay)
    expect(first).toMatchObject({ deliveryId: item.sampleInput.event.domainEventId, purposeKey: 'operator_notice', to: ['operator@example.com'] })
    for (const value of recipes) for (const send of value.definition.steps.filter(s => s.toolName === 'sendCrmMessage')) expect(send.approval).toEqual({ required: true })
  })
  it('uses the canonical participation command with immutable source identity and no payment fields', async () => {
    const item = recipe('event_registration'), step = item.definition.steps[0], args = validate(step.toolName, inputFor(item, step))
    const context: ToolContext = { userId: randomUUID(), assistantId: randomUUID(), sessionId: randomUUID(), appId: 'fixture', channelType: 'workflow', channelId: 'fixture', workspaceId: randomUUID(), abortSignal: new AbortController().signal }
    await tools[step.toolName].execute(args, context)
    expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: context.workspaceId }), expect.objectContaining({ kind: 'record_participation', sourceKind: 'workflow', sourceId: item.sampleInput.registrationSourceId, eventId: item.sampleInput.eventId, contactId: item.sampleInput.contactId }))
    expect(JSON.stringify(execute.mock.calls.at(-1)![1])).not.toMatch(/providerReference|ticketId|orderId/)
  })
  it('requires current effective membership and retains task subject attribution', () => {
    const item = recipe('membership_onboarding'), read = item.definition.steps[0], guard = item.definition.steps.find(step => step.type === 'branch')!
    expect(read.arguments).toMatchObject({ active_only: true, limit: 1 })
    expect(evaluateBoolean(guard.condition, { input: item.sampleInput, vars: item.sampleVars })).toBe(true)
    for (const entitlements of [[], [{ status: 'active', isEffective: false }], [{ status: 'active' }]]) {
      expect(evaluateBoolean(guard.condition, { input: item.sampleInput, vars: { membership: { entitlements } } })).toBe(false)
    }
    expect(evaluateBoolean(guard.condition, { input: { event: { ...item.sampleInput.event, status: 'cancelled' } }, vars: item.sampleVars })).toBe(false)
    const task = item.definition.steps.find(step => step.toolName === 'saveTask')!
    expect(inputFor(item, task)).toMatchObject({ attributes: { crm_contact_id: item.sampleInput.event.contactId, crm_entitlement_id: item.sampleInput.event.entitlementId } })
  })
  it('confines optional digest prose to paginated reads and denies blocked/unknown outreach previews', () => {
    const digest = recipe('weekly_deal_digest').definition.steps[0]
    expect(digest.type).toBe('assistant_call')
    expect(digest.tools.every((name: string) => tools[name]?.isReadOnly)).toBe(true)
    expect(digest.prompt).toContain('follow nextCursor')
    const item = recipe('managed_outreach'), guard = item.definition.steps.find(step => step.type === 'branch')!
    for (const verdict of ['blocked', 'unknown', undefined]) expect(evaluateBoolean(guard.condition, { input: item.sampleInput, vars: { sendability: { verdict } } })).toBe(false)
    expect(evaluateBoolean(guard.condition, { input: item.sampleInput, vars: item.sampleVars })).toBe(true)
  })
  it('rejects unresolved ids and receipt identities rather than silently inventing new ones', () => {
    for (const key of ['submission_notification', 'event_registration']) {
      const item = recipe(key), step = item.definition.steps[0]
      const args = interpolateValue(step.arguments, { input: {}, vars: {} })
      expect(() => validate(step.toolName, args)).toThrow()
    }
  })
})
