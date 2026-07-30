/**
 * Custom Home app registry store (`workspace_home_apps` + `home_app_state`).
 *
 * The row is the app's identity, its last VALIDATED manifest, where it syncs
 * from, and — the part everything else hangs off — what an admin has actually
 * consented to it reaching. Bundle files live in workspace file storage under
 * the reserved `/apps/<appId>/` prefix, not here.
 *
 * Two authorization notes, both deliberate:
 *
 *   - Reads run **system-level** (`query`, not `queryWithRLS`). The serving
 *     path and the bridge authenticate with a signed capability/bridge token
 *     rather than a user session, so there is no `app.current_user_id` to gate
 *     on; the token IS the credential, and every call re-derives the workspace
 *     from the row. RLS still covers the member-facing list.
 *   - **Grant and scope mutations are owner/admin-checked HERE**, in the
 *     setter — the brain-keys pattern. "Who may consent" is a role question a
 *     row predicate cannot express, and consent is the whole security model
 *     for running someone else's code.
 *
 * Spec: docs/architecture/features/home-apps.md → "Custom apps".
 * [COMP:api/home-apps-store]
 */

import type { Sensitivity } from '@use-brian/core'
import {
  scopesExceedGrant,
  type AppManifest,
  type AppScopes,
} from '@use-brian/brian-app'
import { query } from './client.js'

export type HomeAppKind = 'github' | 'assistant'
export type HomeAppStatus = 'active' | 'disabled' | 'needs_consent'

export type HomeAppRow = {
  id: string
  workspaceId: string
  kind: HomeAppKind
  name: string
  description: string | null
  icon: string | null
  repo: string | null
  branch: string
  rootPath: string
  connectorInstanceId: string | null
  lastSyncedSha: string | null
  lastSyncedAt: Date | null
  syncError: string | null
  manifest: AppManifest | Record<string, never>
  grantedScopes: AppScopes | null
  grantedBy: string | null
  grantedAt: Date | null
  maxClearance: Sensitivity | null
  status: HomeAppStatus
  dailyCallLimit: number
  dailyUsed: number
  createdBy: string | null
  createdAt: Date
  updatedAt: Date
}

const APP_COLUMNS = `
  id,
  workspace_id AS "workspaceId",
  kind, name, description, icon,
  repo, branch,
  root_path AS "rootPath",
  connector_instance_id AS "connectorInstanceId",
  last_synced_sha AS "lastSyncedSha",
  last_synced_at AS "lastSyncedAt",
  sync_error AS "syncError",
  manifest,
  granted_scopes AS "grantedScopes",
  granted_by AS "grantedBy",
  granted_at AS "grantedAt",
  max_clearance AS "maxClearance",
  status,
  daily_call_limit AS "dailyCallLimit",
  daily_used AS "dailyUsed",
  created_by AS "createdBy",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
` as const

/**
 * Can this app render right now? The app-bar's `knownCustomIds` filter is
 * built from exactly this predicate, which is how the T3 drift rule reaches
 * the strip: an app that dropped to `needs_consent` stops being renderable and
 * therefore disappears until an admin re-grants.
 */
export function isRenderableHomeApp(app: HomeAppRow): boolean {
  return app.status === 'active' && app.grantedScopes !== null
}

/** Every custom app in a workspace, newest first. System read. */
export async function listHomeApps(workspaceId: string): Promise<HomeAppRow[]> {
  const result = await query<HomeAppRow>(
    `SELECT ${APP_COLUMNS} FROM workspace_home_apps
      WHERE workspace_id = $1
      ORDER BY created_at DESC`,
    [workspaceId],
  )
  return result.rows
}

/** One app by id. System read — callers must check the workspace themselves. */
export async function getHomeApp(appId: string): Promise<HomeAppRow | null> {
  const result = await query<HomeAppRow>(
    `SELECT ${APP_COLUMNS} FROM workspace_home_apps WHERE id = $1`,
    [appId],
  )
  return result.rows[0] ?? null
}

export async function createHomeApp(params: {
  workspaceId: string
  kind: HomeAppKind
  manifest: AppManifest
  repo?: string | null
  branch?: string
  rootPath?: string
  connectorInstanceId?: string | null
  createdBy: string | null
}): Promise<HomeAppRow> {
  const result = await query<HomeAppRow>(
    `INSERT INTO workspace_home_apps
       (workspace_id, kind, name, description, icon,
        repo, branch, root_path, connector_instance_id, manifest, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
     RETURNING ${APP_COLUMNS}`,
    [
      params.workspaceId,
      params.kind,
      params.manifest.name,
      params.manifest.description ?? null,
      params.manifest.icon ?? null,
      params.repo ?? null,
      params.branch ?? 'main',
      params.rootPath ?? '',
      params.connectorInstanceId ?? null,
      JSON.stringify(params.manifest),
      params.createdBy,
    ],
  )
  return result.rows[0]
}

