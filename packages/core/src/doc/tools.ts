/**
 * Doc v1 — five chat tool builders that bridge the chat model to the
 * page wire-format declared in `./page-types.ts`.
 *
 *   - `renderPage`       — initial page creation (Lock #5; replaces
 *                          `renderView`'s draft-mint path in Phase 5)
 *   - `patchPage`        — surgical edits via the `Op` vocabulary, with
 *                          atomic per-patch version check (Lock #8) and
 *                          per-op observer hook for SSE streaming (Lock #7)
 *   - `getBlock`         — lazy fetch of one block's full content
 *                          (outline-first; Lock #6)
 *   - `queryDataBlock`   — resolve a data block's rows from the bindings
 *                          catalog; outline carries shape only
 *   - `getCurrentPage`   — full-page fallback when the outline isn't enough
 *
 * All five are pure factories: `createRenderPageTool(deps)` etc. The
 * Phase-1 wire-up site (Agent P1I, `packages/api/src/doc/inject.ts`)
 * builds the dep bag and stitches the tools into the per-turn tool map.
 *
 * # Store split
 *
 * Two interfaces are taken on the deps bag:
 *
 *   1. **`SavedViewStore`** — existing live store on `saved_views` JSONB.
 *      `renderPage` calls `createDraft` (mirroring `renderView`'s
 *      seed path); `getBlock` / `queryDataBlock` / `getCurrentPage`
 *      read via `getPage`. Phase 5's hard cutover swaps the table
 *      mapping to doc-native operations, but Phase 1's compatibility
 *      seam keeps the same store interface.
 *
 *   2. **`DocPageStore`** — narrow new interface declared here for
 *      the version-aware operations migration 200 introduced
 *      (`saved_views.version`, `saved_views.last_undo`). `patchPage`'s
 *      version check + undo capture both live behind this interface.
 *      Agent P1F (the DB adapter in `packages/api/src/db/`) fulfils it
 *      against the same `saved_views` row. The interface is co-located
 *      with the tool factories rather than placed in `views/types.ts`
 *      because we're explicitly NOT to modify the legacy views surface
 *      in Phase 1; Phase 5 collapses them.
 *
 * # SSE per-op streaming (Lock #7)
 *
 * `patchPage` accepts an optional `onOpApplied(op, opIndex, page)` dep
 * that's fired exactly once per successfully applied op. The chat route
 * (Agent P1I) hooks SSE event emission into that callback; the tool
 * itself only depends on the callback interface — no SSE plumbing inside
 * the engine. Failure aborts the whole patch (atomic per Lock #8) so the
 * callback is only fired on the happy path.
 *
 * # Undo (single-step, Lock #9)
 *
 * `patchPage` builds the inverse of the applied ops via `invertOps` and
 * persists them through `DocPageStore.saveInverse(pageId, inverse)`.
 * Cmd-Z on the client invokes a separate `undoPage` flow (out of scope
 * for this tool surface — landed by P1F). If the store hook is absent
 * the patch still commits but undo is unavailable; we log a soft warning.
 *
 * Spec: `docs/plans/doc-v1-execution.md` §5.3 + Locks 5/6/7/8/9.
 *
 * [COMP:doc/tools]
 */

import { z } from 'zod'
import { stripFollowUps } from '@use-brian/shared'
import { buildTool, type Tool } from '../tools/types.js'
import type { CrmStore } from '../crm/types.js'
import type { TaskStore } from '../tasks/types.js'
import type { WorkflowRunStore } from '../workflow/types.js'
import type { WorkspaceDirectoryStore } from '../workspace/types.js'
import type { FileStore } from '../files/types.js'
import { buildPayload } from '../views/bindings.js'
import type {
  BindingConfig,
  NameOrigin,
  SavedViewStore,
  SavedViewUpdateFields,
} from '../views/types.js'
import {
  blockSchema,
  liftedPageSchema,
  opsSchema,
} from './page-schemas.js'
import { pageIconValueSchema } from '../views/schemas.js'
import { applyOps } from './ops.js'
import { normalizeMarkdownBlocks, normalizeMarkdownOps, markdownToBlocks } from './markdown.js'
import { pageToMarkdown } from './to-markdown.js'
import { buildOutline, computePatchDelta } from './outline.js'
import { buildUndoEntry, type UndoEntry } from './undo.js'
import { emptyPage } from './page-types.js'
import type {
  Block,
  BlockId,
  DocBlockRangeResult,
  DocCurrentPageResult,
  DocPatchResult,
  DocSectionResult,
  Op,
  Ops,
  Outline,
  Page,
  TmpId,
  VersionedPage,
} from './page-types.js'

// ── Follow-up tag sanitizer (defense-in-depth) ───────────────────────
//
// The `<followup>[...]</followup>` chip tag is a chat-surface convention
// (see FOLLOW_UP_QUESTIONS_ADDENDUM in `../system-prompt.ts`). When a
// chip-enabled chat surface drives page authoring, the model can append
// the tag to a block's text — it must never become document content.
// We strip it at the tool-input boundary, before any storage path forks
// (saved_views JSONB *or* the live Yjs gateway), so the leak is killed
// regardless of which write path a given deploy uses. The matching
// prompt-level prevention (gating the addendum to chip-capable clients)
// lives in `packages/api/src/routes/chat.ts`.

/** Strip the chip tag from a block's `text` field if present. Accepts a
 *  full `Block` or an `edit` op's `Partial<Block>` patch (only text-bearing
 *  kinds carry `text`; the rest pass through untouched). Returns a new
 *  object only when a change was made. */
function stripTextField<T extends Block | Partial<Block>>(block: T): T {
  if (!('text' in block) || typeof (block as { text?: unknown }).text !== 'string') {
    return block
  }
  const text = (block as { text: string }).text
  const stripped = stripFollowUps(text)
  return stripped === text ? block : ({ ...block, text: stripped } as T)
}

/** Strip the chip tag from every text-bearing block of a page. */
function sanitizePageFollowups(page: Page): Page {
  return { ...page, blocks: page.blocks.map((b) => stripTextField(b)) }
}

/** Strip the chip tag from any block carried by `add` / `edit` ops. */
function sanitizeOpsFollowups(ops: Ops): Ops {
  return ops.map((op): Op => {
    if (op.op === 'add') return { ...op, block: stripTextField(op.block) }
    if (op.op === 'edit') return { ...op, patch: stripTextField(op.patch) }
    return op
  })
}

// ── DocPageStore — narrow new interface for v1 page persistence ───
//
// Fulfilled by an adapter on `saved_views` (rows already carry `page`
// JSONB; migration 200 adds `version INT` + `last_undo JSONB`). The
// interface is intentionally small — Phase 5 reabsorbs the legacy
// `SavedViewStore`, at which point this collapses into it.

/**
 * Version-aware page read. Returns the page + the per-row `version`
 * column added by migration 200. RLS hides cross-workspace rows so
 * `null` covers both "not found" and "not visible".
 */
export type DocPageRead = {
  page: Page
  version: number
  title: string
  /**
   * Title provenance (migration 218). `'placeholder'` means the page is
   * still on its untouched default name → eligible for auto-title. See
   * {@link NameOrigin}.
   */
  nameOrigin: NameOrigin
  /**
   * Current page emoji icon (`saved_views.icon`, migration 211), or `null`
   * for the derived glyph. `patchPage` seeds the working copy with it so a
   * `setIcon` op's inverse captures the prior value (single-step undo).
   */
  icon: string | null
}

export type DocPageStore = {
  /**
   * Fetch the versioned page. `userId` for RLS; `pageId` is the
   * `saved_views.id`.
   */
  getVersionedPage(
    userId: string,
    pageId: string,
  ): Promise<DocPageRead | null>

  /**
   * Atomic compare-and-swap: if the current row's `version` equals
   * `expectedVersion`, write `nextPage` + bump version to
   * `expectedVersion + 1` + store `undo` in `last_undo` JSONB + return
   * the new version. Otherwise return `null` (version conflict).
   *
   * The single statement guarantees atomicity per Lock #8 — two
   * concurrent patches can't both succeed against the same base.
   *
   * The `undo` payload is the `UndoEntry` produced by `buildUndoEntry`
   * — single-step revert per Lock #9.
   */
  applyPatch(params: {
    userId: string
    pageId: string
    expectedVersion: number
    nextPage: Page
    /** Undo payload (inverse ops + metadata) for `last_undo` JSONB. */
    undo: UndoEntry
  }): Promise<{ newVersion: number } | null>
}

// ── Live-doc gateway (Yjs write path) ────────────────────────────────

