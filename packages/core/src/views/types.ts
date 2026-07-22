/**
 * Server-side types for Q5 Views — saved-view records and per-entity
 * binding configs.
 *
 * The discriminated union on `BindingConfig` encodes the locked decisions
 * from docs/plans/company-brain.md §16 (calendar added by migration 357):
 *   - tasks: table | board (group by status) | calendar (dateBy due)
 *   - deals: table | board (group by stage)
 *   - contacts / companies / workflow_runs: table-only
 *
 * Combinations like `{entity:'companies', viewType:'board'}` are rejected
 * at compile time. Same property holds at runtime via the Zod schema in
 * `./schemas.ts`.
 *
 * See docs/architecture/features/views.md for the feature spec.
 */

import type { DealStage } from '../crm/types.js'
import type { TaskRecordStatus } from '../tasks/types.js'
import type { WorkflowRunStatus } from '../workflow/types.js'

// ── Entity / view-type enums ──────────────────────────────────────────

export const VIEW_ENTITIES = [
  'tasks',
  'contacts',
  'companies',
  'deals',
  'workflow_runs',
] as const
export type ViewEntity = (typeof VIEW_ENTITIES)[number]

export const VIEW_TYPES = ['table', 'board', 'calendar'] as const
export type ViewType = (typeof VIEW_TYPES)[number]

// ── Per-entity column ids ─────────────────────────────────────────────
//
// Closed sets so the bindings catalog can enforce "only known columns";
// per-workspace custom columns are explicit v2 scope.

export const TASK_COLUMN_IDS = [
  'title',
  'status',
  'assignee',
  'due',
  'tags',
  'updated_at',
] as const
export type TaskColumnId = (typeof TASK_COLUMN_IDS)[number]

export const CONTACT_COLUMN_IDS = [
  'name',
  'company',
  'email',
  'tags',
  'updated_at',
] as const
export type ContactColumnId = (typeof CONTACT_COLUMN_IDS)[number]

export const COMPANY_COLUMN_IDS = [
  'name',
  'domain',
  'tags',
  'updated_at',
] as const
export type CompanyColumnId = (typeof COMPANY_COLUMN_IDS)[number]

export const DEAL_COLUMN_IDS = [
  'name',
  'company',
  'contact',
  'stage',
  'amount',
  'close_date',
  'updated_at',
] as const
export type DealColumnId = (typeof DEAL_COLUMN_IDS)[number]

export const WORKFLOW_RUN_COLUMN_IDS = [
  'started_at',
  'status',
  'trigger_kind',
  'triggered_by',
  'finished_at',
  'error',
] as const
export type WorkflowRunColumnId = (typeof WORKFLOW_RUN_COLUMN_IDS)[number]

// ── Per-view display state (Notion-database UX) ───────────────────────
//
// Persisted UI state for a table data block: column widths, order, hidden
// set, frozen-count, sort, and filter chips. It lives ON the binding
// (`binding.display`) so it round-trips through the Yjs doc doc and the
// no-persistence `renderBinding` call without a migration — the data block
// already carries the binding verbatim. This is deliberately a *per-view*
// concern (like Notion: the same underlying data renders with different
// widths/sorts in different views), not a property of the entity schema.
//
// The doc client seeds the view toolbar from this and writes changes
// back; `apply-view-config.ts` (app-web) projects a resolved TableWidget
// through it before render. Built-in and user-defined (custom) tables share
// the exact same mechanism.

type ViewSort = {
  field: string
  direction: 'asc' | 'desc'
}

/** One persisted filter chip. `op` matches the doc FilterBar operator ids
 *  (`contains` / `is` / `gt` / `before` / …); `value` is the comparand. */
type ViewColumnFilter = {
  propertyName: string
  op: string
  value?: string | number | boolean | string[] | null
}

type ViewDisplay = {
  /** Per-column pixel widths, keyed by column `field`. */
  columnWidths?: Record<string, number>
  /** Column `field` order (a permutation/subset of the binding's columns). */
  order?: string[]
  /** Hidden column `field`s (projected out of the rendered table). */
  hidden?: string[]
  /** Freeze the first N columns (sticky left). */
  frozenCount?: number
  /** Persisted single-column sort, or `null` for unsorted. */
  sort?: ViewSort | null
  /** Persisted filter chips, ANDed together. */
  filters?: ViewColumnFilter[]
}

