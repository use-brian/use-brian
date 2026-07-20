/**
 * Ingest-rule placeholder resolver — Pipeline C.
 *
 * The seeded default rules for Gmail and Calendar route by `:placeholder`
 * tokens (`:crm_contacts`, `:workspace_members`) rather than literal
 * email lists, so "realtime for mail from a known contact" stays correct
 * as the workspace's people change. The ingest engine
 * (`createIngestEngine`, `@use-brian/core`) calls a `PlaceholderResolver`
 * at event-evaluation time — never at rule-creation time — to expand
 * each token to its current literal list (ingest.md §"placeholder
 * resolution — dynamic at evaluation time").
 *
 * This is that resolver, fulfilled with workspace-scoped SQL. Emails are
 * lowercased to match the adapter-normalized event fields — Gmail's
 * `sender` and Calendar's `attendees` / `organizer` all arrive already
 * lowercased from their normalizers.
 *
 * An unknown placeholder resolves to `[]`; the engine then treats the
 * rule as non-matching and falls through to the next rule — never
 * crashes. GitHub and Fathom default rules carry no placeholders, so
 * their pollers keep the inert `async () => []` resolver.
 *
 * [COMP:api/ingest-placeholder-resolver]
 */

import type { IngestContext } from '@use-brian/core'
import { query } from '../db/client.js'

/** Lowercased emails of every CRM contact in the workspace. Contacts are
 *  `entities` rows with `kind = 'person'` post-collapse (crm-entity-unification);
 *  the email lives in `attributes.email`. */
async function crmContactEmails(workspaceId: string): Promise<string[]> {
  const res = await query<{ email: string }>(
    `SELECT DISTINCT lower(attributes->>'email') AS email
       FROM entities
      WHERE kind = 'person'
        AND workspace_id = $1
        AND valid_to IS NULL
        AND attributes->>'email' IS NOT NULL`,
    [workspaceId],
  )
  return res.rows.map((r) => r.email)
}

/** Lowercased emails of every member of the workspace. */
async function workspaceMemberEmails(workspaceId: string): Promise<string[]> {
  const res = await query<{ email: string }>(
    `SELECT DISTINCT lower(u.email) AS email
       FROM users u
       JOIN workspace_members wm ON wm.user_id = u.id
      WHERE wm.workspace_id = $1 AND u.email IS NOT NULL AND u.email <> ''`,
    [workspaceId],
  )
  return res.rows.map((r) => r.email)
}

/**
 * `PlaceholderResolver` for the ingest engine — wired into the Calendar
 * poller's engine (`buildCalendarIngestEngine`). Uses the bare system
 * `query()`: the poller is a trusted worker resolving tokens for an
 * already-resolved workspace, the same posture as the pollers'
 * `resolveWorkspaceId`.
 */
export async function resolveIngestPlaceholders(
  placeholder: string,
  ctx: IngestContext,
): Promise<string[]> {
  switch (placeholder) {
    case ':crm_contacts':
      return crmContactEmails(ctx.workspace_id)
    case ':workspace_members':
      return workspaceMemberEmails(ctx.workspace_id)
    default:
      // Not-yet-supported token (`:priority_channels`, `:assistant`,
      // `:watch_list`, …) — degrade to no-match rather than crash.
      return []
  }
}
