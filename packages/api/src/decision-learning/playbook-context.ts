/**
 * One scoped playbook loader for every model prompt path. It keeps rule ids
 * out of prompt text, renders whole rules under the existing cap, and records
 * one content-free application row for decision-derived rules actually sent.
 *
 * [COMP:api/decision-playbook-context]
 */

import { PLAYBOOK_BLOCK_CHAR_CAP } from '@use-brian/shared'
import type { AnalyticsLogger } from '@use-brian/core'

import {
  listActivePlaybookRulesForActor,
  type PlaybookPromptRule,
} from '../db/playbook-store.js'
import { appendDecisionApplication } from '../db/decision-provenance-store.js'

type Sensitivity = PlaybookPromptRule['decisionSensitivity']

const SENSITIVITY_RANK: Record<Sensitivity, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
}

export type DecisionPlaybookApplicability = {
  kind: 'email' | 'tool'
  key?: string | null
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
  if (rule.appliesToUserId === null || rule.applicabilityKind === 'general') return true
  // A generic chat turn may invoke any supplied tool, so all user-specific
  // operation rules remain available. A frozen workflow context narrows to
  // its known operation and optional account/tool key.
  if (!operation) return true
  if (rule.applicabilityKind !== operation.kind) return false
  if (!rule.applicabilityKey) return true
  return Boolean(operation.key) && rule.applicabilityKey === operation.key
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
  applicability?: DecisionPlaybookApplicability
  sourceKind?: string | null
  sourceId?: string | null
  channelType?: string
  analytics?: AnalyticsLogger
  logLabel: string
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

  const ordered = loaded
    .filter((rule) => rule.appliesToUserId === null || (
      !params.externalPrincipal
      && params.actorUserId !== null
      && rule.appliesToUserId === params.actorUserId
    ))
    .filter((rule) => isApplicable(rule, params.applicability))
    .map((rule, index) => ({ rule, index }))
    .sort((left, right) =>
      orderRank(left.rule, params.applicability) - orderRank(right.rule, params.applicability)
      || left.index - right.index)
    .map(({ rule }) => rule)
  const selected = fitWholeRules(ordered)
  const decisionRules = selected.filter((rule) =>
    rule.createdBy === 'decision_reflection' && rule.appliesToUserId !== null)

  let decisionApplicationId: string | null = null
  if (decisionRules.length > 0 && params.actorUserId && !params.externalPrincipal) {
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