// ── BindingConfig — discriminated union per entity / view-type ────────

export type TasksTableBinding = {
  entity: 'tasks'
  viewType: 'table'
  filters?: {
    status?: TaskRecordStatus[]
    assigneeId?: string
    tag?: string
    /** ISO datetime. */
    dueBefore?: string
    /** ISO datetime. */
    dueAfter?: string
  }
  columns?: TaskColumnId[]
  /** Notion-database per-view display state. See {@link ViewDisplay}. */
  display?: ViewDisplay
}

export type TasksBoardBinding = {
  entity: 'tasks'
  viewType: 'board'
  /** Only `status` is groupable in v1. */
  groupBy: 'status'
  filters?: {
    assigneeId?: string
    tag?: string
  }
  columns?: TaskColumnId[]
}

export type TasksCalendarBinding = {
  entity: 'tasks'
  viewType: 'calendar'
  /**
   * Only `due` is a valid date axis in v1 — mirrors the board's required
   * `groupBy` literal so the discriminator stays two explicit fields and a
   * future deals calendar (`dateBy: 'close_date'`) is additive.
   */
  dateBy: 'due'
  filters?: {
    status?: TaskRecordStatus[]
    assigneeId?: string
    tag?: string
  }
  columns?: TaskColumnId[]
}

export type ContactsTableBinding = {
  entity: 'contacts'
  viewType: 'table'
  filters?: {
    query?: string
    tag?: string
    companyId?: string
  }
  columns?: ContactColumnId[]
  /** Notion-database per-view display state. See {@link ViewDisplay}. */
  display?: ViewDisplay
}

export type CompaniesTableBinding = {
  entity: 'companies'
  viewType: 'table'
  filters?: {
    query?: string
    tag?: string
  }
  columns?: CompanyColumnId[]
  /** Notion-database per-view display state. See {@link ViewDisplay}. */
  display?: ViewDisplay
}

export type DealsTableBinding = {
  entity: 'deals'
  viewType: 'table'
  filters?: {
    stage?: DealStage[]
    contactId?: string
    companyId?: string
  }
  columns?: DealColumnId[]
  /** Notion-database per-view display state. See {@link ViewDisplay}. */
  display?: ViewDisplay
}

export type DealsBoardBinding = {
  entity: 'deals'
  viewType: 'board'
  /** Only `stage` is groupable in v1. */
  groupBy: 'stage'
  filters?: {
    contactId?: string
    companyId?: string
  }
  columns?: DealColumnId[]
}

export type WorkflowRunsTableBinding = {
  entity: 'workflow_runs'
  viewType: 'table'
  filters: {
    /** Required — there is no "all workflow runs in workspace" view in v1. */
    workflowId: string
    status?: WorkflowRunStatus[]
  }
  columns?: WorkflowRunColumnId[]
  /** Notion-database per-view display state. See {@link ViewDisplay}. */
  display?: ViewDisplay
}

/**
 * A user-defined entity table (Phase B — the Notion *editable* database).
 * Renders an `entity_types` row's instances as a table whose columns ARE the
 * type's declared properties, so the column header menu can rename / retype /
 * insert / delete them (the `editableColumns` path). `entity: 'custom'` keeps
 * it out of the built-in `ViewEntity` enum; `buildPayload` resolves it through
 * the injected `docEntityStore`. Reuses the same `display` view-state as the
 * built-in tables.
 */
type CustomEntityTableBinding = {
  entity: 'custom'
  /** `entity_types.id` of the user-defined type this table renders. */
  entityTypeId: string
  viewType: 'table'
  /** Optional subset/order of property names to show (all properties by default). */
  columns?: string[]
  /** Notion-database per-view display state. See {@link ViewDisplay}. */
  display?: ViewDisplay
}

export type BindingConfig =
  | TasksTableBinding
  | TasksBoardBinding
  | TasksCalendarBinding
  | ContactsTableBinding
  | CompaniesTableBinding
  | DealsTableBinding
  | DealsBoardBinding
  | WorkflowRunsTableBinding
  | CustomEntityTableBinding

// ── SavedView record ──────────────────────────────────────────────────

