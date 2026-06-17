// Correction layer — D-locks per docs/architecture/brain/corrections.md.
//   - entity-merge.ts (WU-6.7): D.1 entity merge + cascade, D.2 undoMerge
//   - memory-to-entity-promotion.ts (WU-6.10): D.7 supersession + Promote-to-team
//   - retraction.ts (WU-6.8): D.3 memory retraction + hard purge, D.5 reExtractEpisode
//   - soft-delete.ts (WU-6.8): D.4 universal soft-delete contract
//   - sensitivity-reclassification.ts (WU-6.8): D.6 sensitivity reclassification
//   - tools.ts (WU-6.8 tool layer): retractMemory / deleteBrainRow / reclassifySensitivity chat tools
//
// Collision note: `ApplyHardPurgeInput` is declared in both retraction.ts
// and soft-delete.ts. Each is an adapter-facing port input shape with a
// different field set, so both are re-exported under disambiguated
// aliases — `RetractionApplyHardPurgeInput` / `SoftDeleteApplyHardPurgeInput`.

export {
  type ReconciliationMode,
  type ReconciliationOverride,
  type SpecializationPointer,
  type MergeEntitiesArgs,
  type UndoMergeArgs,
  type EntityMergeSnapshot,
  type EntityMergeRecord,
  type MergeFailureCode,
  type UndoFailureCode,
  EntityMergeError,
  UndoMergeError,
  type ApplyMergeInput,
  type ApplyUndoMergeInput,
  type EntityMergeRepository,
  type SpecializationCascadeRepository,
  type EntityMergeDeps,
  type ConflictSeverity,
  type ConflictReport,
  type ReconciliationResult,
  RESERVED_RECONCILIATION_FIELDS,
  reconcileAttributes,
  reconcileTags,
  isWithinUndoWindow,
  mergeEntities,
  undoMerge,
} from './entity-merge.js'

export {
  type MemoryForPromotion,
  type EntitySnapshotForPromotion,
  type SupersedeEntityFn,
  type MemoryToEntityPromotionPorts,
  type PromoteMemoryToEntityParams,
  type PromotionResult,
  type PromotionFailureReason,
  PromotionDenied,
  promoteMemoryToEntity,
} from './memory-to-entity-promotion.js'

// ── D.3 / D.5 — memory retraction, hard purge, episode re-extraction ──
export {
  type MemoryRetractionSnapshot,
  type RetractMemoryArgs,
  type PurgeMemoryArgs,
  type FindRetractedMatchArgs,
  type ReExtractEpisodeArgs,
  type MemoryRetractionResult,
  type MemoryPurgeResult,
  type ReExtractEpisodeResult,
  type EpisodeDerivationSnapshot,
  type RetractionFailureCode,
  type PurgeFailureCode,
  type ReExtractFailureCode,
  MemoryRetractionError,
  MemoryPurgeError,
  EpisodeReExtractionError,
  type ApplySoftRetractInput,
  // Disambiguated — collides with soft-delete.ts ApplyHardPurgeInput.
  type ApplyHardPurgeInput as RetractionApplyHardPurgeInput,
  type MemoryRetractionRepository,
  type SupersedeDerivationsInput,
  type TriggerExtractionInput,
  type EpisodeReExtractionRepository,
  type RetractionDeps,
  retractMemory,
  purgeMemory,
  findRetractedMatch,
  reExtractEpisode,
} from './retraction.js'

// ── D.4 — universal soft-delete contract ─────────────────────────────
export {
  type SoftDeletePrimitive,
  PRIMITIVES_WITH_PHYSICAL_DELETE,
  isPhysicalDeleteOnly,
  type RowSnapshot,
  type SoftDeleteArgs,
  type HardPurgeArgs,
  type DeleteByAuthorArgs,
  type SoftDeleteResult,
  type HardPurgeResult,
  type SoftDeleteFailureCode,
  type HardPurgeFailureCode,
  type DeleteByAuthorFailureCode,
  SoftDeleteError,
  HardPurgeError,
  DeleteByAuthorError,
  type ApplySoftDeleteInput,
  // Disambiguated — collides with retraction.ts ApplyHardPurgeInput.
  type ApplyHardPurgeInput as SoftDeleteApplyHardPurgeInput,
  type SoftDeleteRepository,
  type SoftDeleteDeps,
  softDelete,
  hardPurge,
  deleteByAuthor,
} from './soft-delete.js'

// ── D.6 — sensitivity reclassification ───────────────────────────────
export {
  type ReclassifiablePrimitive,
  type ReclassificationDirection,
  type TriggeredBy,
  type RowSensitivitySnapshot,
  type ChannelSensitivityRule,
  type DerivedRowRef,
  type ReclassifyRowArgs,
  type ChannelSensitivityRuleSeed,
  type SupersedeChannelRuleArgs,
  type ReclassificationOutcome,
  type SupersedeRuleOutcome,
  type ReclassifyFailureCode,
  type SupersedeRuleFailureCode,
  SensitivityReclassificationError,
  ChannelRuleSupersessionError,
  type ApplyRowReclassificationInput,
  type FindDerivedRowsInput,
  type SensitivityReclassificationRepository,
  type InsertSupersedingRuleInput,
  type ChannelSensitivityRuleRepository,
  type SensitivityReclassificationDeps,
  inferDirection,
  requiresOperator,
  cascadedSensitivity,
  reclassifyRowSensitivity,
  supersedeChannelSensitivityRule,
} from './sensitivity-reclassification.js'

// ── Tool layer — chat tools wrapping D.3 / D.4 / D.6 corrections ──────
export { type CorrectionToolsDeps, createCorrectionTools } from './tools.js'
