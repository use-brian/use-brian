/**
 * The one research command service behind REST, Brian tools and the brain
 * MCP (docs/architecture/features/research.md -> "Commands").
 *
 * Every read resolves through the actor's own access; every mutation takes a
 * validated target id, `expectedVersion` and `idempotencyKey`. Errors are
 * typed (`research_not_found` 404, `research_forbidden` 403, `research_stale`
 * 409, `research_invalid` 400) so every surface fails the same way.
 *
 * [COMP:api/research-commands]
 */
import { z } from 'zod'
import {
  researchFeedbackCorrectionSchema,
  researchImprovementNominationSchema,
  researchLessonDecisionSchema,
} from '@use-brian/core'
import {
  appendResearchFeedbackRevisionSystem,
  getResearchActivityForViewer,
  getResearchFeedbackForViewer,
  getResearchImprovementForViewer,
  insertResearchComparisonSystem,
  insertResearchImprovementSystem,
  listResearchActivitiesForViewer,
  listResearchImprovementsForViewer,
  ResearchStaleError,
  ResearchNotFoundError,
  taskReadableForViewer,
  type ResearchSensitivity,
} from '../db/research-store.js'
import { notifyWorkspaceChange } from '../brain-stream/notify.js'
import { compareResearchTraces, researchComparisonBundleSchema, ResearchComparisonError } from '../evals/research/comparison.js'
import {
  decideResearchLessonSystem,
  lessonSupportIds,
  listResearchLessonsForViewer,
  ResearchLessonError,
  revalidateResearchLessons,
  type ResearchLesson,
} from './learning.js'

export type ResearchActor = {
  userId: string
  /** `user` = a member acting directly or through Brian on their attended instruction. */
  kind: 'user' | 'assistant' | 'credential'
  human: boolean
  origin: 'ui' | 'chat' | 'mcp'
}

export type ResearchErrorCode = 'research_not_found' | 'research_forbidden' | 'research_stale' | 'research_invalid'

export class ResearchCommandError extends Error {
  constructor(readonly code: ResearchErrorCode, readonly status: number, readonly detail?: string) { super(detail ?? code) }
}

const notFound = () => new ResearchCommandError('research_not_found', 404)
const RANK: Record<ResearchSensitivity, number> = { public: 0, internal: 1, confidential: 2 }
const uuid = z.string().uuid()

function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new ResearchCommandError('research_invalid', 400, parsed.error.issues.map((i) => i.message).join('; '))
  return parsed.data
}

function id(value: unknown): string {
  if (!uuid.safeParse(value).success) throw notFound()
  return value as string
}

function translate(error: unknown): never {
  if (error instanceof ResearchCommandError) throw error
  if (error instanceof ResearchLessonError) throw new ResearchCommandError(error.code, error.status)
  if (error instanceof ResearchStaleError) throw new ResearchCommandError('research_stale', 409)
  if (error instanceof ResearchNotFoundError) throw notFound()
  if (error instanceof ResearchComparisonError) throw new ResearchCommandError('research_invalid', 400, error.reason)
  throw error
}

export async function listActivities(actor: ResearchActor, workspaceId: string, filter: { sessionId?: string | null; projectId?: string | null; limit?: number } = {}) {
  return { activities: await listResearchActivitiesForViewer(actor.userId, id(workspaceId), filter) }
}

/** Activity detail plus the lessons its follow-ups support that the viewer may see. */
export async function getActivity(actor: ResearchActor, workspaceId: string, activityId: string) {
  const detail = await getResearchActivityForViewer(actor.userId, id(workspaceId), id(activityId))
  if (!detail) throw notFound()
  const feedbackIds = new Set(detail.feedback.map((f) => f.id))
  const lessons: Array<ResearchLesson & { supportCount: number }> = []
  if (feedbackIds.size) {
    for (const lesson of await listResearchLessonsForViewer(workspaceId, actor.userId)) {
      const support = await lessonSupportIds(lesson.id)
      if (support.some((s) => feedbackIds.has(s))) lessons.push({ ...lesson, supportCount: support.length })
    }
  }
  return { ...detail, lessons }
}