/**
 * Notion-redesign state. Chat-rendered views are created as `'draft'`
 * with an `autoPruneAt` 30 days in the future; the daily prune worker
 * deletes them after that. The user can `save` a draft (state →
 * `'saved'`, autoPruneAt → null) or `unsave` a saved view (back to
 * `'draft'`).
 */
export const VIEW_STATES = ['draft', 'saved'] as const
export type ViewState = (typeof VIEW_STATES)[number]

/**
 * Provenance of a page's `name` (its title), tracked by migration 218 to
 * drive auto-title (doc pages):
 *
 *   - `'placeholder'` — the untouched default name. The only state the
 *     auto-title triggers fire on.
 *   - `'auto'` — a machine-generated title (fired once). Won't re-fire, but
 *     a user rename still overrides it.
 *   - `'user'` — a deliberate rename (human inline/sidebar/breadcrumb, or the
 *     AI's explicit `setTitle` op). Frozen against auto-title forever.
 *
 * See docs/architecture/features/doc.md → "Auto-title".
 */
export const NAME_ORIGINS = ['placeholder', 'auto', 'user'] as const
export type NameOrigin = (typeof NAME_ORIGINS)[number]

export type SavedView = {
  id: string
  workspaceId: string
  /** users.id — the user who created the view. Matches workflows.created_by pattern. */
  createdBy: string
  name: string
  /**
   * Provenance of `name` (migration 218). Drives auto-title: only
   * `'placeholder'` rows are eligible. See {@link NameOrigin}.
   */
  nameOrigin: NameOrigin
  description: string | null
  /**
   * Per-page emoji icon (migration 211). An emoji grapheme like `"🚀"`, or
   * `null` to fall back to a derived glyph in the UI.
   */
  icon: string | null
  /**
   * Stable cross-run identity for a machine-authored page (the partial unique
   * index on `(workspace_id, anchor_key)`), so a re-run converges on the same
   * page instead of littering drafts.
   *
   * It is also the ONLY link from a page back to what produced it. A recording
   * brief carries `recording-synthesis:<recordingId>`, which is how the doc
   * shell knows to mount a player and make the page's `[H:MM:SS]` citations
   * seekable. Null for a hand-authored page.
   */
  anchorKey: string | null
  /**
   * A recording MANUALLY linked to this page (migration 339). Distinct from
   * `anchorKey`: that carries a machine-authored synthesis identity a second
   * page cannot borrow, while this is a user pointing an arbitrary page at an
   * existing recording to surface its player, transcript, and action items.
   * The doc shell resolves the `anchorKey` recording first and falls back to
   * this, so a real synthesis brief always wins. Null when unlinked.
   */
  linkedRecordingId: string | null
  entity: ViewEntity
  viewType: ViewType
  /** Legacy single-binding source of truth — used by pre-Notion-redesign rows. */
  binding: BindingConfig
  /** Notion-redesign page-block model. Null on rows that never received a page (none after migration 184). */
  page: import('./blocks.js').Page | null
  state: ViewState
  /**
   * Doc page-tree nesting (migration 210). The `saved_views.id` of the
   * page this one is filed *under* in the sidebar, or `null` for a
   * workspace-root page. DISTINCT from fork/branch lineage (`parent_page_id`,
   * migration 200) — this is the sidebar hierarchy edge.
   */
  nestParentId?: string | null
  /** Sibling ordering within the nest parent (or root). Kept 0..n-1 by the tree API. */
  position?: number
  /**
   * Notion-style per-page width mode (migration 220). `true` = full width;
   * `false` (default) = the constrained centered column. Doc-only chrome —
   * the doc client reads it to pick the body wrapper width.
   */
  fullWidth: boolean
  /**
   * Page-level clearance (migration 212). Gates page-open at doc-sync
   * (member must clear it) and is the value the doc page-header pill
   * shows/sets (migration 224 era). `'internal'` default.
   */
  clearance: 'public' | 'internal' | 'confidential'
  /**
   * The teamspace this page is filed in (migration 313), or `null` for a
   * page private to its creator. Teamspace membership is a hard access
   * boundary carried by the `saved_views` RLS policy; the sidebar groups
   * sections by this value. See docs/architecture/features/teamspaces.md.
   * Optional at the type level (like `nestParentId`) so pre-313 fixtures
   * and mocks stay valid; the DB rows always carry the column.
   */
  teamspaceId?: string | null
  /**
   * The user's *first prompt* — the chat message that created this page
   * (migration 231). Snapshotted at creation by the `renderPage` /
   * `createSubPage` doc tools from the turn's user message; `null` on
   * pre-existing rows and on pages created by any non-chat path. Surfaced
   * read-only in the doc History panel, gated exactly like the page.
   */
  originPrompt: string | null
  autoPruneAt: Date | null
  /**
   * Per-page "Sync to brain" opt-in (migration 001_doc_brain_sync). When true,
   * an authored-content change on save/settle auto-ingests the page into the
   * brain via Pipeline B. Default false. See
   * docs/architecture/brain/ingest-pipeline.md.
   */
  brainSyncEnabled: boolean
  /**
   * The authored-content hash of the last brain ingest (or `null` if never
   * ingested). The auto-on-save trigger compares the current authored hash
   * against this before firing — the dedup half of the re-ingest-storm guard.
   */
  brainLastIngestHash: string | null
  /**
   * When the page was last ingested into the brain (or `null` if never). The
   * auto-on-save trigger also waits for a cooldown since this timestamp — the
   * cooldown half of the storm guard.
   */
  brainLastIngestAt: Date | null
  /**
   * True while an interactively-created draft (doc-editor blank / from-template
   * flows, via `POST /views/draft`) is waiting to fire its `created` page-event
   * trigger. The store skips the immediate emit for these drafts; the client
   * commits the event after debounced typing or on navigating away
   * (`commitCreatedEvent`), which flips this back to false and emits `created`
   * exactly once. Always false for programmatic creates (they emit immediately)
   * and for any committed / older row. Migration 283.
   */
  createdEventPending: boolean
  createdAt: Date
  updatedAt: Date
}

