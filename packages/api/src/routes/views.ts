/**
 * Q5 Views routes — saved-views CRUD + per-entity primitive read routes
 * + ad-hoc payload rendering + direct-write endpoints used by board-drop
 * actions in the renderer.
 *
 * Notion-redesign (mig 184) adds the page-block routes:
 *   GET    /api/views/:id                — page metadata
 *   GET    /api/views/:id/payload        — rendered A2UI payload (walks blocks)
 *   PATCH  /api/views/:id/page           — replace blocks (drag-drop reorder + edits)
 *   PATCH  /api/views/:id/save           — state='saved', clear auto-prune
 *   PATCH  /api/views/:id/unsave         — state='draft', set auto-prune
 *   POST   /api/workspaces/:wid/views/draft — create empty draft
 *
 * The legacy `/api/saved-views/*` routes stay alive for backward compat
 * with the original /views/new form. They share the same store but read
 * the legacy `binding` column directly.
 *
 * All routes require an authenticated user (mounted under requireAuth in
 * `apps/api/src/index.ts`). Workspace membership is checked via
 * `WorkspaceStore.getRole`. Reads go through `queryWithRLS`.
 *
 * Mount point: `/api`.
 *
 * [COMP:api/views-routes]
 */

import { Router } from 'express'
import multer from 'multer'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import {
  isValidPageSlug,
  normalizeHostname,
  suggestPageSlug,
} from '@use-brian/shared/page-slugs'
import type { PageDomainStore } from '../db/page-domain-store.js'
import type { DomainProvisioner } from '../domains/provisioner.js'
import {
  AUTO_TITLE_MIN_CHARS,
  type AnalyticsLogger,
  bindingConfigSchema,
  blueprintRecordToBlocks,
  buildPayload,
  canRead,
  DEAL_STAGES,
  emptyPage,
  pageSchema,
  renderPage,
  blocksToMarkdown,
  pageToMarkdown,
  markdownToBlocks,
  blocksToDocx,
  parseDocxToMarkdown,
  sanitize,
  softDelete,
  SoftDeleteError,
  TASK_STATUSES,
  type BindingConfig,
  type BindingDeps,
  type DocEntityStore,
  type DocPageStore,
  type CrmStore,
  type DealStage,
  type JobStore,
  type LLMProvider,
  type NameOrigin,
  type Page,
  type SavedView,
  type SavedViewStore,
  type ScheduledJob,
  type SoftDeletePrimitive,
  type SoftDeleteRepository,
  type TaskRecordStatus,
  type TaskStore,
  type ViewEntity,
  type WorkflowRunStore,
  type WorkspaceDirectoryStore,
  savedViewCreateInputSchema,
  savedViewUpdateInputSchema,
  viewEntitySchema,
  customTemplateCreateInputSchema,
  customTemplateUpdateInputSchema,
  extractionSpecToBlocks,
} from '@use-brian/core'
import { getRecording } from '../db/recordings-store.js'
import type { WorkspaceStore } from '../db/workspace-store.js'
import type { PageTemplateStore } from '../db/page-templates-store.js'
import type { BlueprintRecordStore } from '../db/blueprint-records-store.js'
import { createRecordPageProjector } from '../synthesis/synthesize.js'
import { getWorkspaceMembershipWithClearanceSystem } from '../db/workspace-store.js'
import type { PageGrantStore } from '../db/page-grant-store.js'
import type { WorkspaceGroupStore } from '../db/workspace-group-store.js'
import { publishPageShareChange } from '../page-share-fanout.js'
import { renderPublicPage } from './_public-render.js'
import { runDocAutoTitle } from '../doc/auto-title.js'

export type ViewsRouteOptions = {
  savedViewStore: SavedViewStore
  taskStore: TaskStore
  crmStore: CrmStore
  workflowRunStore: WorkflowRunStore
  workspaceStore: WorkspaceStore
  /**
   * Phase 1 (Notion-feel) — bindings call `batchGet` here to resolve
   * `tasks.assignee_id` UUIDs to PersonWidget cells.
   */
  workspaceDirectory: WorkspaceDirectoryStore
  /**
   * Phase 3 (Notion-feel) — `DELETE /:entity/:id` routes the data-block
   * row-delete action through the D.4 universal soft-delete contract
   * (`valid_to = now()`), the same path `deleteBrainRow` uses. Bi-temporal
   * soft-delete (not a hard `DELETE`) keeps the supersession chain and the
   * `correction_audit` trail intact.
   */
  softDeleteStore: SoftDeleteRepository
  /**
   * Auto-title (migration 218). The `POST /saved-views/:id/auto-title`
   * endpoint — the human edit trigger — reads the merged page via
   * `docPageStore` and generates a title with `provider`. Both optional:
   * when unset the endpoint returns 503 (the route is still mounted, just
   * inert). `apps/api` wires them; other consumers needn't.
   */
  provider?: LLMProvider
  docPageStore?: DocPageStore
  /**
   * Scheduled-jobs store (migration 229). When wired, `GET /views/:id`
   * attaches the page's `scheduledJobs` — the owner's enabled jobs that
   * target this page — so the doc page header can show a schedule badge
   * ("this page refreshes daily at 07:00"). Optional: when absent the field
   * is an empty array (apps/web doesn't surface the badge). See
   * docs/architecture/engine/scheduled-jobs.md → "Doc page target".
   */
  jobStore?: JobStore
  /**
   * Page sharing (migration 249). When wired, the `POST /views/:id/share`,
   * `GET /views/:id/grants`, `DELETE /views/:id/grants/:grantId`, and
   * `GET /views/:id/public-preview` routes are live. Optional: when absent
   * the share routes return 503 (sharing not configured).
   */
  pageGrantStore?: PageGrantStore
  /**
   * Custom domains + page slugs (migration 324). When wired, the
   * `GET /views/:id/site`, domain-attach/check/detach, and slug routes are
   * live; when absent they return 503. `domainProvisioner` handles DNS
   * instructions + verification (manual or Vercel — see
   * docs/architecture/features/custom-domains.md → "Provisioner seam").
   */
  pageDomainStore?: PageDomainStore
  domainProvisioner?: DomainProvisioner
  /** Per-workspace attached-domain cap (default 5). */
  pageDomainsMaxPerWorkspace?: number
  /** Hostnames a customer may not attach (exact hosts or `.suffix` entries).
   *  Config, never code: boot derives the deployment's own origin hosts and
   *  appends `PAGE_DOMAIN_BLOCKED_HOSTS`. */
  pageDomainBlockedHosts?: string[]
  /**
   * Workspace groups (migration 252) — backs the Share-tab "Groups" + the
   * member/group pickers. Optional: when absent the group routes return 503.
   */
  workspaceGroupStore?: WorkspaceGroupStore
  /**
   * Audit logger for `page_shared` / `page_unshared` events. Optional —
   * fire-and-forget when present.
   */
  analytics?: AnalyticsLogger
  /**
   * User-defined entity store (Phase B — editable custom tables). When wired,
   * a `{ entity: 'custom', entityTypeId }` data block resolves through
   * `buildCustomEntityTable`. Optional: when absent a custom binding renders an
   * empty table. The companion write side is `routes/doc-entities.ts`.
   */
  docEntityStore?: DocEntityStore
  /**
   * Doc import → brain (the `target: 'brain' | 'both'` import path). Optional
   * callback that hands an imported document's extracted text to Pipeline B
   * (the same `ingestToBrain` decompose path). When absent, a `brain`-target
   * import returns 503 and a `both`-target import creates the page and reports
   * `brainIngested: false` — a `page`-target import is unaffected. Wiring it
   * needs workspace-assistant + clearance resolution; see
   * docs/architecture/features/doc-conversion.md.
   */
  ingestDocument?: (args: {
    userId: string
    workspaceId: string
    text: string
    sourceLabel: string
  }) => Promise<void>
  /**
   * Doc-page → brain distillation (the "Sync to brain" pipeline). Backs the
   * manual `POST /saved-views/:id/ingest` route — RLS-checked, then runs the
   * runner in the BACKGROUND (never blocks the response). Optional: when absent
   * (minimal / open build with no Pipeline B), the route returns 503. The auto-
   * on-save path uses the separate `/internal/ingest-page` endpoint, not this
   * route. See docs/architecture/brain/ingest-pipeline.md.
   */
  ingestPage?: (args: { userId: string; pageId: string }) => Promise<void>
  /**
   * Custom page templates (migration 281). When wired, the four
   * `/workspaces/:wid/page-templates*` routes are live — workspace-shared,
   * user-authored templates that the gallery merges with the built-in
   * `PAGE_TEMPLATES` catalog. Optional: when absent the routes return 503.
   * See docs/architecture/features/doc-templates.md -> "Custom templates".
   */
  pageTemplateStore?: PageTemplateStore
  /**
   * Blueprint records (migration 307) — the typed output rows of the blueprint
   * contract. When wired (together with `docPageStore` for the open-as-page
   * projection), the `/workspaces/:wid/blueprints/:bid/records` list + the
   * `/workspaces/:wid/blueprint-records/:rid/page` projection routes are live.
   * Optional: when absent the routes return 503.
   * See docs/architecture/brain/structural-synthesis.md → "The record".
   */
  blueprintRecordStore?: BlueprintRecordStore
}

/**
 * Page-view projection of a scheduled job that maintains this page (migration
 * 229). Only the fields the doc schedule badge needs: the structured
 * `schedule` (client formats the cadence via i18n), the next/last run, the
 * last outcome, and a short instruction summary. Deliberately excludes channel
 * / nag / workflow internals — the badge is informational, the job is managed
 * through the assistant.
 */
function scheduledJobSummary(job: ScheduledJob) {
  return {
    id: job.id,
    schedule: job.schedule,
    nextRunAt: job.nextRunAt.toISOString(),
    lastRunAt: job.lastRunAt ? job.lastRunAt.toISOString() : null,
    lastStatus: job.lastStatus,
    // Truncate so a long instruction can't bloat the metadata payload; the
    // full instruction lives on the job and is managed through chat.
    summary: job.instructions.slice(0, 160),
  }
}

function unauthorized(res: import('express').Response): void {
  res.status(401).json({ error: 'Unauthorized' })
}

function notMember(res: import('express').Response): void {
  res.status(403).json({ error: 'Not a member of this workspace' })
}

