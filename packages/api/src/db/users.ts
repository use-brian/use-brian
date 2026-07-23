import { query, getPool } from './client.js'
import { generateHandle } from '@use-brian/core'

export type User = {
  id: string
  email: string | null
  name: string | null
  handle: string | null
  avatarUrl: string | null
  /**
   * Avatar provenance (migration 237). NULL / 'google' = synced from the
   * OAuth provider (hot-linked, not copied); 'uploaded' = the user uploaded
   * their own photo, stored under `avatar_storage_key`. Drives the
   * no-clobber guard in `findOrCreateUser` / `promoteChannelUser` so a later
   * provider sign-in can't overwrite an upload. See
   * docs/architecture/platform/user-profile.md → "Avatar precedence".
   */
  avatarSource: string | null
  /** Backend object key for an uploaded avatar. NULL for provider hot-links. */
  avatarStorageKey: string | null
  /** Workspace whose storage binding received the avatar. Migration 367. */
  avatarStorageWorkspaceId: string | null
  /** Immutable gs://, s3://, or file:// origin URI. Migration 367. */
  avatarStorageUri: string | null
  authProvider: string
  authProviderId: string
  /** Per-account Stripe customer link (migration 001). The only billing
   *  field left on `users` after Phase E (migration 257) dropped the
   *  per-user plan/subscription columns — billing is per-workspace now
   *  (`workspaces.plan` / `workspaces.stripe_*`). */
  stripeCustomerId: string | null
  /**
   * Anchor timezone — slow-changing. Used for scheduling (recurring
   * jobs, "every Monday at 9am" semantics). Rewritten only when the
   * tz-drift detector confirms a permanent move.
   */
  timezone: string
  /**
   * Presence timezone — fast-changing. The IANA zone last observed
   * from a live signal (browser `X-Client-Timezone` header). Used
   * for per-turn display ("Current local time"). Null when never
   * observed; consumers must fall back to `timezone` (anchor).
   * See migration 095 and `buildFullSystemPrompt` in
   * `_prompt-builder.ts`.
   */
  lastSeenTz: string | null
  lastSeenTzAt: Date | null
  createdAt: Date
}

/** Shared SELECT column list so the three lookup queries stay in sync. */
const USER_COLUMNS = `
  id, email, name, handle, avatar_url as "avatarUrl",
  avatar_source as "avatarSource", avatar_storage_key as "avatarStorageKey",
  avatar_storage_workspace_id as "avatarStorageWorkspaceId",
  avatar_storage_uri as "avatarStorageUri",
  auth_provider as "authProvider", auth_provider_id as "authProviderId",
  stripe_customer_id as "stripeCustomerId",
  timezone,
  last_seen_tz as "lastSeenTz",
  last_seen_tz_at as "lastSeenTzAt",
  created_at as "createdAt"
` as const

/**
 * Find or create a user by auth provider.
 * Used for both OAuth (Google) and messaging (Telegram) flows.
 *
 * `timezone` is the browser/mini-app IANA zone captured at sign-up.
 * When omitted, the row falls back to the column default ('UTC').
 * See `docs/architecture/platform/auth.md` → "Timezone capture at sign-up"
 * for why we seed at onboarding rather than relying on the
 * attach-on-first-chat backfill alone (telegram-only users who never
 * open web chat stay UTC forever — 2026-04-23 Cynthia incident).
 * Existing users get their timezone backfilled here too when the stored
 * value is still the 'UTC' default, so users who signed up pre-fix are
 * self-healed the first time we see a real zone from them.
 */
