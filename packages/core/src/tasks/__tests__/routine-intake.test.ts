import { describe, expect, it } from 'vitest'
import { RoutineTaskIntakeSchema, readRoutineInput, routineConfigurationIssues, routineConfigurationShape } from '../routine-intake.js'
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
