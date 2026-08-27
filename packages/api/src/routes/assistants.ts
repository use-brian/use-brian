/**
 * Assistant CRUD routes for the assistant detail page.
 *
 * Mounted at `/api/assistants` behind requireAuth.
 * All queries use queryWithRLS so a user can only access assistants
 * they are a member of.
 *
 * [COMP:api/assistants-route]
 *
 *   GET    /:assistantId          — single assistant detail
 *   PATCH  /:assistantId          — update settings: charter.instructions (any
 *                                   member), clearance (owner / workspace admin),
 *                                   everything else (name, charter.mission /
 *                                   .audience / .success, model aliases)
 *                                   owner-only. Legacy `systemPrompt` / `bio`
 *                                   keys fold into the charter (migration 418).
 *   DELETE /:assistantId          — delete assistant (owner only, solo-owned)
 */

import { Router } from 'express'
import { queryWithRLS, query, getPool } from '../db/client.js'
import { resolveAssistantAccess } from '../db/users.js'
import type { AssistantConnectorStore } from '../db/assistant-connector-store.js'
import type { ConnectorStore } from '../db/connector-store.js'
import {
  connectorInstanceGovernanceId,
  parseConnectorInstanceGovernanceId,
  type ConnectorInstance,
  type ConnectorInstanceStore,
} from '../db/connector-instance-store.js'
import { buildConnectorAuthHeaders } from '../mcp/auth-headers.js'
import { workspacePolicyAsSettingsStore } from '../db/workspace-tool-policy-store.js'
import type { ConnectorGrantStore } from '../db/connector-grant-store.js'
import type { McpSettingsStore, JobStore, CapabilityStore } from '@use-brian/core'
import {
  APP_LEVEL_ASSISTANT_ID,
  ALL_EXACT_INSTANCE_GOVERNANCE_CONNECTOR_IDS,
  BUILTIN_PRIMITIVE_CONNECTOR_IDS,
  MULTI_INSTANCE_CONNECTOR_IDS,
  OFFICIAL_CONNECTOR_TOOLS,
  OFFICIAL_CONNECTORS,
  type ConnectorEntry,
} from '@use-brian/shared'
import { classifyTool, defaultPolicy, loadBuiltinSkills } from '@use-brian/core'
import type { SkillContent } from '@use-brian/core'
import {
  CHARTER_FIELDS,
  CHARTER_FIELD_LIMITS,
  resolveCharter,
  type AssistantCharter,
  type CharterField,
} from '@use-brian/shared'
import {
  decidePlaybookRule,
  listPlaybookRulesForViewer,
  MAX_ACTIVE_PLAYBOOK_RULES,
  MAX_ACTIVE_DECISION_PLAYBOOK_RULES,
  type PlaybookDecision,
} from '../db/playbook-store.js'
import type { SkillStore, WorkspaceSkillStore } from '../db/skill-store.js'
import type { WorkspaceSkillEnablementStore } from '../db/workspace-skill-enablement-store.js'

type AssistantParams = { assistantId: string }

type AssistantRouteOptions = {
  assistantConnectorStore?: AssistantConnectorStore
  connectorStore?: ConnectorStore
  connectorInstanceStore?: ConnectorInstanceStore
  connectorGrantStore?: ConnectorGrantStore
  mcpSettingsStore?: McpSettingsStore
  workspaceToolPolicyStore?: import('../db/workspace-tool-policy-store.js').WorkspaceToolPolicyStore
  workspaceStore?: Pick<import('../db/workspace-store.js').WorkspaceStore, 'getRole'>
  registry?: ConnectorEntry[]
  jobStore?: JobStore
  skillStore?: SkillStore
  communitySkills?: SkillContent[]
  /**
   * Workspace-skill enablement allowlist. Powers the Workspace tab on the
   * assistant detail page — the assistant-centric dual of the skill editor's
   * Access tab. Absent in minimal open-build mounts / unit tests, in which
   * case the Workspace group is reported empty rather than guessed at.
   */
  workspaceSkillEnablementStore?: WorkspaceSkillEnablementStore
  /**
   * Resolves a workspace skill row UUID to its owning workspace, for the
   * cross-workspace guard on the workspace-skill toggle routes.
   */
  workspaceSkillStore?: Pick<WorkspaceSkillStore, 'getByIdSystem' | 'listForWorkspace'>
  capabilityStore: CapabilityStore
  analytics?: import('@use-brian/core').AnalyticsLogger
  /**
   * Per-assistant connector grants store. Reserved for future inline
   * surfaces on this router (e.g. show "grant required" warnings on
   * the connectors list). Today the mutations live on the dedicated
   * `/api/assistant-connector-grants` mount.
   */
  assistantConnectorGrantsStore?: import('../db/assistant-connector-grants-store.js').AssistantConnectorGrantsStore
}

