/**
 * Workspace store — workspace CRUD and member management.
 *
 * A workspace groups users who share assistants. Every user has at least
 * one default workspace, named "Personal" (auto-created at signup,
 * `is_personal=true`). `is_personal` is **only a label/anchor**: it names the
 * default workspace and anchors ingest routing, primary-assistant lookup, the
 * free-tier workspace cap, and deletion-protection. It gates **no** connector
 * or sharing behavior — every workspace is treated identically there.
 *
 * **Connector scoping (security):** while a workspace's owner is its *sole*
 * member, the owner's personal (`scope='user'`) connectors are that
 * workspace's connectors. The instant it has teammates it must NOT expose
 * the owner's personal connectors to other members — its tool access comes
 * only from team-native (`scope='workspace'`) instances + member-exposure
 * grants (`connector_grant`). `injectMcpTools` enforces this via
 * `isSoloWorkspaceSystem` — live member count ≤ 1, regardless of
 * `is_personal` (see incident 2026-06-01 / 2026-06-02 and
 * docs/architecture/integrations/mcp.md → "Workspace connector scoping").
 *
 * See docs/architecture/platform/workspaces.md and migration 110 (the
 * team→workspace rename + primary assistant + personal collapse).
 */

import type { PoolClient } from 'pg'
import { minSensitivity } from '@sidanclaw/core'
import type { Sensitivity } from '@sidanclaw/core'
import { query, queryWithRLS, getPool } from './client.js'
import type { ConnectorGrantStore } from './connector-grant-store.js'
import type { ChannelRouteStore } from './channel-route-store.js'

// ── Types ──────────────────────────────────────────────────────

export type Workspace = {
  id: string
  name: string
  /**
   * What knowledge the workspace intends to share — set at creation, used
   * as grounding for the workspace-vs-user memory routing decision (see
   * `## Workspace Context` block in `context-builder.ts` and migration 053).
   * Empty string for legacy workspaces created before migration 053.
   */
  purpose: string
  ownerUserId: string
  iconSeed: number | null
  /**
   * True for the auto-created default workspace each user gets at signup
   * (named "Personal"). A pure **label/anchor**: it enforces the free-tier
   * "only paid users can create more workspaces" cap, anchors default-assistant
   * lookup + ingest routing, and protects the workspace from deletion. It gates
   * **no** connector/sharing behavior — that all keys on `memberCount` (solo vs
   * shared) so every workspace is treated identically. See migration 110 §7.
   */
  isPersonal: boolean
  /**
   * Live count of `workspace_members` rows. Computed by `list()` / `get()` via
   * `memberCountsSystem` (the OWNER pool) — NOT as a subquery inside the
   * RLS-enforced read, where the `wm_own_workspace` policy would confine the
   * count to the caller's own row and always yield 1. The frontend reads it to
   * decide solo-vs-shared behavior (e.g. whether to auto-expose a connector and
   * whether to show the "Share with this workspace" control). Undefined on the
   * create/update/system return paths that don't compute it — treat absent as 1
   * (solo).
   */
  memberCount?: number
  /**
   * Workspace billing plan — the authoritative tier for this workspace
   * after the per-workspace billing migration (143). Surfaced on the list
   * endpoint so chrome (landing nav badge, workspace switcher) renders
   * the correct tier without a separate `/api/usage` round-trip.
   */
  plan: WorkspacePlan
  /**
   * The workspace's default recording blueprint — a `workspace_page_templates`
   * id carrying an `extraction` spec (a blueprint). When a recording is
   * processed with no explicit blueprint pick, this is the fallback the
   * selection ladder (`explicit ?? workspace default ?? none`) resolves at the
   * enqueue edge. `null` = no default (ingest-only). Migration 291. See
   * docs/architecture/brain/structural-synthesis.md.
   */
  defaultRecordingBlueprintId: string | null
  createdAt: Date
  updatedAt: Date
}

/**
 * Thrown by `setDefaultRecordingBlueprint` when the supplied template id is not
 * a valid blueprint for this workspace (missing, cross-workspace, or carries no
 * `extraction` spec). The route maps it to HTTP 400.
 */
export class InvalidRecordingBlueprintError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidRecordingBlueprintError'
  }
}

export type WorkspaceMember = {
  id: string
  workspaceId: string
  userId: string
  role: 'owner' | 'admin' | 'member'
  /**
   * Per-member feed/draft-app permission. Always effectively true for
   * owner/admin (callers should use `canMemberDraftRole` instead of
   * reading this raw value). For 'member' rows, admin/owner toggles via
   * PATCH /api/workspaces/:workspaceId/members/:userId/permissions.
   */
  canDraft: boolean
  /**
   * Per-member data clearance — the maximum sensitivity tier this member
   * can see or set on workspace-scoped entities (channels, knowledge,
   * memories). Added in migration 153 along with the workspace-channels
   * RLS policy that gates on `sensitivity_rank(<entity>.clearance) <=
   * sensitivity_rank(wm.clearance)`. The UI uses this to filter the
   * clearance dropdown so a member can't try to raise an entity above
   * their own tier (which the RLS WITH CHECK would reject anyway).
   */
  clearance: 'public' | 'internal' | 'confidential'
  joinedAt: Date
  /** Joined from users table for display. */
  email?: string | null
  userName?: string | null
  avatarUrl?: string | null
}

/**
 * Effective draft permission for a (role, can_draft) pair.
 *
 * Owners and admins always have draft permission regardless of the
 * column value — the column only governs 'member'-role users.
 */
export function canMemberDraftRole(
  role: 'owner' | 'admin' | 'member',
  canDraft: boolean,
): boolean {
  return role === 'owner' || role === 'admin' || canDraft
}

// ── Column lists ───────────────────────────────────────────────

const WORKSPACE_COLUMNS = `
  id, name, purpose,
  owner_user_id AS "ownerUserId",
  icon_seed AS "iconSeed",
  is_personal AS "isPersonal",
  plan,
  default_recording_blueprint_id AS "defaultRecordingBlueprintId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
` as const

const MEMBER_COLUMNS = `
  wm.id, wm.workspace_id AS "workspaceId", wm.user_id AS "userId",
  wm.role, wm.can_draft AS "canDraft", wm.clearance,
  wm.joined_at AS "joinedAt",
  u.email, u.name AS "userName", u.avatar_url AS "avatarUrl"
` as const

