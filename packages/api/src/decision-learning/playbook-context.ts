/**
 * One scoped playbook loader for every model prompt path. It keeps rule ids
 * out of prompt text, renders whole rules under the existing cap, and records
 * one content-free application row for decision-derived rules actually sent.
 *
 * [COMP:api/decision-playbook-context]
 */

import { PLAYBOOK_BLOCK_CHAR_CAP, type FeedLearningScope } from '@use-brian/shared'
import type { AnalyticsLogger } from '@use-brian/core'

import {
  listActivePlaybookRulesForActor,
  type PlaybookPromptRule,
} from '../db/playbook-store.js'
import { appendDecisionApplication } from '../db/decision-provenance-store.js'
import { listResearchLessonsForTurn, type ResearchPromptLesson } from '../research/learning.js'

type Sensitivity = PlaybookPromptRule['decisionSensitivity']

const SENSITIVITY_RANK: Record<Sensitivity, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
}

export type DecisionPlaybookApplicability = {
  kind: 'email' | 'tool' | 'feed'
  key?: string | null
  scope?: FeedLearningScope
}

export type DecisionPlaybookContext = {
  /** Model-visible strings only. Artifact/application ids never enter these. */
  playbookRules: string[]
  /** Internal attribution returned out-of-band from prompt text. */
  appliedRuleIds: string[]
  decisionApplicationId: string | null
  readFailed: boolean
}

function isApplicable(
  rule: PlaybookPromptRule,
  operation: DecisionPlaybookApplicability | undefined,
): boolean {
  if (rule.applicabilityKind === 'feed') {
    const source = rule.feedScope; const target = operation?.scope
    if (operation?.kind !== 'feed' || !source || !target) return false
    return feedLearningScopeApplies({ ...source, sensitivity: rule.decisionSensitivity }, target)
  }
  if (rule.appliesToUserId === null || rule.applicabilityKind === 'general') return true
  // A generic chat turn may invoke any supplied tool, so all user-specific
  // operation rules remain available. A frozen workflow context narrows to
  // its known operation and optional account/tool key.
  if (!operation) return true
  if (rule.applicabilityKind !== operation.kind) return false
  if (!rule.applicabilityKey) return true
  return Boolean(operation.key) && rule.applicabilityKey === operation.key
}

/** Feed references and native rules share one applicability boundary. */
export function feedLearningScopeApplies(source: FeedLearningScope, target: FeedLearningScope): boolean {
  return source.platform === target.platform && source.postFormat === target.postFormat && source.brandId === target.brandId
    && source.compartments.every(id => target.compartments.includes(id))
    && source.projectIds.every(id => target.projectIds.includes(id))
    && SENSITIVITY_RANK[source.sensitivity] <= SENSITIVITY_RANK[target.sensitivity]
}

function orderRank(
  rule: PlaybookPromptRule,
  operation: DecisionPlaybookApplicability | undefined,
): number {
  if (rule.appliesToUserId === null) return 2
  if (rule.applicabilityKind === 'general') return 1
  if (!operation) return 0
  return rule.applicabilityKind === operation.kind
    && (!rule.applicabilityKey || rule.applicabilityKey === operation.key)
    ? 0
    : 1
}

function fitWholeRules(rules: readonly PlaybookPromptRule[]): PlaybookPromptRule[] {
  const selected: PlaybookPromptRule[] = []
  let spent = 0
  for (const candidate of rules) {
    const rule = candidate.rule.trim()
    if (!rule) continue
    const lineLength = `- ${rule}`.length + 1
    if (spent + lineLength > PLAYBOOK_BLOCK_CHAR_CAP) break
    selected.push({ ...candidate, rule })
    spent += lineLength
  }
  return selected
}

function maximumSensitivity(rules: readonly PlaybookPromptRule[]): Sensitivity {
  return rules.reduce<Sensitivity>(
    (highest, rule) => SENSITIVITY_RANK[rule.decisionSensitivity]
      > SENSITIVITY_RANK[highest]
      ? rule.decisionSensitivity
      : highest,
    'public',
  )
}