/**
 * Optional bridge from the AI page tools to the *live* collaborative
 * Y.Doc (served by `apps/doc-sync`). When wired, `patchPage` routes
 * its ops through here instead of the legacy `saved_views.page`
 * version-CAS, so AI edits land in the same CRDT humans edit and
 * broadcast live — no divergence. Absent in tests / smoke / local →
 * `patchPage` falls back to the CAS path so those contexts keep working.
 *
 * The implementation (`packages/api/src/doc/doc-gateway.ts`) POSTs to
 * the sync service, which applies the ops to the authoritative in-memory
 * doc via `@use-brian/doc-model` `applyOpsToYDoc`. Concurrency is handled
 * by the CRDT + the observe-then-reconcile rule (ops whose target a human
 * deleted come back in `skipped`), not by a version reject. See
 * `docs/architecture/features/doc.md` → "Real-time collaboration".
 */
export type DocGateway = {
  applyOps(params: {
    userId: string
    pageId: string
    ops: Op[]
  }): Promise<
    | {
        idMap: Record<string, string>
        skipped: { opIndex: number; reason: string }[]
        version: number
        /**
         * The authoritative post-apply block list, derived from the live
         * in-memory Y.Doc the gateway just mutated. `patchPage` builds its
         * delta + outline from this so the model's read reflects its own write
         * immediately — `documents.snapshot_json` lags the sync service's ~2s
         * persistence debounce, and re-reading it mid-loop showed the model a
         * stale page (it re-targeted already-deleted blocks and looped; prod
         * incident 2026-06-11). Optional so an older doc-sync that doesn't yet
         * return it makes `patchPage` fall back to the snapshot re-read.
         */
        page?: Page
        /** Live post-apply title, paired with `page`. */
        title?: string
      }
    | { error: string }
  >
}

// ── SSE-per-op observer ──────────────────────────────────────────────

/**
 * Per-op observer fired during `patchPage`. Lock #7's SSE-per-op
 * streaming hooks here: the chat route subscribes and emits one SSE
 * event per call. The observer never throws; if the host wants to
 * back-pressure it must do so without raising into the tool.
 *
 * `intermediatePage` is the page state immediately after the op was
 * applied to the in-memory working copy (NOT after the DB write —
 * the write is one atomic CAS at the end of the patch). The host
 * uses it to compute a partial outline or just to forward the op
 * verbatim to subscribed clients.
 */
export type DocOpObserver = (
  op: Op,
  opIndex: number,
  intermediatePage: Page,
) => void

// ── Tool event taxonomy ──────────────────────────────────────────────

export type DocToolEvent =
  | { type: 'page_rendered'; pageId: string; version: number }
  | {
      type: 'page_patched'
      pageId: string
      previousVersion: number
      newVersion: number
      opCount: number
      /**
       * The committed page metadata, present ONLY when the patch included a
       * `setTitle` and/or `setIcon` op. The chat route streams this to the
       * open doc clients (tabs / breadcrumb / sidebar) live, the moment the
       * patch commits — independent of the post-turn auto-title pass, which
       * skips `'user'`-named pages and so never fires for an explicit AI
       * rename / icon change. `null` icon means "cleared to the derived glyph".
       */
      meta?: { title: string; icon: string | null; nameOrigin: NameOrigin }
    }
  | { type: 'block_fetched'; pageId: string; blockId: string }
  | { type: 'data_block_queried'; pageId: string; blockId: string; rowCount: number }
  | { type: 'sub_page_created'; pageId: string; parentPageId: string }

export type DocToolEventContext = {
  userId: string
  assistantId: string
  sessionId: string
  channelType: string
}

// ── Tool deps ────────────────────────────────────────────────────────

/**
 * The full dep bag the five tool factories consume. The chat route
 * (Agent P1I, `packages/api/src/doc/inject.ts`) builds this from
 * the API package's concrete stores. Pure data — no closures keyed
 * on the request.
 */
export type DocToolDeps = {
  savedViewStore: SavedViewStore
  docPageStore: DocPageStore
  taskStore: TaskStore
  crmStore: CrmStore
  workflowRunStore: WorkflowRunStore
  workspaceDirectory: WorkspaceDirectoryStore
  /**
   * Optional live-doc gateway. When present, `patchPage` writes through
   * the Yjs sync service (humans see AI edits live); when absent it falls
   * back to the legacy `saved_views.page` CAS. See `DocGateway`.
   */
  docGateway?: DocGateway
  /**
   * Optional per-op observer for `patchPage`. The chat route wires SSE
   * emission here; smoke tests / scheduled-job contexts omit it.
   */
  onOpApplied?: DocOpObserver
  /** Optional analytics hook for the four doc tool events. */
  onEvent?: (event: DocToolEvent, ctx: DocToolEventContext) => void
  /**
   * The page the user is currently looking at this turn (the request's
   * `docViewId`). When set, `patchPage` is PINNED to it: a `pageId` the
   * model supplies that is neither this anchor nor a page created earlier in
   * the same turn (see `turnCreatedPageIds`) is treated as a stale / recalled
   * reference and redirected to the anchor — the work belongs on the page the
   * user is viewing. Null on new-draft turns (no page open), where `patchPage`
   * trusts the model's `pageId` (it just rendered/created it). This closes the
   * "resumed session recalls a stale pageId and edits the wrong page" bug.
   */
  anchorPageId?: string | null
  /**
   * Pages created during THIS turn (`renderPage` / `createSubPage` push their
   * new id here). Lets the anchor-pin above allow legitimate same-turn
   * multi-page authoring ("create a sub-page and fill it in") while still
   * redirecting stale references. Shared across the doc tools built from
   * one `createDocTools` call; absent → no same-turn exemption.
   */
  turnCreatedPageIds?: Set<string>
  /**
   * Optional cached-file store, for `importToPage` (the faithful AI import,
   * journey F). Reads a previously-uploaded `.docx`/`.md` file's parsed
   * content (already Markdown for `.docx` — turndown at upload) and converts it
   * deterministically. Absent → `importToPage` reports it's unavailable. The
   * chat route threads `options.fileStore` here. See
   * docs/architecture/features/doc-conversion.md.
   */
  fileStore?: FileStore
}

// ── Input schemas ────────────────────────────────────────────────────

const pageIdSchema = z.string().min(1).max(128)
const blockIdSchema = z.string().min(1).max(128)

/**
 * Page icon — one emoji grapheme (≤16 chars, matching the REST
 * `PATCH /saved-views/:id` contract) or an `img:<workspaceId>/<fileId>`
 * image token from the `fetchSiteIcon` tool. The page's leading glyph above
 * the title; omit to leave the derived document glyph in place.
 */
const iconInputSchema = pageIconValueSchema.describe(
  'The page icon (the glyph shown above the title): a single emoji, e.g. "🌋", or an "img:..." token returned by the fetchSiteIcon tool. Set the icon HERE — do NOT prefix an emoji onto the title text. Omit to keep the default document glyph.',
)

const renderPageInputSchema = z.object({
  page: liftedPageSchema.describe(
    'The freshly-built page. Block ids must already be assigned (use `tmp-*` placeholders if you want the server to mint real ids — but for `renderPage`, real ids are preferred since the page is brand-new).',
  ),
  title: z
    .string()
    .min(0)
    .max(512)
    .optional()
    .describe('Top-level page title. Defaults to "New draft" if omitted.'),
  name: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe(
      'Optional draft name shown in the sidebar listing. Defaults to `title`, or "New draft" if `title` is also absent.',
    ),
  icon: iconInputSchema.optional(),
})

const patchPageInputSchema = z.object({
  pageId: pageIdSchema.describe(
    'The id returned by a prior `renderPage` call. Required — `patchPage` cannot create new pages.',
  ),
  ops: opsSchema.describe(
    'Ordered list of surgical edits. Variants: `add` (insert a block), `edit` (merge a patch into a block), `delete` (remove a block), `move` (reorder), `setTitle` (rename the page). Use `tmp-*` ids in `add.block.id` if a later op in the same patch references the not-yet-real block. A `chart` block (added or edited) must carry the numbers to plot (bar/pie `data.points`, line `data.series` with points, kpi `data.value`); a chart left with no plottable values is rejected — present that information as a `data` table, `callout`, or list instead.',
  ),
  expectedVersion: z
    .number()
    .int()
    .nonnegative()
    .describe(
      'Page version you read from the outline / `getCurrentPage`. Used for optimistic concurrency — the patch is rejected if another writer bumped the page since. Refetch the outline and retry on conflict.',
    ),
})

const getBlockInputSchema = z.object({
  pageId: pageIdSchema,
  blockId: blockIdSchema.describe(
    'The id of the block to fetch. Found in the outline entry for the block.',
  ),
})

const getSectionInputSchema = z.object({
  pageId: pageIdSchema,
  headingId: blockIdSchema.describe(
    'The id of the HEADING block that opens the section (from the page outline / map). Returns that heading plus every block beneath it, up to the next heading of the same or higher level.',
  ),
})

const getBlockRangeInputSchema = z.object({
  pageId: pageIdSchema,
  fromBlockId: blockIdSchema.describe(
    'Id of the first block in the range (inclusive), from the outline.',
  ),
  toBlockId: blockIdSchema.describe(
    'Id of the last block in the range (inclusive), from the outline. Must appear at or after fromBlockId in document order.',
  ),
})

