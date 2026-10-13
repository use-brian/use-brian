/**
 * Brian tools for saved research (docs/architecture/features/research.md ->
 * "Commands"). Thin adapters over commands.ts: the same service, authority
 * and typed errors as the REST routes and the brain MCP. A Brian turn conveys
 * a person's intent only when an attended member sent it; otherwise the
 * assistant acts as itself and cannot correct, nominate, record or approve.
 *
 * [COMP:api/research-commands]
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { buildTool, type Tool, type ToolContext } from '@use-brian/core'
import * as research from './commands.js'

export function researchActorFromTool(context: ToolContext): research.ResearchActor {
  if (context.programmaticPrincipal) return { userId: context.userId, kind: 'credential', human: false, origin: 'mcp' }
  const human = context.attended === true && !!context.workspaceActorUserId
  return human
    ? { userId: context.workspaceActorUserId!, kind: 'user', human: true, origin: 'chat' }
    : { userId: context.userId, kind: 'assistant', human: false, origin: 'chat' }
}

const key = (context: ToolContext, ...parts: unknown[]) =>
  createHash('sha256').update([context.sessionId, ...parts.map((p) => JSON.stringify(p))].join('\u0000')).digest('hex').slice(0, 48)

const COPY: Record<research.ResearchErrorCode, string> = {
  research_not_found: 'Nothing you can see matches that id. Nothing was changed.',
  research_forbidden: 'You are not allowed to do this here (only the member, the Project owner, or a workspace owner acting directly may). Nothing was changed; retrying will be refused the same way.',
  research_stale: 'Not applied: it changed since you read it. Read it again and use the current version.',
  research_invalid: 'The request was invalid. Nothing was changed.',
}

async function run(context: ToolContext, work: (actor: research.ResearchActor, workspaceId: string) => Promise<unknown>) {
  if (!context.workspaceId) return { data: 'Research records need a workspace-scoped conversation. Nothing was read or changed.', isError: true as const }
  try {
    return { data: await work(researchActorFromTool(context), context.workspaceId) as object }
  } catch (error) {
    if (error instanceof research.ResearchCommandError) {
      return { data: `${COPY[error.code]}${error.detail && error.code === 'research_invalid' ? ` (${error.detail})` : ''}`, isError: true as const }
    }
    throw error
  }
}

export function createResearchTools(): Record<
  'listResearchActivities' | 'getResearchActivity' | 'correctResearchFeedback' | 'decideResearchLesson' | 'nominateResearchImprovement' | 'getResearchImprovement' | 'recordResearchComparison',
  Tool
> {
  const listResearchActivities = buildTool({
    name: 'listResearchActivities',
    isReadOnly: true,
    isConcurrencySafe: true,
    description: 'List saved research results you can see (newest first): status, saved artifact, Project and date. Filter by session_id or project_id. Use it to continue earlier research without asking the person to paste it again.',
    inputSchema: z.object({ session_id: z.string().uuid().optional(), project_id: z.string().uuid().optional(), limit: z.number().int().min(1).max(50).optional() }),
    execute: (input, context) => run(context, (actor, ws) => research.listActivities(actor, ws, { sessionId: input.session_id, projectId: input.project_id, limit: input.limit })),
  })

  const getResearchActivity = buildTool({
    name: 'getResearchActivity',
    isReadOnly: true,
    isConcurrencySafe: true,
    description: 'Read one saved research result: its saved artifacts, sources (read vs only found), gaps, follow-ups with their current label and version, and the lessons they support. Open the artifact itself with the page or document tools.',
    inputSchema: z.object({ activity_id: z.string().uuid() }),
    execute: (input, context) => run(context, (actor, ws) => research.getActivity(actor, ws, input.activity_id)),
  })

  const correctResearchFeedback = buildTool({
    name: 'correctResearchFeedback',
    isReadOnly: false,
    description: 'Correct how a research follow-up was understood, on behalf of the person who sent this message. Their own follow-up gets the new label; someone else\'s follow-up only records their disagreement. Pass feedback_id, kind and expected_version from getResearchActivity.',
    inputSchema: z.object({
      feedback_id: z.string().uuid(),
      kind: z.enum(['correction', 'request_correction', 'missing_coverage', 'preference', 'deeper_exploration', 'changed_objective', 'satisfaction', 'uncertain']),
      note: z.string().trim().max(1000).optional(),
      expected_version: z.number().int().positive(),
    }),
    execute: (input, context) => run(context, (actor, ws) => research.correctFeedback(actor, ws, input.feedback_id, {
      kind: input.kind, note: input.note ?? null, expectedVersion: input.expected_version, idempotencyKey: key(context, input),
    })),
  })

  const decideResearchLesson = buildTool({
    name: 'decideResearchLesson',
    isReadOnly: false,
    description: 'Approve, reject or retire a learned research lesson on behalf of the person who sent this message. Personal lessons belong to their member, Project lessons to a Project owner, and company methods to a workspace owner acting directly. Pass lesson_id and expected_version.',
    inputSchema: z.object({ lesson_id: z.string().uuid(), decision: z.enum(['approve', 'reject', 'retire']), expected_version: z.number().int().positive() }),
    execute: (input, context) => run(context, (actor, ws) => research.decideLesson(actor, ws, input.lesson_id, {
      decision: input.decision, expectedVersion: input.expected_version, idempotencyKey: key(context, input),
    })),
  })

  const nominateResearchImprovement = buildTool({
    name: 'nominateResearchImprovement',
    isReadOnly: false,
    description: 'Nominate a generic research improvement candidate from a recurring failure: a short title, the observed pattern in generic terms (no names or private details), the desired behavior, and optional feedback/activity ids and a task_id for the engineering work. It records evidence; it does not change the engine.',
    inputSchema: z.object({
      title: z.string().trim().min(3).max(200),
      pattern: z.string().trim().min(3).max(2000),
      desired_behavior: z.string().trim().min(3).max(2000),
      feedback_ids: z.array(z.string().uuid()).max(50).optional(),
      activity_ids: z.array(z.string().uuid()).max(50).optional(),
      task_id: z.string().uuid().optional(),
    }),
    execute: (input, context) => run(context, (actor, ws) => research.nominateImprovement(actor, ws, {
      title: input.title, pattern: input.pattern, desiredBehavior: input.desired_behavior, feedbackIds: input.feedback_ids ?? [],
      activityIds: input.activity_ids ?? [], taskId: input.task_id ?? null, idempotencyKey: key(context, input),
    })),
  })

  const getResearchImprovement = buildTool({
    name: 'getResearchImprovement',
    isReadOnly: true,
    isConcurrencySafe: true,
    description: 'Read research improvement candidates. With improvement_id: the pattern, desired behavior, linked task, evidence you can see, and recorded comparisons (locally verified vs externally reported). Without it: the list.',
    inputSchema: z.object({ improvement_id: z.string().uuid().optional() }),
    execute: (input, context) => run(context, (actor, ws) => input.improvement_id
      ? research.getImprovement(actor, ws, input.improvement_id) : research.listImprovements(actor, ws)),
  })

  const recordResearchComparison = buildTool({
    name: 'recordResearchComparison',
    isReadOnly: false,
    description: 'Record an engine comparison on an improvement candidate. A `traces` bundle (manifest, baseline, candidate) is recomputed and stored as locally verified; a `reported` bundle is stored as externally reported. It never installs or releases anything.',
    inputSchema: z.object({ improvement_id: z.string().uuid(), bundle: z.record(z.string(), z.unknown()) }),
    execute: (input, context) => run(context, (actor, ws) => research.recordComparison(actor, ws, input.improvement_id, {
      bundle: input.bundle, idempotencyKey: key(context, input),
    })),
  })

  return { listResearchActivities, getResearchActivity, correctResearchFeedback, decideResearchLesson, nominateResearchImprovement, getResearchImprovement, recordResearchComparison }
}