export function assistantRoutes(options: AssistantRouteOptions): Router {
  const router = Router()

  /**
   * Verify the authenticated user can access this assistant.
   * Returns { userId, role } or sends 401/403 and returns null.
   *
   * Delegates to `resolveAssistantAccess` — the single access predicate (see its
   * docstring). `role` here is the caller's **effective** role, the higher of
   * their direct (`assistant_members`) and workspace (`workspace_members`) roles.
   *
   * That determinism is the point, because every write below branches on this
   * value. The previous spelling was a local `UNION … LIMIT 1` with no
   * `ORDER BY`: when a user's two membership rows disagreed, the role returned
   * was whichever the planner happened to emit first. A workspace admin carrying
   * a legacy `assistant_members.role='member'` row could be denied a rename they
   * were entitled to, and — the direction that matters — a workspace `member`
   * carrying a legacy `role='owner'` row could non-deterministically clear the
   * owner-only gate on `bio` and the model aliases.
   */
  async function verifyMembership(
    req: { userId?: string; params: AssistantParams },
    res: import('express').Response,
  ): Promise<{ userId: string; role: string; workspaceId: string | null } | null> {
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return null
    }

    const access = await resolveAssistantAccess(userId, req.params.assistantId)
    if (!access) {
      res.status(403).json({ error: 'Not a member of this assistant' })
      return null
    }
    return { userId, role: access.role, workspaceId: access.assistant.workspaceId ?? null }
  }

  // ── GET /:assistantId — single assistant detail ────────────────

  router.get<AssistantParams>('/:assistantId', async (req, res) => {
    const member = await verifyMembership(req, res)
    if (!member) return
    const { assistantId } = req.params

    try {
      const result = await queryWithRLS<{
        id: string
        name: string
        system_prompt: string | null
        bio: string | null
        charter: unknown
        created_at: string
        default_model_alias: string
        api_model_alias: string
        icon_seed: number | null
        workspace_id: string | null
        clearance: string
        kind: string
        app_type: string | null
      }>(
        member.userId,
        `SELECT id, name, system_prompt, bio, charter, created_at,
                default_model_alias, api_model_alias, icon_seed, workspace_id, clearance, kind, app_type
         FROM assistants WHERE id = $1`,
        [assistantId],
      )
      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Assistant not found' })
        return
      }
      const row = result.rows[0]
      // Charter is the identity item (migration 418). The legacy keys are
      // mirrored FROM it so pre-charter clients (Telegram Mini App manage
      // page, scripts) keep displaying current data.
      const charter = resolveCharter({
        charter: row.charter,
        systemPrompt: row.system_prompt,
        bio: row.bio,
      })
      res.json({
        id: row.id,
        name: row.name,
        role: member.role,
        charter,
        systemPrompt: charter.instructions ?? null,
        createdAt: row.created_at,
        defaultModelAlias: row.default_model_alias,
        apiModelAlias: row.api_model_alias,
        iconSeed: row.icon_seed ?? 0,
        workspaceId: row.workspace_id,
        bio: charter.mission ?? null,
        clearance: row.clearance,
        kind: row.kind,
        appType: row.app_type,
      })
    } catch (err) {
      console.error('[assistants] get failed:', err)
      res.status(500).json({ error: 'Failed to get assistant' })
    }
  })

  // ── PATCH /:assistantId — update name / system_prompt ──────────

  router.patch<AssistantParams>('/:assistantId', async (req, res) => {
    const member = await verifyMembership(req, res)
    if (!member) return

    const { assistantId } = req.params
    const body = req.body as {
      name?: string
      /** @deprecated migration 418 — folds into `charter.instructions`. */
      systemPrompt?: string | null
      /** @deprecated migration 418 — folds into `charter.mission`. */
      bio?: string | null
      /** Partial charter patch: key present = write, `null` = clear,
       *  absent = keep. See docs/plans/assistant-growth-loop.md §2. */
      charter?: Record<string, unknown> | null
      defaultModelAlias?: string
      apiModelAlias?: string
      /** @deprecated migration 416 — folded into `defaultModelAlias`. */
      slackModelAlias?: string
      /** @deprecated migration 416 — folded into `defaultModelAlias`. */
      telegramModelAlias?: string
      /** @deprecated migration 416 — folded into `defaultModelAlias`. */
      whatsappModelAlias?: string
      clearance?: string
    }
    const { name, apiModelAlias, clearance } = body

    // ── Charter patch assembly ─────────────────────────────────────
    // The charter is the one identity item (migration 418). Pre-charter
    // clients still send `systemPrompt` / `bio`; those fold onto
    // `instructions` / `mission` so an old Mini App manage page keeps
    // editing the same truth the new UI does.
    if (
      body.charter !== undefined &&
      body.charter !== null &&
      (typeof body.charter !== 'object' || Array.isArray(body.charter))
    ) {
      res.status(400).json({ error: 'charter must be an object' })
      return
    }
    const charterPatch: Partial<Record<CharterField, string | null>> = {}
    if (body.charter && typeof body.charter === 'object') {
      for (const field of CHARTER_FIELDS) {
        if (!(field in body.charter)) continue
        const raw = (body.charter as Record<string, unknown>)[field]
        if (raw !== null && typeof raw !== 'string') {
          res.status(400).json({ error: `charter.${field} must be a string or null` })
          return
        }
        charterPatch[field] = raw as string | null
      }
    }
    if (body.systemPrompt !== undefined && charterPatch.instructions === undefined) {
      charterPatch.instructions = body.systemPrompt
    }
    if (body.bio !== undefined && charterPatch.mission === undefined) {
      charterPatch.mission = body.bio
    }
    const charterFieldsPresent = Object.keys(charterPatch) as CharterField[]

    // Legacy per-platform keys (pre-416 clients: the Telegram Mini App manage
    // page, third-party scripts) fold onto the one default tier. First key
    // present wins; they were never meaningfully independent, since Slack's
    // was inert and Telegram's already drove the official bot.
    const defaultModelAlias =
      body.defaultModelAlias ??
      body.telegramModelAlias ??
      body.slackModelAlias ??
      body.whatsappModelAlias

    // Authorization model (verifyMembership already confirmed the caller can
    // access this assistant):
    //   - `charter.instructions`: any member who can access the assistant.
    //     The instructions are a shared, collaboratively-editable persona —
    //     released from owner-only so teammates can tune the assistant they
    //     work with (the pre-418 `system_prompt` right, preserved). See
    //     docs/architecture/features/assistant-detail-page.md →
    //     "Charter — per-field editing rights".
    //   - `charter.mission` / `.audience` / `.success`: owner only. These
    //     define what the assistant IS (they feed peer routing, the public
    //     chat-link header, and the reflection rubric), inheriting the old
    //     `bio` gate.
    //   - `name` (rename): the assistant owner, or an `admin` (a workspace
    //     admin manages the shared assistant roster, so renaming is a team
    //     right, not an owner-only one). 'owner'/'admin' are the privileged
    //     values in both role vocabularies (assistant_members and
    //     workspace_members), so `member.role` — resolved by verifyMembership
    //     from whichever table applies — is authoritative here.
    //   - `clearance`: the assistant owner, or a team admin/owner of the
    //     assistant's workspace (policy is a team-wide concern — see
    //     docs/architecture/platform/sensitivity.md).
    //   - everything else (model aliases): owner only.
    // A non-owner request that bundles an owner-only field is rejected whole
    // (the strictest field in the request governs).
    const identityFieldPresent =
      charterPatch.mission !== undefined ||
      charterPatch.audience !== undefined ||
      charterPatch.success !== undefined
    const ownerOnlyFieldPresent =
      identityFieldPresent ||
      defaultModelAlias !== undefined || apiModelAlias !== undefined

    if (member.role !== 'owner') {
      if (ownerOnlyFieldPresent) {
        res.status(403).json({ error: 'Only the owner can update assistant settings' })
        return
      }
      // Rename is owner-or-admin. Inside this branch member.role is 'admin' or
      // 'member', so admins pass and members are rejected.
      if (name !== undefined && member.role !== 'admin') {
        res.status(403).json({ error: 'Only the owner or a workspace admin can rename this assistant' })
        return
      }
      // The request now touches only charter.instructions, name (admin,
      // allowed above) and/or clearance. A clearance change still requires
      // team admin/owner; instructions are open to any member who reached
      // this far.
      if (clearance !== undefined) {
        const teamRole = await queryWithRLS<{ role: string }>(
          member.userId,
          `SELECT tm.role FROM assistants a
           JOIN workspace_members tm ON tm.workspace_id = a.workspace_id
           WHERE a.id = $1 AND tm.user_id = $2 AND tm.role IN ('admin', 'owner')`,
          [assistantId, member.userId],
        )
        if (teamRole.rows.length === 0) {
          res.status(403).json({ error: 'Only the assistant owner or a team admin can change clearance' })
          return
        }
      }
    }

    const VALID_MODEL_ALIASES = new Set(['standard', 'pro', 'max'])

    // Validate
    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length === 0) {
        res.status(400).json({ error: 'Name must be a non-empty string' })
        return
      }
      if (name.length > 100) {
        res.status(400).json({ error: 'Name must be 100 characters or less' })
        return
      }
    }
    for (const field of charterFieldsPresent) {
      const value = charterPatch[field]
      if (typeof value === 'string' && value.length > CHARTER_FIELD_LIMITS[field]) {
        res.status(400).json({
          error: `charter.${field} must be ${CHARTER_FIELD_LIMITS[field].toLocaleString('en-US')} characters or less`,
        })
        return
      }
    }
    if (defaultModelAlias !== undefined && !VALID_MODEL_ALIASES.has(defaultModelAlias)) {
      res.status(400).json({ error: 'defaultModelAlias must be standard, pro, or max' })
      return
    }
    if (apiModelAlias !== undefined && !VALID_MODEL_ALIASES.has(apiModelAlias)) {
      res.status(400).json({ error: 'apiModelAlias must be standard, pro, or max' })
      return
    }

    // Build dynamic SET clause
    const sets: string[] = []
    const values: unknown[] = []
    let idx = 1

    if (name !== undefined) {
      sets.push(`name = $${idx++}`)
      values.push(name.trim())
    }
    if (charterFieldsPresent.length > 0) {
      // Merge the patch onto the CURRENT effective charter (which resolves
      // legacy `system_prompt` / `bio` for pre-backfill rows), then write the
      // whole object. From the first PATCH on, `charter` is authoritative -
      // clearing a field can never resurrect stale legacy column text.
      const current = await queryWithRLS<{
        charter: unknown
        system_prompt: string | null
        bio: string | null
      }>(
        member.userId,
        `SELECT charter, system_prompt, bio FROM assistants WHERE id = $1`,
        [assistantId],
      )
      if (current.rows.length === 0) {
        res.status(404).json({ error: 'Assistant not found' })
        return
      }
      const merged: AssistantCharter = resolveCharter({
        charter: current.rows[0].charter,
        systemPrompt: current.rows[0].system_prompt,
        bio: current.rows[0].bio,
      })
      for (const field of charterFieldsPresent) {
        const value = charterPatch[field]
        const trimmed = typeof value === 'string' ? value.trim() : null
        if (trimmed) merged[field] = trimmed
        else delete merged[field]
      }
      sets.push(`charter = $${idx++}::jsonb`)
      values.push(JSON.stringify(merged))
    }
    if (defaultModelAlias !== undefined) {
      sets.push(`default_model_alias = $${idx++}`)
      values.push(defaultModelAlias)
    }
    if (apiModelAlias !== undefined) {
      sets.push(`api_model_alias = $${idx++}`)
      values.push(apiModelAlias)
    }
    if (clearance !== undefined && ['public', 'internal', 'confidential'].includes(clearance)) {
      sets.push(`clearance = $${idx++}`)
      values.push(clearance)
    }

    if (sets.length === 0) {
      res.status(400).json({ error: 'No fields to update' })
      return
    }

    sets.push(`updated_at = now()`)
    values.push(assistantId)

    try {
      const result = await queryWithRLS<{
        id: string; name: string; system_prompt: string | null
        bio: string | null; charter: unknown
        default_model_alias: string; api_model_alias: string
        clearance: string
      }>(
        member.userId,
        `UPDATE assistants SET ${sets.join(', ')} WHERE id = $${idx}
         RETURNING id, name, system_prompt, bio, charter, default_model_alias, api_model_alias, clearance`,
        values,
      )
      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Assistant not found' })
        return
      }
      const row = result.rows[0]

      // Migration 224: a doc thread's read-clearance = its owning
      // assistant's clearance, denormalized onto the assistant's
      // workspace-shared sessions + their comment_threads. When the
      // assistant's clearance changes, recompute those rows so the RLS gate
      // stays correct (the policies never read `assistants`). System-side
      // (bare query): these rows are owned by various thread creators, so an
      // RLS-scoped update wouldn't reach them.
      if (clearance !== undefined) {
        await query(
          `UPDATE sessions SET effective_clearance = $1
            WHERE assistant_id = $2 AND visibility = 'workspace'`,
          [row.clearance, assistantId],
        )
        await query(
          `UPDATE comment_threads ct SET effective_clearance = $1
             FROM sessions s
            WHERE s.id = ct.session_id AND s.assistant_id = $2`,
          [row.clearance, assistantId],
        )
      }

      const updatedCharter = resolveCharter({
        charter: row.charter,
        systemPrompt: row.system_prompt,
        bio: row.bio,
      })
      res.json({
        id: row.id,
        name: row.name,
        charter: updatedCharter,
        systemPrompt: updatedCharter.instructions ?? null,
        bio: updatedCharter.mission ?? null,
        defaultModelAlias: row.default_model_alias,
        apiModelAlias: row.api_model_alias,
        clearance: row.clearance,
      })
    } catch (err) {
      console.error('[assistants] update failed:', err)
      res.status(500).json({ error: 'Failed to update assistant' })
    }
  })

  // ── Playbook (growth loop Phase 3) ─────────────────────────────
  // The reflection worker proposes rules as 'suggested'; the owner admits,
  // rejects, or retires them here. Viewing is any-member (the playbook is
  // standing behavior every member works with); deciding is owner-only,
  // matching the charter identity fields. Spec:
  // docs/architecture/context-engine/assistant-playbook.md.

  router.get<AssistantParams>('/:assistantId/playbook', async (req, res) => {
    const member = await verifyMembership(req, res)
    if (!member) return
    try {
      const rules = await listPlaybookRulesForViewer({
        assistantId: req.params.assistantId,
        userId: member.userId,
        isAssistantOwner: member.role === 'owner',
      })
      res.json({
        rules,
        maxActive: MAX_ACTIVE_PLAYBOOK_RULES,
        maxActiveDecision: MAX_ACTIVE_DECISION_PLAYBOOK_RULES,
      })
    } catch (err) {
      console.error('[assistants] playbook list failed:', err)
      res.status(500).json({ error: 'Failed to list playbook rules' })
    }
  })

  router.post<AssistantParams & { ruleId: string }>(
    '/:assistantId/playbook/:ruleId/decision',
    async (req, res) => {
      const member = await verifyMembership(req, res)
      if (!member) return
      const { decision } = req.body as { decision?: string }
      if (decision !== 'approve' && decision !== 'reject' && decision !== 'retire') {
        res.status(400).json({ error: "decision must be 'approve', 'reject', or 'retire'" })
        return
      }
      try {
        const result = await decidePlaybookRule({
          assistantId: req.params.assistantId,
          ruleId: req.params.ruleId,
          decision: decision as PlaybookDecision,
          userId: member.userId,
          workspaceId: member.workspaceId,
          isAssistantOwner: member.role === 'owner',
        })
        if (result === 'forbidden') {
          res.status(403).json({ error: 'You can decide only your own learned rules' })
          return
        }
        if (result === 'cap') {
          res.status(409).json({
            error: 'active_rule_cap',
            message: 'The active rule limit has been reached. Retire one first.',
          })
          return
        }
        if (!result) {
          res.status(404).json({ error: 'Rule not found or not in a decidable state' })
          return
        }
        options.analytics?.logEvent({
          userId: member.userId,
          actorUserId: member.userId,
          assistantId: req.params.assistantId,
          eventName: decision === 'retire'
            ? 'decision_rule_retired'
            : 'decision_playbook_rule_decided',
          channelType: 'web',
          metadata: {
            user_scoped: result.appliesToUserId !== null,
            approved: decision === 'approve',
            rejected: decision === 'reject',
            retired: decision === 'retire',
          },
        })
        console.info(
          `[assistants] playbook decision applied assistant=${req.params.assistantId} scope=${result.appliesToUserId ? 'user' : 'assistant'} status=${result.status}`,
        )
        res.json({ rule: result })
      } catch (err) {
        console.error('[assistants] playbook decision failed:', err)
        res.status(500).json({ error: 'Failed to apply playbook decision' })
      }
    },
  )

  // ── DELETE /:assistantId — delete assistant ────────────────────

  router.delete<AssistantParams>('/:assistantId', async (req, res) => {
    const member = await verifyMembership(req, res)
    if (!member) return
    if (member.role !== 'owner') {
      res.status(403).json({ error: 'Only the owner can delete an assistant' })
      return
    }

    const { assistantId } = req.params

    try {
      // Guard: primary assistants anchor their workspace and cannot be
      // deleted independently. Deleting the workspace cascades to its
      // assistants (FK ON DELETE CASCADE) — that's the only way out.
      // See docs/architecture/platform/workspaces.md → "Primary assistant".
      const kindRow = await queryWithRLS<{ kind: string }>(
        member.userId,
        `SELECT kind FROM assistants WHERE id = $1`,
        [assistantId],
      )
      if (kindRow.rows[0]?.kind === 'primary') {
        res.status(409).json({
          error: 'primary_not_deletable',
          message:
            'The primary assistant cannot be deleted. Delete the workspace instead.',
        })
        return
      }

      // Guard: refuse if other members exist (team assistant)
      const members = await queryWithRLS<{ user_id: string }>(
        member.userId,
        `SELECT user_id FROM assistant_members
         WHERE assistant_id = $1 AND user_id <> $2`,
        [assistantId, member.userId],
      )
      if (members.rows.length > 0) {
        res.status(409).json({
          error: 'transfer_ownership_required',
          message: 'This assistant has other members. Remove them or transfer ownership before deleting.',
          memberCount: members.rows.length,
        })
        return
      }

      // Transactional delete. `SET LOCAL` (after BEGIN) scopes the RLS acting
      // user to this transaction, so Postgres reverts it on COMMIT/ROLLBACK.
      // A session-scoped `SET` — and, worse, the `SET app.current_user_id = ''`
      // this finally used to run — leaks onto the pooled connection, and every
      // later bare `query()` on an RLS-policied table then evaluates
      // `current_setting('app.current_user_id', true)::uuid` against `''`,
      // throwing `invalid input syntax for type uuid: ""` (22P02) platform-wide
      // until that physical connection recycles. See packages/api/CLAUDE.md →
      // "Bypass restore + pool contamination".
      const client = await getPool().connect()
      try {
        await client.query('BEGIN')
        await client.query(`SET LOCAL app.current_user_id = '${member.userId.replace(/'/g, "''")}'`)
        await client.query('DELETE FROM assistants WHERE id = $1', [assistantId])
        await client.query('COMMIT')
        res.status(204).end()
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    } catch (err) {
      console.error('[assistants] delete failed:', err)
      res.status(500).json({ error: 'Failed to delete assistant' })
    }
  })

  // ── Primitive capability grants (§17 — Tasks/CRM toggles) ─────────────
  //
  // Two endpoints. Per-assistant grants for the primitive groups exposed
  // by the company-brain plan §17, plus the `configure` control-plane
  // capability (agent-facing capability surface §5). Names match
  // `requiresCapability` on the matching tools so flipping a toggle
  // directly hides the tool from the model on the next turn.
  //
  //   GET   /:assistantId/primitive-grants
  //   PATCH /:assistantId/primitive-grants/:capability  { enabled: boolean }
  //
  // Auth: any workspace member (read+write) for the §17 primitives —
  // capability gates are not user-private secrets; the audit log captures
  // who flipped what. The `configure` capability is the exception: it arms
  // control-plane writes on the agent surfaces (brain MCP / assistant MCP),
  // so toggling it requires workspace owner/admin
  // (docs/architecture/integrations/agent-capability-surface.md §5 — off by default,
  // never self-grantable; this route is the ONLY user-facing grant path).
  // See docs/plans/company-brain.md §17 and
  // docs/architecture/features/tasks.md / crm.md "Primitive access control".

  const PRIMITIVE_CAPABILITIES = ['tasks', 'crm', 'goals'] as const
  // Admin-gated named capabilities toggleable on this surface. `configure`
  // unlocks Tier-2 control-plane write tools for agents acting as this
  // assistant (CONFIGURE_CAPABILITY in @use-brian/core).
  const ADMIN_CAPABILITIES = ['configure'] as const
  // Built-in workspace primitives (Workspace Files / Office / Computer Use).
  // Same capability mechanism as the §17 primitives, but surfaced on the
  // assistant's Tools tab beside the other connector rows rather than in the
  // Settings capabilities panel — that is where their "Always on" pill used
  // to sit, and where a user goes looking for a connector's off switch.
  // DERIVED from the registry (`auth_type: 'none'`), never a hardcoded slug
  // list — see the "all built-ins" drift anti-pattern in CLAUDE.md. The
  // capability name IS the connector id, which is why one set serves both.
  const BUILTIN_CAPABILITIES = [...BUILTIN_PRIMITIVE_CONNECTOR_IDS]
  const TOGGLEABLE_CAPABILITIES: string[] = [
    ...PRIMITIVE_CAPABILITIES,
    ...ADMIN_CAPABILITIES,
    ...BUILTIN_CAPABILITIES,
  ]

  // Which surface owns each row. Two clients read this one route and each
  // renders only its own group — without the discriminator the Settings
  // capabilities panel would render a second, duplicate control for every
  // built-in primitive alongside the Tools tab's. A client must NOT re-derive
  // the split from a local slug list (that is how `goals` ended up rendering
  // under the `configure` label).
  type CapabilityGroup = 'primitive' | 'admin' | 'builtin'
  const groupOf = (cap: string): CapabilityGroup =>
    BUILTIN_PRIMITIVE_CONNECTOR_IDS.has(cap)
      ? 'builtin'
      : (ADMIN_CAPABILITIES as readonly string[]).includes(cap)
        ? 'admin'
        : 'primitive'

  router.get<AssistantParams>('/:assistantId/primitive-grants', async (req, res) => {
    const member = await verifyMembership(req, res)
    if (!member) return
    const { assistantId } = req.params
    try {
      const active = new Set(await options.capabilityStore.listActive(assistantId))
      res.json({
        grants: TOGGLEABLE_CAPABILITIES.map((cap) => ({
          capability: cap,
          enabled: active.has(cap),
          group: groupOf(cap),
        })),
      })
    } catch (err) {
      console.error('[assistants] primitive-grants list failed:', err)
      res.status(500).json({ error: 'Failed to list primitive grants' })
    }
  })

  router.patch('/:assistantId/primitive-grants/:capability', async (req, res) => {
    const member = await verifyMembership(req as any, res)
    if (!member) return
    const { assistantId, capability } = req.params as { assistantId: string; capability: string }
    if (!TOGGLEABLE_CAPABILITIES.includes(capability)) {
      res.status(400).json({ error: `capability must be one of: ${TOGGLEABLE_CAPABILITIES.join(', ')}` })
      return
    }
    // `configure` arms agent-driven control-plane writes — owner/admin only.
    // (verifyMembership's role comes from assistant_members for personal
    // assistants and workspace_members for team-owned ones; 'owner'/'admin'
    // are the privileged values in both vocabularies.)
    if (
      ADMIN_CAPABILITIES.includes(capability as (typeof ADMIN_CAPABILITIES)[number]) &&
      member.role !== 'owner' &&
      member.role !== 'admin'
    ) {
      res.status(403).json({ error: 'Only a workspace owner or admin can change the configure capability' })
      return
    }
    const { enabled } = req.body as { enabled?: boolean }
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be boolean' })
      return
    }

    try {
      if (enabled) {
        // Idempotent grant. The store throws DuplicateGrantError if an
        // active grant already exists; for a toggle UX that's a no-op.
        try {
          await options.capabilityStore.grant({
            assistantId,
            capability,
            grantedByUserId: member.userId,
            reason:
              capability === 'configure'
                ? 'agent-surface configure capability toggled on by workspace admin'
                : groupOf(capability) === 'builtin'
                  ? `built-in primitive "${capability}" switched on by workspace member`
                  : '§17 toggled on by workspace member',
          })
        } catch (err) {
          if (err instanceof Error && err.name === 'DuplicateGrantError') {
            // Already on — no-op.
          } else {
            throw err
          }
        }
      } else {
        // Find the active grant id, then revoke it. listAllActive is admin
        // surface; we just look up by table.
        const activeRow = await query<{ id: string }>(
          `SELECT id FROM assistant_capabilities
           WHERE assistant_id = $1 AND capability = $2 AND revoked_at IS NULL
           LIMIT 1`,
          [assistantId, capability],
        )
        if (activeRow.rows[0]) {
          await options.capabilityStore.revoke({
            grantId: activeRow.rows[0].id,
            revokedByUserId: member.userId,
            reason:
              capability === 'configure'
                ? 'agent-surface configure capability toggled off by workspace admin'
                : groupOf(capability) === 'builtin'
                  ? `built-in primitive "${capability}" switched off by workspace member`
                  : '§17 toggled off by workspace member',
          })
        }
      }
      const active = new Set(await options.capabilityStore.listActive(assistantId))
      res.json({ capability, enabled: active.has(capability), group: groupOf(capability) })
    } catch (err) {
      console.error('[assistants] primitive-grants patch failed:', err)
      res.status(500).json({ error: 'Failed to update primitive grant' })
    }
  })

  // ── POST /:assistantId/regenerate-icon — new random pixel creature ──────

  router.post('/:assistantId/regenerate-icon', async (req, res) => {
    const member = await verifyMembership(req as any, res)
    if (!member) return

    try {
      const { assistantId } = req.params as { assistantId: string }
      const newSeed = Math.floor(Math.random() * 1000000)
      await query(
        `UPDATE assistants SET icon_seed = $1 WHERE id = $2`,
        [newSeed, assistantId],
      )
      res.json({ iconSeed: newSeed })
    } catch (err) {
      console.error('[assistants] regenerate-icon failed:', err)
      res.status(500).json({ error: 'Failed to regenerate icon' })
    }
  })

  // ── GET /:assistantId/connectors — list connectors with Layer 2 status ──

  router.get<AssistantParams>('/:assistantId/connectors', async (req, res) => {
    const member = await verifyMembership(req, res)
    if (!member) return

    if (!options.connectorStore || !options.assistantConnectorStore) {
      res.json({ connectors: [] })
      return
    }

    try {
      const { assistantId } = req.params
      const assistantSettings = await options.assistantConnectorStore.listForAssistant(assistantId)
      const settingsMap = new Map(assistantSettings.map((s) => [s.connectorId, s.enabled]))
      // Derive the always-show set from the official registry so a new
       // built-in connector (e.g. fathom) appears as a toggle even before the
       // user has connected it. Hard-coding this list silently dropped
       // newly-added built-ins. See OFFICIAL_CONNECTORS in
       // packages/shared/src/connector-registry.ts.
      const BUILTIN_IDS = new Set(
        OFFICIAL_CONNECTORS.filter((c) => c.enabled).map((c) => c.id),
      )
      const registry = options.registry ?? []

      // Resolve the assistant's owning team. Personal assistants return null
      // here and the team-overlay loop is a no-op.
      const teamRow = await queryWithRLS<{ workspace_id: string | null }>(
        member.userId,
        `SELECT workspace_id FROM assistants WHERE id = $1`,
        [assistantId],
      )
      const assistantTeamId = teamRow.rows[0]?.workspace_id ?? null

      // Workspace connector-scoping gate — MUST mirror injectMcpTools
      // (packages/api/src/mcp/inject.ts, incidents 2026-06-01 / 2026-06-02 /
      // 2026-07-14). The personal layer below pulls the viewer's `scope='user'`
      // connectors. The engine never injects owner-personal connectors for a
      // workspace assistant — exposure (`connector_grant`) is the injection
      // boundary in every workspace, solo included. Surfacing them here as
      // assistant toggles otherwise advertises dead toggles AND re-draws the
      // owner-impersonation surface that gate closed. Only workspace-less
      // personal assistants load them.
      const loadPersonal = !assistantTeamId
      const userConnectors = loadPersonal
        ? await options.connectorStore.list(member.userId)
        : []

      // Build the unified list, applying the same precedence the engine
      // uses at tool-injection time (see packages/api/src/mcp/inject.ts):
      //   team-native > member-grant > personal
      // The oldest instance keeps the provider key for backward compatibility;
      // every additional instance gets a stable `<provider>:<instanceId>` key.
      // Registry-declared exact-governance connectors keep exact keys for every
      // instance because their accounts or discovered catalogs are independent.
      type Entry = {
        id: string
        providerId?: string
        name: string
        /** Non-secret identity for the connected account, when known. */
        connectedEmail?: string
        url?: string
        custom: boolean
        connected: boolean
        enabled: boolean
        icon_url?: string
        category?: 'official' | 'community'
        scope: 'personal' | 'team-native' | 'team-grant' | 'builtin'
        grantedByUserId?: string
        /** Internal ordering key for account-bound cards; stripped from JSON. */
        sortCreatedAt?: Date
        /** Internal provider grouping key; stripped from JSON. */
        sortProvider?: string
        /**
         * The backing connector_instance id. Multi-account cards use it for
         * exact governance; team-native cards also use it for the
         * clearance-gated workspace tool-policy routes.
         */
        instanceId?: string
      }
      const byKey = new Map<string, Entry>()

      if (assistantTeamId && options.connectorInstanceStore) {
        const teamNative = (await options.connectorInstanceStore.listByWorkspaceSystem(assistantTeamId))
          .sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0)
            || String(a.id).localeCompare(String(b.id)))
        const instanceIndexByProvider = new Map<string, number>()
        for (const inst of teamNative) {
          const entry = registry.find((e) => e.id === inst.provider)
          // WhatsApp channel infrastructure owns connector_instance rows for
          // credentials and attribution, but it exposes no assistant tools.
          if (inst.provider === 'whatsapp') continue
          if (inst.custom || ALL_EXACT_INSTANCE_GOVERNANCE_CONNECTOR_IDS.has(inst.provider)) {
            // Exact-governance account routers expose only usable accounts in
            // Assistant Tools; disconnected/auth-failed rows stay manageable
            // on the workspace connector surface.
            if (!inst.connected || (inst.provider !== 'cli' && inst.healthStatus === 'auth_failed')) continue
            const governanceId = connectorInstanceGovernanceId(inst.provider, inst.id)
            byKey.set(governanceId, {
              id: governanceId,
              providerId: inst.provider,
              name: inst.connectedEmail ?? inst.label,
              connectedEmail: inst.connectedEmail ?? undefined,
              custom: inst.custom,
              connected: inst.connected,
              enabled: settingsMap.get(governanceId) ?? settingsMap.get(inst.provider) ?? true,
              icon_url: entry?.icon_url,
              category: entry?.category,
              scope: 'team-native',
              instanceId: inst.id,
              sortCreatedAt: inst.createdAt,
              sortProvider: inst.provider,
            })
            continue
          }
          const providerIndex = instanceIndexByProvider.get(inst.provider) ?? 0
          instanceIndexByProvider.set(inst.provider, providerIndex + 1)
          const governanceId = ALL_EXACT_INSTANCE_GOVERNANCE_CONNECTOR_IDS.has(inst.provider)
            || (MULTI_INSTANCE_CONNECTOR_IDS.has(inst.provider) && providerIndex > 0)
            ? connectorInstanceGovernanceId(inst.provider, inst.id)
            : inst.provider
          byKey.set(governanceId, {
            id: governanceId,
            ...(MULTI_INSTANCE_CONNECTOR_IDS.has(inst.provider) ? { providerId: inst.provider } : {}),
            name: inst.label,
            connectedEmail: inst.connectedEmail ?? undefined,
            url: inst.url ?? undefined,
            custom: inst.custom,
            connected: inst.connected,
            enabled: settingsMap.get(governanceId) ?? settingsMap.get(inst.provider) ?? true,
            icon_url: entry?.icon_url,
            category: entry?.category,
            scope: 'team-native',
            instanceId: inst.id,
            sortCreatedAt: inst.createdAt,
            sortProvider: inst.provider,
          })
        }
      }

      if (assistantTeamId && options.connectorGrantStore) {
        const grants = await options.connectorGrantStore.listForTargetSystem('workspace', assistantTeamId)
        const teamNativeProviders = new Set(
          [...byKey.values()]
            .filter((connector) => connector.scope === 'team-native')
            .map((connector) => connector.providerId ?? connector.id),
        )
        // Preserve the existing one-grantor-per-provider precedence, but keep
        // every instance exposed by that winning grantor instead of collapsing
        // the provider to its first row. CLI is the exception: runtime loads
        // every explicitly granted server because each has its own catalog.
        const winningGrantorByProvider = new Map<string, string>()
        const instanceIndexByProvider = new Map<string, number>()
        const orderedGrants = [...grants].sort((a, b) =>
          (a.instance.createdAt?.getTime() ?? 0) - (b.instance.createdAt?.getTime() ?? 0)
            || String(a.instance.id).localeCompare(String(b.instance.id)),
        )
        for (const g of orderedGrants) {
          if (g.instance.provider !== 'cli' && teamNativeProviders.has(g.instance.provider)) continue
          const entry = registry.find((e) => e.id === g.instance.provider)
          if (g.instance.provider === 'whatsapp') continue
          if (g.instance.provider !== 'cli') {
            const winningGrantor = winningGrantorByProvider.get(g.instance.provider)
            if (winningGrantor && winningGrantor !== g.grantedByUserId) continue
            if (!winningGrantor) winningGrantorByProvider.set(g.instance.provider, g.grantedByUserId)
          }
          if (g.instance.custom || ALL_EXACT_INSTANCE_GOVERNANCE_CONNECTOR_IDS.has(g.instance.provider)) {
            if (!g.instance.connected) continue
            if (g.instance.provider !== 'cli' && g.instance.healthStatus === 'auth_failed') continue
            const governanceId = connectorInstanceGovernanceId(g.instance.provider, g.instance.id)
            byKey.set(governanceId, {
              id: governanceId,
              providerId: g.instance.provider,
              name: g.instance.connectedEmail ?? g.instance.label,
              connectedEmail: g.instance.connectedEmail ?? undefined,
              custom: g.instance.custom,
              connected: g.instance.connected,
              enabled: settingsMap.get(governanceId) ?? settingsMap.get(g.instance.provider) ?? true,
              icon_url: entry?.icon_url,
              category: entry?.category,
              scope: 'team-grant',
              grantedByUserId: g.grantedByUserId,
              instanceId: g.instance.id,
              sortCreatedAt: g.instance.createdAt,
              sortProvider: g.instance.provider,
            })
            continue
          }
          const providerIndex = instanceIndexByProvider.get(g.instance.provider) ?? 0
          instanceIndexByProvider.set(g.instance.provider, providerIndex + 1)
          const governanceId = ALL_EXACT_INSTANCE_GOVERNANCE_CONNECTOR_IDS.has(g.instance.provider)
            || (MULTI_INSTANCE_CONNECTOR_IDS.has(g.instance.provider) && providerIndex > 0)
            ? connectorInstanceGovernanceId(g.instance.provider, g.instance.id)
            : g.instance.provider
          byKey.set(governanceId, {
            id: governanceId,
            ...(MULTI_INSTANCE_CONNECTOR_IDS.has(g.instance.provider) ? { providerId: g.instance.provider } : {}),
            name: g.instance.label,
            connectedEmail: g.instance.connectedEmail ?? undefined,
            url: g.instance.url ?? undefined,
            custom: g.instance.custom,
            connected: g.instance.connected,
            enabled: settingsMap.get(governanceId) ?? settingsMap.get(g.instance.provider) ?? true,
            icon_url: entry?.icon_url,
            category: entry?.category,
            scope: 'team-grant',
            grantedByUserId: g.grantedByUserId,
            instanceId: g.instance.id,
            sortCreatedAt: g.instance.createdAt,
            sortProvider: g.instance.provider,
          })
        }
      }

      // Layer in personal connectors — but skip any provider already
      // claimed by team-native or grant, since the engine would shadow
      // them anyway.
      const instanceIndexByProvider = new Map<string, number>()
      const orderedUserConnectors = [...userConnectors].sort((a, b) =>
        (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0)
          || String(a.id).localeCompare(String(b.id)),
      )
      for (const c of orderedUserConnectors) {
        const providerIndex = instanceIndexByProvider.get(c.connectorId) ?? 0
        instanceIndexByProvider.set(c.connectorId, providerIndex + 1)
        const governanceId = ALL_EXACT_INSTANCE_GOVERNANCE_CONNECTOR_IDS.has(c.connectorId)
          ? connectorInstanceGovernanceId(c.connectorId, c.id)
          : MULTI_INSTANCE_CONNECTOR_IDS.has(c.connectorId) && providerIndex > 0
            ? connectorInstanceGovernanceId(c.connectorId, c.id)
            : c.connectorId
        const existing = byKey.get(governanceId)
        if (existing) continue
        if (!BUILTIN_IDS.has(c.connectorId) && !c.connected) continue
        const entry = registry.find((e) => e.id === c.connectorId)
        byKey.set(governanceId, {
          id: governanceId,
          ...(MULTI_INSTANCE_CONNECTOR_IDS.has(c.connectorId)
            ? { providerId: c.connectorId, instanceId: c.id }
            : {}),
          name: c.connectedEmail ?? c.name,
          connectedEmail: c.connectedEmail ?? undefined,
          url: c.url ?? undefined,
          custom: c.custom,
          connected: c.connected,
          enabled: settingsMap.get(governanceId) ?? settingsMap.get(c.connectorId) ?? true,
          icon_url: entry?.icon_url,
          category: entry?.category ?? (c.custom ? undefined : 'community' as const),
          scope: 'personal',
          sortCreatedAt: c.createdAt,
          sortProvider: c.connectorId,
        })
      }

      // Built-in workspace primitives (Workspace Files / Office / Computer
      // Use) have NO row in any of the three sources above — they are
      // boot-injected capability
      // primitives, not connector instances — so without this pass they can
      // never appear here and their per-assistant (L2) tool policy is
      // unreachable, contradicting the Studio Connectors page's
      // "Configure per-assistant tool permissions in the Assistant
      // Connectors tab" pointer. Synthesize an entry per registry built-in
      // (derived — never hardcode the id list; see
      // BUILTIN_PRIMITIVE_CONNECTOR_IDS). The /tools + /tools/policy
      // sub-routes below already handle OFFICIAL_CONNECTOR_TOOLS ids.
      //
      // `enabled` is the CAPABILITY grant, not `assistant_connector_settings`.
      // A built-in has no connector instance, so nothing at runtime ever reads
      // its connector-settings row — sourcing the toggle from there would give
      // the user a switch that flips in the UI and changes nothing. The grant
      // is what `filterToolsByCapabilities` actually reads on every path.
      const builtinCapabilities = new Set(await options.capabilityStore.listActive(assistantId))
      for (const id of BUILTIN_PRIMITIVE_CONNECTOR_IDS) {
        if (byKey.has(id)) continue
        if ((OFFICIAL_CONNECTOR_TOOLS[id]?.length ?? 0) === 0) continue // no governable tools
        const official = OFFICIAL_CONNECTORS.find((e) => e.id === id)
        if (!official?.enabled) continue
        const entry = registry.find((e) => e.id === id)
        byKey.set(id, {
          id,
          name: official.name,
          custom: false,
          connected: true, // no external account, no instance row to connect
          enabled: builtinCapabilities.has(id),
          icon_url: entry?.icon_url,
          category: 'official',
          scope: 'builtin',
        })
      }

      const connectors = Array.from(byKey.values())
        // AgentMail is an email Channel, not an assistant-level connection.
        // Its handler and mailbox actions are configured on the inbox in
        // Studio → Channels; rendering it here would create a second authority.
        .filter((connector) => (connector.providerId ?? connector.id) !== 'agentmail')
        .sort((a, b) => {
          if (a.sortProvider !== b.sortProvider) return 0
          return (a.sortCreatedAt?.getTime() ?? 0) - (b.sortCreatedAt?.getTime() ?? 0)
            || a.id.localeCompare(b.id)
        })
        .map(({ sortCreatedAt: _sortCreatedAt, sortProvider: _sortProvider, ...connector }) => connector)
      res.json({ connectors })
    } catch (err) {
      console.error('[assistants] list connectors failed:', err)
      res.status(500).json({ error: 'Failed to list connectors' })
    }
  })

  // ── POST /:assistantId/connectors/:connectorId/enable ─────────

  router.post('/:assistantId/connectors/:connectorId/enable', async (req, res) => {
    const member = await verifyMembership(req as any, res)
    if (!member) return

    if (!options.assistantConnectorStore) {
      res.status(500).json({ error: 'Not configured' })
      return
    }

    try {
      const { assistantId, connectorId } = req.params as { assistantId: string; connectorId: string }
      await options.assistantConnectorStore.setEnabled(assistantId, connectorId, true)
      res.json({ ok: true })
    } catch (err) {
      console.error('[assistants] enable connector failed:', err)
      res.status(500).json({ error: 'Failed to enable connector' })
    }
  })

  // ── POST /:assistantId/connectors/:connectorId/disable ────────

  router.post('/:assistantId/connectors/:connectorId/disable', async (req, res) => {
    const member = await verifyMembership(req as any, res)
    if (!member) return

    if (!options.assistantConnectorStore) {
      res.status(500).json({ error: 'Not configured' })
      return
    }

    try {
      const { assistantId, connectorId } = req.params as { assistantId: string; connectorId: string }
      await options.assistantConnectorStore.setEnabled(assistantId, connectorId, false)
      res.json({ ok: true })
    } catch (err) {
      console.error('[assistants] disable connector failed:', err)
      res.status(500).json({ error: 'Failed to disable connector' })
    }
  })

  // ── GET /:assistantId/connectors/:connectorId/tools ─────────
  // Returns tools with the EFFECTIVE policy (strictest of L1 + L2).

  const STRICTNESS: Record<string, number> = { allow: 0, ask: 1, block: 2 }
  function strictest(a: string, b: string): 'allow' | 'ask' | 'block' {
    return (STRICTNESS[a] ?? 0) >= (STRICTNESS[b] ?? 0) ? a as 'allow' | 'ask' | 'block' : b as 'allow' | 'ask' | 'block'
  }

  router.get('/:assistantId/connectors/:connectorId/tools', async (req, res) => {
    const member = await verifyMembership(req as any, res)
    if (!member) return
    if (!options.mcpSettingsStore || !options.connectorStore) { res.json({ tools: [] }); return }

    const { assistantId, connectorId } = req.params as { assistantId: string; connectorId: string }
    const parsedGovernanceId = parseConnectorInstanceGovernanceId(connectorId)
    const providerId = parsedGovernanceId?.provider ?? connectorId
    const governanceId = parsedGovernanceId ? connectorId : providerId

    try {
      if (providerId === 'cli' && parsedGovernanceId && options.connectorInstanceStore) {
        const instanceId = parsedGovernanceId.instanceId
        let instance: ConnectorInstance | null = null
        let policyStore = options.mcpSettingsStore
        let policyUserId = member.userId
        let policyServerName: string | null = null
        if (member.workspaceId) {
          const [teamNative, grants] = await Promise.all([
            options.connectorInstanceStore.listByWorkspaceSystem(member.workspaceId),
            options.connectorGrantStore
              ? options.connectorGrantStore.listForTargetSystem('workspace', member.workspaceId)
              : Promise.resolve([]),
          ])
          const teamOwned = teamNative.find(
            (candidate) => candidate.id === instanceId && candidate.provider === 'cli',
          ) ?? null
          const grant = grants.find(
            (candidate) => candidate.instance.id === instanceId && candidate.instance.provider === 'cli',
          ) ?? null
          instance = teamOwned ?? grant?.instance ?? null
          if (teamOwned && options.workspaceToolPolicyStore) {
            policyStore = workspacePolicyAsSettingsStore(options.workspaceToolPolicyStore, member.workspaceId)
            policyServerName = connectorId
          } else if (grant) {
            policyUserId = grant.grantedByUserId
          }
        } else {
          instance = await options.connectorInstanceStore.get(member.userId, instanceId)
          if (instance?.provider !== 'cli' || instance.scope !== 'user' || instance.userId !== member.userId) {
            instance = null
          }
        }
        if (!instance || !instance.connected) {
          res.status(404).json({ error: 'CLI connector not found' })
          return
        }

        const credentials = await options.connectorInstanceStore.getAuthCredentialsSystem(instance.id)
        if (credentials?.type !== 'cli') {
          res.status(409).json({ error: 'CLI connector credentials are missing or invalid' })
          return
        }
        const { discoverCliServer } = await import('../mcp/cli-transport.js')
        const server = await discoverCliServer({
          binaryPath: credentials.binaryPath,
          args: credentials.args,
          env: instance.config?.env as Record<string, string> | undefined,
          cwd: typeof instance.config?.cwd === 'string' ? instance.config.cwd : undefined,
          timeoutMs: typeof instance.config?.timeoutMs === 'number' ? instance.config.timeoutMs : undefined,
        }, instance.label)
        policyServerName ??= server.name

        const tools = await Promise.all(server.tools.map(async (tool) => {
          const classification = classifyTool(tool.name, tool.description)
          const fallback = defaultPolicy(classification)
          const appOverride = await policyStore!.getPolicy({
            assistantId: APP_LEVEL_ASSISTANT_ID,
            userId: policyUserId,
            serverName: policyServerName,
            toolName: tool.name,
          })
          const assistantOverride = await policyStore!.getPolicy({
            assistantId,
            userId: policyUserId,
            serverName: policyServerName,
            toolName: tool.name,
          })
          const appPolicy = appOverride?.policy ?? fallback
          const assistantPolicy = assistantOverride?.policy ?? fallback
          return {
            name: tool.name,
            description: tool.description,
            classification,
            appPolicy,
            assistantPolicy,
            effectivePolicy: strictest(appPolicy, assistantPolicy),
          }
        }))
        res.json({ tools, serverName: server.name, providerId, instanceId })
        return
      }

      if (OFFICIAL_CONNECTOR_TOOLS[providerId]) {
        const tools = await Promise.all(
          OFFICIAL_CONNECTOR_TOOLS[providerId].map(async (t) => {
            // L1: app-level policy (sentinel assistant ID)
            let appPolicy: string = t.defaultPolicy
            const appOverride = await options.mcpSettingsStore!.getPolicy({
              assistantId: APP_LEVEL_ASSISTANT_ID, userId: member.userId,
              serverName: providerId, toolName: t.name,
            })
            if (appOverride) appPolicy = appOverride.policy

            // L2: assistant-level policy
            let assistantPolicy: string = t.defaultPolicy
            let override = await options.mcpSettingsStore!.getPolicy({
              assistantId, userId: member.userId,
              serverName: governanceId, toolName: t.name,
            })
            if (!override && governanceId !== providerId) {
              override = await options.mcpSettingsStore!.getPolicy({
                assistantId, userId: member.userId,
                serverName: providerId, toolName: t.name,
              })
            }
            if (override) assistantPolicy = override.policy

            return {
              name: t.name,
              description: t.description,
              classification: t.classification,
              appPolicy,
              assistantPolicy,
              effectivePolicy: strictest(appPolicy, assistantPolicy),
            }
          }),
        )
        res.json({ tools, serverName: governanceId, providerId })
        return
      }

      // Custom MCP connector — check personal first, then team-native
      // instances on this assistant's owning team. Team-native custom
      // MCPs use a UUID `provider` (set in connector-instances.ts) so
      // they can never collide with personal `connectorId`s here.
      const connectors = await options.connectorStore!.list(member.userId)
      const personal = member.workspaceId
        ? undefined
        : connectors.find((c) => parsedGovernanceId
          ? c.id === parsedGovernanceId.instanceId && c.connectorId === providerId
          : c.connectorId === providerId)
      let mcpUrl: string | null = personal?.url ?? null
      let mcpName: string = personal?.name ?? connectorId
      // Outbound auth headers (bearer / custom header) for an auth-required
      // custom connector — resolved per branch so the discovery initialize
      // isn't rejected (which would 500 this route and blank the L2 policy
      // editor). Mirrors GET /connectors/:id/tools + injectMcpTools.
      let authHeaders: Record<string, string> = {}
      let policyStore = options.mcpSettingsStore
      let policyUserId = member.userId
      let policyServerName: string | null = null
      if (personal?.url) {
        authHeaders = buildConnectorAuthHeaders(
          await options.connectorStore!.getAuthCredentials(member.userId, providerId),
        )
      }

      if (!mcpUrl && options.connectorInstanceStore) {
        const teamRow = await queryWithRLS<{ workspace_id: string | null }>(
          member.userId,
          `SELECT workspace_id FROM assistants WHERE id = $1`,
          [assistantId],
        )
        const assistantTeamId = member.workspaceId ?? teamRow.rows[0]?.workspace_id ?? null
        if (assistantTeamId) {
          const [teamInstances, grants] = await Promise.all([
            options.connectorInstanceStore.listByWorkspaceSystem(assistantTeamId),
            options.connectorGrantStore
              ? options.connectorGrantStore.listForTargetSystem('workspace', assistantTeamId)
              : Promise.resolve([]),
          ])
          const teamOwned = teamInstances.find((inst) => (
            inst.provider === providerId
            && (!parsedGovernanceId || inst.id === parsedGovernanceId.instanceId)
            && inst.custom
            && inst.connected
            && inst.url
          )) ?? null
          const grant = grants.find(({ instance: inst }) => (
            inst.provider === providerId
            && (!parsedGovernanceId || inst.id === parsedGovernanceId.instanceId)
            && inst.custom
            && inst.connected
            && inst.url
          )) ?? null
          const workspaceCustom = teamOwned ?? grant?.instance ?? null
          if (workspaceCustom?.url) {
            mcpUrl = workspaceCustom.url
            mcpName = workspaceCustom.label
            authHeaders = buildConnectorAuthHeaders(
              await options.connectorInstanceStore.getAuthCredentialsSystem(workspaceCustom.id),
            )
            if (teamOwned && options.workspaceToolPolicyStore) {
              policyStore = workspacePolicyAsSettingsStore(options.workspaceToolPolicyStore, assistantTeamId)
              policyServerName = providerId
            } else if (grant) {
              policyUserId = grant.grantedByUserId
            }
          }
        }
      }

      if (!mcpUrl) { res.json({ tools: [], serverName: providerId }); return }

      const { discoverMcpServer } = await import('../mcp/client.js')
      const server = await discoverMcpServer(mcpUrl, mcpName, authHeaders)
      policyServerName ??= server.name

      const tools = await Promise.all(
        server.tools.map(async (t) => {
          const classification = classifyTool(t.name, t.description)
          const defPolicy = defaultPolicy(classification)

          // L1: app-level (sentinel assistant ID)
          let appPolicy: string = defPolicy
          const appOverride = await policyStore!.getPolicy({
            assistantId: APP_LEVEL_ASSISTANT_ID, userId: policyUserId,
            serverName: policyServerName, toolName: t.name,
          })
          if (appOverride) appPolicy = appOverride.policy

          // L2: assistant-level
          let assistantPolicy: string = defPolicy
          const o = await policyStore!.getPolicy({
            assistantId, userId: policyUserId,
            serverName: policyServerName, toolName: t.name,
          })
          if (o) assistantPolicy = o.policy

          return {
            name: t.name,
            description: t.description,
            classification,
            appPolicy,
            assistantPolicy,
            effectivePolicy: strictest(appPolicy, assistantPolicy),
          }
        }),
      )
      res.json({ tools, serverName: server.name })
    } catch (err) {
      console.error('[assistants] tool discovery failed:', err)
      res.status(500).json({ error: 'Failed to discover tools' })
    }
  })

  // ── POST /:assistantId/connectors/:connectorId/tools/policy ──
  // Sets assistant-level (L2) tool policy. Cannot be looser than app-level (L1).

  router.post('/:assistantId/connectors/:connectorId/tools/policy', async (req, res) => {
    const member = await verifyMembership(req as any, res)
    if (!member) return
    if (!options.mcpSettingsStore) { res.status(500).json({ error: 'Not configured' }); return }

    const { assistantId, connectorId } = req.params as { assistantId: string; connectorId: string }
    const { serverName, toolName, policy } = req.body as {
      serverName?: string; toolName?: string; policy?: string
    }

    if (!serverName || !toolName || !policy || !['allow', 'ask', 'block'].includes(policy)) {
      res.status(400).json({ error: 'Missing or invalid serverName, toolName, or policy' })
      return
    }

    try {
      const classification = classifyTool(toolName)
      const parsedGovernanceId = parseConnectorInstanceGovernanceId(connectorId)
      const providerId = parsedGovernanceId?.provider ?? connectorId
      const dynamicInstance = !!parsedGovernanceId && (
        providerId === 'cli' || !OFFICIAL_CONNECTOR_TOOLS[providerId]
      )
      let policyUserId = member.userId
      if (dynamicInstance && member.workspaceId && options.connectorInstanceStore) {
        const [teamNative, grants] = await Promise.all([
          options.connectorInstanceStore.listByWorkspaceSystem(member.workspaceId),
          options.connectorGrantStore
            ? options.connectorGrantStore.listForTargetSystem('workspace', member.workspaceId)
            : Promise.resolve([]),
        ])
        const teamOwned = teamNative.find((instance) => (
          instance.id === parsedGovernanceId.instanceId && instance.provider === providerId
        ))
        const grant = grants.find(({ instance }) => (
          instance.id === parsedGovernanceId.instanceId && instance.provider === providerId
        ))
        if (teamOwned) {
          const workspaceRole = options.workspaceStore
            ? await options.workspaceStore.getRole(member.userId, member.workspaceId)
            : null
          if (workspaceRole !== 'owner' && workspaceRole !== 'admin') {
            res.status(403).json({ error: 'Workspace owner or admin role required' })
            return
          }
          if (!options.workspaceToolPolicyStore) {
            res.status(500).json({ error: 'Workspace policy store is not configured' })
            return
          }
          await options.workspaceToolPolicyStore.setPolicy({
            workspaceId: member.workspaceId,
            serverName: providerId === 'cli' ? connectorId : providerId,
            toolName,
            policy: policy as 'allow' | 'ask' | 'block',
            classification,
            updatedBy: member.userId,
          })
          res.json({ ok: true })
          return
        }
        if (!grant) {
          res.status(404).json({ error: 'Connector instance not found' })
          return
        }
        policyUserId = grant.grantedByUserId
      }
      const persistedServerName = providerId === 'cli' && parsedGovernanceId
        ? serverName
        : OFFICIAL_CONNECTOR_TOOLS[providerId]
          ? (parsedGovernanceId && providerId === parsedGovernanceId.provider ? connectorId : providerId)
          : serverName

      await options.mcpSettingsStore.setPolicy({
        assistantId,
        userId: policyUserId,
        serverName: persistedServerName,
        toolName,
        policy: policy as 'allow' | 'ask' | 'block',
        classification,
      })

      res.json({ ok: true })
    } catch (err) {
      console.error('[assistants] policy update failed:', err)
      res.status(500).json({ error: 'Failed to update policy' })
    }
  })

  // ── Scheduled jobs ──────────────────────────────────────────────

  router.get<AssistantParams>('/:assistantId/jobs', async (req, res) => {
    const member = await verifyMembership(req as any, res)
    if (!member) return
    if (!options.jobStore) { res.status(500).json({ error: 'Not configured' }); return }

    const status = (req.query.status as string | undefined) ?? 'all' // 'active' | 'completed' | 'all'
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1)
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string, 10) || 10))

    try {
      const allJobs = await options.jobStore.list(req.params.assistantId, member.userId)

      const filtered = status === 'active'
        ? allJobs.filter((j) => j.enabled)
        : status === 'completed'
          ? allJobs.filter((j) => !j.enabled)
          : allJobs

      const total = filtered.length
      const start = (page - 1) * limit
      const paginated = filtered.slice(start, start + limit)

      res.json({
        jobs: paginated.map((j) => ({
          id: j.id,
          instructions: j.instructions,
          schedule: j.schedule,
          timezone: j.timezone,
          mode: j.mode,
          channelType: j.channelType,
          enabled: j.enabled,
          nextRunAt: j.nextRunAt.toISOString(),
          lastRunAt: j.lastRunAt?.toISOString() ?? null,
          lastStatus: j.lastStatus,
        })),
        total,
        page,
        totalPages: Math.ceil(total / limit),
      })
    } catch (err) {
      console.error('[assistants] list jobs failed:', err)
      res.status(500).json({ error: 'Failed to list jobs' })
    }
  })

  router.patch('/:assistantId/jobs/:jobId', async (req, res) => {
    const member = await verifyMembership(req as any, res)
    if (!member) return
    if (!options.jobStore) { res.status(500).json({ error: 'Not configured' }); return }

    const { jobId } = req.params as { assistantId: string; jobId: string }
    const { enabled, instructions, mode, timezone } = req.body as {
      enabled?: boolean
      instructions?: string
      mode?: 'local' | 'user'
      timezone?: string
    }

    // Mode/tz handling mirrors the updateScheduledJob tool in core:
    //   - Flipping to 'user' without an explicit tz syncs to the user's
    //     current tz so next_run_at recomputes to the right instant.
    //   - Flipping to 'local' without a tz keeps the existing value.
    //   - Recompute nextRunAt whenever timezone actually changes. The
    //     job-store.update handles the SQL side — we just need to read
    //     the existing job to know the current schedule.
    const updates: {
      enabled?: boolean
      instructions?: string
      mode?: 'local' | 'user'
      timezone?: string
      nextRunAt?: Date
    } = {}
    if (enabled !== undefined) updates.enabled = enabled
    if (instructions !== undefined) updates.instructions = instructions
    if (mode !== undefined) updates.mode = mode

    if (timezone !== undefined) {
      updates.timezone = timezone
    } else if (mode === 'user') {
      // Sync to users.timezone. Import lazily to keep this route file light.
      const { findUserById } = await import('../db/users.js')
      const user = await findUserById(member.userId)
      if (user?.timezone) updates.timezone = user.timezone
    }

    if (updates.timezone) {
      const existing = await options.jobStore.get(jobId)
      if (existing) {
        const { computeNextRun } = await import('@use-brian/core')
        updates.nextRunAt = computeNextRun(existing.schedule, updates.timezone)
      }
    }

    try {
      const job = await options.jobStore.update(jobId, updates)
      if (!job) { res.status(404).json({ error: 'Job not found' }); return }
      res.json({
        ok: true,
        job: {
          id: job.id,
          enabled: job.enabled,
          mode: job.mode,
          timezone: job.timezone,
          nextRunAt: job.nextRunAt.toISOString(),
        },
      })
    } catch (err) {
      console.error('[assistants] update job failed:', err)
      res.status(500).json({ error: 'Failed to update job' })
    }
  })

  // ── Timezone drift detection ───────────────────────────────────
  // Returns nudge payload when the user appears to have travelled and
  // has pinned (mode='local') jobs that may need attention. Web Tasks
  // tab polls this; see `detectTzDrift` for fire conditions.
  router.get<AssistantParams>('/:assistantId/tz-drift', async (req, res) => {
    const member = await verifyMembership(req as any, res)
    if (!member) return
    try {
      const { detectTzDrift } = await import('../scheduling/tz-drift-detector.js')
      const drift = await detectTzDrift(member.userId)
      // Filter pinned jobs to only those owned by the assistant the user
      // is currently looking at. The detector returns all of the user's
      // pinned jobs across assistants, which is useful for a global
      // banner but noisy per-assistant.
      if (drift && options.jobStore) {
        const assistantJobs = await options.jobStore.list(req.params.assistantId, member.userId)
        const assistantJobIds = new Set(assistantJobs.map((j) => j.id))
        drift.pinnedJobs = drift.pinnedJobs.filter((j) => assistantJobIds.has(j.id))
        if (drift.pinnedJobs.length === 0) {
          res.json({ drift: null })
          return
        }
      }
      res.json({ drift })
    } catch (err) {
      console.error('[assistants] tz-drift check failed:', err)
      res.status(500).json({ error: 'Failed to check tz drift' })
    }
  })

  // Snooze the drift nudge for 30 days — the "Keep" path.
  router.post<AssistantParams>('/:assistantId/tz-drift/suppress', async (req, res) => {
    const member = await verifyMembership(req as any, res)
    if (!member) return
    try {
      const { setTzNudgeSuppression } = await import('../db/users.js')
      const until = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      await setTzNudgeSuppression(member.userId, until)
      res.json({ ok: true, suppressedUntil: until.toISOString() })
    } catch (err) {
      console.error('[assistants] tz-drift suppress failed:', err)
      res.status(500).json({ error: 'Failed to suppress nudge' })
    }
  })

  router.delete('/:assistantId/jobs/:jobId', async (req, res) => {
    const member = await verifyMembership(req as any, res)
    if (!member) return
    if (!options.jobStore) { res.status(500).json({ error: 'Not configured' }); return }

    const { jobId } = req.params as { assistantId: string; jobId: string }

    try {
      const deleted = await options.jobStore.delete(jobId)
      if (!deleted) { res.status(404).json({ error: 'Job not found' }); return }
      res.json({ ok: true })
    } catch (err) {
      console.error('[assistants] delete job failed:', err)
      res.status(500).json({ error: 'Failed to delete job' })
    }
  })

  // ── Skills ─────────────────────────────────────────────────────

  router.get<AssistantParams>('/:assistantId/skills', async (req, res) => {
    const member = await verifyMembership(req, res)
    if (!member) return
    if (!options.skillStore) { res.json({ skills: [] }); return }

    try {
      // Look up the assistant's app_type so we can filter skills constrained
      // to a specific app_type (e.g. distribution-only voice/inspiration
      // skills are hidden on personal assistants). Failure here falls back
      // to "no app_type", which is the same as a personal assistant.
      let assistantAppType: string | null = null
      try {
        const r = await queryWithRLS<{ app_type: string | null }>(
          member.userId,
          'SELECT app_type FROM assistants WHERE id = $1',
          [req.params.assistantId],
        )
        assistantAppType = r.rows[0]?.app_type ?? null
      } catch {}

      const builtin = loadBuiltinSkills()
        .filter((s) => !s.appliesToAppType || s.appliesToAppType === assistantAppType)
        .map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          whenToUse: s.whenToUse,
          category: s.category,
          requiresConnectors: s.requiresConnectors,
          appliesToAppType: s.appliesToAppType,
          source: s.source,
        }))
      // The slug-keyed override layer. Spans BOTH groups (see skill-system.md
      // → "How the two tables actually combine at runtime"), so it is read
      // once and applied to each. A failure here must not read as "no
      // overrides" — that silently flips every opt-out built-in's displayed
      // state — so it is logged and surfaced, never swallowed.
      let settings: Array<{ skillId: string; enabled: boolean }> = []
      let starred: string[] = []
      try {
        settings = await options.skillStore.listForAssistant(req.params.assistantId)
      } catch (err) {
        console.error('[assistants] legacy skill settings read failed:', err)
      }
      try {
        starred = await options.skillStore.listStarred(member.userId)
      } catch (err) {
        console.error('[assistants] skill stars read failed:', err)
      }
      const settingsMap = new Map(settings.map((s) => [s.skillId, s.enabled]))
      const starredSet = new Set(starred)

      const communityMeta = (options.communitySkills ?? []).map((s) => ({
        id: s.id, name: s.name, description: s.description, whenToUse: s.whenToUse,
        category: s.category, requiresConnectors: s.requiresConnectors, source: s.source,
      }))

      // ── Workspace group ───────────────────────────────────────────
      //
      // The assistant's OWN workspace, every author, active/stale only.
      // Deliberately NOT `listOwned(userId)`, which pins the caller's primary
      // (personal) workspace and filters `author_id` — that is why a
      // team-workspace assistant could never see its own skills here, and it
      // is the same deprecated path incident 2026-06-01 removed from the
      // injection pipeline.
      const workspaceSkills: Array<{
        rowId: string
        slug: string
        name: string
        description: string
        whenToUse?: string
        category: string
        requiresConnectors: string[]
        source: string
        enabled: boolean
        starred: boolean
      }> = []
      if (member.workspaceId && options.workspaceSkillEnablementStore && options.workspaceSkillStore) {
        try {
          const [rows, enablement] = await Promise.all([
            options.workspaceSkillStore.listForWorkspace(member.workspaceId, {
              actingUserId: member.userId,
            }),
            options.workspaceSkillEnablementStore.listForAssistant(req.params.assistantId, {
              actingUserId: member.userId,
            }),
          ])
          // `listForWorkspace` carries BOTH keys on one row (`rowId` UUID for
          // the allowlist, `slug` for the legacy override), so the two
          // keyspaces meet without a second resolve query.
          const allowed = new Set(enablement.map((e) => e.workspaceSkillId))
          for (const s of rows) {
            // Match the runtime resolver's state filter — an archived skill
            // (including a curator-absorbed member) is never offered, so
            // showing a toggle for it would promise something that cannot
            // happen.
            if (s.state === 'archived') continue
            workspaceSkills.push({
              rowId: s.rowId,
              slug: s.slug,
              name: s.name,
              description: s.description,
              whenToUse: s.whenToUse,
              category: s.category,
              requiresConnectors: s.requiresConnectors,
              source: s.source,
              // Mirror the runtime predicate in `injectSkills`, not just the
              // allowlist: a legacy `enabled = true` row offers the skill even
              // with no allowlist row, and a legacy `false` vetoes one that
              // has it. Showing allowlist-presence alone would misreport every
              // skill the old personal-workspace toggle enabled.
              enabled: settingsMap.get(s.slug) === false
                ? false
                : allowed.has(s.rowId) || settingsMap.get(s.slug) === true,
              starred: starredSet.has(s.slug),
            })
          }
        } catch (err) {
          // Never degrade to an empty Workspace tab silently — an empty tab is
          // indistinguishable from "this workspace has no skills".
          console.error('[assistants] workspace skill listing failed:', err)
          res.status(500).json({ error: 'Failed to list skills' })
          return
        }
      }

      const allSkills = [...builtin, ...communityMeta]

      res.json({
        skills: allSkills.map((s) => ({
          ...s,
          // Built-in: enabled by default (opt-out). Community: opt-in.
          enabled: settingsMap.get(s.id) ?? (s.source === 'builtin'),
          starred: starredSet.has(s.id),
        })),
        workspaceSkills,
      })
    } catch (err) {
      console.error('[assistants] list skills failed:', err)
      res.status(500).json({ error: 'Failed to list skills' })
    }
  })

  router.post('/:assistantId/skills/:skillId/enable', async (req, res) => {
    const member = await verifyMembership(req as any, res)
    if (!member) return
    if (!options.skillStore) { res.status(500).json({ error: 'Not configured' }); return }

    try {
      const { assistantId, skillId } = req.params as { assistantId: string; skillId: string }
      await options.skillStore.setEnabled(assistantId, skillId, true)
      res.json({ ok: true })
    } catch (err) {
      console.error('[assistants] enable skill failed:', err)
      res.status(500).json({ error: 'Failed to enable skill' })
    }
  })

  router.post('/:assistantId/skills/:skillId/disable', async (req, res) => {
    const member = await verifyMembership(req as any, res)
    if (!member) return
    if (!options.skillStore) { res.status(500).json({ error: 'Not configured' }); return }

    try {
      const { assistantId, skillId } = req.params as { assistantId: string; skillId: string }
      await options.skillStore.setEnabled(assistantId, skillId, false)
      res.json({ ok: true })
    } catch (err) {
      console.error('[assistants] disable skill failed:', err)
      res.status(500).json({ error: 'Failed to disable skill' })
    }
  })

  // ── Workspace skills — the allowlist pair ──────────────────────────
  //
  // The assistant-centric dual of the skill editor's `GET/PUT
  // /api/skills/:id/access`. Both write `workspace_skill_enablement`; this end
  // takes one skill and one assistant, that end takes one skill and many.
  //
  // `:workspaceSkillId` is the workspace_skills ROW UUID, not the slug — the
  // allowlist is UUID-keyed. Membership is the only gate, matching
  // `resolveAccessContext` on the skill-centric route: an admin requirement
  // here would make access editable from one end of the relation and not the
  // other.
  //
  // Spec: docs/architecture/engine/skill-system.md → "Per-assistant enablement".

  /**
   * Resolve the workspace skill and prove it belongs to the same workspace as
   * the assistant. The allowlist PK is `(workspace_skill_id, assistant_id)`
   * and its FKs check existence, not workspace equality — so without this a
   * member of two workspaces could attach workspace A's skill to workspace
   * B's assistant. The skill-centric route gets this structurally by deriving
   * its candidate assistants from the skill's own workspace; here it must be
   * asserted. Mismatch is 404, not 403: the caller should not learn whether an
   * id they cannot use exists.
   */
  async function resolveWorkspaceSkillForAssistant(
    workspaceSkillId: string,
    assistantWorkspaceId: string | null,
    res: import('express').Response,
  ): Promise<{ rowId: string; slug: string } | null> {
    if (!options.workspaceSkillStore || !options.workspaceSkillEnablementStore) {
      res.status(501).json({ error: 'Workspace skill access is not available' })
      return null
    }
    const skill = await options.workspaceSkillStore.getByIdSystem(workspaceSkillId)
    if (!skill || !assistantWorkspaceId || skill.workspaceId !== assistantWorkspaceId) {
      res.status(404).json({ error: 'Skill not found' })
      return null
    }
    return { rowId: skill.rowId, slug: skill.slug }
  }

  router.post('/:assistantId/workspace-skills/:workspaceSkillId/enable', async (req, res) => {
    const member = await verifyMembership(req as any, res)
    if (!member) return

    try {
      const { assistantId, workspaceSkillId } = req.params as {
        assistantId: string; workspaceSkillId: string
      }
      const skill = await resolveWorkspaceSkillForAssistant(
        workspaceSkillId, member.workspaceId, res,
      )
      if (!skill) return

      await options.workspaceSkillEnablementStore!.enable(skill.rowId, assistantId, member.userId)
      // Clear a stale slug-keyed veto so the toggle actually takes effect.
      // DELETE, never `setEnabled(false)` on the disable path — see the store
      // docstring and skill-system.md → "The Workspace toggle reconciles the
      // legacy veto".
      if (options.skillStore) {
        const legacy = await options.skillStore.listForAssistant(assistantId)
        if (legacy.some((r) => r.skillId === skill.slug && !r.enabled)) {
          await options.skillStore.clearEnabled(assistantId, skill.slug)
        }
      }
      res.json({ ok: true })
    } catch (err) {
      console.error('[assistants] enable workspace skill failed:', err)
      res.status(500).json({ error: 'Failed to enable skill' })
    }
  })

  router.post('/:assistantId/workspace-skills/:workspaceSkillId/disable', async (req, res) => {
    const member = await verifyMembership(req as any, res)
    if (!member) return

    try {
      const { assistantId, workspaceSkillId } = req.params as {
        assistantId: string; workspaceSkillId: string
      }
      const skill = await resolveWorkspaceSkillForAssistant(
        workspaceSkillId, member.workspaceId, res,
      )
      if (!skill) return

      await options.workspaceSkillEnablementStore!.disable(skill.rowId, assistantId, member.userId)
      // A legacy `enabled = true` row would keep offering the skill after the
      // allowlist row is gone, so it has to go too. Deleting (rather than
      // writing `false`) avoids minting a veto row that would silently defeat
      // a later enable from the skill editor's allowlist-only Access tab.
      if (options.skillStore) {
        const legacy = await options.skillStore.listForAssistant(assistantId)
        if (legacy.some((r) => r.skillId === skill.slug && r.enabled)) {
          await options.skillStore.clearEnabled(assistantId, skill.slug)
        }
      }
      res.json({ ok: true })
    } catch (err) {
      console.error('[assistants] disable workspace skill failed:', err)
      res.status(500).json({ error: 'Failed to disable skill' })
    }
  })

  return router
}