const queryDataBlockInputSchema = z.object({
  pageId: pageIdSchema,
  blockId: blockIdSchema.describe(
    'The id of the `kind: "data"` block whose rows to resolve. Outline entries with `kind: "data"` carry the metadata; this tool returns the resolved row payload.',
  ),
  limit: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .describe('Optional row cap. Defaults to the binding\'s natural limit.'),
  cursor: z
    .string()
    .min(1)
    .max(512)
    .optional()
    .describe(
      'Opaque pagination cursor from a prior call. The full set is returned in one call today; this parameter is reserved for paginated bindings that are not yet available.',
    ),
})

const getCurrentPageInputSchema = z.object({
  pageId: pageIdSchema,
  fields: z
    .enum(['outline', 'full'])
    .optional()
    .describe(
      "How much to return. 'outline' (the default) returns just the compact page outline + current version — cheap, and enough to re-anchor block ids after a rejection. 'full' ALSO returns every block's complete content; ask for it only when you must reason structurally over many blocks at once. Prefer getBlock / queryDataBlock for one block / a data block's rows.",
    ),
})

const createSubPageInputSchema = z.object({
  parentPageId: pageIdSchema.describe(
    'The id of the page this sub-page is filed under (the parent in the sidebar tree). Use the id of the page currently in scope — e.g. the `pageId` from its outline.',
  ),
  title: z
    .string()
    .min(1)
    .max(512)
    .describe('Title of the new sub-page. Also used as its sidebar name.'),
  icon: iconInputSchema.optional(),
  page: liftedPageSchema
    .optional()
    .describe(
      'Optional initial content (`{ blocks: Block[] }`) for the sub-page. Each block needs a `kind` and a stable `id`. Omit to create an empty sub-page the user (or a follow-up `patchPage`) fills in.',
    ),
})

// ── Workspace gate (mirrors views/tools.ts) ──────────────────────────

function workspaceGate(
  workspaceId: string | null | undefined,
): { data: string; isError: true } | null {
  if (!workspaceId) {
    return {
      data: 'Doc tools require a workspace. This assistant is not bound to one — switch to a workspace-scoped chat to create or edit doc pages.',
      isError: true,
    }
  }
  return null
}

function eventCtx(context: {
  userId: string
  assistantId: string
  sessionId: string
  channelType: string
}): DocToolEventContext {
  return {
    userId: context.userId,
    assistantId: context.assistantId,
    sessionId: context.sessionId,
    channelType: context.channelType,
  }
}

// ── id mint helper ──────────────────────────────────────────────────

function newId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } })
    .crypto
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID()
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

// ── renderPage ───────────────────────────────────────────────────────

/**
 * `renderPage` — initial creation. Persists the page as a draft on
 * `saved_views` and returns the new id + version 1 + the outline so the
 * model can immediately reference block ids in a follow-up `patchPage`.
 *
 * For Phase 1's compatibility seam we route through the existing
 * `SavedViewStore.createDraft` (the same path `renderView` uses); the
 * `entity` / `viewType` columns are filled from the first `data` block
 * if any, or defaulted to `tasks` / `table` so the legacy listing
 * doesn't trip on null values. Phase 5 collapses the schema and this
 * fallback disappears.
 */
export function createRenderPageTool(deps: DocToolDeps): Tool {
  return buildTool({
    name: 'renderPage',
    description:
      'Create a brand-new doc page from a fully-formed `Page` object. ' +
      'Use this when the user asks you to build a page, dashboard, or document — anything that begins with a blank doc. ' +
      '\n\n' +
      'For edits to an existing page — including appending a single live data view — use `patchPage` instead (add a `data` block with an `add` op). ' +
      '\n\n' +
      'Input: a `page` object (`{ blocks: Block[] }`) plus optional `title`, `name`, and `icon`. Each block declares its `kind` — prose (`text`, `heading`, `callout`, `quote`, `code`, `bulleted_list_item`, `numbered_list_item`, `to_do`, `toggle`), structure (`divider`), or live data (`data`, `chart`) — and a stable `id` (or `tmp-*` if you want the server to mint one). A `data` block carries a `binding` object (e.g. `{ entity: "tasks", viewType: "table" }`). For sub-bullets, set `indent` on a `bulleted_list_item` / `numbered_list_item` (`0`/omit = top level, `1` = nested under the item above, `2` = deeper); list a parent then its children as consecutive items (parent `indent: 0`, children `indent: 1`). Content that belongs INSIDE a `toggle` or `callout` goes in its `children` array (full nested blocks; `richText` is only the summary/lead line) — blocks listed after a toggle are siblings and stay visible when it collapses. ' +
      '\n\n' +
      'A `chart` block is for quantitative data ONLY and MUST carry the numbers to plot: bar/pie need `data.points`, line needs `data.series` with points, kpi needs `data.value`. If you do not have numbers to plot, present the information as a `data` table, a `callout`, or a bulleted list instead. A chart with no plottable values is REJECTED, so never insert a chart shell to fill in later. ' +
      '\n\n' +
      'To give the page an emoji icon (the glyph above the title), pass `icon` (e.g. `icon: "🌋"`). Put the emoji THERE — never prefix it onto the `title` text. ' +
      '\n\n' +
      'Author a page that reads on its own: open with a `heading`, frame it with a line of `text`, and introduce every `data` block with its own heading + lead-in sentence. A page that is a single bare `data` block — a table with no heading or framing — is not a finished page. ' +
      '\n\n' +
      'Returns `{ pageId, version: 1, outline }`. The `outline` lists every block by id + kind + position label + 80-char preview — exactly what you need to follow up with `patchPage` calls.',
    inputSchema: renderPageInputSchema,
    isConcurrencySafe: false,
    isReadOnly: false,
    timeoutMs: 30_000,

    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      const title = input.title ?? 'New draft'
      const name = input.name ?? title
      // If the model named the page (explicit title or name), that's a
      // deliberate title → freeze it against auto-title. A bare renderPage
      // (no title/name) is born on the placeholder default, so auto-title
      // may retitle it once it has content. See doc.md → "Auto-title".
      const nameOrigin: NameOrigin =
        input.title !== undefined || input.name !== undefined ? 'user' : 'placeholder'

      // Strip any `<followup>` chip tag the model appended to block text —
      // it's a chat-surface convention, never document content.
      const sanitizedPage = sanitizePageFollowups(input.page)
      // Expand any Markdown the model crammed into a text/heading block
      // (`### Heading`, `**bold**`, blank-line paragraphs) into the canonical
      // blocks it describes — same normalizer the patchPage path uses. See
      // ./markdown.ts + docs/architecture/features/doc.md.
      const page: Page = { blocks: normalizeMarkdownBlocks(sanitizedPage.blocks) }

      // Default the legacy entity/viewType columns from the first data
      // block we find, or fall back to tasks/table. These columns are
      // for sidebar sorting in the back-compat window only — Phase 5
      // drops them.
      const firstData = page.blocks.find(
        (b): b is Extract<Block, { kind: 'data' }> => b.kind === 'data',
      )
      const legacyBinding: BindingConfig = firstData
        ? firstData.binding
        : ({ entity: 'tasks', viewType: 'table' } as BindingConfig)

      try {
        const draft = await deps.savedViewStore.createDraft({
          userId: context.userId,
          workspaceId: context.workspaceId!,
          // Assistant-authored page write — marks the page event bot-authored
          // so a watching workflow doesn't loop on its own output (the page
          // self-loop guard). See views/types.ts → PageWriteActor.
          writtenBy: 'system',
          name,
          nameOrigin,
          // Explicit page emoji, if the model chose one. `null`/omitted leaves
          // the column empty so auto-title can later suggest one (COALESCE).
          icon: input.icon ?? null,
          // `saved_views.entity` is a closed DB enum (the 5 built-ins); a
          // custom-table page defaults the legacy column to 'tasks' (the block
          // binding is authoritative for content).
          entity: legacyBinding.entity === 'custom' ? 'tasks' : legacyBinding.entity,
          viewType: legacyBinding.viewType,
          binding: legacyBinding,
          page,
          // Snapshot the prompt that created this page → the History "first
          // prompt" (migration 231). Undefined on turns with no user message.
          originPrompt: context.userMessageText,
        })

        const versionedPage: VersionedPage = {
          blocks: page.blocks,
          version: 1,
          title,
        }
        const outline: Outline = buildOutline(versionedPage, {
          pageId: draft.id,
          pageVersion: 1,
          title,
        })

        // Register the freshly-minted page so a same-turn `patchPage` to it is
        // allowed past the anchor-pin (it's intentional, not a stale recall).
        deps.turnCreatedPageIds?.add(draft.id)
        deps.onEvent?.(
          { type: 'page_rendered', pageId: draft.id, version: 1 },
          eventCtx(context),
        )

        return {
          data: {
            kind: 'doc_render' as const,
            pageId: draft.id,
            version: 1,
            outline,
          },
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { data: `Failed to render page: ${message}`, isError: true }
      }
    },
  })
}

