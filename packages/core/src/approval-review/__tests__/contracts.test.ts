import { describe, expect, it } from 'vitest'
import {
  countQualifyingSupport,
  deriveActionDescriptor,
  humanOnlyCategory,
  matchPattern,
  parameterPolicySchema,
  patternKeyFor,
  resolveEffectiveAssignment,
  type ActionDescriptor,
  type AssignmentCandidate,
  type DescriptorSource,
  type ParameterPolicy,
  type SupportRecord,
} from '../contracts.js'

const step = { id: 'send', type: 'tool_call', toolName: 'slackPostMessage', arguments: { channel: '#ops', text: '{{vars.summary}}' }, approval: { required: true } }
const wf = (over: Partial<Extract<DescriptorSource, { kind: 'workflow_step' }>> = {}): DescriptorSource => ({
  kind: 'workflow_step', toolName: 'slackPostMessage', arguments: { channel: '#ops', text: 'Daily fictional summary' },
  workflowId: '11111111-1111-4111-8111-111111111111', stepId: 'send', stepDefinition: step,
  accountKey: null, originatingAssistantId: '22222222-2222-4222-8222-222222222222', description: null, ...over,
})
const descriptor = (src: DescriptorSource): ActionDescriptor => {
  const r = deriveActionDescriptor(src)
  if (!r.ok) throw new Error(r.reason)
  return r.descriptor
}
const lineage = (d: ActionDescriptor, policy: ParameterPolicy = {}) => ({ patternKey: patternKeyFor(d, policy), descriptor: d, parameterPolicy: policy })

