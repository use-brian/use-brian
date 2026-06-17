import { query, queryWithRLS } from './client.js'

/**
 * Chat-home onboarding signal state — drives which nudges show on the
 * chat-centric home (docs/architecture/features/web-ui.md → "The chat-centric
 * home"). Each boolean is a per-workspace fact; a nudge hides once its signal
 * is true (or the user dismisses it — see users.dismissed_nudges).
 *
 * [COMP:api/home-setup-state]
 */
export type HomeSetupState = {
  profileSet: boolean
  companyResearched: boolean
  brainPopulated: boolean
  connectors: {
    googleCalendar: boolean
    slack: boolean
    telegram: boolean
    notion: boolean
    github: boolean
    fathom: boolean
  }
  aiClientConnected: boolean
}

/** True if `userId` is a member of `workspaceId`. Gate workspace-scoped reads on this. */
export async function isWorkspaceMember(userId: string, workspaceId: string): Promise<boolean> {
  const r = await query<{ ok: number }>(
    `SELECT 1 AS ok FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 LIMIT 1`,
    [workspaceId, userId],
  )
  return r.rows.length > 0
}

/**
 * Assemble the home setup-state for one workspace. The brain-row existence
 * checks (self person / company / any content) run RLS-gated so they only
 * reflect what this user can see; the connector / channel / brain-key reads
 * are workspace-scoped system reads and MUST be gated by `isWorkspaceMember`
 * at the route boundary first.
 */
export async function getHomeSetupState(userId: string, workspaceId: string): Promise<HomeSetupState> {
  const [brain, connectors, channels, keys] = await Promise.all([
    queryWithRLS<{ profile: boolean; company: boolean; populated: boolean }>(
      userId,
      `SELECT
         EXISTS(SELECT 1 FROM entities WHERE workspace_id = $1 AND kind = 'person'
                AND attributes->>'self' = 'true' AND valid_to IS NULL) AS profile,
         EXISTS(SELECT 1 FROM companies WHERE workspace_id = $1 AND valid_to IS NULL) AS company,
         (EXISTS(SELECT 1 FROM memories WHERE workspace_id = $1 AND valid_to IS NULL)
          OR EXISTS(SELECT 1 FROM entities WHERE workspace_id = $1 AND valid_to IS NULL)) AS populated`,
      [workspaceId],
    ),
    query<{ provider: string }>(
      `SELECT provider FROM connector_instance
       WHERE workspace_id = $1 AND scope = 'workspace' AND connected = true`,
      [workspaceId],
    ),
    query<{ channel_type: string }>(
      `SELECT channel_type FROM channels WHERE workspace_id = $1 AND status = 'active'`,
      [workspaceId],
    ),
    query<{ ok: number }>(
      `SELECT 1 AS ok FROM brain_keys WHERE workspace_id = $1 AND status = 'active' LIMIT 1`,
      [workspaceId],
    ),
  ])

  const providers = new Set(connectors.rows.map((r) => r.provider))
  const channelTypes = new Set(channels.rows.map((r) => r.channel_type))
  const has = (p: string) => providers.has(p)
  const row = brain.rows[0]

  return {
    profileSet: row?.profile ?? false,
    companyResearched: row?.company ?? false,
    brainPopulated: row?.populated ?? false,
    connectors: {
      googleCalendar: has('google-calendar'),
      // Slack/Telegram count as connected either as a workspace connector
      // instance or as an active channel integration.
      slack: has('slack') || channelTypes.has('slack'),
      telegram: has('telegram') || channelTypes.has('telegram'),
      notion: has('notion'),
      github: has('github'),
      fathom: has('fathom'),
    },
    aiClientConnected: keys.rows.length > 0,
  }
}

/**
 * A single brain-glance item. `kind` is the entity `kind`
 * (person | company | project | product | deal) or the literal `'memory'`.
 *
 * [COMP:api/home-glance]
 */
export type HomeGlanceItem = { id: string; label: string; kind: string; createdAt: string }

/**
 * Read-only "Your brain" glance for the chat-home right rail
 * (docs/architecture/features/web-ui.md → "The chat-centric home"):
 *   - `learnedRecently`: brain writes (entities + memories) created on or
 *     after `since` (the caller passes a recent window, e.g. 30 days), newest
 *     first, capped at 6. Each carries `createdAt` so the rail shows a date.
 *   - `recent`: up to 6 most-recent entities, untimed — the catch-all list,
 *     distinct from the recent-activity feed. Each is a full `HomeGlanceItem`
 *     (id + kind) so the rail can open it in the brain detail drawer, not just
 *     a display name.
 */
export type HomeGlance = { learnedRecently: HomeGlanceItem[]; recent: HomeGlanceItem[] }

/**
 * Assemble the brain glance for one workspace. Both reads are RLS-gated via
 * `queryWithRLS` so they only reflect rows this user can see; the route MUST
 * still gate on `isWorkspaceMember` first (same as `getHomeSetupState`).
 *
 * `learnedRecently` UNIONs current entities (label = display_name, kind = the
 * entity kind) with current memories (label = first ~80 chars of summary,
 * kind = 'memory') **created at or after `since`** — so it reflects what was
 * actually learned in the recent window, not the most-recent rows of all
 * time. `recent` is the 6 most-recent entities (no time filter), each a full
 * item (id + kind) so the rail can open it in the detail drawer.
 */
export async function getHomeGlance(
  userId: string,
  workspaceId: string,
  since: string,
): Promise<HomeGlance> {
  const toItem = (r: {
    id: string
    label: string
    kind: string
    created_at: string
  }): HomeGlanceItem => ({
    id: r.id,
    label: r.label,
    kind: r.kind,
    createdAt: typeof r.created_at === "string" ? r.created_at : new Date(r.created_at).toISOString(),
  })
  const [learned, recent] = await Promise.all([
    queryWithRLS<{ id: string; label: string; kind: string; created_at: string }>(
      userId,
      `(
         SELECT id, display_name AS label, kind, created_at
         FROM entities
         WHERE workspace_id = $1 AND valid_to IS NULL AND created_at >= $2
       )
       UNION ALL
       (
         SELECT id, left(summary, 80) AS label, 'memory' AS kind, created_at
         FROM memories
         WHERE workspace_id = $1 AND valid_to IS NULL AND created_at >= $2
       )
       ORDER BY created_at DESC
       LIMIT 6`,
      [workspaceId, since],
    ),
    queryWithRLS<{ id: string; label: string; kind: string; created_at: string }>(
      userId,
      `SELECT id, display_name AS label, kind, created_at
       FROM entities
       WHERE workspace_id = $1 AND valid_to IS NULL
       ORDER BY created_at DESC
       LIMIT 6`,
      [workspaceId],
    ),
  ])

  return {
    learnedRecently: learned.rows.map(toItem),
    recent: recent.rows.map(toItem),
  }
}