// ── patchPage ───────────────────────────────────────────────────────

/**
 * `patchPage` — surgical edits via the `Op` vocabulary. Atomic per
 * Lock #8: the whole patch lands or none of it does. Per Lock #7 the
 * tool fires `onOpApplied` per applied op so the chat route can stream
 * SSE events. Per Lock #9 the inverse is captured and stored for
 * single-step undo.
 *
 * Conflict semantics: if the current `version` !== `expectedVersion`,
 * the tool returns `isError: true` with a clean "stale page" message
 * so the model retries against a fresh outline.
 */
export function createPatchPageTool(deps: DocToolDeps): Tool {
  return buildTool({
    name: 'patchPage',
    description:
      'Apply a list of surgical edits (`Op`s) to an existing doc page. ' +
      'Use this for ANY change to an already-created page — adding blocks, editing text, reordering, deleting, renaming the title. ' +
      '\n\n' +
      'Op vocabulary:\n' +
      '  - `add` — insert a new block (`{ op: "add", block: <Block> }`). **Omit `after` to append at the end of the page** — to build out a page, list a run of `add` ops in document order with NO `after` and they stack top-to-bottom. Pass `after: "start" | "end" | "<blockId>"` only to insert at a specific position. Give `block.id` a `tmp-*` placeholder only when a later op in the same patch must reference it — and if you do, that op must come AFTER the `add` that mints it; otherwise omit `id` and let the server assign one. For a SUB-item, set `indent` on a `bulleted_list_item` / `numbered_list_item` / `to_do` (`1` nests it under the item it follows, `2` deeper) and `add` it after its parent (or previous sibling); `0`/omitted keeps it top-level.\n' +
      '  - `edit` — merge a patch into an existing block (`{ op: "edit", blockId, patch: { text: "new" } }`). `id` + `kind` are preserved; never re-discriminates a block.\n' +
      '  - `delete` — remove a block (`{ op: "delete", blockId }`).\n' +
      '  - `move` — reorder a block to a new anchor (`{ op: "move", blockId, after: ... }`).\n' +
      '  - `setTitle` — rename the page (`{ op: "setTitle", title: "..." }`).\n' +
      '  - `setIcon` — set or clear the page icon, the glyph shown above the title (`{ op: "setIcon", icon: "🌋" }`, an image token from the fetchSiteIcon tool `{ op: "setIcon", icon: "img:..." }`, or `{ op: "setIcon", icon: null }` to clear). Use this to give a page an icon — never prefix an emoji onto the title text.\n' +
      '\n' +
      'Concurrency: pass `expectedVersion` from the last outline you saw. If the page changed since, the patch is rejected — refetch via the outline and retry.\n' +
      '\n' +
      'Returns `{ pageId, version: <new>, idMap, changed, removed }` (plus `skipped` if some ops targeted since-deleted blocks). `changed` are the added/edited blocks as outline entries and `removed` the deleted ids — ONLY what this patch touched, never the whole page; the current full outline is re-delivered in your context fresh every turn, so you never need it echoed back. `idMap` maps every `tmp-*` you passed to its real `BlockId` so later calls reference the canonical id. If EVERY op targeted a block that no longer exists, it returns `{ kind: "invalid_ops", outline }` instead (a full outline) so you can re-anchor on current ids and retry.',
    inputSchema: patchPageInputSchema,
    isConcurrencySafe: false,
    isReadOnly: false,
    timeoutMs: 30_000,

    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      // Pin to the page the user is looking at this turn. A `pageId` that is
      // neither the anchor (the open page) nor a page created earlier in this
      // same turn is a stale / recalled reference — common on resumed sessions,
      // where the model recalls an old id from context and edits the wrong (or
      // an orphaned) page. Redirect it to the anchor so the edit lands where the
      // user is looking. New-draft turns carry no anchor and trust input.pageId.
      if (
        deps.anchorPageId &&
        input.pageId !== deps.anchorPageId &&
        !deps.turnCreatedPageIds?.has(input.pageId)
      ) {
        console.warn(
          `[patchPage] redirecting stale target ${input.pageId} -> anchor ${deps.anchorPageId}`,
        )
        input.pageId = deps.anchorPageId
      }

      // Strip any `<followup>` chip tag from block text carried by the ops
      // before validation/application — the model can append it when a
      // chip-enabled chat surface drives the edit; it's never page content.
      const sanitized = sanitizeOpsFollowups(input.ops)

      // 1. Load the current page.
      const current = await deps.docPageStore.getVersionedPage(
        context.userId,
        input.pageId,
      )
      if (!current) {
        return {
          data: `Page not found: ${input.pageId}. It may have been deleted or you may not have access.`,
          isError: true,
        }
      }

      // Normalize any Markdown the model crammed into a text/heading block
      // — `### Heading`, `**bold**`, blank-line paragraphs — into the
      // canonical blocks it describes, BEFORE validation/application so the
      // expansion flows through both the Yjs and CAS write paths. Needs the
      // current page for `edit`-op target kind/position. See ./markdown.ts.
      const ops = normalizeMarkdownOps(sanitized, current.page)

      // 2. Version check (Lock #8). Skipped on the live-doc (Yjs) path —
      //    the CRDT reconciles concurrent edits, so version mismatch is a
      //    re-plan signal (via `skipped`), not a hard reject.
      if (!deps.docGateway && current.version !== input.expectedVersion) {
        return {
          data: {
            kind: 'stale_page' as const,
            pageId: input.pageId,
            expectedVersion: input.expectedVersion,
            currentVersion: current.version,
            message: `Stale page: expected version ${input.expectedVersion}, got ${current.version}. Refetch the outline and retry.`,
          },
          isError: true,
        }
      }

      // 3. Validate ops before any application so we fast-fail with
      //    structured feedback rather than mid-iteration mess.
      const prePage: Page = { blocks: [...current.page.blocks] }
      // Title + icon live on the working copy as page metadata for `setTitle`
      // / `setIcon` semantics — seed both so an op's inverse captures the
      // prior value (single-step undo) and `patchPage` can persist the result.
      const preVersioned: Page & { title?: string; icon?: string | null } = {
        ...prePage,
        title: current.title,
        icon: current.icon,
      } as Page & { title?: string; icon?: string | null }
      // 4. Apply ops to a working copy ONE AT A TIME, **tolerantly**: a
      //    stale-target op (delete/edit/move on a block that no longer exists)
      //    is SKIPPED and reported, not fatal to the whole patch. This mirrors
      //    the Yjs sync service's observe-then-reconcile guard (`applyOpsToYDoc`
      //    returns the same `skipped[]`). The old whole-patch `validateOps`
      //    gate defeated that tolerance — it rejected the entire patch with
      //    `invalid_ops` on the first stale op, before the gateway path could
      //    run, which was the dominant residual cause of the 2026-06-04 doc
      //    patch-rejection storm. We re-walk per op (vs a single
      //    `applyOps(ops)`) so the per-op SSE observer (Lock #7) sees
      //    intermediate states and so one bad op can't sink its neighbours.
      let working: Page & { title?: string; icon?: string | null } = preVersioned
      const idMap: Record<TmpId, BlockId> = {}
      const appliedOps: Op[] = []
      const skipped: { opIndex: number; op: string; reason: string }[] = []
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i]
        try {
          const { page: nextWorking, idMap: stepIdMap } = applyOps(
            working,
            [op],
            newId,
          )
          working = nextWorking as Page & { title?: string }
          for (const k of Object.keys(stepIdMap)) {
            idMap[k as TmpId] = stepIdMap[k as TmpId]
          }
          appliedOps.push(op)
        } catch (err) {
          // A thrown op leaves `working` untouched (`applyOps` mutates a clone),
          // so skipping is a clean no-op on page state. Strip the
          // `applyOps[i]: ` prefix for a model-facing reason.
          const raw = err instanceof Error ? err.message : String(err)
          skipped.push({
            opIndex: i,
            op: op.op,
            reason: raw.replace(/^applyOps\[\d+\]:\s*/, ''),
          })
          continue
        }

        // Fire per-op observer (applied ops only). Failures inside the observer
        // must not abort the patch — log and continue. The observer receives
        // the original op (with `tmp-*` ids intact) so the chat route's SSE
        // emission can correlate with what the model sent; the resolved ids are
        // available via the returned `idMap` in the final tool result.
        if (deps.onOpApplied) {
          try {
            deps.onOpApplied(op, i, working)
          } catch (observerErr) {
            console.warn(
              '[patchPage] onOpApplied observer threw — ignoring:',
              observerErr,
            )
          }
        }
      }

      // Every op targeted a block that no longer exists (or was otherwise
      // unappliable). Nothing to commit — return the fresh outline so the model
      // re-anchors on real block ids instead of guessing again. The fail-total
      // breaker (`loop-detector.ts`) bounds repeated whole-patch misses.
      if (appliedOps.length === 0) {
        return {
          data: {
            kind: 'invalid_ops' as const,
            skipped,
            message: `No ops applied: all ${ops.length} targeted blocks that no longer exist or could not be applied. Re-read the outline below and retry against current block ids.`,
            outline: buildOutline(preVersioned, {
              pageId: input.pageId,
              pageVersion: current.version,
              title: current.title,
            }),
          },
          isError: true,
        }
      }

      // 5. Build the undo entry for the forward patch. Single-step
      //    revert (Lock #9) — `last_undo` is overwritten on every
      //    successful patch.
      const newVersion = current.version + 1
      // Undo inverts only the ops that ACTUALLY applied — a skipped stale-target
      // op never mutated the page, so it must not appear in the inverse.
      const undoEntry = buildUndoEntry(
        prePage,
        appliedOps,
        idMap as Record<string, string>,
        newVersion,
      )

      // Persist the page-metadata ops — `setTitle` → `saved_views.name`
      // (frozen against auto-title with `name_origin = 'user'`, a deliberate
      // rename) and `setIcon` → `saved_views.icon` — in one UPDATE. Both
      // columns live OUTSIDE the page-blocks JSONB and the Y.Doc, so neither
      // the legacy CAS `applyPatch` nor the doc-sync gateway writes them:
      // this is the single place an AI title/icon change lands in
      // `saved_views`. Best-effort — a failure here must not fail the patch.
      // See doc.md → "Auto-title" and "Per-page emoji icons".
      const persistMetaOps = async () => {
        const fields: SavedViewUpdateFields = {}
        if (ops.some((o) => o.op === 'setTitle')) {
          fields.name = working.title ?? current.title
          fields.nameOrigin = 'user'
        }
        if (ops.some((o) => o.op === 'setIcon')) {
          // Explicit AI choice → write the column directly (overwrite). Unlike
          // the auto-title suggestion (COALESCE), this is a deliberate
          // instruction, so it owns the icon the way `setTitle` owns the name.
          fields.icon = working.icon ?? null
        }
        if (Object.keys(fields).length === 0) return
        try {
          // Assistant-authored metadata edit — bot-authored page event.
          await deps.savedViewStore.update(context.userId, input.pageId, fields, 'system')
        } catch (metaErr) {
          console.warn('[patchPage] page-metadata persist failed:', metaErr)
        }
      }

      // Metadata payload for the `page_patched` event — populated only when the
      // patch carried a `setTitle`/`setIcon`, so the chat route can stream the
      // committed title/icon to the open clients (tabs / breadcrumb / sidebar)
      // live. A `setTitle` freezes `name_origin` to `'user'`; a `setIcon`-only
      // patch leaves provenance unchanged. These mirror what `persistMetaOps`
      // just wrote, so the stream and the DB agree.
      const titleChanged = ops.some((o) => o.op === 'setTitle')
      const iconChanged = ops.some((o) => o.op === 'setIcon')
      const metaForEvent:
        | { title: string; icon: string | null; nameOrigin: NameOrigin }
        | undefined =
        titleChanged || iconChanged
          ? {
              title: working.title ?? current.title,
              icon: working.icon ?? null,
              nameOrigin: titleChanged ? 'user' : current.nameOrigin,
            }
          : undefined

      // 6a. Live-doc path (Yjs). When the sync gateway is wired, AI edits
      //     apply to the same CRDT humans edit — no version-CAS; the
      //     reconcile guard in the sync service drops ops whose target a
      //     human deleted (returned in `skipped`). See doc.md →
      //     "Real-time collaboration".
      if (deps.docGateway) {
        // `setIcon` is page metadata, not a Y.Doc block — the sync service has
        // no representation for it (and `applyOpsToYDoc` would no-op it). Drop
        // it from the doc payload; it's persisted to `saved_views.icon` via
        // `persistMetaOps` below, on both write paths.
        const opsForDoc = ops.filter((o) => o.op !== 'setIcon')
        const gw = await deps.docGateway.applyOps({
          userId: context.userId,
          pageId: input.pageId,
          ops: opsForDoc,
        })
        if ('error' in gw) {
          return {
            data: `Live page update failed: ${gw.error}. The page is open in collaborative editing — refetch the outline and retry.`,
            isError: true,
          }
        }
        const mergedIdMap: Record<string, string> = {
          ...(idMap as Record<string, string>),
          ...gw.idMap,
        }
        // Authoritative post-apply state. Prefer what the gateway just produced
        // from the live in-memory doc — `documents.snapshot_json` (what
        // getVersionedPage reads) lags the sync service's ~2s persistence
        // debounce, so re-reading it here would hand the model a stale page: the
        // read-after-write gap that made it re-target already-deleted blocks and
        // loop into a confabulated reply (prod incident 2026-06-11, session
        // d98e2acd). Fall back to the snapshot re-read only for an older doc-sync
        // that doesn't return the live page yet (deploy-order safe).
        const live = gw.page
          ? { blocks: gw.page.blocks, title: gw.title }
          : await deps.docPageStore
              .getVersionedPage(context.userId, input.pageId)
              .then((fresh) => ({
                blocks: fresh?.page.blocks ?? working.blocks,
                title: fresh?.title,
              }))
        const liveVersioned: VersionedPage = {
          blocks: live.blocks,
          version: gw.version || current.version + 1,
          title: live.title ?? working.title ?? current.title,
        }
        const liveOutline: Outline = buildOutline(liveVersioned, {
          pageId: input.pageId,
          pageVersion: liveVersioned.version,
          title: liveVersioned.title,
        })
        // Every content op targeted a block that no longer exists on the live
        // page — the gateway applied nothing. Mirror the CAS path's same guard
        // (`appliedOps.length === 0` above): surface a re-anchor signal as an
        // ERROR, not a success-shaped no-op `doc_patch`. A no-op that reports
        // success is doubly harmful: the model gets no reason to change course
        // (it re-issues the same stale-target ops), and because the executor
        // feeds `isError` into the loop-detector's `recordOutcome`, a non-error
        // outcome RESETS the failure streak — so neither the fail-streak nor the
        // fail-total fuse ever trips. The turn then churns to the tool-call
        // budget and a weak model can emit a confabulated internal directive as
        // its whole reply (prod incident 2026-06-11, session d98e2acd: 16
        // buffered no-op turns, then a leaked "If you continue to receive
        // errors... Do not loop." reply). Metadata patches (setTitle/setIcon)
        // keep the success path so the title/icon still persists.
        const hasMetaOp = ops.some(
          (o) => o.op === 'setTitle' || o.op === 'setIcon',
        )
        if (
          !hasMetaOp &&
          opsForDoc.length > 0 &&
          gw.skipped.length === opsForDoc.length
        ) {
          return {
            data: {
              kind: 'invalid_ops' as const,
              skipped: gw.skipped,
              message: `No ops applied: all ${opsForDoc.length} targeted blocks that no longer exist on the live page. Re-read the outline below and retry against current block ids.`,
              outline: liveOutline,
            },
            isError: true,
          }
        }
        // Return only the blocks this patch changed/removed, not the whole-page
        // outline (the live outline is re-injected into the system prompt every
        // turn). Diff against the authoritative re-read snapshot. Note: on a
        // live collaborative page the re-read is the MERGED CRDT, so a concurrent
        // collaborator's edits between the initial read and this re-read surface
        // in `changed` too — by design (the model gets their current state; the
        // over-report is bounded and safe, and rare on a small-team doc; the
        // Phase 0 `doc_context_composition` metric would surface it if it ever
        // bloats). See outline.ts:computePatchDelta + doc-turn-context-optimization.md.
        const delta = computePatchDelta(
          prePage.blocks,
          liveVersioned.blocks,
          liveOutline,
        )
        await persistMetaOps()
        deps.onEvent?.(
          {
            type: 'page_patched',
            pageId: input.pageId,
            previousVersion: input.expectedVersion,
            newVersion: liveVersioned.version,
            opCount: input.ops.length,
            ...(metaForEvent ? { meta: metaForEvent } : {}),
          },
          eventCtx(context),
        )
        const patchResult: DocPatchResult = {
          kind: 'doc_patch',
          pageId: input.pageId,
          version: liveVersioned.version,
          idMap: mergedIdMap,
          changed: delta.changed,
          removed: delta.removed,
          ...(gw.skipped.length > 0 ? { skipped: gw.skipped } : {}),
        }
        return { data: patchResult }
      }

      // 6b. Legacy atomic compare-and-swap write (no sync gateway).
      //     `applyPatch` is the only DB-side seam — if it returns null, a
      //     concurrent writer beat us to it and we surface a stale-page error.
      const nextPage: Page = { blocks: working.blocks }
      try {
        const result = await deps.docPageStore.applyPatch({
          userId: context.userId,
          pageId: input.pageId,
          expectedVersion: input.expectedVersion,
          nextPage,
          undo: undoEntry,
        })
        if (!result) {
          // Re-read so the model has accurate state on the retry.
          const fresh = await deps.docPageStore.getVersionedPage(
            context.userId,
            input.pageId,
          )
          return {
            data: {
              kind: 'stale_page' as const,
              pageId: input.pageId,
              expectedVersion: input.expectedVersion,
              currentVersion: fresh?.version ?? null,
              message: `Page was updated concurrently. Refetch and retry.`,
            },
            isError: true,
          }
        }

        const nextVersioned: VersionedPage = {
          blocks: nextPage.blocks,
          version: result.newVersion,
          title: working.title ?? current.title,
        }
        const outline: Outline = buildOutline(nextVersioned, {
          pageId: input.pageId,
          pageVersion: result.newVersion,
          title: nextVersioned.title,
        })
        // Delta, not the whole-page outline (see the Yjs path above + the
        // delta rationale in computePatchDelta). Diff pre-patch vs committed.
        const delta = computePatchDelta(
          prePage.blocks,
          nextPage.blocks,
          outline,
        )
        await persistMetaOps()

        deps.onEvent?.(
          {
            type: 'page_patched',
            pageId: input.pageId,
            previousVersion: input.expectedVersion,
            newVersion: result.newVersion,
            opCount: input.ops.length,
            ...(metaForEvent ? { meta: metaForEvent } : {}),
          },
          eventCtx(context),
        )

        const patchResult: DocPatchResult = {
          kind: 'doc_patch',
          pageId: input.pageId,
          version: result.newVersion,
          idMap: idMap as Record<string, string>,
          changed: delta.changed,
          removed: delta.removed,
          ...(skipped.length > 0 ? { skipped } : {}),
        }
        return { data: patchResult }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { data: `Failed to apply patch: ${message}`, isError: true }
      }
    },
  })
}

