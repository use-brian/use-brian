/**
 * Execution planner: proposes the plan an assigned assistant would follow.
 *
 * The plan is a PROPOSAL. Readiness is computed afterwards by
 * `assessExecutionReadiness` against the assistant's actual manifest, so a
 * confident plan naming an operation the assistant does not have is caught
 * there, never trusted here. The manifest's tool names are passed per call
 * (dynamic context, never a static prompt list), and the planner is asked to
 * name only tools from it.
 *
 * Fail-CLOSED: a model error or an unparseable plan returns null, which the
 * qualifier records as "not ready" rather than arming anything.
 *
 * [COMP:goals/execution-qualification]
 */
import { z } from 'zod'
import { collectStream } from '../providers/accumulator.js'
import type { LLMProvider, TokenUsage } from '../providers/types.js'
import type { GoalLlmRuntime, GoalLlmUsageContext } from './clarity.js'
import type { ExecutionPlanDraft } from './execution.js'

const PLANNER_SYSTEM_PROMPT = [
  'You plan work an assistant has been assigned. Use ONLY the request and sources you are given; do not invent scope.',
  'Return the outcome, constraints, a few useful steps, and the concrete completion evidence that would prove the outcome (for example a sent message id or a published page), never "the task is marked done".',
  'List every operation the plan needs in requiredOperations, using ONLY names from AVAILABLE OPERATIONS. If the plan needs something that is not available, name it anyway so it can be reported as missing.',
  'List connected accounts the plan needs in requiredAccounts, inputs the request does not yet provide in requiredInputs with provided=false, and any consequential question you cannot answer from the sources in questions.',
  'Respond with ONLY a JSON object: {"outcome": string, "constraints": string[], "steps": [{"title": string, "contribution": string}], "completionEvidence": string[], "requiredOperations": string[], "requiredAccounts": string[], "requiredInputs": [{"name": string, "provided": boolean}], "questions": string[]}.',
].join('\n')

const planSchema = z.object({
  outcome: z.string().trim().min(1).max(2000),
  constraints: z.array(z.string().max(500)).max(20).default([]),
  steps: z.array(z.object({ title: z.string().min(1).max(300), contribution: z.string().max(500).default('') })).max(20).default([]),
  completionEvidence: z.array(z.string().min(1).max(300)).max(10).default([]),
  requiredOperations: z.array(z.string().min(1).max(120)).max(30).default([]),
  requiredAccounts: z.array(z.string().min(1).max(120)).max(10).default([]),
  requiredInputs: z.array(z.object({ name: z.string().min(1).max(300), provided: z.boolean() })).max(10).default([]),
  questions: z.array(z.string().min(1).max(500)).max(5).default([]),
})

/** Parse a planner response. Anything not a valid plan is null (fail-closed). */
export function parseExecutionPlan(text: string): ExecutionPlanDraft | null {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const parsed = planSchema.safeParse(JSON.parse(match[0]))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export type ExecutionPlannerInput = {
  title: string
  context: string
  manifestTools: string[]
  userId: string
  workspaceId: string
  assistantId: string
}

export function createExecutionPlanner(deps: {
  provider: LLMProvider
  model: string
  modelTier: string
  onUsage?: (usage: TokenUsage, context: GoalLlmUsageContext) => void
  resolveLlm: ((workspaceId: string) => Promise<GoalLlmRuntime | null>) | null
}): (input: ExecutionPlannerInput) => Promise<ExecutionPlanDraft | null> {
  return async (input) => {
    try {
      const runtime = deps.resolveLlm ? await deps.resolveLlm(input.workspaceId) : null
      const content = [
        `REQUEST AND SOURCES:\n${input.context}`,
        `AVAILABLE OPERATIONS: ${input.manifestTools.join(', ') || '(none)'}`,
      ].join('\n\n')
      const response = await collectStream((runtime?.provider ?? deps.provider).stream({
        model: runtime?.model ?? deps.model,
        systemPrompt: PLANNER_SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
        maxTokens: Math.min(1200, runtime?.maxTokens ?? 1200),
        inputTokenLimit: runtime?.inputTokenLimit,
        temperature: 0.1,
      }))
      if (response.usage) deps.onUsage?.(response.usage, {
        userId: input.userId, workspaceId: input.workspaceId, assistantId: input.assistantId,
        model: response.model || runtime?.model || deps.model, modelTier: runtime?.modelTier ?? deps.modelTier,
        providerKeySource: runtime?.providerKeySource ?? 'platform',
      })
      return parseExecutionPlan(response.content.map(b => (b.type === 'text' ? b.text : '')).join(''))
    } catch (err) {
      console.error('[execution-planner] planning failed; the task stays unarmed:', err)
      return null
    }
  }
}
