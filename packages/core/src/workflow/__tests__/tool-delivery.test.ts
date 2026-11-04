import { describe, expect, it, vi } from 'vitest'
import { deliverToolCallNotification } from '../tool-delivery.js'
import { WorkflowDefinitionSchema, WorkflowStepSchema, reviewedClientReplyViolation } from '../schemas.js'
import type { DeliveryOutcome } from '../executor.js'
import type { ToolCallStep } from '../types.js'

const step: ToolCallStep = { id: 'notify', type: 'tool_call', toolName: 'getCrmSubmission', arguments: {},
  deliver: { channelType: 'slack', channelId: 'C_APPROVED' }, deliveryText: '{{input.site}}: {{prev.name}} {{vars.label}}' }
const seed = () => ({ step, output: { name: '{{input.redirect}}' }, scope: { input: { site: 'Website', redirect: 'untrusted' }, vars: { label: 'saved' } },
  run: { id: 'run', workspaceId: 'workspace', triggeredBy: null }, workflow: { id: 'workflow', createdBy: 'creator' }, assistantId: 'acting-primary',
  scopeEvidence: { sensitivity: 'internal' as const, compartments: [], projectIds: [], sources: [{ workspaceId: 'workspace', userId: null,
    assistantId: null, sensitivity: 'internal' as const, compartments: [], projectIds: [], resourceKind: 'entity', resourceId: 'contact', version: '1' }] } })

describe('[COMP:workflow/tool-delivery] deterministic notification boundary', () => {
  it('passes text-only substitution and complete evidence to the exact authored destination', async () => {
    const deliverToChannel = vi.fn(async (): Promise<DeliveryOutcome> => ({ status: 'delivered', channelType: 'slack', channelId: 'C_APPROVED' }))
    const input = seed(), output = await deliverToolCallNotification({ ...input, deps: { deliverToChannel } })
    expect(output?.status).toBe('delivered')
    expect(deliverToChannel).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'workspace', assistantId: 'acting-primary', userId: 'creator',
      channelType: 'slack', channelId: 'C_APPROVED', text: 'Website: {{input.redirect}} saved', scopeEvidence: input.scopeEvidence,
      publication: { runId: 'run', stepId: 'notify' } })
  })
  it.each(['not-wired', 'empty', 'cancelled', 'malformed', 'malformed-text', 'invalid-integration'] as const)('does not start a send for %s', async state => {
    const input = seed(), deliverToChannel = vi.fn()
    if (state === 'empty') input.step = { ...step, deliveryText: '{{prev.missing}}' }
    if (state === 'malformed') input.step = { ...step, deliver: { ...step.deliver!, channelId: '{{prev.channel}}' } }
    if (state === 'malformed-text') input.step = { ...step, deliveryText: {} as unknown as string }
    if (state === 'invalid-integration') input.step = { ...step, deliver: { ...step.deliver!, channelIntegrationId: '00000000-0000-4000-8000-000000000001' } }
    const abort = new AbortController(); if (state === 'cancelled') abort.abort()
    const result = await deliverToolCallNotification({ ...input, deps: { abortSignal: abort.signal,
      ...(state === 'not-wired' ? {} : { deliverToChannel }) } })
    expect(result?.status).not.toBe('delivered'); expect(deliverToChannel).not.toHaveBeenCalled()
  })
  it('surfaces sink refusal and uncertain provider errors without changing tool output', async () => {
    const input = seed(), snapshot = structuredClone(input.output)
    const refused = { status: 'skipped', channelType: 'slack', reason: 'delivery_audience_unverified' } as const
    expect(await deliverToolCallNotification({ ...input, deps: { deliverToChannel: async () => refused } })).toEqual(refused)
    expect(await deliverToolCallNotification({ ...input, deps: { deliverToChannel: async () => { throw new Error('provider unconfirmed') } } }))
      .toEqual({ status: 'failed', channelType: 'slack', error: 'provider unconfirmed' })
    expect(input.output).toEqual(snapshot)
  })
  it('replies under the confirmed parent and refuses to spill into the channel when it is missing', async () => {
    const input = seed()
    const reply = { ...step, deliver: { ...step.deliver!, thread: { fromStep: 'parent' } } }
    const deliverToChannel = vi.fn(async (_params: unknown): Promise<DeliveryOutcome> => ({ status: 'delivered', channelType: 'slack', channelId: 'C_APPROVED', messageId: '2.0' }))
    expect(await deliverToolCallNotification({ ...input, step: reply, deps: { deliverToChannel } })).toMatchObject({ status: 'failed' })
    expect(deliverToChannel).not.toHaveBeenCalled()
    expect(await deliverToolCallNotification({ ...input, step: reply,
      scope: { ...input.scope, vars: { ...input.scope.vars, __deliveryMsg_parent: '1.0' } }, deps: { deliverToChannel } }))
      .toMatchObject({ status: 'delivered', thread: 'applied' })
    expect(deliverToChannel.mock.calls[0][0]).toMatchObject({ threadRef: '1.0', scopeEvidence: input.scopeEvidence })
  })
  it('validates tool thread destinations and parent references', () => {
    const reply = { ...step, id: 'reply', deliver: { ...step.deliver!, thread: { fromStep: step.id } } }
    const definition = { startStepId: step.id, steps: [step, reply] }
    expect(WorkflowDefinitionSchema.safeParse(definition).success).toBe(true)
    for (const deliver of [
      { ...reply.deliver, channelId: 'C_OTHER' },
      { ...reply.deliver, thread: { fromStep: 'missing' } },
      { ...reply.deliver, thread: { fromStep: 'reply' } },
      { ...reply.deliver, channelType: 'whatsapp' },
    ]) expect(WorkflowDefinitionSchema.safeParse({ ...definition, steps: [step, { ...reply, deliver }] }).success).toBe(false)
  })
  it('requires paired fields and rejects unsupported recipient and response surfaces', () => {
    expect(WorkflowDefinitionSchema.safeParse({ startStepId: step.id, steps: [step] }).success).toBe(true)
    for (const invalid of [{ ...step, deliveryText: undefined }, { ...step, deliver: undefined },
      { ...step, deliver: { channelType: 'whatsapp', replyToTrigger: true } },
      { ...step, question: { text: 'Not supported' } }]) expect(WorkflowStepSchema.safeParse(invalid).success).toBe(false)
    expect(WorkflowDefinitionSchema.safeParse({ startStepId: step.id, steps: [{ ...step, deliver: { ...step.deliver, channelId: 'current' } }] }).success).toBe(false)
    expect(reviewedClientReplyViolation(step)).toContain('cannot configure another output delivery')
  })
})