export async function findOrCreateUser(params: {
  authProvider: string
  authProviderId: string
  email?: string
  name?: string
  avatarUrl?: string
  timezone?: string
}): Promise<{ user: User; isNew: boolean }> {
  // Try to find existing
  const existing = await query<User>(
    `SELECT ${USER_COLUMNS}
     FROM users WHERE auth_provider = $1 AND auth_provider_id = $2`,
    [params.authProvider, params.authProviderId],
  )

  if (existing.rows.length > 0) {
    // Backfill UTC-default timezone when the caller learned a real one.
    // Non-UTC existing values are preserved — we never overwrite an
    // already-meaningful zone here. The travel-drift detector owns that
    // workflow via an explicit user confirmation.
    const shouldBackfillTz =
      !!params.timezone &&
      params.timezone !== 'UTC' &&
      (!existing.rows[0].timezone || existing.rows[0].timezone === 'UTC')
    // Update name/email/avatar if provided and changed; backfill tz when applicable.
    if (params.name || params.email || params.avatarUrl || shouldBackfillTz) {
      await query(
        // No-clobber: a provider sign-in must never overwrite an uploaded
        // photo. When avatar_source='uploaded' we keep the existing avatar_url;
        // otherwise we COALESCE in the provider photo. We never touch
        // avatar_source on this path. See user-profile.md → "Avatar precedence".
        `UPDATE users SET
           name = COALESCE($1, name),
           email = COALESCE($2, email),
           avatar_url = CASE WHEN avatar_source = 'uploaded' THEN avatar_url ELSE COALESCE($3, avatar_url) END,
           timezone = CASE WHEN $4::text IS NOT NULL THEN $4 ELSE timezone END,
           updated_at = now()
         WHERE auth_provider = $5 AND auth_provider_id = $6`,
        [
          params.name,
          params.email,
          params.avatarUrl,
          shouldBackfillTz ? params.timezone : null,
          params.authProvider,
          params.authProviderId,
        ],
      )
      if (shouldBackfillTz) existing.rows[0].timezone = params.timezone!
    }
    return { user: existing.rows[0], isNew: false }
  }

  // Create new user + Personal workspace + primary assistant in one txn.
  // Generate a unique handle with retry on collision (the handle UNIQUE
  // constraint is the only thing that needs retry; everything else is
  // deterministic per-row inside the transaction).
  let user: User | undefined
  for (let attempt = 0; attempt < 5; attempt++) {
    const handle = generateHandle()
    try {
      const result = await query<User>(
        `INSERT INTO users (email, name, avatar_url, auth_provider, auth_provider_id, handle, timezone)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'UTC'))
         RETURNING ${USER_COLUMNS}`,
        [
          params.email ?? null,
          params.name ?? null,
          params.avatarUrl ?? null,
          params.authProvider,
          params.authProviderId,
          handle,
          params.timezone && params.timezone !== 'UTC' ? params.timezone : null,
        ],
      )
      user = result.rows[0]
      break
    } catch (err: unknown) {
      // Retry on handle uniqueness violation (23505 = unique_violation)
      if ((err as { code?: string }).code === '23505' && (err as { constraint?: string }).constraint?.includes('handle')) {
        continue
      }
      throw err
    }
  }
  if (!user) throw new Error('Failed to generate unique handle after 5 attempts')

  // Channel shadows (auth_provider='channel' — public-API visitors like
  // `api:<keyId>:<externalUserId>` AND Telegram/Slack DM end-users) never get
  // a Personal workspace. They can't log in; their turns run entirely inside
  // the bot/assistant's workspace (memory + brain are scoped to
  // `assistant.workspaceId` by the channel + public-API routes, never the
  // shadow's own workspace), and the shadow-claim merge reassigns
  // sessions/memories by `user_id` — so a per-shadow personal workspace +
  // primary is dead weight that only pollutes the workspace table (admin list,
  // free-plan cap counts). Excluding them here keeps each customer's API/DM
  // end-users contained in the customer's single workspace.
  // See docs/architecture/platform/workspaces.md → "Primary assistant" and
  // docs/architecture/features/public-api.md → "Identity & sessions".
  if (params.authProvider === 'channel') {
    return { user, isNew: true }
  }

  // §9 collapse: every new platform user (Google, email, dev, web-guest) gets a
  // Personal workspace + a primary assistant inside it. Done in a single
  // transaction so a partial signup can't leave the user without a workspace
  // home.
  const firstName = (user.name ?? '').split(' ')[0] || user.handle || 'My'
  const workspaceName = `${firstName}'s personal workspace`
  const workspacePurpose =
    "Personal workspace — primary assistant + memories not bound to a shared workspace."

  const client = await getPool().connect()
  try {
    await client.query('BEGIN')

    const wsResult = await client.query<{ id: string }>(
      `INSERT INTO workspaces (name, purpose, owner_user_id, is_personal)
       VALUES ($1, $2, $3, true)
       RETURNING id`,
      [workspaceName, workspacePurpose, user.id],
    )
    const workspaceId = wsResult.rows[0].id

    // Owner is an operator → 'confidential' clearance, per the role defaults
    // in sensitivity.md → "User clearance (Q18)". The column DEFAULT is
    // 'internal'; stamp it explicitly so the owner can configure confidential
    // channels/pages (the write-side gates read the raw column — migration 236).
    await client.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, clearance)
       VALUES ($1, $2, 'owner', 'confidential')`,
      [workspaceId, user.id],
    )

    // The default (General) teamspace, owner joined — same seeding as
    // workspaceStore.create() (migration 313; teamspaces.md).
    await client.query(
      `WITH ts AS (
         INSERT INTO teamspaces (workspace_id, name, sensitivity, is_default, created_by)
         VALUES ($1, 'General', 'internal', true, $2)
         RETURNING id
       )
       INSERT INTO teamspace_members (teamspace_id, user_id)
       SELECT id, $2 FROM ts`,
      [workspaceId, user.id],
    )

    // The primary assistant is workspace-bound. owner_user_id stays set so
    // the legacy assistant_members fan-out still resolves; the workspace
    // is the canonical owner for new code paths.
    const assistant = await client.query<{ id: string }>(
      `INSERT INTO assistants (name, owner_user_id, workspace_id, kind)
       VALUES ($1, $2, $3, 'primary')
       RETURNING id`,
      [`${workspaceName} Primary Assistant`, user.id, workspaceId],
    )

    await client.query(
      `INSERT INTO assistant_members (assistant_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [assistant.rows[0].id, user.id],
    )

    // §17 — primary assistants default-on for the Tasks (Q1) and CRM (Q2)
    // primitive groups. The matching tools carry requiresCapability
    // 'tasks' / 'crm' and the per-turn filter hides them when no active
    // grant exists. Owner toggles via the assistant settings page.
    // See docs/plans/company-brain.md §17.
    await client.query(
      `INSERT INTO assistant_capabilities
         (assistant_id, capability, granted_by_user_id, reason)
       VALUES ($1, 'tasks', $2, '§17 default-on at primary creation'),
              ($1, 'crm',   $2, '§17 default-on at primary creation'),
              ($1, 'goals', $2, 'goals default-on at primary creation'),
              ($1, 'views', $2, 'doc-skill parity — default-on at primary creation'),
              ($1, 'files', $2, 'doc-skill parity — default-on at primary creation')`,
      [assistant.rows[0].id, user.id],
    )

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }

  return { user, isNew: true }
}