// Live `workspace_members` counts for a set of workspace ids, computed on the
// SYSTEM (owner) pool so the count sees EVERY member row — not just the caller's
// own. This CANNOT be a correlated subquery inside `list()` / `get()`: those run
// under `queryWithRLS`, and the sole policy on `workspace_members`
// (`wm_own_workspace`: `user_id = current_user_id`) confines any read of that
// table to the caller's single membership row. A count taken under RLS is
// therefore ALWAYS 1, which made every multi-member workspace mis-render as
// "solo" in the connector-sharing UI — `isSharedWorkspace(memberCount)` keys on
// `memberCount > 1` (incident 2026-07-01). We mirror `isSoloWorkspaceSystem` /
// `listMembers`, which use the owner pool for exactly this reason. Membership
// size is not sensitive to a member (they can already call `listMembers`), so
// lifting only the count onto the owner pool exposes nothing new; the workspace
// rows themselves stay RLS-gated.
async function memberCountsSystem(
  workspaceIds: string[],
): Promise<Map<string, number>> {
  if (workspaceIds.length === 0) return new Map()
  const result = await query<{ workspaceId: string; count: number }>(
    `SELECT workspace_id AS "workspaceId", count(*)::int AS count
       FROM workspace_members
      WHERE workspace_id = ANY($1)
      GROUP BY workspace_id`,
    [workspaceIds],
  )
  return new Map(result.rows.map((r) => [r.workspaceId, r.count]))
}

// ── Store ──────────────────────────────────────────────────────

export type WorkspaceStore = {
  create(userId: string, name: string, purpose: string): Promise<Workspace>
  list(userId: string): Promise<Workspace[]>
  get(userId: string, workspaceId: string): Promise<Workspace | null>
  update(userId: string, workspaceId: string, updates: { name?: string; purpose?: string }): Promise<Workspace | null>
  /**
   * Set (or clear) the workspace's default recording blueprint (migration 291).
   * `templateId === null` clears it (ingest-only). A non-null id is VALIDATED:
   * the template must exist, belong to THIS workspace, and carry an `extraction`
   * spec (be a blueprint) — otherwise `InvalidRecordingBlueprintError` is thrown
   * (the route maps it to 400). Returns the updated workspace, or `null` when
   * the workspace is not found / not writable under RLS.
   */
  setDefaultRecordingBlueprint(userId: string, workspaceId: string, templateId: string | null): Promise<Workspace | null>
  delete(userId: string, workspaceId: string): Promise<boolean>
  listMembers(userId: string, workspaceId: string): Promise<WorkspaceMember[]>
  addMember(userId: string, workspaceId: string, memberUserId: string, role?: 'admin' | 'member'): Promise<WorkspaceMember>
  removeMember(userId: string, workspaceId: string, memberUserId: string): Promise<boolean>
  updateMemberRole(userId: string, workspaceId: string, memberUserId: string, role: 'admin' | 'member'): Promise<boolean>
  updateMemberDraftPermission(userId: string, workspaceId: string, memberUserId: string, canDraft: boolean): Promise<boolean>
  getRole(userId: string, workspaceId: string): Promise<'owner' | 'admin' | 'member' | null>
  /**
   * Look up (role, canDraft) for a (user, workspace) pair from a system
   * context (no RLS). Returns null when the user is not a member. Callers
   * compose with `canMemberDraftRole` to decide draft-route admission.
   */
  getMembership(userId: string, workspaceId: string): Promise<{ role: 'owner' | 'admin' | 'member'; canDraft: boolean } | null>
  adoptAssistant(userId: string, workspaceId: string, assistantId: string): Promise<boolean>
  removeAssistant(userId: string, workspaceId: string, assistantId: string): Promise<boolean>
  /** System-level lookup (no RLS) for worker context. */
  getByIdSystem(workspaceId: string): Promise<Workspace | null>
  /** Count free-plan workspaces owned by a user (the auto-created Personal
   * workspace included) — used to gate creation. A user with no paid
   * workspace may own at most 2 free-plan workspaces; owning any paid
   * workspace lifts the cap. Only ownership counts, never membership. */
  countFreeOwned(userId: string): Promise<number>
}

/**
 * Resolve the userId whose *personal* connector credentials a turn may
 * use. This always returns the workspace owner for a workspace assistant.
 * That is only *acted on* when the owner is the sole member — `injectMcpTools`
 * gates the owner-personal base-load on `isSoloWorkspaceSystem`
 * (live member count ≤ 1) and SUPPRESSES it for any multi-member workspace,
 * which draws tools only from team-native instances + `connector_grant`
 * overlays. Falls back to `baseUserId` if lookup fails or the assistant is
 * not workspace-bound.
 *
 * NOTE: this does NOT itself enforce the shared-workspace isolation — the
 * gate lives in `injectMcpTools`. Retiring this resolver entirely (per the
 * Stage-5 `resolveConnectorInstances` plan) is blocked until solo workspaces
 * stop relying on `scope='user'` connectors. See incident 2026-06-01.
 */
export async function getConnectorUserId(
  baseUserId: string,
  workspaceId: string | null | undefined,
): Promise<string> {
  if (!workspaceId) return baseUserId
  try {
    const row = await query<{ owner_user_id: string }>(
      `SELECT owner_user_id FROM workspaces WHERE id = $1`,
      [workspaceId],
    )
    if (row.rows[0]) {
      return row.rows[0].owner_user_id
    }
  } catch (err) {
    console.error('[workspace-store] workspace owner lookup failed, falling back to base user:', err)
  }
  return baseUserId
}

/**
 * System-level check that gates the owner-personal connector **base load**
 * in `injectMcpTools` (and the editor list in `GET /:assistantId/connectors`):
 * may this workspace inject the owner's personal `scope='user'` connectors as
 * its base tool set? True only when the owner is still the workspace's **sole
 * member** — keyed purely on the live `workspace_members` count, never on
 * `is_personal`.
 *
 * Why member count, not `is_personal` (incident 2026-06-01, re-opened
 * 2026-06-02): `is_personal` is NOT a "solo" flag. Per
 * `docs/architecture/platform/workspaces.md`, it is only a label marking the
 * auto-created **default** workspace, and teammates are invited *into that
 * same workspace* with no "promote to team" migration. So an `is_personal=true`
 * workspace routinely has multiple members — keying the gate on the flag loaded
 * the owner's private Gmail/Notion/etc. for every member (owner impersonation).
 * The real "is the owner the only one who could be impersonated" signal is the
 * live member count, so we check it directly and treat every workspace
 * identically: a solo workspace of any kind loads the owner's personal
 * connectors (the owner is the only identity that could be acted as, so there
 * is nothing to leak); a multi-member workspace of any kind suppresses them,
 * drawing tools solely from team-native instances + explicit `connector_grant`
 * exposures.
 *
 * Uses bare `query()` (system bypass) so the member COUNT sees every row, not
 * just the caller's own `workspace_members` row under RLS.
 *
 * Fails CLOSED: on a missing row or a lookup error this returns `false`
 * (suppress the owner's personal connectors). A transient failure therefore
 * degrades to "tools temporarily missing" for that turn, never to re-opening
 * the leak.
 */
