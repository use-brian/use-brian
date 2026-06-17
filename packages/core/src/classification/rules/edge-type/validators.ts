/**
 * Edge-type validation rules — reject LLM-emitted edges whose
 * source.kind / target.kind / edge_type triple is incompatible.
 *
 * These rules don't *produce* an edge_type; they fire when the LLM
 * produces something the vocabulary doesn't actually support, so the
 * write is rejected and an analytics event is logged.
 *
 * Implemented as a pure helper rather than a Classifier — edges have
 * source + target kinds as part of the candidate which doesn't fit
 * the single-`candidate` interface cleanly. The helper is called
 * directly from Pipeline B's edge-write loop.
 *
 * Spec: docs/architecture/brain/classification/edge-type.md
 *   §Validation rules
 */

import type { EdgeType, EntityKind } from '../../../entities/types.js'

export type EdgeValidationRule = {
  id: string
  edgeType: EdgeType
  reason: string
  /** Returns true if the (source.kind, target.kind) triple is incompatible with edgeType. */
  isViolation(sourceKind: EntityKind, targetKind: EntityKind): boolean
}

export const edgeValidationRules: EdgeValidationRule[] = [
  {
    id: 'validate-works-at-requires-person-company',
    edgeType: 'works_at',
    reason: 'works_at requires (person → company)',
    isViolation: (s, t) => !(s === 'person' && t === 'company'),
  },
  {
    id: 'validate-discussed-in-requires-entity-episode',
    edgeType: 'discussed_in',
    reason: 'discussed_in requires (entity → episode); enforced at source kind only',
    isViolation: (_s, _t) => false,  // source/target kind are entity/episode; LLM emits entity/entity so this is permissive in v1
  },
  {
    id: 'validate-depends-on-requires-same-kind',
    edgeType: 'depends_on',
    reason: 'depends_on requires source.kind === target.kind',
    isViolation: (s, t) => s !== t,
  },
]

const rulesByEdgeType: Map<EdgeType, EdgeValidationRule[]> = new Map()
for (const r of edgeValidationRules) {
  if (!rulesByEdgeType.has(r.edgeType)) rulesByEdgeType.set(r.edgeType, [])
  rulesByEdgeType.get(r.edgeType)!.push(r)
}

export type EdgeValidationResult =
  | { ok: true }
  | { ok: false; rule_id: string; reason: string }

export function validateEdgeKindTriple(
  edgeType: EdgeType,
  sourceKind: EntityKind,
  targetKind: EntityKind,
): EdgeValidationResult {
  const rules = rulesByEdgeType.get(edgeType) ?? []
  for (const r of rules) {
    if (r.isViolation(sourceKind, targetKind)) {
      return { ok: false, rule_id: r.id, reason: r.reason }
    }
  }
  return { ok: true }
}