export async function findUserByEmail(email: string): Promise<User | null> {
  const result = await query<User>(
    `SELECT ${USER_COLUMNS} FROM users WHERE email = $1`,
    [email],
  )
  return result.rows[0] ?? null
}

/**
 * Promote a channel-created shadow user to a full authenticated user.
 * Updates auth provider, name, and avatar. See docs/architecture/channels/channel-user-identity.md.
 */
export async function promoteChannelUser(
  userId: string,
  updates: { authProvider: string; authProviderId: string; name?: string; avatarUrl?: string },
): Promise<void> {
  await query(
    // No-clobber: never overwrite an uploaded photo with the provider photo.
    // See user-profile.md → "Avatar precedence". avatar_source is untouched.
    `UPDATE users SET
       auth_provider = $2,
       auth_provider_id = $3,
       name = COALESCE($4, name),
       avatar_url = CASE WHEN avatar_source = 'uploaded' THEN avatar_url ELSE COALESCE($5, avatar_url) END,
       updated_at = now()
     WHERE id = $1`,
    [userId, updates.authProvider, updates.authProviderId, updates.name ?? null, updates.avatarUrl ?? null],
  )
}

/**
 * Backfill profile fields from an OAuth provider sign-in WITHOUT touching the
 * auth_provider pair. Used by the cross-provider Google branch (verified
 * Google email matches an existing row created by another method, e.g. email
 * magic-link): the row keeps its original provider — the sign-in is an
 * alternate authentication method, not a provider switch — but gains the
 * provider's display name / avatar where it has none. Same no-clobber avatar
 * rule as findOrCreateUser / promoteChannelUser (user-profile.md → "Avatar
 * precedence"). See docs/architecture/platform/auth.md → "Account resolution
 * (Google side)".
 */
export async function backfillUserProfileFromProvider(
  userId: string,
  updates: { name?: string; avatarUrl?: string },
): Promise<void> {
  if (!updates.name && !updates.avatarUrl) return
  await query(
    `UPDATE users SET
       name = COALESCE($2, name),
       avatar_url = CASE WHEN avatar_source = 'uploaded' THEN avatar_url ELSE COALESCE($3, avatar_url) END,
       updated_at = now()
     WHERE id = $1`,
    [userId, updates.name ?? null, updates.avatarUrl ?? null],
  )
}

export async function findUserById(id: string): Promise<User | null> {
  const result = await query<User>(
    `SELECT ${USER_COLUMNS} FROM users WHERE id = $1`,
    [id],
  )
  return result.rows[0] ?? null
}

/**
 * Resolve display names for a set of user IDs in one batched query. Used by
 * read paths that render *other* workspace members' identities (e.g. doc
 * comment authorship, where the client otherwise only knows the current
 * viewer's name and falls back to a "?" avatar for everyone else).
 *
 * `users` RLS is own-row only (`users_own` in 002_rls_policies.sql), so this
 * uses the system-bypass `query` exactly like {@link findUserById}; the caller
 * MUST authorize the read (workspace membership / clearance) before calling.
 * Falls back to `email` when a user has no `name` — the client's initials
 * helper already accepts emails. Returns an empty map for empty input (no
 * query issued).
 */
