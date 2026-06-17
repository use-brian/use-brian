/**
 * Parse a GitHub webhook delivery into a typed `GithubNormalizedEvent`.
 *
 * Returns `null` for any webhook type not represented in the default
 * rule templates — the orchestrator emits no envelope for those, the
 * route handler can log them for telemetry.
 *
 * Mapping (spec ingest.md §GitHub lines 749–756 — token strings match
 * the rule templates exactly so the `event_type` filter fires):
 *
 *   X-GitHub-Event=push                          → 'push'
 *   pull_request    action=opened                → 'pull_request.opened'
 *   pull_request    action=closed && merged=true → 'pull_request.merged'
 *   pull_request    action=closed && !merged     → 'pull_request.closed'
 *   issues          action=opened                → 'issue.opened'
 *   issues          action=closed                → 'issue.closed'
 *   release         action=published             → 'release.published'
 *   security_advisory  action=published          → 'security_alert'
 *   dependabot_alert        any                  → 'security_alert'
 *   secret_scanning_alert   any                  → 'security_alert'
 *   anything else                                → null
 *
 * [COMP:brain/source-adapters/github]
 */

import { z } from 'zod'

import { getHeader } from './signature.js'
import type {
  GithubDeliveryContext,
  GithubEventType,
  GithubNormalizedEvent,
  GithubPushDetail,
  GithubWebhookInput,
} from './types.js'

// ── Zod schemas — permissive, passthrough unknown fields ──────────────

const userSchema = z
  .object({
    login: z.string().min(1),
    type: z.string().optional(),
  })
  .passthrough()

const repoSchema = z
  .object({
    full_name: z.string().min(1),
    default_branch: z.string().optional(),
  })
  .passthrough()

const pushCommitSchema = z
  .object({
    added: z.array(z.string()).optional().default([]),
    removed: z.array(z.string()).optional().default([]),
    modified: z.array(z.string()).optional().default([]),
  })
  .passthrough()