export async function loadDecisionPlaybookContext(params: {
  workspaceId: string | null
  assistantId: string
  actorUserId: string | null
  externalPrincipal: boolean
  operationKind: string
  operationId: string
  /** Feed shared review intersects the current draft audience before selection. */
  allowedRuleIds?: readonly string[]
  /** Source preview must not count as model application. Defaults to true. */
  recordApplication?: boolean
  applicability?: DecisionPlaybookApplicability
  sourceKind?: string | null
  sourceId?: string | null
  channelType?: string
  analytics?: AnalyticsLogger
  logLabel: string
  /**
   * Present only on a research turn: also select the actor's research
   * lessons, the turn Project's lessons (live roster for actor and
   * assistant) and accepted company methods (features/research.md).
   */
  research?: { projectId: string | null }
}): Promise<DecisionPlaybookContext> {
  let loaded: PlaybookPromptRule[]
  try {
    loaded = await listActivePlaybookRulesForActor({
      assistantId: params.assistantId,
      actorUserId: params.actorUserId,
      externalPrincipal: params.externalPrincipal,
    })
  } catch (err) {
    console.error(`[${params.logLabel}] scoped playbook read failed:`, err)
    if (params.actorUserId) {
      params.analytics?.logEvent({
        userId: params.actorUserId,
        actorUserId: params.actorUserId,
        assistantId: params.assistantId,
        eventName: 'decision_playbook_read_failed',
        channelType: params.channelType,
        metadata: {},
      })
    }
    return {
      playbookRules: [],
      appliedRuleIds: [],
      decisionApplicationId: null,
      readFailed: true,
    }
  }

  // Research lessons ride the same loader and cap. A failed lesson read omits
  // them with an honest operational error; it never fails the turn.
  let researchLessons: ResearchPromptLesson[] = []
  if (params.research && params.workspaceId) {
    try {
      researchLessons = await listResearchLessonsForTurn({
        workspaceId: params.workspaceId,
        actorUserId: params.actorUserId,
        assistantId: params.assistantId,
        projectId: params.research.projectId,
        externalPrincipal: params.externalPrincipal,
      })
    } catch (err) {
      console.error(`[${params.logLabel}] research lesson read failed:`, err)
    }
  }
  const researchRules: PlaybookPromptRule[] = researchLessons.map((lesson) => ({
    id: lesson.id, rule: lesson.rule, createdBy: 'research_reflection',
    appliesToUserId: null, applicabilityKind: 'general', applicabilityKey: null,
    decisionSensitivity: lesson.sensitivity, feedScope: null, decisionCompartments: [], decisionProjectIds: [],
  }))
  const researchRank = new Map(researchLessons.map((lesson) => [lesson.id, lesson.scope === 'user' ? 0 : 1]))

  const ordered = [...loaded
    .filter(rule => !params.allowedRuleIds || params.allowedRuleIds.includes(rule.id))
    .filter((rule) => rule.appliesToUserId === null || (
      !params.externalPrincipal
      && params.actorUserId !== null
      && rule.appliesToUserId === params.actorUserId
    ))
    .filter((rule) => isApplicable(rule, params.applicability)), ...researchRules]
    .map((rule, index) => ({ rule, index }))
    .sort((left, right) =>
      (researchRank.get(left.rule.id) ?? orderRank(left.rule, params.applicability))
        - (researchRank.get(right.rule.id) ?? orderRank(right.rule, params.applicability))
      || left.index - right.index)
    .map(({ rule }) => rule)
  const selected = fitWholeRules(ordered)
  const decisionRules = selected.filter((rule) =>
    (rule.createdBy === 'decision_reflection' && rule.appliesToUserId !== null) || researchRank.has(rule.id))

  let decisionApplicationId: string | null = null
  if (params.recordApplication !== false && decisionRules.length > 0 && params.actorUserId && !params.externalPrincipal) {
    try {
      const application = await appendDecisionApplication({
        workspaceId: params.workspaceId,
        actorUserId: params.actorUserId,
        assistantId: params.assistantId,
        operationKind: params.operationKind,
        operationId: params.operationId,
        artifactRefs: decisionRules.map((rule) => ({
          kind: 'assistant_playbook_rule',
          id: rule.id,
        })),
        sourceKind: params.sourceKind ?? null,
        sourceId: params.sourceId ?? null,
        visibility: 'owner',
        sensitivity: maximumSensitivity(decisionRules),
      })
      decisionApplicationId = application.id
      params.analytics?.logEvent({
        userId: params.actorUserId,
        actorUserId: params.actorUserId,
        assistantId: params.assistantId,
        eventName: 'decision_playbook_applied',
        channelType: params.channelType,
        metadata: {
          rule_count: decisionRules.length,
          has_specific_applicability: decisionRules.some((rule) =>
            rule.applicabilityKind !== 'general'),
        },
      })
    } catch (err) {
      // A failed attribution write never blocks the turn and never invents an
      // id for a later approval. The rules are still soft prompt guidance.
      console.error(`[${params.logLabel}] decision application write failed:`, err)
    }
  }

  return {
    playbookRules: selected.map((rule) => rule.rule),
    appliedRuleIds: decisionRules.map((rule) => rule.id),
    decisionApplicationId,
    readFailed: false,
  }
}
