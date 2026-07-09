/**
 * Shared route helpers — extracted from duplicated patterns across route files.
 *
 * [COMP:api/route-helpers]
 */

import { findOrCreateUser, findUserById } from '../db/users.js'
import { query } from '../db/client.js'
import { loadBuiltinSkills, formatSkillListing, createUseSkillTool, expandSkillPointers, parseFileContent, shouldInline } from '@sidanclaw/core'
import type { Tool, UsageStore, BudgetStatus, ContentBlock, FileStore, McpSettingsStore, KnowledgeStoreInterface, KnowledgeRepoWriter, GDriveFilesStore, SkillContent, EngineHooks, FilesApi } from '@sidanclaw/core'
import type { ActorIdentity } from '../mcp/auth-headers.js'
// NOTE: the real DB-backed credit gate (`checkCreditBudget`, closed billing/)
// is NOT imported here — that would couple this OPEN helper to closed code.
// It is injected into `checkUsageBudget` as `creditGate` by the platform; the
// open build omits it and every turn runs uncapped (billing-out = don't-wire,
// the open-core split (repo CLAUDE.md; plan in git history) §12.3).
import type { SkillStore, WorkspaceSkillStore } from '../db/skill-store.js'
import type { ConnectorStore } from '../db/connector-store.js'
import type { AssistantConnectorStore } from '../db/assistant-connector-store.js'
import type { ConnectorGrantStore } from '../db/connector-grant-store.js'
import type { ConnectorInstanceStore } from '../db/connector-instance-store.js'
import { injectMcpTools, type ConfirmationEnricher, type McpInjectionResult } from '../mcp/inject.js'
import { renderArtifactManifest } from '../files/artifact-manifest.js'

// ── User resolution ────────────────────────────────────────────

/**
 * Resolve user from JWT token or create/find a guest fallback.
 * Used by routes behind `optionalAuth` that serve both authenticated
 * and guest traffic.
 */
export async function resolveUser(jwtUserId?: string) {
  if (jwtUserId) {
    const user = await findUserById(jwtUserId)
    return user ?? null
  }
  const { user } = await findOrCreateUser({
    authProvider: 'web-guest',
    authProviderId: 'guest-local',
    name: 'Guest',
  })
  return user
}

// ── Assistant membership checks ────────────────────────────────

/**
 * Verify that `userId` is a member of the given assistant.
 * Sends 403 and returns false if not.
 *
 * Personal assistants: row in `assistant_members`. Team assistants
 * (post migration `089`): row in `workspace_members` for the owning team.
 */
export async function requireAssistantMember(
  userId: string,
  assistantId: string,
  res: import('express').Response,
): Promise<boolean> {
  const result = await query<{ ok: number }>(
    `SELECT 1 AS ok
     WHERE EXISTS (
       SELECT 1 FROM assistant_members am
       WHERE am.assistant_id = $1 AND am.user_id = $2
     )
     OR EXISTS (
       SELECT 1 FROM assistants a
       JOIN workspace_members tm ON tm.workspace_id = a.workspace_id
       WHERE a.id = $1 AND tm.user_id = $2
     )`,
    [assistantId, userId],
  )
  if (result.rows.length === 0) {
    res.status(403).json({ error: 'Not a member of this assistant' })
    return false
  }
  return true
}

/**
 * Verify that `userId` is an owner of the given assistant.
 * Sends 403 and returns false if not.
 *
 * Personal assistants: `assistant_members.role='owner'`. Team
 * assistants (post migration `089`): `workspace_members.role='owner'`
 * for the owning team.
 */
export async function requireAssistantOwner(
  userId: string,
  assistantId: string,
  res: import('express').Response,
): Promise<boolean> {
  const result = await query<{ ok: number }>(
    `SELECT 1 AS ok
     WHERE EXISTS (
       SELECT 1 FROM assistant_members am
       WHERE am.assistant_id = $1 AND am.user_id = $2 AND am.role = 'owner'
     )
     OR EXISTS (
       SELECT 1 FROM assistants a
       JOIN workspace_members tm ON tm.workspace_id = a.workspace_id
       WHERE a.id = $1 AND tm.user_id = $2 AND tm.role = 'owner'
     )`,
    [assistantId, userId],
  )
  if (result.rows.length === 0) {
    res.status(403).json({ error: 'Not the owner of this assistant' })
    return false
  }
  return true
}

// ── Budget display ─────────────────────────────────────────────

/**
 * Compute a display percent for a usage window (session or rolling).
 *
 * Raw percent is the float ratio cost/cap. The display percent rounds to
 * an integer, but floors to 1% when any usage exists — otherwise a user
 * who's spent $0.001 of a $2.33 weekly cap would see 0% after 50 chats
 * and think tracking is broken.
 */
export function computePercent(cost: number, cap: number) {
  if (cap <= 0) return { percent: 0, rawPercent: 0 }
  const rawPercent = (cost / cap) * 100
  if (rawPercent <= 0) return { percent: 0, rawPercent: 0 }
  const percent = rawPercent < 1 ? 1 : Math.min(100, Math.round(rawPercent))
  return { percent, rawPercent: Number(rawPercent.toFixed(4)) }
}

