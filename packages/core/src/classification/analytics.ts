/**
 * Classification analytics event taxonomy.
 *
 * Wraps `AnalyticsLogger` with type-safe helpers so emitters can't
 * misspell event names or drift metadata shape across primitives.
 *
 * Spec: docs/architecture/brain/classification/README.md §Audit / provenance
 */

import { sanitize, type AnalyticsLogger } from '../analytics/logger.js'
import type { ClassifierBoundary, ClassifierTier } from './types.js'

export type ClassifierAppliedEvent = {
  primitive_kind: 'entity' | 'edge' | 'memory' | 'episode'
  target_id?: string                       // null if pre-write
  rule_id: string
  tier: ClassifierTier
  confidence: number
  before_value: string                     // LLM-emitted / user-provided value (or 'none')
  after_value: string                      // value after the rule
  boundary: ClassifierBoundary
}

export type ClassifierConflictEvent = {
  primitive_kind: 'entity' | 'edge' | 'memory' | 'episode'
  winning_rule_id: string
  losing_rule_ids: string[]
  primary: string                          // candidate.primary at conflict time
  boundary: ClassifierBoundary
}

export type ClassifierBlockedEvent = {
  rule_id: string
  primitive_kind: 'entity' | 'edge' | 'memory' | 'episode'
  blocked_value: string
  source_kind?: string
  boundary: ClassifierBoundary
  reason: string
}

export type ClassifierDemoteBlockedEvent = {
  rule_id: string
  entity_id: string
  current_kind: string
  suggested_kind: string
  boundary: ClassifierBoundary
}

export type ClassifierCircuitBreakerTrippedEvent = {
  rule_id: string
  workspace_id: string
  observed_count_per_hour: number
  suspended_until: string                  // ISO timestamp
  boundary: ClassifierBoundary
}

export type ClassificationAnalytics = {
  applied(actorUserId: string, e: ClassifierAppliedEvent): void
  conflict(actorUserId: string, e: ClassifierConflictEvent): void
  blocked(actorUserId: string, e: ClassifierBlockedEvent): void
  demoteBlocked(actorUserId: string, e: ClassifierDemoteBlockedEvent): void
  circuitBreakerTripped(actorUserId: string, e: ClassifierCircuitBreakerTrippedEvent): void
}

/**
 * Wraps an AnalyticsLogger with the typed classifier events.
 * Pass undefined to disable analytics (tests, ad-hoc tools).
 */
export function createClassificationAnalytics(
  logger: AnalyticsLogger | undefined,
): ClassificationAnalytics {
  if (!logger) {
    return {
      applied: () => {},
      conflict: () => {},
      blocked: () => {},
      demoteBlocked: () => {},
      circuitBreakerTripped: () => {},
    }
  }

  return {
    applied(actorUserId, e) {
      logger.logEvent({
        userId: actorUserId,
        eventName: 'classifier_applied',
        metadata: {
          primitive_kind: sanitize(e.primitive_kind),
          target_id: e.target_id ? sanitize(e.target_id) : undefined,
          rule_id: sanitize(e.rule_id),
          tier: sanitize(e.tier),
          confidence: e.confidence,
          before_value: sanitize(e.before_value),
          after_value: sanitize(e.after_value),
          boundary: sanitize(e.boundary),
        },
      })
    },
    conflict(actorUserId, e) {
      logger.logEvent({
        userId: actorUserId,
        eventName: 'classifier_conflict',
        metadata: {
          primitive_kind: sanitize(e.primitive_kind),
          winning_rule_id: sanitize(e.winning_rule_id),
          losing_rule_ids: sanitize(e.losing_rule_ids.join(',')),
          primary: sanitize(e.primary),
          boundary: sanitize(e.boundary),
        },
      })
    },
    blocked(actorUserId, e) {
      logger.logEvent({
        userId: actorUserId,
        eventName: 'classifier_blocked',
        metadata: {
          rule_id: sanitize(e.rule_id),
          primitive_kind: sanitize(e.primitive_kind),
          blocked_value: sanitize(e.blocked_value),
          source_kind: e.source_kind ? sanitize(e.source_kind) : undefined,
          boundary: sanitize(e.boundary),
          reason: sanitize(e.reason),
        },
      })
    },
    demoteBlocked(actorUserId, e) {
      logger.logEvent({
        userId: actorUserId,
        eventName: 'classifier_demote_blocked',
        metadata: {
          rule_id: sanitize(e.rule_id),
          entity_id: sanitize(e.entity_id),
          current_kind: sanitize(e.current_kind),
          suggested_kind: sanitize(e.suggested_kind),
          boundary: sanitize(e.boundary),
        },
      })
    },
    circuitBreakerTripped(actorUserId, e) {
      logger.logEvent({
        userId: actorUserId,
        eventName: 'classifier_circuit_breaker_tripped',
        metadata: {
          rule_id: sanitize(e.rule_id),
          workspace_id: sanitize(e.workspace_id),
          observed_count_per_hour: e.observed_count_per_hour,
          suspended_until: sanitize(e.suspended_until),
          boundary: sanitize(e.boundary),
        },
      })
    },
  }
}
