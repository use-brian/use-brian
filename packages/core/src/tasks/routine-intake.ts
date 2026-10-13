/** Configured routine contracts. This module grants no authoring or intake authority.
 * Spec: docs/architecture/features/routine-work-intake.md
 * [COMP:tasks/routine-intake]
 */
import { z } from 'zod'
import type { WorkflowDefinition, WorkflowTrigger } from '../workflow/types.js'

const bindingPath = z.string().max(200).regex(/^event\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/)
  .refine(path => !path.split('.').some(key => ['__proto__', 'prototype', 'constructor'].includes(key)),
    'Input bindings cannot read prototype properties.')

export const RoutineTaskIntakeSchema = z.object({
  version: z.literal(1),
  blueprint: z.object({
    outcome: z.string().trim().min(1).max(512),
    description: z.string().trim().min(1).max(10000),
    completionCheck: z.string().trim().min(1).max(2000),
    inputs: z.array(z.object({
      key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
      label: z.string().trim().min(1).max(200),
      path: bindingPath,
      required: z.boolean(),
    }).strict()).max(40),
  }).strict(),
  home: z.object({ kind: z.enum(['department', 'project']), id: z.string().uuid() }).strict().optional(),
  permittedActions: z.array(z.string().trim().min(1).max(200)).max(100),
  requiredAccounts: z.array(z.string().trim().min(1).max(200)).max(100),
}).strict().superRefine((config, ctx) => {
  const keys = new Set<string>()
  config.blueprint.inputs.forEach((input, index) => {
    if (keys.has(input.key)) ctx.addIssue({ code: z.ZodIssueCode.custom,
      path: ['blueprint', 'inputs', index, 'key'], message: 'Input keys must be distinct.' })
    keys.add(input.key)
  })
})

export type RoutineTaskIntake = z.infer<typeof RoutineTaskIntakeSchema>

/** Activation preflight, separate from draft shape validation. */
export function routineConfigurationIssues(input: {
  definition: WorkflowDefinition
  trigger: WorkflowTrigger
  contextGroupId: string | null
  contextProjectId: string | null
}): string[] {
  const config = input.definition.taskIntake
  if (!config) return []
  const issues: string[] = []
  if (input.trigger.kind !== 'event') issues.push('routine_event_trigger_required')
  if (!input.definition.defaultExecutor) issues.push('routine_executor_required')
  if (input.definition.principal) issues.push('routine_external_principal_unsupported')
  if (!config.home) issues.push('routine_home_required')
  else if (config.home.kind === 'project' ? config.home.id !== input.contextProjectId : config.home.id !== input.contextGroupId) {
    issues.push('routine_home_context_mismatch')
  }
  return issues
}

/** Material native configuration. Canvas coordinates carry no mandate. */
export function routineConfigurationShape(input: {
  definition: WorkflowDefinition
  trigger: WorkflowTrigger
  contextGroupId: string | null
  contextProjectId: string | null
}) {
  const { layout: _layout, ...definition } = input.definition
  return { definition, trigger: input.trigger, contextGroupId: input.contextGroupId, contextProjectId: input.contextProjectId }
}

/** Resolve ONLY own properties of the admitted event, never model-global state. */
export function readRoutineInput(input: unknown, path: string): unknown {
  if (!bindingPath.safeParse(path).success) return undefined
  let value = input
  for (const key of path.split('.')) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined
    value = (value as Record<string, unknown>)[key]
  }
  return value
}
