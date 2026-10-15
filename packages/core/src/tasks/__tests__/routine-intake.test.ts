import { describe, expect, it } from 'vitest'
import { RoutineTaskIntakeSchema, readRoutineInput, routineConfigurationIssues, routineConfigurationShape, qualifyRoutineTracking } from '../routine-intake.js'
import { evaluateTaskAdmission, type TaskReadinessAssessment, type TaskRuleRecord } from '../admission.js'
import { WorkflowDefinitionSchema } from '../../workflow/schemas.js'

const id = '00000000-0000-4000-8000-000000000001'
const config = {
  version: 1 as const,
  blueprint: { outcome: 'Prepare a case summary', description: 'Summarize the admitted case', completionCheck: 'Summary is saved',
    inputs: [{ key: 'case', label: 'Which case?', path: 'event.caseId', required: true }] },
  home: { kind: 'department' as const, id }, permittedActions: ['saveTask'], requiredAccounts: [],
}
const definition = { startStepId: 'review', steps: [{ id: 'review', type: 'tool_call' as const, toolName: 'getTask', arguments: {} }] }

describe('[COMP:tasks/routine-intake] native configuration boundary', () => {
  it('keeps legacy definitions off and round-trips optional typed configuration', () => {
    expect(WorkflowDefinitionSchema.parse(definition).taskIntake).toBeUndefined()
    expect(WorkflowDefinitionSchema.parse({ ...definition, taskIntake: config }).taskIntake).toEqual(config)
  })
  it.each(['human_confirmed', 'workflowId', 'budget', 'periodCap'])('rejects caller authority/budget field %s', field => {
    expect(RoutineTaskIntakeSchema.safeParse({ ...config, [field]: true }).success).toBe(false)
  })
  it.each(['input.event.caseId', 'event.__proto__.caseId', 'event.constructor.name', 'event.caseId()', 'vars.caseId'])
    ('rejects non-event or unsafe binding %s', path => {
      expect(RoutineTaskIntakeSchema.safeParse({ ...config, blueprint: { ...config.blueprint,
        inputs: [{ ...config.blueprint.inputs[0], path }] } }).success).toBe(false)
      expect(readRoutineInput({ event: { caseId: 'fictional-case' } }, path)).toBeUndefined()
    })
  it('keeps missing and inherited values missing', () => {
    expect(readRoutineInput({ event: { caseId: 'fictional-case' } }, 'event.caseId')).toBe('fictional-case')
    expect(readRoutineInput({ event: {} }, 'event.caseId')).toBeUndefined()
    expect(readRoutineInput({ event: Object.create({ caseId: 'fictional-case' }) }, 'event.caseId')).toBeUndefined()
  })
  it('rejects duplicate input keys', () => {
    expect(RoutineTaskIntakeSchema.safeParse({ ...config, blueprint: { ...config.blueprint,
      inputs: [...config.blueprint.inputs, ...config.blueprint.inputs] } }).success).toBe(false)
  })
  it('keeps unresolved drafts separate from activation and never guesses a home/executor', () => {
    const draft = { ...definition, taskIntake: { ...config, home: undefined } }
    expect(WorkflowDefinitionSchema.safeParse(draft).success).toBe(true)
    expect(routineConfigurationIssues({ definition: draft, trigger: { kind: 'manual' }, contextGroupId: null, contextProjectId: null }))
      .toEqual(['routine_event_trigger_required', 'routine_executor_required', 'routine_home_required'])
    expect(routineConfigurationIssues({ definition: { ...definition, taskIntake: config, defaultExecutor: { kind: 'person', memberId: id } },
      trigger: { kind: 'event', event: { sources: [{ source: { type: 'task' } }] } }, contextGroupId: id, contextProjectId: null })).toEqual([])
  })
  it('rejects a mismatched operating home', () => {
    expect(routineConfigurationIssues({ definition: { ...definition, taskIntake: config, defaultExecutor: { kind: 'assistant', assistantId: id } },
      trigger: { kind: 'event', event: { sources: [{ source: { type: 'task' } }] } }, contextGroupId: null, contextProjectId: null }))
      .toEqual(['routine_home_context_mismatch'])
  })
  it('includes all material fields but ignores presentation layout', () => {
    const input = { definition: { ...definition, taskIntake: config }, trigger: { kind: 'manual' as const }, contextGroupId: id, contextProjectId: null }
    expect(routineConfigurationShape({ ...input, definition: { ...input.definition, layout: { review: { x: 5, y: 9 } } } }))
      .toEqual(routineConfigurationShape(input))
    expect(routineConfigurationShape({ ...input, definition: { ...input.definition, defaultExecutor: { kind: 'person', memberId: id } } }))
      .not.toEqual(routineConfigurationShape(input))
  })
})

