/**
 * Workspace skill store — CRUD for workspace-scoped + community skills,
 * plus per-assistant enablement and curator bookkeeping.
 *
 * V2 substrate (`docs/architecture/engine/skill-system.md` §S10–S15 +
 * CL-8). Built on top of mig 168's `workspace_skills` table (renamed from
 * `skills` in the same migration). Built-in skills are loaded from disk
 * (`packages/core/src/skills/builtin/`); this store handles user, community,
 * and auto-generated skills that live in the database.
 *
 * Two interfaces, one factory, two factory entrypoints:
 *
 *   * `WorkspaceSkillStore` — the new canonical surface. Every method takes
 *     `workspaceId` so the WS-B/C/D workstreams can reason about workspace-
 *     scoped curator queries, lifecycle transitions, and lease acquisition.
 *     Created via `createDbWorkspaceSkillStore()`.
 *
 *   * `SkillStore` — the legacy userId-keyed alias kept alive so existing
 *     route + injection sites keep compiling. Each method resolves the
 *     user's primary workspace inline (personal workspace by default,
 *     otherwise the oldest membership) and forwards to the new surface.
 *     Created via `createDbSkillStore()`. Deprecated — callers should
 *     migrate to `WorkspaceSkillStore` over time.
 *
 * [COMP:api/skill-store]
 */

import { query, queryWithRLS } from './client.js'
import { notifyWorkspaceChange } from '../brain-stream/notify.js'
import type { SkillContent, SkillMeta } from '@sidanclaw/core'
import {
  SKILL_ACTIVATION_THRESHOLD,
  SKILL_USAGE_CONFIDENCE_INCREMENT,
  SKILL_USAGE_CONFIDENCE_CAP,
  bornConfidence,
  bornActivated,
  bornVerified,
} from '@sidanclaw/core'

// ── Inputs ─────────────────────────────────────────────────────────

export type CreateSkillInput = {
  slug: string
  name: string
  description: string
  whenToUse?: string
  content: string
  category?: string
  requiresConnectors?: string[]
  /** Defaults to 'user'. Set 'auto-generated' for REM-emitted skills. */
  source?: 'user' | 'auto-generated' | 'community'
  /** Defaults: 'auto-generated' → 'background_review', else 'foreground'. */
  writeOrigin?: 'foreground' | 'background_review'
  originatingAssistantId?: string | null
  /**
   * Procedural-brain provenance tier (mig 260, plan §5.3). 'authored' = a human
   * wrote it (born active); 'self' = induced from the team's own interaction;
   * 'ingested' = induced from ingested external content (hard bar — never
   * auto-active). Defaults to 'authored', or 'self' for auto-generated rows.
   */
  inductionSource?: 'self' | 'ingested' | 'authored'
  /** Clearance chosen at birth (brain-skill-management plan §3.2 — the
   *  creator's suggested sensitivity). When provided it counts as a manual
   *  choice: `sensitivity_overridden = true` so edge inheritance won't move
   *  it. Defaults to the column default ('internal'), inheritable. */
  sensitivity?: 'public' | 'internal' | 'confidential'
}

export type UpdateSkillInput = {
  name?: string
  description?: string
  whenToUse?: string | null
  content?: string
  category?: string
  requiresConnectors?: string[]
  /** Manual clearance choice (brain-skill-management plan §3.3). Setting it
   *  also flips `sensitivity_overridden = true` so edge-derived inheritance
   *  (`setInheritedSensitivity`) stops touching the row. */
  sensitivity?: 'public' | 'internal' | 'confidential'
}

// ── Row types ──────────────────────────────────────────────────────

/** Full row including every V2 column — used by curator + admin paths. */
export type WorkspaceSkillRow = {
  id: string
  workspace_id: string
  slug: string
  name: string
  description: string
  when_to_use: string | null
  content: string
  category: string
  requires_connectors: string[]
  source: string
  author_id: string | null
  published: boolean
  // S11
  write_origin: 'foreground' | 'background_review'
  // S12
  state: 'active' | 'stale' | 'archived'
  state_transitioned_at: Date
  last_invoked_at: Date | null
  // S13
  pinned: boolean
  pinned_at: Date | null
  // S14
  originating_assistant_id: string | null
  auto_generated_at: Date | null
  acknowledged_at: Date | null
  // S15
  absorbed_into: string | null
  absorbed_at: Date | null
  // S10
  last_patch_diff: string | null
  last_patch_diff_at: Date | null
  review_lease_held_by: string | null
  review_lease_until: Date | null
  // CL-8
  invocations: number
  succeeded: number
  user_corrected_after: number
  // Bi-temporal
  valid_from: Date
  valid_to: Date | null
  superseded_by: string | null
  // Procedural-brain governance (mig 260)
  confidence: number
  activated_at: Date | null
  rederivation_count: number
  induction_source: 'self' | 'ingested' | 'authored'
  sensitivity: 'public' | 'internal' | 'confidential'
  sensitivity_overridden: boolean
  verified_by_user_id: string | null
  verified_at: Date | null
  // Structural-synthesis Phase 2 (mig 301): the v2 blueprint this skill fills.
  blueprint_id: string | null
}

