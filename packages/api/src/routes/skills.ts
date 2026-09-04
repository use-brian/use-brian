/**
 * Skill management routes.
 *
 * Mounted at `/api/skills` behind requireAuth.
 *
 * [COMP:api/skills-route]
 *
 *   GET    /catalog              — community catalog (published skills)
 *   GET    /mine                 — user's own skills
 *   GET    /workspace?workspaceId — governance-aware workspace skill list (Brain)
 *   POST   /                    — create a skill (workspace-aware when `workspaceId`
 *                                  in body; writes D4 default enablement rows;
 *                                  accepts imported `supportFiles` + `importSource`)
 *   POST   /import              — parse a skill file from GitHub / a public URL
 *                                  into a draft (parse-only, no DB write)
 *   GET    /import/github/instances — usable GitHub connectors (import picker)
 *   GET    /import/github/repos     — repos reachable by an instance's PAT
 *   GET    /import/github/contents  — one directory level of a repo
 *   PATCH  /:id                 — update a skill (D2: name/body edits carry the
 *                                  confirm-grade trust stamp; accepts `sensitivity`)
 *   DELETE /:id                 — delete a skill
 *   POST   /:id/confirm         — human-confirm a suggested skill → active (Brain trust loop)
 *   GET    /:id/access          — skill-centric per-assistant enablement (Access tab)
 *   PUT    /:id/access          — set the enabled-assistant set for a skill
 *   GET    /catalog/:slug        — one template's full content (creator's
 *                                  instant template load)
 *   POST   /catalog/:slug/install — materialize a brian-tools bundle into a workspace
 *   POST   /draft               — one conversational draft turn: transcript +
 *                                  live draft in, revised draft or reply out
 *                                  (brain-skill-management plan §3.2/D3 as
 *                                  amended for chat iteration; model tier +
 *                                  research + attachments)
 *   POST   /:id/publish         — publish to community
 *   POST   /:id/unpublish       — unpublish
 *   POST   /:id/star            — star (user-level UX preference; no runtime effect)
 *   POST   /:id/unstar          — unstar
 */

import { Router } from 'express'
import { z } from 'zod'
import { query } from '../db/client.js'
import {
  loadBuiltinSkills,
  createRateLimiter,
  shouldInline,
  extractionSpecSchema,
  extractionSpecToBlocks,
  transcribeFirstAudio,
  voiceUnavailableNote,
  TRANSCRIPTION_DISABLED_REASON,
} from '@use-brian/core'
import type {
  SkillContent,
  LLMProvider,
  FileStore,
  ContentBlock,
  PreflightOptions,
} from '@use-brian/core'
import type { SkillStore, WorkspaceSkillStore, WorkspaceSkill } from '../db/skill-store.js'
import type { PageTemplateStore } from '../db/page-templates-store.js'
import { getWorkspacePlan as getWorkspacePlanDb, type WorkspaceStore } from '../db/workspace-store.js'
import type { WorkspaceSkillEnablementStore } from '../db/workspace-skill-enablement-store.js'
import { materialiseAllAssistants } from '../skills/all-assistants.js'

// The real DB-backed credit gate (`checkCreditBudget`, closed `billing/`) is
// injected by the platform via the `checkUsageBudget` option; the open build
// falls through to `allowAllBudget` below (billing-out = don't-wire, §12.3).
const allowAllBudget = async (): Promise<{ status: 'ok' | 'downgraded' | 'blocked' }> => ({
  status: 'ok',
})
import { resolveModel, tierForModel } from '../model-resolution.js'
import {
  generateSkillDraft,
  SkillDraftError,
  type SkillDraftAttachments,
  type SkillDraftContext,
  type SkillDraftTemplate,
} from '../skills/draft-generator.js'
import {
  importSkillFromGithub,
  importSkillFromPaste,
  importSkillFromUrl,
  SkillImportError,
  IMPORT_MAX_FILE_BYTES,
  type GithubContentsReader,
} from '../skills/import-service.js'
import { normalizeSkillGroup } from '@use-brian/shared/skill-groups'
import {
  existingGroupsOf,
  selectCategorizableSkills,
  suggestSkillCategories,
  type CategorizeScope,
} from '../skills/categorize.js'
import {
  validateSupportFile,
  validateSupportFileSet,
  SUPPORT_FILE_KINDS,
  SUPPORT_FILE_NAME_MAX,
  type SupportFile,
} from '../skills/support-files.js'
import type { RawImportFetcher } from '../skills/import-source.js'
import {
  listWorkspaceGithubInstances,
  resolveWorkspaceGithubPat,
} from './knowledge.js'
import { getFileContents, listAffiliatedRepos } from '../github/client.js'
import type { ConnectorInstanceStore } from '../db/connector-instance-store.js'
import type { ConnectorGrantStore } from '../db/connector-grant-store.js'
import type { WorkspaceSkillFilesStore } from '../db/workspace-skill-files-store.js'

const SENSITIVITIES = new Set(['public', 'internal', 'confidential'])

type SkillRouteOptions = {
  skillStore: SkillStore
  syncNativeSlashCommands?: (userId: string, workspaceId: string) => Promise<void>
  communityRegistry?: SkillContent[]
  /**
   * V2 workspace-aware store — backs the Brain procedural-primitive surface
   * (`docs/architecture/engine/skill-system.md` §5, §7.1): the
   * governance-aware workspace skill list and the human-confirmation trust
   * action. Optional so existing call sites / tests that only need the legacy
   * userId-keyed catalog continue to mount without it.
   */
  workspaceSkillStore?: WorkspaceSkillStore
  /** Workspace-membership gate for the workspace-scoped Brain endpoints. */
  workspaceStore?: WorkspaceStore
  /** Page-template store — mints + links a v2 blueprint when a saved skill's
   *  draft carries an `extraction` spec (structural-synthesis Phase 2). Optional:
   *  without it a skill with an extraction spec still saves, just unlinked. */
  pageTemplateStore?: PageTemplateStore
  /**
   * Per-assistant enablement (brain-skill-management plan §4) — backs the D4
   * all-assistants default at create and the skill-centric Access endpoints.
   */
  workspaceSkillEnablementStore?: WorkspaceSkillEnablementStore
  /** Assistants the user can reach in a workspace (id + name) — injected so
   *  tests stub it instead of the users-store SQL. */
  listWorkspaceAssistants?: (
    userId: string,
    workspaceId: string,
  ) => Promise<Array<{ id: string; name: string }>>
  /** LLM provider for POST /draft. Absent → the draft endpoint returns 503
   *  (mirrors `doc-themes`'s provider gating). */
  draftProvider?: LLMProvider
  /** Workspace-owned text runtime, resolved after membership at call time. */
  resolveWorkspaceCustomLlm?: import('../custom-llm-runtime.js').WorkspaceCustomLlmResolver
  /** Workspace grounding for the draft agent (`skills/draft-context.ts`) —
   *  injected so tests stub the RLS reads. */
  getDraftContext?: (userId: string, workspaceId: string) => Promise<SkillDraftContext>
  /** Override for tests — defaults to 20 drafts/user/hour (plan §10). */
  draftRateLimiter?: ReturnType<typeof createRateLimiter>
  /** Override for tests — defaults to 10 research turns/user/hour (research
   *  turns also burn search-provider quota on top of the model call). */
  researchRateLimiter?: ReturnType<typeof createRateLimiter>
  /** File cache for draft-turn attachments (`fileIds` on POST /draft).
   *  Absent → attachments are ignored. */
  fileStore?: FileStore
  /** Voice-note transcription for audio `fileIds` on POST /draft. Mirrors the
   *  chat route so the universal dock recorder can target this stateless chat. */
  voiceTranscription?: PreflightOptions
  /** Plan + budget seams for the draft model-tier gate — default to the real
   *  DB-backed implementations (`getWorkspacePlan` / `checkCreditBudget`);
   *  injected by tests. */
  getWorkspacePlan?: (workspaceId: string) => Promise<string>
  checkUsageBudget?: (
    workspaceId: string,
    plan: string,
  ) => Promise<{ status: 'ok' | 'downgraded' | 'blocked' }>
  /**
   * Skill import (skill-system.md → "Importing skills (GitHub / URL)").
   * The connector stores back the GitHub browse endpoints + PAT resolution;
   * absent → those endpoints answer 503 (URL import still works). The files
   * store backs the create-route `supportFiles` extension.
   */
  connectorInstanceStore?: ConnectorInstanceStore
  connectorGrantStore?: ConnectorGrantStore
  workspaceSkillFilesStore?: WorkspaceSkillFilesStore
  /** Test seam — defaults to the allowlisted raw fetcher. */
  fetchRawImport?: RawImportFetcher
  /** Test seam — defaults to the real GitHub client bound to the PAT. */
  githubReaderFor?: (pat: string) => GithubContentsReader
  /** Test seam — defaults to the real repo-listing GitHub call. */
  listReposFor?: (pat: string) => Promise<Array<{
    full_name: string
    name: string
    owner: { login: string }
    private: boolean
    description: string | null
  }>>
}

/** One transcript entry. The endpoint is stateless — the client resends the
 *  whole conversation every turn; the generator trims to a fresh window. */
const draftTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(4000),
})