// ── Budget gate ───────────────────────────────────────────────

/**
 * Centralised budget gate used by all channels (web, Telegram, Slack, WhatsApp).
 *
 * Returns `ok` / `downgraded` / `blocked` plus a `resetsAt` ISO timestamp
 * so callers can tell the user when the allowance resets.
 *
 * Scoped to the WORKSPACE (migration 144) — the credit allowance aggregates
 * the whole workspace, and `plan` is the workspace's plan (`workspaces.plan`,
 * one of free/pro/max_5x/max_10x/enterprise). Enforcement is the **monthly
 * credit cap** (`creditCapForPlan`): at the cap, paid plans downgrade to
 * Standard and free blocks. `resetsAt` is the current billing-period end.
 *
 * Replaced the rolling-dollar budget (weekly + 5h burst windows) on
 * 2026-06-05. See docs/architecture/platform/cost-and-pricing.md → "Budget
 * enforcement: the monthly credit cap".
 */
export type UsageBudgetGateResult = {
  status: BudgetStatus
  resetsAt: string | null
  /** Credits consumed this billing period (derived). */
  creditsUsed: number
  /** Plan monthly allowance; null = uncapped (enterprise). */
  creditCap: number | null
}

/**
 * The injected credit-gate seam. The platform passes the real DB-backed
 * `checkCreditBudget` (closed `billing/`); the open build passes nothing.
 */
export type CreditBudgetGate = (
  workspaceId: string,
  plan: string,
) => Promise<UsageBudgetGateResult>

export async function checkUsageBudget(
  workspaceId: string,
  plan: string,
  creditGate?: CreditBudgetGate,
): Promise<UsageBudgetGateResult> {
  // Open build: no billing wired -> allow-all (uncapped). The caller already
  // skips this path entirely when `usageStore` is absent (chat.ts), so this is
  // a belt-and-suspenders default.
  if (!creditGate) {
    return { status: 'ok', resetsAt: null, creditsUsed: 0, creditCap: null }
  }
  const result = await creditGate(workspaceId, plan)
  return {
    status: result.status,
    resetsAt: result.resetsAt,
    creditsUsed: result.creditsUsed,
    creditCap: result.creditCap,
  }
}

// ── Date validation ────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Check if a string is a valid YYYY-MM-DD date format. */
export function isValidDateString(date: string): boolean {
  return DATE_RE.test(date)
}

// ── System prompt builders ─────────────────────────────────────

/**
 * Build the "unavailable capabilities" system prompt section.
 * Tells the model what's NOT available so it doesn't waste turns searching.
 *
 * Closed-world framing: the suggest-Settings template is scoped to the
 * listed services only. Without the scoping, models extend the template to
 * arbitrary services ("enable the Jira connector in Settings") and invent
 * integrations that do not exist (caught by the WS2 probe battery,
 * conn-jira-post / wf-crm-deal-won).
 */
export function buildUnavailableCapabilitiesPrompt(capabilities: string[]): string {
  if (capabilities.length === 0) return ''
  return `\n\n# Unavailable capabilities\n\nThe following services are NOT available. Do not attempt to use them or search for them:\n${capabilities.map((c) => `- ${c}`).join('\n')}\n\nIf the user asks for something that requires one of the services listed above, say it is not connected and suggest enabling it in Settings (when an entry includes its own connect phrase, use that instead). This list plus your tools is the complete integration surface: for a service in neither, sidanclaw has no integration to enable. Say so plainly and offer the nearest supported alternative. Never point the user to a Settings toggle or connector for a service that is not listed here.`
}

// ── MCP injection (shared across channel routes) ──────────────

/**
 * Stores needed by `applyMcpInjection`. Grouped so route option types
 * can spread the same shape (every chat-style channel passes the same
 * set of stores from `apps/api/src/index.ts`).
 */
export type ChannelMcpStores = {
  connectorStore?: ConnectorStore
  mcpSettingsStore?: McpSettingsStore
  assistantConnectorStore?: AssistantConnectorStore
  knowledgeStore?: KnowledgeStoreInterface
  /**
   * KB repo write-back port (assistant direct edits). Inert unless the
   * caller also sets `allowKnowledgeWrites` on the injection params.
   */
  knowledgeRepoWriter?: KnowledgeRepoWriter
  gdriveFilesStore?: GDriveFilesStore
  connectorGrantStore?: ConnectorGrantStore
  connectorInstanceStore?: ConnectorInstanceStore
  /** Shared workspace tool policy (migration 312) — governs team-owned connector tools. */
  workspaceToolPolicyStore?: import('../db/workspace-tool-policy-store.js').WorkspaceToolPolicyStore
  /**
   * Per-assistant connector grants store (#4 in
   * `docs/architecture/integrations/connector-actions.md`). Forwarded
   * to `injectMcpTools` → `injectGoogleTools` so Gmail/GCal write
   * callbacks gate on `assertActionAllowed` before executing.
   */
  assistantConnectorGrantsStore?: import('../db/assistant-connector-grants-store.js').AssistantConnectorGrantsStore
  /**
   * Workspace-files byte layer — enables `gmailSendMessage` workspace-file
   * attachments (`docs/architecture/integrations/gmail.md` → "Attachments").
   */
  filesApi?: FilesApi
}

