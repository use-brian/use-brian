/**
 * Task guardrail tools — the assistant-facing half of the admission gate.
 *
 * Spec: docs/architecture/features/task-guardrails.md
 *
 * Four tools:
 *   rejectTask     — delete a bad task WITH a reason; writes the tombstone that
 *                    stops the class from coming back
 *   saveTaskRule   — compile a spoken policy into a stored predicate
 *   listTaskRules  — read the policy back (including inert `proposed` rules)
 *   deleteTaskRule — remove one
 *
 * WHY `rejectTask` IS NOT `archiveTasks`. Archiving is "this is finished with";
 * rejecting is "this should never have existed, and here is why". Only the
 * second teaches the workspace anything, so only the second writes a tombstone.
 * Keeping them as separate verbs is what stops routine cleanup from silently
 * training suppression rules.
 *
 * WHY THE MODEL COMPILES THE PREDICATE. `saveTaskRule` takes BOTH a structured
 * `when` and the user's own sentence. The model does the compiling once, at
 * authoring time, so the stored row is something the user can read and toggle
 * in Studio — rather than a sentence re-interpreted by an LLM on every
 * admission check, which would be neither cheap nor stable.
 *
 * [COMP:tasks/guardrail-tools]
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../tools/types.js'
import { tolerantBoolean } from '../tools/schema-tolerance.js'
import {
  validateRulePredicate,
  type TaskLane,
  type TaskRuleEffect,
  type TaskRulePredicate,
  type TaskRuleRecord,
  type TaskRuleStatus,
} from './admission.js'

const idShape = z.string().uuid()

/** DB operations the guardrail tools need. Implemented in `packages/api/src/db`. */
export type TaskGuardrailStore = {
  /**
   * Soft-delete the task and write the tombstone in one transaction, then run
   * the proposal check. Returns null when the id resolves to nothing the caller
   * may see (RLS-hidden, wrong workspace, already deleted) — the tool cannot
   * distinguish those, and should not.
   */
  rejectTask(input: {
    workspaceId: string
    userId: string
    taskId: string
    reason: string
  }): Promise<{
    title: string
    tombstoneId: string
    /** Set when this rejection tipped a cluster over PROPOSAL_THRESHOLD. */
    proposedRuleId: string | null
    proposedRuleClause: string | null
  } | null>

  createRule(input: {
    workspaceId: string
    userId: string
    effect: TaskRuleEffect
    predicate: TaskRulePredicate
    nlClause: string | null
    reason: string | null
    status: TaskRuleStatus
  }): Promise<TaskRuleRecord>

  listRules(input: {
    workspaceId: string
    includeDisabled: boolean
  }): Promise<TaskRuleRecord[]>

  deleteRule(input: { workspaceId: string; ruleId: string }): Promise<boolean>
}

export type TaskGuardrailToolOptions = {
  onEvent?: (
    event: { type: 'task_rejected'; taskId: string } | { type: 'task_rule_saved'; ruleId: string },
    ctx: { userId: string; assistantId: string; workspaceId: string },
  ) => void
}

function workspaceGate(
  workspaceId: string | null | undefined,
): { data: string; isError: true } | null {
  if (!workspaceId) {
    return {
      data: 'Task guardrails require a workspace. This assistant is not bound to one.',
      isError: true,
    }
  }
  return null
}

const laneEnum = z.enum(['extracted', 'assistant'])

/**
 * The `when` predicate, described for the model. Every field is optional and
 * they AND together — the descriptions carry the semantics because a model
 * writing a rule from one sentence of user speech has no other reference.
 */