export async function getUserDisplayNamesByIds(
  ids: string[],
): Promise<Map<string, string>> {
  const profiles = await getUserProfilesByIds(ids)
  const map = new Map<string, string>()
  for (const [id, profile] of profiles) map.set(id, profile.name)
  return map
}

/**
 * Resolve display name + avatar for a set of user IDs in one batched query.
 * The profile counterpart of {@link getUserDisplayNamesByIds} — used by read
 * paths that render *other* people (doc comment authors, switcher rows) and
 * need both the attributable name and their photo. `name` falls back to
 * `email` (the client's initials helper accepts emails); `avatarUrl` is the
 * stored URL or null.
 *
 * `users` RLS is own-row only (`users_own` in 002_rls_policies.sql), so this
 * uses the system-bypass `query` exactly like {@link findUserById}; the caller
 * MUST authorize the read (workspace membership / clearance) before calling.
 * Returns an empty map for empty input (no query issued).
 */
export async function getUserProfilesByIds(
  ids: string[],
): Promise<Map<string, { name: string; avatarUrl: string | null }>> {
  const unique = [...new Set(ids.filter(Boolean))]
  if (unique.length === 0) return new Map()
  const result = await query<{
    id: string
    name: string | null
    email: string
    avatarUrl: string | null
  }>(
    `SELECT id, name, email, avatar_url as "avatarUrl" FROM users WHERE id = ANY($1)`,
    [unique],
  )
  const map = new Map<string, { name: string; avatarUrl: string | null }>()
  for (const row of result.rows) {
    map.set(row.id, { name: row.name ?? row.email, avatarUrl: row.avatarUrl ?? null })
  }
  return map
}

/**
 * Read-only lookup by (auth_provider, auth_provider_id). Returns null when
 * no shadow user has been created yet — callers MUST NOT auto-create.
 * Used by GET-only paths (history endpoints, etc.) where creating a user
 * row would be a write side-effect on a read.
 */
export async function findUserByAuthProvider(
  authProvider: string,
  authProviderId: string,
): Promise<User | null> {
  const result = await query<User>(
    `SELECT ${USER_COLUMNS}
     FROM users WHERE auth_provider = $1 AND auth_provider_id = $2`,
    [authProvider, authProviderId],
  )
  return result.rows[0] ?? null
}

/**
 * Update the user's timezone. Called when the web client sends a
 * browser-detected timezone that differs from the stored value.
 */
export async function updateUserTimezone(
  userId: string,
  timezone: string,
): Promise<void> {
  await query(
    `UPDATE users SET timezone = $1, updated_at = now() WHERE id = $2`,
    [timezone, userId],
  )
}

/**
 * Persist an uploaded avatar. Sets `avatar_url` to our proxy URL,
 * `avatar_storage_key` plus immutable workspace/URI origin provenance, and stamps
 * `avatar_source='uploaded'` so the no-clobber guard in `findOrCreateUser` /
 * `promoteChannelUser` protects it from a later provider sign-in. Called by
 * `POST /api/account/avatar`. See user-profile.md → "Uploading your own photo".
 */
export async function updateUserAvatar(
  userId: string,
  {
    url,
    storageKey,
    storageWorkspaceId,
    storageUri,
    previousStorageKey,
  }: {
    url: string
    storageKey: string
    storageWorkspaceId: string
    storageUri: string
    previousStorageKey: string | null
  },
): Promise<boolean> {
  const result = await query(
    `UPDATE users SET
       avatar_url = $1,
       avatar_storage_key = $2,
       avatar_storage_workspace_id = $3,
       avatar_storage_uri = $4,
       avatar_source = 'uploaded',
       updated_at = now()
     WHERE id = $5 AND avatar_storage_key IS NOT DISTINCT FROM $6`,
    [url, storageKey, storageWorkspaceId, storageUri, userId, previousStorageKey],
  )
  return (result.rowCount ?? 0) > 0
}

/**
 * Remove an uploaded avatar. Nulls all five avatar columns so the next
 * provider sign-in re-syncs the hot-linked photo. Called by
 * `DELETE /api/account/avatar` (after the blob delete).
 */
export async function clearUserAvatar(userId: string, expectedStorageKey: string | null): Promise<boolean> {
  const result = await query(
    `UPDATE users SET
       avatar_url = NULL,
       avatar_storage_key = NULL,
       avatar_storage_workspace_id = NULL,
       avatar_storage_uri = NULL,
       avatar_source = NULL,
       updated_at = now()
     WHERE id = $1 AND avatar_storage_key IS NOT DISTINCT FROM $2`,
    [userId, expectedStorageKey],
  )
  return (result.rowCount ?? 0) > 0
}

