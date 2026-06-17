export {
  runLightConsolidation,
  runREMConsolidation,
  runDeepConsolidation,
  computeConsolidationScore,
  bucketDomains,
  runTeamLightConsolidation,
  runTeamDeepConsolidation,
  runREMSkillUmbrella,
  runDeepSkillDecay,
} from './phases.js'
export type {
  ConsolidationPhase,
  ConsolidationResult,
  ConsolidationStore,
  ConsolidationEvent,
  ConsolidationOptions,
  DeepConsolidationOptions,
  MemoryScoreInput,
} from './phases.js'
export { createConsolidationWorker } from './worker.js'
export type {
  ConsolidationWorkerOptions,
  ConsolidationCallContext,
  ConsolidationCallModel,
  ScopedConsolidationEvent,
  WorkspaceCuratorScope,
  WorkspaceCuratorCadenceTracker,
  ReclassificationScope,
} from './worker.js'
export {
  runSkillUmbrellaPass,
  clusterByEmbedding,
  startOfWeekUTC,
} from './skill-umbrella.js'
export type {
  UmbrellaSkill,
  SkillUmbrellaStore,
  SkillUmbrellaDigestStore,
  SkillUmbrellaEvent,
  SkillCuratorAction,
  RunSkillUmbrellaPassParams,
  RunSkillUmbrellaPassResult,
} from './skill-umbrella.js'
export {
  runSkillDecay,
  evaluateDemoteRule,
} from './skill-decay.js'
export {
  runReclassification,
  filterMemoriesForReclassification,
  buildReclassificationPrompt,
  RECLASSIFICATION_DAILY_CAP,
} from './reclassifier.js'
export type {
  MemoryForReclassification,
  ReclassificationDecision,
  ReclassificationDeps,
  ReclassificationResult,
} from './reclassifier.js'
export type {
  SkillDecayStore,
  SkillDecayCandidate,
  SkillDecayEvent,
  SkillDecayReason,
  SkillDecayThresholds,
  RunSkillDecayParams,
  RunSkillDecayResult,
} from './skill-decay.js'
