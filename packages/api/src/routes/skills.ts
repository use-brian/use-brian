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
 *                                  in body; writes D4 default enablement rows)
 *   PATCH  /:id                 — update a skill (D2: name/body edits carry the
 *                                  confirm-grade trust stamp; accepts `sensitivity`)
 *   DELETE /:id                 — delete a skill
 *   POST   /:id/confirm         — human-confirm a suggested skill → active (Brain trust loop)
 *   GET    /:id/access          — skill-centric per-assistant enablement (Access tab)
 *   PUT    /:id/access          — set the enabled-assistant set for a skill
 *   GET    /catalog/:slug        — one template's full content (creator's
 *                                  instant template load)
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
import { loadBuiltinSkills, createRateLimiter, shouldInline, extractionSpecSchema, extractionSpecToBlocks } from '@sidanclaw/core'
import type { SkillContent, LLMProvider, FileStore, ContentBlock } from '@sidanclaw/core'
import type { SkillStore, WorkspaceSkillStore, WorkspaceSkill } from '../db/skill-store.js'
import type { PageTemplateStore } from '../db/page-templates-store.js'
import { getWorkspacePlan as getWorkspacePlanDb, type WorkspaceStore } from '../db/workspace-store.js'
import type { WorkspaceSkillEnablementStore } from '../db/workspace-skill-enablement-store.js'

// The real DB-backed credit gate (`checkCreditBudget`, closed `billing/`) is
// injected by the platform via the `checkUsageBudget` option; the open build
// falls through to `allowAllBudget` below (billing-out = don't-wire, §12.3).
const allowAllBudget = async (): Promise<{ status: 'ok' | 'downgraded' | 'blocked' }> => ({
  status: 'ok',
})
import { resolveModel } from '../model-resolution.js'
import {
  generateSkillDraft,
  SkillDraftError,
  type SkillDraftAttachments,
  type SkillDraftContext,
  type SkillDraftTemplate,
} from '../skills/draft-generator.js'

const SENSITIVITIES = new Set(['public', 'internal', 'confidential'])

