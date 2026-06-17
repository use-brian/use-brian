/**
 * GitHub source-specific filter implementations (ingest.md line 519):
 *
 *   event_type   { values: string[] }   ← matches `event.event_type`
 *   repo_match   { values: string[] }   ← matches `event.repo` (owner/name)
 *   actor_match  { values: string[] }   ← matches `event.actor.login`
 *   branch_match { values: string[] }   ← matches `event.branch` (null → no match)
 *
 * All pure functions: (event, params) → boolean. No I/O.
 *
 * [COMP:brain/source-adapters/github]
 */

import type { GithubFilterImplementations } from './types.js'

export const githubFilterImplementations: GithubFilterImplementations = {
  event_type: (event, params) => params.values.includes(event.event_type),
  repo_match: (event, params) => params.values.includes(event.repo),
  actor_match: (event, params) => params.values.includes(event.actor.login),
  branch_match: (event, params) =>
    event.branch !== null && params.values.includes(event.branch),
}