describe('[COMP:approval-review/contracts] delegated approval review contracts', () => {
  describe('action descriptors', () => {
    it('derives a workflow-step descriptor from frozen facts, executor identity when no account', () => {
      const d = descriptor(wf())
      expect(d).toMatchObject({ actionKind: 'slackPostMessage', identity: 'assistant:22222222-2222-4222-8222-222222222222', procedure: { kind: 'workflow', stepId: 'send' } })
      expect(descriptor(wf({ accountKey: 'ops@fictional.example' })).identity).toBe('account:ops@fictional.example')
      expect(descriptor(wf({ toolName: 'slackPostMessage__abc' })).actionKind).toBe('slackPostMessage')
    })

    it('leaves a request without workflow identity, identity or action unresolved', () => {
      expect(deriveActionDescriptor(wf({ workflowId: null }))).toEqual({ ok: false, reason: 'no_procedure' })
      expect(deriveActionDescriptor(wf({ stepDefinition: null }))).toEqual({ ok: false, reason: 'no_procedure' })
      expect(deriveActionDescriptor(wf({ originatingAssistantId: null }))).toEqual({ ok: false, reason: 'unknown_identity' })
      expect(deriveActionDescriptor(wf({ toolName: null }))).toEqual({ ok: false, reason: 'unknown_action' })
      expect(deriveActionDescriptor({ kind: 'tool_invocation' })).toEqual({ ok: false, reason: 'ineligible_kind' })
      expect(deriveActionDescriptor({ kind: 'staged_write' })).toEqual({ ok: false, reason: 'ineligible_kind' })
    })

    it('derives a browser-send descriptor per skill version, profile and target; drift/ceiling/legacy are unresolved', () => {
      const payload = { skillId: 'sk-1', skillVersion: 3, profileId: 'pr-1', ref: 'e12', label: 'Submit timesheet', description: 'Submit the weekly timesheet', site: 'hr.fictional.example' }
      const d = descriptor({ kind: 'browser_skill_send', payload })
      expect(d).toMatchObject({ actionKind: 'browser.terminal_send', identity: 'browser_profile:pr-1', procedure: { kind: 'browser_skill', id: 'sk-1', version: 3, stepId: 'e12' } })
      expect(deriveActionDescriptor({ kind: 'browser_skill_send', payload: { ...payload, skillVersion: undefined } })).toEqual({ ok: false, reason: 'skill_version_missing' })
      expect(deriveActionDescriptor({ kind: 'browser_skill_send', payload: { ...payload, drift: 'label changed' } })).toEqual({ ok: false, reason: 'send_drift' })
      expect(deriveActionDescriptor({ kind: 'browser_skill_send', payload: { ...payload, ceiling: 'payment' } })).toEqual({ ok: false, reason: 'verb_ceiling' })
    })
  })

  describe('D47 human-only categories', () => {
    it('classifies payments, transfers, account deletion, security and bulk destructive actions', () => {
      expect(humanOnlyCategory({ actionKind: 'stripeCreatePayment' })).toBe('payment')
      expect(humanOnlyCategory({ actionKind: 'bankTransferFunds' })).toBe('transfer')
      expect(humanOnlyCategory({ actionKind: 'deleteUserAccount' })).toBe('account_deletion')
      expect(humanOnlyCategory({ actionKind: 'rotateApiKey' })).toBe('security')
      expect(humanOnlyCategory({ actionKind: 'updateMemberRole' })).toBe('security')
      expect(humanOnlyCategory({ actionKind: 'bulkArchive' })).toBe('bulk_destructive')
      expect(humanOnlyCategory({ actionKind: 'deleteRecords', parameters: { ids: ['a', 'b'] } })).toBe('bulk_destructive')
      expect(humanOnlyCategory({ actionKind: 'browser.terminal_send', effectTexts: ['Place order'] })).toBe('payment')
      expect(humanOnlyCategory({ actionKind: 'browser.terminal_send', ceiling: 'mass_delete' })).toBe('bulk_destructive')
    })

    it('gives normally allowed actions no category (no extra gate)', () => {
      expect(humanOnlyCategory({ actionKind: 'slackPostMessage' })).toBeNull()
      expect(humanOnlyCategory({ actionKind: 'createTask' })).toBeNull()
      expect(humanOnlyCategory({ actionKind: 'deleteRecords', parameters: { ids: ['a'] } })).toBeNull()
      expect(humanOnlyCategory({ actionKind: 'browser.terminal_send', effectTexts: ['Submit timesheet'] })).toBeNull()
    })
  })

  describe('D42 exact match', () => {
    const base = descriptor(wf())
    it('matches only the same workflow, step definition, identity, action and parameters', () => {
      const p = lineage(base)
      expect(matchPattern(p, descriptor(wf()))).toEqual({ ok: true })
      expect(matchPattern(p, descriptor(wf({ workflowId: '33333333-3333-4333-8333-333333333333' })))).toEqual({ ok: false, reason: 'procedure_mismatch' })
      expect(matchPattern(p, descriptor(wf({ stepDefinition: { ...step, arguments: { channel: '#all' } } })))).toEqual({ ok: false, reason: 'definition_changed' })
      expect(matchPattern(p, descriptor(wf({ accountKey: 'other@fictional.example' })))).toEqual({ ok: false, reason: 'identity_mismatch' })
      expect(matchPattern(p, descriptor(wf({ arguments: { channel: '#ops', text: 'A different fictional text' } })))).toEqual({ ok: false, reason: 'parameter_mismatch' })
      expect(matchPattern(p, descriptor(wf({ arguments: { channel: '#ops', text: 'Daily fictional summary', attachment: 'f1' } })))).toEqual({ ok: false, reason: 'parameter_mismatch' })
    })

    it('accepts a varying field only within its explicit human rule', () => {
      const policy = parameterPolicySchema.parse({ text: { rule: 'text', maxLength: 40 } })
      const p = lineage(base, policy)
      expect(matchPattern(p, descriptor(wf({ arguments: { channel: '#ops', text: 'Another short fictional summary' } })))).toEqual({ ok: true })
      expect(matchPattern(p, descriptor(wf({ arguments: { channel: '#ops', text: 'x'.repeat(41) } })))).toEqual({ ok: false, reason: 'varying_field_out_of_policy' })
      expect(matchPattern(p, descriptor(wf({ arguments: { channel: '#general', text: 'short' } })))).toEqual({ ok: false, reason: 'parameter_mismatch' })
    })

    it('never treats a recipient or attachment as free text, and keys lineages by policy', () => {
      expect(parameterPolicySchema.safeParse({ to: { rule: 'text', maxLength: 100 } }).success).toBe(false)
      expect(parameterPolicySchema.safeParse({ attachmentId: { rule: 'text', maxLength: 100 } }).success).toBe(false)
      expect(parameterPolicySchema.safeParse({ to: { rule: 'one_of', values: ['a@fictional.example'] } }).success).toBe(true)
      expect(patternKeyFor(base, {})).not.toBe(patternKeyFor(base, { text: { rule: 'text', maxLength: 40 } }))
      const money = parameterPolicySchema.parse({ amount: { rule: 'number_max', max: 10 } })
      const d = descriptor(wf({ arguments: { channel: '#ops', text: 'Daily fictional summary', amount: 5 } }))
      expect(matchPattern(lineage(d, money), descriptor(wf({ arguments: { channel: '#ops', text: 'Daily fictional summary', amount: 11 } })))).toEqual({ ok: false, reason: 'varying_field_out_of_policy' })
    })
  })

  describe('D43 human evidence', () => {
    const at = (m: number) => new Date(Date.UTC(2026, 9, 1, 0, m))
    const rec = (id: string, chain: string, over: Partial<SupportRecord> = {}): SupportRecord =>
      ({ approvalId: id, chainKey: chain, decision: 'approved', humanOrigin: true, decidedAt: at(Number(id.replace(/\D/g, '')) || 0), ...over })

    it('qualifies on three distinct human chains', () => {
      const r = countQualifyingSupport([rec('a1', 'run1'), rec('a2', 'run2'), rec('a3', 'run3')], null)
      expect(r).toMatchObject({ distinctApprovedChains: 3, qualifies: true, contradicted: false, countedApprovalIds: ['a1', 'a2', 'a3'] })
    })

    it('ignores duplicates in one chain, AI decisions and withdrawn approvals', () => {
      const r = countQualifyingSupport([
        rec('a1', 'run1'), rec('a2', 'run1'), rec('a3', 'run1'),
        rec('a4', 'run2', { humanOrigin: false }), rec('a5', 'run3', { withdrawn: true }), rec('a6', 'run4'),
      ], null)
      expect(r).toMatchObject({ distinctApprovedChains: 2, qualifies: false })
    })

    it('a human denial contradicts, and only evidence after a revocation counts', () => {
      expect(countQualifyingSupport([rec('a1', 'r1'), rec('a2', 'r2'), rec('a3', 'r3'), rec('a4', 'r4', { decision: 'rejected' })], null))
        .toMatchObject({ qualifies: false, contradicted: true })
      expect(countQualifyingSupport([rec('a1', 'r1'), rec('a2', 'r2'), rec('a3', 'r3'), rec('a4', 'r4')], at(3)))
        .toMatchObject({ distinctApprovedChains: 2, qualifies: false })
    })
  })

  describe('D45/D46 assignment precedence', () => {
    const human = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const cand = (over: Partial<AssignmentCandidate>): AssignmentCandidate => ({
      id: Math.random().toString(36), scopeKind: 'workflow', scopeId: 'wf', status: 'active', delegatorUserId: human,
      reviewerAssistantId: 'rev', revision: 1, parameterPolicy: {}, ...over,
    })
    const scopes = { approvalId: 'ap', approverUserId: human, taskId: 'task', sessionId: 'sess', procedure: { kind: 'workflow' as const, id: 'wf' } }

    it('has no reviewer unless one was assigned', () => {
      expect(resolveEffectiveAssignment([], scopes)).toBeNull()
    })

    it('prefers request over task over session over the workflow default', () => {
      const wfDefault = cand({ scopeKind: 'workflow', scopeId: 'wf' })
      const session = cand({ scopeKind: 'session', scopeId: 'sess' })
      const request = cand({ scopeKind: 'request', scopeId: 'ap' })
      expect(resolveEffectiveAssignment([wfDefault], scopes)).toBe(wfDefault)
      expect(resolveEffectiveAssignment([wfDefault, session], scopes)).toBe(session)
      expect(resolveEffectiveAssignment([wfDefault, session, request], scopes)).toBe(request)
    })

    it('ignores revoked assignments and assignments made by anyone but the approver', () => {
      expect(resolveEffectiveAssignment([cand({ status: 'revoked' })], scopes)).toBeNull()
      expect(resolveEffectiveAssignment([cand({ delegatorUserId: 'someone-else' })], scopes)).toBeNull()
    })
  })
})
