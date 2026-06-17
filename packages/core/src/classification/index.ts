/**
 * Classification framework — public surface.
 *
 * Spec: docs/architecture/brain/classification/README.md
 */

export {
  CLASSIFIER_BOUNDARIES,
  DEFAULT_HINT_FLOOR,
  type Classifier,
  type ClassifierBlock,
  type ClassifierBoundary,
  type ClassifierCandidate,
  type ClassifierDecision,
  type ClassifierMatch,
  type ClassifierNegativeRule,
  type ClassifierRegistry,
  type ClassifierRule,
  type ClassifierSuggestion,
  type ClassifierTier,
  type ClassifierToolResult,
  type DerivedEdge,
  type DerivedEntity,
} from './types.js'

export { decide, type DecideOptions } from './decide.js'

export {
  createClassifierRegistry,
  isNegativeRule,
  type RegistryOptions,
} from './registry.js'

export {
  createComposeExecutor,
  type CompositionContext,
  type CompositionResult,
  type CompositionWrite,
  type ComposeExecutor,
  type ComposeExecutorDeps,
} from './compose.js'

export {
  createClassificationAnalytics,
  type ClassificationAnalytics,
  type ClassifierAppliedEvent,
  type ClassifierBlockedEvent,
  type ClassifierCircuitBreakerTrippedEvent,
  type ClassifierConflictEvent,
  type ClassifierDemoteBlockedEvent,
} from './analytics.js'

export {
  type EnqueuePendingClassification,
  type PendingClassificationDetectedBy,
  type PendingClassificationPrimitive,
  type PendingClassificationRecord,
  type PendingClassificationResolution,
  type PendingClassificationStore,
} from './pending-queue.js'

export { createEntityKindClassifier } from './rules/entity-kind/index.js'

export {
  edgeValidationRules,
  validateEdgeKindTriple,
  type EdgeValidationResult,
  type EdgeValidationRule,
} from './rules/edge-type/index.js'

export { applySensitivityRules } from './rules/sensitivity/index.js'

export {
  decideMemoryScope,
  type MemoryScopeContext,
  type MemoryScopeDecision,
} from './rules/memory-scope/index.js'

export {
  createCircuitBreaker,
  createInMemoryCounterStore,
  type CircuitBreaker,
  type CircuitBreakerCounterStore,
  type CircuitBreakerOptions,
} from './circuit-breaker.js'

export {
  createClassifierSelfHealWorker,
  type ClassifierSelfHealTickResult,
  type ClassifierSelfHealWorker,
  type ClassifierSelfHealWorkerOptions,
  type ClassifierSelfHealWorkspaceLister,
  type EntityCentralityScannerPort,
  type EntityKindReclassifierPort,
} from './self-heal/worker.js'