const draftBodySchema = z.object({
  workspaceId: z.string().trim().min(1),
  /** The drafting conversation, oldest first; the last entry must be `user`.
   *  Reference material is NOT a separate field — pasted text rides inside a
   *  message, documents ride as `fileIds` (the old one-shot `reference` field
   *  was removed as duplicate UX; see plan §11d). */
  messages: z.array(draftTurnSchema).min(1).max(24),
  templateSlug: z.string().trim().max(200).optional(),
  /** The LIVE document state (including the user's hand edits) — the agent
   *  revises from this, never from its own last output. Field caps are
   *  lenient vs the save caps so an over-limit document can still be sent
   *  to the agent to shorten. */
  currentDraft: z
    .object({
      name: z.string().max(120),
      description: z.string().max(300),
      whenToUse: z.string().max(1000),
      content: z.string().max(6000),
      sensitivity: z.enum(['public', 'internal', 'confidential']),
    })
    .optional(),
  /** Model tier alias — resolved via `resolveModel` (plan-gated, silent
   *  downgrade like /api/chat). */
  model: z.enum(['standard', 'pro', 'max']).optional(),
  /** Arm webSearch/urlReader grounding for this turn. */
  research: z.boolean().optional(),
  /** Uploaded attachment ids (POST /api/files/upload) for the latest turn. */
  fileIds: z.array(z.string().trim().min(1)).max(10).optional(),
})

function toMeta(s: SkillContent) {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    whenToUse: s.whenToUse,
    category: s.category,
    requiresConnectors: s.requiresConnectors,
    source: s.source,
    authorName: s.authorName,
    bundleVersion: s.bundleVersion ?? 1,
    resourceCount: s.resources?.length ?? 0,
    sourceDigest: s.sourceDigest ?? null,
  }
}