export async function isSoloWorkspaceSystem(
  workspaceId: string,
): Promise<boolean> {
  try {
    const result = await query<{ solo: boolean }>(
      `SELECT (
         (SELECT count(*) FROM workspace_members wm WHERE wm.workspace_id = w.id) <= 1
       ) AS solo
       FROM workspaces w
       WHERE w.id = $1`,
      [workspaceId],
    )
    return result.rows[0]?.solo === true
  } catch (err) {
    console.error('[workspace-store] isSoloWorkspaceSystem failed, treating as shared:', err)
    return false
  }
}

/**
 * System-level lookup of a user's role in a workspace. Uses `query()` (no
 * RLS) because webhook-driven checks run before a user session is
 * established — see BYO TG group add-protection in `routes/telegram-byo.ts`.
 *
 * Returns `null` when the user is not a member of the workspace.
 */
export async function getWorkspaceRoleSystem(
  userId: string,
  workspaceId: string,
): Promise<'owner' | 'admin' | 'member' | null> {
  try {
    const result = await query<{ role: 'owner' | 'admin' | 'member' }>(
      `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId],
    )
    return result.rows[0]?.role ?? null
  } catch (err) {
    console.error('[workspace-store] getWorkspaceRoleSystem failed:', err)
    return null
  }
}

/**
 * System-level lookup of (role, can_draft) for a (user, workspace) pair.
 * Compose with `canMemberDraftRole` to gate draft-app routes.
 *
 * Returns `null` when the user is not a member of the workspace.
 */
export async function getWorkspaceMembershipSystem(
  userId: string,
  workspaceId: string,
): Promise<{ role: 'owner' | 'admin' | 'member'; canDraft: boolean } | null> {
  try {
    const result = await query<{
      role: 'owner' | 'admin' | 'member'
      canDraft: boolean
    }>(
      `SELECT role, can_draft AS "canDraft"
         FROM workspace_members
        WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId],
    )
    const row = result.rows[0]
    if (!row) return null
    return { role: row.role, canDraft: row.canDraft }
  } catch (err) {
    console.error('[workspace-store] getWorkspaceMembershipSystem failed:', err)
    return null
  }
}

/**
 * System-level lookup of (role, clearance) for a (user, workspace) pair.
 *
 * Uses `query()` (no RLS) because the caller — the doc-files route
 * (`packages/api/src/routes/doc-files.ts`) — runs the membership gate
 * BEFORE any user-scoped read; the lookup is the gate itself, so it cannot
 * depend on the RLS it is about to authorize. `clearance` is the member's
 * `workspace_members.clearance` (migration 153) used to build the
 * `FilesContext` the upload runs under.
 *
 * Returns `null` when the user is not a member of the workspace — the
 * route translates that to a 403.
 */
export async function getWorkspaceMembershipWithClearanceSystem(
  userId: string,
  workspaceId: string,
): Promise<{ role: 'owner' | 'admin' | 'member'; clearance: 'public' | 'internal' | 'confidential' } | null> {
  try {
    const result = await query<{
      role: 'owner' | 'admin' | 'member'
      clearance: 'public' | 'internal' | 'confidential'
    }>(
      `SELECT role, clearance
         FROM workspace_members
        WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId],
    )
    const row = result.rows[0]
    if (!row) return null
    return { role: row.role, clearance: row.clearance }
  } catch (err) {
    console.error('[workspace-store] getWorkspaceMembershipWithClearanceSystem failed:', err)
    return null
  }
}

/**
 * Resolve the READ-side clearance ceiling for a turn — `min(actingMember,
 * assistant)`. This is the value to put in `AccessContext.clearance` /
 * `ToolContext.clearance` (the read-filter ceiling), NOT the write ceiling
 * (which stays `assistant.clearance` via `ToolContext.assistantClearance`).
 *
 * Closes the read-side leak where a low-clearance member read confidential
 * workspace data through a higher-clearance assistant (incident 2026-06-01):
 * the assistant operated at its own clearance for reads, ignoring the
 * member's tier. Capping reads at `min(member, assistant)` closes it with
 * ZERO lockouts (the member keeps using the assistant; only their reads are
 * bounded). See docs/architecture/platform/sensitivity.md → "Read-side clearance".
 *
 * Role bump: owner/admin are operators — effectively `confidential` (the
 * mig-153 intent: "owner/admin backfill to confidential so operators keep
 * seeing"). The column may still read `internal` for workspaces created
 * after the backfill (the default), so we bump by role rather than trust the
 * raw column, which keeps `min()` from wrongly restricting an operator.
 * Non-members (e.g. channel participants with no `workspace_members` row) get
 * `public` — most restrictive. No workspace → the assistant's own clearance
 * (no member concept).
 */
export async function resolveReadClearanceSystem(
  userId: string,
  workspaceId: string | null | undefined,
  assistantClearance: Sensitivity,
): Promise<Sensitivity> {
  if (!workspaceId) return assistantClearance
  const membership = await getWorkspaceMembershipWithClearanceSystem(userId, workspaceId)
  // Non-member (e.g. channel participant) → null → 'public' (most restrictive).
  return effectiveReadClearance(membership?.role ?? null, membership?.clearance ?? null, assistantClearance)
}

/**
 * Pure read-ceiling computation — `min(effectiveMember, assistant)` with the
 * owner/admin role bump (see `resolveReadClearanceSystem`). Split out so
 * callers that already hold the membership row (e.g. the brain explorer) can
 * apply the bound without a second query. `role === null` (non-member) maps to
 * the most-restrictive `public`.
 */
export function effectiveReadClearance(
  role: 'owner' | 'admin' | 'member' | null,
  memberClearance: Sensitivity | null,
  assistantClearance: Sensitivity,
): Sensitivity {
  const effectiveMemberClearance: Sensitivity =
    role === 'owner' || role === 'admin'
      ? 'confidential' // operators — mig-153 intent, regardless of the stored column
      : (memberClearance ?? 'public') // member uses column; non-member → public
  return minSensitivity(effectiveMemberClearance, assistantClearance)
}

/**
 * System-level fetch of a member's role + compartment grant (the
 * non-hierarchical MLS category axis — see docs/plans/compartment-axis.md).
 * Parallels `getWorkspaceMembershipWithClearanceSystem`; kept separate so the
 * clearance read path stays untouched. Uses `query()` (no RLS) for the same
 * gate-can't-depend-on-the-RLS-it-authorizes reason. `compartments` is the
 * nullable `workspace_members.compartments` column (migration 243); `NULL`
 * means the universe grant. Returns `null` when the user is not a member.
 */
export async function getWorkspaceMembershipWithCompartmentsSystem(
  userId: string,
  workspaceId: string,
): Promise<{ role: 'owner' | 'admin' | 'member'; compartments: string[] | null } | null> {
  try {
    const result = await query<{
      role: 'owner' | 'admin' | 'member'
      compartments: string[] | null
    }>(
      `SELECT role, compartments
         FROM workspace_members
        WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId],
    )
    const row = result.rows[0]
    if (!row) return null
    return { role: row.role, compartments: row.compartments ?? null }
  } catch (err) {
    console.error('[workspace-store] getWorkspaceMembershipWithCompartmentsSystem failed:', err)
    return null
  }
}