export type ApplyMcpInjectionParams = {
  /** Log-prefix scope (e.g. `'chat'`, `'public-api'`). */
  scope: string
  /**
   * Pre-resolved connector user id. Callers are responsible for running
   * `getConnectorUserId(actingUserId, assistant.workspaceId)` first because they
   * typically reuse the result for `injectSkills` later in the same turn.
   */
  connectorUserId: string
  assistant: { id: string; workspaceId?: string | null }
  userTimezone?: string
  /** The mutable tool map injection writes into. */
  tools: Map<string, Tool>
  stores: ChannelMcpStores
  /**
   * Connector-action audit deps. When set + the assistant is workspace-
   * scoped + the right stores are wired, the Gmail `sendMessage` wrap
   * emits a `connector_action` Episode + audit row per
   * `docs/plans/company-brain/connector-actions.md`. Forwarded through
   * to `injectMcpTools → injectGoogleTools`. Absent → Gmail still
   * works, just without the brain-level audit.
   */
  connectorActionAudit?: import('../connector-action-port.js').ConnectorActionAudit
  /**
   * Authoritative primary email domain for the acting assistant's
   * workspace — drives `audience_clearance` derivation in the GCal
   * audit hook (`internal` when all attendees on-domain, else
   * `public`). Forwarded to `injectMcpTools → injectGoogleTools`.
   */
  workspaceDomain?: string | null
  /**
   * Tool-use interception port (remote MCP only), forwarded to
   * `injectMcpTools`. Open default = unset. See
   * `docs/architecture/engine/tool-hooks.md`.
   */
  engineHooks?: EngineHooks
  /**
   * The acting user's resolved identity for this turn, forwarded to
   * `injectMcpTools` (opted-in connectors get `X-Sidanclaw-Actor-*` headers).
   */
  actorIdentity?: ActorIdentity
  /**
   * On-demand introspection lane tools, forwarded to `injectMcpTools` as the
   * `serverName: 'introspection'` mcp_search local source. The CALLER gates:
   * pass them only for interactive workspace-PRIMARY turns (they read
   * workspace-operational state — approvals, scheduled jobs, research runs,
   * session history). See `docs/architecture/engine/introspection-tools.md`.
   */
  introspectionTools?: Tool[]
  /**
   * Whether this surface may expose the KB WRITE tools. `applyMcpInjection`
   * serves BOTH the interactive web chat AND the public API channel, so the
   * flag is per-caller and never hardcoded here: web chat passes `true`
   * (live Approve/Deny loop); the public API passes `false` (no
   * confirmation loop — its strip would orphan an `ask` tool). Default
   * `false`, fail closed. See docs/architecture/features/knowledge-base.md
   * → "Assistant direct edits".
   */
  allowKnowledgeWrites?: boolean
}

/**
 * Run the same MCP injection step every chat-style route needs:
 * discover the team owner's connectors, inject `mcp_search`/`mcp_call`
 * + any built-in connectors + KB tools, return the unavailable-capability
 * list and confirmation enricher.
 *
 * No-op (returns identity enricher + empty unavailable list) when the
 * required stores aren't wired in. Catches injection failures so a flaky
 * MCP server can never crash the route.
 *
 * Used by web `chat.ts` and the public API channel — keeps the two
 * surfaces in lockstep so an assistant's tool set doesn't depend on
 * which transport the consumer happens to be using.
 */
export async function applyMcpInjection(
  params: ApplyMcpInjectionParams,
): Promise<McpInjectionResult> {
  const noop: McpInjectionResult = {
    enrichConfirmation: async (_t, input) => input,
    unavailable: [],
  }
  const { stores } = params
  if (!stores.connectorStore || !stores.mcpSettingsStore) return noop
  try {
    return await injectMcpTools({
      userId: params.connectorUserId,
      assistantId: params.assistant.id,
      tools: params.tools,
      connectorStore: stores.connectorStore,
      settingsStore: stores.mcpSettingsStore,
      assistantConnectorStore: stores.assistantConnectorStore,
      userTimezone: params.userTimezone,
      knowledgeStore: stores.knowledgeStore,
      knowledgeRepoWriter: stores.knowledgeRepoWriter,
      allowKnowledgeWrites: params.allowKnowledgeWrites === true,
      gdriveFilesStore: stores.gdriveFilesStore,
      connectorGrantStore: stores.connectorGrantStore,
      connectorInstanceStore: stores.connectorInstanceStore,
      workspaceToolPolicyStore: stores.workspaceToolPolicyStore,
      assistantTeamId: params.assistant.workspaceId ?? null,
      connectorActionAudit: params.connectorActionAudit,
      assistantConnectorGrantsStore: stores.assistantConnectorGrantsStore,
      workspaceDomain: params.workspaceDomain,
      engineHooks: params.engineHooks,
      actorIdentity: params.actorIdentity,
      filesApi: stores.filesApi,
      introspectionTools: params.introspectionTools,
    })
  } catch (err) {
    console.error(`[${params.scope}] MCP tool injection failed:`, err)
    return noop
  }
}