/**
 * Update the user's display name. Called by `PATCH /api/account/profile`.
 * The route validates / trims the name; this just persists it.
 */
export async function updateUserProfile(
  userId: string,
  { name }: { name: string },
): Promise<void> {
  await query(
    `UPDATE users SET name = $1, updated_at = now() WHERE id = $2`,
    [name, userId],
  )
}

/**
 * Stamp the user's presence timezone from a live client signal.
 * Called on every authenticated chat turn that carries a valid
 * `X-Client-Timezone` header. Idempotent — repeats with the same
 * value still bump `last_seen_tz_at` so the freshness window stays
 * accurate across long-running web sessions. `updated_at` is left
 * untouched: presence is a high-frequency observational signal, not
 * a profile edit, and bumping `updated_at` would invalidate caches
 * keyed on it.
 */
export async function updateUserLastSeenTz(
  userId: string,
  timezone: string,
): Promise<void> {
  await query(
    `UPDATE users SET last_seen_tz = $1, last_seen_tz_at = now() WHERE id = $2`,
    [timezone, userId],
  )
}

/**
 * Read the travel-tz nudge suppression timestamp. Null when never set
 * or cleared. The drift detector compares this against `now()` — any
 * value in the future suppresses a nudge; null / past allows it.
 */
export async function getTzNudgeSuppression(
  userId: string,
): Promise<Date | null> {
  const result = await query<{ tz_nudge_suppressed_until: Date | null }>(
    `SELECT tz_nudge_suppressed_until FROM users WHERE id = $1`,
    [userId],
  )
  return result.rows[0]?.tz_nudge_suppressed_until ?? null
}

/**
 * Set (or clear) the travel-tz nudge suppression window. Pass a future
 * timestamp (typically `now() + 30 days`) when the user chooses "Keep
 * my existing timezone" on the travel nudge. Pass null to clear it.
 */
export async function setTzNudgeSuppression(
  userId: string,
  until: Date | null,
): Promise<void> {
  await query(
    `UPDATE users SET tz_nudge_suppressed_until = $1, updated_at = now() WHERE id = $2`,
    [until, userId],
  )
}

/**
 * Read the per-user dismissed-nudge set for the chat-home (migration 242).
 * A nudge key present + true means the user dismissed it; absent means
 * still eligible (subject to its setup-state signal). [COMP:api/home-dismiss]
 */
export async function getDismissedNudges(userId: string): Promise<Record<string, boolean>> {
  const result = await query<{ dismissed_nudges: Record<string, boolean> | null }>(
    `SELECT dismissed_nudges FROM users WHERE id = $1`,
    [userId],
  )
  return result.rows[0]?.dismissed_nudges ?? {}
}

/**
 * Persist a chat-home nudge dismissal. Merges `{ [key]: true }` into the
 * JSONB set so repeated dismissals are idempotent. [COMP:api/home-dismiss]
 */
export async function updateDismissedNudges(userId: string, key: string): Promise<void> {
  await query(
    `UPDATE users
     SET dismissed_nudges = COALESCE(dismissed_nudges, '{}'::jsonb) || jsonb_build_object($2::text, true),
         updated_at = now()
     WHERE id = $1`,
    [userId, key],
  )
}

/**
 * Persist the user's Stripe customer ID — called from the checkout
 * route when we first create a customer for the user. The webhook
 * handler will later fill in the subscription fields.
 */
export async function setUserStripeCustomerId(
  userId: string,
  stripeCustomerId: string,
): Promise<void> {
  await query(
    `UPDATE users SET stripe_customer_id = $1, updated_at = now() WHERE id = $2`,
    [stripeCustomerId, userId],
  )
}

/**
 * Get the user's default assistant. After the §9 collapse, this is the
 * `kind='primary'` assistant of the user's Personal workspace. Falls
 * back to "first owned assistant" for legacy rows that pre-date §9 and
 * haven't been promoted yet — that fallback is defensive and should not
 * fire after migration 110 has run.
 */
export type UserAssistantView = {
  id: string
  name: string
  telegramModelAlias: string
  workspaceId: string | null
  systemPrompt: string | null
  kind: AssistantKind
  appType: AssistantAppType | null
  blockedUserIds: string[]
  clearance: 'public' | 'internal' | 'confidential'
  /** Compartment grant (MLS category axis). NULL = universe. See docs/plans/compartment-axis.md. */
  compartments: string[] | null
  /** Auto-stamp compartments on writes this assistant authors (⊆ compartments). */
  defaultCompartments: string[]
}

