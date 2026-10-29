/**
 * Research follow-up capture (docs/architecture/features/research.md ->
 * "Follow-up feedback").
 *
 * Runs after the member's message is persisted and is replayable: the row is
 * keyed by the canonical message, so a replay converges. Only an
 * authenticated direct member's own words count - external principals,
 * quoted/forwarded lines, assistant output and tool results never do.
 *
 * [COMP:api/research-feedback]
 */
import {
  interpretResearchFollowup,
  resolveResearchFollowupTarget,
  type ResearchFeedbackKind,
} from '@use-brian/core'
import type { ResearchActivity, ResearchArtifactLink, ResearchFeedback, ResearchSensitivity } from '../db/research-store.js'

export type FollowupMessage = {
  id: string
  /** Canonical scope version of the message. */
  version: number
  role: string
  content: unknown
  senderUserId: string | null
  sensitivity: ResearchSensitivity | null
  compartments: string[] | null
}

export type ResearchFeedbackDeps = {
  /** Settled activities in this session visible to the actor, newest first. */
  listSessionActivities(actorUserId: string, workspaceId: string, sessionId: string): Promise<ResearchActivity[]>
  /** One activity (any session) visible to the actor, with its links. */
  getActivity(actorUserId: string, workspaceId: string, activityId: string): Promise<{ activity: ResearchActivity; artifacts: ResearchArtifactLink[] } | null>
  findReplyActivity?(actorUserId: string, workspaceId: string, outputMessageId: string): Promise<{ activity: ResearchActivity; artifacts: ResearchArtifactLink[] } | null>
  /** Production uses bounded durable state; legacy in-memory ports remain usable. */
  replayDurable?(params: { workspaceId:string;sessionId:string;assistantId:string;actorUserId:string;excludeMessageId?:string|null }): Promise<number>
  record(input: {
    workspaceId: string
    activityId: string
    sessionId: string
    assistantId: string
    messageId: string
    messageVersion: number
    actorUserId: string
    outputKey: string
    association: ResearchFeedback['association']
    kind: ResearchFeedbackKind
    uncertain: boolean
    interpreter: string
    projectId: string | null
    sensitivity: ResearchSensitivity
    compartments: string[]
  }): Promise<{ feedback: ResearchFeedback; inserted: boolean }>
}

export type FollowupCaptureResult =
  | { outcome: 'recorded' | 'replayed'; feedback: ResearchFeedback }
  | { outcome: 'not_member' | 'no_research' | 'unlinked'; reason?: string }

const RANK: Record<ResearchSensitivity, number> = { public: 0, internal: 1, confidential: 2 }
const maxSensitivity = (a: ResearchSensitivity, b: ResearchSensitivity | null): ResearchSensitivity =>
  b && RANK[b] > RANK[a] ? b : a

/**
 * The member's own words: text blocks only (never tool results or
 * attachments), with quoted/forwarded lines (`>` prefixes) removed.
 */
export function ownFollowupText(content: unknown): string {
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    text = content
      .filter((b): b is { type: 'text'; text: string } => !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text'
        && typeof (b as { text?: unknown }).text === 'string')
      .map((b) => b.text).join('\n')
  }
  return text.split('\n').filter((line) => !/^\s*>/.test(line)).join('\n').trim()
}

export function outputKeyFor(activity: ResearchActivity, artifacts: readonly ResearchArtifactLink[]): string {
  const out = artifacts.find((a) => a.relation === 'output') ?? artifacts[0]
  if (out) return `${out.kind}:${out.artifactId}:${out.version ?? 'latest'}`
  return activity.outputMessageId ? `message:${activity.outputMessageId}` : `activity:${activity.id}`
}