// ── getBlock ────────────────────────────────────────────────────────

/**
 * `getBlock` — lazy fetch of a single block's full content. The outline
 * carries previews + ids; when the model needs the full payload of
 * exactly one block (long text, a chart binding's full config, etc.)
 * it calls this rather than `getCurrentPage`.
 */
export function createGetBlockTool(deps: DocToolDeps): Tool {
  return buildTool({
    name: 'getBlock',
    description:
      'Fetch the full content of one block on a doc page. ' +
      'The page outline (which you receive in the chat envelope when a page is in scope) lists every block by id + kind + 80-char preview. ' +
      'When the preview isn\'t enough — e.g. the full text of a long paragraph, the binding of a data block, the chart config — call `getBlock` with the block\'s id. ' +
      '\n\n' +
      'For the full page (all blocks at once), use `getCurrentPage`. For a data block\'s rows, use `queryDataBlock`. ' +
      '\n\n' +
      'Returns `{ block: <Block> }` — the discriminated union variant matching the block\'s kind.',
    inputSchema: getBlockInputSchema,
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,

    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      const page = await deps.savedViewStore.getPage(
        context.userId,
        input.pageId,
      )
      if (!page) {
        return {
          data: `Page not found: ${input.pageId}. It may have been deleted or you may not have access.`,
          isError: true,
        }
      }
      const block = page.blocks.find(b => b.id === input.blockId)
      if (!block) {
        return {
          data: `Block "${input.blockId}" not found on page ${input.pageId}. The page may have been edited since you last saw the outline — refetch via getCurrentPage.`,
          isError: true,
        }
      }

      // Round-trip the block through Zod so the response is guaranteed
      // to satisfy the doc wire-format contract (catches corruption
      // in the JSONB column at read time, surfaces cleanly to the model).
      const parsed = blockSchema.safeParse(block)
      if (!parsed.success) {
        return {
          data: `Block "${input.blockId}" failed schema validation: ${parsed.error.message}`,
          isError: true,
        }
      }

      deps.onEvent?.(
        { type: 'block_fetched', pageId: input.pageId, blockId: input.blockId },
        eventCtx(context),
      )

      return { data: { block: parsed.data } }
    },
  })
}

