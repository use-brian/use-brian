/** Scoped deterministic tool-result notifications. [COMP:workflow/tool-delivery] */
import { sanitizeDeliveryText } from '@use-brian/shared'
import type { ScopeEvidence } from '../security/context-scope.js'
import type { DeliveryOutcome, ExecutorDeps } from './executor.js'
import { interpolateString, type InterpolationScope } from './interpolation.js'
import { ToolCallDeliverySchema } from './schemas.js'
import type { ToolCallStep, WorkflowRecord, WorkflowRunRecord } from './types.js'

export async function deliverToolCallNotification(params: {
  step: Pick<ToolCallStep, 'id' | 'deliver' | 'deliveryText'>
  output: unknown
  scope: InterpolationScope
  run: Pick<WorkflowRunRecord, 'id' | 'workspaceId' | 'triggeredBy'>
  workflow: Pick<WorkflowRecord, 'id' | 'createdBy'>
  assistantId: string
  scopeEvidence: ScopeEvidence
  deps: Pick<ExecutorDeps, 'deliverToChannel' | 'abortSignal'>
}): Promise<DeliveryOutcome | undefined> {
  const { step, run, workflow, deps } = params
  if (!step.deliver && step.deliveryText === undefined) return undefined
  const channelType = step.deliver?.channelType ?? 'unknown'
  const target = ToolCallDeliverySchema.safeParse(step.deliver)
  if (!target.success || target.data.channelId === 'current'
    || target.data.channelIntegrationId && !['telegram', 'feishu'].includes(target.data.channelType)
    || typeof step.deliveryText !== 'string' || !step.deliveryText || step.deliveryText.length > 8000) {
    return { status: 'failed', channelType, error: 'Invalid deterministic tool delivery configuration.' }
  }
  // A stopped workflow must not start a new external effect after its tool.
  if (deps.abortSignal?.aborted) return { status: 'skipped', channelType, reason: 'access_denied' }
  const text = sanitizeDeliveryText(interpolateString(step.deliveryText, { ...params.scope, prev: params.output }))
  if (!text.trim()) return { status: 'skipped', channelType, reason: 'empty_text' }
  if (!deps.deliverToChannel) return { status: 'skipped', channelType, reason: 'not_wired' }
  try {
    return await deps.deliverToChannel({
      workspaceId: run.workspaceId, assistantId: params.assistantId,
      userId: run.triggeredBy ?? workflow.createdBy, ...target.data, text,
      scopeEvidence: structuredClone(params.scopeEvidence),
      publication: { runId: run.id, stepId: step.id },
    })
  } catch (error) {
    return { status: 'failed', channelType, error: error instanceof Error ? error.message : String(error) }
  }
}