export async function captureResearchFollowup(deps: ResearchFeedbackDeps, params: {
  workspaceId: string
  sessionId: string
  assistantId: string
  message: FollowupMessage
  /** True when the sender is not an authenticated workspace member (external principal, guest). */
  externalPrincipal: boolean
  /** Explicit selection of a saved result (card action, cross-chat). */
  selectedActivityId?: string | null
  /** Explicit reply to a delivered message (channel reply-to), resolved to its id. */
  replyToMessageId?: string | null
}): Promise<FollowupCaptureResult> {
  const { message } = params
  if (message.role !== 'user' || !message.senderUserId || params.externalPrincipal) return { outcome: 'not_member' }
  const actor = message.senderUserId
  const text = ownFollowupText(message.content)
  if (!text) return { outcome: 'not_member', reason: 'no_member_text' }

  const inSession = (await deps.listSessionActivities(actor, params.workspaceId, params.sessionId))
    .filter((a) => a.status !== 'running' && a.requestMessageId !== message.id)
  const candidates = inSession.map((a) => ({ activityId: a.id, outputMessageId: a.outputMessageId }))
  let selected: { activity: ResearchActivity; artifacts: ResearchArtifactLink[] } | null = null
  if (params.selectedActivityId) {
    // Cross-chat feedback must explicitly name an activity the actor can see.
    selected = await deps.getActivity(actor, params.workspaceId, params.selectedActivityId)
    // An explicit unavailable target is not permission to choose another result.
    if (!selected || selected.activity.status === 'running') return candidates.length
      ? { outcome: 'unlinked', reason: 'not_visible' } : { outcome: 'no_research' }
    if (!candidates.some((c) => c.activityId === selected!.activity.id)) {
      candidates.push({ activityId: selected.activity.id, outputMessageId: selected.activity.outputMessageId })
    }
  }
  if (params.replyToMessageId && deps.findReplyActivity && !candidates.some(c => c.outputMessageId === params.replyToMessageId)) {
    const replied = await deps.findReplyActivity(actor, params.workspaceId, params.replyToMessageId)
    if (replied && replied.activity.status !== 'running') candidates.push({ activityId: replied.activity.id, outputMessageId: replied.activity.outputMessageId })
  }
  if (candidates.length === 0) return { outcome: 'no_research' }

  const interpretation = interpretResearchFollowup(text)
  const target = resolveResearchFollowupTarget({
    selectedActivityId: selected ? selected.activity.id : null,
    replyToMessageId: params.replyToMessageId ?? null,
    candidates,
    interpretation,
  })
  if (target.status !== 'linked') return { outcome: target.status === 'none' ? 'no_research' : 'unlinked', reason: target.status === 'uncertain' ? target.reason : undefined }

  const detail = selected?.activity.id === target.activityId ? selected : await deps.getActivity(actor, params.workspaceId, target.activityId)
  if (!detail) return { outcome: 'unlinked', reason: 'not_visible' }
  const { activity, artifacts } = detail
  const result = await deps.record({
    workspaceId: params.workspaceId,
    activityId: activity.id,
    sessionId: params.sessionId,
    assistantId: params.assistantId,
    messageId: message.id,
    messageVersion: message.version,
    actorUserId: actor,
    outputKey: outputKeyFor(activity, artifacts),
    association: target.method,
    kind: interpretation.kind,
    uncertain: interpretation.uncertain,
    interpreter: interpretation.interpreter,
    projectId: activity.projectId,
    sensitivity: maxSensitivity(activity.sensitivity, message.sensitivity),
    compartments: [...new Set([...activity.compartments, ...(message.compartments ?? [])])].sort(),
  })
  return { outcome: result.inserted ? 'recorded' : 'replayed', feedback: result.feedback }
}

/**
 * Replay capture over a session's recent member messages. Idempotent: a
 * message that already produced a row converges, and one that produced none
 * is simply re-evaluated (association is deterministic).
 */
export async function replayResearchFollowups(deps: ResearchFeedbackDeps & {
  listMessagesAfter(sessionId: string, afterMessageId: string, limit: number): Promise<FollowupMessage[]>
}, params: { workspaceId: string; sessionId: string; assistantId: string; actorUserId: string; limit?: number
  /** The message being captured explicitly right after; replay must not pre-empt its association. */
  excludeMessageId?: string | null }): Promise<number> {
  if (deps.replayDurable) return deps.replayDurable(params)
  const activities = (await deps.listSessionActivities(params.actorUserId, params.workspaceId, params.sessionId))
    .filter((a) => a.status !== 'running' && a.outputMessageId)
  const latest = activities[0]
  if (!latest?.outputMessageId) return 0
  const messages = await deps.listMessagesAfter(params.sessionId, latest.outputMessageId, params.limit ?? 10)
  let recorded = 0
  for (const message of messages) {
    if (message.senderUserId !== params.actorUserId || message.id === params.excludeMessageId) continue
    const r = await captureResearchFollowup(deps, {
      workspaceId: params.workspaceId, sessionId: params.sessionId, assistantId: params.assistantId,
      message, externalPrincipal: false,
    })
    if (r.outcome === 'recorded') recorded += 1
  }
  return recorded
}
