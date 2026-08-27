/**
 * Minimized, bounded human-decision evidence for one assistant/member pair.
 * Raw journal rows remain authoritative; this reader emits grouped facts and
 * loads reviewed-email changed regions only for the transient model request.
 *
 * [COMP:workers/decision-reflection]
 */

import type pg from 'pg'

import { getPool } from '../db/client.js'
import { excludeExternalPrincipalsSql } from '../db/external-principal.js'

type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>
type Sensitivity = 'public' | 'internal' | 'confidential' | 'restricted'

export type DecisionReflectionSubject = {
  assistantId: string
  actorUserId: string
  workspaceId: string | null
  newestEvidenceAt: Date
}

export type DecisionPlaybookCorpusEntry = {
  rule: string
  status: 'suggested' | 'active' | 'rejected' | 'retired'
  semanticKey: string | null
  appliesToUserId: string | null
}

export type NormalizedDecisionEvidence = {
  eventIds: string[]
  sourceObjectId: string
  sourceKind: 'reviewed_email' | 'tool_denial'
  applicabilityKind: 'email' | 'tool'
  applicabilityKey: string | null
  occurredAt: Date
  sensitivity: Sensitivity
  reason: string | null
  changedRegion?: { before: string; after: string }
}

export type DecisionEvidenceBundle = {
  assistantId: string
  actorUserId: string
  evidence: NormalizedDecisionEvidence[]
  corpus: DecisionPlaybookCorpusEntry[]
  newestLinkedEvidenceAt: Date | null
  hasNewEvidence: boolean
}

type RawEligibleEvent = {
  id: string
  eventKind: 'approval.decided' | 'email.draft_revised'
  sourceId: string
  reason: string | null
  payload: Record<string, unknown>
  sensitivity: Sensitivity
  createdAt: Date
}

const SENSITIVITY_RANK: Record<Sensitivity, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
}

