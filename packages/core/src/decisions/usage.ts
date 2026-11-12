/** Decision result attribution, never a wire-model rewrite or authority receipt. */
import { isDecisionModelRow, registryRow } from '@use-brian/shared/model-registry'
import type { DecisionModelRef } from './types.js'

/** Preserve historical IDs unless the decision catalog explicitly pins its alias. */
export function decisionUsageModelId(model: DecisionModelRef): string {
  const row = registryRow(model.catalogId)
  return row && isDecisionModelRow(row) && row.recordAlias ? row.alias : model.wireId
}