/** App-shape view returned by curator / lifecycle methods. */
export type WorkspaceSkill = {
  /** Row UUID. */
  rowId: string
  /** Slug — also the `SkillContent.id` for runtime resolution. */
  id: string
  workspaceId: string
  slug: string
  name: string
  description: string
  whenToUse?: string
  content: string
  category: string
  requiresConnectors: string[]
  source: 'builtin' | 'user' | 'community' | 'auto-generated'
  authorId?: string
  published: boolean
  writeOrigin: 'foreground' | 'background_review'
  state: 'active' | 'stale' | 'archived'
  stateTransitionedAt: Date
  lastInvokedAt?: Date
  pinned: boolean
  pinnedAt?: Date
  originatingAssistantId?: string
  autoGeneratedAt?: Date
  acknowledgedAt?: Date
  absorbedInto?: string
  absorbedAt?: Date
  lastPatchDiff?: string
  lastPatchDiffAt?: Date
  reviewLeaseHeldBy?: string
  reviewLeaseUntil?: Date
  invocations: number
  succeeded: number
  userCorrectedAfter: number
  validFrom: Date
  validTo?: Date
  supersededBy?: string
  // Procedural-brain governance (mig 260)
  confidence: number
  activatedAt?: Date
  rederivationCount: number
  inductionSource: 'self' | 'ingested' | 'authored'
  sensitivity: 'public' | 'internal' | 'confidential'
  sensitivityOverridden: boolean
  verifiedByUserId?: string
  verifiedAt?: Date
  /** The v2 blueprint (workspace_page_templates id) this skill fills, if any. */
  blueprintId?: string
}

// ── Mappers ────────────────────────────────────────────────────────

function rowToSkillContent(row: WorkspaceSkillRow): SkillContent {
  return {
    id: row.slug,
    name: row.name,
    description: row.description,
    whenToUse: row.when_to_use ?? undefined,
    content: row.content,
    category: row.category as SkillContent['category'],
    requiresConnectors: row.requires_connectors ?? [],
    source: row.source as SkillContent['source'],
    authorId: row.author_id ?? undefined,
    blueprintId: row.blueprint_id ?? undefined,
  }
}

function rowToSkillMeta(row: Omit<WorkspaceSkillRow, 'content'>): SkillMeta {
  return {
    id: row.slug,
    name: row.name,
    description: row.description,
    whenToUse: row.when_to_use ?? undefined,
    category: row.category as SkillMeta['category'],
    requiresConnectors: row.requires_connectors ?? [],
    source: row.source as SkillMeta['source'],
    authorId: row.author_id ?? undefined,
  }
}

function rowToWorkspaceSkill(row: WorkspaceSkillRow): WorkspaceSkill {
  return {
    rowId: row.id,
    id: row.slug,
    workspaceId: row.workspace_id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    whenToUse: row.when_to_use ?? undefined,
    content: row.content,
    category: row.category,
    requiresConnectors: row.requires_connectors ?? [],
    source: row.source as WorkspaceSkill['source'],
    authorId: row.author_id ?? undefined,
    published: row.published,
    writeOrigin: row.write_origin,
    state: row.state,
    stateTransitionedAt: row.state_transitioned_at,
    lastInvokedAt: row.last_invoked_at ?? undefined,
    pinned: row.pinned,
    pinnedAt: row.pinned_at ?? undefined,
    originatingAssistantId: row.originating_assistant_id ?? undefined,
    autoGeneratedAt: row.auto_generated_at ?? undefined,
    acknowledgedAt: row.acknowledged_at ?? undefined,
    absorbedInto: row.absorbed_into ?? undefined,
    absorbedAt: row.absorbed_at ?? undefined,
    lastPatchDiff: row.last_patch_diff ?? undefined,
    lastPatchDiffAt: row.last_patch_diff_at ?? undefined,
    reviewLeaseHeldBy: row.review_lease_held_by ?? undefined,
    reviewLeaseUntil: row.review_lease_until ?? undefined,
    invocations: row.invocations,
    succeeded: row.succeeded,
    userCorrectedAfter: row.user_corrected_after,
    validFrom: row.valid_from,
    validTo: row.valid_to ?? undefined,
    supersededBy: row.superseded_by ?? undefined,
    // Procedural-brain governance (mig 260)
    confidence: row.confidence,
    activatedAt: row.activated_at ?? undefined,
    rederivationCount: row.rederivation_count,
    inductionSource: row.induction_source,
    sensitivity: row.sensitivity,
    sensitivityOverridden: row.sensitivity_overridden,
    verifiedByUserId: row.verified_by_user_id ?? undefined,
    verifiedAt: row.verified_at ?? undefined,
    blueprintId: row.blueprint_id ?? undefined,
  }
}

// SELECT projection — wildcard is safe here because the row type lists every
// column. Kept centralised so column-shape changes only need touching here.
const COLS_ALL = '*'

// ── Public store interface (V2 canonical) ──────────────────────────