export type { ConfirmationEnricher, McpInjectionResult }

// ── Skill injection ────────────────────────────────────────────

/** sensitivity / clearance rank ordering: public(1) < internal(2) < confidential(3). */
const SENSITIVITY_RANK: Record<'public' | 'internal' | 'confidential', number> = {
  public: 1,
  internal: 2,
  confidential: 3,
}

/**
 * Use-time clearance gate for a single skill, per
 * `docs/architecture/engine/skill-system.md` → "Sensitivity + clearance gate".
 * A skill `S` is OFFERED to assistant `A` iff
 * `sensitivity_rank(S.sensitivity) <= sensitivity_rank(A.clearance)`
 * (the public(1) < internal(2) < confidential(3) ordering).
 *
 * Offering SCOPE is owned entirely by the `workspace_skill_enablement`
 * allowlist (rule 1, applied in `injectSkills` alongside this helper, with
 * the requiresConnectors + appType gating). Suggested skills get their
 * originating assistant's enablement row seeded at creation (mig 264), so
 * the proposer-first default lives in data the Access matrix shows and
 * edits — there is no longer an activation/originating override here.
 * Built-in skills (loaded from disk, no `workspace_skills` row) are treated
 * by the caller as `sensitivity: 'public'`, so they pass unconditionally.
 *
 * [COMP:api/skill-injection-gate]
 */
export type SkillGovernance = {
  sensitivity: 'public' | 'internal' | 'confidential'
}

export type SkillOfferableViewer = {
  assistantClearance: 'public' | 'internal' | 'confidential'
}

export function isSkillOfferable(
  gov: SkillGovernance,
  viewer: SkillOfferableViewer,
): boolean {
  return SENSITIVITY_RANK[gov.sensitivity] <= SENSITIVITY_RANK[viewer.assistantClearance]
}

type InjectSkillsOptions = {
  skillStore: SkillStore
  connectorUserId: string
  assistantId: string
  /**
   * Acting assistant's clearance ceiling (`assistants.clearance`). Drives the
   * use-time clearance gate (`isSkillOfferable`): a workspace skill whose
   * sensitivity outranks this is never offered. Defaults to `'confidential'`
   * (the assistants-table default — fails safe to the most permissive viewer)
   * only when the caller cannot resolve it; callers should thread the real
   * `assistant.clearance` through.
   */
  assistantClearance?: 'public' | 'internal' | 'confidential'
  tools: Map<string, Tool>
  connectorStore?: ConnectorStore
  unavailableCapabilities: string[]
  communitySkills?: import('@sidanclaw/core').SkillContent[]
  channel: string
  /**
   * Assistant kind + app_type. Used to filter built-in skills with an
   * `applies_to_app_type` constraint (e.g. distribution-only skills like
   * voice import are hidden on standard assistants).
   */
  assistantKind?: 'standard' | 'app' | 'primary'
  assistantAppType?: 'distribution' | 'doc' | null
  /**
   * CL-8 invocation tracking (optional). When `workspaceSkillStore` and
   * `workspaceId` are both set, `injectSkills` builds a slug → row-id map
   * for the workspace's DB-backed skills and wires the `useSkill` tool's
   * `recordInvocation` callback to:
   *
   *   1. Synchronously bump `invocations` + `last_invoked_at` (and
   *      reactivate stale → active) via
   *      `WorkspaceSkillStore.recordInvocation`.
   *   2. Push the resolved row id into `invocationBuffer` so the chat
   *      route can bump `succeeded` post-commit.
   *
   * Built-in skills (no `workspace_skills` row) are filtered at this
   * layer — their slugs never land in the map and the callback no-ops.
   * Counter errors are logged but never thrown — feedback bookkeeping
   * must not break the runtime path.
   */
  workspaceSkillStore?: WorkspaceSkillStore
  /**
   * S14 per-assistant enablement for workspace / auto-generated skills
   * (`workspace_skill_enablement`, UUID FK). When present, a workspace skill
   * enabled for this assistant here surfaces to the model even without a
   * legacy slug-keyed `assistant_skill_settings` row — this is the read side
   * that the skill-approval enable-for-originating write feeds.
   */
  workspaceSkillEnablementStore?: import('../db/workspace-skill-enablement-store.js').WorkspaceSkillEnablementStore
  /**
   * Backs load-time `{{kind:name}}` pointer expansion: when set, `useSkill`
   * substitutes a workspace skill's reference/template/script pointers with
   * the file content (looked up by the skill's row UUID) before handing the
   * body to the model. Built-in skills (no row id) pass through unchanged.
   */
  workspaceSkillFilesStore?: import('../db/workspace-skill-files-store.js').WorkspaceSkillFilesStore
  workspaceId?: string
  invocationBuffer?: import('@sidanclaw/core').SkillInvocationBuffer
  /**
   * Optional slug allow-list. When non-empty, only skills whose `id`/slug is
   * in this set are offered — the governance gates still apply on top. Used by
   * a workflow `assistant_call` step's `skills` field to pin the exact skills
   * that step may use. `undefined` → offer every governance-passing skill
   * (chat). An empty array `[]` → offer NOTHING (an explicit empty allow-list;
   * used by a workflow step that only enforces skills and offers none).
   */
  restrictToSlugs?: string[]
  /**
   * Optional list of slugs to ENFORCE. Each governance-passing enforced skill's
   * instructions are loaded (with pointer expansion) and returned in
   * `enforcedPromptFragment` for the caller to inject as mandatory system-prompt
   * instructions — the model runs them regardless of choice. Independent of
   * `restrictToSlugs` (enforcement is not gated by the discovery allow-list),
   * but the same enablement / clearance / app_type / connector gates apply, so
   * an unentitled slug is dropped. An enforced slug is excluded from the
   * discovery listing so it is never double-surfaced. Used by a workflow
   * `assistant_call` step's `enforcedSkills` field.
   */
  enforceSlugs?: string[]
}