const predicateShape = z.object({
  source_kinds: z
    .array(z.string().min(1).max(64))
    .max(10)
    .optional()
    .describe(
      'Episode source kinds this rule applies to, e.g. ["slack_thread"], ["web_chat"], ["recording"]. Omit to apply to every source.',
    ),
  lanes: z
    .array(laneEnum)
    .max(2)
    .optional()
    .describe(
      'Which write path: "extracted" (tasks the brain mined from ingested content) or "assistant" (tasks created by a tool call in a conversation). Omit to apply to both. Use ["extracted"] for "stop mining tasks out of my Slack" — it leaves explicit requests working.',
    ),
  title_matches: z
    .array(z.string().min(2).max(120))
    .max(10)
    .optional()
    .describe(
      'Case-insensitive substrings tested against the task title; ANY match counts. Use content words, not whole sentences — "standup" not "revise the daily standup workflow".',
    ),
  channel_refs: z
    .array(z.string().min(1).max(128))
    .max(20)
    .optional()
    .describe('Channel ids the rule is scoped to (e.g. a Slack channel id). Omit for all channels.'),
  require: z
    .array(
      z.enum([
        'assignee',
        'due',
        'description',
        'resolved_target',
        'explicit_commitment',
        'completion_signal',
        'agent_ready',
      ]),
    )
    .max(7)
    .optional()
    .describe('For effect "require" only: operational or readiness facts a task must have. Anything missing them is held for review instead of created. The core automatic-ingestion agent-readiness floor cannot be relaxed.'),
})

