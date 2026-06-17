/**
 * GitHub adapter — `extractWrites` produces typed entity + edge writes
 * directly from structured webhook payloads, before Pipeline B's LLM
 * extraction runs.
 *
 * Self-interpretation at envelope time: the adapter KNOWS what each
 * event encodes (a PR is a pull_request, a push has a repo + commits),
 * so deterministic writes flow without LLM tokens.
 *
 * Spec: docs/architecture/brain/classification/README.md
 *   §F2 B1 Connector adapter
 *   §Decision 3 — extractWrites
 *
 * [COMP:brain/source-adapters/github]
 */

import type { CompositionWrite } from '../../../classification/compose.js'
import type { DerivedEdge, DerivedEntity } from '../../../classification/types.js'
import type { GithubNormalizedEvent } from './types.js'

const REPO_KIND = 'repository' as const
const PERSON_KIND = 'person' as const
const REPO_AUTHOR_EDGE = 'documented_by' as const

function canonicalRepoUrl(repo: string): string {
  return `https://github.com/${repo}`
}

function repoEntity(repo: string): DerivedEntity {
  const [owner = '', name = repo] = repo.split('/')
  return {
    ref: 'repository',
    kind: REPO_KIND,
    display_name: name,
    canonical_id: canonicalRepoUrl(repo),
    attributes: {
      provider: 'github',
      owner: owner.toLowerCase(),
      repo_name: name,
    },
  }
}

function actorEntity(login: string, isBot: boolean): DerivedEntity | null {
  // Skip bot accounts — they're system identities, not persons.
  if (isBot) return null
  if (!login) return null
  return {
    ref: 'actor',
    kind: PERSON_KIND,
    display_name: login,
    canonical_id: `https://github.com/${login}`,
    attributes: { github_login: login },
  }
}

/**
 * Map a normalized GitHub event into the writes the adapter wants to
 * deterministically produce. Returns null when there's nothing to write
 * (e.g. push from a bot account that we deliberately skip).
 *
 * Composition executor handles dedup by canonical_id, so repeated PR
 * webhooks on the same repo are idempotent.
 */
export function extractWritesFromGithubEvent(
  event: GithubNormalizedEvent,
): CompositionWrite | null {
  const repo = repoEntity(event.repo)
  const actor = actorEntity(event.actor.login, event.actor.is_bot)

  const entities: DerivedEntity[] = []
  const edges: DerivedEdge[] = []

  if (actor) {
    entities.push(actor)
    edges.push({
      // Repo is `primary` (composition executor reserves that ref for
      // the primary entity); actor is a derived entity with ref='actor'.
      source_ref: 'primary',
      target_ref: 'actor',
      edge_type: REPO_AUTHOR_EDGE,
      attributes: {
        github_event: event.event_type,
        delivery_id: event.delivery_id,
      },
    })
  }

  return {
    primary: { ...repo, ref: 'primary' },
    entities,
    edges,
  } satisfies CompositionWrite
}