// ── queryDataBlock ──────────────────────────────────────────────────

/**
 * `queryDataBlock` — resolve a data block's rows via the bindings
 * catalog. The outline only carries shape metadata (entity, columns,
 * row count); calling this is how the model fetches the actual payload
 * before responding to a user question that needs row-level facts.
 *
 * Phase 1 delegates to the existing `views/bindings.ts:buildPayload()`
 * so the wire shape matches `renderView` (`{ a2ui: '0.8', root: ... }`).
 * Phase 3 entity-store work will swap the resolver to one that handles
 * the user-defined entity types and pagination cursors — until then
 * `limit` / `cursor` are accepted but unused.
 */
export function createQueryDataBlockTool(deps: DocToolDeps): Tool {
  return buildTool({
    name: 'queryDataBlock',
    description:
      'Resolve the rows of a `kind: "data"` block on a doc page. ' +
      'Use this when the user asks a question that requires reading actual rows from a data block — e.g. "what tasks are overdue", "show me the top 3 deals by amount". ' +
      '\n\n' +
      'The page outline carries the data block\'s shape (entity, properties, row count) but NOT the rows themselves. This tool fetches the rows by re-running the block\'s binding against the live store. ' +
      '\n\n' +
      'Returns `{ rows: <unknown[]>, nextCursor?: string }`. The full set is returned in one call today — `cursor` / `limit` are accepted but unused; pagination is not yet available.',
    inputSchema: queryDataBlockInputSchema,
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 30_000,

    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      const page = await deps.savedViewStore.getPage(
        context.userId,
        input.pageId,
      )
      if (!page) {
        return {
          data: `Page not found: ${input.pageId}. It may have been deleted or you may not have access.`,
          isError: true,
        }
      }
      const block = page.blocks.find(b => b.id === input.blockId)
      if (!block) {
        return {
          data: `Block "${input.blockId}" not found on page ${input.pageId}.`,
          isError: true,
        }
      }
      if (block.kind !== 'data') {
        return {
          data: `Block "${input.blockId}" is kind "${block.kind}", not "data". Only data blocks can be queried — for other block kinds use \`getBlock\` to read the full content.`,
          isError: true,
        }
      }

      try {
        const payload = await buildPayload(block.binding, {
          taskStore: deps.taskStore,
          crmStore: deps.crmStore,
          workflowRunStore: deps.workflowRunStore,
          workspaceDirectory: deps.workspaceDirectory,
          userId: context.userId,
          workspaceId: context.workspaceId!,
        })

        // The bindings catalog returns an A2UI widget tree; extract the
        // row array if the root is a table or a board so the response
        // shape is consistent regardless of viewType. Falling back to
        // the raw root keeps the contract loose for Phase 3 view types
        // that don't fit table/board.
        let rows: unknown[] = []
        const root = payload.root as { type?: string; rows?: unknown[]; columns?: unknown[] }
        if (root.type === 'table' && Array.isArray(root.rows)) {
          rows = root.rows
        } else if (
          root.type === 'board' &&
          'columns' in root &&
          Array.isArray(root.columns)
        ) {
          // Flatten board cards into one row list so consumers don't
          // have to special-case the discriminator.
          rows = root.columns.flatMap((col: unknown) => {
            const c = col as { cards?: unknown[] }
            return Array.isArray(c.cards) ? c.cards : []
          })
        }

        deps.onEvent?.(
          {
            type: 'data_block_queried',
            pageId: input.pageId,
            blockId: input.blockId,
            rowCount: rows.length,
          },
          eventCtx(context),
        )

        return {
          data: {
            kind: 'data_block_rows' as const,
            pageId: input.pageId,
            blockId: input.blockId,
            entity: block.binding.entity,
            viewType: block.binding.viewType,
            rows,
            // Phase 1 always returns the full set; cursor stays undefined.
          },
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          data: `Failed to query data block: ${message}`,
          isError: true,
        }
      }
    },
  })
}

// ── getCurrentPage ──────────────────────────────────────────────────

/**
 * `getCurrentPage` — fallback when the outline isn't enough. Returns the page
 * outline + version by default; pass `fields:'full'` to also get every block's
 * complete content. The model is encouraged to lean on the live outline +
 * targeted `getBlock` calls instead (cheaper for large pages), so the default
 * is outline-only — the full-page dump is opt-in.
 */