export async function getDefaultAssistant(userId: string): Promise<UserAssistantView | null> {
  // Preferred path: the primary assistant of the user's Personal workspace.
  const primary = await query<UserAssistantView>(
    `SELECT a.id, a.name, a.telegram_model_alias as "telegramModelAlias",
            a.workspace_id as "workspaceId",
            a.system_prompt as "systemPrompt",
            a.kind,
            a.app_type as "appType",
            a.blocked_user_ids as "blockedUserIds",
            a.clearance,
            a.compartments,
            a.default_compartments as "defaultCompartments"
     FROM assistants a
     JOIN workspaces w ON w.id = a.workspace_id
     WHERE w.owner_user_id = $1 AND w.is_personal = true AND a.kind = 'primary'
     LIMIT 1`,
    [userId],
  )
  if (primary.rows[0]) return primary.rows[0]

  // Defensive fallback (should not fire post-migration-110): the oldest
  // assistant the user owns. Kept so a misconfigured user can still chat.
  const result = await query<UserAssistantView>(
    `SELECT a.id, a.name, a.telegram_model_alias as "telegramModelAlias",
            a.workspace_id as "workspaceId",
            a.system_prompt as "systemPrompt",
            a.kind,
            a.app_type as "appType",
            a.blocked_user_ids as "blockedUserIds",
            a.clearance,
            a.compartments,
            a.default_compartments as "defaultCompartments"
     FROM assistants a
     JOIN assistant_members am ON am.assistant_id = a.id
     WHERE am.user_id = $1 AND am.role = 'owner'
     ORDER BY a.created_at ASC LIMIT 1`,
    [userId],
  )
  return result.rows[0] ?? null
}

/**
 * Resolve the `kind='primary'` assistant of a specific workspace the
 * user is a member of. Used by the chat route's workspace-aware routing
 * when the client sends `workspaceId` without an `assistantId`
 * (typical: the user is looking at a workspace home and just types).
 *
 * Returns null when the workspace has no primary (should not happen
 * post-migration 193) or when the user is not a workspace member.
 */
export async function getWorkspacePrimaryAssistant(
  userId: string,
  workspaceId: string,
): Promise<UserAssistantView | null> {
  const result = await query<UserAssistantView>(
    `SELECT a.id, a.name, a.telegram_model_alias as "telegramModelAlias",
            a.workspace_id as "workspaceId",
            a.system_prompt as "systemPrompt",
            a.kind,
            a.app_type as "appType",
            a.blocked_user_ids as "blockedUserIds",
            a.clearance,
            a.compartments,
            a.default_compartments as "defaultCompartments"
     FROM assistants a
     WHERE a.workspace_id = $1 AND a.kind = 'primary'
       AND EXISTS (
         SELECT 1 FROM workspace_members wm
         WHERE wm.workspace_id = a.workspace_id AND wm.user_id = $2
       )
     LIMIT 1`,
    [workspaceId, userId],
  )
  return result.rows[0] ?? null
}

/** The caller's effective role on an assistant, by precedence owner > admin > member. */
export type AssistantRole = 'owner' | 'admin' | 'member'

/** What `resolveAssistantAccess` returns: the assistant plus the caller's effective role. */
export type AssistantAccess = {
  assistant: UserAssistantView
  role: AssistantRole
}

/**
 * **The** assistant access predicate. Every "can this user use / see / edit this
 * assistant" decision resolves here — do not hand-roll the membership join at a
 * call site.
 *
 * A user reaches an assistant two ways: a direct `assistant_members` grant
 * (legacy, and the Personal-workspace primary) or membership in the assistant's
 * workspace (`workspace_members`, canonical post-089). The gate is
 * `direct OR workspace`, and the returned `role` is the **effective** role — the
 * higher-privilege of the two paths, by owner > admin > member.
 *
 * Never gate on `assistants.owner_user_id`. After the migration-089 ownership
 * XOR flip that column is NULL for every workspace-owned assistant, so an
 * `owner_user_id = $userId` predicate is unsatisfiable by any human for exactly
 * the team assistants that matter most. That defect shipped twice: the Telegram
 * `/switch` commit gate, and the unguarded Telegram link-code routes.
 *
 * The effective-role CASE is load-bearing and mirrors `listAccessibleAssistants`.
 * The earlier per-route spelling was `UNION … LIMIT 1` with no `ORDER BY`, so
 * when a user's direct and workspace roles disagreed the resolved role was
 * whatever the planner emitted first — nondeterministic, on the path that gates
 * every assistant write. Both membership tables key on `(…, user_id)`, so the
 * LEFT JOINs match at most one row each: no fan-out, exactly one row out.
 *
 * System read (bare `query`): the membership JOINs are themselves the access
 * gate, so no RLS context is needed — same pattern as `listAccessibleAssistants`.
 *
 * Returns null when the assistant does not exist OR the caller cannot reach it.
 * Callers must not distinguish the two (a 404 on "exists but no access" leaks
 * assistant existence across workspaces); respond 403 for both.
 *
 * See docs/architecture/platform/workspaces.md → "The assistant list" and
 * component `[COMP:api/assistant-access]`.
 */
