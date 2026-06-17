/**
 * Edge-type classifier scaffold.
 *
 * In v1, the edge-type classifier is mostly **validation** (reject
 * incompatible source/target/edge_type triples) — most positive edge
 * rules ship as `derived.edges` from the entity-kind classifier
 * (works_at from corporate-email, documented_by from github actor).
 *
 * As probabilistic LLM-hint rules accumulate, they can be added to a
 * proper `Classifier<EdgeType>` registry here. For now, the validation
 * helper is the public surface.
 *
 * Spec: docs/architecture/brain/classification/edge-type.md
 */

export {
  edgeValidationRules,
  validateEdgeKindTriple,
  type EdgeValidationResult,
  type EdgeValidationRule,
} from './validators.js'
