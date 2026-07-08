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
 *   PATCH  /:assistantId          — update settings: system_prompt (any member),
 *                                   clearance (owner / workspace admin), everything
 *                                   else (name, bio, sharing, model aliases) owner-only
 *   DELETE /:assistantId          — delete assistant (owner only, solo-owned)
 */

import { Router } from 'express'
import { queryWithRLS, query, getPool } from '../db/client.js'
import type { AssistantConnectorStore } from '../db/assistant-connector-store.js'
import type { ConnectorStore } from '../db/connector-store.js'
import type { ConnectorInstanceStore } from '../db/connector-instance-store.js'
import { buildConnectorAuthHeaders } from '../mcp/auth-headers.js'
import type { ConnectorGrantStore } from '../db/connector-grant-store.js'
import { isSoloWorkspaceSystem } from '../db/workspace-store.js'
import type { McpSettingsStore, JobStore, CapabilityStore } from '@sidanclaw/core'
import { APP_LEVEL_ASSISTANT_ID, OFFICIAL_CONNECTOR_TOOLS, OFFICIAL_CONNECTORS, type ConnectorEntry } from '@sidanclaw/shared'
import { classifyTool, defaultPolicy, loadBuiltinSkills } from '@sidanclaw/core'
import type { SkillContent } from '@sidanclaw/core'
import type { SkillStore } from '../db/skill-store.js'

type AssistantParams = { assistantId: string }