export function createGetCurrentPageTool(deps: DocToolDeps): Tool {
  return buildTool({
    name: 'getCurrentPage',
    description:
      'Re-fetch a doc page outline + current version. ' +
      'Use it after a `patchPage` rejection when you want a fresh snapshot before retrying. By default it returns the compact outline only (every block by id + preview) and the version — which is all you need to re-anchor. ' +
      '\n\n' +
      'Pass `fields:"full"` ONLY when you must reason structurally over many blocks at once — that returns every block\'s complete content and is the most expensive read. For a single block, prefer `getBlock`; for a data block\'s rows, prefer `queryDataBlock`. ' +
      '\n\n' +
      'Returns `{ outline, version }` by default, or `{ outline, version, page }` with `fields:"full"`.',
    inputSchema: getCurrentPageInputSchema,
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,

    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      const current = await deps.docPageStore.getVersionedPage(
        context.userId,
        input.pageId,
      )
      if (!current) {
        return {
          data: `Page not found: ${input.pageId}. It may have been deleted or you may not have access.`,
          isError: true,
        }
      }

      const versionedPage: VersionedPage = {
        blocks: current.page.blocks,
        version: current.version,
        title: current.title,
      }
      const outline: Outline = buildOutline(versionedPage, {
        pageId: input.pageId,
        pageVersion: current.version,
        title: current.title,
      })

      // Default to outline-only — the full-page JSON (every block's complete
      // content) is the single biggest tool-result body and is needed only for
      // multi-block structural reasoning. `fields:'full'` opts into it. See
      // docs/plans/doc-turn-context-optimization.md → Phase 1.
      const fields = input.fields ?? 'outline'
      const result: DocCurrentPageResult = {
        kind: 'doc_current_page',
        pageId: input.pageId,
        version: current.version,
        outline,
        ...(fields === 'full' ? { page: versionedPage } : {}),
      }
      return { data: result }
    },
  })
}

// ── getSection / getBlockRange ───────────────────────────────────────

/**
 * `getSection` — expand one heading-delimited section (the "expand" for a
 * section the large-page map collapsed). Reads the LIVE page (the same source
 * the outline injection uses) and returns the heading + its subtree.
 */
export function createGetSectionTool(deps: DocToolDeps): Tool {
  return buildTool({
    name: 'getSection',
    description:
      'Expand one section of a doc page — a heading and every block beneath it, up to the next heading of the same or higher level — with full block content. ' +
      'On a large page the system-prompt map shows far sections collapsed to a one-line summary; call `getSection` with the heading id to read (and then edit) those blocks. ' +
      '\n\n' +
      'For a single block use `getBlock`; for an arbitrary span use `getBlockRange`. ' +
      'Returns `{ headingId, version, blocks: Block[] }`.',
    inputSchema: getSectionInputSchema,
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,

    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      const current = await deps.docPageStore.getVersionedPage(
        context.userId,
        input.pageId,
      )
      if (!current) {
        return {
          data: `Page not found: ${input.pageId}. It may have been deleted or you may not have access.`,
          isError: true,
        }
      }
      const blocks = current.page.blocks
      const startIdx = blocks.findIndex((b) => b.id === input.headingId)
      if (startIdx === -1) {
        return {
          data: `Heading "${input.headingId}" not found on page ${input.pageId}. The page may have changed since you saw the outline — refetch it.`,
          isError: true,
        }
      }
      const start = blocks[startIdx]
      if (start.kind !== 'heading') {
        return {
          data: `Block "${input.headingId}" is a ${start.kind}, not a heading. Use getBlock for a single block, or pass a heading id to getSection.`,
          isError: true,
        }
      }
      // Subtree: this heading + everything until the next same-or-higher heading.
      const section: Block[] = [start]
      for (let i = startIdx + 1; i < blocks.length; i++) {
        const b = blocks[i]
        if (b.kind === 'heading' && b.level <= start.level) break
        section.push(b)
      }
      const result: DocSectionResult = {
        kind: 'doc_section',
        pageId: input.pageId,
        version: current.version,
        headingId: input.headingId,
        blocks: section,
      }
      return { data: result }
    },
  })
}

/**
 * `getBlockRange` — read a contiguous span of blocks by its endpoints. The
 * general-form section read (when the run isn't heading-delimited).
 */
export function createGetBlockRangeTool(deps: DocToolDeps): Tool {
  return buildTool({
    name: 'getBlockRange',
    description:
      'Read a contiguous run of blocks on a doc page, from `fromBlockId` to `toBlockId` (inclusive), with full content. ' +
      'Use it to pull an arbitrary span the outline collapsed; for a whole heading-delimited section prefer `getSection`, for one block `getBlock`. ' +
      '\n\n' +
      'Returns `{ fromBlockId, toBlockId, version, blocks: Block[] }`.',
    inputSchema: getBlockRangeInputSchema,
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,

    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      const current = await deps.docPageStore.getVersionedPage(
        context.userId,
        input.pageId,
      )
      if (!current) {
        return {
          data: `Page not found: ${input.pageId}. It may have been deleted or you may not have access.`,
          isError: true,
        }
      }
      const blocks = current.page.blocks
      const from = blocks.findIndex((b) => b.id === input.fromBlockId)
      const to = blocks.findIndex((b) => b.id === input.toBlockId)
      if (from === -1 || to === -1) {
        return {
          data: `Block range endpoints not found (from=${input.fromBlockId}, to=${input.toBlockId}) on page ${input.pageId}. The page may have changed — refetch the outline.`,
          isError: true,
        }
      }
      if (from > to) {
        return {
          data: `Invalid range: fromBlockId appears AFTER toBlockId on the page. Pass the endpoints in document order.`,
          isError: true,
        }
      }
      const result: DocBlockRangeResult = {
        kind: 'doc_block_range',
        pageId: input.pageId,
        version: current.version,
        fromBlockId: input.fromBlockId,
        toBlockId: input.toBlockId,
        blocks: blocks.slice(from, to + 1),
      }
      return { data: result }
    },
  })
}

// ── exportPage ───────────────────────────────────────────────────────

const exportPageInputSchema = z.object({
  pageId: pageIdSchema
    .optional()
    .describe('The page to export. Omit to export the page the user currently has open.'),
})

/**
 * `exportPage` — serialize a doc page to Markdown text the model can reuse
 * (paste into a message, fold into an email draft, hand to another tool). The
 * markdown export half of the format-conversion feature (journey C); the
 * binary `.docx` download is a page-header UI action, since a tool returns
 * text, not a file. Live `data`/`chart` blocks serialize as snapshot
 * placeholders (the bindings resolver isn't wired into the tool yet).
 *
 * Spec: docs/architecture/features/doc-conversion.md.
 */
export function createExportPageTool(deps: DocToolDeps): Tool {
  return buildTool({
    name: 'exportPage',
    description:
      'Export a doc page to Markdown text you can reuse — paste into a message, include in an email draft, or hand to another tool. ' +
      'Use it when the user asks to "export this page", "send this as a doc", or "copy this as markdown". ' +
      'Pass `pageId` (the id of the page in scope); omit it to export the page the user currently has open. ' +
      '\n\n' +
      'Returns the full page serialized as Markdown (heading, prose, lists, tables, callouts, code). ' +
      'For a downloadable Word (.docx) or .md FILE, point the user to the Export action in the page header — a tool returns text, not a file attachment.',
    inputSchema: exportPageInputSchema,
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,

    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      const pageId = input.pageId ?? deps.anchorPageId ?? undefined
      if (!pageId) {
        return {
          data: 'No page to export: pass a `pageId`, or open a page first.',
          isError: true,
        }
      }
      const current = await deps.docPageStore.getVersionedPage(context.userId, pageId)
      if (!current) {
        return {
          data: `Page not found: ${pageId}. It may have been deleted or you may not have access.`,
          isError: true,
        }
      }
      const markdown = pageToMarkdown(current.page, current.title)
      return { data: { kind: 'doc_export', pageId, title: current.title, format: 'markdown', markdown } }
    },
  })
}

// ── importToPage ─────────────────────────────────────────────────────

const importToPageInputSchema = z.object({
  fileId: z
    .string()
    .min(1)
    .describe('Id of a previously-uploaded file (from the attached-file reference shown when the user attached it).'),
  mode: z
    .enum(['faithful', 'transform'])
    .optional()
    .describe(
      "'faithful' (default) imports the document as-is and creates the page for you. 'transform' returns the document text so you can restructure or summarize it into a new page with renderPage.",
    ),
  title: z.string().max(256).optional().describe('Optional page title. Defaults to the uploaded file name.'),
})

/**
 * `importToPage` — turn a previously-uploaded `.docx`/`.md` file into a doc
 * page. The AI side of the import journey: "faithful" is the deterministic,
 * model-free path (the cached file's parsed Markdown → blocks → a new draft);
 * "transform" hands the text back so the model restructures it via renderPage
 * (the only model-routed import path, §2). Reuses the upload-time parse —
 * `.docx` is already turndown Markdown in the file cache — so no re-parse and
 * no new dependency.
 *
 * Spec: docs/architecture/features/doc-conversion.md.
 */
