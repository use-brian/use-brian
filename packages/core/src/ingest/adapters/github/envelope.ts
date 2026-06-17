/**
 * Map `GithubNormalizedEvent` → `EpisodeEnvelope`.
 *
 * Source-kind routing (load-bearing):
 *
 *   event_type === 'push' && push.default_branch  →  'github_sync'
 *   everything else                                →  'connector_action'
 *
 * Pushes to feature branches are workflow signals, not KB content — they
 * go through `connector_action` so Pipeline B does not touch `kb_chunks`
 * (ingest.md line 206).
 *
 * [COMP:brain/source-adapters/github]
 */

import type { EpisodeActor, EpisodeEnvelope, SourceKind } from '../../types.js'
import type { GithubDeliveryContext, GithubNormalizedEvent } from './types.js'

function externalIdFor(event: GithubNormalizedEvent): string | undefined {
  const payload = event.payload as Record<string, unknown>
  switch (event.event_type) {
    case 'pull_request.opened':
    case 'pull_request.merged':
    case 'pull_request.closed': {
      const pr = payload.pull_request as { number?: number } | undefined
      return pr?.number != null ? String(pr.number) : undefined
    }
    case 'issue.opened':
    case 'issue.closed': {
      const issue = payload.issue as { number?: number } | undefined
      return issue?.number != null ? String(issue.number) : undefined
    }
    case 'release.published': {
      const rel = payload.release as { tag_name?: string; id?: number } | undefined
      return rel?.tag_name ?? (rel?.id != null ? String(rel.id) : undefined)
    }
    case 'security_alert': {
      const adv = payload.security_advisory as { ghsa_id?: string } | undefined
      if (adv?.ghsa_id) return adv.ghsa_id
      const alert = payload.alert as { number?: number } | undefined
      return alert?.number != null ? String(alert.number) : undefined
    }
    case 'push':
      return event.push?.commit_to
    default:
      return undefined
  }
}

function summaryFor(event: GithubNormalizedEvent): string {
  const payload = event.payload as Record<string, unknown>
  switch (event.event_type) {
    case 'pull_request.opened':
    case 'pull_request.merged':
    case 'pull_request.closed': {
      const pr = payload.pull_request as {
        title?: string
        body?: string
        html_url?: string
        number?: number
      } | undefined
      return JSON.stringify({
        action: event.event_type,
        number: pr?.number,
        title: pr?.title,
        body: pr?.body,
        html_url: pr?.html_url,
      })
    }
    case 'issue.opened':
    case 'issue.closed': {
      const issue = payload.issue as {
        title?: string
        body?: string
        html_url?: string
        number?: number
      } | undefined
      return JSON.stringify({
        action: event.event_type,
        number: issue?.number,
        title: issue?.title,
        body: issue?.body,
        html_url: issue?.html_url,
      })
    }
    case 'release.published': {
      const rel = payload.release as {
        name?: string
        tag_name?: string
        body?: string
        html_url?: string
      } | undefined
      return JSON.stringify({
        action: event.event_type,
        tag_name: rel?.tag_name,
        name: rel?.name,
        body: rel?.body,
        html_url: rel?.html_url,
      })
    }
    case 'security_alert': {
      const adv = payload.security_advisory as Record<string, unknown> | undefined
      const alert = payload.alert as Record<string, unknown> | undefined
      return JSON.stringify({
        action: event.event_type,
        security_advisory: adv,
        alert,
      })
    }
    case 'push': {
      return JSON.stringify({
        action: 'push',
        ref: (payload.ref as string | undefined) ?? null,
        commit_from: event.push?.commit_from,
        commit_to: event.push?.commit_to,
        files_changed: event.push?.files_changed ?? [],
      })
    }
  }
}

function actorsFor(event: GithubNormalizedEvent): EpisodeActor[] {
  return [{ external_id: event.actor.login, role: 'author' }]
}

function pickSourceKind(event: GithubNormalizedEvent): SourceKind {
  if (event.event_type === 'push' && event.push?.default_branch) {
    return 'github_sync'
  }
  return 'connector_action'
}

function sourceRefFor(
  event: GithubNormalizedEvent,
  source_kind: SourceKind,
  ctx: GithubDeliveryContext,
): Record<string, unknown> {
  if (source_kind === 'github_sync') {
    return {
      source_kind: 'github_sync',
      repo: event.repo,
      commit_from: event.push!.commit_from,
      commit_to: event.push!.commit_to,
      files_changed: event.push!.files_changed,
      delivery_id: event.delivery_id,
    }
  }
  const ref: Record<string, unknown> = {
    source_kind: 'connector_action',
    connector_id: ctx.connector_id,
    action_kind: event.event_type,
    delivery_id: event.delivery_id,
    repo: event.repo,
  }
  const external_id = externalIdFor(event)
  if (external_id !== undefined) ref.external_id = external_id
  if (event.branch !== null) ref.branch = event.branch
  return ref
}

export function toEpisodeEnvelope(
  event: GithubNormalizedEvent,
  ctx: GithubDeliveryContext,
): EpisodeEnvelope {
  const source_kind = pickSourceKind(event)
  return {
    source_kind,
    source_ref: sourceRefFor(event, source_kind, ctx),
    occurred_at: event.occurred_at,
    actors: actorsFor(event),
    content: {
      raw: summaryFor(event),
      attachments: [],
    },
    sensitivity: ctx.sensitivity ?? 'internal',
    user_id: ctx.user_id,
    assistant_id: ctx.assistant_id,
    workspace_id: ctx.workspace_id,
    created_by_user_id: ctx.created_by_user_id,
    created_by_assistant_id: ctx.created_by_assistant_id,
  }
}