type InjectSkillsResult = {
  /** System prompt fragment listing offered (discovery) skills — empty if none. */
  promptFragment: string
  /**
   * System-prompt fragment carrying the full instructions of every enforced
   * skill under a `# Required Skills` block — empty string when no enforced
   * skill resolved. The caller appends it to the callee system prompt.
   */
  enforcedPromptFragment: string
}

/**
 * Load, filter, and inject skills into the tool set and system prompt.
 *
 * Handles built-in, community, and user skills. Built-in skills are
 * enabled by default; community/user skills require explicit opt-in
 * via assistant skill settings.
 */
export async function injectSkills(opts: InjectSkillsOptions): Promise<InjectSkillsResult> {
  const { skillStore, connectorUserId, assistantId, tools, connectorStore, unavailableCapabilities, communitySkills, channel } = opts

  // Use-time clearance gate viewer. Clearance defaults to the
  // assistants-table default ('confidential') when the caller couldn't resolve
  // it, so the gate fails safe (most permissive) rather than silently hiding
  // every workspace skill.
  const viewer: SkillOfferableViewer = {
    assistantClearance: opts.assistantClearance ?? 'confidential',
  }

  // CL-8: slug → workspace_skills.id map. Populated when we have a
  // workspace store + id; built-in skills (loaded from disk) are
  // intentionally absent because they have no DB row.
  const slugToRowId = new Map<string, string>()

  // Clearance lookup, keyed by slug (the `SkillContent.id` the gate
  // compares against). Built-in skills are absent here; the gate treats a
  // missing entry as 'public' so they're never gated out.
  const slugToGovernance = new Map<string, SkillGovernance>()

  try {
    const builtinSkills = loadBuiltinSkills()
    // Workspace-scoped skills (the assistant's workspace). This replaces the
    // legacy `listOwned(connectorUserId)`, which resolved the OWNER's personal
    // workspace and leaked owner-personal skills into shared-workspace members'
    // turns (incident 2026-06-01). For a workspace-bound assistant we pin
    // `opts.workspaceId`; only legacy workspace-less assistants fall back to the
    // caller's own skills. Per-assistant enablement (`enabledSlugs`) still gates
    // which are offered.
    const [userSkills, assistantSkillSettings, workspaceEnablement] = await Promise.all([
      opts.workspaceId
        ? skillStore.listForWorkspaceContent(opts.workspaceId, connectorUserId)
        : skillStore.listOwned(connectorUserId),
      skillStore.listForAssistant(assistantId),
      // S14: per-assistant enablement for workspace / auto-gen skills (UUID FK).
      // This is the read side of the skill-approval enable-for-originating
      // write — without it, an approved auto-gen skill is invisible to the
      // model because the legacy gate only consults the slug-keyed table.
      opts.workspaceSkillEnablementStore && opts.workspaceId
        ? opts.workspaceSkillEnablementStore.listForAssistant(assistantId, {
            actingUserId: connectorUserId,
          })
        : Promise.resolve([] as Array<{ workspaceSkillId: string }>),
    ])

    // Best-effort: build the slug→rowId map from the workspace skill
    // surface. Failure here only disables CL-8 tracking — listing and
    // tool injection still work via the legacy path above. Auto-gen
    // skills surface here as `source='auto-generated'` rows; the
    // counter still needs to fire for them.
    const rowIdToSlug = new Map<string, string>()
    if (opts.workspaceSkillStore && opts.workspaceId) {
      try {
        const workspaceSkills = await opts.workspaceSkillStore.listForWorkspace(
          opts.workspaceId,
        )
        for (const ws of workspaceSkills) {
          slugToRowId.set(ws.slug, ws.rowId)
          rowIdToSlug.set(ws.rowId, ws.slug)
          // Clearance field carried on the WorkspaceSkill view. Offering
          // scope (incl. the suggested-skill proposer default) lives in the
          // enablement allowlist — see isSkillOfferable's doc comment.
          slugToGovernance.set(ws.slug, { sensitivity: ws.sensitivity })
        }
      } catch (err) {
        console.error(`[${channel}] CL-8 slug map build failed:`, err)
      }
    }
    // S14 enablement, projected from row UUID to slug (the key the gate below
    // compares against `SkillContent.id`). A workspace skill enabled for this
    // assistant via `workspace_skill_enablement` becomes available even with
    // no legacy `assistant_skill_settings` row.
    const workspaceEnabledSlugs = new Set<string>()
    for (const e of workspaceEnablement) {
      const slug = rowIdToSlug.get(e.workspaceSkillId)
      if (slug) workspaceEnabledSlugs.add(slug)
    }
    const disabledSlugs = new Set(
      assistantSkillSettings.filter((s: { enabled: boolean }) => !s.enabled).map((s: { skillId: string }) => s.skillId),
    )

    // NOTE (residual of the 2026-06-01 connector-scoping fix): the skill
    // *listing* above is now workspace-scoped, but this connector-availability
    // gate still lists `connectorUserId`'s personal connectors — for a shared
    // workspace that is the OWNER. `injectMcpTools` already suppresses the
    // owner's personal connector *tools* for shared workspaces, so a
    // connector-gated skill surfaced here would be offered without working
    // tools, and the set leaks which providers the owner has connected. The
    // correct fix derives the connected set from `resolveConnectorInstances`
    // (team-native + grants), which needs the connectorInstance/grant stores
    // threaded into injectSkills — tracked as Stage-5 cleanup. No data access
    // (the tools aren't injected); only skill *availability* may over-report.
    const connectedIds = new Set<string>()
    if (connectorStore) {
      const connectors = await connectorStore.list(connectorUserId)
      for (const c of connectors) {
        if (c.connected) connectedIds.add(c.connectorId)
      }
    }

    const enabledSlugs = new Set(
      assistantSkillSettings.filter((s: { enabled: boolean }) => s.enabled).map((s: { skillId: string }) => s.skillId),
    )
    const allSkills = [...builtinSkills, ...(communitySkills ?? []), ...userSkills]
    const matchesAppType = (s: { appliesToAppType?: string }): boolean => {
      if (!s.appliesToAppType) return true
      return opts.assistantAppType === s.appliesToAppType
    }
    const isEnabled = (s: { id: string; source: string }): boolean =>
      s.source === 'builtin' || enabledSlugs.has(s.id) || workspaceEnabledSlugs.has(s.id)
    // Use-time clearance gate. Built-in skills have no `workspace_skills`
    // row — treat them as 'public' so they're never gated out.
    const isOfferable = (s: { id: string }): boolean => {
      const gov = slugToGovernance.get(s.id) ?? { sensitivity: 'public' as const }
      return isSkillOfferable(gov, viewer)
    }
    // Shared governance predicate — enablement + app_type + clearance +
    // required-connector gates. Both the discovery listing and the enforced
    // set pass through this, so a workflow step can never surface (offer OR
    // enforce) a skill the assistant is not entitled to.
    const passesGovernance = (s: { id: string; source: string; appliesToAppType?: string; requiresConnectors: string[] }): boolean => {
      if (disabledSlugs.has(s.id)) return false
      if (!isEnabled(s)) return false
      if (!matchesAppType(s)) return false
      if (!isOfferable(s)) return false
      return s.requiresConnectors.every((c) => connectedIds.has(c))
    }

    // Discovery allow-list (workflow `assistant_call.skills`). `undefined` →
    // offer every governance-passing skill (chat). `[]` → offer NOTHING (an
    // explicit empty allow-list — a step that only enforces). `[slugs]` → those.
    const restrictSet = opts.restrictToSlugs === undefined ? null : new Set(opts.restrictToSlugs)
    const isInScope = (s: { id: string }): boolean => (restrictSet === null ? true : restrictSet.has(s.id))
    // Enforced set (workflow `assistant_call.enforcedSkills`) — forced to run,
    // injected as instructions rather than offered. Independent of the
    // discovery allow-list; the governance gates still apply.
    const enforceSet = opts.enforceSlugs && opts.enforceSlugs.length > 0 ? new Set(opts.enforceSlugs) : null

    // Discovery set: governance-passing ∩ allow-list, MINUS anything enforced
    // (an enforced skill is already active — never double-surface it via useSkill).
    const availableSkills = allSkills.filter(
      (s) => passesGovernance(s) && isInScope(s) && !enforceSet?.has(s.id),
    )

    for (const s of allSkills) {
      if (disabledSlugs.has(s.id)) continue
      // A skill outside the caller's allow-list is not "unavailable" — it was
      // simply never requested by this step; don't surface it in the prompt.
      if (!isInScope(s)) continue
      if (enforceSet?.has(s.id)) continue // enforced, not a discovery candidate
      if (!isEnabled(s)) continue
      // Skills constrained to a different app_type are not "unavailable" —
      // they're irrelevant for this assistant. Skip surfacing them in the
      // unavailable list so we don't pollute the prompt for personal
      // assistants with "voice-import skill (requires: ...)".
      if (!matchesAppType(s)) continue
      // A skill gated out by clearance / activation scope (§5.5) is not
      // "unavailable" either — it must not even be named to an under-cleared
      // or non-originating assistant.
      if (!isOfferable(s)) continue
      const missing = s.requiresConnectors.filter((c) => !connectedIds.has(c))
      if (missing.length > 0) {
        unavailableCapabilities.push(`${s.name} skill (requires: ${missing.join(', ')})`)
      }
    }

    // CL-8: fire-and-forget counter bump (invocations + last_invoked_at, stale
    // → active reactivation) + post-commit `succeeded` queue. No-ops for
    // built-in skills (absent from `slugToRowId`). Hoisted so BOTH the
    // discovery `useSkill` path and the enforced-skill injection use it — an
    // enforced skill is genuinely run, so it counts as an invocation.
    const recordInvocation = (slug: string) => {
      const rowId = slugToRowId.get(slug)
      if (!rowId) return // built-in or unmapped slug — nothing to record
      if (opts.workspaceSkillStore) {
        opts.workspaceSkillStore.recordInvocation(rowId).catch((err) => {
          console.warn(`[${channel}] CL-8 recordInvocation failed:`, err)
        })
      }
      opts.invocationBuffer?.addInvocation(rowId)
    }

    // Load-time `{{kind:name}}` pointer expansion: resolve the skill's row UUID
    // (built-ins are absent → pass through) and substitute support-file
    // pointers from `workspace_skill_files`. Shared by discovery + enforcement.
    const filesStore = opts.workspaceSkillFilesStore
    const expandContent = filesStore
      ? async (skill: SkillContent): Promise<string> => {
          const rowId = slugToRowId.get(skill.id)
          if (!rowId) return skill.content
          const expanded = await expandSkillPointers(skill, rowId, filesStore)
          return expanded.content
        }
      : undefined

    let promptFragment = ''
    const listing = formatSkillListing(availableSkills)
    if (listing) {
      promptFragment = `\n\n# Available Skills\nUse the useSkill tool to activate a skill when relevant.\nBefore answering what sidanclaw (or you) can do, or how a feature works, activate the most relevant skill FIRST and answer only from it.\n${listing}`
    }

    if (availableSkills.length > 0) {
      tools.set(
        'useSkill',
        createUseSkillTool({
          getAvailableSkills: () => availableSkills,
          recordInvocation,
          expandContent,
        }),
      )
    }

    // Enforced skills — inject the full (pointer-expanded) instructions as a
    // mandatory system-prompt block. Each enforced slug that passes governance
    // is loaded, counted as an invocation (it IS being run), and concatenated
    // under `# Required Skills`. An expansion failure falls back to raw content
    // (must never drop a mandatory instruction). A slug that fails governance
    // is silently skipped — a workflow step cannot escalate.
    let enforcedPromptFragment = ''
    if (enforceSet) {
      const enforcedSkills = allSkills.filter((s) => enforceSet.has(s.id) && passesGovernance(s))
      const sections: string[] = []
      for (const skill of enforcedSkills) {
        let instructions = skill.content
        if (expandContent) {
          try {
            instructions = await expandContent(skill)
          } catch {
            instructions = skill.content
          }
        }
        recordInvocation(skill.id)
        sections.push(`## ${skill.name}\n${instructions}`)
      }
      if (sections.length > 0) {
        enforcedPromptFragment = `\n\n# Required Skills\nThe skill instructions below are mandatory for this task. Follow each of them in full — they are not optional, and apply in addition to any skill you activate yourself.\n\n${sections.join('\n\n')}`
      }
    }

    return { promptFragment, enforcedPromptFragment }
  } catch (err) {
    console.error(`[${channel}] skill injection failed:`, err)
    return { promptFragment: '', enforcedPromptFragment: '' }
  }
}