/**
 * Resolve the READ-side compartment grant for a turn — the intersection
 * `member ∩ assistant` (the compartment analogue of
 * `resolveReadClearanceSystem`'s `min(member, assistant)`). This is the value
 * to put in `AccessContext.compartments`. Returns `string[] | null` where
 * `null` is the universe grant (predicate clause dropped). NOT yet wired at
 * entry points — the read-gate ships inert until wiring lands. See
 * docs/plans/compartment-axis.md.
 *
 * No workspace → the assistant's own grant (no member concept), mirroring the
 * clearance resolver's passthrough.
 */
export async function resolveReadCompartmentsSystem(
  userId: string,
  workspaceId: string | null | undefined,
  assistantCompartments: string[] | null,
): Promise<string[] | null> {
  if (!workspaceId) return assistantCompartments
  const membership = await getWorkspaceMembershipWithCompartmentsSystem(userId, workspaceId)
  return effectiveReadCompartments(
    membership?.role ?? null,
    membership?.compartments ?? null,
    assistantCompartments,
  )
}

/**
 * Pure compartment-grant computation — `member ∩ assistant` with `null` acting
 * as the universe. Split out (like `effectiveReadClearance`) so callers holding
 * the membership row apply the bound without a second query.
 *
 * - owner/admin: universe member grant (`null`) — operators keep seeing, the
 *   compartment analogue of the clearance owner/admin bump.
 * - non-member (`role === null`, e.g. a channel participant): the empty grant
 *   (`[]`) — cleared into nothing, so only uncompartmented rows; the
 *   most-restrictive choice (analogue of clearance's `public`).
 * - plain member: their column grant; `null` (the inert default) = universe.
 */
export function effectiveReadCompartments(
  role: 'owner' | 'admin' | 'member' | null,
  memberCompartments: string[] | null,
  assistantCompartments: string[] | null,
): string[] | null {
  const effectiveMember: string[] | null =
    role === 'owner' || role === 'admin'
      ? null // universe — operators keep seeing
      : role === null
        ? [] // non-member → cleared into nothing (only uncompartmented rows)
        : memberCompartments // plain member: column grant; null = universe
  return intersectCompartments(effectiveMember, assistantCompartments)
}

/**
 * Set-intersection of two compartment grants where `null` is the universe (the
 * identity element): `null ∩ x = x`. Two finite grants intersect to the
 * compartments common to both. Mirrors the algebra that collapses a
 * two-principal superset gate to one: `g ⊇ R ∧ h ⊇ R ⟺ (g ∩ h) ⊇ R`.
 *
 * Inputs are assumed registry-deduped (`workspace_compartments` carries
 * `UNIQUE (workspace_id, key)`); the result preserves the left grant's order
 * and does not re-dedupe. Harmless for the `<@` read clause (Postgres array
 * containment is set-semantic), but a caller that compares grants by deep
 * equality should normalise first.
 */
export function intersectCompartments(
  a: string[] | null,
  b: string[] | null,
): string[] | null {
  if (a === null) return b
  if (b === null) return a
  const bSet = new Set(b)
  return a.filter((c) => bSet.has(c))
}

/**
 * Fused read-ceiling resolver — ONE `workspace_members` fetch yielding BOTH the
 * clearance ceiling (`min(member, assistant)`) and the compartment grant
 * (`member ∩ assistant`). The entry-point caller should use this instead of
 * calling `resolveReadClearanceSystem` + `resolveReadCompartmentsSystem`
 * separately (which would issue two near-identical membership queries per turn).
 * No workspace → the assistant's own ceilings (no member concept). See
 * docs/plans/compartment-axis.md.
 */
export async function resolveReadCeilingsSystem(
  userId: string,
  workspaceId: string | null | undefined,
  assistantClearance: Sensitivity,
  assistantCompartments: string[] | null,
): Promise<{ clearance: Sensitivity; compartments: string[] | null }> {
  if (!workspaceId) {
    return { clearance: assistantClearance, compartments: assistantCompartments }
  }
  const membership = await getWorkspaceMembershipWithCeilingsSystem(userId, workspaceId)
  const role = membership?.role ?? null
  return {
    clearance: effectiveReadClearance(role, membership?.clearance ?? null, assistantClearance),
    compartments: effectiveReadCompartments(role, membership?.compartments ?? null, assistantCompartments),
  }
}

/**
 * One membership fetch for the fused resolver — `role, clearance, compartments`
 * in a single `query()` (no RLS — the gate can't depend on the RLS it
 * authorizes, same as the per-axis fetchers it replaces).
 */
