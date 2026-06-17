// Fathom source adapter — WU-7.5.
//
// Public surface for callers (the future ingest engine routing in WU-3.7
// and a Fathom pull worker / webhook receiver in a later work unit). The
// `packages/core/src/ingest/index.ts` barrel is owned by the coordinator
// and is not re-exported from here.
//
// [COMP:brain/source-adapters/fathom]

export { normalizeFathomMeeting } from './normalize.js'
export type { NormalizeFathomOptions } from './normalize.js'
export { fathomMeetingToEpisode } from './to-episode.js'

export type {
  EpisodeEnvelope,
  FathomEpisodeContext,
  FathomNormalizedMeeting,
  FathomNormalizedParticipant,
  FathomRawMeeting,
  FathomRawParticipant,
} from './types.js'