type SkillRouteOptions = {
  skillStore: SkillStore
  communityRegistry?: SkillContent[]
  /**
   * V2 workspace-aware store — backs the Brain procedural-primitive surface
   * (`docs/plans/skills-as-procedural-brain-primitive.md` §5, §7.1): the
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
  /** Plan + budget seams for the draft model-tier gate — default to the real
   *  DB-backed implementations (`getWorkspacePlan` / `checkCreditBudget`);
   *  injected by tests. */
  getWorkspacePlan?: (workspaceId: string) => Promise<string>
  checkUsageBudget?: (
    workspaceId: string,
    plan: string,
  ) => Promise<{ status: 'ok' | 'downgraded' | 'blocked' }>
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
  return { id: s.id, name: s.name, description: s.description, whenToUse: s.whenToUse, category: s.category, requiresConnectors: s.requiresConnectors, source: s.source, authorName: s.authorName }
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
  getDraftContext,
  draftRateLimiter,
  researchRateLimiter,
  fileStore,
  getWorkspacePlan = getWorkspacePlanDb,
  checkUsageBudget = allowAllBudget,
}: SkillRouteOptions): Router {
  const router = Router()
  // One model call per draft turn — keep a per-user lid on it (plan §10).
  // In-memory is fine: the limit is an abuse backstop, not a billing meter,
  // and the route runs single-service.
  const draftLimiter = draftRateLimiter ?? createRateLimiter({ maxRequests: 20, windowMs: 3600_000 })
  // Research turns additionally burn search-provider quota — tighter sub-lid.
  const researchLimiter =
    researchRateLimiter ?? createRateLimiter({ maxRequests: 10, windowMs: 3600_000 })

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
      enabledAssistantIds,
      lastInvokedAt: s.lastInvokedAt ? s.lastInvokedAt.toISOString() : null,
      invocations: s.invocations,
      succeeded: s.succeeded,
      userCorrectedAfter: s.userCorrectedAfter,
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
      }
      res.json({
        skill: {
          id: s.id ?? slug,
          name: s.name,
          description: s.description ?? '',
          whenToUse: s.whenToUse ?? null,
          content: s.content,
          category: s.category ?? 'custom',
          requiresConnectors: s.requiresConnectors ?? [],
          source: s.source ?? 'community',
          authorName: s.authorName,
        },
      })
    } catch (err) {
      console.error('[skills] catalog detail failed:', err)
      res.status(500).json({ error: 'Failed to load template skill' })
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
  // (`docs/plans/skills-as-procedural-brain-primitive.md` §5, §7.1). Returns
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
      const projected = visible.map((s) =>
        projectWorkspaceSkill(s, enabledBySkill.get(s.rowId) ?? []),
      )
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

    const input = {
      slug,
      name: name.trim(),
      description: description?.trim() || name.trim(),
      whenToUse: whenToUse?.trim(),
      content: content.trim(),
      category: category ?? 'custom',
      requiresConnectors: requiresConnectors ?? [],
      sensitivity: sensitivity as 'public' | 'internal' | 'confidential' | undefined,
    }

    try {
      // Workspace-aware branch (brain-skill-management plan §4): create in the
      // named workspace and write the D4 enablement default — every assistant
      // the creator can reach, unless an explicit subset was sent. Enablement
      // is an allowlist; skipping this step would create a skill no assistant
      // is ever offered.
      if (workspaceId && workspaceSkillStore && workspaceStore) {
        const role = await workspaceStore.getRole(userId, workspaceId)
        if (!role) { res.status(404).json({ error: 'Not found' }); return }

        const skill = await workspaceSkillStore.create(userId, workspaceId, input)

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
        if (workspaceSkillEnablementStore && listWorkspaceAssistants) {
          const assistants = await listWorkspaceAssistants(userId, workspaceId)
          const valid = new Set(assistants.map((a) => a.id))
          const wanted =
            enabledAssistantIds === undefined || enabledAssistantIds === 'all'
              ? assistants.map((a) => a.id)
              : enabledAssistantIds.filter((id) => valid.has(id))
          for (const assistantId of wanted) {
            await workspaceSkillEnablementStore.enable(skill.rowId, assistantId, userId)
          }
          enabledIds = wanted
        }
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
      res.status(429).json({ error: 'Monthly usage limit reached — try again after the reset' }); return
    }
    const resolvedModel = resolveModel(model, plan, budget.status)

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
    // the access predicate closes the cross-tenant path; audio is stubbed
    // out (no transcription on this path).
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
          textParts.push(
            `<attached_file id="${file.id}" name="${file.fileName}" type="${file.mimeType}">[Audio attachments are not supported for skill drafting. Ask the user to paste the relevant text instead.]</attached_file>`,
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
        provider: draftProvider,
        model: resolvedModel,
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

    try {
      // D2 (brain-skill-management plan): name/content edits carry the
      // confirm-grade trust stamp inside the store update.
      const skill = await skillStore.update(userId, req.params.id, {
        name: name?.trim(),
        description: description?.trim(),
        whenToUse: whenToUse === null ? null : whenToUse?.trim(),
        content: content?.trim(),
        category,
        requiresConnectors,
        sensitivity: sensitivity as 'public' | 'internal' | 'confidential' | undefined,
      })
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
      const deleted = await skillStore.delete(userId, req.params.id)
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
      const rows = await workspaceSkillEnablementStore!.listForSkill(ctx.skill.rowId, {
        actingUserId: userId,
      })
      const enabled = new Set(rows.map((r) => r.assistantId))
      res.json({
        assistants: ctx.assistants.map((a) => ({
          id: a.id,
          name: a.name,
          enabled: enabled.has(a.id),
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

    const { enabledAssistantIds } = (req.body ?? {}) as { enabledAssistantIds?: string[] }
    if (!Array.isArray(enabledAssistantIds) || enabledAssistantIds.some((id) => typeof id !== 'string')) {
      res.status(400).json({ error: 'enabledAssistantIds must be an array of assistant ids' }); return
    }

    try {
      const ctx = await resolveAccessContext(userId, req.params.id)
      if (!ctx.ok) { res.status(ctx.status).json({ error: ctx.error }); return }

      // Desired-state set over the workspace's assistants: enable the missing,
      // disable the removed. Ids outside the workspace are ignored.
      const valid = new Set(ctx.assistants.map((a) => a.id))
      const wanted = new Set(enabledAssistantIds.filter((id) => valid.has(id)))
      const current = new Set(
        (
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

  // ── POST /:id/publish — publish to community ────────────────

  router.post('/:id/publish', async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }

    try {
      const ok = await skillStore.publish(userId, req.params.id)
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
      const ok = await skillStore.unpublish(userId, req.params.id)
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