export type WorkspaceSkillStore = {
  // ── Workspace-scoped CRUD ────────────────────────────────────────
  /** All visible skills (bi-temporally alive) in the workspace. */
  listForWorkspace(workspaceId: string, opts?: { actingUserId?: string }): Promise<WorkspaceSkill[]>
  create(userId: string, workspaceId: string, input: CreateSkillInput): Promise<WorkspaceSkill>
  update(
    userId: string,
    workspaceId: string,
    skillId: string,
    updates: UpdateSkillInput,
  ): Promise<WorkspaceSkill | null>
  /** Structural-synthesis Phase 2: link (or clear) the v2 blueprint this skill
   * fills. Side-effect-free (no verify stamp / write_origin flip) — it records a
   * structural pairing, not a substance edit. */
  setBlueprint(userId: string, workspaceId: string, skillId: string, blueprintId: string | null): Promise<void>
  /** Bi-temporal close. Sets `valid_to = now()` rather than DELETE. */
  delete(userId: string, workspaceId: string, skillId: string): Promise<boolean>

  // ── Lookup ───────────────────────────────────────────────────────
  /** Slug-scoped lookup within a workspace — runtime `useSkill` resolver. */
  getBySlug(workspaceId: string, slug: string): Promise<SkillContent | null>
  /** Full row by UUID. System-level — used by curator + loader pointer expansion. */
  getByIdSystem(skillId: string): Promise<WorkspaceSkill | null>

  // ── Community catalog ────────────────────────────────────────────
  listPublished(): Promise<SkillMeta[]>
  publish(userId: string, workspaceId: string, skillId: string): Promise<boolean>
  unpublish(userId: string, workspaceId: string, skillId: string): Promise<boolean>

  // ── Legacy per-assistant enablement (built-in skills, slug-keyed) ─
  // assistant_skill_settings is still TEXT skill_id, so it lives here for
  // built-in skill toggles. Workspace skills use workspace_skill_enablement.
  listForAssistant(assistantId: string): Promise<Array<{ skillId: string; enabled: boolean }>>
  setEnabled(assistantId: string, skillId: string, enabled: boolean): Promise<void>

  // ── User-level UX stars ──────────────────────────────────────────
  listStarred(userId: string): Promise<string[]>
  star(userId: string, skillId: string): Promise<void>
  unstar(userId: string, skillId: string): Promise<void>

  // ── V2 — provenance flip (Approach W) ────────────────────────────
  /** User edited an auto-generated skill → flip `write_origin = 'foreground'`. */
  markUserVerified(userId: string, workspaceId: string, skillId: string): Promise<void>

  // ── V2 — pin / unpin (S13) ───────────────────────────────────────
  setPinned(userId: string, workspaceId: string, skillId: string, pinned: boolean): Promise<void>

  // ── V2 — lifecycle (S12) ─────────────────────────────────────────
  /** System-level lifecycle flip used by the daily curator sweep. */
  setState(skillId: string, state: 'active' | 'stale' | 'archived'): Promise<void>
  /** Bumps invocations + last_invoked_at; synchronously reactivates stale → active. */
  recordInvocation(skillId: string): Promise<void>

  // ── V2 — curator lease (S10) ─────────────────────────────────────
  acquireReviewLease(skillId: string, leaseHolder: string, leaseMinutes: number): Promise<boolean>
  releaseReviewLease(skillId: string, leaseHolder: string): Promise<void>
  /** Curator candidate set: background_review-origin, non-pinned, in (active|stale). */
  listCuratorEligible(workspaceId: string): Promise<WorkspaceSkill[]>

  // ── V2 — absorption (S15) ────────────────────────────────────────
  /** Follow `absorbed_into` transitively. Cap at `maxHops` (default 10). */
  resolveAbsorption(
    skillId: string,
    maxHops?: number,
  ): Promise<{ resolvedId: string; hops: number; chainTooLong: boolean }>

  // ── V2 — CL-8 counters ───────────────────────────────────────────
  incrementSucceeded(skillId: string): Promise<void>
  incrementUserCorrectedAfter(skillId: string): Promise<void>

  // ── Procedural-brain governance (mig 260) ────────────────────────
  /** Apply edge-derived sensitivity inheritance. No-op when `sensitivity_overridden`. System-level. */
  setInheritedSensitivity(skillId: string, sensitivity: 'public' | 'internal' | 'confidential'): Promise<void>
  /**
   * Human confirmation (plan §5.2): stamp verifier, lift confidence to the
   * activation threshold, activate, and flip provenance to `foreground` (verified
   * skills are immune to auto-curation). Workspace-scoped, RLS-gated.
   */
  confirmSkill(userId: string, workspaceId: string, skillId: string): Promise<void>
  /**
   * Record one independent re-derivation (plan §5.2): bump `rederivation_count` +
   * `confidence`; activate when the threshold is reached EXCEPT for
   * `ingested`-source skills (those activate only via `confirmSkill`). System-level.
   */
  recordRederivation(skillId: string): Promise<void>
}

/**
 * Legacy userId-keyed surface. Deprecated — every method here forwards to
 * the workspace-aware `WorkspaceSkillStore` after resolving the user's
 * primary workspace.
 */