export function createTaskGuardrailTools(
  store: TaskGuardrailStore,
  opts?: TaskGuardrailToolOptions,
): {
  rejectTask: Tool
  saveTaskRule: Tool
  listTaskRules: Tool
  deleteTaskRule: Tool
} {
  const rejectTask = buildTool({
    name: 'rejectTask',
    requiresCapability: 'tasks',
    description:
      'Delete a task that should never have been created, recording WHY. Use this — not `archiveTasks` — when the user says a task is noise, a duplicate, a misunderstanding, or was never a real work item. ' +
      'The reason is durable: near-identical tasks stop being created in this workspace from now on, and after several similar rejections the workspace is offered a standing rule. ' +
      'Use `closeTask` for work that is finished and `archiveTasks` for routine cleanup of real tasks — neither of those teaches anything, and neither should.',
    inputSchema: z.object({
      id: idShape.describe('The task to reject.'),
      reason: z
        .string()
        .min(3)
        .max(500)
        .describe(
          'Why this was not a real task, in the user\'s own terms where possible (e.g. "this was me giving you an instruction, not a work item", "duplicate of the standup task"). This text is shown back to the extractor as a negative example, so a vague reason teaches a vague lesson.',
        ),
    }),
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      const result = await store.rejectTask({
        workspaceId: context.workspaceId!,
        userId: context.userId,
        taskId: input.id,
        reason: input.reason,
      })
      if (!result) {
        return { data: `No live task found with id ${input.id}.`, isError: true }
      }

      opts?.onEvent?.(
        { type: 'task_rejected', taskId: input.id },
        { userId: context.userId, assistantId: context.assistantId, workspaceId: context.workspaceId! },
      )

      const lines = [
        `Rejected and deleted "${result.title}". Similar tasks will no longer be created in this workspace.`,
      ]
      if (result.proposedRuleClause) {
        lines.push(
          `That is the third rejection of this kind, so a standing rule is now proposed: "${result.proposedRuleClause}". It is NOT active yet — ask the user whether to turn it on, then activate it with saveTaskRule or from Studio.`,
        )
      }
      return { data: lines.join(' ') }
    },
  })

  const saveTaskRule = buildTool({
    name: 'saveTaskRule',
    requiresCapability: 'tasks',
    description:
      'Record a standing rule about when tasks may be created in this workspace. Use when the user states a policy ("stop making tasks out of standup chatter", "never create a task without an owner", "no tasks from the #random channel"). ' +
      'Pass BOTH `when` (the machine-checkable conditions) and `nl_clause` (the user\'s sentence). The conditions are enforced exactly; the sentence is additionally shown to the extractor, which is the only enforcement a rule gets when it cannot be reduced to conditions. ' +
      'If a policy is genuinely fuzzy ("only things I actually committed to"), still pass it as `nl_clause` with the narrowest honest `when` you can — and tell the user it is best-effort guidance rather than a hard block.',
    inputSchema: z.object({
      effect: z
        .enum(['deny', 'require'])
        .describe(
          '"deny" blocks matching tasks outright. "require" holds matching tasks for review until they have the fields listed in `when.require`.',
        ),
      when: predicateShape.describe(
        'Conditions, ANDed together. A "deny" rule needs at least one of source_kinds / lanes / title_matches / channel_refs — an empty condition set would block every task in the workspace and is rejected.',
      ),
      nl_clause: z
        .string()
        .min(3)
        .max(300)
        .optional()
        .describe('The user\'s own phrasing of the rule. Shown in Studio and to the extractor.'),
      reason: z.string().max(500).optional().describe('Why the rule exists, if the user gave a reason.'),
      activate: tolerantBoolean()
        .optional()
        .describe('Defaults to true. Pass false to save the rule without enforcing it yet.'),
    }),
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      const predicate = input.when as TaskRulePredicate
      const invalid = validateRulePredicate(input.effect, predicate)
      if (invalid) return { data: invalid, isError: true }

      const rule = await store.createRule({
        workspaceId: context.workspaceId!,
        userId: context.userId,
        effect: input.effect,
        predicate,
        nlClause: input.nl_clause ?? null,
        reason: input.reason ?? null,
        status: input.activate === false ? 'disabled' : 'active',
      })

      opts?.onEvent?.(
        { type: 'task_rule_saved', ruleId: rule.id },
        { userId: context.userId, assistantId: context.assistantId, workspaceId: context.workspaceId! },
      )

      return {
        data: `Saved task rule [${rule.id}] (${rule.effect}, ${rule.status}): ${
          rule.nlClause ?? describePredicate(rule.predicate)
        }`,
      }
    },
  })

  const listTaskRules = buildTool({
    name: 'listTaskRules',
    requiresCapability: 'tasks',
    isReadOnly: true,
    isConcurrencySafe: true,
    description:
      'List this workspace\'s task-creation rules, including ones that are only PROPOSED (suggested after repeated rejections and not yet enforcing). Use before saving a new rule to avoid restating one that already exists, and when the user asks why a task was or was not created.',
    inputSchema: z.object({
      include_disabled: tolerantBoolean()
        .optional()
        .describe('Include rules the user has switched off. Defaults to false.'),
    }),
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      const rules = await store.listRules({
        workspaceId: context.workspaceId!,
        includeDisabled: input.include_disabled === true,
      })
      if (rules.length === 0) {
        return { data: 'No task rules in this workspace. Duplicate suppression still applies — it is always on.' }
      }
      return {
        data: rules
          .map(
            (r) =>
              `[${r.id}] ${r.status}/${r.effect}: ${r.nlClause ?? describePredicate(r.predicate)}${
                r.status === 'proposed' ? ' (proposed — not enforcing until activated)' : ''
              }`,
          )
          .join('\n'),
      }
    },
  })

  const deleteTaskRule = buildTool({
    name: 'deleteTaskRule',
    requiresCapability: 'tasks',
    description:
      'Delete a task-creation rule. Use when the user says a rule is wrong or too broad — for example after it blocked something they wanted. Rules are cheap to restate, so this is a hard delete rather than a soft one.',
    inputSchema: z.object({ id: idShape }),
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      const deleted = await store.deleteRule({
        workspaceId: context.workspaceId!,
        ruleId: input.id,
      })
      return deleted
        ? { data: `Deleted task rule [${input.id}].` }
        : { data: `No task rule found with id ${input.id}.`, isError: true }
    },
  })

  return { rejectTask, saveTaskRule, listTaskRules, deleteTaskRule }
}

/** Fallback description for a rule the user never phrased in words. */
function describePredicate(p: TaskRulePredicate): string {
  const parts: string[] = []
  if (p.source_kinds?.length) parts.push(`source in ${p.source_kinds.join('/')}`)
  if (p.lanes?.length) parts.push(`lane in ${(p.lanes as TaskLane[]).join('/')}`)
  if (p.title_matches?.length) parts.push(`title contains ${p.title_matches.join(' or ')}`)
  if (p.channel_refs?.length) parts.push(`channel in ${p.channel_refs.join('/')}`)
  if (p.require?.length) parts.push(`must have ${p.require.join(' + ')}`)
  return parts.length > 0 ? parts.join(', ') : 'all tasks'
}
