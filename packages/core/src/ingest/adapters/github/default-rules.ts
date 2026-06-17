/**
 * Default GitHub rules — verbatim from ingest.md §GitHub lines 749–756.
 *
 *   1. event_type   { pull_request.merged, security_alert, release }  → realtime + alert
 *   2. event_type   { pull_request.opened, issue.opened }              → realtime
 *   3. branch_match { main }                                           → realtime
 *   4. actor_match  { dependabot[bot], renovate[bot] }                 → drop
 *   5. always                                                          → scheduled '0 18 * * 1-5'
 *
 * Seeded per `connector_instance` when a new GitHub connector lands;
 * founder customises via the agent.
 *
 * [COMP:brain/source-adapters/github]
 */

import type { GithubDefaultRule } from './types.js'

export const githubDefaultRules: ReadonlyArray<GithubDefaultRule> = [
  {
    filter_type: 'event_type',
    params: { values: ['pull_request.merged', 'security_alert', 'release.published'] },
    routing_mode: 'realtime',
    alert: true,
  },
  {
    filter_type: 'event_type',
    params: { values: ['pull_request.opened', 'issue.opened'] },
    routing_mode: 'realtime',
  },
  {
    filter_type: 'branch_match',
    params: { values: ['main'] },
    routing_mode: 'realtime',
  },
  {
    filter_type: 'actor_match',
    params: { values: ['dependabot[bot]', 'renovate[bot]'] },
    routing_mode: 'drop',
  },
  {
    filter_type: 'always',
    params: {},
    routing_mode: 'scheduled',
    routing_schedule: '0 18 * * 1-5',
  },
]