const pushPayloadSchema = z
  .object({
    ref: z.string().min(1),
    before: z.string().min(1),
    after: z.string().min(1),
    repository: repoSchema,
    sender: userSchema,
    commits: z.array(pushCommitSchema).optional().default([]),
    head_commit: z
      .object({
        id: z.string().optional(),
        timestamp: z.string().optional(),
        author: z
          .object({ name: z.string().optional(), email: z.string().optional() })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough()

const pullRequestPayloadSchema = z
  .object({
    action: z.string().min(1),
    pull_request: z
      .object({
        number: z.number().int(),
        merged: z.boolean().optional(),
        updated_at: z.string().optional(),
        created_at: z.string().optional(),
        base: z
          .object({ ref: z.string().optional() })
          .passthrough()
          .optional(),
        user: userSchema.optional(),
      })
      .passthrough(),
    repository: repoSchema,
    sender: userSchema,
  })
  .passthrough()

const issuesPayloadSchema = z
  .object({
    action: z.string().min(1),
    issue: z
      .object({
        number: z.number().int(),
        updated_at: z.string().optional(),
        created_at: z.string().optional(),
      })
      .passthrough(),
    repository: repoSchema,
    sender: userSchema,
  })
  .passthrough()

const releasePayloadSchema = z
  .object({
    action: z.string().min(1),
    release: z
      .object({
        id: z.number().int().optional(),
        tag_name: z.string().optional(),
        published_at: z.string().nullable().optional(),
      })
      .passthrough(),
    repository: repoSchema,
    sender: userSchema,
  })
  .passthrough()

const securityAdvisoryPayloadSchema = z
  .object({
    action: z.string().min(1).optional(),
    security_advisory: z
      .object({
        ghsa_id: z.string().optional(),
        published_at: z.string().optional(),
      })
      .passthrough()
      .optional(),
    repository: repoSchema.optional(),
    sender: userSchema.optional(),
  })
  .passthrough()

const genericAlertPayloadSchema = z
  .object({
    action: z.string().optional(),
    alert: z
      .object({
        number: z.number().int().optional(),
        created_at: z.string().optional(),
      })
      .passthrough()
      .optional(),
    repository: repoSchema,
    sender: userSchema.optional(),
  })
  .passthrough()

// ── Helpers ──────────────────────────────────────────────────────────

function parseTimestamp(v: string | undefined | null, fallback: Date): Date {
  if (!v) return fallback
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? fallback : d
}

function isBotLogin(login: string, type?: string): boolean {
  if (type === 'Bot') return true
  return login.endsWith('[bot]')
}

function branchFromRef(ref: string): string | null {
  const prefix = 'refs/heads/'
  if (ref.startsWith(prefix)) return ref.slice(prefix.length)
  return null
}

function filesFromCommits(
  commits: Array<{ added: string[]; removed: string[]; modified: string[] }>,
): string[] {
  const set = new Set<string>()
  for (const c of commits) {
    for (const f of c.added) set.add(f)
    for (const f of c.removed) set.add(f)
    for (const f of c.modified) set.add(f)
  }
  return [...set]
}

// ── Per-event normalizers ─────────────────────────────────────────────

function normalizePush(
  payload: z.infer<typeof pushPayloadSchema>,
  ctx: GithubDeliveryContext,
  deliveryId: string,
  receivedAt: Date,
): GithubNormalizedEvent {
  const branch = branchFromRef(payload.ref)
  const push: GithubPushDetail = {
    commit_from: payload.before,
    commit_to: payload.after,
    default_branch: branch !== null && branch === ctx.default_branch,
    files_changed: filesFromCommits(payload.commits),
  }
  const occurred_at = parseTimestamp(payload.head_commit?.timestamp, receivedAt)
  return {
    event_type: 'push',
    delivery_id: deliveryId,
    occurred_at,
    repo: payload.repository.full_name,
    branch,
    actor: {
      login: payload.sender.login,
      is_bot: isBotLogin(payload.sender.login, payload.sender.type),
    },
    payload,
    push,
  }
}

function normalizePullRequest(
  payload: z.infer<typeof pullRequestPayloadSchema>,
  deliveryId: string,
  receivedAt: Date,
): GithubNormalizedEvent | null {
  let event_type: GithubEventType
  if (payload.action === 'opened') {
    event_type = 'pull_request.opened'
  } else if (payload.action === 'closed') {
    event_type = payload.pull_request.merged ? 'pull_request.merged' : 'pull_request.closed'
  } else {
    return null
  }
  const occurred_at = parseTimestamp(
    payload.pull_request.updated_at ?? payload.pull_request.created_at,
    receivedAt,
  )
  return {
    event_type,
    delivery_id: deliveryId,
    occurred_at,
    repo: payload.repository.full_name,
    branch: payload.pull_request.base?.ref ?? null,
    actor: {
      login: payload.sender.login,
      is_bot: isBotLogin(payload.sender.login, payload.sender.type),
    },
    payload,
  }
}

function normalizeIssues(
  payload: z.infer<typeof issuesPayloadSchema>,
  deliveryId: string,
  receivedAt: Date,
): GithubNormalizedEvent | null {
  let event_type: GithubEventType
  if (payload.action === 'opened') {
    event_type = 'issue.opened'
  } else if (payload.action === 'closed') {
    event_type = 'issue.closed'
  } else {
    return null
  }
  const occurred_at = parseTimestamp(
    payload.issue.updated_at ?? payload.issue.created_at,
    receivedAt,
  )
  return {
    event_type,
    delivery_id: deliveryId,
    occurred_at,
    repo: payload.repository.full_name,
    branch: null,
    actor: {
      login: payload.sender.login,
      is_bot: isBotLogin(payload.sender.login, payload.sender.type),
    },
    payload,
  }
}

function normalizeRelease(
  payload: z.infer<typeof releasePayloadSchema>,
  deliveryId: string,
  receivedAt: Date,
): GithubNormalizedEvent | null {
  if (payload.action !== 'published') return null
  const occurred_at = parseTimestamp(payload.release.published_at, receivedAt)
  return {
    event_type: 'release.published',
    delivery_id: deliveryId,
    occurred_at,
    repo: payload.repository.full_name,
    branch: null,
    actor: {
      login: payload.sender.login,
      is_bot: isBotLogin(payload.sender.login, payload.sender.type),
    },
    payload,
  }
}

function normalizeSecurityAdvisory(
  payload: z.infer<typeof securityAdvisoryPayloadSchema>,
  deliveryId: string,
  receivedAt: Date,
): GithubNormalizedEvent | null {
  if (payload.action && payload.action !== 'published') return null
  if (!payload.repository) return null
  const occurred_at = parseTimestamp(payload.security_advisory?.published_at, receivedAt)
  return {
    event_type: 'security_alert',
    delivery_id: deliveryId,
    occurred_at,
    repo: payload.repository.full_name,
    branch: null,
    actor: {
      login: payload.sender?.login ?? 'github',
      is_bot: true,
    },
    payload,
  }
}

function normalizeGenericAlert(
  payload: z.infer<typeof genericAlertPayloadSchema>,
  deliveryId: string,
  receivedAt: Date,
): GithubNormalizedEvent {
  const occurred_at = parseTimestamp(payload.alert?.created_at, receivedAt)
  return {
    event_type: 'security_alert',
    delivery_id: deliveryId,
    occurred_at,
    repo: payload.repository.full_name,
    branch: null,
    actor: {
      login: payload.sender?.login ?? 'github',
      is_bot: true,
    },
    payload,
  }
}

// ── Public entry point ───────────────────────────────────────────────

export function normalizeGithubWebhook(
  input: GithubWebhookInput,
  receivedAt: Date = new Date(),
): GithubNormalizedEvent | null {
  const eventName = getHeader(input.headers, 'x-github-event')
  if (!eventName) return null
  const deliveryId = getHeader(input.headers, 'x-github-delivery') ?? ''

  let body: unknown
  try {
    body = JSON.parse(input.rawBody)
  } catch {
    return null
  }

  switch (eventName) {
    case 'push': {
      const parsed = pushPayloadSchema.safeParse(body)
      if (!parsed.success) return null
      return normalizePush(parsed.data, input.deliveryContext, deliveryId, receivedAt)
    }
    case 'pull_request': {
      const parsed = pullRequestPayloadSchema.safeParse(body)
      if (!parsed.success) return null
      return normalizePullRequest(parsed.data, deliveryId, receivedAt)
    }
    case 'issues': {
      const parsed = issuesPayloadSchema.safeParse(body)
      if (!parsed.success) return null
      return normalizeIssues(parsed.data, deliveryId, receivedAt)
    }
    case 'release': {
      const parsed = releasePayloadSchema.safeParse(body)
      if (!parsed.success) return null
      return normalizeRelease(parsed.data, deliveryId, receivedAt)
    }
    case 'security_advisory': {
      const parsed = securityAdvisoryPayloadSchema.safeParse(body)
      if (!parsed.success) return null
      return normalizeSecurityAdvisory(parsed.data, deliveryId, receivedAt)
    }
    case 'dependabot_alert':
    case 'secret_scanning_alert': {
      const parsed = genericAlertPayloadSchema.safeParse(body)
      if (!parsed.success) return null
      return normalizeGenericAlert(parsed.data, deliveryId, receivedAt)
    }
    default:
      return null
  }
}