// ── File → content block builder ─────────────────────────────

/**
 * A file to be converted into content blocks for the LLM.
 * Used by both web chat (from fileStore) and messaging channels (from raw media).
 */
export type FileInput = {
  /** Optional file ID (for fileStore references). */
  id?: string
  fileName: string
  mimeType: string
  /** Raw file content as a Buffer. For images, will be base64-encoded into an image block. */
  buffer: Buffer
}

export type FileContentBlocksResult = {
  /** Image blocks and tool_result blocks to prepend before the text block. */
  contentBlocks: ContentBlock[]
  /** Text context describing attached files (inlined text, file references). */
  attachmentContext: string
}

/**
 * Build content blocks from file data. Shared across web chat and messaging channels.
 *
 * - Images + PDFs → multimodal `image` content block (Gemini `inlineData`)
 * - Text/JSON/CSV (small) → inlined as <attached_file> text
 * - Large files → durable artifact manifest when `promoteArtifact` is wired
 *   (large-content-artifacts §Phase 2.3); else cached in fileStore (if
 *   provided) with a readFileContent reference; else the 20K truncation
 *   fallback.
 *
 * @param files - Array of file inputs to process
 * @param fileStore - Optional file store for caching large files
 * @param sessionId - Required if fileStore is provided (for caching)
 * @param promoteArtifact - Optional workspace-bound promotion closure: a large
 *   text-like file is written to workspace_files + chunked, and the turn
 *   carries the artifact manifest instead of losing everything past 20K chars.
 */