function maxSensitivity(values: readonly Sensitivity[]): Sensitivity {
  return values.reduce(
    (highest, value) => SENSITIVITY_RANK[value] > SENSITIVITY_RANK[highest] ? value : highest,
    'public',
  )
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function isReviewedEmailDecision(payload: Record<string, unknown>): boolean {
  return payload.approvalKind === 'workflow_step'
    && payload.toolName === 'imapSendMessage'
}

/** Remove quoted history and envelope-like headers before any diff reaches a model. */
export function stripQuotedEmailHistory(input: string): string {
  const kept: string[] = []
  for (const rawLine of input.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trimEnd()
    if (/^\s*>/.test(line)) continue
    if (/^\s*-{2,}\s*(original message|forwarded message)\s*-{2,}\s*$/i.test(line)) break
    if (/^\s*on .{0,240} wrote:\s*$/i.test(line)) break
    if (/^\s*(from|to|cc|bcc|subject|sent|date):\s+/i.test(line)) continue
    kept.push(line)
  }
  return kept.join('\n').trim()
}

/** Return only the changed middle, with each side bounded to 1,000 chars. */
export function changedEmailRegion(beforeRaw: string, afterRaw: string): {
  before: string
  after: string
} {
  const before = stripQuotedEmailHistory(beforeRaw)
  const after = stripQuotedEmailHistory(afterRaw)
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++
  let suffix = 0
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix++
  return {
    before: before.slice(prefix, before.length - suffix || before.length).trim().slice(0, 1_000),
    after: after.slice(prefix, after.length - suffix || after.length).trim().slice(0, 1_000),
  }
}

/** Bounded roster with only pairs that have unlinked eligible evidence. */
export async function listDecisionReflectionSubjects(
  queryable: Queryable = getPool(),
): Promise<DecisionReflectionSubject[]> {
  const result = await queryable.query<DecisionReflectionSubject>(
    `WITH eligible AS (
       SELECT de.assistant_id, de.actor_user_id, MAX(de.created_at) AS newest
         FROM decision_events de
        WHERE de.assistant_id IS NOT NULL
          AND de.created_at >= now() - interval '30 days'
          AND (
            de.event_kind = 'email.draft_revised'
            OR (
              de.event_kind = 'approval.decided'
              AND de.payload->>'resolution' IN ('deny', 'always_deny')
              AND NULLIF(btrim(de.reason), '') IS NOT NULL
            )
          )
          ${excludeExternalPrincipalsSql('de.actor_user_id')}
        GROUP BY de.assistant_id, de.actor_user_id
     ), linked AS (
       SELECT r.assistant_id, r.applies_to_user_id AS actor_user_id,
              MAX(de.created_at) AS newest
         FROM assistant_playbook_rules r
         JOIN decision_derivations dd
           ON dd.artifact_kind = 'assistant_playbook_rule'
          AND dd.artifact_id = r.id::text
          AND dd.relation = 'supports'
         JOIN decision_events de ON de.id = dd.decision_event_id
        WHERE r.created_by = 'decision_reflection'
          AND r.applies_to_user_id IS NOT NULL
        GROUP BY r.assistant_id, r.applies_to_user_id
     )
     SELECT e.assistant_id AS "assistantId",
            e.actor_user_id AS "actorUserId",
            a.workspace_id AS "workspaceId",
            e.newest AS "newestEvidenceAt"
       FROM eligible e
       JOIN assistants a ON a.id = e.assistant_id
       LEFT JOIN linked l
         ON l.assistant_id = e.assistant_id AND l.actor_user_id = e.actor_user_id
      WHERE l.newest IS NULL OR e.newest > l.newest
      ORDER BY e.newest ASC, e.assistant_id, e.actor_user_id
      LIMIT 100`,
  )
  return result.rows
}

export async function readDecisionEvidence(
  params: { assistantId: string; actorUserId: string },
  queryable: Queryable = getPool(),
): Promise<DecisionEvidenceBundle> {
  const raw = await queryable.query<RawEligibleEvent>(
    `SELECT de.id, de.event_kind AS "eventKind", de.source_id AS "sourceId",
            de.reason, de.payload, de.sensitivity, de.created_at AS "createdAt"
       FROM decision_events de
      WHERE de.assistant_id = $1 AND de.actor_user_id = $2
        AND de.created_at >= now() - interval '30 days'
        AND (
          de.event_kind = 'email.draft_revised'
          OR (
            de.event_kind = 'approval.decided'
            AND de.payload->>'resolution' IN ('deny', 'always_deny')
            AND NULLIF(btrim(de.reason), '') IS NOT NULL
          )
        )
        ${excludeExternalPrincipalsSql('de.actor_user_id')}
      ORDER BY de.created_at DESC, de.id DESC
      LIMIT 120`,
    [params.assistantId, params.actorUserId],
  )

  const emailEvents = raw.rows.filter((event) => event.eventKind === 'email.draft_revised')
  const nextByPrevious = new Map<string, RawEligibleEvent>()
  const replacementIds = new Set<string>()
  for (const event of emailEvents) {
    const previous = stringValue(event.payload.previousApprovalId)
    const replacement = stringValue(event.payload.replacementApprovalId)
    if (!previous || !replacement) continue
    nextByPrevious.set(previous, event)
    replacementIds.add(replacement)
  }
  const chains: Array<{ events: RawEligibleEvent[]; firstId: string; finalId: string }> = []
  const consumed = new Set<string>()
  for (const event of emailEvents) {
    const firstId = stringValue(event.payload.previousApprovalId)
    if (!firstId || replacementIds.has(firstId) || consumed.has(event.id)) continue
    const events: RawEligibleEvent[] = []
    let cursor = firstId
    let finalId = firstId
    while (nextByPrevious.has(cursor)) {
      const next = nextByPrevious.get(cursor)!
      if (consumed.has(next.id)) break
      consumed.add(next.id)
      events.push(next)
      finalId = stringValue(next.payload.replacementApprovalId) ?? cursor
      cursor = finalId
    }
    if (events.length) chains.push({ events, firstId, finalId })
  }
  // A partial chain can start before the rolling window. Keep it as one source.
  for (const event of emailEvents) {
    if (consumed.has(event.id)) continue
    const firstId = stringValue(event.payload.previousApprovalId)
    const finalId = stringValue(event.payload.replacementApprovalId)
    if (firstId && finalId) chains.push({ events: [event], firstId, finalId })
  }

  const bodyIds = [...new Set(chains.flatMap((chain) => [chain.firstId, chain.finalId]))]
  const bodies = new Map<string, string>()
  if (bodyIds.length) {
    const bodyRows = await queryable.query<{ id: string; body: string | null }>(
      `SELECT id, arguments->>'body' AS body
         FROM pending_approvals
        WHERE id = ANY($1::uuid[])`,
      [bodyIds],
    )
    for (const row of bodyRows.rows) if (row.body !== null) bodies.set(row.id, row.body)
  }

  const evidence: NormalizedDecisionEvidence[] = []
  const emailRootByApprovalId = new Map<string, string>()
  for (const chain of chains) {
    const newest = chain.events.reduce((latest, event) =>
      event.createdAt > latest.createdAt ? event : latest)
    const first = chain.events[chain.events.length - 1]
    const before = bodies.get(chain.firstId) ?? ''
    const after = bodies.get(chain.finalId) ?? ''
    emailRootByApprovalId.set(chain.firstId, chain.firstId)
    for (const event of chain.events) {
      const previous = stringValue(event.payload.previousApprovalId)
      const replacement = stringValue(event.payload.replacementApprovalId)
      if (previous) emailRootByApprovalId.set(previous, chain.firstId)
      if (replacement) emailRootByApprovalId.set(replacement, chain.firstId)
    }
    evidence.push({
      eventIds: chain.events.map((event) => event.id),
      sourceObjectId: chain.firstId,
      sourceKind: 'reviewed_email',
      applicabilityKind: 'email',
      applicabilityKey: stringValue(newest.payload.accountKey),
      occurredAt: newest.createdAt,
      sensitivity: maxSensitivity(chain.events.map((event) => event.sensitivity)),
      reason: first.reason?.slice(0, 1_000) ?? null,
      changedRegion: changedEmailRegion(before, after),
    })
  }
  for (const event of raw.rows) {
    if (event.eventKind !== 'approval.decided') continue
    const approvalObjectId = stringValue(event.payload.approvalId)
      ?? stringValue(event.payload.toolCallId)
      ?? event.sourceId
    const reviewedEmail = isReviewedEmailDecision(event.payload)
    const sourceObjectId = reviewedEmail
      ? emailRootByApprovalId.get(approvalObjectId) ?? approvalObjectId
      : approvalObjectId
    evidence.push({
      eventIds: [event.id],
      sourceObjectId,
      sourceKind: reviewedEmail ? 'reviewed_email' : 'tool_denial',
      applicabilityKind: reviewedEmail ? 'email' : 'tool',
      applicabilityKey: reviewedEmail
        ? stringValue(event.payload.accountKey)
        : stringValue(event.payload.toolName),
      occurredAt: event.createdAt,
      sensitivity: event.sensitivity,
      reason: event.reason?.slice(0, 1_000) ?? null,
    })
  }
  evidence.sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime())
  const bounded = evidence.slice(0, 30)

  const [corpusRows, linkedRows] = await Promise.all([
    queryable.query<DecisionPlaybookCorpusEntry>(
      `SELECT rule, status, semantic_key AS "semanticKey",
              applies_to_user_id AS "appliesToUserId"
         FROM assistant_playbook_rules
        WHERE assistant_id = $1
          AND (applies_to_user_id IS NULL OR applies_to_user_id = $2)
        ORDER BY created_at DESC
        LIMIT 100`,
      [params.assistantId, params.actorUserId],
    ),
    queryable.query<{ newest: Date | null }>(
      `SELECT MAX(de.created_at) AS newest
         FROM assistant_playbook_rules r
         JOIN decision_derivations dd
           ON dd.artifact_kind = 'assistant_playbook_rule'
          AND dd.artifact_id = r.id::text
          AND dd.relation = 'supports'
         JOIN decision_events de ON de.id = dd.decision_event_id
        WHERE r.assistant_id = $1 AND r.applies_to_user_id = $2
          AND r.created_by = 'decision_reflection'`,
      [params.assistantId, params.actorUserId],
    ),
  ])
  const newestLinkedEvidenceAt = linkedRows.rows[0]?.newest ?? null
  return {
    assistantId: params.assistantId,
    actorUserId: params.actorUserId,
    evidence: bounded,
    corpus: corpusRows.rows,
    newestLinkedEvidenceAt,
    hasNewEvidence: bounded.some((item) =>
      newestLinkedEvidenceAt === null || item.occurredAt > newestLinkedEvidenceAt),
  }
}