export async function resolveAssistantAccess(
  userId: string,
  assistantId: string,
): Promise<AssistantAccess | null> {
  const result = await query<UserAssistantView & { role: AssistantRole }>(
    `SELECT a.id, a.name, a.telegram_model_alias as "telegramModelAlias",
            a.workspace_id as "workspaceId",
            a.system_prompt as "systemPrompt",
            a.kind,
            a.app_type as "appType",
            a.blocked_user_ids as "blockedUserIds",
            a.clearance,
            a.compartments,
            a.default_compartments as "defaultCompartments",
            CASE
              WHEN am.role = 'owner' OR wm.role = 'owner' THEN 'owner'
              WHEN am.role = 'admin' OR wm.role = 'admin' THEN 'admin'
              ELSE 'member'
            END AS role
       FROM assistants a
       LEFT JOIN assistant_members am
         ON am.assistant_id = a.id AND am.user_id = $1
       LEFT JOIN workspace_members wm
         ON wm.workspace_id = a.workspace_id AND wm.user_id = $1
      WHERE a.id = $2
        AND (
              am.user_id IS NOT NULL
              OR (a.workspace_id IS NOT NULL AND wm.user_id IS NOT NULL)
            )
      LIMIT 1`,
    [userId, assistantId],
  )
  const row = result.rows[0]
  if (!row) return null
  const { role, ...assistant } = row
  return { assistant, role }
}

/** Look up a specific assistant the user can access, discarding the role.
 *  Thin wrapper over `resolveAssistantAccess` — the predicate lives there, so
 *  this can never drift from the role-aware path. Returns null if the assistant
 *  doesn't exist or the user has no access. */
export async function getUserAssistant(userId: string, assistantId: string): Promise<UserAssistantView | null> {
  return (await resolveAssistantAccess(userId, assistantId))?.assistant ?? null
}

/**
 * A row in the assistant list — the shape the Studio rail, the global
 * sidebar, and the chat switcher render. Returned by
 * `listAccessibleAssistants`.
 */
export type AccessibleAssistant = {
  id: string
  name: string
  /**
   * The caller's *effective* role on this assistant: the highest-privilege
   * of their direct (`assistant_members`) and workspace (`workspace_members`)
   * roles, by the precedence owner > admin > member. A user reachable through
   * both paths appears once, with this single role — never once per path.
   */
  role: 'owner' | 'admin' | 'member'
  systemPrompt: string | null
  memoryCount: number
  iconSeed: number | null
  workspaceId: string | null
  telegramModelAlias: string
  slackModelAlias: string
  clearance: 'public' | 'internal' | 'confidential'
  kind: AssistantKind
  appType: AssistantAppType | null
}

/**
 * List every assistant a user can reach — one row per assistant.
 *
 * A user reaches an assistant two ways: a direct `assistant_members` grant
 * (legacy, and the Personal-workspace primary) or membership in the
 * assistant's workspace (`workspace_members`, canonical post-089). The two
 * are LEFT JOINed; the access gate is `direct OR workspace`, mirroring
 * `getUserAssistant`'s predicate exactly so the access set is unchanged.
 *
 * Returning ONE row per assistant is the load-bearing property. The earlier
 * implementation `UNION`ed the two access paths and each arm selected its own
 * `role` column, so a user whose direct role disagreed with their workspace
 * role (e.g. `assistant_members.role='member'` but `workspace_members.role
 * ='admin'`) produced two rows differing only in `role`. UNION dedupes on the
 * whole row, so both survived — surfacing as a phantom "duplicate assistant"
 * in the rail. The effective-role CASE collapses that to a single row with the
 * higher-privilege role. Both membership tables key on `(…, user_id)`, so the
 * LEFT JOINs match at most one row each — no fan-out.
 *
 * `workspaceId`, when given, narrows to that one workspace (the workspace-
 * scoped Studio surfaces pass it); the access gate is otherwise unchanged.
 *
 * System read (bare `query`): the membership JOINs are themselves the access
 * gate, so no RLS context is needed — same pattern as `getUserAssistant`.
 *
 * See docs/architecture/platform/workspaces.md → "Assistant access & the
 * assistant list" and component `[COMP:api/assistants-list]`.
 */