export async function listLessons(actor: ResearchActor, workspaceId: string, filter: { projectId?: string | null } = {}) {
  return { lessons: await listResearchLessonsForViewer(id(workspaceId), actor.userId, filter) }
}

/**
 * Correct a follow-up's label. The original member rewrites the
 * interpretation; another admitted participant can only add a disagreement.
 * An assistant acting on its own can do neither.
 */
export async function correctFeedback(actor: ResearchActor, workspaceId: string, feedbackId: string, input: unknown) {
  const body = parse(researchFeedbackCorrectionSchema, input)
  if (actor.kind === 'assistant') throw new ResearchCommandError('research_forbidden', 403)
  const feedback = await getResearchFeedbackForViewer(actor.userId, id(workspaceId), id(feedbackId))
  if (!feedback) throw notFound()
  const stance = feedback.actorUserId === actor.userId ? 'interpretation' : 'disagreement'
  try {
    const r = await appendResearchFeedbackRevisionSystem({
      feedbackId, workspaceId, expectedVersion: body.expectedVersion, stance, kind: body.kind, note: body.note ?? null,
      actorUserId: actor.userId, idempotencyKey: body.idempotencyKey, assistantId: null, sessionId: null, sensitivity: feedback.sensitivity,
    })
    if (stance === 'interpretation' && !r.replayed) await revalidateResearchLessons(workspaceId)
    if (!r.replayed) notifyWorkspaceChange(workspaceId, 'research', 'update', feedback.activityId)
    return { revision: r.revision, stance, replayed: r.replayed }
  } catch (error) {
    translate(error)
  }
}

export async function decideLesson(actor: ResearchActor, workspaceId: string, lessonId: string, input: unknown) {
  const body = parse(researchLessonDecisionSchema, input)
  try {
    const decided = await decideResearchLessonSystem({ userId: actor.userId, human: actor.human, kind: actor.kind }, id(workspaceId), id(lessonId), body)
    if (!decided.replayed) notifyWorkspaceChange(workspaceId, 'research', 'update', lessonId)
    return decided
  } catch (error) {
    translate(error)
  }
}

export async function listImprovements(actor: ResearchActor, workspaceId: string) {
  return { improvements: await listResearchImprovementsForViewer(actor.userId, id(workspaceId)) }
}

/** A candidate with its evidence re-resolved under the viewer's own access. */
export async function getImprovement(actor: ResearchActor, workspaceId: string, improvementId: string) {
  const found = await getResearchImprovementForViewer(actor.userId, id(workspaceId), id(improvementId))
  if (!found) throw notFound()
  const visibleFeedback: string[] = []
  for (const fid of found.improvement.feedbackIds) {
    if (await getResearchFeedbackForViewer(actor.userId, workspaceId, fid)) visibleFeedback.push(fid)
  }
  const visibleActivities: string[] = []
  for (const aid of found.improvement.activityIds) {
    if (await getResearchActivityForViewer(actor.userId, workspaceId, aid)) visibleActivities.push(aid)
  }
  return {
    ...found,
    evidence: {
      feedbackIds: visibleFeedback,
      activityIds: visibleActivities,
      hidden: found.improvement.feedbackIds.length - visibleFeedback.length + found.improvement.activityIds.length - visibleActivities.length,
    },
  }
}

/**
 * Nominate a generic improvement candidate. Every cited follow-up, activity
 * and Task must be visible to the nominator now; the candidate inherits the
 * highest source sensitivity. The text is the nominator's generic pattern -
 * it is not an export of the evidence.
 */
