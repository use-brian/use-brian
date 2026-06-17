/**
 * Distribution module — team-owned, public-facing "app" assistants.
 *
 * Phase 1 exports: Threads + X (Twitter) clients, types, tool factories,
 * and the platform-agnostic soul builder. Phase 2 adds: defense pipeline,
 * local defense tools, entity memory helpers.
 *
 * See docs/architecture/feed/README.md.
 */

// ── Shared platform-agnostic shapes ─────────────────────────────
export {
  VoiceSample,
  InspirationSource,
  InspirationCandidate,
} from './types.js'

// ── Threads ─────────────────────────────────────────────────────
export * from './threads/types.js'
export {
  ThreadsApiError,
  ThreadsPublishStepError,
  exchangeCodeForShortLivedToken,
  exchangeShortLivedForLongLived,
  refreshLongLivedToken,
  getProfile,
  createPost,
  createReplyContainer,
  publishContainer,
  getContainerStatus,
  deletePost,
  getMediaDetails,
  getMediaInsights,
  getProfileInsights,
  listReplies,
  listMentions,
  listOwnPosts,
  listOwnReplies,
  listProfilePosts,
  searchThreads,
  hideReply,
  replyToPost,
  type CreatePostParams,
  type ThreadsTerminalStatus,
} from './threads/client.js'
export { createDistributionTools, type ThreadsApi } from './threads/tools.js'
export {
  decodeThreadsShortcode,
  INSTAGRAM_EPOCH_MS,
  type DecodedShortcode,
} from './threads/shortcode.js'

// Draft-session UI tool. Exported via the same surface as other distribution
// tools so the API layer's injector can pull it from one place.
export {
  buildProposeDraftsTool,
  PROPOSE_DRAFTS_TOOL_NAME,
} from '../distribution/draft-tools.js'

// The soul builder is platform-agnostic — all platforms share the L1 prompt
// and surface their identity only through tool descriptions (Tool-awareness
// rule in root CLAUDE.md). Lives under threads/ for now; promoting it to
// distribution/soul.ts is an optional cleanup.
export {
  buildFeedSystemPrompt,
  type FeedPromptMode,
  type BuildFeedPromptParams,
} from './threads/soul.js'

// ── Twitter (X) ─────────────────────────────────────────────────
export * from './twitter/types.js'
export {
  TwitterApiError,
  exchangeCodeForToken as twitterExchangeCodeForToken,
  refreshAccessToken as twitterRefreshAccessToken,
  getAuthenticatedProfile as getTwitterAuthenticatedProfile,
  createTweet,
  deleteTweet,
  getTweet,
  getTweetWithAuthor,
  getUserTimeline,
  listOwnTweets as twitterListOwnTweets,
  listHomeTimeline as twitterListHomeTimelineClient,
  listFromList as twitterListFromListClient,
  searchRecent as twitterSearchRecent,
  listOwnedLists as twitterListOwnedLists,
  listMembershipsForUser as twitterListMembershipsForUser,
  listReplies as twitterListTweetReplies,
  listMentions as twitterListUserMentions,
  listQuotes as twitterListQuoteTweets,
  replyToTweet,
  hideReply as twitterHideReplyClient,
  type CreateTweetParams,
} from './twitter/client.js'
export {
  createTwitterDistributionTools,
  type TwitterApi,
} from './twitter/tools.js'
export {
  AUTHORIZE_URL as TWITTER_AUTHORIZE_URL,
  SCOPES as TWITTER_SCOPES,
  buildAuthorizeUrl as buildTwitterAuthorizeUrl,
  type BuildAuthorizeUrlParams as BuildTwitterAuthorizeUrlParams,
} from './twitter/oauth.js'

// ── Defense pipeline (Phase 2, shared across platforms) ──────────
export {
  spotlight,
  sanitize as spotlightSanitize,
  SPOTLIGHT_MARKERS,
} from './defense/spotlighting.js'
export {
  classifyCheap,
  classifyStructured,
  ReplyCategory,
  ReplySentiment,
  StructuredClassification,
  type CheapDecision,
  type CheapDropReason,
  type ClassifyStructuredOptions,
  type ClassifyStructuredResult,
} from './defense/classifier.js'
export {
  rateReputationGate,
  evaluatePolicy,
  isAutoReplyEligible,
  type TrustTier,
  type RateGateDecision,
  type RateGateDropReason,
  type RateGateInput,
  type PolicyDecision,
  type PolicyReason,
  type ReplyPolicy,
  type EvaluatePolicyInput,
} from './defense/policy.js'
export {
  processReply,
  type PipelineInput,
  type PipelineResult,
  type PipelineDeps,
  type PipelineEventsStore,
  type PipelineEntityStore,
  type PipelineHider,
  type PipelineReplyPoster,
} from './pipeline.js'
export {
  mintApprovalToken,
  verifyApprovalToken,
  hashApprovalText,
  type ApprovalTokenPayload,
  type ApprovalTokenMintOptions,
  type ApprovalTokenVerifyOptions,
  type ApprovalTokenVerifyResult,
  type ApprovalTokenFailure,
} from './defense/approval-token.js'
export {
  generateDraft,
  DRAFT_MAX_LENGTH,
  type GenerateDraftOptions,
  type GenerateDraftResult,
} from './defense/draft.js'
export {
  judgeDraft,
  SafetyJudgement,
  SafetyFailure,
  type JudgeDraftOptions,
  type JudgeDraftResult,
} from './defense/safety.js'