export async function listAccessibleAssistants(
  userId: string,
  workspaceId?: string | null,
): Promise<AccessibleAssistant[]> {
  const wsFilter = workspaceId ? ' AND a.workspace_id = $2' : ''
  const result = await query<AccessibleAssistant>(
    `SELECT a.id, a.name,
            CASE
              WHEN am.role = 'owner' OR wm.role = 'owner' THEN 'owner'
              WHEN am.role = 'admin' OR wm.role = 'admin' THEN 'admin'
              ELSE 'member'
            END                    AS role,
            a.system_prompt        AS "systemPrompt",
            a.icon_seed            AS "iconSeed",
            a.workspace_id         AS "workspaceId",
            a.telegram_model_alias AS "telegramModelAlias",
            a.slack_model_alias    AS "slackModelAlias",
            a.clearance,
            a.kind,
            a.app_type             AS "appType",
            COALESCE((SELECT COUNT(*) FROM memories m
                      WHERE m.assistant_id = a.id AND m.user_id = $1), 0)::int
                                   AS "memoryCount"
       FROM assistants a
       LEFT JOIN assistant_members am
         ON am.assistant_id = a.id AND am.user_id = $1
       LEFT JOIN workspace_members wm
         ON wm.workspace_id = a.workspace_id AND wm.user_id = $1
      WHERE (
              am.user_id IS NOT NULL
              OR (a.workspace_id IS NOT NULL AND wm.user_id IS NOT NULL)
            )${wsFilter}
      ORDER BY a.created_at ASC`,
    workspaceId ? [userId, workspaceId] : [userId],
  )
  return result.rows
}

/**
 * Find an assistant by its ID (no RLS — used by webhook routes before the
 * user is known, e.g. Slack BYO where the assistant_id comes from the URL
 * and the Slack user hasn't been mapped to a Use Brian user yet).
 */
export type AssistantKind = 'standard' | 'app' | 'primary'

/**
 * App variant. Non-null iff `kind='app'`, per the constraint in migration 081
 * (narrowed to only 'distribution' in migration 247). Growth of this union
 * happens alongside new variants (register a soul + tool injector — see
 * _prompt-builder.ts + chat.ts). Doc was removed — doc authoring is a
 * surface skill (`buildDocSkillBlock` + `injectDocTools`), not an app type.
 */
export type AssistantAppType = 'distribution'

export type AssistantRow = {
  id: string
  name: string
  ownerUserId: string
  slackModelAlias: string
  telegramModelAlias: string
  whatsappModelAlias: string
  workspaceId: string | null
  systemPrompt: string | null
  clearance: 'public' | 'internal' | 'confidential'
  compartments: string[] | null
  defaultCompartments: string[]
  kind: AssistantKind
  appType: AssistantAppType | null
}

export async function findAssistantById(
  assistantId: string,
): Promise<AssistantRow | null> {
  const result = await query<AssistantRow>(
    `SELECT id, name, owner_user_id as "ownerUserId",
            slack_model_alias as "slackModelAlias",
            telegram_model_alias as "telegramModelAlias",
            whatsapp_model_alias as "whatsappModelAlias",
            workspace_id as "workspaceId",
            system_prompt as "systemPrompt",
            clearance,
            compartments,
            default_compartments as "defaultCompartments",
            kind,
            app_type as "appType"
     FROM assistants WHERE id = $1`,
    [assistantId],
  )
  return result.rows[0] ?? null
}

/**
 * WU-4.4 Q20 observation-side blocklist resolver. Returns true when
 * `userId` is in the assistant's `blocked_user_ids` array (migration
 * 122). This is the observation-direction counterpart to the
 * invocation-side `isUserBlocked` evaluator in `routes/chat.ts` — wired
 * into Pipeline B so a blocked user's content is never extracted into
 * the brain by the blocking assistant.
 *
 * No RLS: the ingest batch worker has no per-viewer session — the lookup
 * is keyed only by the assistant id, which the worker already holds.
 * A missing assistant resolves to `false` (not blocked) so a stale id
 * never silently suppresses extraction.
 *
 * See `docs/plans/company-brain/permissions.md` §"Per-assistant user
 * blocklist" (Q20).
 */
export async function isUserBlockedForAssistant(
  assistantId: string,
  userId: string,
): Promise<boolean> {
  const result = await query<{ blocked: boolean }>(
    `SELECT $2 = ANY(blocked_user_ids) AS blocked
       FROM assistants WHERE id = $1`,
    [assistantId, userId],
  )
  return result.rows[0]?.blocked ?? false
}