function notFound(res: import('express').Response, what = 'Not found'): void {
  res.status(404).json({ error: what })
}

function badRequest(res: import('express').Response, message: string): void {
  res.status(400).json({ error: message })
}

/** Strip path-hostile + control chars from a page title for a download
 *  filename; fall back to 'document' when nothing usable remains. */
function safeFilename(title: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = title.replace(/[\\/?%*:|"<> -]/g, '').trim().slice(0, 100)
  return cleaned || 'document'
}

function buildBindingDeps(
  opts: ViewsRouteOptions,
  userId: string,
  workspaceId: string,
): BindingDeps {
  return {
    taskStore: opts.taskStore,
    crmStore: opts.crmStore,
    workflowRunStore: opts.workflowRunStore,
    workspaceDirectory: opts.workspaceDirectory,
    docEntityStore: opts.docEntityStore,
    userId,
    workspaceId,
  }
}

function viewMetadata(view: SavedView) {
  return {
    id: view.id,
    workspaceId: view.workspaceId,
    createdBy: view.createdBy,
    name: view.name,
    // Title provenance (migration 218). The doc client reads this to
    // decide whether the human auto-title trigger is still armed
    // (`'placeholder'`) or frozen (`'auto'`/`'user'`).
    nameOrigin: view.nameOrigin,
    description: view.description,
    icon: view.icon ?? null,
    entity: view.entity,
    viewType: view.viewType,
    state: view.state,
    nestParentId: view.nestParentId ?? null,
    position: view.position ?? 0,
    // Teamspace placement (migration 313). Null = private to the creator.
    // The sidebar groups sections by this; drag-to-section writes it via
    // /views/:id/reparent.
    teamspaceId: view.teamspaceId ?? null,
    // Notion-style per-page width mode (migration 220). The doc client
    // reads this to pick the body wrapper width (full vs constrained column).
    fullWidth: view.fullWidth ?? false,
    // Page-level clearance (migration 212). The doc page-header pill
    // shows/sets it; gates page-open at doc-sync.
    clearance: view.clearance ?? 'internal',
    // The page's genesis prompt (migration 231) — the doc History panel
    // shows it read-only as the "first prompt". Null when the page wasn't
    // created from a chat turn.
    originPrompt: view.originPrompt ?? null,
    autoPruneAt: view.autoPruneAt ? view.autoPruneAt.toISOString() : null,
    // Per-page "Sync to brain" toggle (migration 001_doc_brain_sync). The doc
    // page-header ⋯ menu reads it to reflect the switch state.
    brainSyncEnabled: view.brainSyncEnabled ?? false,
    // True while an interactive draft still owes its deferred `created`
    // page-event (migration 283). The doc client arms the commit watcher when
    // this is set — debounced typing or a navigate-away flush fires the event
    // once via POST /views/:id/commit-created. Re-read on reload so a
    // refreshed-but-uncommitted draft re-arms instead of going stale.
    createdEventPending: view.createdEventPending ?? false,
    // Stable cross-run identity (`saved_views.anchor_key`). The doc client
    // needs it to know a page was SYNTHESIZED FROM something: a recording
    // brief's key is `recording-synthesis:<recordingId>`, and that string is
    // the page's only link back to the recording it was written from. Without
    // it the recording chrome cannot mount and the page's `[H:MM:SS]`
    // citations have nothing to seek — the store has always projected it, this
    // whitelist just never forwarded it. See recordings.md → "The brief page
    // IS the recording surface".
    anchorKey: view.anchorKey ?? null,
    // A manually-linked recording (migration 339). The doc client resolves the
    // anchorKey recording first and falls back to this, so a hand-authored page
    // can surface an existing recording's player/transcript/action items. Same
    // whitelist lesson as `anchorKey`: the store projects it, but this response
    // is hand-maintained, so a field the client relies on must be listed here
    // or it silently never crosses the wire.
    linkedRecordingId: view.linkedRecordingId ?? null,
    page: view.page,
    createdAt: view.createdAt.toISOString(),
    updatedAt: view.updatedAt.toISOString(),
  }
}

/**
 * Resolve a SavedView to a renderable `Page`. New-model rows have
 * `page` populated by migration 184; if a row somehow lacks one, fall
 * back to wrapping the legacy `binding` as a single data block so the
 * read path doesn't degrade to an empty container.
 */
function pageOf(view: SavedView): Page {
  if (view.page) return view.page
  return {
    blocks: [
      {
        kind: 'data',
        id: view.id, // stable fallback; pre-migration rows never get re-ordered
        binding: view.binding,
      },
    ],
  }
}

export function viewsRoutes(opts: ViewsRouteOptions): Router {
  const router = Router()

  // ── Custom page templates (migration 281) ────────────────────────────
  // Workspace-shared, user-authored templates. The gallery merges these with
  // the built-in PAGE_TEMPLATES catalog; both authoring paths ("Save as
  // template" and "New template") POST a block snapshot. Optional store: when
  // unwired the four routes return 503. See doc-templates.md -> "Custom templates".

  // GET /workspaces/:workspaceId/page-templates — list custom templates (summaries)
  router.get('/workspaces/:workspaceId/page-templates', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    if (!opts.pageTemplateStore) return res.status(503).json({ error: 'Custom templates not configured' })
    const workspaceId = req.params.workspaceId
    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) return notMember(res)
    const templates = await opts.pageTemplateStore.list(userId, workspaceId)
    res.json({ templates })
  })

  // GET /workspaces/:workspaceId/page-templates/:id — one template, with blocks
  router.get('/workspaces/:workspaceId/page-templates/:id', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    if (!opts.pageTemplateStore) return res.status(503).json({ error: 'Custom templates not configured' })
    const role = await opts.workspaceStore.getRole(userId, req.params.workspaceId)
    if (!role) return notMember(res)
    const template = await opts.pageTemplateStore.getById(userId, req.params.id)
    if (!template || template.workspaceId !== req.params.workspaceId) return notFound(res, 'Template not found')
    res.json({ template })
  })

  // POST /workspaces/:workspaceId/page-templates — create (both authoring paths)
  router.post('/workspaces/:workspaceId/page-templates', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    if (!opts.pageTemplateStore) return res.status(503).json({ error: 'Custom templates not configured' })
    const workspaceId = req.params.workspaceId
    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) return notMember(res)
    const parsed = customTemplateCreateInputSchema.safeParse(req.body)
    if (!parsed.success) return badRequest(res, `Invalid template: ${parsed.error.message}`)
    const template = await opts.pageTemplateStore.create(userId, { workspaceId, ...parsed.data })
    res.status(201).json({ template })
  })

  // PATCH /workspaces/:workspaceId/page-templates/:id — partial update (the
  // blueprint detail editor + the WYSIWYG re-save path). An `extraction` patch
  // with no `blocks` regenerates the authoring skeleton so the doc round-trip
  // (blocksToExtractionSpec) stays consistent. See structural-synthesis.md ->
  // "The blueprint detail editor".
  router.patch('/workspaces/:workspaceId/page-templates/:id', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    if (!opts.pageTemplateStore) return res.status(503).json({ error: 'Custom templates not configured' })
    const role = await opts.workspaceStore.getRole(userId, req.params.workspaceId)
    if (!role) return notMember(res)
    const existing = await opts.pageTemplateStore.getById(userId, req.params.id)
    if (!existing || existing.workspaceId !== req.params.workspaceId) return notFound(res, 'Template not found')
    const parsed = customTemplateUpdateInputSchema.safeParse(req.body)
    if (!parsed.success) return badRequest(res, `Invalid template patch: ${parsed.error.message}`)
    const patch = { ...parsed.data }
    if (patch.extraction && patch.blocks === undefined) {
      patch.blocks = extractionSpecToBlocks(patch.extraction)
    }
    const template = await opts.pageTemplateStore.update(userId, req.params.id, patch)
    if (!template) return notFound(res, 'Template not found')
    res.json({ template })
  })

  // DELETE /workspaces/:workspaceId/page-templates/:id
  router.delete('/workspaces/:workspaceId/page-templates/:id', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    if (!opts.pageTemplateStore) return res.status(503).json({ error: 'Custom templates not configured' })
    const role = await opts.workspaceStore.getRole(userId, req.params.workspaceId)
    if (!role) return notMember(res)
    const removed = await opts.pageTemplateStore.remove(userId, req.params.id)
    if (!removed) return notFound(res, 'Template not found')
    res.json({ ok: true })
  })

  // ── Blueprint records (migration 307) ────────────────────────────────
  // The typed output rows a blueprint's fills/saves produce. The page is a
  // per-surface PROJECTION of the record — the open-as-page route below
  // renders it on demand for records that have none.
  // See structural-synthesis.md → "The record".

  // GET /workspaces/:workspaceId/blueprints/:blueprintId/records — newest first
  router.get('/workspaces/:workspaceId/blueprints/:blueprintId/records', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    if (!opts.blueprintRecordStore) return res.status(503).json({ error: 'Blueprint records not configured' })
    const { workspaceId, blueprintId } = req.params
    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) return notMember(res)
    const records = await opts.blueprintRecordStore.listForBlueprint(userId, workspaceId, blueprintId)
    res.json({
      records: records.map((r) => ({
        id: r.id,
        subject: r.subject,
        status: r.status,
        missing: r.missing,
        fields: r.fields,
        specSnapshot: r.specSnapshot,
        sourceKind: r.sourceKind,
        pageId: r.pageId,
        updatedAt: r.updatedAt,
      })),
    })
  })

  // POST /workspaces/:workspaceId/blueprint-records/:recordId/page — open as page.
  // Idempotent: an existing projection re-renders in place (same page); a
  // pageless record mints its page on the record's own anchor key.
  router.post('/workspaces/:workspaceId/blueprint-records/:recordId/page', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    if (!opts.blueprintRecordStore || !opts.docPageStore) {
      return res.status(503).json({ error: 'Blueprint records not configured' })
    }
    const { workspaceId, recordId } = req.params
    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) return notMember(res)
    const record = await opts.blueprintRecordStore.getById(userId, recordId)
    if (!record || record.workspaceId !== workspaceId) return notFound(res, 'Record not found')

    // Find-or-create the page on the record's anchor (23505-converge, the
    // same identity a fill with renderPage would use), then project.
    let pageId = record.pageId
    if (!pageId) {
      pageId = await opts.savedViewStore.findIdByAnchorKey(userId, workspaceId, record.anchorKey)
    }
    if (!pageId) {
      try {
        const draft = await opts.savedViewStore.createDraft({
          userId,
          workspaceId,
          name: record.subject,
          nameOrigin: 'placeholder',
          entity: 'tasks',
          viewType: 'table',
          binding: { entity: 'tasks', viewType: 'table' },
          page: { blocks: [] },
          anchorKey: record.anchorKey,
          originPrompt: `blueprint record: ${record.subject}`,
        })
        pageId = draft.id
      } catch {
        pageId = await opts.savedViewStore.findIdByAnchorKey(userId, workspaceId, record.anchorKey)
      }
    }
    if (!pageId) return res.status(500).json({ error: 'Could not create the page' })

    const project = createRecordPageProjector(opts.docPageStore)
    const projected = await project({
      userId,
      pageId,
      blocks: blueprintRecordToBlocks(record.specSnapshot, record.fields, () => randomUUID()),
    })
    if (!projected) {
      // The page exists but the CAS write lost twice — the record still holds
      // the data; the client can retry.
      return res.status(409).json({ error: 'Page is being edited; try again' })
    }
    await opts.blueprintRecordStore.finalize(userId, record.id, {
      status: record.status,
      missing: record.missing,
      pageId,
    })
    res.json({ pageId })
  })

  // ── Saved-views CRUD (legacy single-binding paths) ───────────────────

  // GET /workspaces/:workspaceId/saved-views?entity=&state=
  router.get('/workspaces/:workspaceId/saved-views', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    const workspaceId = req.params.workspaceId

    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) return notMember(res)

    const entityParam = typeof req.query.entity === 'string' ? req.query.entity : undefined
    let entity: ViewEntity | undefined
    if (entityParam) {
      const parsed = viewEntitySchema.safeParse(entityParam)
      if (!parsed.success) return badRequest(res, `Invalid entity: ${entityParam}`)
      entity = parsed.data
    }

    const stateParam = typeof req.query.state === 'string' ? req.query.state : undefined
    let state: 'draft' | 'saved' | 'all' | undefined
    if (stateParam) {
      if (stateParam !== 'draft' && stateParam !== 'saved' && stateParam !== 'all') {
        return badRequest(res, `Invalid state: ${stateParam}`)
      }
      state = stateParam
    }

    const rows = await opts.savedViewStore.list({
      userId,
      workspaceId,
      entity,
      state,
    })
    res.json({
      savedViews: rows.map((r) => ({
        id: r.id,
        workspaceId: r.workspaceId,
        name: r.name,
        // Title provenance (migration 218) — the doc client reads it to
        // show a generic "draft" glyph + the auto-title hint animation on a
        // fresh `'placeholder'` row, instead of the entity-derived glyph.
        nameOrigin: r.nameOrigin,
        description: r.description,
        icon: r.icon ?? null,
        entity: r.entity,
        viewType: r.viewType,
        state: r.state,
        nestParentId: r.nestParentId ?? null,
        position: r.position ?? 0,
        // Teamspace placement (migration 313). The sidebar groups its
        // sections from this — omit it and every page collapses into the
        // Private group (all teamspaces render empty), and a drag into a
        // teamspace never sticks across the reload.
        teamspaceId: r.teamspaceId ?? null,
        updatedAt: r.updatedAt.toISOString(),
      })),
    })
  })

  // POST /workspaces/:workspaceId/saved-views
  router.post('/workspaces/:workspaceId/saved-views', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    const workspaceId = req.params.workspaceId

    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) return notMember(res)

    const parsed = savedViewCreateInputSchema.safeParse(req.body)
    if (!parsed.success) {
      return badRequest(res, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    }

    const created = await opts.savedViewStore.create({
      userId,
      workspaceId,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      binding: parsed.data.binding,
    })
    res.status(201).json({
      ...viewMetadata(created),
      binding: created.binding,
    })
  })

  // GET /saved-views/:id  — legacy alias for GET /api/views/:id
  router.get('/saved-views/:id', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)

    const view = await opts.savedViewStore.getById(userId, req.params.id)
    if (!view) return notFound(res, 'Saved view not found')
    res.json({
      ...viewMetadata(view),
      binding: view.binding,
    })
  })

  // PATCH /saved-views/:id  — legacy: edits binding (used by the original /views/new editor)
  router.patch('/saved-views/:id', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)

    const parsed = savedViewUpdateInputSchema.safeParse(req.body)
    if (!parsed.success) {
      return badRequest(res, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    }

    // Page-level clearance (migration 212): a member may set a page's clearance
    // only up to their OWN workspace clearance — you can't classify a page more
    // sensitively than you can see (which also stops locking yourself out).
    // canRead(memberClearance, newClearance) is true iff member ≥ new.
    if (parsed.data.clearance !== undefined) {
      const view = await opts.savedViewStore.getById(userId, req.params.id)
      if (!view) return notFound(res, 'Saved view not found')
      const membership = await getWorkspaceMembershipWithClearanceSystem(userId, view.workspaceId)
      if (!membership || !canRead(membership.clearance, parsed.data.clearance)) {
        return res.status(403).json({ error: 'Cannot set a page above your own clearance' })
      }
    }

    // Linking a recording (migration 339): the FK only proves the id is a real
    // recording, not that it belongs to THIS page's workspace or that the
    // caller can see it. `getRecording` runs under the caller's RLS, so a
    // recording in a workspace they are not a member of returns null — reject
    // it rather than let a page point at a recording its viewers can't open.
    // `null` (unlink) skips the check.
    if (parsed.data.linkedRecordingId != null) {
      const view = await opts.savedViewStore.getById(userId, req.params.id)
      if (!view) return notFound(res, 'Saved view not found')
      const rec = await getRecording(userId, parsed.data.linkedRecordingId)
      if (!rec || rec.workspaceId !== view.workspaceId) {
        return res.status(400).json({ error: 'That recording is not in this page’s workspace' })
      }
    }

    // A user-driven rename (inline title / sidebar ⋯ / breadcrumb all PATCH
    // here) freezes the title against auto-title (migration 218). Only stamp
    // when `name` is actually changing — an icon-only PATCH leaves provenance
    // alone. `nameOrigin` isn't part of the client schema, so it's set here.
    const fields =
      parsed.data.name !== undefined
        ? { ...parsed.data, nameOrigin: 'user' as NameOrigin }
        : parsed.data
    const updated = await opts.savedViewStore.update(userId, req.params.id, fields)
    if (!updated) return notFound(res, 'Saved view not found')
    res.json({
      ...viewMetadata(updated),
      binding: updated.binding,
    })
  })

  // DELETE /saved-views/:id
  router.delete('/saved-views/:id', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)

    const removed = await opts.savedViewStore.remove(userId, req.params.id)
    if (!removed) return notFound(res, 'Saved view not found')
    res.json({ ok: true })
  })

  // POST /saved-views/:id/ingest — manual "Sync to brain" trigger. RLS-checks
  // the page is visible to the caller, then runs the doc-page distillation in
  // the BACKGROUND (Pipeline B is async by design) and returns immediately. A
  // failed ingest is logged, never surfaced — the user's click "queued" it.
  router.post('/saved-views/:id/ingest', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    if (!opts.ingestPage) {
      return res.status(503).json({ error: 'Brain ingestion is not configured' })
    }
    // Confirm the page exists + is visible to the caller (and never an
    // ephemeral draft — canvas-brain-distillation.md: "confirms the page is
    // saved"). RLS hides cross-workspace rows, so `getById` is the access gate.
    const view = await opts.savedViewStore.getById(userId, req.params.id)
    if (!view) return notFound(res, 'Saved view not found')
    if (view.state !== 'saved') {
      return res.status(409).json({ error: 'Only a saved page can be synced to the brain' })
    }
    const pageId = req.params.id
    // Fire-and-forget — the response never waits on Pipeline B.
    void opts.ingestPage({ userId, pageId }).catch((err: unknown) => {
      console.error(
        `[views] background ingestPage failed for ${pageId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    })
    res.status(202).json({ queued: true })
  })

  // POST /saved-views/:id/auto-title — the human edit trigger (migration 218).
  // The doc editor fires this once the body crosses the size threshold
  // while the title is still the untouched placeholder. The server re-checks
  // both authoritatively (RLS-scoped read + `name_origin = 'placeholder'` +
  // size floor) and commits via the guarded `setAutoTitle`, so it's safe to
  // call repeatedly: a touched title returns `{ applied: false }`. Overhead
  // cost is not attributed here (no assistant/session context — see doc.md
  // → "Auto-title"). The AI trigger lives in the chat route.
  router.post('/saved-views/:id/auto-title', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    if (!opts.provider || !opts.docPageStore) {
      return res.status(503).json({ error: 'Auto-title is not configured' })
    }
    const result = await runDocAutoTitle({
      userId,
      pageId: req.params.id,
      provider: opts.provider,
      docPageStore: opts.docPageStore,
      savedViewStore: opts.savedViewStore,
      minChars: AUTO_TITLE_MIN_CHARS,
    })
    res.json({ title: result.title, icon: result.icon, applied: result.applied })
  })

  // GET /saved-views/:id/payload  — legacy: builds from binding directly
  router.get('/saved-views/:id/payload', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)

    const view = await opts.savedViewStore.getById(userId, req.params.id)
    if (!view) return notFound(res, 'Saved view not found')

    try {
      const deps = buildBindingDeps(opts, userId, view.workspaceId)
      // Prefer the new page renderer if a page exists, so the legacy
      // alias stays in sync with the new path. Old rows without a page
      // fall back via pageOf().
      const payload = view.page
        ? await renderPage(view.page, deps)
        : await buildPayload(view.binding, deps)
      res.json(payload)
    } catch (err) {
      console.error('[views] payload build failed:', err)
      res.status(500).json({ error: 'Failed to build payload', message: (err as Error).message })
    }
  })

  // ── Notion-redesign — page-model routes ──────────────────────────────

  // GET /views/:id  — page metadata (id, name, state, page, autoPruneAt) +
  // the page's scheduled jobs (migration 229 — drives the schedule badge).
  router.get('/views/:id', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)

    const view = await opts.savedViewStore.getById(userId, req.params.id)
    if (!view) return notFound(res, 'View not found')

    // The page's recurring "research & update this page" schedules. Owner-
    // scoped + enabled-only inside the store. Absent jobStore → empty list.
    const scheduledJobs = opts.jobStore
      ? (await opts.jobStore.listEnabledByView(userId, view.id)).map(scheduledJobSummary)
      : []

    res.json({ ...viewMetadata(view), scheduledJobs })
  })

  // GET /views/:id/payload  — fully rendered A2UI payload via renderPage
  router.get('/views/:id/payload', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)

    const view = await opts.savedViewStore.getById(userId, req.params.id)
    if (!view) return notFound(res, 'View not found')

    try {
      const payload = await renderPage(
        pageOf(view),
        buildBindingDeps(opts, userId, view.workspaceId),
      )
      res.json(payload)
    } catch (err) {
      console.error('[views] page render failed:', err)
      res.status(500).json({ error: 'Failed to build payload', message: (err as Error).message })
    }
  })

  // ── Page sharing (migration 249) ─────────────────────────────────────

  const shareInputSchema = z.object({
    // `view` is fully live (anonymous public render). `comment` / `edit` are
    // recorded on the grant — the access spine (`page_grants.role`) and the
    // resolver already carry the role — and the picker lets the owner select
    // them now (partial Notion parity). External enforcement of comment/edit
    // activates with the deferred guest-identity (comment) and doc-sync
    // write-filter (edit). See docs/plans/doc-page-sharing.md Q5.
    role: z.enum(['view', 'comment', 'edit']).optional(),
    label: z.string().max(120).nullable().optional(),
    indexable: z.boolean().optional(),
    expiresAt: z.string().datetime().nullable().optional(),
    declassify: z.boolean().optional(),
  })

  // Page creator or workspace owner/admin may manage sharing.
  async function canManageShare(userId: string, view: SavedView): Promise<boolean> {
    if (view.createdBy === userId) return true
    const membership = await getWorkspaceMembershipWithClearanceSystem(userId, view.workspaceId)
    return membership?.role === 'owner' || membership?.role === 'admin'
  }

  // POST /views/:id/share — mint an anonymous "anyone with the link" grant.
  // Publishing requires the page be public (explicit declassify confirm).
  router.post('/views/:id/share', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    if (!opts.pageGrantStore) return res.status(503).json({ error: 'Sharing is not configured' })

    const parsed = shareInputSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return badRequest(res, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    }

    const view = await opts.savedViewStore.getById(userId, req.params.id)
    if (!view) return notFound(res, 'View not found')
    if (!(await canManageShare(userId, view))) {
      return res.status(403).json({ error: 'Only the page owner or a workspace admin can share this page' })
    }

    // Publishing is an explicit declassification — the page must be public.
    if (view.clearance !== 'public') {
      if (!parsed.data.declassify) {
        return res.status(409).json({ error: 'Page must be public to share externally', code: 'not_public' })
      }
      await opts.savedViewStore.update(userId, view.id, { clearance: 'public' })
    }

    const { grant, token } = await opts.pageGrantStore.createLinkGrant({
      userId,
      pageId: view.id,
      role: parsed.data.role ?? 'view',
      label: parsed.data.label ?? null,
      indexable: parsed.data.indexable ?? false,
      expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
    })

    opts.analytics?.logEvent({
      userId,
      eventName: 'page_shared',
      metadata: { role: sanitize(grant.role), indexable: grant.indexable, has_expiry: Boolean(grant.expiresAt) },
    })

    res.status(201).json({ grant, token, sharePath: `/share/${token}` })
  })

  // GET /views/:id/grants — list the page's live link grants (no token hashes).
  router.get('/views/:id/grants', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    if (!opts.pageGrantStore) return res.status(503).json({ error: 'Sharing is not configured' })
    const view = await opts.savedViewStore.getById(userId, req.params.id)
    if (!view) return notFound(res, 'View not found')
    const [grants, identityGrants, publish] = await Promise.all([
      opts.pageGrantStore.listGrants(userId, view.id),
      opts.pageGrantStore.listIdentityGrants(userId, view.id),
      opts.pageGrantStore.getPublishState(userId, view.id),
    ])
    res.json({ grants, identityGrants, publish })
  })

  // POST /views/:id/publish — publish the page to one universal web URL
  // (`/share/p/:pageId`). Idempotent: one active `published` grant per page.
  // Publishing declassifies the page to `clearance='public'`.
  router.post('/views/:id/publish', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    if (!opts.pageGrantStore) return res.status(503).json({ error: 'Sharing is not configured' })
    const indexable = Boolean((req.body ?? {}).indexable)
    const view = await opts.savedViewStore.getById(userId, req.params.id)
    if (!view) return notFound(res, 'View not found')
    if (!(await canManageShare(userId, view))) {
      return res.status(403).json({ error: 'Only the page owner or a workspace admin can publish this page' })
    }
    if (view.clearance !== 'public') {
      await opts.savedViewStore.update(userId, view.id, { clearance: 'public' })
    }
    await opts.pageGrantStore.publishPage({ userId, pageId: view.id, indexable })
    opts.analytics?.logEvent({ userId, eventName: 'page_published', metadata: { indexable } })
    publishPageShareChange(view.id)
    res.json({ published: true, indexable })
  })

  // POST /views/:id/unpublish — revoke the page's published web URL.
  router.post('/views/:id/unpublish', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    if (!opts.pageGrantStore) return res.status(503).json({ error: 'Sharing is not configured' })
    const view = await opts.savedViewStore.getById(userId, req.params.id)
    if (!view) return notFound(res, 'View not found')
    if (!(await canManageShare(userId, view))) {
      return res.status(403).json({ error: 'Only the page owner or a workspace admin can unpublish this page' })
    }
    await opts.pageGrantStore.unpublishPage(userId, view.id)
    publishPageShareChange(view.id)
    res.json({ published: false })
  })

  // ── Custom domains + page slugs (migration 324) ──────────────────────
  // docs/architecture/features/custom-domains.md. A domain fronts a
  // PUBLISHED page's subtree; slugs are domain-scoped pretty paths.

  // GET /views/:id/site — Publish-tab state: domains attached to THIS page,
  // plus this page's position under any domain-fronted ancestor (the slug
  // editor's context). `sites[0]` is the nearest.
  router.get('/views/:id/site', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    if (!opts.pageDomainStore) return res.status(503).json({ error: 'Custom domains are not configured' })
    const view = await opts.savedViewStore.getById(userId, req.params.id)
    if (!view) return notFound(res, 'View not found')
    const [domains, context] = await Promise.all([
      opts.pageDomainStore.listDomainsForPage(userId, view.id),
      opts.pageDomainStore.getSiteContext(userId, view.id),
    ])
    const sites = await Promise.all(
      context.map(async ({ domain, depth, currentSlug }) => {
        const isRoot = depth === 0
        let suggestedSlug: string | null = null
        if (!isRoot && !currentSlug) {
          const taken = new Set(await opts.pageDomainStore!.listSlugs(userId, domain.id))
          suggestedSlug = suggestPageSlug(view.name ?? '', taken)
        }
        return {
          domainId: domain.id,
          hostname: domain.hostname,
          status: domain.status,
          rootPageId: domain.pageId,
          isRoot,
          slug: currentSlug,
          suggestedSlug,
        }
      }),
    )
    res.json({ domains, sites })
  })

  const domainInputSchema = z.object({ hostname: z.string().min(1).max(300) })

  // POST /views/:id/domains — attach a custom hostname to this (published)
  // page. Provisions edge/TLS on the hosted path; returns DNS instructions.
  router.post('/views/:id/domains', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    if (!opts.pageDomainStore || !opts.domainProvisioner) {
      return res.status(503).json({ error: 'Custom domains are not configured' })
    }
    const parsed = domainInputSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return badRequest(res, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    }
    const view = await opts.savedViewStore.getById(userId, req.params.id)
    if (!view) return notFound(res, 'View not found')
    if (!(await canManageShare(userId, view))) {
      return res.status(403).json({ error: 'Only the page owner or a workspace admin can manage domains' })
    }
    const hostname = normalizeHostname(parsed.data.hostname, {
      block: opts.pageDomainBlockedHosts,
    })
    if (!hostname) {
      // Well-formed but blocked (our own origin / a subdomain of our apex /
      // operator policy) vs. genuinely malformed — distinct codes so the UI can
      // explain a reserved host instead of "enter a valid hostname".
      if (normalizeHostname(parsed.data.hostname)) {
        return res.status(400).json({
          error: 'This hostname is reserved and cannot be attached as a custom domain',
          code: 'blocked_hostname',
        })
      }
      return res.status(400).json({ error: 'Not a usable public hostname', code: 'invalid_hostname' })
    }
    if (opts.pageGrantStore) {
      const publish = await opts.pageGrantStore.getPublishState(userId, view.id)
      if (!publish.published) {
        return res.status(409).json({ error: 'Publish the page before attaching a domain', code: 'not_published' })
      }
    }
    const cap = opts.pageDomainsMaxPerWorkspace ?? 5
    const count = await opts.pageDomainStore.countDomainsForWorkspace(userId, view.workspaceId)
    if (count >= cap) {
      return res.status(409).json({ error: `Workspace domain limit reached (${cap})`, code: 'domain_limit' })
    }
    const created = await opts.pageDomainStore.createDomain({
      userId,
      workspaceId: view.workspaceId,
      pageId: view.id,
      hostname,
      provider: opts.domainProvisioner.kind,
    })
    if ('error' in created) {
      return res.status(409).json({ error: 'This hostname is already connected', code: 'hostname_taken' })
    }
    let domain = created
    let instructions: unknown[] = []
    try {
      instructions = (await opts.domainProvisioner.add(hostname)).instructions
    } catch (err) {
      console.error('[views] domain provisioning failed:', err)
      domain =
        (await opts.pageDomainStore.updateDomainStatus(userId, created.id, {
          status: 'error',
          verificationError: (err as Error).message,
        })) ?? created
    }
    opts.analytics?.logEvent({
      userId,
      eventName: 'page_domain_added',
      metadata: { provider: sanitize(domain.provider) },
    })
    res.status(201).json({ domain, instructions })
  })

  // POST /views/:id/domains/:domainId/check — re-run DNS/ownership
  // verification and refresh the stored status.
  router.post('/views/:id/domains/:domainId/check', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    if (!opts.pageDomainStore || !opts.domainProvisioner) {
      return res.status(503).json({ error: 'Custom domains are not configured' })
    }
    const domain = await opts.pageDomainStore.getDomain(userId, req.params.domainId)
    if (!domain || domain.pageId !== req.params.id) return notFound(res, 'Domain not found')
    const result = await opts.domainProvisioner.check(domain.hostname)
    const updated = await opts.pageDomainStore.updateDomainStatus(userId, domain.id, {
      status: result.live ? 'live' : 'pending_dns',
      verificationError: result.error,
    })
    res.json({ domain: updated ?? domain, live: result.live, instructions: result.instructions })
  })

  // DELETE /views/:id/domains/:domainId — detach. Deprovisioning is
  // best-effort; the row delete (cascading slugs) is the source of truth.
  router.delete('/views/:id/domains/:domainId', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    if (!opts.pageDomainStore) return res.status(503).json({ error: 'Custom domains are not configured' })
    const view = await opts.savedViewStore.getById(userId, req.params.id)
    if (!view) return notFound(res, 'View not found')
    if (!(await canManageShare(userId, view))) {
      return res.status(403).json({ error: 'Only the page owner or a workspace admin can manage domains' })
    }
    const domain = await opts.pageDomainStore.getDomain(userId, req.params.domainId)
    if (!domain || domain.pageId !== view.id) return notFound(res, 'Domain not found')
    await opts.domainProvisioner?.remove(domain.hostname).catch((err) => {
      console.warn('[views] domain deprovision failed:', err)
    })
    await opts.pageDomainStore.deleteDomain(userId, domain.id)
    opts.analytics?.logEvent({ userId, eventName: 'page_domain_removed', metadata: {} })
    publishPageShareChange(view.id)
    res.json({ deleted: true })
  })

  const slugInputSchema = z.object({
    domainId: z.string().uuid(),
    slug: z.string().min(1).max(64),
  })

  // PUT /views/:id/slug — set/replace this page's slug on a domain. The old
  // slug stays behind as a 301 source (history swap in the store).
  router.put('/views/:id/slug', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    if (!opts.pageDomainStore) return res.status(503).json({ error: 'Custom domains are not configured' })
    const parsed = slugInputSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return badRequest(res, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    }
    const view = await opts.savedViewStore.getById(userId, req.params.id)
    if (!view) return notFound(res, 'View not found')
    if (!(await canManageShare(userId, view))) {
      return res.status(403).json({ error: 'Only the page owner or a workspace admin can edit the page link' })
    }
    if (!isValidPageSlug(parsed.data.slug)) {
      return res.status(400).json({ error: 'Not a usable slug', code: 'invalid_slug' })
    }
    const result = await opts.pageDomainStore.setSlug({
      userId,
      domainId: parsed.data.domainId,
      pageId: view.id,
      slug: parsed.data.slug,
    })
    if (!result.ok) {
      const status = result.reason === 'domain_not_found' ? 404 : result.reason === 'slug_taken' ? 409 : 400
      return res.status(status).json({ error: 'Could not set the page link', code: result.reason })
    }
    const domain = await opts.pageDomainStore.getDomain(userId, parsed.data.domainId)
    opts.analytics?.logEvent({ userId, eventName: 'page_slug_set', metadata: {} })
    publishPageShareChange(view.id)
    if (domain) publishPageShareChange(domain.pageId)
    res.json({ slug: result.slug, previousSlug: result.previousSlug })
  })

  // GET /views/:id/slug-availability?domainId&slug — the debounced editor
  // check. `current` marks "this page already holds it".
  router.get('/views/:id/slug-availability', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    if (!opts.pageDomainStore) return res.status(503).json({ error: 'Custom domains are not configured' })
    const domainId = typeof req.query.domainId === 'string' ? req.query.domainId : ''
    const slug = typeof req.query.slug === 'string' ? req.query.slug : ''
    if (!domainId || !slug) return badRequest(res, 'domainId and slug are required')
    const valid = isValidPageSlug(slug)
    const holder = valid ? await opts.pageDomainStore.getSlugHolder(userId, domainId, slug) : null
    const available = valid && (!holder || holder.pageId === req.params.id)
    const current = Boolean(holder && holder.pageId === req.params.id && holder.isCurrent)
    res.json({ valid, available, current })
  })

  const identityGrantSchema = z.object({
    principalType: z.enum(['user', 'group', 'workspace']),
    principalRef: z.string().min(1),
    role: z.enum(['view', 'comment', 'edit', 'full']),
  })

  // POST /views/:id/grants — invite a member/group at a role, or set the
  // workspace-default ("General access") role. Phase 3 (§13 D1). Manager-gated.
  router.post('/views/:id/grants', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    if (!opts.pageGrantStore) return res.status(503).json({ error: 'Sharing is not configured' })
    const parsed = identityGrantSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return badRequest(res, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    }
    const view = await opts.savedViewStore.getById(userId, req.params.id)
    if (!view) return notFound(res, 'View not found')
    if (!(await canManageShare(userId, view))) {
      return res.status(403).json({ error: 'Only the page owner or a workspace admin can manage sharing' })
    }
    // A workspace grant always targets THIS page's workspace (the General
    // access row); user/group refs are passed through.
    const principalRef = parsed.data.principalType === 'workspace' ? view.workspaceId : parsed.data.principalRef
    const grant = await opts.pageGrantStore.upsertIdentityGrant({
      userId,
      pageId: view.id,
      principalType: parsed.data.principalType,
      principalRef,
      role: parsed.data.role,
    })
    opts.analytics?.logEvent({
      userId,
      eventName: 'page_grant_set',
      metadata: { principal_type: sanitize(parsed.data.principalType), role: sanitize(parsed.data.role) },
    })
    publishPageShareChange(view.id)
    res.status(201).json({ grant })
  })

  // PATCH /views/:id/grants/:grantId — change a grant's role. Manager-gated.
  router.patch('/views/:id/grants/:grantId', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    if (!opts.pageGrantStore) return res.status(503).json({ error: 'Sharing is not configured' })
    const role = (req.body ?? {}).role
    if (role !== 'view' && role !== 'comment' && role !== 'edit' && role !== 'full') {
      return badRequest(res, 'role must be one of view|comment|edit|full')
    }
    const view = await opts.savedViewStore.getById(userId, req.params.id)
    if (!view) return notFound(res, 'View not found')
    if (!(await canManageShare(userId, view))) {
      return res.status(403).json({ error: 'Only the page owner or a workspace admin can manage sharing' })
    }
    const ok = await opts.pageGrantStore.updateGrantRole(userId, req.params.grantId, role)
    if (!ok) return notFound(res, 'Grant not found')
    publishPageShareChange(view.id)
    res.json({ ok: true })
  })

  // DELETE /views/:id/grants/:grantId — revoke a link (instant unshare).
  router.delete('/views/:id/grants/:grantId', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    if (!opts.pageGrantStore) return res.status(503).json({ error: 'Sharing is not configured' })
    const view = await opts.savedViewStore.getById(userId, req.params.id)
    if (!view) return notFound(res, 'View not found')
    if (!(await canManageShare(userId, view))) {
      return res.status(403).json({ error: 'Only the page owner or a workspace admin can manage sharing' })
    }
    const ok = await opts.pageGrantStore.revokeGrant(userId, req.params.grantId)
    if (!ok) return notFound(res, 'Grant not found')
    opts.analytics?.logEvent({ userId, eventName: 'page_unshared', metadata: {} })
    publishPageShareChange(view.id)
    res.json({ ok: true })
  })

  // ── Share-tab pickers + groups (Phase 3) — page-scoped to avoid path
  //    collisions; the dialog already holds the pageId. ──────────────────

  // GET /views/:id/shareable-members — workspace members (users.id) for the picker.
  router.get('/views/:id/shareable-members', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    const view = await opts.savedViewStore.getById(userId, req.params.id)
    if (!view) return notFound(res, 'View not found')
    const members = await opts.workspaceStore.listMembers(userId, view.workspaceId)
    res.json({
      members: members.map((m) => ({
        userId: m.userId,
        name: m.userName ?? null,
        email: m.email ?? null,
        avatarUrl: m.avatarUrl ?? null,
      })),
    })
  })

  // GET /views/:id/groups — workspace groups (for the Groups tab + picker).
  router.get('/views/:id/groups', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    if (!opts.workspaceGroupStore) return res.status(503).json({ error: 'Groups not configured' })
    const view = await opts.savedViewStore.getById(userId, req.params.id)
    if (!view) return notFound(res, 'View not found')
    const groups = await opts.workspaceGroupStore.listGroups(userId, view.workspaceId)
    res.json({ groups })
  })

  // POST /views/:id/groups { name } — create a workspace group (owner/admin).
  router.post('/views/:id/groups', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    if (!opts.workspaceGroupStore) return res.status(503).json({ error: 'Groups not configured' })
    const view = await opts.savedViewStore.getById(userId, req.params.id)
    if (!view) return notFound(res, 'View not found')
    const role = await opts.workspaceStore.getRole(userId, view.workspaceId)
    if (role !== 'owner' && role !== 'admin') {
      return res.status(403).json({ error: 'Only a workspace owner or admin can create groups' })
    }
    const name = typeof (req.body ?? {}).name === 'string' ? (req.body as { name: string }).name.trim() : ''
    if (!name) return badRequest(res, 'name is required')
    const group = await opts.workspaceGroupStore.createGroup(userId, view.workspaceId, name.slice(0, 120))
    res.status(201).json({ group })
  })

  // GET /views/:id/groups/:groupId/members
  router.get('/views/:id/groups/:groupId/members', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    if (!opts.workspaceGroupStore) return res.status(503).json({ error: 'Groups not configured' })
    const view = await opts.savedViewStore.getById(userId, req.params.id)
    if (!view) return notFound(res, 'View not found')
    const members = await opts.workspaceGroupStore.listMembers(userId, req.params.groupId)
    res.json({ members })
  })

  // POST /views/:id/groups/:groupId/members { userId } — owner/admin.
  router.post('/views/:id/groups/:groupId/members', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    if (!opts.workspaceGroupStore) return res.status(503).json({ error: 'Groups not configured' })
    const view = await opts.savedViewStore.getById(userId, req.params.id)
    if (!view) return notFound(res, 'View not found')
    const role = await opts.workspaceStore.getRole(userId, view.workspaceId)
    if (role !== 'owner' && role !== 'admin') {
      return res.status(403).json({ error: 'Only a workspace owner or admin can manage groups' })
    }
    const memberUserId = typeof (req.body ?? {}).userId === 'string' ? (req.body as { userId: string }).userId : ''
    if (!memberUserId) return badRequest(res, 'userId is required')
    await opts.workspaceGroupStore.addMember(userId, req.params.groupId, memberUserId)
    res.status(201).json({ ok: true })
  })

  // DELETE /views/:id/groups/:groupId/members/:memberUserId — owner/admin.
  router.delete('/views/:id/groups/:groupId/members/:memberUserId', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    if (!opts.workspaceGroupStore) return res.status(503).json({ error: 'Groups not configured' })
    const view = await opts.savedViewStore.getById(userId, req.params.id)
    if (!view) return notFound(res, 'View not found')
    const role = await opts.workspaceStore.getRole(userId, view.workspaceId)
    if (role !== 'owner' && role !== 'admin') {
      return res.status(403).json({ error: 'Only a workspace owner or admin can manage groups' })
    }
    const ok = await opts.workspaceGroupStore.removeMember(userId, req.params.groupId, req.params.memberUserId)
    if (!ok) return notFound(res, 'Group member not found')
    res.json({ ok: true })
  })

  // GET /views/:id/public-preview — render exactly what an outsider sees
  // (public-clearance data + neutralized identity/media). Member-visible.
  // The previewed page is the share root: child_page labels resolve as they
  // would on the published page (subtree + independently-published targets).
  router.get('/views/:id/public-preview', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    const view = await opts.savedViewStore.getById(userId, req.params.id)
    if (!view) return notFound(res, 'View not found')
    const page = await opts.savedViewStore.getPage(userId, view.id)
    try {
      const rendered = await renderPublicPage(opts, view.workspaceId, page ?? { blocks: [] }, view.id)
      res.json({
        title: view.name,
        icon: view.icon ?? null,
        fullWidth: view.fullWidth ?? false,
        ...rendered,
      })
    } catch (err) {
      console.error('[views] public preview render failed:', err)
      res.status(500).json({ error: 'Failed to render preview' })
    }
  })

  // PATCH /views/:id/page  — replace blocks (drag-drop reorder + manual edits)
  router.patch('/views/:id/page', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)

    const body = (req.body ?? {}) as { page?: unknown }
    const parsed = pageSchema.safeParse(body.page)
    if (!parsed.success) {
      return badRequest(res, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    }

    const ok = await opts.savedViewStore.updatePage(userId, req.params.id, parsed.data)
    if (!ok) return notFound(res, 'View not found')

    // Return the fresh metadata so the client can swap state without a refetch.
    const fresh = await opts.savedViewStore.getById(userId, req.params.id)
    if (!fresh) return notFound(res, 'View not found')
    res.json(viewMetadata(fresh))
  })

  // PATCH /views/:id/save  — state='saved', clear auto-prune
  router.patch('/views/:id/save', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)

    const stateOk = await opts.savedViewStore.setState(userId, req.params.id, 'saved')
    if (!stateOk) return notFound(res, 'View not found')
    await opts.savedViewStore.setAutoPruneAt(userId, req.params.id, null)

    const fresh = await opts.savedViewStore.getById(userId, req.params.id)
    if (!fresh) return notFound(res, 'View not found')
    res.json(viewMetadata(fresh))
  })

  // PATCH /views/:id/unsave  — state='draft', set auto-prune
  router.patch('/views/:id/unsave', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)

    const stateOk = await opts.savedViewStore.setState(userId, req.params.id, 'draft')
    if (!stateOk) return notFound(res, 'View not found')

    // 30 days from now — matches `createDraft` default.
    const autoPruneAt = new Date()
    autoPruneAt.setUTCDate(autoPruneAt.getUTCDate() + 30)
    await opts.savedViewStore.setAutoPruneAt(userId, req.params.id, autoPruneAt)

    const fresh = await opts.savedViewStore.getById(userId, req.params.id)
    if (!fresh) return notFound(res, 'View not found')
    res.json(viewMetadata(fresh))
  })

  // PATCH /views/:id/reparent  — move a page in the doc sidebar tree
  //
  // Body: { nestParentId: string | null, position: number }. Sets the
  // page's nest parent + sibling position and reindexes the destination
  // siblings to 0..n-1. `nestParentId: null` promotes the page to a
  // workspace-root position. Mirrors the other `/views/:id/*` mutators:
  // auth required, RLS scopes visibility (a hidden / missing row 404s).
  // A cycle (parenting a page under itself or one of its descendants) is
  // rejected with 400.
  const reparentBodySchema = z.object({
    nestParentId: z.string().uuid().nullable(),
    position: z.number().int().min(0),
    // Teamspace destination for a root drop (migration 313). Omitted = keep
    // the page's current teamspace (plain reorder / legacy promote-to-root);
    // a teamspace id files it at that section's root; null moves it to the
    // caller's Private section. Ignored when nestParentId is a page — the
    // child always adopts the parent's teamspace.
    teamspaceId: z.string().uuid().nullable().optional(),
  })
  router.patch('/views/:id/reparent', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)

    const parsed = reparentBodySchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return badRequest(res, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    }

    // Confirm the page is visible to this user first so we can tell a
    // genuine "not found / no access" (404) apart from a cycle rejection
    // (400) — `reparent` returns false for both.
    const existing = await opts.savedViewStore.getById(userId, req.params.id)
    if (!existing) return notFound(res, 'View not found')

    const moved = await opts.savedViewStore.reparent(
      userId,
      req.params.id,
      parsed.data.nestParentId,
      parsed.data.position,
      undefined,
      parsed.data.teamspaceId,
    )
    if (!moved) {
      return badRequest(
        res,
        'Cannot reparent: the target parent is missing or not accessible, the destination teamspace is not yours to file into, or the move would create a cycle (a page cannot be nested under itself or one of its descendants).',
      )
    }

    const fresh = await opts.savedViewStore.getById(userId, req.params.id)
    if (!fresh) return notFound(res, 'View not found')
    res.json(viewMetadata(fresh))
  })

  // POST /workspaces/:wid/views/draft  — create an empty draft
  router.post('/workspaces/:workspaceId/views/draft', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    const workspaceId = req.params.workspaceId

    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) return notMember(res)

    // Empty draft: tasks/table is a sensible default for "blank doc"
    // — the user can swap or add data blocks immediately. Frontend can
    // optionally pass a name in the body; default to a timestamped one.
    // An optional `nestParentId` files the new draft under an existing
    // page in the doc sidebar tree (migration 210).
    const body = (req.body ?? {}) as {
      name?: string
      binding?: unknown
      nestParentId?: unknown
      blocks?: unknown
      teamspaceId?: unknown
    }

    // Optional block seed (migration 281) — "Start from a template" creates the
    // draft pre-filled with a template's blocks instead of an empty page. Same
    // shape the store's `createDraft({ page })` accepts (and the MCP
    // `createPageFromTemplate` uses). Absent → emptyPage.
    let seededPage: Page | undefined
    if (body.blocks !== undefined) {
      const parsedPage = pageSchema.safeParse({ blocks: body.blocks })
      if (!parsedPage.success) {
        return badRequest(res, parsedPage.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
      }
      seededPage = parsedPage.data
    }

    let binding: BindingConfig = { entity: 'tasks', viewType: 'table' }
    if (body.binding !== undefined) {
      const parsed = bindingConfigSchema.safeParse(body.binding)
      if (!parsed.success) {
        return badRequest(res, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
      }
      binding = parsed.data
    }

    let nestParentId: string | null = null
    if (body.nestParentId !== undefined && body.nestParentId !== null) {
      const parsedParent = z.string().uuid().safeParse(body.nestParentId)
      if (!parsedParent.success) {
        return badRequest(res, 'nestParentId must be a UUID or null')
      }
      nestParentId = parsedParent.data
    }

    // Teamspace placement (migration 313) — tri-state: omitted → inherit the
    // parent's teamspace / default to General; a teamspace id → that section
    // (the sidebar section "+"); null → private to the creator (the Private
    // section's create). The RLS WITH CHECK refuses a teamspace the caller
    // isn't a member of.
    let teamspaceId: string | null | undefined
    if (body.teamspaceId !== undefined) {
      const parsedTeamspace = z.string().uuid().nullable().safeParse(body.teamspaceId)
      if (!parsedTeamspace.success) {
        return badRequest(res, 'teamspaceId must be a UUID or null')
      }
      teamspaceId = parsedTeamspace.data
    }

    // A user-supplied name is a deliberate title (e.g. Duplicate copies the
    // source name) → frozen against auto-title. A bare "+ New draft" lands on
    // the placeholder default and is auto-title-eligible (migration 218),
    // which retitles it (and fills an icon) once it has content.
    const userNamed = typeof body.name === 'string' && body.name.trim().length > 0
    const name = userNamed ? body.name!.trim().slice(0, 256) : 'New draft'

    const created = await opts.savedViewStore.createDraft({
      userId,
      workspaceId,
      name,
      nameOrigin: userNamed ? 'user' : 'placeholder',
      // `saved_views.entity` is the closed 5-enum; a custom-table draft defaults
      // it to 'tasks' (the block binding is authoritative for content).
      entity: binding.entity === 'custom' ? 'tasks' : binding.entity,
      viewType: binding.viewType,
      binding,
      page: seededPage ?? emptyPage,
      nestParentId,
      teamspaceId,
      // Interactive create (the doc-editor blank / from-template flows): defer
      // the `created` page-event-trigger instead of firing it on this empty,
      // just-minted draft. The client commits it once the user engages
      // (debounced typing) or navigates away, via /views/:id/commit-created.
      // Migration 283 / docs workflow.md → "Deferred created (interactive drafts)".
      deferCreatedEvent: true,
    })
    res.status(201).json(viewMetadata(created))
  })

  // POST /views/:id/commit-created — fire the deferred `created` page-event for
  // an interactive draft. Idempotent + single-fire (the store flips
  // `created_event_pending` atomically): the doc client calls this after
  // debounced typing and again on navigate-away, but the workflow runs once.
  // Returns `{ committed }` — true only for the call that won the flip.
  router.post('/views/:id/commit-created', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    const committed = await opts.savedViewStore.commitCreatedEvent(userId, req.params.id)
    res.json({ committed })
  })

  // ── Format conversion: import (.docx/.md → page/brain) + export ──────
  // Spec: docs/architecture/features/doc-conversion.md. The converters are the
  // pure hub in `@use-brian/core`; these routes are the I/O wrapper.

  const importUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  })
  const DOCX_MIME =
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

  // GET /views/:id/export?format=md|docx — serialize the live page to a
  // downloadable file. Prefers the merged Yjs page (so a human's edits are
  // included); falls back to the frozen `saved_views.page`.
  router.get('/views/:id/export', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)

    const format = String(req.query.format ?? 'md').toLowerCase()
    if (format !== 'md' && format !== 'docx') {
      return badRequest(res, "format must be 'md' or 'docx'")
    }

    const view = await opts.savedViewStore.getById(userId, req.params.id)
    if (!view) return notFound(res, 'View not found')

    const live = opts.docPageStore
      ? await opts.docPageStore.getVersionedPage(userId, view.id)
      : null
    const page: Page = live?.page ?? pageOf(view)
    const title = live?.title ?? view.name ?? 'Untitled'
    const filename = safeFilename(title)

    if (format === 'md') {
      const md = pageToMarkdown(page, title)
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.md"`)
      return res.send(md)
    }
    // docx
    const buf = await blocksToDocx(page, { title })
    res.setHeader('Content-Type', DOCX_MIME)
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.docx"`)
    return res.send(buf)
  })

  // POST /workspaces/:wid/views/import — multipart field "file" + optional
  // `target` ∈ {page,brain,both}. Deterministic, model-free conversion:
  // .docx is Markdown-mediated (mammoth → turndown → markdownToBlocks),
  // .md/text parses directly. `page`/`both` create a draft; `brain`/`both`
  // hand the extracted text to Pipeline B via the optional `ingestDocument`.
  router.post(
    '/workspaces/:workspaceId/views/import',
    importUpload.single('file'),
    async (req, res) => {
      const userId = (req as { userId?: string }).userId
      if (!userId) return unauthorized(res)
      // The multer middleware overload widens `req.params` values to
      // `string | string[]`; the route param is always a single string.
      const workspaceId = String(req.params.workspaceId)

      const role = await opts.workspaceStore.getRole(userId, workspaceId)
      if (!role) return notMember(res)

      const file = (req as { file?: Express.Multer.File }).file
      if (!file) return badRequest(res, 'No file provided (multipart field "file")')

      const target = String((req.body?.target as string) ?? 'page').toLowerCase()
      if (target !== 'page' && target !== 'brain' && target !== 'both') {
        return badRequest(res, "target must be 'page', 'brain', or 'both'")
      }
      if ((target === 'brain' || target === 'both') && !opts.ingestDocument) {
        if (target === 'brain') {
          return res.status(503).json({ error: 'Brain import is not configured' })
        }
        // `both` with no brain wiring degrades to a page import (reported below).
      }

      // multer/busboy decodes the filename header as latin1; recover UTF-8.
      const fileName = Buffer.from(file.originalname, 'latin1').toString('utf8')
      const lower = fileName.toLowerCase()
      const isDocx = file.mimetype === DOCX_MIME || lower.endsWith('.docx')
      const isMd =
        file.mimetype.startsWith('text/') ||
        file.mimetype === 'application/json' ||
        /\.(md|markdown|txt)$/.test(lower)
      if (!isDocx && !isMd) {
        return badRequest(
          res,
          `Unsupported file type for import: ${file.mimetype || fileName}. Use .docx or .md.`,
        )
      }

      // Parse to Markdown (the universal import front door) then to blocks.
      let text: string
      let blocks
      try {
        text = isDocx ? await parseDocxToMarkdown(file.buffer) : file.buffer.toString('utf-8')
        blocks = markdownToBlocks(text)
      } catch (err) {
        return badRequest(res, `Could not parse the file: ${(err as Error).message}`)
      }

      const parsedPage = pageSchema.safeParse({ blocks })
      if (!parsedPage.success) {
        return badRequest(res, 'The imported document produced an invalid page.')
      }

      // A faithful import keeps the document's own name → 'user' origin (frozen
      // against auto-title), mirroring the Duplicate flow.
      const baseName = fileName.replace(/\.(docx|md|markdown|txt)$/i, '').trim().slice(0, 256) || 'Imported document'

      let pageId: string | null = null
      if (target === 'page' || target === 'both') {
        const created = await opts.savedViewStore.createDraft({
          userId,
          workspaceId,
          name: baseName,
          nameOrigin: 'user',
          entity: 'tasks',
          viewType: 'table',
          binding: { entity: 'tasks', viewType: 'table' },
          page: parsedPage.data,
          nestParentId: null,
        })
        pageId = created.id
      }

      let brainIngested = false
      if ((target === 'brain' || target === 'both') && opts.ingestDocument) {
        await opts.ingestDocument({ userId, workspaceId, text, sourceLabel: fileName })
        brainIngested = true
      }

      res.status(201).json({ pageId, brainIngested, blockCount: blocks.length })
    },
  )

  // ── Ad-hoc payload rendering (no persistence) ───────────────────────
  //
  // POST /workspaces/:workspaceId/views/render
  // Body: a BindingConfig. Returns an A2UI ViewPayload.
  // Used by the new-view editor page and (optionally) by the renderView
  // chat tool from the server side.
  router.post('/workspaces/:workspaceId/views/render', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    const workspaceId = req.params.workspaceId

    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) return notMember(res)

    const parsed = bindingConfigSchema.safeParse(req.body)
    if (!parsed.success) {
      return badRequest(res, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    }

    try {
      const payload = await buildPayload(
        parsed.data as BindingConfig,
        buildBindingDeps(opts, userId, workspaceId),
      )
      res.json(payload)
    } catch (err) {
      console.error('[views] render failed:', err)
      res.status(500).json({ error: 'Render failed', message: (err as Error).message })
    }
  })

  // ── Direct-write routes used by board-drop actions + inline cell edit ─
  //
  // Phase 2 (Notion-feel) — broaden the per-entity PATCH endpoints to
  // accept the full editable-field allowlist used by the renderer's
  // property Editors. Each schema is **strict**: unknown fields are
  // rejected so client typos can't silently no-op. The store-side
  // `*UpdateFields` types already allowlist columns; this is the
  // outer guard at the route boundary.
  //
  // Spec: docs/architecture/features/views.md § Phase 2.

  function isoOrNullish(input: unknown): Date | null | undefined {
    if (input === undefined) return undefined
    if (input === null) return null
    if (typeof input === 'string' && input.length === 0) return null
    if (typeof input === 'string') {
      const t = Date.parse(input)
      if (Number.isFinite(t)) return new Date(t)
    }
    return undefined
  }

  // ── Tasks ──────────────────────────────────────────────────────────
  // PATCH /tasks/:id — accepts any subset of {title, status, assigneeId,
  // due, tags, parentId}. Body must include at least one editable key;
  // the store treats an empty patch as a no-op read.
  const taskPatchSchema = z
    .object({
      title: z.string().min(1).max(512).optional(),
      status: z.enum(TASK_STATUSES).optional(),
      // `null` clears the assignee; omit leaves unchanged.
      assigneeId: z.string().uuid().nullable().optional(),
      // ISO string or null. Empty string normalises to null upstream.
      due: z.union([z.string(), z.null()]).optional(),
      tags: z.array(z.string().min(1)).optional(),
      parentId: z.string().uuid().nullable().optional(),
    })
    .strict()

  router.patch('/tasks/:id', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)

    const parsed = taskPatchSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return badRequest(res, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    }

    const patch: Parameters<TaskStore['update']>[2] = {}
    if (parsed.data.title !== undefined) patch.title = parsed.data.title
    if (parsed.data.status !== undefined) patch.status = parsed.data.status as TaskRecordStatus
    if (parsed.data.assigneeId !== undefined) patch.assigneeId = parsed.data.assigneeId
    if (parsed.data.tags !== undefined) patch.tags = parsed.data.tags
    if (parsed.data.parentId !== undefined) patch.parentId = parsed.data.parentId
    const dueParsed = isoOrNullish(parsed.data.due)
    if (dueParsed !== undefined) patch.due = dueParsed

    if (Object.keys(patch).length === 0) {
      return badRequest(res, 'No editable fields provided')
    }

    const updated = await opts.taskStore.update(userId, req.params.id, patch)
    if (!updated) return notFound(res, 'Task not found')
    res.json({
      id: updated.id,
      title: updated.title,
      status: updated.status,
      assigneeId: updated.assigneeId,
      due: updated.due ? updated.due.toISOString() : null,
      tags: updated.tags,
      parentId: updated.parentId,
      updatedAt: updated.updatedAt.toISOString(),
    })
  })

  // ── Contacts ───────────────────────────────────────────────────────
  // PATCH /contacts/:id — name/email/phone/companyId/tags.
  const contactPatchSchema = z
    .object({
      name: z.string().min(1).max(512).optional(),
      email: z.string().nullable().optional(),
      phone: z.string().nullable().optional(),
      companyId: z.string().uuid().nullable().optional(),
      tags: z.array(z.string().min(1)).optional(),
    })
    .strict()

  router.patch('/contacts/:id', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)

    const parsed = contactPatchSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return badRequest(res, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    }
    if (Object.keys(parsed.data).length === 0) {
      return badRequest(res, 'No editable fields provided')
    }

    const updated = await opts.crmStore.updateContact(userId, req.params.id, parsed.data)
    if (!updated) return notFound(res, 'Contact not found')
    res.json({
      id: updated.id,
      name: updated.name,
      email: updated.email,
      phone: updated.phone,
      companyId: updated.companyId,
      tags: updated.tags,
      updatedAt: updated.updatedAt.toISOString(),
    })
  })

  // ── Companies ──────────────────────────────────────────────────────
  // PATCH /companies/:id — name/domain/tags.
  const companyPatchSchema = z
    .object({
      name: z.string().min(1).max(512).optional(),
      domain: z.string().nullable().optional(),
      tags: z.array(z.string().min(1)).optional(),
    })
    .strict()

  router.patch('/companies/:id', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)

    const parsed = companyPatchSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return badRequest(res, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    }
    if (Object.keys(parsed.data).length === 0) {
      return badRequest(res, 'No editable fields provided')
    }

    const updated = await opts.crmStore.updateCompany(userId, req.params.id, parsed.data)
    if (!updated) return notFound(res, 'Company not found')
    res.json({
      id: updated.id,
      name: updated.name,
      domain: updated.domain,
      tags: updated.tags,
      updatedAt: updated.updatedAt.toISOString(),
    })
  })

  // ── Deals ──────────────────────────────────────────────────────────
  // PATCH /deals/:id — combined endpoint replacing the narrow stage-only
  // path. `stage` here uses `setDealStage` (it's the lone cut-point for
  // stage transitions); every other field uses `updateDeal`. When both
  // appear in one patch, `updateDeal` lands first, then `setDealStage`.
  const dealPatchSchema = z
    .object({
      stage: z.enum(DEAL_STAGES).optional(),
      contactId: z.string().uuid().nullable().optional(),
      companyId: z.string().uuid().nullable().optional(),
      amount: z.number().nullable().optional(),
      closeDate: z.union([z.string(), z.null()]).optional(),
    })
    .strict()

  router.patch('/deals/:id', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)

    const parsed = dealPatchSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return badRequest(res, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    }
    if (Object.keys(parsed.data).length === 0) {
      return badRequest(res, 'No editable fields provided')
    }

    const id = req.params.id
    const dealUpdate: Parameters<CrmStore['updateDeal']>[2] = {}
    if (parsed.data.contactId !== undefined) dealUpdate.contactId = parsed.data.contactId
    if (parsed.data.companyId !== undefined) dealUpdate.companyId = parsed.data.companyId
    if (parsed.data.amount !== undefined) dealUpdate.amount = parsed.data.amount
    const closeParsed = isoOrNullish(parsed.data.closeDate)
    if (closeParsed !== undefined) dealUpdate.closeDate = closeParsed

    let current = null as Awaited<ReturnType<CrmStore['updateDeal']>>
    if (Object.keys(dealUpdate).length > 0) {
      current = await opts.crmStore.updateDeal(userId, id, dealUpdate)
      if (!current) return notFound(res, 'Deal not found')
    }
    if (parsed.data.stage !== undefined) {
      current = await opts.crmStore.setDealStage(userId, id, parsed.data.stage as DealStage)
      if (!current) return notFound(res, 'Deal not found')
    }
    if (!current) {
      // Shouldn't happen — we already rejected empty patches — but be safe.
      return badRequest(res, 'No editable fields provided')
    }
    res.json({
      id: current.id,
      stage: current.stage,
      contactId: current.contactId,
      companyId: current.companyId,
      amount: current.amount,
      closeDate: current.closeDate ? current.closeDate.toISOString() : null,
      updatedAt: current.updatedAt.toISOString(),
    })
  })

  // PATCH /deals/:id/stage  — legacy alias (board-drop callers).
  router.patch('/deals/:id/stage', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)

    const body = (req.body ?? {}) as { stage?: string }
    if (!body.stage) return badRequest(res, 'stage is required')

    const updated = await opts.crmStore.setDealStage(
      userId,
      req.params.id,
      body.stage as DealStage,
    )
    if (!updated) return notFound(res, 'Deal not found')
    res.json({ id: updated.id, stage: updated.stage, updatedAt: updated.updatedAt.toISOString() })
  })

  // ── Row create (Phase 3 — the data-block "+ Add row" affordance) ─────
  //
  // POST /<entity> — workspace-scoped create for the four built-in
  // primitives. Body must carry `workspaceId` (the soft-delete /
  // create paths are workspace-scoped, and the row-action payload the
  // renderer fires doesn't carry it — the host supplies it from its
  // workspace context). Required text fields fall back to a placeholder
  // so the "+ Add row" ghost-row can create a blank row in one tap;
  // every other field takes its frozen-v1 store default.
  //
  // Spec: docs/architecture/features/views.md § Direct-write (data-block actions).

  const DEFAULT_TASK_TITLE = 'Untitled task'
  const DEFAULT_CONTACT_NAME = 'Untitled contact'
  const DEFAULT_COMPANY_NAME = 'Untitled company'

  const workspaceScopedBody = z.object({ workspaceId: z.string().uuid() })

  async function requireWorkspace(
    req: import('express').Request,
    res: import('express').Response,
  ): Promise<{ userId: string; workspaceId: string } | null> {
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      unauthorized(res)
      return null
    }
    const parsed = workspaceScopedBody.safeParse(req.body ?? {})
    if (!parsed.success) {
      badRequest(res, 'workspaceId is required')
      return null
    }
    const role = await opts.workspaceStore.getRole(userId, parsed.data.workspaceId)
    if (!role) {
      notMember(res)
      return null
    }
    return { userId, workspaceId: parsed.data.workspaceId }
  }

  const taskCreateSchema = workspaceScopedBody.extend({
    title: z.string().min(1).max(512).optional(),
    status: z.enum(TASK_STATUSES).optional(),
  })
  router.post('/tasks', async (req, res) => {
    const ctx = await requireWorkspace(req, res)
    if (!ctx) return
    const parsed = taskCreateSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return badRequest(res, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    }
    const created = await opts.taskStore.create({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      title: parsed.data.title ?? DEFAULT_TASK_TITLE,
      status: (parsed.data.status as TaskRecordStatus | undefined) ?? 'todo',
    })
    res.status(201).json({
      id: created.id,
      title: created.title,
      status: created.status,
      assigneeId: created.assigneeId,
      due: created.due ? created.due.toISOString() : null,
      tags: created.tags,
      parentId: created.parentId,
      updatedAt: created.updatedAt.toISOString(),
    })
  })

  const contactCreateSchema = workspaceScopedBody.extend({
    name: z.string().min(1).max(512).optional(),
  })
  router.post('/contacts', async (req, res) => {
    const ctx = await requireWorkspace(req, res)
    if (!ctx) return
    const parsed = contactCreateSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return badRequest(res, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    }
    const created = await opts.crmStore.createContact({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      name: parsed.data.name ?? DEFAULT_CONTACT_NAME,
    })
    res.status(201).json({
      id: created.id,
      name: created.name,
      email: created.email,
      phone: created.phone,
      companyId: created.companyId,
      tags: created.tags,
      updatedAt: created.updatedAt.toISOString(),
    })
  })

  const companyCreateSchema = workspaceScopedBody.extend({
    name: z.string().min(1).max(512).optional(),
  })
  router.post('/companies', async (req, res) => {
    const ctx = await requireWorkspace(req, res)
    if (!ctx) return
    const parsed = companyCreateSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return badRequest(res, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    }
    const created = await opts.crmStore.createCompany({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      name: parsed.data.name ?? DEFAULT_COMPANY_NAME,
    })
    res.status(201).json({
      id: created.id,
      name: created.name,
      domain: created.domain,
      tags: created.tags,
      updatedAt: created.updatedAt.toISOString(),
    })
  })

  const dealCreateSchema = workspaceScopedBody.extend({
    stage: z.enum(DEAL_STAGES).optional(),
  })
  router.post('/deals', async (req, res) => {
    const ctx = await requireWorkspace(req, res)
    if (!ctx) return
    const parsed = dealCreateSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return badRequest(res, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    }
    const created = await opts.crmStore.createDeal({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      stage: (parsed.data.stage as DealStage | undefined) ?? 'lead',
    })
    res.status(201).json({
      id: created.id,
      stage: created.stage,
      contactId: created.contactId,
      companyId: created.companyId,
      amount: created.amount,
      closeDate: created.closeDate ? created.closeDate.toISOString() : null,
      updatedAt: created.updatedAt.toISOString(),
    })
  })

  // ── Row delete (Phase 3 — the data-block row-menu "Delete row") ──────
  //
  // DELETE /<entity>/:id?workspaceId=<wid> — bi-temporal soft-delete via
  // the D.4 universal soft-delete contract (`valid_to = now()`), NOT a
  // hard `DELETE`. The supersession chain + `correction_audit` trail are
  // preserved, matching the `deleteBrainRow` chat tool. `workspaceId` is
  // a query param because DELETE bodies are non-idiomatic; the
  // soft-delete repository reads the row by `(workspace_id, id)` before
  // closing it.
  //
  // One explicit route per entity (mirrors the per-entity PATCH style
  // above) rather than a `:entity` param — Express 5's path-to-regexp no
  // longer supports inline regex route params, and explicit paths avoid
  // greedy-matching the legacy `/saved-views/:id` DELETE.
  //
  // Spec: docs/architecture/features/views.md § Direct-write (data-block
  // actions), docs/architecture/brain/corrections.md § D.4.
  function handleRowDelete(entity: string, primitive: SoftDeletePrimitive) {
    return async (req: import('express').Request, res: import('express').Response): Promise<void> => {
      const userId = (req as { userId?: string }).userId
      if (!userId) return unauthorized(res)

      const rowId = String(req.params.id)
      const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined
      if (!workspaceId) return badRequest(res, 'workspaceId is required')

      const role = await opts.workspaceStore.getRole(userId, workspaceId)
      if (!role) return notMember(res)

      try {
        await softDelete(
          {
            primitive,
            workspaceId,
            rowId,
            actorUserId: userId,
            reason: 'Deleted from Doc data view',
          },
          { repo: opts.softDeleteStore },
        )
        res.json({ ok: true })
      } catch (err) {
        if (err instanceof SoftDeleteError) {
          if (err.code === 'row_not_found' || err.code === 'workspace_mismatch') {
            return notFound(res, `${entity} not found`)
          }
          if (err.code === 'already_soft_deleted' || err.code === 'already_retracted') {
            // Idempotent — the row is already gone from the active set.
            res.json({ ok: true })
            return
          }
          return badRequest(res, err.message)
        }
        console.error('[views] soft-delete failed:', err)
        res.status(500).json({ error: 'Failed to delete row', message: (err as Error).message })
      }
    }
  }
  router.delete('/tasks/:id', handleRowDelete('tasks', 'task'))
  router.delete('/contacts/:id', handleRowDelete('contacts', 'contact'))
  router.delete('/companies/:id', handleRowDelete('companies', 'company'))
  router.delete('/deals/:id', handleRowDelete('deals', 'deal'))

  return router
}