export type SavedViewListRow = Pick<
  SavedView,
  | 'id'
  | 'workspaceId'
  | 'name'
  | 'nameOrigin'
  | 'description'
  | 'icon'
  | 'entity'
  | 'viewType'
  | 'state'
  | 'nestParentId'
  | 'position'
  | 'teamspaceId'
  | 'updatedAt'
>

export type SavedViewListFilters = {
  workspaceId: string
  userId: string
  entity?: ViewEntity
  /** Filter by state — defaults to `'saved'` for the sidebar listing. Pass `'all'` to include drafts. */
  state?: ViewState | 'all'
  limit?: number
}

export type SavedViewUpdateFields = {
  name?: string
  /**
   * Provenance to stamp alongside a `name` change (migration 218). A
   * user-driven rename passes `'user'` to freeze the title against
   * auto-title. Omit to leave unchanged. NOT settable to `'auto'` here —
   * the placeholder→auto transition goes through `setAutoTitle` so it's
   * race-safe and conditional.
   */
  nameOrigin?: NameOrigin
  /** Pass `null` to clear; omit to leave unchanged. */
  description?: string | null
  /** Per-page emoji icon. Pass `null` to clear; omit to leave unchanged. */
  icon?: string | null
  /** Notion-style per-page width mode (migration 220). Omit to leave unchanged. */
  fullWidth?: boolean
  /** Page-level clearance (migration 212). Omit to leave unchanged. Callers
   *  must validate the new value is ≤ the setter's own clearance. */
  clearance?: 'public' | 'internal' | 'confidential'
  /**
   * Link a recording to this page, or `null` to unlink (migration 339). The
   * route validates the recording is in this page's workspace and the caller
   * can see it. Omit to leave unchanged.
   */
  linkedRecordingId?: string | null
  binding?: BindingConfig
  /**
   * Per-page "Sync to brain" toggle (migration 001_doc_brain_sync). When true,
   * an authored-content change on save/settle auto-ingests the page into the
   * brain. Omit to leave unchanged. See
   * docs/architecture/brain/ingest-pipeline.md (the on-request `ingestPage`
   * becomes ALSO auto via this toggle).
   */
  brainSyncEnabled?: boolean
}

/**
 * Constructor args for the chat-driven draft creation path. The chat
 * tool seeds the page with a single data block from the binding; the
 * route layer creates an empty page.
 */