export type ApplyManifestResult = {
  app: HomeAppRow
  /** True when the new manifest asked for more than the standing grant. */
  droppedToNeedsConsent: boolean
}

/**
 * Record a newly-validated manifest on an app — the write every sync and every
 * assistant edit funnels through.
 *
 * **This is where T3 lives.** If the new manifest requests scopes the standing
 * grant does not cover, the app drops to `needs_consent` and leaves the strip
 * until an admin re-consents. Silently carrying a grant forward onto widened
 * scopes is precisely the failure the consent model exists to prevent, and it
 * would be invisible: the app keeps working, with more power than anyone
 * approved.
 */
export async function applyHomeAppManifest(params: {
  appId: string
  manifest: AppManifest
  lastSyncedSha?: string | null
}): Promise<ApplyManifestResult | null> {
  const existing = await getHomeApp(params.appId)
  if (!existing) return null

  const drifted = scopesExceedGrant(params.manifest.scopes, existing.grantedScopes)
  const nextStatus: HomeAppStatus = drifted
    ? 'needs_consent'
    : existing.status === 'needs_consent'
      ? 'active'
      : existing.status

  const result = await query<HomeAppRow>(
    `UPDATE workspace_home_apps
        SET name = $2, description = $3, icon = $4,
            manifest = $5::jsonb,
            status = $6,
            last_synced_sha = COALESCE($7, last_synced_sha),
            last_synced_at = now(),
            sync_error = NULL,
            updated_at = now()
      WHERE id = $1
      RETURNING ${APP_COLUMNS}`,
    [
      params.appId,
      params.manifest.name,
      params.manifest.description ?? null,
      params.manifest.icon ?? null,
      JSON.stringify(params.manifest),
      nextStatus,
      params.lastSyncedSha ?? null,
    ],
  )
  const app = result.rows[0]
  if (!app) return null
  return { app, droppedToNeedsConsent: drifted && existing.status !== 'needs_consent' }
}

/** Record a sync failure without touching the manifest or the grant. */
export async function recordHomeAppSyncError(
  appId: string,
  message: string,
): Promise<void> {
  await query(
    `UPDATE workspace_home_apps
        SET sync_error = $2, last_synced_at = now(), updated_at = now()
      WHERE id = $1`,
    [appId, message.slice(0, 2000)],
  )
}

export type GrantResult =
  | { ok: true; app: HomeAppRow }
  | { ok: false; reason: 'not_admin' | 'not_found' | 'invalid'; message: string }