const quality: TaskReadinessAssessment = { classification: 'needs_spec', evidenceQuote: null, evidenceVerified: true,
  commitment: 'explicit', objective: 'Prepare a configured case summary', target: null, description: 'Human-configured case summary',
  startingPointKind: 'missing', startingPoint: null, completionSignal: 'Summary saved', missing: ['target', 'starting_point'],
  explanation: 'A required case input is missing.' }
const policy = (q = quality, rules: TaskRuleRecord[] = []) => ({ candidate: { workspaceId: id, title: 'Configured case summary',
  lane: 'extracted' as const, quality: q }, rules, taskMatches: [], tombstoneMatches: [] })
const rule = (effect: TaskRuleRecord['effect'], requirements: TaskRuleRecord['predicate']['require'] = []): TaskRuleRecord =>
  ({ id, workspaceId: id, status: 'active', effect, predicate: { require: requirements }, nlClause: null, reason: null, origin: 'user', createdAt: new Date() })

describe('[COMP:tasks/routine-intake] tracking versus execution qualification', () => {
  it('tracks confirmed partial work without changing its quality or ordinary extraction readiness', () => {
    const qualification = qualifyRoutineTracking(quality, ['case'])
    expect(qualification).toEqual({ kind: 'trackable', execution: 'waiting_for_input', missingInputs: ['case'] })
    expect(evaluateTaskAdmission(policy(), qualification)).toEqual({ outcome: 'allow' })
    expect(evaluateTaskAdmission(policy())).toMatchObject({ outcome: 'hold', reasonCode: 'needs_spec' })
    expect(quality.classification).toBe('needs_spec')
    expect(quality.target).toBeNull()
  })
  it.each(['none', 'hedged', 'implicit'] as const)('refuses %s commitment in the routine exception', commitment => {
    expect(qualifyRoutineTracking({ ...quality, commitment }, ['case'])).toMatchObject({ kind: 'untrackable', reason: 'not_work' })
  })
  it('refuses missing evidence, judge failure and an absent outcome', () => {
    expect(qualifyRoutineTracking({ ...quality, evidenceVerified: false }, ['case'])).toMatchObject({ kind: 'untrackable' })
    expect(qualifyRoutineTracking({ ...quality, evidenceVerified: false, explanation: 'Judge unavailable' }, [])).toMatchObject({ kind: 'untrackable' })
    expect(qualifyRoutineTracking({ ...quality, objective: null }, ['case'])).toMatchObject({ kind: 'untrackable' })
  })
  it.each(['agent_ready', 'resolved_target'] as const)('retains stronger %s tracking requirements', requirement => {
    expect(evaluateTaskAdmission(policy(quality, [rule('require', [requirement])]), qualifyRoutineTracking(quality, ['case'])))
      .toMatchObject({ outcome: 'hold', reasonCode: 'rule_requires' })
  })
  it('retains deny, tombstone, strong and ambiguous duplicate gates', () => {
    const qualification = qualifyRoutineTracking(quality, ['case'])
    expect(evaluateTaskAdmission(policy(quality, [rule('deny')]), qualification)).toMatchObject({ outcome: 'drop', reasonCode: 'rule' })
    expect(evaluateTaskAdmission({ ...policy(), tombstoneMatches: [{ similarity: 1,
      tombstone: { id, workspaceId: id, title: 'Rejected summary', titleNorm: 'rejected summary', reason: 'Not wanted',
        sourceKind: null, lane: null, createdAt: new Date() } }] }, qualification)).toMatchObject({ outcome: 'drop', reasonCode: 'tombstoned' })
    expect(evaluateTaskAdmission({ ...policy(), taskMatches: [{ id, title: 'Summary', similarity: 1 }] }, qualification))
      .toMatchObject({ outcome: 'drop', reasonCode: 'duplicate' })
    expect(evaluateTaskAdmission({ ...policy(), taskMatches: [{ id, title: 'Summary', similarity: 0.7 }] }, qualification))
      .toMatchObject({ outcome: 'hold', reasonCode: 'near_duplicate' })
  })
  it('does not let the specialized policy result turn unverified/non-work into a mandate', () => {
    const qualification = qualifyRoutineTracking(quality, ['case'])
    expect(evaluateTaskAdmission(policy({ ...quality, evidenceVerified: false }), qualification)).toMatchObject({ outcome: 'hold', reasonCode: 'quality_unverified' })
    expect(evaluateTaskAdmission(policy({ ...quality, classification: 'not_a_task' }), qualification)).toMatchObject({ outcome: 'drop', reasonCode: 'not_a_task' })
  })
})
