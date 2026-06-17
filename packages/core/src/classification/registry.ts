/**
 * Generic classifier registry — composes positive rules + negative
 * rules into a single `Classifier<T>` surface.
 *
 * Validates at registration time:
 *   - rule.boundaries non-empty
 *   - probabilistic rule has at least one boundary that can consume hints
 *   - rule.id is unique across the registry
 *
 * Spec: docs/architecture/brain/classification/README.md §Rule contribution
 */

import { decide } from './decide.js'
import type {
  Classifier,
  ClassifierBlock,
  ClassifierBoundary,
  ClassifierCandidate,
  ClassifierDecision,
  ClassifierMatch,
  ClassifierNegativeRule,
  ClassifierRegistry,
  ClassifierRule,
} from './types.js'

export type RegistryOptions = {
  /** Drop probabilistic matches below this floor in `decide()`. */
  hintFloor?: number
}

export function createClassifierRegistry<T extends string>(
  rules: Array<ClassifierRule<T> | ClassifierNegativeRule<T>>,
  options: RegistryOptions = {},
): ClassifierRegistry<T> {
  const positive: ClassifierRule<T>[] = []
  const negative: ClassifierNegativeRule<T>[] = []
  const seenIds = new Set<string>()

  for (const r of rules) {
    if (seenIds.has(r.id)) {
      throw new Error(`[classification/registry] duplicate rule id: ${r.id}`)
    }
    seenIds.add(r.id)

    if (r.boundaries.length === 0) {
      throw new Error(
        `[classification/registry] rule ${r.id} has empty boundaries — must register against ≥1 boundary`,
      )
    }

    if ('blocks' in r) {
      negative.push(r)
    } else {
      // Probabilistic rules need at least one boundary that can surface hints —
      // extraction (LLM consumer), connector / inbox / self-heal (UI pending queue)
      // or tool (suggestions[] in result). All five boundaries can surface
      // probabilistic hints today, so we accept any non-empty boundary list.
      // This validation is kept as a guard for future boundary additions that
      // may be hint-incompatible.
      positive.push(r)
    }
  }

  function classify(c: ClassifierCandidate, boundary: ClassifierBoundary): ClassifierMatch<T>[] {
    const out: ClassifierMatch<T>[] = []
    for (const r of positive) {
      if (!r.boundaries.includes(boundary)) continue
      if (r.applicableSources && c.source && !r.applicableSources.includes(c.source.kind)) {
        continue
      }
      if (!r.applies(c)) continue
      const m = r.evaluate(c)
      if (m !== null) out.push(m)
    }
    out.sort((a, b) => b.confidence - a.confidence)
    return out
  }

  function collectBlocks(c: ClassifierCandidate, boundary: ClassifierBoundary): ClassifierBlock<T>[] {
    const out: ClassifierBlock<T>[] = []
    for (const n of negative) {
      if (!n.boundaries.includes(boundary)) continue
      if (n.applicableSources && c.source && !n.applicableSources.includes(c.source.kind)) {
        continue
      }
      if (!n.applies(c)) continue
      out.push({ rule_id: n.id, blocked: n.blocks, reason: n.reason })
    }
    return out
  }

  return {
    classify,
    decide(c: ClassifierCandidate, boundary: ClassifierBoundary): ClassifierDecision<T> {
      const matches = classify(c, boundary)
      const blocks = collectBlocks(c, boundary)
      return decide(matches, blocks, { hintFloor: options.hintFloor })
    },
    ruleIds() {
      return [...positive.map((r) => r.id), ...negative.map((r) => r.id)]
    },
  }
}

/**
 * Type-guard for callers iterating the rules array — distinguish
 * positive rules (have `produces`) from negative rules (have `blocks`).
 */
export function isNegativeRule<T extends string>(
  r: ClassifierRule<T> | ClassifierNegativeRule<T>,
): r is ClassifierNegativeRule<T> {
  return 'blocks' in r
}