export async function nominateImprovement(actor: ResearchActor, workspaceId: string, input: unknown) {
  const body = parse(researchImprovementNominationSchema, input)
  if (actor.kind === 'assistant') throw new ResearchCommandError('research_forbidden', 403)
  id(workspaceId)
  let sensitivity: ResearchSensitivity = 'internal'
  const compartments = new Set<string>()
  for (const fid of body.feedbackIds) {
    const f = await getResearchFeedbackForViewer(actor.userId, workspaceId, fid)
    if (!f) throw notFound()
    const a = await getResearchActivityForViewer(actor.userId, workspaceId, f.activityId)
    if (!a) throw notFound()
    if (RANK[a.activity.sensitivity] > RANK[sensitivity]) sensitivity = a.activity.sensitivity
    a.activity.compartments.forEach((c) => compartments.add(c))
  }
  for (const aid of body.activityIds) {
    const a = await getResearchActivityForViewer(actor.userId, workspaceId, aid)
    if (!a) throw notFound()
    if (RANK[a.activity.sensitivity] > RANK[sensitivity]) sensitivity = a.activity.sensitivity
    a.activity.compartments.forEach((c) => compartments.add(c))
  }
  if (body.taskId && !(await taskReadableForViewer(actor.userId, body.taskId))) throw notFound()
  try {
    const { improvement, created } = await insertResearchImprovementSystem({
      workspaceId, createdBy: actor.userId, title: body.title, pattern: body.pattern, desiredBehavior: body.desiredBehavior,
      taskId: body.taskId ?? null, feedbackIds: body.feedbackIds, activityIds: body.activityIds, sensitivity,
      compartments: [...compartments].sort(), idempotencyKey: body.idempotencyKey,
    })
    if (created) notifyWorkspaceChange(workspaceId, 'research', 'create', improvement.id)
    return { improvement, replayed: !created }
  } catch (error) {
    translate(error)
  }
}

const recordComparisonSchema = z.object({
  bundle: researchComparisonBundleSchema,
  idempotencyKey: z.string().trim().min(1).max(200),
}).strict()

/**
 * Record a comparison against a visible candidate. A trace bundle is
 * recomputed here and stored `local_verified`; a reported result is stored
 * `externally_reported`. Nothing is installed, rebaselined or released.
 */
export async function recordComparison(actor: ResearchActor, workspaceId: string, improvementId: string, input: unknown) {
  const body = parse(recordComparisonSchema, input)
  if (actor.kind === 'assistant') throw new ResearchCommandError('research_forbidden', 403)
  const found = await getResearchImprovementForViewer(actor.userId, id(workspaceId), id(improvementId))
  if (!found) throw notFound()
  try {
    const bundle = body.bundle
    if (bundle.kind === 'traces') {
      const result = compareResearchTraces(bundle.manifest, bundle.baseline, bundle.candidate)
      const { comparison, created } = await insertResearchComparisonSystem({
        workspaceId, improvementId, recordedBy: actor.userId, verification: 'local_verified',
        caseSetVersion: result.identities.caseSetVersion, datasetVersion: result.identities.datasetVersion,
        judgeIdentity: result.identities.judge ?? 'none', baselineIdentity: result.identities.baseline,
        candidateIdentity: result.identities.candidate, result: { splits: result.splits, hardFailures: result.hardFailures },
        traceManifest: { kind: 'traces' }, idempotencyKey: body.idempotencyKey,
      })
      return { comparison, replayed: !created }
    }
    const { comparison, created } = await insertResearchComparisonSystem({
      workspaceId, improvementId, recordedBy: actor.userId, verification: 'externally_reported',
      caseSetVersion: bundle.caseSetVersion, datasetVersion: bundle.datasetVersion, judgeIdentity: bundle.judge,
      baselineIdentity: bundle.baseline, candidateIdentity: bundle.candidate, result: { reported: bundle.summary },
      traceManifest: { kind: 'reported' }, idempotencyKey: body.idempotencyKey,
    })
    return { comparison, replayed: !created }
  } catch (error) {
    translate(error)
  }
}

export async function getComparison(actor: ResearchActor, workspaceId: string, improvementId: string, comparisonId: string) {
  const found = await getResearchImprovementForViewer(actor.userId, id(workspaceId), id(improvementId))
  const comparison = found?.comparisons.find((c) => c.id === comparisonId)
  if (!comparison) throw notFound()
  return { comparison }
}