async function getWorkspaceMembershipWithCeilingsSystem(
  userId: string,
  workspaceId: string,
): Promise<{
  role: 'owner' | 'admin' | 'member'
  clearance: Sensitivity
  compartments: string[] | null
} | null> {
  try {
    const result = await query<{
      role: 'owner' | 'admin' | 'member'
      clearance: Sensitivity
      compartments: string[] | null
    }>(
      `SELECT role, clearance, compartments
         FROM workspace_members
        WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId],
    )
    const row = result.rows[0]
    if (!row) return null
    return { role: row.role, clearance: row.clearance, compartments: row.compartments ?? null }
  } catch (err) {
    console.error('[workspace-store] getWorkspaceMembershipWithCeilingsSystem failed:', err)
    return null
  }
}

/**
 * System-level lookup of a workspace's purpose string. Used by chat /
 * telegram / channel-pipeline routes to ground the model's
 * workspace-vs-user routing decision (rendered into the
 * `## Workspace Context` block; see context-builder.ts).
 *
 * Returns the purpose string (possibly empty for legacy workspaces) or
 * `null` when the workspace doesn't exist or the lookup fails.
 */
export async function getWorkspacePurpose(
  workspaceId: string | null | undefined,
): Promise<string | null> {
  if (!workspaceId) return null
  try {
    const row = await query<{ purpose: string }>(
      `SELECT purpose FROM workspaces WHERE id = $1`,
      [workspaceId],
    )
    return row.rows[0]?.purpose ?? null
  } catch (err) {
    console.error('[workspace-store] workspace purpose lookup failed:', err)
    return null
  }
}

/**
 * System-level lookup of a workspace's default recording blueprint (migration
 * 291). Returns the `workspace_page_templates` id, or `null` when no default is
 * set, the workspace is missing, or the lookup fails. Null-safe by design: this
 * backs the channel-media-intake enqueue-edge resolver, and a recording must
 * never be blocked by a default-lookup error — it just falls back to
 * ingest-only. See docs/architecture/brain/structural-synthesis.md.
 */
export async function getWorkspaceDefaultRecordingBlueprint(
  workspaceId: string | null | undefined,
): Promise<string | null> {
  if (!workspaceId) return null
  try {
    const row = await query<{ default_recording_blueprint_id: string | null }>(
      `SELECT default_recording_blueprint_id FROM workspaces WHERE id = $1`,
      [workspaceId],
    )
    return row.rows[0]?.default_recording_blueprint_id ?? null
  } catch (err) {
    console.error('[workspace-store] default recording blueprint lookup failed, defaulting to none:', err)
    return null
  }
}

/**
 * System-level lookup of a workspace's identity (name + purpose) in a
 * single round-trip. Used by the distribution L1 soul which grounds both
 * the role framing and the topic scope. Returns null when the workspace
 * doesn't exist or the lookup fails.
 */
export async function getWorkspaceIdentity(
  workspaceId: string | null | undefined,
): Promise<{ name: string; purpose: string } | null> {
  if (!workspaceId) return null
  try {
    const row = await query<{ name: string; purpose: string }>(
      `SELECT name, purpose FROM workspaces WHERE id = $1`,
      [workspaceId],
    )
    return row.rows[0] ?? null
  } catch (err) {
    console.error('[workspace-store] workspace identity lookup failed:', err)
    return null
  }
}

// ── Workspace billing (migration 143) ──────────────────────────
//
// The workspace is the billing entity. These system-level helpers back
// the Stripe webhook and the billing routes. See
// docs/architecture/platform/cost-and-pricing.md.

export type WorkspacePlan = 'free' | 'pro' | 'max_5x' | 'max_10x' | 'enterprise'

export type WorkspaceBilling = {
  workspaceId: string
  ownerUserId: string
  plan: WorkspacePlan
  stripeCustomerId: string | null
  stripeSubscriptionId: string | null
  stripePriceId: string | null
  subscriptionStatus: string | null
  currentPeriodEnd: Date | null
  cancelAtPeriodEnd: boolean
  paymentFailedAt: Date | null
  trialVariant: string | null
  trialUsedAt: Date | null
  trialEndsAt: Date | null
}

const BILLING_COLUMNS = `
  id AS "workspaceId",
  owner_user_id AS "ownerUserId",
  plan,
  stripe_customer_id AS "stripeCustomerId",
  stripe_subscription_id AS "stripeSubscriptionId",
  stripe_price_id AS "stripePriceId",
  subscription_status AS "subscriptionStatus",
  current_period_end AS "currentPeriodEnd",
  cancel_at_period_end AS "cancelAtPeriodEnd",
  payment_failed_at AS "paymentFailedAt",
  trial_variant AS "trialVariant",
  trial_used_at AS "trialUsedAt",
  trial_ends_at AS "trialEndsAt"
` as const

/** System-level billing lookup by workspace id. Null if not found. */
export async function getWorkspaceBilling(
  workspaceId: string,
): Promise<WorkspaceBilling | null> {
  const result = await query<WorkspaceBilling>(
    `SELECT ${BILLING_COLUMNS} FROM workspaces WHERE id = $1`,
    [workspaceId],
  )
  return result.rows[0] ?? null
}

/**
 * System-level billing lookup by Stripe customer id — the only handle the
 * Stripe webhook has on `customer.subscription.*` events. NOT unique: one
 * owner can have several workspaces sharing a customer, so this returns
 * the first match; the webhook also carries `workspace_id` in metadata
 * (see `handleSubscriptionUpsert`) and prefers that when present.
 */
export async function getWorkspaceBillingByStripeCustomerId(
  stripeCustomerId: string,
): Promise<WorkspaceBilling | null> {
  const result = await query<WorkspaceBilling>(
    `SELECT ${BILLING_COLUMNS} FROM workspaces
     WHERE stripe_customer_id = $1
     ORDER BY is_personal DESC, created_at ASC
     LIMIT 1`,
    [stripeCustomerId],
  )
  return result.rows[0] ?? null
}

/** Resolve a workspace's plan for budget / model-tier gating. Falls back
 *  to `'free'` when the workspace is missing or the lookup fails — a turn
 *  must never be blocked by a billing-lookup error. */
export async function getWorkspacePlan(workspaceId: string): Promise<WorkspacePlan> {
  try {
    const result = await query<{ plan: WorkspacePlan }>(
      `SELECT plan FROM workspaces WHERE id = $1`,
      [workspaceId],
    )
    return result.rows[0]?.plan ?? 'free'
  } catch (err) {
    console.error('[workspace-store] getWorkspacePlan failed, defaulting to free:', err)
    return 'free'
  }
}

/**
 * Read the workspace's lifetime deep-research counter. Used by the chat
 * route to gate `mode: 'research'` turns against the free-plan quota
 * (5 per workspace; paid plans bypass the cap but still increment for
 * observability).
 *
 * Returns 0 when the workspace is missing or the lookup fails — a turn
 * must never be blocked by a counter-read error. The gate downstream
 * uses this together with `getWorkspacePlan` to decide allow / 402.
 *
 * Spec: migration 185_workspace_research_quota.sql.
 */
export async function getWorkspaceResearchUsed(workspaceId: string): Promise<number> {
  try {
    const result = await query<{ research_used_count: number }>(
      `SELECT research_used_count FROM workspaces WHERE id = $1`,
      [workspaceId],
    )
    return result.rows[0]?.research_used_count ?? 0
  } catch (err) {
    console.error('[workspace-store] getWorkspaceResearchUsed failed, defaulting to 0:', err)
    return 0
  }
}

/**
 * Atomically bump the deep-research counter and return the new value.
 * Called immediately after the quota gate passes, before the queryLoop
 * spawns — the increment is the side effect that makes the gate
 * meaningful. Failures are non-fatal: we log + return the pre-increment
 * value so the turn isn't denied because the counter write hiccupped
 * (Postgres reachable enough to run the gate read but not the bump is
 * pathological, and the gate already passed).
 */
export async function incrementWorkspaceResearchUsed(workspaceId: string): Promise<number> {
  try {
    const result = await query<{ research_used_count: number }>(
      `UPDATE workspaces
         SET research_used_count = research_used_count + 1
       WHERE id = $1
       RETURNING research_used_count`,
      [workspaceId],
    )
    return result.rows[0]?.research_used_count ?? 0
  } catch (err) {
    console.error('[workspace-store] incrementWorkspaceResearchUsed failed:', err)
    return 0
  }
}

/** Free-plan lifetime cap on `mode: 'research'` turns per workspace. */
export const FREE_RESEARCH_QUOTA = 5

/**
 * Persist a workspace's Stripe subscription state. Called from two places:
 *   - The Stripe webhook on `customer.subscription.{created,updated}`.
 *   - The promo-redeem flow's transaction, synchronously after the Stripe
 *     sub is created (so the workspace's plan is correct before the
 *     webhook lands — and even when no webhook will land at all, e.g.
 *     local dev without `stripe listen` forwarding).
 *
 * Full-snapshot update (pass explicit nulls) so the row is never
 * half-updated. `stripe_customer_id` is COALESCEd — never cleared.
 *
 * Pass `client` to run inside an existing pg transaction. Without it the
 * function uses a fresh pool connection via the bare `query()` helper.
 */
export async function updateWorkspaceStripeSubscription(
  workspaceId: string,
  fields: {
    plan: WorkspacePlan
    stripeCustomerId: string | null
    stripeSubscriptionId: string | null
    stripePriceId: string | null
    subscriptionStatus: string | null
    currentPeriodEnd: Date | null
    cancelAtPeriodEnd: boolean
  },
  client?: PoolClient,
): Promise<void> {
  const sql = `UPDATE workspaces SET
       plan = $1,
       stripe_customer_id = COALESCE($2, stripe_customer_id),
       stripe_subscription_id = $3,
       stripe_price_id = $4,
       subscription_status = $5,
       current_period_end = $6,
       cancel_at_period_end = $7,
       updated_at = now()
     WHERE id = $8`
  const params = [
    fields.plan,
    fields.stripeCustomerId,
    fields.stripeSubscriptionId,
    fields.stripePriceId,
    fields.subscriptionStatus,
    fields.currentPeriodEnd,
    fields.cancelAtPeriodEnd,
    workspaceId,
  ]
  if (client) {
    await client.query(sql, params)
  } else {
    await query(sql, params)
  }
}

/** Persist a workspace's Stripe customer id (set on first checkout). */
export async function setWorkspaceStripeCustomerId(
  workspaceId: string,
  stripeCustomerId: string,
): Promise<void> {
  await query(
    `UPDATE workspaces SET stripe_customer_id = $1, updated_at = now() WHERE id = $2`,
    [stripeCustomerId, workspaceId],
  )
}

/**
 * Stamp the trial marker the first time a workspace's subscription appears
 * in `trialing` status. Idempotent via `WHERE trial_used_at IS NULL` — a
 * workspace gets one trial, ever. `trial_ends_at` is the auto-charge date.
 *
 * Pass `client` to run inside an existing pg transaction (see
 * `updateWorkspaceStripeSubscription` for the rationale).
 */
export async function markWorkspaceTrialUsed(
  workspaceId: string,
  variant: 'standard_30' | 'early_adopter_90',
  trialEndsAt: Date | null,
  client?: PoolClient,
): Promise<void> {
  const sql = `UPDATE workspaces
     SET trial_variant = $2, trial_used_at = now(), trial_ends_at = $3,
         updated_at = now()
     WHERE id = $1 AND trial_used_at IS NULL`
  const params = [workspaceId, variant, trialEndsAt]
  if (client) {
    await client.query(sql, params)
  } else {
    await query(sql, params)
  }
}

/** Record (or clear) the most recent payment failure for a workspace. */
export async function setWorkspacePaymentFailedAt(
  workspaceId: string,
  at: Date | null,
): Promise<void> {
  await query(
    `UPDATE workspaces SET payment_failed_at = $1, updated_at = now() WHERE id = $2`,
    [at, workspaceId],
  )
}

/**
 * Stage-3/4 cascade hooks — deleted on workspace-member removal so a
 * leaving member's connector grants and channel routes on workspace
 * assistants don't linger. Both are optional.
 */
export type WorkspaceStoreCascades = {
  connectorGrantStore?: ConnectorGrantStore
  channelRouteStore?: ChannelRouteStore
}

export function createWorkspaceStore(cascades: WorkspaceStoreCascades = {}): WorkspaceStore {
  return {
    async create(userId, name, purpose) {
      const client = await getPool().connect()
      try {
        await client.query('BEGIN')

        const result = await client.query<Workspace>(
          `INSERT INTO workspaces (name, purpose, owner_user_id, icon_seed) VALUES ($1, $2, $3, $4)
           RETURNING ${WORKSPACE_COLUMNS}`,
          [name, purpose, userId, Math.floor(Math.random() * 1000000)],
        )
        const workspace = result.rows[0]

        // Add creator as owner member. Owner is an operator → 'confidential'
        // clearance (sensitivity.md → "User clearance (Q18)" role defaults).
        // The column DEFAULT is 'internal'; stamp it explicitly so the owner
        // can configure confidential channels/pages, whose write-side gates
        // read the raw column rather than the role (migration 236).
        await client.query(
          `INSERT INTO workspace_members (workspace_id, user_id, role, clearance) VALUES ($1, $2, 'owner', 'confidential')`,
          [workspace.id, userId],
        )

        // Every workspace gets a `kind='primary'` assistant in the same
        // transaction. It anchors the workspace home (the composer hero,
        // the workspace-scoped chat fallback) and is required for the
        // chat route's workspace-aware routing to resolve a default when
        // no assistantId is sent. Pre-this-migration, only the Personal
        // workspace created at signup got a primary; `POST /api/workspaces`
        // produced empty workspaces that silently routed chats to the
        // user's Personal primary. See migration 193_workspace_primary_backfill.
        //
        // owner_user_id stays NULL: workspace_members is the canonical
        // access path (matches POST /:workspaceId/assistants and the
        // 110 §6b ownership-XOR rule).
        const assistantResult = await client.query<{ id: string }>(
          `INSERT INTO assistants (name, owner_user_id, workspace_id, kind)
           VALUES ($1, NULL, $2, 'primary')
           RETURNING id`,
          [`${name} Primary Assistant`, workspace.id],
        )

        // §17 — primary assistants default-on for Tasks (Q1) and CRM
        // (Q2) primitive grants. Matches findOrCreateUser's defaults so
        // a workspace primary behaves identically to the Personal one.
        await client.query(
          `INSERT INTO assistant_capabilities
             (assistant_id, capability, granted_by_user_id, reason)
           VALUES ($1, 'tasks', $2, '§17 default-on at primary creation'),
                  ($1, 'crm',   $2, '§17 default-on at primary creation'),
                  ($1, 'goals', $2, 'goals default-on at primary creation'),
                  ($1, 'views', $2, 'doc-skill parity — default-on at primary creation'),
                  ($1, 'files', $2, 'doc-skill parity — default-on at primary creation')`,
          [assistantResult.rows[0].id, userId],
        )

        await client.query('COMMIT')
        return workspace
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },

    async list(userId) {
      const result = await queryWithRLS<Workspace>(
        userId,
        `SELECT ${WORKSPACE_COLUMNS} FROM workspaces
         WHERE id IN (SELECT workspace_id FROM workspace_members WHERE user_id = $1)
         ORDER BY is_personal DESC, created_at DESC`,
        [userId],
      )
      // memberCount is filled from the owner pool: under RLS the count would
      // always be 1 (see memberCountsSystem). Default to 1 only if a row is
      // absent from the count map (a workspace with zero members is impossible).
      const counts = await memberCountsSystem(result.rows.map((w) => w.id))
      return result.rows.map((w) => ({ ...w, memberCount: counts.get(w.id) ?? 1 }))
    },

    async get(userId, workspaceId) {
      const result = await queryWithRLS<Workspace>(
        userId,
        `SELECT ${WORKSPACE_COLUMNS} FROM workspaces WHERE id = $1`,
        [workspaceId],
      )
      const row = result.rows[0]
      if (!row) return null
      const counts = await memberCountsSystem([row.id])
      return { ...row, memberCount: counts.get(row.id) ?? 1 }
    },

    async update(userId, workspaceId, updates) {
      const sets: string[] = []
      const values: unknown[] = []
      let idx = 1
      if (updates.name !== undefined) { sets.push(`name = $${idx}`); values.push(updates.name); idx++ }
      if (updates.purpose !== undefined) { sets.push(`purpose = $${idx}`); values.push(updates.purpose); idx++ }
      if (sets.length === 0) {
        const fetched = await queryWithRLS<Workspace>(
          userId,
          `SELECT ${WORKSPACE_COLUMNS} FROM workspaces WHERE id = $1`,
          [workspaceId],
        )
        return fetched.rows[0] ?? null
      }
      values.push(workspaceId)
      const result = await queryWithRLS<Workspace>(
        userId,
        `UPDATE workspaces SET ${sets.join(', ')} WHERE id = $${idx}
         RETURNING ${WORKSPACE_COLUMNS}`,
        values,
      )
      return result.rows[0] ?? null
    },

    async setDefaultRecordingBlueprint(userId, workspaceId, templateId) {
      if (templateId !== null) {
        // Validate the template is a blueprint (carries an `extraction` spec)
        // AND lives in THIS workspace. Both checks ride the same RLS-scoped
        // SELECT — a cross-workspace id simply yields no row under the
        // `workspace_page_templates_workspace_member` policy, so a non-member's
        // template is indistinguishable from a missing one (no leak), and a
        // member's template in ANOTHER workspace is caught by the explicit
        // `workspace_id = $2` predicate.
        const check = await queryWithRLS<{ extraction: unknown }>(
          userId,
          `SELECT extraction FROM workspace_page_templates WHERE id = $1 AND workspace_id = $2`,
          [templateId, workspaceId],
        )
        const row = check.rows[0]
        if (!row) {
          throw new InvalidRecordingBlueprintError(
            'Blueprint not found in this workspace',
          )
        }
        if (row.extraction == null) {
          throw new InvalidRecordingBlueprintError(
            'Template is not a blueprint (no extraction spec)',
          )
        }
      }

      const result = await queryWithRLS<Workspace>(
        userId,
        `UPDATE workspaces SET default_recording_blueprint_id = $1, updated_at = now()
         WHERE id = $2
         RETURNING ${WORKSPACE_COLUMNS}`,
        [templateId, workspaceId],
      )
      return result.rows[0] ?? null
    },

    async delete(userId, workspaceId) {
      // The default ("Personal") workspace is not user-deletable — it's the
      // permanent anchor for ingest routing + primary-assistant lookup, tied to
      // the user's lifecycle (deleted only when the user is deleted, via
      // ON DELETE CASCADE on workspaces.owner_user_id). This deletion guard is
      // now the ONLY behavior keyed on `is_personal`; connector/sharing
      // behavior all keys on member count (solo vs shared) instead.
      const result = await queryWithRLS(
        userId,
        `DELETE FROM workspaces WHERE id = $1 AND owner_user_id = $2 AND is_personal = false`,
        [workspaceId, userId],
      )
      return (result.rowCount ?? 0) > 0
    },

    async listMembers(_userId, workspaceId) {
      // Lists EVERY member of the workspace, so it must NOT be confined by the
      // per-user RLS on `workspace_members`/`users` (each policy exposes only
      // the caller's own row). It is a system read: it runs on the system pool
      // (the owner role), which bypasses RLS — full-member visibility with no
      // GUC to set or leak.
      const result = await query<WorkspaceMember>(
        `SELECT ${MEMBER_COLUMNS}
           FROM workspace_members wm
           JOIN users u ON u.id = wm.user_id
          WHERE wm.workspace_id = $1
          ORDER BY wm.joined_at ASC`,
        [workspaceId],
      )
      return result.rows
    },

    async addMember(_userId, workspaceId, memberUserId, role = 'member') {
      // Clearance tracks the role default (sensitivity.md → "User clearance
      // (Q18)"): admin is an operator → 'confidential', member → 'internal'.
      // Until Q18 explicit per-member grants ship, role is the sole clearance
      // source; the write-side channel/page gates read this raw column.
      const clearance = role === 'admin' ? 'confidential' : 'internal'
      const result = await query<WorkspaceMember>(
        `INSERT INTO workspace_members (workspace_id, user_id, role, clearance) VALUES ($1, $2, $3, $4)
         RETURNING id, workspace_id AS "workspaceId", user_id AS "userId", role, joined_at AS "joinedAt"`,
        [workspaceId, memberUserId, role, clearance],
      )
      const member = result.rows[0]

      // Add the new member to all workspace assistants
      await query(
        `INSERT INTO assistant_members (assistant_id, user_id, role)
         SELECT a.id, $1, 'member'
         FROM assistants a WHERE a.workspace_id = $2
         ON CONFLICT (assistant_id, user_id) DO NOTHING`,
        [memberUserId, workspaceId],
      )

      return member
    },

    async removeMember(_userId, workspaceId, memberUserId) {
      await query(
        `DELETE FROM assistant_members
         WHERE user_id = $1
           AND assistant_id IN (SELECT id FROM assistants WHERE workspace_id = $2)
           AND role <> 'owner'`,
        [memberUserId, workspaceId],
      )

      if (cascades.connectorGrantStore) {
        try {
          await cascades.connectorGrantStore.deleteByGrantorAndTargetSystem(
            memberUserId, 'workspace', workspaceId,
          )
        } catch (err) {
          console.error('[workspace-store] grant cleanup on member removal failed:', err)
        }
      }

      if (cascades.channelRouteStore) {
        try {
          await query(
            `DELETE FROM channel_routes cr
             USING linked_identities li
             WHERE cr.provider = li.provider
               AND cr.provider_id = li.provider_id
               AND li.user_id = $1
               AND cr.assistant_id IN (SELECT id FROM assistants WHERE workspace_id = $2)`,
            [memberUserId, workspaceId],
          )
        } catch (err) {
          console.error('[workspace-store] channel_routes cleanup on member removal failed:', err)
        }
      }

      const result = await query(
        `DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 AND role <> 'owner'`,
        [workspaceId, memberUserId],
      )
      return (result.rowCount ?? 0) > 0
    },

    async updateMemberRole(_userId, workspaceId, memberUserId, role) {
      // Keep clearance aligned with the new role default (admin →
      // 'confidential', member → 'internal') so a promotion grants the
      // operator the confidential reads/writes the role implies, and a
      // demotion drops it. Role is the sole clearance source until Q18
      // explicit grants ship. See sensitivity.md → "User clearance (Q18)".
      const clearance = role === 'admin' ? 'confidential' : 'internal'
      const result = await query(
        `UPDATE workspace_members SET role = $1, clearance = $4
         WHERE workspace_id = $2 AND user_id = $3 AND role <> 'owner'`,
        [role, workspaceId, memberUserId, clearance],
      )
      return (result.rowCount ?? 0) > 0
    },

    async updateMemberDraftPermission(_userId, workspaceId, memberUserId, canDraft) {
      const result = await query(
        `UPDATE workspace_members SET can_draft = $1
         WHERE workspace_id = $2 AND user_id = $3 AND role <> 'owner'`,
        [canDraft, workspaceId, memberUserId],
      )
      return (result.rowCount ?? 0) > 0
    },

    async getRole(userId, workspaceId) {
      const result = await queryWithRLS<{ role: 'owner' | 'admin' | 'member' }>(
        userId,
        `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
        [workspaceId, userId],
      )
      return result.rows[0]?.role ?? null
    },

    async getMembership(userId, workspaceId) {
      const result = await queryWithRLS<{
        role: 'owner' | 'admin' | 'member'
        canDraft: boolean
      }>(
        userId,
        `SELECT role, can_draft AS "canDraft"
           FROM workspace_members
          WHERE workspace_id = $1 AND user_id = $2`,
        [workspaceId, userId],
      )
      const row = result.rows[0]
      if (!row) return null
      return { role: row.role, canDraft: row.canDraft }
    },

    async adoptAssistant(userId, workspaceId, assistantId) {
      // Transfer-of-ownership: caller's Personal workspace → target
      // workspace. Requirements:
      //   - Caller owns the assistant (assistant_members.role='owner').
      //   - Assistant currently lives in caller's Personal workspace
      //     (post-§9 every assistant has a workspace_id).
      const ownerCheck = await queryWithRLS<{ role: string }>(
        userId,
        `SELECT role FROM assistant_members WHERE assistant_id = $1 AND user_id = $2`,
        [assistantId, userId],
      )
      if (!ownerCheck.rows[0] || ownerCheck.rows[0].role !== 'owner') return false

      const client = await getPool().connect()
      try {
        await client.query('BEGIN')

        const updated = await client.query(
          `UPDATE assistants a
             SET workspace_id = $1,
                 owner_user_id = NULL
           FROM workspaces w
           WHERE a.id = $2
             AND a.workspace_id = w.id
             AND w.owner_user_id = $3
             AND w.is_personal = true`,
          [workspaceId, assistantId, userId],
        )
        if ((updated.rowCount ?? 0) === 0) {
          await client.query('ROLLBACK')
          return false
        }

        await client.query(
          `DELETE FROM assistant_members WHERE assistant_id = $1`,
          [assistantId],
        )

        await client.query('COMMIT')
        return true
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },

    async removeAssistant(userId, workspaceId, assistantId) {
      // Transfer-of-ownership: workspace → workspace owner's Personal.
      const newOwnerRow = await query<{ ownerUserId: string; personalWorkspaceId: string | null }>(
        `SELECT w.owner_user_id AS "ownerUserId",
                pw.id            AS "personalWorkspaceId"
         FROM workspaces w
         LEFT JOIN workspaces pw ON pw.owner_user_id = w.owner_user_id AND pw.is_personal = true
         WHERE w.id = $1`,
        [workspaceId],
      )
      const newOwnerUserId = newOwnerRow.rows[0]?.ownerUserId
      const newWorkspaceId = newOwnerRow.rows[0]?.personalWorkspaceId
      if (!newOwnerUserId || !newWorkspaceId) return false

      const client = await getPool().connect()
      try {
        await client.query('BEGIN')

        const updated = await client.query(
          `UPDATE assistants
             SET workspace_id = $1,
                 owner_user_id = $2
           WHERE id = $3 AND workspace_id = $4`,
          [newWorkspaceId, newOwnerUserId, assistantId, workspaceId],
        )
        if ((updated.rowCount ?? 0) === 0) {
          await client.query('ROLLBACK')
          return false
        }

        await client.query(
          `DELETE FROM assistant_members WHERE assistant_id = $1`,
          [assistantId],
        )
        await client.query(
          `INSERT INTO assistant_members (assistant_id, user_id, role)
           VALUES ($1, $2, 'owner')
           ON CONFLICT (assistant_id, user_id) DO UPDATE SET role = 'owner'`,
          [assistantId, newOwnerUserId],
        )

        await client.query('COMMIT')
        return true
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },

    async getByIdSystem(workspaceId) {
      const result = await query<Workspace>(
        `SELECT ${WORKSPACE_COLUMNS} FROM workspaces WHERE id = $1`,
        [workspaceId],
      )
      return result.rows[0] ?? null
    },

    async countFreeOwned(userId) {
      const result = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM workspaces
         WHERE owner_user_id = $1 AND plan = 'free'`,
        [userId],
      )
      return parseInt(result.rows[0]?.count ?? '0', 10)
    },
  }
}
