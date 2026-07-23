/**
 * GitHub source adapter (WS-7 / WU-7.3).
 *
 * Receives a raw webhook delivery and emits zero or one `EpisodeEnvelope`
 * for Pipeline B. The barrel `packages/core/src/ingest/index.ts` is left
 * untouched here — the coordinator wires the adapter exports after the
 * WS-7 wave merges.
 *
 * Spec: docs/plans/company-brain/ingest.md §Adapter strategy + §GitHub.
 *
 * [COMP:brain/source-adapters/github]
 */

import type { EpisodeEnvelope } from '../../types.js'

import { githubDefaultRules } from './default-rules.js'
import { toEpisodeEnvelope } from './envelope.js'
import { githubFilterImplementations } from './filters.js'
import { normalizeGithubWebhook } from './normalize.js'
import { getHeader, verifyGithubSignature } from './signature.js'
import type { GithubConnectorAdapter, GithubWebhookInput } from './types.js'

export class GithubSignatureError extends Error {
  constructor(message = 'Invalid GitHub webhook signature') {
    super(message)
    this.name = 'GithubSignatureError'
  }
}

async function receive(input: GithubWebhookInput): Promise<EpisodeEnvelope[]> {
  const header = getHeader(input.headers, 'x-hub-signature-256')
  if (!verifyGithubSignature(input.rawBody, header, input.deliveryContext.hmac_secret)) {
    throw new GithubSignatureError()
  }
  const event = normalizeGithubWebhook(input)
  if (event === null) return []
  return [toEpisodeEnvelope(event, input.deliveryContext)]
}

export const githubAdapter: GithubConnectorAdapter = {
  source: 'github',
  receive,
  filterImplementations: githubFilterImplementations,
  defaultRules: githubDefaultRules,
}

export {
  githubDefaultRules,
  githubFilterImplementations,
  normalizeGithubWebhook,
  toEpisodeEnvelope,
  verifyGithubSignature,
}
export { extractWritesFromGithubEvent } from './extract-writes.js'
export { githubTaskIntent, parseCloseRefs } from './task-lifecycle.js'
export type { GithubTaskIntent, GithubTaskRef } from './task-lifecycle.js'
export type {
  GithubConnectorAdapter,
  GithubDefaultRule,
  GithubDeliveryContext,
  GithubEventType,
  GithubFilterImplementation,
  GithubFilterImplementations,
  GithubFilterParams,
  GithubNormalizedEvent,
  GithubPushDetail,
  GithubWebhookInput,
} from './types.js'