export type SkillStore = {
  listOwned(userId: string): Promise<SkillContent[]>
  /**
   * Workspace-scoped skill listing for runtime injection: every non-
   * superseded skill in `workspaceId` (any author), as `SkillContent`.
   * `actingUserId` is the RLS principal (must be a member of the
   * workspace). Unlike `listOwned` — which resolves the caller's *primary*
   * (personal) workspace and filters `author_id` — this pins the
   * assistant's actual workspace, so a shared-workspace assistant surfaces
   * the workspace's own skills, not the owner's personal ones. Replaces the
   * `listOwned(owner)` injection path that leaked owner-personal skills to
   * members (incident 2026-06-01). Per-assistant enablement still gates
   * which are offered.
   */
  listForWorkspaceContent(workspaceId: string, actingUserId: string): Promise<SkillContent[]>
  create(userId: string, input: CreateSkillInput): Promise<SkillContent>
  update(userId: string, skillId: string, updates: UpdateSkillInput): Promise<SkillContent | null>
  delete(userId: string, skillId: string): Promise<boolean>
  listPublished(): Promise<SkillMeta[]>
  publish(userId: string, skillId: string): Promise<boolean>
  unpublish(userId: string, skillId: string): Promise<boolean>
  /** Slug lookup unscoped — falls through to the first published/most-recent match. */
  getBySlug(slug: string): Promise<SkillContent | null>
  listForAssistant(assistantId: string): Promise<Array<{ skillId: string; enabled: boolean }>>
  setEnabled(assistantId: string, skillId: string, enabled: boolean): Promise<void>
  listStarred(userId: string): Promise<string[]>
  star(userId: string, skillId: string): Promise<void>
  unstar(userId: string, skillId: string): Promise<void>
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Resolve a user's primary workspace for the legacy userId-only callers.
 * Prefers the personal workspace; falls back to the oldest membership.
 * Throws when the user has no workspace at all — that's an unrecoverable
 * shape under the V2 RLS model.
 */
async function resolvePrimaryWorkspace(userId: string): Promise<string> {
  const result = await queryWithRLS<{ workspace_id: string }>(
    userId,
    `SELECT wm.workspace_id
     FROM workspace_members wm
     JOIN workspaces w ON w.id = wm.workspace_id
     WHERE wm.user_id = $1
     ORDER BY (w.is_personal) DESC, wm.joined_at ASC
     LIMIT 1`,
    [userId],
  )
  if (result.rows.length === 0) {
    throw new Error(`User ${userId} has no workspace; cannot resolve skill scope`)
  }
  return result.rows[0].workspace_id
}

// ── Factory — V2 canonical ─────────────────────────────────────────

/**
 * Optional post-write hooks. `onWritten` fires fire-and-forget after a
 * successful `create` / `update` — it never blocks, never awaits, and is
 * isolated from the write (a throwing hook can never fail the skill save).
 * The skill-edge recomputer (`skill-edge-service.ts`) is its sole production
 * implementation: every skill body change re-derives `references_entity` /
 * `requires_connector` edges and refreshes inherited sensitivity
 * (`docs/architecture/engine/skill-system.md` §5.1, §6).
 */
export type WorkspaceSkillStoreHooks = {
  onWritten?: (skill: WorkspaceSkill) => void
}

export function createDbWorkspaceSkillStore(hooks?: WorkspaceSkillStoreHooks): WorkspaceSkillStore {
  // Fire-and-forget the post-write hook. A synchronous throw or a rejected
  // promise from the hook is swallowed here — the skill row is the source of
  // truth and an edge-derivation failure must never break a skill write.
  const fireOnWritten = (skill: WorkspaceSkill): void => {
    if (!hooks?.onWritten) return
    try {
      const r = hooks.onWritten(skill) as unknown
      if (r && typeof (r as Promise<unknown>).then === 'function') {
        ;(r as Promise<unknown>).catch((err) =>
          console.error(`[skill-store] onWritten hook rejected (skill=${skill.rowId}):`, err),
        )
      }
    } catch (err) {
      console.error(`[skill-store] onWritten hook threw (skill=${skill.rowId}):`, err)
    }
  }

  return {
    // ── Workspace-scoped CRUD ────────────────────────────────────────

    async listForWorkspace(workspaceId, opts) {
      if (opts?.actingUserId) {
        const result = await queryWithRLS<WorkspaceSkillRow>(
          opts.actingUserId,
          `SELECT ${COLS_ALL} FROM workspace_skills
           WHERE workspace_id = $1 AND valid_to IS NULL
           ORDER BY created_at DESC`,
          [workspaceId],
        )
        return result.rows.map(rowToWorkspaceSkill)
      }
      const result = await query<WorkspaceSkillRow>(
        `SELECT ${COLS_ALL} FROM workspace_skills
         WHERE workspace_id = $1 AND valid_to IS NULL
         ORDER BY created_at DESC`,
        [workspaceId],
      )
      return result.rows.map(rowToWorkspaceSkill)
    },

    async create(userId, workspaceId, input) {
      const source = input.source ?? 'user'
      const writeOrigin =
        input.writeOrigin ?? (source === 'auto-generated' ? 'background_review' : 'foreground')
      const autoGeneratedAt = source === 'auto-generated' ? new Date() : null
      const isAuto = source === 'auto-generated'
      // Procedural-brain governance (graded confidence — see
      // `docs/architecture/engine/skill-system.md` §"Governance — graded confidence").
      // Birth is keyed off the PROVENANCE tier, not `source`: `authored` is born
      // certified (confidence 1.0, active, verified — a human wrote it); `self` is
      // admitted through the approval gate born ACTIVE at MEDIUM confidence but NOT
      // yet certified; `ingested` is born SUGGESTED (the poisoning hard-bar). Only a
      // later human confirmation (or edit) lifts confidence to 1.0.
      const inductionSource = input.inductionSource ?? (isAuto ? 'self' : 'authored')
      const confidence = bornConfidence(inductionSource)
      const activatedAt = bornActivated(inductionSource) ? new Date() : null
      // Authoring is itself the human certification → stamp the verifier at birth so
      // the "confidence 1.0 ⇔ verified" invariant holds. `self` / `ingested` are not
      // certified at birth (verifier stays NULL until Confirm / edit).
      const bornVer = bornVerified(inductionSource)
      const verifiedByUserId = bornVer ? userId : null

      const result = await queryWithRLS<WorkspaceSkillRow>(
        userId,
        `INSERT INTO workspace_skills (
           slug, name, description, when_to_use, content, category,
           requires_connectors, source, author_id, workspace_id,
           write_origin, originating_assistant_id, auto_generated_at,
           induction_source, confidence, activated_at,
           verified_by_user_id, verified_at,
           sensitivity, sensitivity_overridden
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
                 ${bornVer ? 'now()' : 'NULL'},$18,$19)
         RETURNING ${COLS_ALL}`,
        [
          input.slug,
          input.name,
          input.description,
          input.whenToUse ?? null,
          input.content,
          input.category ?? 'custom',
          input.requiresConnectors ?? [],
          source,
          userId,
          workspaceId,
          writeOrigin,
          input.originatingAssistantId ?? null,
          autoGeneratedAt,
          inductionSource,
          confidence,
          activatedAt,
          verifiedByUserId,
          // A caller-chosen clearance is a manual choice → guarded against
          // inheritance; otherwise the 'internal' default stays inheritable.
          input.sensitivity ?? 'internal',
          input.sensitivity !== undefined,
        ],
      )
      const skill = rowToWorkspaceSkill(result.rows[0])
      fireOnWritten(skill)
      notifyWorkspaceChange(skill.workspaceId, 'skill', 'create', skill.rowId)
      return skill
    },

    async update(userId, workspaceId, skillId, updates) {
      const sets: string[] = []
      const values: unknown[] = []
      let idx = 1

      if (updates.name !== undefined) {
        sets.push(`name = $${idx++}`)
        values.push(updates.name)
      }
      if (updates.description !== undefined) {
        sets.push(`description = $${idx++}`)
        values.push(updates.description)
      }
      if (updates.whenToUse !== undefined) {
        sets.push(`when_to_use = $${idx++}`)
        values.push(updates.whenToUse)
      }
      if (updates.content !== undefined) {
        sets.push(`content = $${idx++}`)
        values.push(updates.content)
      }
      if (updates.category !== undefined) {
        sets.push(`category = $${idx++}`)
        values.push(updates.category)
      }
      if (updates.requiresConnectors !== undefined) {
        sets.push(`requires_connectors = $${idx++}`)
        values.push(updates.requiresConnectors)
      }
      if (updates.sensitivity !== undefined) {
        // Manual clearance choice — guard it against future inheritance.
        sets.push(`sensitivity = $${idx++}`)
        values.push(updates.sensitivity)
        sets.push(`sensitivity_overridden = true`)
      }

      if (sets.length === 0) return null

      sets.push(`updated_at = now()`)
      // V2: any user edit flips write_origin → 'foreground' (Approach W).
      sets.push(`write_origin = 'foreground'`)
      // Edit = confirm (brain-skill-management plan D2): a human rewriting the
      // procedure's substance (name/body) is a stronger endorsement than the
      // Confirm click, so it carries the same trust stamp — verifier recorded,
      // confidence lifted to the activation threshold, a Suggested skill
      // activated. Metadata-only edits (category/connectors/sensitivity) don't
      // qualify. Both callers are human paths: the PATCH route and the
      // approval-apply of a staged update (the approver reviewed the diff).
      if (updates.content !== undefined || updates.name !== undefined) {
        sets.push(`verified_by_user_id = $${idx++}`)
        values.push(userId)
        sets.push(`verified_at = now()`)
        sets.push(`confidence = GREATEST(confidence, $${idx++})`)
        values.push(SKILL_ACTIVATION_THRESHOLD)
        sets.push(`activated_at = COALESCE(activated_at, now())`)
      }
      values.push(skillId, workspaceId)

      const result = await queryWithRLS<WorkspaceSkillRow>(
        userId,
        `UPDATE workspace_skills SET ${sets.join(', ')}
         WHERE id = $${idx++} AND workspace_id = $${idx}
         RETURNING ${COLS_ALL}`,
        values,
      )
      if (!result.rows[0]) return null
      const skill = rowToWorkspaceSkill(result.rows[0])
      fireOnWritten(skill)
      notifyWorkspaceChange(skill.workspaceId, 'skill', 'update', skill.rowId)
      return skill
    },

    async setBlueprint(userId, workspaceId, skillId, blueprintId) {
      const result = await queryWithRLS(
        userId,
        `UPDATE workspace_skills SET blueprint_id = $1, updated_at = now()
          WHERE id = $2 AND workspace_id = $3`,
        [blueprintId, skillId, workspaceId],
      )
      if ((result.rowCount ?? 0) > 0) notifyWorkspaceChange(workspaceId, 'skill', 'update', skillId)
    },

    async delete(userId, workspaceId, skillId) {
      const result = await queryWithRLS(
        userId,
        `UPDATE workspace_skills
         SET valid_to = now(), state = 'archived', state_transitioned_at = now()
         WHERE id = $1 AND workspace_id = $2 AND valid_to IS NULL`,
        [skillId, workspaceId],
      )
      if ((result.rowCount ?? 0) > 0) notifyWorkspaceChange(workspaceId, 'skill', 'delete', skillId)
      return (result.rowCount ?? 0) > 0
    },

    // ── Lookup ───────────────────────────────────────────────────────

    async getBySlug(workspaceId, slug) {
      const result = await query<WorkspaceSkillRow>(
        `SELECT ${COLS_ALL} FROM workspace_skills
         WHERE workspace_id = $1 AND slug = $2 AND valid_to IS NULL
         LIMIT 1`,
        [workspaceId, slug],
      )
      return result.rows[0] ? rowToSkillContent(result.rows[0]) : null
    },

    async getByIdSystem(skillId) {
      const result = await query<WorkspaceSkillRow>(
        `SELECT ${COLS_ALL} FROM workspace_skills WHERE id = $1 LIMIT 1`,
        [skillId],
      )
      return result.rows[0] ? rowToWorkspaceSkill(result.rows[0]) : null
    },

    // ── Community catalog ────────────────────────────────────────────

    async listPublished() {
      const result = await query<WorkspaceSkillRow>(
        `SELECT ${COLS_ALL} FROM workspace_skills
         WHERE published = true AND valid_to IS NULL
         ORDER BY name ASC`,
      )
      return result.rows.map(rowToSkillMeta)
    },

    async publish(userId, workspaceId, skillId) {
      const result = await queryWithRLS(
        userId,
        `UPDATE workspace_skills
         SET published = true, source = 'community', updated_at = now()
         WHERE id = $1 AND workspace_id = $2`,
        [skillId, workspaceId],
      )
      if ((result.rowCount ?? 0) > 0) notifyWorkspaceChange(workspaceId, 'skill', 'update', skillId)
      return (result.rowCount ?? 0) > 0
    },

    async unpublish(userId, workspaceId, skillId) {
      const result = await queryWithRLS(
        userId,
        `UPDATE workspace_skills
         SET published = false, source = 'user', updated_at = now()
         WHERE id = $1 AND workspace_id = $2`,
        [skillId, workspaceId],
      )
      if ((result.rowCount ?? 0) > 0) notifyWorkspaceChange(workspaceId, 'skill', 'update', skillId)
      return (result.rowCount ?? 0) > 0
    },

    // ── Legacy per-assistant enablement (built-in skills, slug-keyed) ─

    async listForAssistant(assistantId) {
      const result = await query<{ skillId: string; enabled: boolean }>(
        `SELECT skill_id AS "skillId", enabled
         FROM assistant_skill_settings
         WHERE assistant_id = $1`,
        [assistantId],
      )
      return result.rows
    },

    async setEnabled(assistantId, skillId, enabled) {
      await query(
        `INSERT INTO assistant_skill_settings (assistant_id, skill_id, enabled)
         VALUES ($1, $2, $3)
         ON CONFLICT (assistant_id, skill_id) DO UPDATE
           SET enabled = $3`,
        [assistantId, skillId, enabled],
      )
    },

    // ── User-level UX stars ──────────────────────────────────────────

    async listStarred(userId) {
      const result = await queryWithRLS<{ skill_id: string }>(
        userId,
        `SELECT skill_id FROM user_skill_stars WHERE user_id = $1`,
        [userId],
      )
      return result.rows.map((r) => r.skill_id)
    },

    async star(userId, skillId) {
      await queryWithRLS(
        userId,
        `INSERT INTO user_skill_stars (user_id, skill_id)
         VALUES ($1, $2)
         ON CONFLICT (user_id, skill_id) DO NOTHING`,
        [userId, skillId],
      )
    },

    async unstar(userId, skillId) {
      await queryWithRLS(
        userId,
        `DELETE FROM user_skill_stars WHERE user_id = $1 AND skill_id = $2`,
        [userId, skillId],
      )
    },

    // ── V2 — provenance flip (Approach W) ────────────────────────────

    async markUserVerified(userId, workspaceId, skillId) {
      await queryWithRLS(
        userId,
        `UPDATE workspace_skills
         SET write_origin = 'foreground', updated_at = now()
         WHERE id = $1 AND workspace_id = $2`,
        [skillId, workspaceId],
      )
      notifyWorkspaceChange(workspaceId, 'skill', 'update', skillId)
    },

    // ── V2 — pin / unpin (S13) ───────────────────────────────────────

    async setPinned(userId, workspaceId, skillId, pinned) {
      // Pinning an archived skill auto-restores it (S13 invariant 3).
      await queryWithRLS(
        userId,
        `UPDATE workspace_skills
         SET pinned = $1,
             pinned_at = CASE WHEN $1 THEN now() ELSE NULL END,
             state = CASE WHEN $1 AND state = 'archived' THEN 'active' ELSE state END,
             state_transitioned_at = CASE
               WHEN $1 AND state = 'archived' THEN now()
               ELSE state_transitioned_at
             END,
             updated_at = now()
         WHERE id = $2 AND workspace_id = $3`,
        [pinned, skillId, workspaceId],
      )
      notifyWorkspaceChange(workspaceId, 'skill', 'update', skillId)
    },

    // ── V2 — lifecycle (S12) ─────────────────────────────────────────

    async setState(skillId, state) {
      const result = await query<{ workspaceId: string }>(
        `UPDATE workspace_skills
         SET state = $1, state_transitioned_at = now(), updated_at = now()
         WHERE id = $2
         RETURNING workspace_id AS "workspaceId"`,
        [state, skillId],
      )
      if (result.rows[0]) notifyWorkspaceChange(result.rows[0].workspaceId, 'skill', 'update', skillId)
    },

    async recordInvocation(skillId) {
      // Stale → active synchronously. Archived is NOT
      // auto-reactivated (S12 invariant 1).
      await query(
        `UPDATE workspace_skills
         SET invocations = invocations + 1,
             last_invoked_at = now(),
             state = CASE
               WHEN state = 'stale' THEN 'active'
               ELSE state
             END,
             state_transitioned_at = CASE
               WHEN state = 'stale' THEN now()
               ELSE state_transitioned_at
             END
         WHERE id = $1`,
        [skillId],
      )
    },

    // ── V2 — curator lease (S10) ─────────────────────────────────────

    async acquireReviewLease(skillId, leaseHolder, leaseMinutes) {
      // CAS — only set the lease when no live holder remains. Re-acquisition
      // by the same caller extends the lease (the curator can renew its own
      // lease).
      const result = await query<{ id: string }>(
        `UPDATE workspace_skills
         SET review_lease_held_by = $1,
             review_lease_until   = now() + ($2::int * interval '1 minute')
         WHERE id = $3
           AND (
             review_lease_held_by IS NULL
             OR review_lease_until <= now()
             OR review_lease_held_by = $1
           )
         RETURNING id`,
        [leaseHolder, leaseMinutes, skillId],
      )
      return (result.rowCount ?? 0) > 0
    },

    async releaseReviewLease(skillId, leaseHolder) {
      await query(
        `UPDATE workspace_skills
         SET review_lease_held_by = NULL,
             review_lease_until   = NULL
         WHERE id = $1 AND review_lease_held_by = $2`,
        [skillId, leaseHolder],
      )
    },

    async listCuratorEligible(workspaceId) {
      const result = await query<WorkspaceSkillRow>(
        `SELECT ${COLS_ALL} FROM workspace_skills
         WHERE workspace_id = $1
           AND write_origin = 'background_review'
           AND pinned = false
           AND state IN ('active', 'stale')
           AND valid_to IS NULL
         ORDER BY last_invoked_at NULLS FIRST, created_at ASC`,
        [workspaceId],
      )
      return result.rows.map(rowToWorkspaceSkill)
    },

    // ── V2 — absorption (S15) ────────────────────────────────────────

    async resolveAbsorption(skillId, maxHops = 10) {
      let current = skillId
      for (let hops = 0; hops < maxHops; hops++) {
        const result = await query<{ absorbed_into: string | null; state: string }>(
          `SELECT absorbed_into, state FROM workspace_skills WHERE id = $1 LIMIT 1`,
          [current],
        )
        if (result.rows.length === 0) {
          return { resolvedId: current, hops, chainTooLong: false }
        }
        const row = result.rows[0]
        if (row.state !== 'archived' || row.absorbed_into === null) {
          return { resolvedId: current, hops, chainTooLong: false }
        }
        current = row.absorbed_into
      }
      return { resolvedId: current, hops: maxHops, chainTooLong: true }
    },

    // ── V2 — CL-8 counters ───────────────────────────────────────────

    async incrementSucceeded(skillId) {
      // A corrected-free success nudges confidence up slightly, capped below the
      // certified threshold (evidence approaches but never reaches full trust) and
      // only for un-verified skills (a certified 1.0 skill must not be dragged down
      // to the cap). See `docs/architecture/engine/skill-system.md` §"Graded confidence".
      await query(
        `UPDATE workspace_skills
         SET succeeded = succeeded + 1,
             confidence = CASE
               WHEN verified_at IS NULL THEN LEAST(confidence + $2, $3)
               ELSE confidence
             END
         WHERE id = $1`,
        [skillId, SKILL_USAGE_CONFIDENCE_INCREMENT, SKILL_USAGE_CONFIDENCE_CAP],
      )
    },

    async incrementUserCorrectedAfter(skillId) {
      await query(
        `UPDATE workspace_skills SET user_corrected_after = user_corrected_after + 1 WHERE id = $1`,
        [skillId],
      )
    },

    // ── Procedural-brain governance (mig 260) ────────────────────────

    async setInheritedSensitivity(skillId, sensitivity) {
      await query(
        `UPDATE workspace_skills SET sensitivity = $1, updated_at = now()
         WHERE id = $2 AND sensitivity_overridden = false`,
        [sensitivity, skillId],
      )
    },

    async confirmSkill(userId, workspaceId, skillId) {
      await queryWithRLS(
        userId,
        `UPDATE workspace_skills
         SET verified_by_user_id = $1,
             verified_at = now(),
             confidence = GREATEST(confidence, $2),
             activated_at = COALESCE(activated_at, now()),
             write_origin = 'foreground',
             updated_at = now()
         WHERE id = $3 AND workspace_id = $4`,
        [userId, SKILL_ACTIVATION_THRESHOLD, skillId, workspaceId],
      )
    },

    async recordRederivation(skillId) {
      // An independent re-derivation is mild corroborating evidence: bump the count
      // and nudge confidence up SLIGHTLY, capped below the certified threshold and
      // only for un-verified skills. Re-derivation NO LONGER activates or certifies —
      // only human confirmation reaches 1.0 / flips a suggested skill to active.
      await query(
        `UPDATE workspace_skills
         SET rederivation_count = rederivation_count + 1,
             confidence = CASE
               WHEN verified_at IS NULL THEN LEAST(confidence + $2, $3)
               ELSE confidence
             END,
             updated_at = now()
         WHERE id = $1`,
        [skillId, SKILL_USAGE_CONFIDENCE_INCREMENT, SKILL_USAGE_CONFIDENCE_CAP],
      )
    },
  }
}

// ── Factory — legacy back-compat shim ──────────────────────────────

/**
 * Legacy factory kept for back-compat with the existing routes + injection
 * sites that call `listOwned(userId)` etc. Internally resolves the user's
 * primary workspace and forwards to the canonical store. Deprecated.
 */
export function createDbSkillStore(): SkillStore {
  const ws = createDbWorkspaceSkillStore()

  return {
    async listOwned(userId) {
      const workspaceId = await resolvePrimaryWorkspace(userId)
      const result = await queryWithRLS<WorkspaceSkillRow>(
        userId,
        `SELECT ${COLS_ALL} FROM workspace_skills
         WHERE workspace_id = $1 AND author_id = $2 AND valid_to IS NULL
         ORDER BY created_at DESC`,
        [workspaceId, userId],
      )
      return result.rows.map(rowToSkillContent)
    },

    async listForWorkspaceContent(workspaceId, actingUserId) {
      // Pins the GIVEN workspace (the assistant's), NOT the caller's primary
      // workspace, and does NOT filter author_id — every member's skills in
      // this workspace are eligible (per-assistant enablement gates the rest).
      const result = await queryWithRLS<WorkspaceSkillRow>(
        actingUserId,
        // state filter: archived skills (incl. curator-absorbed members) stay
        // out of the chat listing even though their row is still bi-temporally
        // current (valid_to IS NULL until delete()). Matches the spec resolver
        // ('state IN (active, stale)').
        `SELECT ${COLS_ALL} FROM workspace_skills
         WHERE workspace_id = $1 AND valid_to IS NULL
           AND state IN ('active', 'stale')
         ORDER BY created_at DESC`,
        [workspaceId],
      )
      return result.rows.map(rowToSkillContent)
    },

    async create(userId, input) {
      const workspaceId = await resolvePrimaryWorkspace(userId)
      const skill = await ws.create(userId, workspaceId, input)
      return rowToSkillContentFromWorkspaceSkill(skill)
    },

    async update(userId, skillId, updates) {
      const workspaceId = await resolvePrimaryWorkspace(userId)
      const skill = await ws.update(userId, workspaceId, skillId, updates)
      return skill ? rowToSkillContentFromWorkspaceSkill(skill) : null
    },

    async delete(userId, skillId) {
      const workspaceId = await resolvePrimaryWorkspace(userId)
      return ws.delete(userId, workspaceId, skillId)
    },

    listPublished() {
      return ws.listPublished()
    },

    async publish(userId, skillId) {
      const workspaceId = await resolvePrimaryWorkspace(userId)
      return ws.publish(userId, workspaceId, skillId)
    },

    async unpublish(userId, skillId) {
      const workspaceId = await resolvePrimaryWorkspace(userId)
      return ws.unpublish(userId, workspaceId, skillId)
    },

    async getBySlug(slug) {
      // Slug is now workspace-scoped; legacy callsite scans every workspace
      // for the slug. The (workspace_id, slug) UNIQUE means at most one
      // match per workspace; we surface published rows first.
      const result = await query<WorkspaceSkillRow>(
        `SELECT ${COLS_ALL} FROM workspace_skills
         WHERE slug = $1 AND valid_to IS NULL
         ORDER BY published DESC, created_at DESC
         LIMIT 1`,
        [slug],
      )
      return result.rows[0] ? rowToSkillContent(result.rows[0]) : null
    },

    listForAssistant(assistantId) {
      return ws.listForAssistant(assistantId)
    },

    setEnabled(assistantId, skillId, enabled) {
      return ws.setEnabled(assistantId, skillId, enabled)
    },

    listStarred(userId) {
      return ws.listStarred(userId)
    },

    star(userId, skillId) {
      return ws.star(userId, skillId)
    },

    unstar(userId, skillId) {
      return ws.unstar(userId, skillId)
    },
  }
}

function rowToSkillContentFromWorkspaceSkill(skill: WorkspaceSkill): SkillContent {
  return {
    id: skill.slug,
    name: skill.name,
    description: skill.description,
    whenToUse: skill.whenToUse,
    content: skill.content,
    category: skill.category as SkillContent['category'],
    requiresConnectors: skill.requiresConnectors,
    // The legacy `SkillContent.source` predates 'auto-generated'. The legacy
    // back-compat shim sees auto-gen rows as user-authored at the wire format —
    // callers that need provenance must read the workspace surface.
    source: (skill.source === 'auto-generated' ? 'user' : skill.source) as SkillContent['source'],
    authorId: skill.authorId,
    blueprintId: skill.blueprintId,
  }
}