export async function buildFileContentBlocks(
  files: FileInput[],
  fileStore?: FileStore,
  sessionId?: string,
  promoteArtifact?: (input: {
    fileName: string
    mime: string
    bytes: Buffer
    parsedText: string
  }) => Promise<{ fileId: string; path: string; status: 'ready' | 'pending'; segmentCount: number; truncated: boolean } | null>,
): Promise<FileContentBlocksResult> {
  const contentBlocks: ContentBlock[] = []
  const textParts: string[] = []

  for (const file of files) {
    const isImage = file.mimeType.startsWith('image/')
    const isPdf = file.mimeType === 'application/pdf'

    if (isImage || isPdf) {
      // Images + PDFs share the `inlineData` path — Gemini reads both natively.
      const base64Data = file.buffer.toString('base64')
      contentBlocks.push({
        type: 'image',
        mimeType: file.mimeType,
        data: base64Data,
      })
      if (file.id) {
        textParts.push(
          `<attached_file id="${file.id}" name="${file.fileName}" type="${file.mimeType}">[${isPdf ? 'pdf' : 'image'}]</attached_file>`,
        )
      }
    } else {
      const { text } = await parseFileContent(file.buffer, file.mimeType, file.fileName)
      const isSmall = shouldInline(text)

      if (isSmall) {
        textParts.push(
          `<attached_file${file.id ? ` id="${file.id}"` : ''} name="${file.fileName}" type="${file.mimeType}">\n${text}\n</attached_file>`,
        )
      } else if (promoteArtifact) {
        // Durable artifact path (large-content-artifacts §Phase 2.3): the file
        // is written to workspace_files + chunked into file_segments, and the
        // turn carries a manifest. Falls through to the legacy paths on a
        // promotion failure — never drops the attachment.
        const promoted = await promoteArtifact({
          fileName: file.fileName,
          mime: file.mimeType,
          bytes: file.buffer,
          parsedText: text,
        }).catch(() => null)
        if (promoted) {
          textParts.push(
            renderArtifactManifest({
              fileId: promoted.fileId,
              fileName: file.fileName,
              mime: file.mimeType,
              sizeBytes: file.buffer.length,
              charLength: text.length,
              segmentCount: promoted.segmentCount,
              status: promoted.status,
              truncated: promoted.truncated,
            }),
          )
        } else if (fileStore && sessionId) {
          const cached = await fileStore.cache({
            sessionId,
            fileName: file.fileName,
            mimeType: file.mimeType,
            content: text,
            sizeBytes: file.buffer.length,
          })
          textParts.push(
            `<attached_file id="${cached.id}" name="${file.fileName}" type="${file.mimeType}">[Large file. Use readFileContent with fileId="${cached.id}" to retrieve full content.]</attached_file>`,
          )
        } else {
          const truncated = text.length > 20000 ? text.slice(0, 20000) + '\n... [truncated]' : text
          textParts.push(
            `<attached_file${file.id ? ` id="${file.id}"` : ''} name="${file.fileName}" type="${file.mimeType}">\n${truncated}\n</attached_file>`,
          )
        }
      } else if (fileStore && sessionId) {
        // Cache large files for on-demand retrieval via readFileContent tool
        const cached = await fileStore.cache({
          sessionId,
          fileName: file.fileName,
          mimeType: file.mimeType,
          content: text,
          sizeBytes: file.buffer.length,
        })
        textParts.push(
          `<attached_file id="${cached.id}" name="${file.fileName}" type="${file.mimeType}">[Large file. Use readFileContent with fileId="${cached.id}" to retrieve full content.]</attached_file>`,
        )
      } else {
        // No fileStore — inline a truncated version
        const truncated = text.length > 20000 ? text.slice(0, 20000) + '\n... [truncated]' : text
        textParts.push(
          `<attached_file${file.id ? ` id="${file.id}"` : ''} name="${file.fileName}" type="${file.mimeType}">\n${truncated}\n</attached_file>`,
        )
      }
    }
  }

  return {
    contentBlocks,
    attachmentContext: textParts.length > 0 ? textParts.join('\n\n') + '\n\n' : '',
  }
}