export type CreateDraftInput = {
  userId: string
  workspaceId: string
  name: string
  /**
   * Title provenance for the new row (migration 218). Defaults to
   * `'placeholder'` — the draft is born auto-title-eligible. Pass `'user'`
   * when the caller already supplied a real title (e.g. `renderPage`/
   * `createSubPage` with an explicit title) so auto-title leaves it alone.
   */
  nameOrigin?: NameOrigin
  /**
   * Per-page emoji icon (migration 211). Defaults to `null` — the row shows a
   * derived glyph until someone (the user via the picker, the AI via
   * `renderPage`/`createSubPage`/`setIcon`, or auto-title's COALESCE
   * suggestion) sets one. Pass an emoji to seed it at creation.
   */
  icon?: string | null
  entity: ViewEntity
  viewType: ViewType
  binding: BindingConfig
  page: import('./blocks.js').Page
  /**
   * Doc page-tree nesting (migration 210). When set, the new draft is
   * filed under this `saved_views.id` in the sidebar. `null`/omitted →
   * workspace-root page. Used by the `createSubPage` doc tool.
   */
  nestParentId?: string | null
  /**
   * The user's first prompt to snapshot as `origin_prompt` (migration 231) —
   * the chat message that triggered this page's creation. The doc tools
   * pass the turn's user message; omitted / `null` on non-chat paths.
   */
  originPrompt?: string | null
  /**
   * Teamspace placement (migration 313). Tri-state:
   *  - **omitted (`undefined`)** — inherit the parent's teamspace when
   *    `nestParentId` is set, else file into the workspace's default
   *    (General) teamspace. Every server-side / AI / workflow path takes
   *    this default so team deliverables stay team-visible.
   *  - **a teamspace id** — file into that teamspace (the sidebar section
   *    "+" passes the section's id).
   *  - **`null`** — explicitly private to the creator (the Private
   *    section's create). See docs/architecture/features/teamspaces.md.
   */
  teamspaceId?: string | null
  /** Defaults to 30 days. Ignored when `state` is `'saved'` (never prunes). */
  autoPruneDays?: number
  /**
   * Lifecycle state the row is BORN in. Defaults to `'draft'` — the
   * chat-rendered-view contract: ephemeral, `auto_prune_at` 30 days out, the
   * prune worker deletes it unless the user saves it or files it under a saved
   * ancestor.
   *
   * Pass `'saved'` for a page that is a **durable artifact of an explicit,
   * paid action** rather than a speculative render — a blueprint/synthesis
   * brief is the case this exists for. Such a page is born with
   * `auto_prune_at = NULL`, so no prune path can reach it, and it appears in
   * the default (`state='saved'`) sidebar listing immediately.
   *
   * See docs/architecture/brain/structural-synthesis.md → "Brief durability".
   */
  state?: ViewState
  /**
   * Stable cross-run identity (migration 279). Set by the workflow executor's
   * `page.reuse === 'per-workflow'` path to `<workflowId>:<stepId>` so a
   * recurring workflow's anchor page is found-and-reused instead of minting an
   * empty duplicate each fire. Unique per `(workspace_id, anchor_key)`.
   * Omitted / null on every non-workflow path.
   */
  anchorKey?: string | null
  /** See {@link PageWriteActor}. Defaults to `'user'`. */
  writtenBy?: PageWriteActor
  /**
   * Defer the `created` page-event-trigger instead of emitting it at creation
   * (migration 283). Set by the interactive `POST /views/draft` route so the
   * doc-editor "blank page" / "from template" flows don't fire a workflow on an
   * empty just-minted page. The row is marked `created_event_pending`; the
   * client later fires it once via `commitCreatedEvent` (debounced typing, or a
   * flush on navigating away). Omitted / false on programmatic paths
   * (brain-MCP, workflow anchor), which keep emitting `created` immediately.
   */
  deferCreatedEvent?: boolean
}

/**
 * Who produced a page write, for the workflow `page` event source's self-loop
 * guard (the page analog of a channel's bot-author flag). A write reaches the
 * dispatcher as `isBot = writtenBy === 'system'`, and a `page`-source
 * subscription only fires on a `'system'` write when it set `match.fromBots`.
 *
 *  - `'user'` (default) — a human edit through the doc-editor REST routes.
 *  - `'system'` — any automated / assistant write: a workflow step's page
 *    anchor (`createAnchorPage`), the assistant doc tools (`createSubPage` /
 *    `patchPage` / `renderPage`), or an external agent via brain-MCP. This is
 *    what stops a workflow that writes a page under a page it watches from
 *    re-triggering itself. See docs/architecture/features/workflow.md → "Page
 *    event source".
 */
