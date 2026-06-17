/**
 * Local type vocabulary for the GitHub source adapter.
 *
 * `ConnectorAdapter` (the shared interface from WU-3.7) and the internal
 * `Event` shape do not exist yet — these types are intentionally narrow
 * so a follow-up can replace them with the canonical interfaces
 * mechanically.
 *
 * Spec: docs/plans/company-brain/ingest.md §Adapter strategy + §GitHub.
 *
 * [COMP:brain/source-adapters/github]
 */

import type { EpisodeEnvelope } from '../../types.js'
import type { Sensitivity } from '../../../security/sensitivity.js'

/**
 * Filter-time event type tokens — match the spec's default rule
 * templates verbatim (ingest.md §GitHub, lines 749–756):
 *   - `pull_request.merged`, `pull_request.opened`, `pull_request.closed`
 *   - `issue.opened`, `issue.closed` (singular per spec, GitHub uses
 *     plural `issues` webhook — normalizer reconciles)
 *   - `release.published`
 *   - `security_alert` (spec wording; aliased from GitHub's
 *     `security_advisory`, `dependabot_alert`, `secret_scanning_alert`)
 *   - `push`
 */
export type GithubEventType =
  | 'push'
  | 'pull_request.opened'
  | 'pull_request.merged'
  | 'pull_request.closed'
  | 'issue.opened'
  | 'issue.closed'
  | 'release.published'
  | 'security_alert'

/** Push-event detail lifted out of payload for envelope construction. */
export type GithubPushDetail = {
  commit_from: string
  commit_to: string
  default_branch: boolean
  files_changed: string[]
}

/** Normalized webhook event handed to filters + envelope mapper. */
export type GithubNormalizedEvent = {
  event_type: GithubEventType
  delivery_id: string
  occurred_at: Date
  repo: string
  branch: string | null
  actor: { login: string; is_bot: boolean }
  /** Raw event payload; kept for envelope-mapper field lookups. */
  payload: Record<string, unknown>
  /** Set when `event_type === 'push'`. */
  push?: GithubPushDetail
}

/**
 * Context the HTTP route injects per delivery. Carries everything the
 * webhook payload does not know about: visibility ids, hmac secret,
 * per-instance default branch.
 */
export type GithubDeliveryContext = {
  workspace_id: string
  user_id: string | null
  assistant_id: string | null
  created_by_user_id: string
  created_by_assistant_id: string | null
  /** Defaults to `'internal'` when omitted. */
  sensitivity?: Sensitivity
  /** Connector id stamped into `source_ref` for `connector_action` envelopes. */
  connector_id: string
  /** Default branch for this connector instance — drives the github_sync decision. */
  default_branch: string
  /** Shared HMAC secret for X-Hub-Signature-256. */
  hmac_secret: string
}

/** Adapter entry-point input — primitives only, framework-agnostic. */
export type GithubWebhookInput = {
  rawBody: string
  headers: Record<string, string>
  deliveryContext: GithubDeliveryContext
}

/** Filter parameter shape — uniform across the four GitHub filters. */
export type GithubFilterParams = {
  values: string[]
}

export type GithubFilterImplementation = (
  event: GithubNormalizedEvent,
  params: GithubFilterParams,
) => boolean

export type GithubFilterImplementations = {
  event_type: GithubFilterImplementation
  repo_match: GithubFilterImplementation
  actor_match: GithubFilterImplementation
  branch_match: GithubFilterImplementation
}

/** Default rule template descriptor — matches `ingest.md` rule schema. */
export type GithubDefaultRule = {
  filter_type: 'event_type' | 'repo_match' | 'actor_match' | 'branch_match' | 'always'
  params: Record<string, unknown>
  routing_mode: 'realtime' | 'scheduled' | 'drop'
  routing_schedule?: string
  alert?: boolean
}

/**
 * Adapter shape — local to this module until WU-3.7 lands the canonical
 * `ConnectorAdapter` interface.
 */
export type GithubConnectorAdapter = {
  source: 'github'
  receive(input: GithubWebhookInput): Promise<EpisodeEnvelope[]>
  filterImplementations: GithubFilterImplementations
  defaultRules: ReadonlyArray<GithubDefaultRule>
}