export function createImportToPageTool(deps: DocToolDeps): Tool {
  return buildTool({
    name: 'importToPage',
    description:
      'Import a previously uploaded .docx or .md file into a doc page. ' +
      'Use it when the user attaches a Word or Markdown document and asks to "turn this into a page", "import this file", or "make a page out of this". ' +
      '\n\n' +
      'Two modes. "faithful" (the default) converts the document exactly — headings, lists, tables, and formatting preserved, NO rewriting — and creates the page for you. "transform" instead returns the document text so YOU restructure or summarize it into a new page via renderPage; use it only when the user explicitly asks you to reshape or condense the content. ' +
      '\n\n' +
      'Input: `fileId` (from the attached-file reference), optional `mode`, optional `title` (defaults to the file name). ' +
      'Faithful returns `{ pageId, blockCount }` — the page exists and is ready, so tell the user it is open. Transform returns `{ mode: "transform", fileName, content }` for you to author from with renderPage.',
    inputSchema: importToPageInputSchema,
    isConcurrencySafe: false,
    isReadOnly: false,
    timeoutMs: 30_000,

    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate
      if (!deps.fileStore) {
        return { data: 'File import is not available in this context.', isError: true }
      }

      const file = await deps.fileStore.get(input.fileId)
      if (!file) {
        return { data: `File not found or expired: ${input.fileId}. Ask the user to re-attach it.`, isError: true }
      }

      const lower = file.fileName.toLowerCase()
      const importable =
        file.mimeType.startsWith('text/') ||
        file.mimeType === 'application/json' ||
        file.mimeType.includes('officedocument.wordprocessingml') ||
        /\.(md|markdown|txt|docx)$/.test(lower)
      if (!importable) {
        return {
          data: `"${file.fileName}" (${file.mimeType}) can't be imported as a page. Only .docx and .md/.txt documents are supported.`,
          isError: true,
        }
      }

      // The file cache holds the upload-time parse: turndown Markdown for
      // `.docx`, verbatim text for `.md`/`.txt`. Both feed the importer.
      if (input.mode === 'transform') {
        return {
          data: {
            kind: 'doc_import_transform',
            mode: 'transform',
            fileName: file.fileName,
            content: file.content,
          },
        }
      }

      const blocks = markdownToBlocks(file.content)
      const parsed = liftedPageSchema.safeParse({ blocks })
      if (!parsed.success) {
        return {
          data: `Could not build a page from "${file.fileName}" (the document produced invalid blocks).`,
          isError: true,
        }
      }
      const page = parsed.data as Page

      const baseName =
        (input.title ?? file.fileName.replace(/\.(docx|md|markdown|txt)$/i, '')).trim().slice(0, 256) ||
        'Imported document'

      const draft = await deps.savedViewStore.createDraft({
        userId: context.userId,
        workspaceId: context.workspaceId!,
        // Assistant-authored — see PageWriteActor (page self-loop guard).
        writtenBy: 'system',
        name: baseName,
        nameOrigin: 'user',
        entity: 'tasks',
        viewType: 'table',
        binding: { entity: 'tasks', viewType: 'table' },
        page,
        originPrompt: context.userMessageText,
      })

      // Same as renderPage: register the new page so a same-turn patchPage is
      // allowed past the anchor-pin, and emit page_rendered so the chat route
      // surfaces the deep-link pill + refreshes the sidebar.
      deps.turnCreatedPageIds?.add(draft.id)
      deps.onEvent?.({ type: 'page_rendered', pageId: draft.id, version: 1 }, eventCtx(context))

      return { data: { kind: 'doc_import', pageId: draft.id, blockCount: page.blocks.length } }
    },
  })
}

// ── createSubPage ────────────────────────────────────────────────────

/**
 * `createSubPage` — create a new page nested under an existing one (the
 * Notion sub-page primitive). Persists a draft `saved_views` row with
 * `nest_parent_id = parentPageId` (migration 210) so the new page appears
 * filed under its parent in the doc sidebar tree.
 *
 * Mirrors `renderPage`'s persistence path (`SavedViewStore.createDraft`)
 * but threads the nest-parent edge through. Returns the same
 * `{ pageId, version, outline }` shape so a follow-up `patchPage` can
 * reference block ids immediately.
 */
export function createCreateSubPageTool(deps: DocToolDeps): Tool {
  return buildTool({
    name: 'createSubPage',
    description:
      'Create a new page NESTED UNDER an existing doc page — the Notion sub-page primitive. ' +
      'Use this when the user wants a child page filed under the page currently open (e.g. "add a sub-page for Q3 planning", "break this section out into its own page"). ' +
      '\n\n' +
      'The new page shows up indented under its parent in the sidebar tree. Nesting is recorded on the page itself (its `nest_parent_id`), so you do NOT need to also add a block to the parent — though you may insert a `child_page` block (`{ kind: "child_page", id, childPageId }`) into the parent via `patchPage` if you also want an inline clickable link to the sub-page in the parent\'s body. ' +
      '\n\n' +
      'Input: `parentPageId` (the parent page\'s id — use the `pageId` of the page in scope), `title` (the sub-page title), an optional `icon` (an emoji for the page glyph, e.g. "🌋" — set it here, not in the title text), and an optional `page` (`{ blocks: Block[] }`) to seed initial content. Omit `page` to create an empty sub-page. ' +
      '\n\n' +
      'For a top-level page (no parent), use `renderPage` instead. To edit an existing page, use `patchPage`. ' +
      '\n\n' +
      'Returns `{ pageId, version: 1, outline }` — the new sub-page\'s id, its starting version, and the block outline for follow-up `patchPage` calls.',
    inputSchema: createSubPageInputSchema,
    isConcurrencySafe: false,
    isReadOnly: false,
    timeoutMs: 30_000,

    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      // Verify the parent page exists + is visible before nesting under it.
      // RLS hides cross-workspace rows, so a null read means "no access /
      // not found" — surface a clean error rather than minting an orphan.
      const parent = await deps.savedViewStore.getById(
        context.userId,
        input.parentPageId,
      )
      if (!parent) {
        return {
          data: `Parent page not found: ${input.parentPageId}. It may have been deleted or you may not have access. Create a top-level page with renderPage instead.`,
          isError: true,
        }
      }

      const title = input.title
      const page: Page = input.page ?? emptyPage

      // Default the legacy entity/viewType columns from the first data
      // block (back-compat window; Phase 5 drops them) — same fallback as
      // renderPage.
      const firstData = page.blocks.find(
        (b): b is Extract<Block, { kind: 'data' }> => b.kind === 'data',
      )
      const legacyBinding: BindingConfig = firstData
        ? firstData.binding
        : ({ entity: 'tasks', viewType: 'table' } as BindingConfig)

      try {
        const draft = await deps.savedViewStore.createDraft({
          userId: context.userId,
          workspaceId: context.workspaceId!,
          // Assistant-authored — see PageWriteActor (page self-loop guard).
          writtenBy: 'system',
          name: title,
          // A sub-page is always created with an explicit title → deliberate,
          // so it's frozen against auto-title from birth.
          nameOrigin: 'user',
          // Explicit page emoji, if the model chose one. A sub-page is frozen
          // against auto-title, so an icon set here is the only emoji it gets
          // unless the user later picks one.
          icon: input.icon ?? null,
          // Legacy `saved_views.entity` enum default for a custom-table page.
          entity: legacyBinding.entity === 'custom' ? 'tasks' : legacyBinding.entity,
          viewType: legacyBinding.viewType,
          binding: legacyBinding,
          page,
          nestParentId: input.parentPageId,
          // Snapshot the prompt that triggered this sub-page → History "first
          // prompt" (migration 231). Undefined on turns with no user message.
          originPrompt: context.userMessageText,
        })

        const versionedPage: VersionedPage = {
          blocks: page.blocks,
          version: 1,
          title,
        }
        const outline: Outline = buildOutline(versionedPage, {
          pageId: draft.id,
          pageVersion: 1,
          title,
        })

        // Register the freshly-minted sub-page so a same-turn `patchPage` to it
        // is allowed past the anchor-pin (intentional, not a stale recall).
        deps.turnCreatedPageIds?.add(draft.id)
        deps.onEvent?.(
          {
            type: 'sub_page_created',
            pageId: draft.id,
            parentPageId: input.parentPageId,
          },
          eventCtx(context),
        )

        return {
          data: {
            kind: 'doc_sub_page' as const,
            pageId: draft.id,
            version: 1,
            outline,
          },
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { data: `Failed to create sub-page: ${message}`, isError: true }
      }
    },
  })
}

// ── Aggregate factory ───────────────────────────────────────────────

/**
 * Build all six doc tools at once. The Phase-1 inject site
 * (`packages/api/src/doc/inject.ts`, owned by Agent P1I) calls this
 * and merges the result into the per-turn tool map.
 */
export function createDocTools(deps: DocToolDeps): {
  renderPage: Tool
  patchPage: Tool
  getBlock: Tool
  queryDataBlock: Tool
  getCurrentPage: Tool
  getSection: Tool
  getBlockRange: Tool
  createSubPage: Tool
  exportPage: Tool
  importToPage: Tool
} {
  return {
    renderPage: createRenderPageTool(deps),
    patchPage: createPatchPageTool(deps),
    getBlock: createGetBlockTool(deps),
    queryDataBlock: createQueryDataBlockTool(deps),
    getCurrentPage: createGetCurrentPageTool(deps),
    getSection: createGetSectionTool(deps),
    getBlockRange: createGetBlockRangeTool(deps),
    createSubPage: createCreateSubPageTool(deps),
    exportPage: createExportPageTool(deps),
    importToPage: createImportToPageTool(deps),
  }
}