async function isWorkspaceAdmin(userId: string, workspaceId: string): Promise<boolean> {
  const result = await query<{ role: string }>(
    `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [workspaceId, userId],
  )
  const role = result.rows[0]?.role
  return role === 'owner' || role === 'admin'
}

/**
 * Grant an app the scopes its manifest requests, activating it.
 *
 * The granted scopes are taken from the app's **stored, validated manifest**,
 * never from the request body. A caller-supplied scope set would mean the
 * consent screen and the grant could disagree — an admin approving one thing
 * while a crafted request writes another.
 */
export async function grantHomeApp(params: {
  actingUserId: string
  appId: string
  maxClearance?: Sensitivity | null
  dailyCallLimit?: number
}): Promise<GrantResult> {
  const app = await getHomeApp(params.appId)
  if (!app) return { ok: false, reason: 'not_found', message: 'App not found.' }
  if (!(await isWorkspaceAdmin(params.actingUserId, app.workspaceId))) {
    return {
      ok: false,
      reason: 'not_admin',
      message: 'Only a workspace owner or admin can grant an app access.',
    }
  }
  const manifest = app.manifest as AppManifest
  if (!manifest?.scopes) {
    return {
      ok: false,
      reason: 'invalid',
      message: 'This app has no validated manifest to grant.',
    }
  }

  const result = await query<HomeAppRow>(
    `UPDATE workspace_home_apps
        SET granted_scopes = $2::jsonb,
            granted_by = $3,
            granted_at = now(),
            max_clearance = $4,
            daily_call_limit = COALESCE($5, daily_call_limit),
            status = 'active',
            updated_at = now()
      WHERE id = $1
      RETURNING ${APP_COLUMNS}`,
    [
      params.appId,
      JSON.stringify(manifest.scopes),
      params.actingUserId,
      params.maxClearance ?? null,
      params.dailyCallLimit ?? null,
    ],
  )
  return { ok: true, app: result.rows[0] }
}

/** Revoke the grant (back to `needs_consent`) or disable/enable an app. */
export async function setHomeAppStatus(params: {
  actingUserId: string
  appId: string
  status: HomeAppStatus
}): Promise<GrantResult> {
  const app = await getHomeApp(params.appId)
  if (!app) return { ok: false, reason: 'not_found', message: 'App not found.' }
  if (!(await isWorkspaceAdmin(params.actingUserId, app.workspaceId))) {
    return {
      ok: false,
      reason: 'not_admin',
      message: 'Only a workspace owner or admin can change an app.',
    }
  }
  // Dropping to `needs_consent` CLEARS the grant. Leaving it behind would let a
  // later "activate" silently restore powers nobody re-approved.
  const clearGrant = params.status === 'needs_consent'
  const result = await query<HomeAppRow>(
    `UPDATE workspace_home_apps
        SET status = $2,
            granted_scopes = CASE WHEN $3::boolean THEN NULL ELSE granted_scopes END,
            updated_at = now()
      WHERE id = $1
      RETURNING ${APP_COLUMNS}`,
    [params.appId, params.status, clearGrant],
  )
  return { ok: true, app: result.rows[0] }
}

export async function deleteHomeApp(params: {
  actingUserId: string
  appId: string
}): Promise<GrantResult> {
  const app = await getHomeApp(params.appId)
  if (!app) return { ok: false, reason: 'not_found', message: 'App not found.' }
  if (!(await isWorkspaceAdmin(params.actingUserId, app.workspaceId))) {
    return {
      ok: false,
      reason: 'not_admin',
      message: 'Only a workspace owner or admin can remove an app.',
    }
  }
  await query(`DELETE FROM workspace_home_apps WHERE id = $1`, [params.appId])
  return { ok: true, app }
}

// ── Daily bridge budget (transplanted from public chat links) ───────────

export type BudgetResult = { allowed: boolean; used: number; limit: number }

/**
 * Atomically consume one bridge call from the app's daily budget.
 *
 * The date reset happens INSIDE the same UPDATE as the increment — a
 * read-then-write would leave a window where two concurrent calls both see a
 * stale window date and both reset the counter, which is a day's worth of
 * budget handed out for free. `limit = 0` means unlimited.
 */
export async function consumeHomeAppBudget(appId: string): Promise<BudgetResult> {
  const result = await query<{ used: number; limit: number }>(
    `UPDATE workspace_home_apps
        SET daily_used = CASE
              WHEN daily_window_date = CURRENT_DATE THEN daily_used + 1
              ELSE 1
            END,
            daily_window_date = CURRENT_DATE
      WHERE id = $1
      RETURNING daily_used AS "used", daily_call_limit AS "limit"`,
    [appId],
  )
  const row = result.rows[0]
  if (!row) return { allowed: false, used: 0, limit: 0 }
  return { allowed: row.limit === 0 || row.used <= row.limit, used: row.used, limit: row.limit }
}

// ── Bridge KV (home_app_state) ──────────────────────────────────────────

/** v1 cap per scope. The iframe is opaque-origin and has no storage of its
 *  own, so this is the app's ONLY persistence — but it is workspace data in a
 *  shared database, not a private disk. */
export const HOME_APP_STATE_MAX_BYTES = 256 * 1024

export type StateScope = 'workspace' | 'user'

export async function getHomeAppState(params: {
  appId: string
  scope: StateScope
  userId: string
}): Promise<Record<string, unknown>> {
  const result = await query<{ data: Record<string, unknown> }>(
    `SELECT data FROM home_app_state
      WHERE app_id = $1
        AND ($2::uuid IS NULL AND user_id IS NULL OR user_id = $2::uuid)`,
    [params.appId, params.scope === 'user' ? params.userId : null],
  )
  return result.rows[0]?.data ?? {}
}

export type PutStateResult =
  | { ok: true }
  | { ok: false; reason: 'too_large'; message: string }

export async function putHomeAppState(params: {
  appId: string
  workspaceId: string
  scope: StateScope
  userId: string
  data: unknown
}): Promise<PutStateResult> {
  const serialized = JSON.stringify(params.data ?? {})
  const bytes = Buffer.byteLength(serialized, 'utf8')
  if (bytes > HOME_APP_STATE_MAX_BYTES) {
    return {
      ok: false,
      reason: 'too_large',
      message: `State is ${Math.round(bytes / 1024)} KB, over the ${
        HOME_APP_STATE_MAX_BYTES / 1024
      } KB limit.`,
    }
  }
  const scopedUserId = params.scope === 'user' ? params.userId : null
  // Two partial unique indexes back this (NULLs are distinct in a plain unique
  // index, so a single `(app_id, user_id)` constraint would let two
  // workspace-scoped rows coexist). Hence two statements rather than one
  // ON CONFLICT — the target index differs per scope.
  if (scopedUserId) {
    await query(
      `INSERT INTO home_app_state (app_id, workspace_id, user_id, data, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, now())
       ON CONFLICT (app_id, user_id) WHERE user_id IS NOT NULL
       DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [params.appId, params.workspaceId, scopedUserId, serialized],
    )
  } else {
    await query(
      `INSERT INTO home_app_state (app_id, workspace_id, user_id, data, updated_at)
       VALUES ($1, $2, NULL, $3::jsonb, now())
       ON CONFLICT (app_id) WHERE user_id IS NULL
       DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [params.appId, params.workspaceId, serialized],
    )
  }
  return { ok: true }
}