export type PageWriteActor = 'user' | 'system'

// ── Store interface ───────────────────────────────────────────────────

export type SavedViewStore = {
  create(params: {
    userId: string
    workspaceId: string
    name: string
    description?: string | null
    binding: BindingConfig
    /** See {@link PageWriteActor}. Defaults to `'user'`. */
    writtenBy?: PageWriteActor
  }): Promise<SavedView>

  /**
   * Returns the full record. RLS hides cross-workspace rows — the caller
   * sees `null` regardless of whether the id is invalid or out-of-scope.
   */
  getById(userId: string, id: string): Promise<SavedView | null>

  list(filters: SavedViewListFilters): Promise<SavedViewListRow[]>

  update(
    userId: string,
    id: string,
    fields: SavedViewUpdateFields,
    /** See {@link PageWriteActor}. Defaults to `'user'`. */
    writtenBy?: PageWriteActor,
  ): Promise<SavedView | null>

  /**
   * Hard delete. Returns `true` if a row was removed, `false` if RLS
   * hid it or the id didn't exist.
   */
  remove(userId: string, id: string): Promise<boolean>

  // ── Notion-redesign extensions ────────────────────────────────────

  /**
   * Read just the page field. Cheaper than getById when the editor
   * only needs the blocks.
   */
  getPage(userId: string, id: string): Promise<import('./blocks.js').Page | null>

  /**
   * Replace the page atomically. Returns true if a row was updated,
   * false if RLS hid it or the row was missing.
   */
  updatePage(userId: string, id: string, page: import('./blocks.js').Page): Promise<boolean>

  /**
   * Flip the row's state. Clearing autoPruneAt on `'saved'`, setting
   * it on `'draft'` is the responsibility of the caller (the route
   * layer composes setState + setAutoPruneAt in one update).
   */
  setState(userId: string, id: string, state: ViewState): Promise<boolean>

  /**
   * Set or clear the prune timestamp. Pass `null` to clear.
   */
  setAutoPruneAt(userId: string, id: string, when: Date | null): Promise<boolean>

  /**
   * Create a draft. Seeded with `page` (often a single data block from
   * the chat tool, or `emptyPage` from the route layer).
   */
  createDraft(params: CreateDraftInput): Promise<SavedView>

  /**
   * Fire the deferred `created` page-event for an interactively-created draft
   * (one created with `deferCreatedEvent`). Atomically clears
   * `created_event_pending` and emits the `created` lifecycle event **only if
   * this call won the flip** — so concurrent commits (the typing debounce vs the
   * navigate-away flush, a double-click, a reload) fire the workflow exactly
   * once. A no-op (returns `false`) for an already-committed row, a row that was
   * never deferred, or one hidden by RLS. Migration 283.
   */
  commitCreatedEvent(userId: string, id: string): Promise<boolean>

  /**
   * Resolve a page id by its stable cross-run `anchor_key` (migration 279),
   * scoped to a workspace. Backs the workflow executor's
   * `page.reuse === 'per-workflow'` find-or-create: a hit means the recurring
   * anchor page already exists and should be reused. RLS-scoped by `userId`
   * (a workspace member). Returns `null` when no page carries the key.
   */
  findIdByAnchorKey(
    userId: string,
    workspaceId: string,
    anchorKey: string,
  ): Promise<string | null>

  /**
   * Auto-title commit (doc pages, migration 218). Set `name = title` +
   * flip `name_origin` `'placeholder'` → `'auto'` in ONE guarded UPDATE,
   * but ONLY while the row is still on its untouched placeholder name.
   *
   * `icon` is the emoji the generator suggested alongside the title. It is
   * applied with `COALESCE(icon, $icon)` — a user-chosen emoji is never
   * clobbered, and `null` (the model emitted no emoji) leaves the existing
   * icon untouched. So the first auto-title can fill in BOTH the name and a
   * fitting icon for a fresh draft, while respecting any icon the user set.
   *
   * Returns the written `{ name, icon }` when it landed, or `null` when the
   * row was already touched (`'auto'`/`'user'`) or RLS hid it. The single
   * conditional statement makes the placeholder→auto transition race-safe
   * across the human (client endpoint) and AI (chat post-turn) triggers —
   * whichever fires first wins; the loser no-ops. Idempotent: re-running
   * after the flip returns `null` without rewriting.
   */
  setAutoTitle(
    userId: string,
    id: string,
    title: string,
    icon?: string | null,
  ): Promise<{ name: string; icon: string | null } | null>

  // ── Doc page-tree (migration 210) ──────────────────────────────

  /**
   * Move a page to a new nest parent + sibling position in the doc
   * sidebar tree. Pass `newNestParentId = null` to promote the page to a
   * workspace-root position.
   *
   * Guards against cycles: rejects (`false`) when `newNestParentId === id`
   * or when `id` is an ancestor of `newNestParentId` (which would create a
   * loop). On success, also reindexes the destination siblings so their
   * `position`s stay contiguous 0..n-1.
   *
   * Returns `true` if the row was moved, `false` on a cycle rejection or
   * when RLS hid the row / it didn't exist.
   */
  reparent(
    userId: string,
    id: string,
    newNestParentId: string | null,
    position: number,
    /** See {@link PageWriteActor}. Defaults to `'user'`. */
    writtenBy?: PageWriteActor,
    /**
     * Teamspace destination for a root drop (migration 313), meaningful only
     * when `newNestParentId === null`: a teamspace id files the page at that
     * section's root, `null` moves it to the caller's Private section, and
     * `undefined` keeps the page's current teamspace (a plain reorder /
     * promote-to-root). When `newNestParentId` is a page, the child always
     * adopts that parent's teamspace and this argument is ignored. The move
     * cascades `teamspace_id` across the page's whole descendant subtree so
     * the denormalization stays true.
     */
    teamspaceId?: string | null,
  ): Promise<boolean>

  /**
   * Set the `position` of each id to its index in `orderedIds`, in one
   * transaction. `nestParentId` scopes the sibling set (`null` for the
   * workspace-root list). Used by the sidebar drag-reorder loop.
   */
  reorderSiblings(
    userId: string,
    nestParentId: string | null,
    orderedIds: string[],
  ): Promise<void>

  /**
   * Sweep expired drafts. Returns the ids that were deleted. System-
   * level; called by `views-prune-worker`. No userId — RLS bypass
   * required.
   */
  pruneExpiredDraftsSystem(): Promise<string[]>

  // ── Brain sync (migration 001_doc_brain_sync) ──────────────────────

  /**
   * Read a page's brain-sync state WITHOUT a userId — for the auto-on-save
   * trigger, which runs system-side (doc-sync persists with a bare `query()`;
   * the API `/internal/ingest-page` endpoint resolves the page's owner before
   * running the runner). Returns `null` if the row is gone.
   *
   * The trigger reads `brainSyncEnabled` (the gate), `brainLastIngestHash`
   * (the dedup key), and `brainLastIngestAt` (the cooldown anchor), plus the
   * `workspaceId` + `createdBy` it needs to scope the ingest to the page owner.
   */
  getBrainSyncStateSystem(id: string): Promise<{
    workspaceId: string
    createdBy: string
    brainSyncEnabled: boolean
    brainLastIngestHash: string | null
    brainLastIngestAt: Date | null
  } | null>

  /**
   * Stamp the result of a brain ingest — set `brain_last_ingest_hash` +
   * `brain_last_ingest_at = now()` so the next save can dedup + cooldown
   * against them. System-level (the runner already resolved + authorised the
   * page owner). Returns `true` if a row was updated.
   */
  markBrainIngestedSystem(id: string, contentHash: string): Promise<boolean>

  // ── Page event source (content-edit updated events) ─────────────────

  /**
   * Read the fields a `page`-source `updated` event needs WITHOUT a userId —
   * for the content-edit trigger (doc-sync persists a Yjs snapshot system-side,
   * then signals the API `/internal/page-event` endpoint, which has no member
   * context). Returns `null` if the row is gone.
   *
   * Block-content edits don't flow through the metadata `update` method (they
   * live in the collaborative Y.Doc / `documents` table), so the store can't
   * emit their `updated` event from a write path. This read backs the
   * out-of-band emit: `workspaceId` + `parentId` (`nest_parent_id`) + `title`
   * (`name`) are exactly the `PageLifecycleEvent` fields the dispatcher needs.
   */
  getPageEventContextSystem(id: string): Promise<{
    workspaceId: string
    parentId: string | null
    title: string | null
  } | null>
}