type AssistantRouteOptions = {
  assistantConnectorStore?: AssistantConnectorStore
  connectorStore?: ConnectorStore
  connectorInstanceStore?: ConnectorInstanceStore
  connectorGrantStore?: ConnectorGrantStore
  mcpSettingsStore?: McpSettingsStore
  registry?: ConnectorEntry[]
  jobStore?: JobStore
  skillStore?: SkillStore
  communitySkills?: SkillContent[]
  capabilityStore: CapabilityStore
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
   * Verify the authenticated user is a member of this assistant.
   * Returns { userId, role } or sends 401/403 and returns null.
   *
   * Post-089 (team-connector promotion): team-owned assistants have no
   * `assistant_members` rows — access flows through `workspace_members`. We
   * check both paths and return the first that matches.
   *   - Personal assistant: the user's `assistant_members.role`
   *   - Team assistant:    the user's `workspace_members.role` (in the team)
   */
  async function verifyMembership(
    req: { userId?: string; params: AssistantParams },
    res: import('express').Response,
  ): Promise<{ userId: string; role: string } | null> {
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return null
    }
    const { assistantId } = req.params

    const result = await queryWithRLS<{ role: string }>(
      userId,
      `SELECT am.role
         FROM assistant_members am
        WHERE am.assistant_id = $1 AND am.user_id = $2
       UNION
       SELECT tm.role
         FROM assistants a
         JOIN workspace_members tm ON tm.workspace_id = a.workspace_id
        WHERE a.id = $1 AND tm.user_id = $2 AND a.workspace_id IS NOT NULL
       LIMIT 1`,
      [assistantId, userId],
    )
    if (result.rows.length === 0) {
      res.status(403).json({ error: 'Not a member of this assistant' })
      return null
    }
    return { userId, role: result.rows[0].role }
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
        sharing_mode: string
        created_at: string
        slack_model_alias: string
        telegram_model_alias: string
        whatsapp_model_alias: string
        icon_seed: number | null
        workspace_id: string | null
        clearance: string
        kind: string
        app_type: string | null
      }>(
        member.userId,
        `SELECT id, name, system_prompt, bio, sharing_mode, created_at,
                slack_model_alias, telegram_model_alias, whatsapp_model_alias, icon_seed, workspace_id, clearance, kind, app_type
         FROM assistants WHERE id = $1`,
        [assistantId],
      )
      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Assistant not found' })
        return
      }
      const row = result.rows[0]
      res.json({
        id: row.id,
        name: row.name,
        role: member.role,
        systemPrompt: row.system_prompt,
        createdAt: row.created_at,
        slackModelAlias: row.slack_model_alias,
        telegramModelAlias: row.telegram_model_alias,
        whatsappModelAlias: row.whatsapp_model_alias,
        iconSeed: row.icon_seed ?? 0,
        workspaceId: row.workspace_id,
        bio: row.bio,
        sharingMode: row.sharing_mode,
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
    const { name, systemPrompt, slackModelAlias, telegramModelAlias, whatsappModelAlias, bio, sharingMode, clearance } = req.body as {
      name?: string
      systemPrompt?: string | null
      slackModelAlias?: string
      telegramModelAlias?: string
      whatsappModelAlias?: string
      bio?: string | null
      sharingMode?: string
      clearance?: string
    }

    // Authorization model (verifyMembership already confirmed the caller can
    // access this assistant):
    //   - `system_prompt`: any member who can access the assistant. The system
    //     prompt is a shared, collaboratively-editable persona — released from
    //     owner-only so teammates can tune the assistant they work with. See
    //     docs/architecture/features/assistant-detail-page.md →
    //     "Settings tab — system prompt (shared editing right)".
    //   - `clearance`: the assistant owner, or a team admin/owner of the
    //     assistant's workspace (policy is a team-wide concern — see
    //     docs/architecture/platform/sensitivity.md).
    //   - everything else (name, bio, sharingMode, model aliases): owner only.
    // A non-owner request that bundles an owner-only field is rejected whole
    // (the strictest field in the request governs).
    const ownerOnlyFieldPresent =
      name !== undefined || bio !== undefined || sharingMode !== undefined ||
      slackModelAlias !== undefined || telegramModelAlias !== undefined ||
      whatsappModelAlias !== undefined

    if (member.role !== 'owner') {
      if (ownerOnlyFieldPresent) {
        res.status(403).json({ error: 'Only the owner can update assistant settings' })
        return
      }
      // The request now touches only systemPrompt and/or clearance. A
      // clearance change still requires team admin/owner; systemPrompt is
      // open to any member who reached this far.
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
    if (systemPrompt !== undefined && systemPrompt !== null) {
      if (typeof systemPrompt !== 'string') {
        res.status(400).json({ error: 'System prompt must be a string' })
        return
      }
      if (systemPrompt.length > 10000) {
        res.status(400).json({ error: 'System prompt must be 10,000 characters or less' })
        return
      }
    }
    if (slackModelAlias !== undefined && !VALID_MODEL_ALIASES.has(slackModelAlias)) {
      res.status(400).json({ error: 'slackModelAlias must be standard, pro, or max' })
      return
    }
    if (telegramModelAlias !== undefined && !VALID_MODEL_ALIASES.has(telegramModelAlias)) {
      res.status(400).json({ error: 'telegramModelAlias must be standard, pro, or max' })
      return
    }
    if (whatsappModelAlias !== undefined && !VALID_MODEL_ALIASES.has(whatsappModelAlias)) {
      res.status(400).json({ error: 'whatsappModelAlias must be standard, pro, or max' })
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
    if (systemPrompt !== undefined) {
      sets.push(`system_prompt = $${idx++}`)
      values.push(systemPrompt === null ? null : systemPrompt)
    }
    if (slackModelAlias !== undefined) {
      sets.push(`slack_model_alias = $${idx++}`)
      values.push(slackModelAlias)
    }
    if (telegramModelAlias !== undefined) {
      sets.push(`telegram_model_alias = $${idx++}`)
      values.push(telegramModelAlias)
    }
    if (whatsappModelAlias !== undefined) {
      sets.push(`whatsapp_model_alias = $${idx++}`)
      values.push(whatsappModelAlias)
    }
    if (bio !== undefined) {
      sets.push(`bio = $${idx++}`)
      values.push(bio === null ? null : (bio.slice(0, 200)))
    }
    // Sharing hard-lock: an assistant with any active capability grant
    // cannot be shared. Privileged bots must stay private — revoke all
    // grants first, then enable sharing. See
    // docs/architecture/platform/capability-grants.md → "Sharing hard-lock".
    if (sharingMode !== undefined && ['off', 'private', 'public'].includes(sharingMode)) {
      if (sharingMode !== 'off') {
        const hasGrants = await options.capabilityStore.hasActive(assistantId)
        if (hasGrants) {
          res.status(409).json({
            error: 'Cannot enable sharing on a privileged assistant. Revoke all capability grants first.',
            code: 'SHARING_LOCKED_BY_GRANTS',
          })
          return
        }
      }
      sets.push(`sharing_mode = $${idx++}`)
      values.push(sharingMode)
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
        slack_model_alias: string; telegram_model_alias: string; whatsapp_model_alias: string
        clearance: string
      }>(
        member.userId,
        `UPDATE assistants SET ${sets.join(', ')} WHERE id = $${idx}
         RETURNING id, name, system_prompt, slack_model_alias, telegram_model_alias, whatsapp_model_alias, clearance`,
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

      res.json({
        id: row.id,
        name: row.name,
        systemPrompt: row.system_prompt,
        slackModelAlias: row.slack_model_alias,
        telegramModelAlias: row.telegram_model_alias,
        whatsappModelAlias: row.whatsapp_model_alias,
        clearance: row.clearance,
      })
    } catch (err) {
      console.error('[assistants] update failed:', err)
      res.status(500).json({ error: 'Failed to update assistant' })
    }
  })

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
  type PrimitiveCapability = (typeof PRIMITIVE_CAPABILITIES)[number]
  // Admin-gated named capabilities toggleable on this surface. `configure`
  // unlocks Tier-2 control-plane write tools for agents acting as this
  // assistant (CONFIGURE_CAPABILITY in @sidanclaw/core).
  const ADMIN_CAPABILITIES = ['configure'] as const
  const TOGGLEABLE_CAPABILITIES = [...PRIMITIVE_CAPABILITIES, ...ADMIN_CAPABILITIES]

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
    if (!TOGGLEABLE_CAPABILITIES.includes(capability as PrimitiveCapability | 'configure')) {
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
                : '§17 toggled off by workspace member',
          })
        }
      }
      const active = new Set(await options.capabilityStore.listActive(assistantId))
      res.json({ capability, enabled: active.has(capability) })
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
      // (packages/api/src/mcp/inject.ts, incident 2026-06-01 / 2026-06-02). The
      // personal layer below pulls the viewer's `scope='user'` connectors. The
      // engine only injects owner-personal connectors while the workspace is
      // *solo* (live member count <= 1, any kind — `is_personal` is irrelevant);
      // the moment a teammate joins it suppresses them. Surfacing them here as
      // assistant toggles otherwise advertises dead toggles AND re-draws the
      // owner-impersonation surface that gate closed. Workspace-less personal
      // assistants (no workspace) always load them. Fails CLOSED via the helper.
      const loadPersonal = assistantTeamId
        ? await isSoloWorkspaceSystem(assistantTeamId)
        : true
      const userConnectors = loadPersonal
        ? await options.connectorStore.list(member.userId)
        : []

      // Build the unified list, applying the same precedence the engine
      // uses at tool-injection time (see packages/api/src/mcp/inject.ts):
      //   team-native > member-grant > personal
      // Each connector toggle is keyed by provider — that matches what
      // assistant_connector_settings stores and what inject.ts's L2 lookup
      // checks.
      type Entry = {
        id: string
        name: string
        url?: string
        custom: boolean
        connected: boolean
        enabled: boolean
        icon_url?: string
        category?: 'official' | 'community'
        scope: 'personal' | 'team-native' | 'team-grant'
        grantedByUserId?: string
      }
      const byKey = new Map<string, Entry>()

      if (assistantTeamId && options.connectorInstanceStore) {
        const teamNative = await options.connectorInstanceStore.listByWorkspaceSystem(assistantTeamId)
        for (const inst of teamNative) {
          const entry = registry.find((e) => e.id === inst.provider)
          byKey.set(inst.provider, {
            id: inst.provider,
            name: inst.label,
            url: inst.url ?? undefined,
            custom: inst.custom,
            connected: inst.connected,
            enabled: settingsMap.get(inst.provider) ?? true,
            icon_url: entry?.icon_url,
            category: entry?.category,
            scope: 'team-native',
          })
        }
      }

      if (assistantTeamId && options.connectorGrantStore) {
        const grants = await options.connectorGrantStore.listForTargetSystem('workspace', assistantTeamId)
        for (const g of grants) {
          if (byKey.has(g.instance.provider)) continue   // team-native wins
          const entry = registry.find((e) => e.id === g.instance.provider)
          byKey.set(g.instance.provider, {
            id: g.instance.provider,
            name: g.instance.label,
            url: g.instance.url ?? undefined,
            custom: g.instance.custom,
            connected: g.instance.connected,
            enabled: settingsMap.get(g.instance.provider) ?? true,
            icon_url: entry?.icon_url,
            category: entry?.category,
            scope: 'team-grant',
            grantedByUserId: g.grantedByUserId,
          })
        }
      }

      // Layer in personal connectors — but skip any provider already
      // claimed by team-native or grant, since the engine would shadow
      // them anyway.
      for (const c of userConnectors) {
        if (byKey.has(c.connectorId)) continue
        if (!BUILTIN_IDS.has(c.connectorId) && !c.connected) continue
        const entry = registry.find((e) => e.id === c.connectorId)
        byKey.set(c.connectorId, {
          id: c.connectorId,
          name: c.name,
          url: c.url ?? undefined,
          custom: c.custom,
          connected: c.connected,
          enabled: settingsMap.get(c.connectorId) ?? true,
          icon_url: entry?.icon_url,
          category: entry?.category ?? (c.custom ? undefined : 'community' as const),
          scope: 'personal',
        })
      }

      const connectors = Array.from(byKey.values())
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

    {
      const { appendFile } = await import('node:fs/promises')
      await appendFile('/tmp/sidanclaw-debug.log', `[assistants/tools] assistantId=${assistantId} connectorId=${connectorId} isOfficial=${!!OFFICIAL_CONNECTOR_TOOLS[connectorId]} officialCount=${OFFICIAL_CONNECTOR_TOOLS[connectorId]?.length ?? 0} keys=${Object.keys(OFFICIAL_CONNECTOR_TOOLS).join(',')}\n`).catch(() => {})
    }
    try {
      if (OFFICIAL_CONNECTOR_TOOLS[connectorId]) {
        const tools = await Promise.all(
          OFFICIAL_CONNECTOR_TOOLS[connectorId].map(async (t) => {
            // L1: app-level policy (sentinel assistant ID)
            let appPolicy: string = t.defaultPolicy
            const appOverride = await options.mcpSettingsStore!.getPolicy({
              assistantId: APP_LEVEL_ASSISTANT_ID, userId: member.userId,
              serverName: connectorId, toolName: t.name,
            })
            if (appOverride) appPolicy = appOverride.policy

            // L2: assistant-level policy
            let assistantPolicy: string = t.defaultPolicy
            const override = await options.mcpSettingsStore!.getPolicy({
              assistantId, userId: member.userId,
              serverName: connectorId, toolName: t.name,
            })
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
        res.json({ tools, serverName: connectorId })
        return
      }

      // Custom MCP connector — check personal first, then team-native
      // instances on this assistant's owning team. Team-native custom
      // MCPs use a UUID `provider` (set in connector-instances.ts) so
      // they can never collide with personal `connectorId`s here.
      const connectors = await options.connectorStore!.list(member.userId)
      const personal = connectors.find((c) => c.connectorId === connectorId)
      let mcpUrl: string | null = personal?.url ?? null
      let mcpName: string = personal?.name ?? connectorId
      // Outbound auth headers (bearer / custom header) for an auth-required
      // custom connector — resolved per branch so the discovery initialize
      // isn't rejected (which would 500 this route and blank the L2 policy
      // editor). Mirrors GET /connectors/:id/tools + injectMcpTools.
      let authHeaders: Record<string, string> = {}
      if (personal?.url) {
        authHeaders = buildConnectorAuthHeaders(
          await options.connectorStore!.getAuthCredentials(member.userId, connectorId),
        )
      }

      if (!mcpUrl && options.connectorInstanceStore) {
        const teamRow = await queryWithRLS<{ workspace_id: string | null }>(
          member.userId,
          `SELECT workspace_id FROM assistants WHERE id = $1`,
          [assistantId],
        )
        const assistantTeamId = teamRow.rows[0]?.workspace_id ?? null
        if (assistantTeamId) {
          const teamInstances = await options.connectorInstanceStore.listByWorkspaceSystem(assistantTeamId)
          const teamCustom = teamInstances.find((inst) => inst.provider === connectorId && inst.custom && inst.url)
          if (teamCustom) {
            mcpUrl = teamCustom.url
            mcpName = teamCustom.label
            authHeaders = buildConnectorAuthHeaders(
              await options.connectorInstanceStore.getAuthCredentialsSystem(teamCustom.id),
            )
          }
        }
      }

      if (!mcpUrl) { res.json({ tools: [], serverName: connectorId }); return }

      const { discoverMcpServer } = await import('../mcp/client.js')
      const server = await discoverMcpServer(mcpUrl, mcpName, authHeaders)

      const tools = await Promise.all(
        server.tools.map(async (t) => {
          const classification = classifyTool(t.name, t.description)
          const defPolicy = defaultPolicy(classification)

          // L1: app-level (sentinel assistant ID)
          let appPolicy: string = defPolicy
          const appOverride = await options.mcpSettingsStore!.getPolicy({
            assistantId: APP_LEVEL_ASSISTANT_ID, userId: member.userId,
            serverName: server.name, toolName: t.name,
          })
          if (appOverride) appPolicy = appOverride.policy

          // L2: assistant-level
          let assistantPolicy: string = defPolicy
          const o = await options.mcpSettingsStore!.getPolicy({
            assistantId, userId: member.userId,
            serverName: server.name, toolName: t.name,
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

      await options.mcpSettingsStore.setPolicy({
        assistantId,
        userId: member.userId,
        serverName,
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
        const { computeNextRun } = await import('@sidanclaw/core')
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
      // DB queries may fail if migration hasn't run — gracefully degrade
      let userSkills: Array<{ id: string; name: string; description: string; whenToUse?: string; category: string; requiresConnectors: string[]; source: string }> = []
      let settings: Array<{ skillId: string; enabled: boolean }> = []
      let starred: string[] = []
      try {
        userSkills = await options.skillStore.listOwned(member.userId)
        settings = await options.skillStore.listForAssistant(req.params.assistantId)
      } catch {}
      try {
        starred = await options.skillStore.listStarred(member.userId)
      } catch {}
      const settingsMap = new Map(settings.map((s) => [s.skillId, s.enabled]))
      const starredSet = new Set(starred)

      const communityMeta = (options.communitySkills ?? []).map((s) => ({
        id: s.id, name: s.name, description: s.description, whenToUse: s.whenToUse,
        category: s.category, requiresConnectors: s.requiresConnectors, source: s.source,
      }))
      const allSkills = [...builtin, ...communityMeta, ...userSkills.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        whenToUse: s.whenToUse,
        category: s.category,
        requiresConnectors: s.requiresConnectors,
        source: s.source,
      }))]

      res.json({
        skills: allSkills.map((s) => ({
          ...s,
          // Built-in: enabled by default (opt-out). Community/user: disabled by default (opt-in).
          enabled: settingsMap.get(s.id) ?? (s.source === 'builtin'),
          starred: starredSet.has(s.id),
        })),
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

  return router
}