export function skillRoutes({
  skillStore,
  communityRegistry = [],
  workspaceSkillStore,
  workspaceStore,
  pageTemplateStore,
  workspaceSkillEnablementStore,
  listWorkspaceAssistants,
  draftProvider,
  resolveWorkspaceCustomLlm,
  getDraftContext,
  draftRateLimiter,
  researchRateLimiter,
  fileStore,
  voiceTranscription,
  getWorkspacePlan = getWorkspacePlanDb,
  checkUsageBudget = allowAllBudget,
  connectorInstanceStore,
  connectorGrantStore,
  workspaceSkillFilesStore,
  fetchRawImport,
  syncNativeSlashCommands,
  githubReaderFor = (pat) => ({
    getFileContents: (owner, repo, path, ref) => getFileContents(pat, owner, repo, path, ref),
  }),
  listReposFor = (pat) => listAffiliatedRepos(pat),
}: SkillRouteOptions): Router {
  const router = Router()
  const refreshNativeCommands = (userId: string, workspaceId: string) => {
    void syncNativeSlashCommands?.(userId, workspaceId).catch((err) =>
      console.warn('[skills] native command sync failed:', err))
  }
  // One model call per draft turn — keep a per-user lid on it (plan §10).
  // In-memory is fine: the limit is an abuse backstop, not a billing meter,
  // and the route runs single-service.
  const draftLimiter = draftRateLimiter ?? createRateLimiter({ maxRequests: 20, windowMs: 3600_000 })
  // Research turns additionally burn search-provider quota — tighter sub-lid.
  const researchLimiter =
    researchRateLimiter ?? createRateLimiter({ maxRequests: 10, windowMs: 3600_000 })

  /**
   * The assistants a skill is currently offered to, as the client should render
   * them.
   *
   * Two representations answer this question (mig 492) and only one of them is
   * rows: an `all_assistants` skill is offered to every assistant in the
   * workspace and carries no `workspace_skill_enablement` row at all. Reading
   * the allowlist alone therefore reports the most-shared skills in the
   * workspace as shared with nobody — every toggle off, in a panel whose whole
   * job is to show who has it.
   *
   * Falls back to the raw rows when the workspace assistant list is
   * unavailable (minimal mounts / tests), which is the pre-445 answer.
   */
  async function resolveEnabledAssistantIds(
    userId: string,
    skill: WorkspaceSkill,
  ): Promise<string[]> {
    if (skill.allAssistants && listWorkspaceAssistants) {
      const assistants = await listWorkspaceAssistants(userId, skill.workspaceId)
      return assistants.map((a) => a.id)
    }
    if (!workspaceSkillEnablementStore) return []
    const rows = await workspaceSkillEnablementStore.listForSkill(skill.rowId, {
      actingUserId: userId,
    })
    return rows.map((r) => r.assistantId)
  }

  /** Governance-aware wire projection of a workspace skill — shared by the
   *  workspace list, the workspace-aware create response, and the editor. */
  function projectWorkspaceSkill(
    s: WorkspaceSkill,
    enabledAssistantIds: string[],
  ) {
    return {
      rowId: s.rowId,
      slug: s.slug,
      name: s.name,
      description: s.description,
      whenToUse: s.whenToUse ?? null,
      content: s.content,
      // The library groups on this; without it every skill reads as "custom".
      category: s.category,
      state: s.state,
      confidence: s.confidence,
      activatedAt: s.activatedAt ? s.activatedAt.toISOString() : null,
      inductionSource: s.inductionSource,
      sensitivity: s.sensitivity,
      sensitivityOverridden: s.sensitivityOverridden,
      originatingAssistantId: s.originatingAssistantId ?? null,
      verifiedByUserId: s.verifiedByUserId ?? null,
      verifiedAt: s.verifiedAt ? s.verifiedAt.toISOString() : null,
      rederivationCount: s.rederivationCount,
      requiresConnectors: s.requiresConnectors,
      blueprintId: s.blueprintId ?? null,
      // Library columns + governance panel (brain-skill-management plan §4).
      // `enabledAssistantIds` is the RESOLVED set the client renders as
      // toggles: for an `allAssistants` skill it is every assistant in the
      // workspace, even though no enablement row exists for any of them.
      // `allAssistants` rides alongside so the editor can tell "everyone,
      // including future assistants" from "everyone who happens to exist" —
      // the two look identical in the id list and behave differently the
      // moment another assistant is created (mig 492).
      enabledAssistantIds,
      allAssistants: s.allAssistants,
      lastInvokedAt: s.lastInvokedAt ? s.lastInvokedAt.toISOString() : null,
      invocations: s.invocations,
      succeeded: s.succeeded,
      userCorrectedAfter: s.userCorrectedAfter,
      bundleVersion: s.bundleVersion ?? 1,
      sourceDigest: s.sourceDigest ?? null,
    }
  }

  // ── GET /catalog — builtin + registry + user-published skills ──

  router.get('/catalog', async (req, res) => {
    try {
      const userId = req.userId
      const builtin = loadBuiltinSkills().map(toMeta)
      const community = communityRegistry.map(toMeta)
      // DB query may fail if migration hasn't run yet — gracefully degrade
      let userPublished: Array<Record<string, unknown>> = []
      try {
        userPublished = (await skillStore.listPublished()) as Array<Record<string, unknown>>
      } catch {}
      let starred = new Set<string>()
      if (userId) {
        try {
          starred = new Set(await skillStore.listStarred(userId))
        } catch {}
      }
      // Merge: builtin + community registry (from SKILL.md) + user-published (from DB)
      const registryIds = new Set([...builtin.map((s) => s.id), ...community.map((s) => s.id)])
      const deduped = userPublished.filter((s) => !registryIds.has(s.id as string))
      const merged = [...builtin, ...community, ...deduped]
      res.json({
        skills: merged.map((s) => ({ ...s, starred: starred.has((s as { id: string }).id) })),
      })
    } catch (err) {
      console.error('[skills] catalog failed:', err)
      res.status(500).json({ error: 'Failed to load skill catalog' })
    }
  })

  // ── GET /catalog/:slug — one template's FULL content ─────────
  //
  // The creator's instant template load (brain-skill-management plan §3.2 as
  // amended): picking a template shows the entire skill in the document view
  // with no model call. The list endpoint stays metadata-only; this is the
  // single-row detail. Resolution chain mirrors POST /draft: builtin →
  // community registry → user-published.

  router.get('/catalog/:slug', async (req, res) => {
    try {
      const slug = req.params.slug
      const fromRegistry =
        loadBuiltinSkills().find((s) => s.id === slug) ??
        communityRegistry.find((s) => s.id === slug)
      const resolved = fromRegistry ?? (await skillStore.getBySlug(slug).catch(() => null))
      if (!resolved) {
        res.status(404).json({ error: 'Template skill not found' }); return
      }
      const s = resolved as {
        id?: string
        name: string
        description?: string
        whenToUse?: string | null
        content: string
        category?: string
        requiresConnectors?: string[]
        source?: string
        authorName?: string
        bundleVersion?: 1 | 2
        resources?: SkillContent['resources']
        sourceDigest?: string
        bundleSource?: SkillContent['bundleSource']
      }
      res.json({
        skill: {
          id: s.id ?? slug,
          name: s.name,
          description: s.description ?? '',
          whenToUse: s.whenToUse ?? null,
          content: s.content,
          category: normalizeSkillGroup(s.category),
          requiresConnectors: s.requiresConnectors ?? [],
          source: s.source ?? 'community',
          authorName: s.authorName,
          bundleVersion: s.bundleVersion ?? 1,
          sourceDigest: s.sourceDigest ?? null,
          bundleSource: s.bundleSource ?? null,
          supportFiles: (s.resources ?? []).map((resource) => ({
            kind: resource.kind,
            name: resource.name,
            path: resource.path,
            content: resource.content,
            description: resource.description ?? null,
            contentHash: resource.contentHash,
          })),
        },
      })
    } catch (err) {
      console.error('[skills] catalog detail failed:', err)
      res.status(500).json({ error: 'Failed to load template skill' })
    }
  })

  // ── POST /catalog/:slug/install — native brian-tools install ─────
  //
  // Catalog entries are immutable templates. Installation copies the entire
  // bundle into workspace-owned storage so runtime, graph, governance, and
  // later user edits all use the same path as a GitHub folder import.
  router.post('/catalog/:slug/install', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    if (!workspaceSkillStore || !workspaceStore || !workspaceSkillFilesStore) {
      res.status(501).json({ error: 'Native skill bundle installation is not available' }); return
    }
    const body = z.object({
      workspaceId: z.string().trim().min(1),
      enabledAssistantIds: z.union([z.literal('all'), z.array(z.string().trim().min(1))]).optional(),
      sensitivity: z.enum(['public', 'internal', 'confidential']).optional(),
    }).safeParse(req.body)
    if (!body.success) { res.status(400).json({ error: 'Invalid install request' }); return }
    const { workspaceId } = body.data
    const role = await workspaceStore.getRole(userId, workspaceId)
    if (!role) { res.status(404).json({ error: 'Not found' }); return }

    const template = communityRegistry.find((skill) => skill.id === req.params.slug)
    if (!template) { res.status(404).json({ error: 'Catalog skill not found' }); return }

    // mig 492: an omitted / 'all' request is the intent "every assistant,
    // including ones created later" — stored on the row, not materialised as
    // one enablement row per assistant that happens to exist right now.
    const installWantsAllAssistants =
      body.data.enabledAssistantIds === undefined || body.data.enabledAssistantIds === 'all'

    let installed: WorkspaceSkill | null = null
    try {
      installed = await workspaceSkillStore.create(userId, workspaceId, {
        slug: template.id,
        name: template.name,
        description: template.description,
        whenToUse: template.whenToUse,
        content: template.content,
        category: normalizeSkillGroup(template.category),
        requiresConnectors: template.requiresConnectors,
        allAssistants: installWantsAllAssistants,
        source: 'community',
        inductionSource: 'authored',
        sensitivity: body.data.sensitivity,
        bundleVersion: 2,
        sourceDigest: template.sourceDigest ?? null,
        deferGraphRecompute: true,
        importSource: {
          ...(template.bundleSource ?? { kind: 'brian-tools', path: `skills/${template.id}` }),
          sourceDigest: template.sourceDigest ?? null,
          resourceHashes: Object.fromEntries(
            (template.resources ?? []).map((resource) => [resource.path, resource.contentHash]),
          ),
        },
      })

      for (const resource of template.resources ?? []) {
        await workspaceSkillFilesStore.upsert(userId, {
          workspaceSkillId: installed.rowId,
          kind: resource.kind,
          name: resource.name,
          path: resource.path,
          content: resource.content,
          description: resource.description ?? null,
          contentHash: resource.contentHash,
        }, { notify: false })
      }

      let enabledIds: string[] = []
      if (workspaceSkillEnablementStore && listWorkspaceAssistants) {
        const assistants = await listWorkspaceAssistants(userId, workspaceId)
        const valid = new Set(assistants.map((assistant) => assistant.id))
        const requested = body.data.enabledAssistantIds
        if (requested === undefined || requested === 'all') {
          // mig 492: "all" is an INTENT, so it rides the flag set at INSERT
          // above and writes no rows — otherwise the next assistant created in
          // this workspace would silently not get the skill. The response still
          // lists today's assistants so the client renders every toggle on.
          enabledIds = assistants.map((assistant) => assistant.id)
        } else {
          enabledIds = requested.filter((id) => valid.has(id))
          for (const assistantId of enabledIds) {
            await workspaceSkillEnablementStore.enable(installed.rowId, assistantId, userId)
          }
        }
      }

      workspaceSkillFilesStore.notifyChanged(installed.rowId)

      refreshNativeCommands(userId, workspaceId)
      res.status(201).json(projectWorkspaceSkill(installed, enabledIds))
    } catch (err: any) {
      if (installed) {
        await query('DELETE FROM workspace_skills WHERE id = $1', [installed.rowId]).catch(() => undefined)
      }
      if (err?.code === '23505') {
        res.status(409).json({ error: 'This skill is already installed in the workspace' }); return
      }
      console.error('[skills] catalog install failed:', err)
      res.status(500).json({ error: 'Failed to install the skill bundle' })
    }
  })

  // ── GET /mine — user's own skills ────────────────────────────

  router.get('/mine', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    try {
      const skills = await skillStore.listOwned(userId)
      let starred = new Set<string>()
      try {
        starred = new Set(await skillStore.listStarred(userId))
      } catch {}
      res.json({ skills: skills.map((s) => ({ ...s, starred: starred.has(s.id) })) })
    } catch {
      // Table may not exist yet (migration not run) — return empty
      res.json({ skills: [] })
    }
  })

  // ── GET /workspace — governance-aware workspace skill list (Brain) ──
  //
  // Backs the Brain procedural-primitive surface
  // (`docs/architecture/engine/skill-system.md` §5, §7.1). Returns
  // every non-archived, bi-temporally-alive workspace skill projected with its
  // governance fields (state, confidence, activation, induction source,
  // sensitivity, verifier). Workspace-membership gated.

  router.get('/workspace', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    if (!workspaceSkillStore || !workspaceStore) {
      res.status(501).json({ error: 'Workspace skills are not available' }); return
    }

    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : null
    if (!workspaceId) {
      res.status(400).json({ error: 'workspaceId query param is required' }); return
    }

    const role = await workspaceStore.getRole(userId, workspaceId)
    if (!role) { res.status(404).json({ error: 'Not found' }); return }

    try {
      const skills = await workspaceSkillStore.listForWorkspace(workspaceId, { actingUserId: userId })
      const visible = skills.filter((s) => s.state !== 'archived')
      // One bulk enablement query for the whole library (plan §4).
      const enabledBySkill = new Map<string, string[]>()
      if (workspaceSkillEnablementStore && visible.length > 0) {
        const rows = await workspaceSkillEnablementStore.listForSkillIds(
          visible.map((s) => s.rowId),
          { actingUserId: userId },
        )
        for (const row of rows) {
          const list = enabledBySkill.get(row.workspaceSkillId) ?? []
          list.push(row.assistantId)
          enabledBySkill.set(row.workspaceSkillId, list)
        }
      }
      // mig 492: an `all_assistants` skill carries no rows, so the bulk read
      // above returns nothing for it. Resolve those against the workspace's
      // assistant list once (not per skill) — otherwise the library renders the
      // workspace's most-shared skills with an empty assistant count.
      if (visible.some((s) => s.allAssistants) && listWorkspaceAssistants) {
        const everyAssistantId = (await listWorkspaceAssistants(userId, workspaceId)).map(
          (a) => a.id,
        )
        for (const s of visible) {
          if (s.allAssistants) enabledBySkill.set(s.rowId, everyAssistantId)
        }
      }
      // Origin-aware induction provenance: one bulk read of the ACTIVE
      // skill → workflow `learned_from` edges so the editors can render
      // "distilled from workflow X" / "skills learned from this workflow's
      // runs" from the list they already load. Best-effort — a read failure
      // degrades to no provenance, never a dead listing.
      const learnedFrom = new Map<string, { id: string; name: string }>()
      if (visible.length > 0) {
        try {
          const edges = await query<{
            skill_id: string
            workflow_id: string
            workflow_name: string
          }>(
            `SELECT el.source_id AS skill_id, w.id AS workflow_id, w.name AS workflow_name
             FROM entity_links el
             JOIN workflows w ON w.id = el.target_id
             WHERE el.workspace_id = $1
               AND el.source_kind = 'skill'
               AND el.target_kind = 'workflow'
               AND el.edge_type = 'learned_from'
               AND el.valid_to IS NULL
               AND el.retracted_at IS NULL`,
            [workspaceId],
          )
          for (const row of edges.rows) {
            learnedFrom.set(row.skill_id, { id: row.workflow_id, name: row.workflow_name })
          }
        } catch (err) {
          console.warn('[skills] learned-from-workflow enrichment failed:', err)
        }
      }
      const projected = visible.map((s) => {
        const wf = learnedFrom.get(s.rowId)
        return {
          ...projectWorkspaceSkill(s, enabledBySkill.get(s.rowId) ?? []),
          ...(wf ? { learnedFromWorkflowId: wf.id, learnedFromWorkflowName: wf.name } : {}),
        }
      })
      res.json({ skills: projected })
    } catch (err) {
      console.error('[skills] workspace list failed:', err)
      res.status(500).json({ error: 'Failed to list workspace skills' })
    }
  })

  // ── POST / — create a skill ─────────────────────────────────

  router.post('/', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const {
      name, description, whenToUse, content, category, requiresConnectors,
      workspaceId, enabledAssistantIds, sensitivity, extraction,
      supportFiles, importSource, bundleVersion, sourceDigest,
    } = req.body as {
      name?: string
      description?: string
      whenToUse?: string
      content?: string
      category?: string
      requiresConnectors?: string[]
      /** Workspace-aware create (brain-skill-management plan §4): returns the
       *  governance projection and writes the D4 enablement default. */
      workspaceId?: string
      /** D4 — which assistants the skill is offered to at birth. Defaults to
       *  'all' (every assistant the creator can reach in the workspace);
       *  enablement is an allowlist, so no rows = a dead skill. */
      enabledAssistantIds?: string[] | 'all'
      sensitivity?: string
      /** Structural-synthesis Phase 2: the draft's output shape. Minted into a
       *  linked v2 blueprint when present (validated with extractionSpecSchema). */
      extraction?: unknown
      /** Skill import (skill-system.md → "Importing skills"): folder support
       *  files written to `workspace_skill_files` after the row insert. */
      supportFiles?: Array<{
        kind?: string
        name?: string
        path?: string
        content?: string
        description?: string
        contentHash?: string
      }>
      /** Import provenance blob, stored verbatim on the row (mig 328). */
      importSource?: Record<string, unknown>
      bundleVersion?: 1 | 2
      sourceDigest?: string
    }

    if (!name || typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'Name is required' }); return
    }
    if (!content || typeof content !== 'string' || !content.trim()) {
      res.status(400).json({ error: 'Content is required' }); return
    }
    if (name.length > 100) {
      res.status(400).json({ error: 'Name must be 100 characters or less' }); return
    }
    if (description && description.length > 250) {
      res.status(400).json({ error: 'Description must be 250 characters or less' }); return
    }
    if (content.length > 5000) {
      res.status(400).json({ error: 'Content must be 5000 characters or less' }); return
    }

    // Generate slug from name
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    if (!slug) {
      res.status(400).json({ error: 'Name must contain at least one alphanumeric character' }); return
    }
    if (sensitivity !== undefined && !SENSITIVITIES.has(sensitivity)) {
      res.status(400).json({ error: 'sensitivity must be public, internal, or confidential' }); return
    }

    // Skill-import extension: validate support files up front so a bad batch
    // never leaves a half-written skill (`workspace_skill_files` rows are
    // written after the insert). One validator backs this and the editor's
    // PUT /:id/files, so the two paths cannot drift.
    let validSupportFiles: SupportFile[] = []
    if (supportFiles !== undefined) {
      const checked = validateSupportFileSet(supportFiles)
      if (!checked.ok) { res.status(400).json({ error: checked.error }); return }
      validSupportFiles = checked.value
    }
    if (importSource !== undefined
      && (typeof importSource !== 'object' || importSource === null || Array.isArray(importSource))) {
      res.status(400).json({ error: 'importSource must be an object' }); return
    }
    if (bundleVersion !== undefined && bundleVersion !== 1 && bundleVersion !== 2) {
      res.status(400).json({ error: 'bundleVersion must be 1 or 2' }); return
    }
    if (sourceDigest !== undefined && !/^[a-f0-9]{64}$/.test(sourceDigest)) {
      res.status(400).json({ error: 'sourceDigest must be a SHA-256 hex digest' }); return
    }
    if (validSupportFiles.length > 0 && workspaceId && !workspaceSkillFilesStore) {
      res.status(501).json({ error: 'Skill bundle resources are not available on this deployment.' }); return
    }

    // mig 492: an omitted or 'all' request means "every assistant, including
    // ones created later". That is a property of the SKILL, so it is stored on
    // the row; only an explicit id list materialises enablement rows.
    const wantsAllAssistants =
      enabledAssistantIds === undefined || enabledAssistantIds === 'all'

    const input = {
      slug,
      name: name.trim(),
      description: description?.trim() || name.trim(),
      whenToUse: whenToUse?.trim(),
      content: content.trim(),
      // Groups are free text, so this NORMALIZES rather than rejects: a
      // caller sending an over-long or oddly-spaced name gets the folded
      // form, never a 400 (`@use-brian/shared/skill-groups`).
      category: normalizeSkillGroup(category),
      requiresConnectors: requiresConnectors ?? [],
      sensitivity: sensitivity as 'public' | 'internal' | 'confidential' | undefined,
      importSource: importSource ?? null,
      bundleVersion: bundleVersion ?? (validSupportFiles.length > 0 ? 2 : 1),
      sourceDigest: sourceDigest ?? null,
      deferGraphRecompute: validSupportFiles.length > 0,
      allAssistants: wantsAllAssistants,
    }

    try {
      // Workspace-aware branch (brain-skill-management plan §4): create in the
      // named workspace and record the default offering scope — every
      // assistant, including future ones (the `all_assistants` flag), unless an
      // explicit subset was sent, which materialises rows instead. Enablement
      // is an allowlist, so a skill with neither is offered to nobody.
      if (workspaceId && workspaceSkillStore && workspaceStore) {
        const role = await workspaceStore.getRole(userId, workspaceId)
        if (!role) { res.status(404).json({ error: 'Not found' }); return }

        const skill = await workspaceSkillStore.create(userId, workspaceId, input)

        // Imported resources are one logical bundle. If any row fails, remove
        // the just-created root so a partial skill never becomes offerable.
        if (validSupportFiles.length > 0 && workspaceSkillFilesStore) {
          try {
            for (const f of validSupportFiles) {
              await workspaceSkillFilesStore.upsert(userId, {
                workspaceSkillId: skill.rowId,
                kind: f.kind,
                name: f.name,
                path: f.path ?? null,
                content: f.content,
                description: f.description ?? null,
                contentHash: f.contentHash,
              }, { notify: false })
            }
          } catch (err) {
            await query('DELETE FROM workspace_skills WHERE id = $1', [skill.rowId]).catch(() => undefined)
            console.error('[skills] bundle resource write failed (skill rolled back):', err)
            res.status(500).json({ error: 'Failed to install the complete skill bundle' })
            return
          }
        }

        // Structural-synthesis Phase 2: if the draft carried a structured output
        // shape, mint a v2 blueprint from it and link the skill, so the skill
        // FILLS the blueprint instead of baking the layout into its body.
        // Failure-isolated: a blueprint mint error never fails the skill save.
        if (extraction !== undefined && pageTemplateStore) {
          const parsedSpec = extractionSpecSchema.safeParse(extraction)
          if (parsedSpec.success) {
            try {
              const template = await pageTemplateStore.create(userId, {
                workspaceId,
                name: `${input.name} blueprint`,
                description: input.description,
                icon: null,
                category: 'knowledge',
                blocks: extractionSpecToBlocks(parsedSpec.data),
                extraction: parsedSpec.data,
              })
              await workspaceSkillStore.setBlueprint(userId, workspaceId, skill.rowId, template.id)
              skill.blueprintId = template.id
            } catch (err) {
              console.error('[skills] blueprint mint/link failed (skill kept):', err)
            }
          }
        }

        let enabledIds: string[] = []
        try {
          if (workspaceSkillEnablementStore && listWorkspaceAssistants) {
            const assistants = await listWorkspaceAssistants(userId, workspaceId)
            const valid = new Set(assistants.map((a) => a.id))
            if (wantsAllAssistants) {
              // mig 492 (was D4): "all" is stored as intent on the row at
              // INSERT, not fanned out into one enablement row per assistant.
              // The old fan-out was a snapshot — correct on the day it ran and
              // wrong for every assistant created afterwards. Rows would also
              // contradict the flag, so this branch writes none.
              enabledIds = assistants.map((a) => a.id)
            } else {
              // `wantsAllAssistants` already absorbed undefined / 'all', so
              // this branch is the explicit id list.
              const wanted = (enabledAssistantIds as string[]).filter((id) => valid.has(id))
              for (const assistantId of wanted) {
                await workspaceSkillEnablementStore.enable(skill.rowId, assistantId, userId)
              }
              enabledIds = wanted
            }
          }
        } catch (err) {
          if (validSupportFiles.length > 0) {
            await query('DELETE FROM workspace_skills WHERE id = $1', [skill.rowId]).catch(() => undefined)
          }
          throw err
        }
        if (validSupportFiles.length > 0) workspaceSkillFilesStore?.notifyChanged(skill.rowId)
        if (validSupportFiles.length > 0) refreshNativeCommands(userId, workspaceId)
        res.status(201).json(projectWorkspaceSkill(skill, enabledIds))
        return
      }

      const skill = await skillStore.create(userId, input)
      res.status(201).json(skill)
    } catch (err: any) {
      if (err?.code === '23505') {
        res.status(409).json({ error: 'A skill with this name already exists' }); return
      }
      console.error('[skills] create failed:', err)
      res.status(500).json({ error: 'Failed to create skill' })
    }
  })

  // ── Skill import (GitHub / URL) ──────────────────────────────
  //
  // Parse-only: POST /import fetches + normalizes a skill file (or Agent
  // Skills folder) into a draft the creator opens pre-filled; nothing is
  // written until the user saves through POST /. The GitHub browse reads
  // authorize through the same usable-set gate the KB source picker uses
  // (`resolveWorkspaceGithubPat`). Spec: skill-system.md → "Importing
  // skills (GitHub / URL)".

  const importBodySchema = z.object({
    workspaceId: z.string().trim().min(1),
    source: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('url'), url: z.string().trim().min(1).max(2000) }),
      // Paste / .md upload — the bytes ride in the request, so unlike `url`
      // there is no server-side fetch and therefore no host allowlist to
      // enforce. `fileName` only informs dialect detection + name derivation.
      z.object({
        kind: z.literal('paste'),
        content: z.string().min(1).max(IMPORT_MAX_FILE_BYTES),
        fileName: z.string().trim().max(200).optional(),
      }),
      z.object({
        kind: z.literal('github'),
        connectorInstanceId: z.string().trim().min(1),
        owner: z.string().trim().min(1).max(200),
        repo: z.string().trim().min(1).max(200),
        path: z.string().trim().min(1).max(500),
        ref: z.string().trim().min(1).max(200).optional(),
      }),
    ]),
  })

  /** Membership gate shared by the four import endpoints. */
  async function gateImportWorkspace(
    userId: string,
    workspaceId: unknown,
    res: import('express').Response,
  ): Promise<string | null> {
    if (typeof workspaceId !== 'string' || !workspaceId.trim()) {
      res.status(400).json({ error: 'workspaceId is required' })
      return null
    }
    if (!workspaceStore) {
      res.status(503).json({ error: 'Workspace store not configured on the server.' })
      return null
    }
    const role = await workspaceStore.getRole(userId, workspaceId)
    if (!role) {
      res.status(404).json({ error: 'Not found' })
      return null
    }
    return workspaceId
  }

  router.post('/import', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const parsed = importBodySchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid import request' })
      return
    }
    const workspaceId = await gateImportWorkspace(userId, parsed.data.workspaceId, res)
    if (!workspaceId) return

    try {
      const source = parsed.data.source
      if (source.kind === 'url') {
        const result = await importSkillFromUrl(source.url, fetchRawImport)
        res.json(result)
        return
      }
      if (source.kind === 'paste') {
        res.json(importSkillFromPaste(source.content, source.fileName))
        return
      }
      const resolved = await resolveWorkspaceGithubPat(
        connectorInstanceStore, connectorGrantStore,
        userId, workspaceId, source.connectorInstanceId, res,
      )
      if (!resolved) return
      const result = await importSkillFromGithub(githubReaderFor(resolved.pat), {
        owner: source.owner, repo: source.repo, path: source.path, ref: source.ref,
      })
      res.json(result)
    } catch (err) {
      if (err instanceof SkillImportError) {
        res.status(err.status).json({ error: err.message })
        return
      }
      console.error('[skills] import failed:', err)
      res.status(500).json({ error: 'Failed to import the skill' })
    }
  })

  router.get('/import/github/instances', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const workspaceId = await gateImportWorkspace(userId, req.query.workspaceId, res)
    if (!workspaceId) return
    try {
      const instances = await listWorkspaceGithubInstances(
        connectorInstanceStore, connectorGrantStore, userId, workspaceId,
      )
      if (instances.length === 0) {
        res.status(409).json({ error: 'No usable GitHub connector in this workspace. Connect GitHub in Studio first.' })
        return
      }
      res.json({
        instances: instances.map((i) => ({ id: i.id, label: i.label, connectedEmail: i.connectedEmail })),
      })
    } catch (err) {
      console.error('[skills] import instances failed:', err)
      res.status(500).json({ error: 'Failed to list GitHub connectors' })
    }
  })

  router.get('/import/github/repos', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const workspaceId = await gateImportWorkspace(userId, req.query.workspaceId, res)
    if (!workspaceId) return
    const resolved = await resolveWorkspaceGithubPat(
      connectorInstanceStore, connectorGrantStore,
      userId, workspaceId,
      typeof req.query.connectorInstanceId === 'string' ? req.query.connectorInstanceId : undefined,
      res,
    )
    if (!resolved) return
    try {
      const repos = await listReposFor(resolved.pat)
      res.json({
        repos: repos.map((r) => ({
          fullName: r.full_name,
          name: r.name,
          owner: r.owner.login,
          private: r.private,
          description: r.description,
        })),
      })
    } catch (err) {
      console.error('[skills] import repos failed:', err)
      res.status(502).json({ error: 'Failed to list repositories from GitHub' })
    }
  })

  router.get('/import/github/contents', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const workspaceId = await gateImportWorkspace(userId, req.query.workspaceId, res)
    if (!workspaceId) return
    const owner = typeof req.query.owner === 'string' ? req.query.owner : ''
    const repo = typeof req.query.repo === 'string' ? req.query.repo : ''
    if (!owner || !repo) {
      res.status(400).json({ error: 'owner and repo are required' })
      return
    }
    const path = typeof req.query.path === 'string' ? req.query.path : ''
    const ref = typeof req.query.ref === 'string' && req.query.ref ? req.query.ref : undefined
    const resolved = await resolveWorkspaceGithubPat(
      connectorInstanceStore, connectorGrantStore,
      userId, workspaceId,
      typeof req.query.connectorInstanceId === 'string' ? req.query.connectorInstanceId : undefined,
      res,
    )
    if (!resolved) return
    try {
      const listing = await githubReaderFor(resolved.pat).getFileContents(owner, repo, path, ref)
      const entries = (Array.isArray(listing) ? listing : [listing])
        // The browser shows only what can be picked or descended into:
        // directories and markdown files.
        .filter((e) => e.type === 'dir' || (e.type === 'file' && /\.(md|mdc|markdown)$/i.test(e.name)))
        .map((e) => ({ type: e.type, name: e.name, path: e.path, size: e.size }))
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
      res.json({ entries })
    } catch (err) {
      console.error('[skills] import contents failed:', err)
      res.status(502).json({ error: 'Failed to read the repository from GitHub' })
    }
  })

  // ── POST /draft — one conversational draft turn ──────────────
  //
  // The Brain creator's + editor chat rail's iteration call
  // (brain-skill-management plan §3.2/D3 as amended for chat iteration): the
  // agent follows the `skill-builder` builtin skill, grounded in the
  // caller's RLS-visible brain context, receives the conversation transcript
  // plus the LIVE document state, and returns EITHER a revised draft (with a
  // short narration message) OR a plain reply (questions/advice — no draft
  // change). Stateless — the client resends the transcript + current draft
  // every turn. Model tier is plan-gated like /api/chat (silent downgrade);
  // `research: true` arms webSearch/urlReader grounding for the turn.

  router.post('/draft', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    if (!workspaceStore || !getDraftContext) {
      res.status(501).json({ error: 'Skill drafting is not available' }); return
    }
    if (!draftProvider) {
      res.status(503).json({ error: 'Skill drafting is not available' }); return
    }

    const parsed = draftBodySchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join('; ') }); return
    }
    const { workspaceId, messages, templateSlug, currentDraft, model, research, fileIds } =
      parsed.data
    if (messages[messages.length - 1]!.role !== 'user') {
      res.status(400).json({ error: 'The last message must be from the user' }); return
    }

    const role = await workspaceStore.getRole(userId, workspaceId)
    if (!role) { res.status(404).json({ error: 'Not found' }); return }

    if (!draftLimiter.check(`u:${userId}`)) {
      res.status(429).json({ error: 'Too many drafts — try again later' }); return
    }
    if (research && !researchLimiter.check(`u:${userId}`)) {
      res.status(429).json({ error: 'Too many research turns — try again later' }); return
    }

    // Model tier + budget gate — mirrors /api/chat: a blocked budget stops
    // the turn, otherwise the requested tier silently downgrades to what the
    // plan/budget allows (`resolveModel`).
    const plan = await getWorkspacePlan(workspaceId)
    const budget = await checkUsageBudget(workspaceId, plan)
    if (budget.status === 'blocked') {
      // `blocked` means the workspace has no active plan (the hosted paid
      // gate; paid plans downgrade instead of blocking). See
      // cost-and-pricing.md → "No free plan: the hosted paid gate".
      res.status(429).json({ error: 'This workspace has no active plan. Pick a plan to keep going, or self-host the open-source version.' }); return
    }
    const resolvedModel = resolveModel(model, plan, budget.status)
    const customRuntime = resolveWorkspaceCustomLlm
      ? await resolveWorkspaceCustomLlm({
          workspaceId,
          requestedTier: tierForModel(resolvedModel),
        })
      : null

    // Template resolution: builtin → community registry → user-published.
    let template: SkillDraftTemplate | undefined
    if (templateSlug) {
      const fromRegistry =
        loadBuiltinSkills().find((s) => s.id === templateSlug) ??
        communityRegistry.find((s) => s.id === templateSlug)
      const resolved = fromRegistry ?? (await skillStore.getBySlug(templateSlug).catch(() => null))
      if (!resolved) {
        res.status(404).json({ error: 'Template skill not found' }); return
      }
      template = { name: resolved.name, whenToUse: resolved.whenToUse ?? null, content: resolved.content }
    }

    // Attachments — the chat route's file block-building pattern
    // (chat.ts "Gate each client-supplied fileId by the turn's identity"):
    // the access predicate closes the cross-tenant path. Audio is transcribed
    // just-in-time so the universal dock recorder's short lane can address
    // this visible stateless draft chat.
    let attachments: SkillDraftAttachments | undefined
    if (fileIds && fileIds.length > 0 && fileStore) {
      const fileCtx = {
        workspaceId,
        userId,
        assistantId: 'skill-draft',
        assistantKind: 'standard' as const,
      }
      const fetched = await Promise.all(
        fileIds.map((id) => fileStore.get(id, fileCtx).catch(() => null)),
      )
      const blocks: ContentBlock[] = []
      const textParts: string[] = []
      for (const file of fetched) {
        if (!file) continue
        const isImage = file.mimeType.startsWith('image/')
        const isPdf = file.mimeType === 'application/pdf'
        const isAudio = file.mimeType.startsWith('audio/')
        if (isAudio) {
          const match = file.content.match(/^data:[^;]+;base64,(.+)$/)
          const base64Data = match ? match[1] : file.content
          let transcribeFailure: string | undefined
          const transcription = voiceTranscription
            ? await transcribeFirstAudio(
                [{ buffer: Buffer.from(base64Data, 'base64'), mime: file.mimeType, index: 0 }],
                {
                  ...voiceTranscription,
                  onFailure: (reason) => { transcribeFailure = reason },
                },
              )
            : undefined
          if (!voiceTranscription) transcribeFailure = TRANSCRIPTION_DISABLED_REASON
          textParts.push(
            transcription
              ? `[voice] ${transcription.text}`
              : `<attached_file id="${file.id}" name="${file.fileName}" type="${file.mimeType}">${voiceUnavailableNote(transcribeFailure)}</attached_file>`,
          )
        } else if (isImage || isPdf) {
          // Inline media must be stored as "data:<mime>;base64,<data>" —
          // refuse to hand garbage to the model as bogus base64.
          const match = file.content.match(/^data:[^;]+;base64,(.+)$/)
          if (match) {
            blocks.push({ type: 'image', mimeType: file.mimeType, data: match[1]! })
            textParts.push(
              `<attached_file id="${file.id}" name="${file.fileName}" type="${file.mimeType}">[${isPdf ? 'pdf' : 'image'}]</attached_file>`,
            )
          } else {
            textParts.push(
              `<attached_file id="${file.id}" name="${file.fileName}" type="${file.mimeType}">[This ${isPdf ? 'PDF' : 'image'} can't be read. Ask the user to re-upload it.]</attached_file>`,
            )
          }
        } else {
          // Text-like: inline when small; hard-truncate otherwise (this
          // path has no readFileContent tool to page through a cache ref).
          const body = shouldInline(file.content)
            ? file.content
            : `${file.content.slice(0, 20_000)}\n…(truncated)`
          textParts.push(
            `<attached_file id="${file.id}" name="${file.fileName}" type="${file.mimeType}">\n${body}\n</attached_file>`,
          )
        }
      }
      if (blocks.length > 0 || textParts.length > 0) attachments = { blocks, textParts }
    }

    // D3 — the drafting methodology is the skill-builder builtin's body.
    const builderSkill = loadBuiltinSkills().find((s) => s.id === 'skill-builder')?.content ?? ''

    try {
      const context = await getDraftContext(userId, workspaceId)
      const result = await generateSkillDraft({
        provider: customRuntime?.provider ?? draftProvider,
        model: customRuntime?.selector ?? resolvedModel,
        transcript: messages,
        template,
        currentDraft,
        attachments,
        context,
        builderSkill,
        research: research === true,
        identity: { userId, workspaceId },
      })
      if (result.kind === 'reply') {
        res.json({ kind: 'reply', message: result.message })
        return
      }
      res.json({ kind: 'draft', draft: result.draft, message: result.message })
    } catch (err) {
      if (err instanceof SkillDraftError) {
        res.status(422).json({ error: err.message }); return
      }
      console.error('[skills] draft failed:', err)
      res.status(500).json({ error: 'Failed to draft skill' })
    }
  })

  /**
   * Resolve a skill's workspace from its ROW id, then gate on membership — the
   * workspace-aware scope shared by the mutation routes (PATCH / DELETE /
   * publish / unpublish). A skill lives in exactly ONE workspace
   * (`workspace_skills.workspace_id`), which is NOT necessarily the caller's
   * personal/primary workspace. The legacy userId-keyed store pinned
   * `resolvePrimaryWorkspace()` (personal workspace first), so a team-workspace
   * skill matched zero rows and 404'd "Skill not found" for anyone whose
   * personal workspace wasn't the skill's — a save/delete on any team skill was
   * unreachable. Mirrors `resolveAccessContext` + the `/:id/confirm` gate.
   * Returns a `legacy` sentinel when the workspace stores aren't injected so
   * minimal mounts fall back to the userId-keyed store.
   */
  async function resolveSkillMutationScope(
    userId: string,
    skillRowId: string,
  ): Promise<
    | { kind: 'workspace'; workspaceId: string }
    | { kind: 'legacy' }
    | { kind: 'not-found' }
  > {
    if (!workspaceSkillStore || !workspaceStore) return { kind: 'legacy' }
    const skill = await workspaceSkillStore.getByIdSystem(skillRowId)
    if (!skill) return { kind: 'not-found' }
    const role = await workspaceStore.getRole(userId, skill.workspaceId)
    if (!role) return { kind: 'not-found' }
    return { kind: 'workspace', workspaceId: skill.workspaceId }
  }

  // ── PATCH /:id — update a skill ─────────────────────────────

  router.patch('/:id', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const { name, description, whenToUse, content, category, requiresConnectors, sensitivity } = req.body as {
      name?: string
      description?: string
      whenToUse?: string | null
      content?: string
      category?: string
      requiresConnectors?: string[]
      /** Manual clearance choice — store sets `sensitivity_overridden`. */
      sensitivity?: string
    }

    if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
      res.status(400).json({ error: 'Name must be a non-empty string' }); return
    }
    if (content !== undefined && (typeof content !== 'string' || !content.trim())) {
      res.status(400).json({ error: 'Content must be a non-empty string' }); return
    }
    if (sensitivity !== undefined && !SENSITIVITIES.has(sensitivity)) {
      res.status(400).json({ error: 'sensitivity must be public, internal, or confidential' }); return
    }

    // D2 (brain-skill-management plan): name/content edits carry the
    // confirm-grade trust stamp inside the store update.
    const updates = {
      name: name?.trim(),
      description: description?.trim(),
      whenToUse: whenToUse === null ? null : whenToUse?.trim(),
      content: content?.trim(),
      // `undefined` means "not patching this field"; anything else is a group
      // name and gets the same normalize-don't-reject treatment as create.
      category: category === undefined ? undefined : normalizeSkillGroup(category),
      requiresConnectors,
      sensitivity: sensitivity as 'public' | 'internal' | 'confidential' | undefined,
    }

    try {
      const scope = await resolveSkillMutationScope(userId, req.params.id)
      if (scope.kind === 'not-found') { res.status(404).json({ error: 'Skill not found' }); return }

      if (scope.kind === 'workspace') {
        const updated = await workspaceSkillStore!.update(userId, scope.workspaceId, req.params.id, updates)
        if (!updated) { res.status(404).json({ error: 'Skill not found' }); return }
        // Return the Brain projection (rowId-shaped, matching create's 201) —
        // the enablement rows are unchanged by an edit, re-read for the shape.
        // An `allAssistants` skill carries NO rows, so reading the allowlist
        // would report it as offered to nobody — resolve it the same way every
        // other projection does (see `resolveEnabledAssistantIds`).
        const enabledAssistantIds = await resolveEnabledAssistantIds(userId, updated)
        res.json(projectWorkspaceSkill(updated, enabledAssistantIds))
        return
      }

      // Legacy fallback — workspace stores not injected (minimal mounts / tests).
      const skill = await skillStore.update(userId, req.params.id, updates)
      if (!skill) { res.status(404).json({ error: 'Skill not found' }); return }
      res.json(skill)
    } catch (err) {
      console.error('[skills] update failed:', err)
      res.status(500).json({ error: 'Failed to update skill' })
    }
  })

  // ── DELETE /:id — delete a skill ────────────────────────────

  router.delete('/:id', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    try {
      const scope = await resolveSkillMutationScope(userId, req.params.id)
      if (scope.kind === 'not-found') { res.status(404).json({ error: 'Skill not found' }); return }
      const deleted =
        scope.kind === 'workspace'
          ? await workspaceSkillStore!.delete(userId, scope.workspaceId, req.params.id)
          : await skillStore.delete(userId, req.params.id)
      if (!deleted) { res.status(404).json({ error: 'Skill not found' }); return }
      res.status(204).end()
    } catch (err) {
      console.error('[skills] delete failed:', err)
      res.status(500).json({ error: 'Failed to delete skill' })
    }
  })

  // ── POST /:id/confirm — human-confirm a suggested skill (Brain) ──
  //
  // The Brain trust-loop action (plan §5.2): a workspace member confirms a
  // suggested/auto-induced skill → the store stamps the verifier, lifts
  // confidence to the activation threshold, activates it, and flips provenance
  // to foreground (so it's immune to auto-curation). `:id` here is the skill
  // ROW UUID (`workspace_skills.id`), matching the `rowId` the /workspace list
  // projects. Workspace-membership gated; workspaceId comes from the body.

  router.post('/:id/confirm', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    if (!workspaceSkillStore || !workspaceStore) {
      res.status(501).json({ error: 'Workspace skills are not available' }); return
    }

    const body = (req.body ?? {}) as { workspaceId?: string }
    const workspaceId =
      typeof body.workspaceId === 'string'
        ? body.workspaceId
        : typeof req.query.workspaceId === 'string'
          ? req.query.workspaceId
          : null
    if (!workspaceId) {
      res.status(400).json({ error: 'workspaceId is required' }); return
    }

    const role = await workspaceStore.getRole(userId, workspaceId)
    if (!role) { res.status(404).json({ error: 'Not found' }); return }

    try {
      await workspaceSkillStore.confirmSkill(userId, workspaceId, req.params.id)
      res.json({ ok: true })
    } catch (err) {
      console.error('[skills] confirm failed:', err)
      res.status(500).json({ error: 'Failed to confirm skill' })
    }
  })

  // ── GET/PUT /:id/access — skill-centric assistant access ────
  //
  // The editor's Access tab (brain-skill-management plan §3.3/§4): the
  // skill-centric dual of Studio's assistant-centric enable toggle. Both
  // write the same `workspace_skill_enablement` allowlist. `:id` is the
  // skill ROW UUID. Membership derived from the skill's own workspace via
  // `getByIdSystem` + `getRole` — no workspaceId in the request.

  async function resolveAccessContext(
    userId: string,
    skillRowId: string,
  ): Promise<
    | { ok: true; skill: WorkspaceSkill; assistants: Array<{ id: string; name: string }> }
    | { ok: false; status: number; error: string }
  > {
    if (!workspaceSkillStore || !workspaceStore || !workspaceSkillEnablementStore || !listWorkspaceAssistants) {
      return { ok: false, status: 501, error: 'Skill access management is not available' }
    }
    const skill = await workspaceSkillStore.getByIdSystem(skillRowId)
    if (!skill) return { ok: false, status: 404, error: 'Skill not found' }
    const role = await workspaceStore.getRole(userId, skill.workspaceId)
    if (!role) return { ok: false, status: 404, error: 'Skill not found' }
    const assistants = await listWorkspaceAssistants(userId, skill.workspaceId)
    return { ok: true, skill, assistants }
  }

  router.get('/:id/access', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    try {
      const ctx = await resolveAccessContext(userId, req.params.id)
      if (!ctx.ok) { res.status(ctx.status).json({ error: ctx.error }); return }
      // mig 492: the flag answers for every assistant at once and carries no
      // rows, so the allowlist read is skipped rather than reported as "off".
      const rows = ctx.skill.allAssistants
        ? []
        : await workspaceSkillEnablementStore!.listForSkill(ctx.skill.rowId, {
            actingUserId: userId,
          })
      const enabled = new Set(rows.map((r) => r.assistantId))
      res.json({
        allAssistants: ctx.skill.allAssistants,
        assistants: ctx.assistants.map((a) => ({
          id: a.id,
          name: a.name,
          enabled: ctx.skill.allAssistants || enabled.has(a.id),
        })),
      })
    } catch (err) {
      console.error('[skills] access list failed:', err)
      res.status(500).json({ error: 'Failed to list skill access' })
    }
  })

  router.put('/:id/access', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const { enabledAssistantIds, allAssistants } = (req.body ?? {}) as {
      enabledAssistantIds?: string[]
      allAssistants?: boolean
    }
    if (allAssistants !== undefined && typeof allAssistants !== 'boolean') {
      res.status(400).json({ error: 'allAssistants must be a boolean' }); return
    }
    // `allAssistants: true` is self-describing — the id list is redundant and
    // may legitimately be absent. Every other request still needs one.
    if (allAssistants !== true
      && (!Array.isArray(enabledAssistantIds) || enabledAssistantIds.some((id) => typeof id !== 'string'))) {
      res.status(400).json({ error: 'enabledAssistantIds must be an array of assistant ids' }); return
    }

    try {
      const ctx = await resolveAccessContext(userId, req.params.id)
      if (!ctx.ok) { res.status(ctx.status).json({ error: ctx.error }); return }

      // ── "All assistants, including future ones" ──────────────────
      // Stored as intent on the skill row, never as rows: rows can only ever
      // name assistants that already exist, which is the whole bug (mig 492).
      // Existing rows are dropped so the two representations cannot disagree.
      if (allAssistants === true) {
        await workspaceSkillStore!.setAllAssistants(userId, ctx.skill.workspaceId, ctx.skill.rowId, true)
        await workspaceSkillEnablementStore!.disableAll(ctx.skill.rowId)
        res.json({
          allAssistants: true,
          assistants: ctx.assistants.map((a) => ({ id: a.id, name: a.name, enabled: true })),
        })
        return
      }

      // Desired-state set over the workspace's assistants: enable the missing,
      // disable the removed. Ids outside the workspace are ignored.
      const valid = new Set(ctx.assistants.map((a) => a.id))
      const wanted = new Set(enabledAssistantIds!.filter((id) => valid.has(id)))

      // Narrowing a flagged skill to an explicit list is a CONVERSION, not a
      // plain diff: the flag must become rows before it is cleared, or the
      // skill briefly (or permanently, on a crash) belongs to nobody. The
      // helper writes rows first and clears the flag second; the diff below
      // then runs against a normal materialised skill.
      const conversion = await materialiseAllAssistants({
        skill: ctx.skill,
        actingUserId: userId,
        listAssistantIds: async () => ctx.assistants.map((a) => a.id),
        enablementStore: workspaceSkillEnablementStore!,
        workspaceSkillStore: workspaceSkillStore!,
      })

      const current = new Set(
        conversion.converted
          ? conversion.enabledAssistantIds
          : (
              await workspaceSkillEnablementStore!.listForSkill(ctx.skill.rowId, {
                actingUserId: userId,
              })
            ).map((r) => r.assistantId),
      )
      for (const id of wanted) {
        if (!current.has(id)) {
          await workspaceSkillEnablementStore!.enable(ctx.skill.rowId, id, userId)
        }
      }
      for (const id of current) {
        if (!wanted.has(id) && valid.has(id)) {
          await workspaceSkillEnablementStore!.disable(ctx.skill.rowId, id, userId)
        }
      }
      res.json({
        allAssistants: false,
        assistants: ctx.assistants.map((a) => ({
          id: a.id,
          name: a.name,
          enabled: wanted.has(a.id),
        })),
      })
    } catch (err) {
      console.error('[skills] access update failed:', err)
      res.status(500).json({ error: 'Failed to update skill access' })
    }
  })

  // ── /categorize — suggest a library group for the unsorted skills ──
  //
  // A workspace that has been running a while accumulates dozens of skills —
  // its own plus everything the background curator induced — and every one of
  // them lands in the `custom` sink, because nothing set `category` until the
  // editor picker existed. Re-filing them one editor visit at a time is the
  // friction this removes.
  //
  // Two routes, deliberately split: `/categorize` PROPOSES and writes nothing,
  // `/categorize/apply` takes the explicit per-skill assignments the user
  // reviewed. The model is guessing a group from a name and a description, so
  // a bulk write nobody looked at is the failure mode to design out.
  //
  // `scope: 'all'` widens the pass to skills that already have a group. It is
  // an explicit tick in the dialog, and it widens what the user is SHOWN, not
  // what is written unseen - the review stage is unchanged.
  //
  // Spec: docs/architecture/engine/skill-system.md → "Suggesting groups".

  const categorizeBodySchema = z.object({
    workspaceId: z.string().trim().min(1),
    // `all` re-decides skills that already have a group, and is reachable only
    // from an explicit tick in the review dialog. Absent means `unsorted`.
    scope: z.enum(['unsorted', 'all']).optional(),
  })

  // A group is free text, not an enum: the schema only bounds the SHAPE, and
  // `normalizeSkillGroup` folds what survives (trim, collapse, cap, built-in
  // slugs). Rejecting an unknown name here is what made the old four-value
  // enum unable to express the group a workspace actually wanted.
  const categorizeApplySchema = z.object({
    workspaceId: z.string().trim().min(1),
    assignments: z
      .array(
        z.object({
          skillRowId: z.string().trim().min(1),
          category: z.string().trim().min(1).max(200),
        }),
      )
      .min(1)
      .max(500),
  })

  router.post('/categorize', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    if (!workspaceSkillStore || !workspaceStore) {
      res.status(501).json({ error: 'Skill grouping is not available' }); return
    }
    if (!draftProvider) {
      res.status(503).json({ error: 'Skill grouping is not available' }); return
    }

    const parsed = categorizeBodySchema.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'workspaceId is required' }); return }
    const { workspaceId } = parsed.data
    const requestedScope: CategorizeScope = parsed.data.scope ?? 'unsorted'

    const role = await workspaceStore.getRole(userId, workspaceId)
    if (!role) { res.status(404).json({ error: 'Not found' }); return }

    // Shares the draft limiter: both are user-triggered model calls from the
    // same surface, and one budget is easier to reason about than two.
    if (!draftLimiter.check(`u:${userId}`)) {
      res.status(429).json({ error: 'Too many requests — try again later' }); return
    }

    const plan = await getWorkspacePlan(workspaceId)
    const budget = await checkUsageBudget(workspaceId, plan)
    if (budget.status === 'blocked') {
      res.status(429).json({ error: 'This workspace has no active plan. Pick a plan to keep going, or self-host the open-source version.' }); return
    }

    try {
      const customRuntime = resolveWorkspaceCustomLlm
        ? await resolveWorkspaceCustomLlm({ workspaceId, requestedTier: 'standard' })
        : null
      const all = await workspaceSkillStore.listForWorkspace(workspaceId, { actingUserId: userId })
      const active = all.filter((s) => s.state !== 'archived')
      const candidates = selectCategorizableSkills(active, requestedScope).map((s) => ({
        rowId: s.rowId,
        name: s.name,
        description: s.description,
        whenToUse: s.whenToUse ?? null,
        category: s.category,
      }))

      if (candidates.length === 0) {
        res.json({ suggestions: [], considered: 0 })
        return
      }

      const suggestions = await suggestSkillCategories({
        provider: customRuntime?.provider ?? draftProvider,
        // Grouping a name + description is the cheapest kind of judgement;
        // it never needs more than the plan's floor tier.
        model: customRuntime?.selector ?? resolveModel('standard', plan, budget.status),
        skills: candidates,
        // Derived from the WHOLE library, not just the batch: a group the
        // model should reuse may belong to a skill this pass cannot touch.
        existingGroups: existingGroupsOf(active),
      })
      res.json({ suggestions, considered: candidates.length })
    } catch (err) {
      console.error('[skills] categorize failed:', err)
      res.status(500).json({ error: 'Failed to suggest groups' })
    }
  })

  router.post('/categorize/apply', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    if (!workspaceSkillStore || !workspaceStore) {
      res.status(501).json({ error: 'Skill grouping is not available' }); return
    }

    const parsed = categorizeApplySchema.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Invalid assignments' }); return }
    const { workspaceId, assignments } = parsed.data

    const role = await workspaceStore.getRole(userId, workspaceId)
    if (!role) { res.status(404).json({ error: 'Not found' }); return }

    // `update` scopes by (id, workspace_id), so a row from another workspace
    // simply matches nothing — it is counted as skipped, never applied.
    // Category is metadata, so this does NOT carry the D2 trust stamp: a bulk
    // re-file must not silently verify and activate every Suggested skill it
    // touches (`skill-store.ts` → "Metadata-only edits ... don't qualify").
    let updated = 0
    const failed: string[] = []
    for (const { skillRowId, category } of assignments) {
      try {
        const row = await workspaceSkillStore.update(userId, workspaceId, skillRowId, {
          category: normalizeSkillGroup(category),
        })
        if (row) updated += 1
        else failed.push(skillRowId)
      } catch (err) {
        console.error('[skills] categorize apply failed for', skillRowId, err)
        failed.push(skillRowId)
      }
    }
    res.json({ updated, failed })
  })

  // ── /:id/files — the skill's support-file bundle ────────────
  //
  // A skill is a bundle, not a lone body: `workspace_skill_files` holds its
  // reference / template / script files and `useSkill` expands their
  // `{{kind:name}}` pointers at load time. These three routes are the human
  // half of that surface — before them the rows were write-once at import and
  // the background curator's `add_support_file` could attach a file the
  // owning user could never see, edit, or remove.
  //
  // Spec: docs/architecture/engine/skill-system.md → "Support files".

  /** Membership + store gate shared by the three file routes. Answers on
   *  `res` and returns false when the caller must not proceed. */
  async function passesSkillFilesGate(
    userId: string,
    skillRowId: string,
    res: import('express').Response,
  ): Promise<boolean> {
    if (!workspaceSkillFilesStore) {
      res.status(501).json({ error: 'Support files are not available on this deployment.' })
      return false
    }
    const scope = await resolveSkillMutationScope(userId, skillRowId)
    if (scope.kind !== 'workspace') {
      // `legacy` means the workspace stores aren't injected — the same
      // not-configured answer as a missing files store.
      if (scope.kind === 'legacy') {
        res.status(501).json({ error: 'Support files are not available on this deployment.' })
      } else {
        res.status(404).json({ error: 'Skill not found' })
      }
      return false
    }
    return true
  }

  /** Wire shape of one support-file row. */
  function toSupportFileJson(row: {
    kind: string
    name: string
    path: string | null
    content: string
    description: string | null
    contentHash: string | null
    updatedAt: Date | string
  }) {
    return {
      kind: row.kind,
      name: row.name,
      path: row.path,
      content: row.content,
      description: row.description,
      contentHash: row.contentHash,
      updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
    }
  }

  const supportFileSelectorSchema = z.object({
    kind: z.enum(SUPPORT_FILE_KINDS),
    name: z.string().trim().min(1).max(SUPPORT_FILE_NAME_MAX),
  })

  router.get('/:id/files', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    try {
      if (!(await passesSkillFilesGate(userId, req.params.id, res))) return
      const rows = await workspaceSkillFilesStore!.list(req.params.id, { actingUserId: userId })
      res.json({ files: rows.map(toSupportFileJson) })
    } catch (err) {
      console.error('[skills] list support files failed:', err)
      res.status(500).json({ error: 'Failed to list support files' })
    }
  })

  router.put('/:id/files', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const checked = validateSupportFile(req.body)
    if (!checked.ok) { res.status(400).json({ error: checked.error }); return }

    try {
      if (!(await passesSkillFilesGate(userId, req.params.id, res))) return

      // Count cap applies to the resulting set, not the request: upserting an
      // existing (kind, name) replaces rather than adds.
      const existing = await workspaceSkillFilesStore!.list(req.params.id, { actingUserId: userId })
      const isNew = !existing.some(
        (f) => f.kind === checked.value.kind && f.name === checked.value.name,
      )
      const projected = existing
        .filter((f) => !(f.kind === checked.value.kind && f.name === checked.value.name))
        .map((f) => ({ kind: f.kind, name: f.name, content: f.content }))
        .concat([checked.value])
      const set = validateSupportFileSet(projected)
      if (!set.ok) { res.status(400).json({ error: set.error }); return }

      const row = await workspaceSkillFilesStore!.upsert(userId, {
        workspaceSkillId: req.params.id,
        kind: checked.value.kind,
        name: checked.value.name,
        path: checked.value.path ?? null,
        content: checked.value.content,
        description: checked.value.description ?? null,
        contentHash: checked.value.contentHash,
      })
      res.status(isNew ? 201 : 200).json({ file: toSupportFileJson(row) })
    } catch (err) {
      console.error('[skills] support file upsert failed:', err)
      res.status(500).json({ error: 'Failed to save the support file' })
    }
  })

  router.delete('/:id/files', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    // Identified by query rather than path: a file name may carry slashes (the
    // resolver allows them), so routing on it would need encoding rules the
    // client would have to match.
    const selector = supportFileSelectorSchema.safeParse(req.query)
    if (!selector.success) {
      res.status(400).json({ error: 'kind and name query parameters are required' }); return
    }
    const { kind, name } = selector.data

    try {
      if (!(await passesSkillFilesGate(userId, req.params.id, res))) return
      const removed = await workspaceSkillFilesStore!.delete(userId, req.params.id, kind, name)
      if (!removed) { res.status(404).json({ error: 'Support file not found' }); return }
      res.json({ deleted: true })
    } catch (err) {
      console.error('[skills] support file delete failed:', err)
      res.status(500).json({ error: 'Failed to delete the support file' })
    }
  })

  // ── POST /:id/publish — publish to community ────────────────

  router.post('/:id/publish', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    try {
      const scope = await resolveSkillMutationScope(userId, req.params.id)
      if (scope.kind === 'not-found') { res.status(404).json({ error: 'Skill not found' }); return }
      const ok =
        scope.kind === 'workspace'
          ? await workspaceSkillStore!.publish(userId, scope.workspaceId, req.params.id)
          : await skillStore.publish(userId, req.params.id)
      if (!ok) { res.status(404).json({ error: 'Skill not found' }); return }
      res.json({ ok: true })
    } catch (err) {
      console.error('[skills] publish failed:', err)
      res.status(500).json({ error: 'Failed to publish skill' })
    }
  })

  // ── POST /:id/unpublish — unpublish ─────────────────────────

  router.post('/:id/unpublish', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    try {
      const scope = await resolveSkillMutationScope(userId, req.params.id)
      if (scope.kind === 'not-found') { res.status(404).json({ error: 'Skill not found' }); return }
      const ok =
        scope.kind === 'workspace'
          ? await workspaceSkillStore!.unpublish(userId, scope.workspaceId, req.params.id)
          : await skillStore.unpublish(userId, req.params.id)
      if (!ok) { res.status(404).json({ error: 'Skill not found' }); return }
      res.json({ ok: true })
    } catch (err) {
      console.error('[skills] unpublish failed:', err)
      res.status(500).json({ error: 'Failed to unpublish skill' })
    }
  })

  // ── POST /:id/star — star (user-level, UX only) ─────────────

  router.post('/:id/star', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    try {
      await skillStore.star(userId, req.params.id)
      res.json({ ok: true })
    } catch (err) {
      console.error('[skills] star failed:', err)
      res.status(500).json({ error: 'Failed to star skill' })
    }
  })

  // ── POST /:id/unstar — unstar ───────────────────────────────

  router.post('/:id/unstar', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    try {
      await skillStore.unstar(userId, req.params.id)
      res.json({ ok: true })
    } catch (err) {
      console.error('[skills] unstar failed:', err)
      res.status(500).json({ error: 'Failed to unstar skill' })
    }
  })

  return router
}
