/**
 * Assistant configuration surface for the workspace goal default budget.
 *
 * [COMP:goals/default-budget]
 */
import { z } from 'zod'
import { buildTool, type Tool } from '../tools/types.js'
import type { GoalDefaultBudget } from './types.js'

export type GoalDefaultBudgetSnapshot = {
  budget: GoalDefaultBudget
  source: 'workspace' | 'built_in'
}

export type SetGoalDefaultBudgetResult =
  | ({ ok: true } & GoalDefaultBudgetSnapshot)
  | {
      ok: false
      reason: 'not_admin' | 'not_found' | 'invalid'
      message: string
    }

export type GoalDefaultBudgetStorePort = {
  get(workspaceId: string): Promise<GoalDefaultBudgetSnapshot>
  set(
    userId: string,
    workspaceId: string,
    patch: {
      maxIterations?: number
      maxSpend?: number
      reset?: boolean
    },
  ): Promise<SetGoalDefaultBudgetResult>
}

const inputSchema = z
  .object({
    max_iterations: z
      .number()
      .int()
      .positive()
      .max(1000)
      .optional()
      .describe('Default hard iteration cap for future budget-less goal kickoffs.'),
    max_spend: z
      .number()
      .positive()
      .optional()
      .describe('Default Brian COGS cap in USD for future budget-less goal kickoffs.'),
    reset: z
      .boolean()
      .optional()
      .describe('True removes the workspace override and restores the built-in default.'),
  })
  .refine(
    (input) => !(input.reset && (input.max_iterations !== undefined || input.max_spend !== undefined)),
    { message: 'reset cannot be combined with max_iterations or max_spend' },
  )

export function createGoalDefaultBudgetTools(store: GoalDefaultBudgetStorePort): {
  configureGoalDefaultBudget: Tool
} {
  const configureGoalDefaultBudget = buildTool({
    name: 'configureGoalDefaultBudget',
    requiresCapability: 'goals',
    description:
      "Read or change this workspace's default budget for future autonomous goals. " +
      'Call with no arguments to read the effective default. Pass max_iterations and/or max_spend to update it. ' +
      'Pass reset=true by itself to restore the built-in default. Explicit limits on an individual goal always win. ' +
      'Changes affect goals that start later, including existing drafts armed later; they never rewrite an already-armed goal. ' +
      'Reading is available to workspace members. Changing or resetting requires a workspace owner or admin.',
    inputSchema,
    isConcurrencySafe: false,
    async execute(input, context) {
      if (!context.workspaceId) {
        return {
          data:
            'This assistant is not bound to a workspace, so there is no workspace goal default budget to read or change. Nothing was changed. Run this from a workspace-scoped chat; retrying here will keep failing.',
          isError: true,
        }
      }

      const wantsWrite =
        input.reset === true
        || input.max_iterations !== undefined
        || input.max_spend !== undefined
      if (!wantsWrite) {
        const current = await store.get(context.workspaceId)
        return {
          data: {
            ...current,
            note:
              current.source === 'built_in'
                ? 'No workspace override is set. These are the built-in defaults.'
                : 'This workspace override is copied onto future budget-less goals at kickoff.',
          },
        }
      }

      const result = await store.set(context.userId, context.workspaceId, {
        maxIterations: input.max_iterations,
        maxSpend: input.max_spend,
        reset: input.reset,
      })
      if (!result.ok) {
        const next =
          result.reason === 'not_admin'
            ? 'Ask a workspace owner or admin to make this change. Retrying as the same member will keep failing.'
            : result.reason === 'not_found'
              ? 'The workspace no longer exists. Do not retry this write.'
              : 'Correct the values before retrying.'
        return { data: `${result.message} Nothing was changed. ${next}`, isError: true }
      }

      return {
        data: {
          budget: result.budget,
          source: result.source,
          note:
            result.source === 'built_in'
              ? 'Reset. Future budget-less goals use the built-in default.'
              : 'Saved. Future budget-less goals use this workspace default; existing armed goals are unchanged.',
        },
      }
    },
  })

  return { configureGoalDefaultBudget }
}
