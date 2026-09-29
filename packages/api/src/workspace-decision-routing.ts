/**
 * Resolve a workspace's persisted classifier choice into a safe decision
 * route. Hybrid authority is granted only by an exact approved profile.
 *
 * [COMP:decisions/workspace-routing]
 */
import { isDecisionModelRow, registryRow } from '@use-brian/shared/model-registry'
import type { WorkspaceDecisionRoutingStore } from './db/workspace-decision-routing.js'
import type { DecisionEvaluationProfileStore } from './db/decision-evaluation-profiles.js'
import type {
  DecisionRouteConfig,
  DecisionRouteContext,
  DecisionRouteResolver,
} from './decision-runtime.js'

export const WORKSPACE_DECISION_SHADOW_SAMPLE_RATE = 0.1
export const WORKSPACE_DECISION_PRIMARY_TIMEOUT_MS = 1_000
export const WORKSPACE_DECISION_TOTAL_TIMEOUT_MS = 120_000

export type OperatorDecisionDefault = {
  mode: 'operator_hybrid'
  modelAlias: string
}

export function parseOperatorDecisionDefault(
  modeValue: string | undefined,
  modelValue: string | undefined,
): OperatorDecisionDefault | undefined {
  const mode = modeValue?.trim()
  const modelAlias = modelValue?.trim()
  if (!mode && !modelAlias) return undefined
  if (mode !== 'operator_hybrid' || !modelAlias) {
    throw new Error(
      'decision-routing: DECISION_DEFAULT_MODE=operator_hybrid and DECISION_DEFAULT_MODEL are required together',
    )
  }
  const row = registryRow(modelAlias)
  if (!row || row.status !== 'active' || !isDecisionModelRow(row)) {
    throw new Error(`decision-routing: operator default '${modelAlias}' is not an active decision model`)
  }
  return { mode, modelAlias: row.alias }
}

export function createWorkspaceDecisionRouteResolver(options: {
  store: Pick<WorkspaceDecisionRoutingStore, 'getSystem'>
  profileStore?: Pick<DecisionEvaluationProfileStore, 'getApprovedExact'>
  configuredAdapterIds: () => readonly string[]
  operatorDefault?: OperatorDecisionDefault
  fallback?: DecisionRouteResolver
  onError?: (error: unknown, context: DecisionRouteContext) => void
}): DecisionRouteResolver {
  return async (context) => {
    if (!context.workspaceId) return options.fallback?.(context) ?? { mode: 'llm_only' }

    try {
      const setting = await options.store.getSystem(context.workspaceId)
      if (!setting && options.operatorDefault) {
        const row = registryRow(options.operatorDefault.modelAlias)
        if (
          !row ||
          row.status !== 'active' ||
          !isDecisionModelRow(row) ||
          !options.configuredAdapterIds().includes(row.decisionCapabilities.adapterId)
        ) {
          return { mode: 'llm_only' }
        }
        const profileBase = {
          id: `operator-default:${row.alias}:${context.operation.id}`,
          version: '1',
          operationId: context.operation.id,
          operationVersion: context.operation.version,
          stateVersion: context.operation.stateVersion,
          questionVersion: context.operation.questionVersion,
          modelCatalogId: row.alias,
          modelWireId: row.decisionCapabilities.wireModelId,
          evaluationSegment: context.evaluationSegment,
          status: 'operator_override' as const,
          evidence: 'operator_override' as const,
          totalTimeoutMs: WORKSPACE_DECISION_TOTAL_TIMEOUT_MS,
          primaryTimeoutMs: WORKSPACE_DECISION_PRIMARY_TIMEOUT_MS,
          maxAttempts: 2 as const,
          policy: { authority: 'deployment_operator_override' },
        }
        if (context.kind === 'observation') {
          return {
            mode: 'shadow',
            primaryModelId: row.alias,
            profile: {
              ...profileBase,
              mode: 'shadow',
              shadowSampleRate: 1,
            },
          }
        }
        return {
          mode: 'hybrid',
          primaryModelId: row.alias,
          profile: { ...profileBase, mode: 'hybrid' },
          allowOperationalFailover: true,
          allowInvalidResponseRecovery: true,
          operatorOverride: true,
        }
      }
      if (!setting) return options.fallback?.(context) ?? { mode: 'llm_only' }
      if (setting.mode === 'llm_only' || !setting.modelAlias) return { mode: 'llm_only' }

      const row = registryRow(setting.modelAlias)
      if (
        !row ||
        row.status !== 'active' ||
        !isDecisionModelRow(row) ||
        !options.configuredAdapterIds().includes(row.decisionCapabilities.adapterId)
      ) {
        return { mode: 'llm_only' }
      }

      const shadowRoute = (): DecisionRouteConfig => ({
        mode: 'shadow',
        primaryModelId: row.alias,
        profile: {
          id: `workspace-shadow:${row.alias}:${context.operation.id}`,
          version: '1',
          mode: 'shadow',
          operationId: context.operation.id,
          operationVersion: context.operation.version,
          stateVersion: context.operation.stateVersion,
          questionVersion: context.operation.questionVersion,
          modelCatalogId: row.alias,
          modelWireId: row.decisionCapabilities.wireModelId,
          evaluationSegment: context.evaluationSegment,
          status: 'evaluation',
          evidence: 'synthetic',
          totalTimeoutMs: WORKSPACE_DECISION_TOTAL_TIMEOUT_MS,
          primaryTimeoutMs: WORKSPACE_DECISION_PRIMARY_TIMEOUT_MS,
          maxAttempts: 2,
          shadowSampleRate: WORKSPACE_DECISION_SHADOW_SAMPLE_RATE,
        },
      })

      if (setting.mode !== 'hybrid' || context.kind === 'observation' || !options.profileStore) {
        return shadowRoute()
      }

      try {
        const profile = await options.profileStore.getApprovedExact({
          operation: context.operation,
          modelCatalogId: row.alias,
          modelWireId: row.decisionCapabilities.wireModelId,
          evaluationSegment: context.evaluationSegment,
        })
        if (!profile) return shadowRoute()
        return {
          mode: 'hybrid',
          primaryModelId: row.alias,
          profile,
        }
      } catch (error) {
        options.onError?.(error, context)
        return shadowRoute()
      }
    } catch (error) {
      options.onError?.(error, context)
      return { mode: 'llm_only' }
    }
  }
}
