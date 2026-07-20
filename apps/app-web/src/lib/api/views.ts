/**
 * SDK for the Notion-redesign Views surface (apps/web).
 *
 * Thin typed wrappers around the page-model routes in
 * `packages/api/src/routes/views.ts` (migration 184). All calls go
 * through `authFetch` so token refresh is handled transparently.
 *
 * Wire types are declared locally rather than imported from
 * `@use-brian/core` — the core barrel pulls in `skills/loader` which
 * uses Node's `fs`, breaking client bundles. (The same constraint
 * drives `packages/views-renderer/src/types.ts` to import from
 * `@use-brian/core/dist/views/a2ui.js` directly.) The shapes here
 * mirror the canonical types in `packages/core/src/views/blocks.ts`
 * and `packages/core/src/views/types.ts`; the Zod validators on the
 * server are the authoritative contract.
 *
 * See `docs/architecture/features/views.md` § Phase 1 → HTTP routes.
 *
 * [COMP:app-web/views-sdk]
 */

import { authFetch } from "@/lib/auth-fetch";
import type { ViewPayload } from "@use-brian/views-renderer";
import type {
  CustomPageTemplate,
  CustomPageTemplateSummary,
  CustomTemplateCreateInput,
  ExtractionSpec,
} from "@use-brian/doc-model";
import {
  Briefcase,
  Building2,
  CheckSquare,
  FileText,
  LayoutGrid,
  type LucideIcon,
  Table2,
  Users,
  Workflow,
} from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

// ── Wire-format types (mirror `@use-brian/core/src/views/*`) ─────────

export type ViewEntity =
  | "tasks"
  | "contacts"
  | "companies"
  | "deals"
  | "workflow_runs";
export type ViewType = "table" | "board";
export type ViewState = "draft" | "saved";

/**
 * Title provenance (migration 218). `'placeholder'` is a fresh, untouched
 * draft — the only state auto-title fires on, and the state that shows a
 * generic "draft" glyph + the auto-title hint animation instead of the
 * entity-derived icon. `'auto'` / `'user'` are settled titles.
 */
export type NameOrigin = "placeholder" | "auto" | "user";

/**
 * Server-validated BindingConfig — narrow client-side shape. We treat
 * it as an opaque blob because the `data` block carries it through
 * unchanged; the server re-validates every PATCH.
 */
export type BindingConfig = {
  /** `'custom'` (Phase B) renders a user-defined entity table whose columns
   *  ARE the type's properties (editable). `entityTypeId` is then required. */
  entity: ViewEntity | "custom";
  /** `entity_types.id` — set only when `entity === 'custom'`. */
  entityTypeId?: string;
  viewType: ViewType;
  filters?: Record<string, unknown>;
  columns?: string[];
  groupBy?: string;
  /**
   * Notion-database per-view display state (column widths / order / hidden /
   * frozen-count / sort / filter chips). Migration-free: it rides on the data
   * block's binding, so it round-trips through the Yjs doc doc and the
   * no-persistence `renderBinding` call. Mirrors `ViewDisplay` in
   * `packages/core/src/views/types.ts`; the server Zod (`viewDisplaySchema`)
   * is authoritative — fields absent there are stripped on the round-trip.
   */
  display?: ViewDisplay;
};

/** Notion-database per-view display state. Mirrors core `ViewDisplay`. */
export type ViewDisplay = {
  columnWidths?: Record<string, number>;
  order?: string[];
  hidden?: string[];
  frozenCount?: number;
  sort?: { field: string; direction: "asc" | "desc" } | null;
  filters?: { propertyName: string; op: string; value?: unknown }[];
};

export type TextBlock = {
  kind: "text";
  id: string;
  text: string;
  variant?: "body" | "muted" | "caption";
};

export type HeadingBlock = {
  kind: "heading";
  id: string;
  level: 1 | 2 | 3 | 4;
  text: string;
};

export type DividerBlock = {
  kind: "divider";
  id: string;
};

export type DataBlock = {
  kind: "data";
  id: string;
  binding: BindingConfig;
};

/**
 * Inline, model-authored chart values — the *static* chart source (a
 * snapshot, used to visualise research findings). Which field applies is
 * decided by the block's `chartType`: bar/pie read `points`, line reads
 * `series`, kpi reads `value`. Mirrors the canonical core `ChartData` in
 * `packages/core/src/views/blocks.ts`.
 */
export type ChartData = {
  points?: { label: string; value: number; color?: string }[];
  series?: { name: string; points: { x: string | number; y: number }[] }[];
  value?: number | string;
  delta?: number;
  format?: "plain" | "currency" | "percent" | "integer";
  currency?: string;
  tone?: "default" | "success" | "warning" | "danger";
  orientation?: "vertical" | "horizontal";
};

/**
 * A chart block — carries EXACTLY ONE source: `data` (inline,
 * model-authored values — the static research path, rendered directly by
 * the editor) OR `binding` (a live aggregation over workspace entities,
 * opaque here and resolved server-side). Mirrors the canonical core
 * `ChartBlock`; the server Zod (`blockSchema`) is authoritative.
 */
export type ChartBlock = {
  kind: "chart";
  id: string;
  chartType: "kpi" | "bar" | "line" | "pie";
  title?: string;
  data?: ChartData;
  binding?: Record<string, unknown>;
};

/**
 * A diagram block — model-authored Mermaid source the renderer compiles to
 * SVG client-side (`views-renderer`'s `Diagram` widget). v1 is Mermaid-only
 * and static. Mirrors the canonical core `DiagramBlock`.
 */
export type DiagramBlock = {
  kind: "diagram";
  id: string;
  syntax: "mermaid";
  code: string;
  title?: string;
};

// ── Phase 2 block extensions ─────────────────────────────────────────
//
// Mirrors the local block shapes declared in each `block-<kind>.tsx`
// component. The Tiptap rich-text content is opaque (`JSONContent`) —
// the SDK accepts any JSON-serialisable object so the wire stays
// flexible while the renderer threads it straight into Tiptap.
//
// The canonical core union (`packages/core/src/views/blocks.ts`) now
// covers all 17 content kinds — `text` / `heading` / `divider` / `data` /
// `chart` / `image` / `video` / `audio` / `file` / `bookmark` plus the
// Phase 2.5 rich kinds `callout` / `code` / `quote` / `bulleted_list_item` /
// `numbered_list_item` / `to_do` / `toggle` — plus `child_page` (18 total).
// The shapes here mirror that union; the server Zod (`blockSchema`) is the
// authoritative contract and now validates rich blocks authored through
// `renderPage` / `patchPage`.

export type RichTextContent = Record<string, unknown>;

export type FileRef = {
  bucket: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
  name: string;
};

export type CalloutBlock = {
  kind: "callout";
  id: string;
  icon: string;
  richText?: RichTextContent;
};

export type CodeBlock = {
  kind: "code";
  id: string;
  language: string;
  code: string;
};

type QuoteBlock = {
  kind: "quote";
  id: string;
  richText?: RichTextContent;
};

type BulletedListItemBlock = {
  kind: "bulleted_list_item";
  id: string;
  richText?: RichTextContent;
};

type NumberedListItemBlock = {
  kind: "numbered_list_item";
  id: string;
  richText?: RichTextContent;
};

type TodoBlock = {
  kind: "to_do";
  id: string;
  checked: boolean;
  richText?: RichTextContent;
};

export type ToggleBlock = {
  kind: "toggle";
  id: string;
  richText?: RichTextContent;
  expanded?: boolean;
};

/**
 * Native simple-table block (Notion `/table`, NOT the bound `data` database).
 * `rows` is a row-major grid of cell rich-text; `hasHeaderRow` /
 * `hasHeaderColumn` map to `tableHeader` vs `tableCell` nodes. The grid is
 * rectangular. Mirrors the canonical core block kind in
 * `packages/core/src/views/blocks.ts` — keep the two in sync.
 */
type TableBlock = {
  kind: "table";
  id: string;
  rows: RichTextContent[][];
  hasHeaderRow?: boolean;
  hasHeaderColumn?: boolean;
};

export type ImageBlock = {
  kind: "image";
  id: string;
  ref: FileRef | null;
  alt?: string;
  caption?: string;
};

export type FileBlock = {
  kind: "file";
  id: string;
  ref: FileRef | null;
};

type BookmarkMeta = {
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  favicon?: string;
};

type BookmarkBlock = {
  kind: "bookmark";
  id: string;
  url: string;
  meta?: BookmarkMeta;
};

/**
 * Inline video player from a URL (uploaded clip or external link). `url: ""`
 * is the freshly-inserted, awaiting-URL state. Mirrors the canonical core
 * block kind in `packages/core/src/views/blocks.ts`.
 */
export type VideoBlock = {
  kind: "video";
  id: string;
  url: string;
  caption?: string;
};

/**
 * Inline audio player from a URL. Same `url: ""` empty-state convention as
 * `VideoBlock`. Mirrors the canonical core block kind.
 */
type AudioBlock = {
  kind: "audio";
  id: string;
  url: string;
  caption?: string;
};

/**
 * A nested sub-page reference. Renders an inline clickable row in the
 * parent page that navigates to the child page (`childPageId` is the
 * child view's id). The child's title is resolved live from the loaded
 * sidebar list (or a light `getView`) — never snapshotted — so a rename
 * of the child reflects everywhere the row is shown
 * (app-web/CLAUDE.md freshness rule).
 *
 * Mirrors the canonical core block kind being added in
 * `packages/core/src/views/blocks.ts`.
 */
export type ChildPageBlock = {
  kind: "child_page";
  id: string;
  childPageId: string;
};

/**
 * Authoring-only directive carrying a blueprint section's extraction
 * instruction (what fills this section when the synthesis engine runs). Only
 * appears in blueprint templates, never a normal page. Mirrors the canonical
 * core `ExtractionSlotBlock` in `packages/core/src/views/blocks.ts`.
 */
export type ExtractionSlotBlock = {
  kind: "extraction_slot";
  id: string;
  instruction: string;
  outputType?: "prose" | "list" | "table";
  /** Contract v2 (typed fields) — all optional; absent means a markdown field
   *  keyed by the slugified preceding heading. Mirrors the core schema. */
  fieldKey?: string;
  fieldType?: "markdown" | "string" | "number" | "date" | "boolean" | "enum" | "entityRef";
  options?: string[];
  entityKind?: "company" | "contact" | "deal" | "task";
  required?: boolean;
};

export type Block =
  | TextBlock
  | HeadingBlock
  | DividerBlock
  | DataBlock
  | ChartBlock
  | DiagramBlock
  | CalloutBlock
  | CodeBlock
  | QuoteBlock
  | BulletedListItemBlock
  | NumberedListItemBlock
  | TodoBlock
  | ToggleBlock
  | TableBlock
  | ImageBlock
  | FileBlock
  | BookmarkBlock
  | VideoBlock
  | AudioBlock
  | ChildPageBlock
  | ExtractionSlotBlock;

export type Page = {
  blocks: Block[];
};

/**
 * The sidebar list shape — minimal fields returned by
 * `GET /api/workspaces/:wid/saved-views`.
 *
 * `nestParentId` / `position` drive the nested sub-page tree:
 *  - `nestParentId` — the id of the row this page nests under, or
 *    `null` for a root-level page.
 *  - `position` — the order among siblings sharing the same
 *    `nestParentId` (ascending). The server is authoritative; the
 *    sidebar builds its tree purely from these two fields
 *    (`lib/sidebar-tree.ts`).
 */
export type ViewListRow = {
  id: string;
  workspaceId: string;
  name: string;
  /**
   * Title provenance (migration 218). `'placeholder'` rows render a generic
   * draft glyph + the auto-title hint animation; `derivePageIcon` reads it.
   */
  nameOrigin: NameOrigin;
  description: string | null;
  entity: ViewEntity;
  viewType: ViewType;
  state: ViewState;
  updatedAt: string;
  nestParentId: string | null;
  position: number;
  /**
   * User-chosen page icon — a single emoji string, or `null` when the
   * page has no explicit icon (then the sidebar falls back to the
   * type-derived glyph via `derivePageIcon`). Set through
   * `setViewIcon`.
   */
  icon: string | null;
  /**
   * The teamspace this page is filed in (migration 313), or `null` for a
   * page private to its creator. Denormalized onto every row; the sidebar
   * groups its sections from this (`groupRowsByTeamspace`). See
   * docs/architecture/features/teamspaces.md.
   */
  teamspaceId: string | null;
};

/**
 * A recurring schedule (`StructuredSchedule`) — the cadence half of a
 * scheduled job. Mirrors `packages/core/src/scheduling/schedule.ts`; kept in
 * sync the same way the Block union tracks `packages/core`. The page schedule
 * badge formats each variant via i18n (`lib/schedule-cadence.ts`).
 */
export type ScheduleSpec =
  | { type: "once"; datetime: string }
  | { type: "daily"; time: string }
  | { type: "weekly"; days: string[]; time: string }
  | { type: "monthly"; dayOfMonth: number; time: string }
  | { type: "cron"; expression: string };

/**
 * One scheduled job that maintains this page (migration 229), as projected by
 * `GET /api/views/:id` for the page-header schedule badge. The owner's enabled
 * jobs that target this page; informational only — the job is managed through
 * the assistant chat, not edited from this surface.
 */
export type ScheduledJobSummary = {
  id: string;
  /** Cadence — formatted for display by `describeCadence` in `lib/schedule-cadence.ts`. */
  schedule: ScheduleSpec;
  /** Next fire time, ISO. */
  nextRunAt: string;
  /** Last fire time, ISO, or `null` if it hasn't run yet. */
  lastRunAt: string | null;
  /** Outcome of the last run (`'completed'` / `'failed'` / …), or `null`. */
  lastStatus: string | null;
  /** Short excerpt of the job instructions (≤160 chars) for the popover. */
  summary: string;
};

/**
 * Full view metadata returned by `GET /api/views/:id` and the
 * mutating endpoints (`PATCH /page`, `/save`, `/unsave`,
 * `POST /workspaces/:wid/views/draft`).
 */
export type ViewMetadata = {
  id: string;
  workspaceId: string;
  createdBy: string;
  name: string;
  /**
   * Title provenance (migration 218). The editor arms the human auto-title
   * trigger only while `'placeholder'`, and `PageTitle` shows the generic
   * draft glyph + hint animation in that state.
   */
  nameOrigin: NameOrigin;
  description: string | null;
  /**
   * Stable identity for a machine-authored page, and the ONLY link from a page
   * back to what produced it. A recording brief carries
   * `recording-synthesis:<recordingId>` — which is how the doc shell knows to
   * mount a player and make this page's `[H:MM:SS]` citations seekable. Null
   * for a hand-authored page.
   */
  anchorKey: string | null;
  /**
   * A recording MANUALLY linked to this page (migration 339). The doc shell
   * resolves the `anchorKey` recording first and falls back to this, so a
   * hand-authored page can surface an existing recording's player, transcript,
   * and action items. Null when unlinked.
   */
  linkedRecordingId: string | null;
  entity: ViewEntity;
  viewType: ViewType;
  state: ViewState;
  /** Nesting parent id (sub-page tree), or null for a root page. */
  nestParentId: string | null;
  /** Order among siblings sharing the same `nestParentId`. */
  position: number;
  /**
   * User-chosen page icon — a single emoji string, or `null` for the
   * type-derived fallback glyph (`derivePageIcon`). Set via
   * `setViewIcon`.
   */
  icon: string | null;
  /**
   * The teamspace this page is filed in (migration 313), or `null` for a
   * page private to its creator. See `ViewListRow.teamspaceId`.
   */
  teamspaceId: string | null;
  /**
   * Notion-style page-width mode (migration 220). `false` (default) —
   * the page body renders as a constrained, centered reading column;
   * `true` — it expands to the full available width. Per-page,
   * persisted on `saved_views.full_width`. Set via `setViewFullWidth`.
   */
  fullWidth: boolean;
  /**
   * Page-level clearance (migration 212): `public` | `internal` (default) |
   * `confidential`. Gates page-open at doc-sync and is shown/set by the
   * page-header clearance pill. Set via `setViewClearance`.
   */
  clearance: "public" | "internal" | "confidential";
  /**
   * The page's genesis prompt (migration 231) — the chat message that created
   * it. Shown read-only as the "first prompt" at the top of the History panel.
   * `null` when the page wasn't created from a chat turn (pre-existing rows,
   * non-chat creation paths). Present on `GET /api/views/:id`.
   */
  originPrompt: string | null;
  autoPruneAt: string | null;
  /**
   * Per-page "Sync to brain" toggle (migration 001_doc_brain_sync). When true,
   * an authored-content change on save/settle auto-ingests the page into the
   * brain. The page-header ⋯ menu reads it to reflect the switch and sets it via
   * `setViewBrainSync`. Default false.
   */
  brainSyncEnabled: boolean;
  /**
   * True while an interactively-created draft (the doc-editor blank /
   * from-template flows) still owes its deferred `created` page-event-trigger
   * (migration 283). The shell arms the commit watcher when this is set:
   * debounced typing, or a flush on navigating away, fires the event once via
   * `commitPageCreatedEvent`. Always false for committed / programmatic pages.
   */
  createdEventPending: boolean;
  page: Page | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Scheduled jobs that maintain this page (migration 229) — the owner's
   * enabled "research & update this page" schedules, soonest first. Present
   * only on `GET /api/views/:id` (the canonical page fetch); the mutating
   * endpoints omit it, so it's optional. Drives the page-header schedule
   * badge — empty / absent → no badge.
   */
  scheduledJobs?: ScheduledJobSummary[];
};

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ""}`);
  }
  return (await res.json()) as T;
}

// ── List ──────────────────────────────────────────────────────────────

/**
 * List views for the sidebar. Two calls (one per state) keep the
 * Saved + Drafts sections independently sortable / paginated and
 * mirror what Notion does — a single call per section.
 */
export async function listViews(params: {
  workspaceId: string;
  state?: ViewState | "all";
}): Promise<ViewListRow[]> {
  const qs = new URLSearchParams();
  if (params.state) qs.set("state", params.state);
  const url = `${API_URL}/api/workspaces/${params.workspaceId}/saved-views${
    qs.toString() ? `?${qs.toString()}` : ""
  }`;
  const res = await authFetch(url);
  const body = await json<{ savedViews: ViewListRow[] }>(res);
  return body.savedViews;
}

// ── Read ──────────────────────────────────────────────────────────────

export async function getView(viewId: string): Promise<ViewMetadata> {
  const res = await authFetch(`${API_URL}/api/views/${viewId}`);
  return json<ViewMetadata>(res);
}

// ── Custom page templates (migration 281) ─────────────────────────────
//
// Workspace-shared, user-authored templates. Distinct from the built-in
// `listPageTemplates()` catalog (`@use-brian/doc-model`, no args) — these are
// fetched per workspace. The gallery merges both.

export async function listCustomPageTemplates(
  workspaceId: string,
): Promise<CustomPageTemplateSummary[]> {
  const res = await authFetch(`${API_URL}/api/workspaces/${workspaceId}/page-templates`);
  const body = await json<{ templates: CustomPageTemplateSummary[] }>(res);
  return body.templates;
}

export async function getCustomPageTemplate(
  workspaceId: string,
  id: string,
): Promise<CustomPageTemplate> {
  const res = await authFetch(`${API_URL}/api/workspaces/${workspaceId}/page-templates/${id}`);
  const body = await json<{ template: CustomPageTemplate }>(res);
  return body.template;
}

export async function createCustomPageTemplate(
  workspaceId: string,
  input: CustomTemplateCreateInput,
): Promise<CustomPageTemplate> {
  const res = await authFetch(`${API_URL}/api/workspaces/${workspaceId}/page-templates`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await json<{ template: CustomPageTemplate }>(res);
  return body.template;
}

/** Partial patch. An `extraction`-only patch regenerates the authoring
 *  skeleton server-side (structural-synthesis.md -> "The blueprint detail
 *  editor"); send `blocks` too only on a WYSIWYG re-save. */
export type CustomTemplateUpdateInput = {
  name?: string;
  description?: string | null;
  icon?: string | null;
  category?: CustomPageTemplate["category"];
  blocks?: Block[];
  extraction?: ExtractionSpec | null;
};

export async function updateCustomPageTemplate(
  workspaceId: string,
  id: string,
  patch: CustomTemplateUpdateInput,
): Promise<CustomPageTemplate> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${workspaceId}/page-templates/${id}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  const body = await json<{ template: CustomPageTemplate }>(res);
  return body.template;
}

export async function deleteCustomPageTemplate(
  workspaceId: string,
  id: string,
): Promise<void> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${workspaceId}/page-templates/${id}`,
    { method: "DELETE" },
  );
  await json<{ ok: true }>(res);
}

// ── Blueprint records (migration 307) ─────────────────────────────────
//
// The typed output rows a blueprint's fills/saves produce (the record is the
// durable output; a page is its on-demand projection). Listed under each
// blueprint in Brain -> Blueprints; "open as page" renders the projection for
// a pageless record. See structural-synthesis.md -> "The record".

export type BlueprintRecordSummary = {
  id: string;
  subject: string;
  status: "complete" | "incomplete";
  missing: string[];
  fields: Record<string, unknown>;
  specSnapshot: Array<{ key: string; heading: string; type: string; required?: boolean }>;
  sourceKind: "recording" | "brain" | "research" | "chat" | "workflow";
  pageId: string | null;
  updatedAt: string;
};

export async function listBlueprintRecords(
  workspaceId: string,
  blueprintId: string,
): Promise<BlueprintRecordSummary[]> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${workspaceId}/blueprints/${blueprintId}/records`,
  );
  const body = await json<{ records: BlueprintRecordSummary[] }>(res);
  return body.records;
}

/** Render (or re-render) the record's page projection; returns the page id. */
export async function openBlueprintRecordPage(
  workspaceId: string,
  recordId: string,
): Promise<{ pageId: string }> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${workspaceId}/blueprint-records/${recordId}/page`,
    { method: "POST" },
  );
  return json(res);
}

// ── Generate from brain (structural-synthesis: fill a blueprint from memory) ──

/** Cheap pre-flight: section-count → credit quote for the confirm dialog. */
export async function estimateBlueprintGenerate(
  workspaceId: string,
  blueprintId: string,
): Promise<{ blueprintId: string; name: string; sectionCount: number; surchargeCredits: number }> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${workspaceId}/blueprints/${blueprintId}/estimate`,
    { method: "POST" },
  );
  return json(res);
}

/** Run the fill from the brain; charges the surcharge on success. `requestId`
 *  is a client-minted idempotency key so a retry never double-charges. */
export async function generateBlueprintFromBrain(
  workspaceId: string,
  blueprintId: string,
  input: { subject: string; requestId: string; sensitivity?: string },
): Promise<{ pageId: string | null; chargedCredits: number }> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${workspaceId}/blueprints/${blueprintId}/generate`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  return json(res);
}

// ── Page sharing (migration 249) ──────────────────────────────────────

export type PageGrant = {
  id: string;
  pageId: string;
  principalType: string;
  role: string;
  label: string | null;
  indexable: boolean;
  createdBy: string;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export async function listGrants(viewId: string): Promise<PageGrant[]> {
  const res = await authFetch(`${API_URL}/api/views/${viewId}/grants`);
  const body = await json<{ grants: PageGrant[] }>(res);
  return body.grants;
}

export async function revokeGrant(viewId: string, grantId: string): Promise<void> {
  const res = await authFetch(`${API_URL}/api/views/${viewId}/grants/${grantId}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// ── Phase 3: member/group grants ──────────────────────────────────────

export type GrantRole = "view" | "comment" | "edit" | "full";
export type IdentityGrant = PageGrant & { principalRef: string | null; principalLabel: string | null };
export type ShareMember = { userId: string; name: string | null; email: string | null; avatarUrl: string | null };
export type WorkspaceGroup = { id: string; workspaceId: string; name: string; memberCount: number; createdAt: string };

export type PublishState = { published: boolean; indexable: boolean };

/** Link grants (Anyone with link), identity grants (people/groups/general), and publish state. */
export async function listShareGrants(
  viewId: string,
): Promise<{ grants: PageGrant[]; identityGrants: IdentityGrant[]; publish: PublishState }> {
  const res = await authFetch(`${API_URL}/api/views/${viewId}/grants`);
  return json<{ grants: PageGrant[]; identityGrants: IdentityGrant[]; publish: PublishState }>(res);
}

/** Publish the page to one universal web URL (`/share/p/<viewId>`). Idempotent. */
export async function publishPage(viewId: string, indexable: boolean): Promise<PublishState> {
  const res = await authFetch(`${API_URL}/api/views/${viewId}/publish`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ indexable }),
  });
  return json<PublishState>(res);
}

/** Unpublish: revoke the page's universal web URL. */
export async function unpublishPage(viewId: string): Promise<void> {
  const res = await authFetch(`${API_URL}/api/views/${viewId}/unpublish`, { method: "POST" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// ── Custom domains + page slugs (migration 324) ───────────────────────
// docs/architecture/features/custom-domains.md

export type PageDomain = {
  id: string;
  workspaceId: string;
  pageId: string;
  hostname: string;
  status: "pending_dns" | "live" | "error";
  provider: "manual" | "vercel";
  verificationError: string | null;
  lastCheckedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type DnsInstruction = { type: "CNAME" | "A" | "TXT"; name: string; value: string };

/** This page's position under a domain-fronted root (the slug editor context). */
export type PageSiteContext = {
  domainId: string;
  hostname: string;
  status: PageDomain["status"];
  rootPageId: string;
  isRoot: boolean;
  slug: string | null;
  suggestedSlug: string | null;
};

export type SiteState = { domains: PageDomain[]; sites: PageSiteContext[] };

/** Publish-tab site state: domains attached to this page + slug context. */
export async function getSiteState(viewId: string): Promise<SiteState> {
  const res = await authFetch(`${API_URL}/api/views/${viewId}/site`);
  return json<SiteState>(res);
}

/** Attach a custom hostname to this published page. Throws the server's
 *  error `code` (not_published / hostname_taken / invalid_hostname /
 *  domain_limit) so the dialog can map it to copy. */
export async function addPageDomain(
  viewId: string,
  hostname: string,
): Promise<{ domain: PageDomain; instructions: DnsInstruction[] }> {
  const res = await authFetch(`${API_URL}/api/views/${viewId}/domains`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hostname }),
  });
  if (!res.ok) throw new Error(await errorCode(res));
  return json(res);
}

export async function checkPageDomain(
  viewId: string,
  domainId: string,
): Promise<{ domain: PageDomain; live: boolean; instructions: DnsInstruction[] }> {
  const res = await authFetch(`${API_URL}/api/views/${viewId}/domains/${domainId}/check`, {
    method: "POST",
  });
  return json(res);
}

export async function removePageDomain(viewId: string, domainId: string): Promise<void> {
  const res = await authFetch(`${API_URL}/api/views/${viewId}/domains/${domainId}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/** Set/replace this page's slug on a domain (old slug 301s to the new one). */
export async function setPageSlug(
  viewId: string,
  domainId: string,
  slug: string,
): Promise<{ slug: string; previousSlug: string | null }> {
  const res = await authFetch(`${API_URL}/api/views/${viewId}/slug`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ domainId, slug }),
  });
  if (!res.ok) throw new Error(await errorCode(res));
  return json(res);
}

export async function checkSlugAvailability(
  viewId: string,
  domainId: string,
  slug: string,
): Promise<{ valid: boolean; available: boolean; current: boolean }> {
  const res = await authFetch(
    `${API_URL}/api/views/${viewId}/slug-availability?domainId=${encodeURIComponent(domainId)}&slug=${encodeURIComponent(slug)}`,
  );
  return json(res);
}

/** The server's short error `code` when present, else `HTTP <status>`. */
async function errorCode(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { code?: string };
    if (body.code) return body.code;
  } catch {
    // fall through
  }
  return `HTTP ${res.status}`;
}

/** Invite a member/group, or set the workspace-default ("General access") role. */
export async function upsertIdentityGrant(
  viewId: string,
  input: { principalType: "user" | "group" | "workspace"; principalRef: string; role: GrantRole },
): Promise<void> {
  const res = await authFetch(`${API_URL}/api/views/${viewId}/grants`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function updateGrantRole(viewId: string, grantId: string, role: GrantRole): Promise<void> {
  const res = await authFetch(`${API_URL}/api/views/${viewId}/grants/${grantId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function listShareableMembers(viewId: string): Promise<ShareMember[]> {
  const res = await authFetch(`${API_URL}/api/views/${viewId}/shareable-members`);
  const body = await json<{ members: ShareMember[] }>(res);
  return body.members;
}

export async function listWorkspaceGroups(viewId: string): Promise<WorkspaceGroup[]> {
  const res = await authFetch(`${API_URL}/api/views/${viewId}/groups`);
  const body = await json<{ groups: WorkspaceGroup[] }>(res);
  return body.groups;
}

// ── Write ─────────────────────────────────────────────────────────────


export async function saveView(viewId: string): Promise<ViewMetadata> {
  const res = await authFetch(`${API_URL}/api/views/${viewId}/save`, {
    method: "PATCH",
  });
  return json<ViewMetadata>(res);
}

export async function unsaveView(viewId: string): Promise<ViewMetadata> {
  const res = await authFetch(`${API_URL}/api/views/${viewId}/unsave`, {
    method: "PATCH",
  });
  return json<ViewMetadata>(res);
}

/**
 * Rename a page. Maps to `PATCH /saved-views/:id` (the metadata-update
 * route accepts `{ name }`). Returns the updated metadata.
 */
export async function renameView(
  viewId: string,
  name: string,
): Promise<ViewMetadata> {
  const res = await authFetch(`${API_URL}/api/saved-views/${viewId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return json<ViewMetadata>(res);
}

/**
 * Set (or clear) a page's icon. Maps to `PATCH /saved-views/:id` with
 * `{ icon }` — pass a single emoji string to set it, or `null` to clear
 * it back to the type-derived glyph. Returns the updated metadata.
 */
export async function setViewIcon(
  viewId: string,
  icon: string | null,
): Promise<ViewMetadata> {
  const res = await authFetch(`${API_URL}/api/saved-views/${viewId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ icon }),
  });
  return json<ViewMetadata>(res);
}

/**
 * Toggle a page's Notion-style "Full width" mode. Maps to `PATCH
 * /saved-views/:id` with `{ fullWidth }` — mirrors `setViewIcon`. `false`
 * is the constrained centered reading column (default); `true` expands the
 * body to the full pane width. Returns the updated metadata.
 */
export async function setViewFullWidth(
  viewId: string,
  fullWidth: boolean,
): Promise<ViewMetadata> {
  const res = await authFetch(`${API_URL}/api/saved-views/${viewId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fullWidth }),
  });
  return json<ViewMetadata>(res);
}

/**
 * Link an existing recording to this page, or pass `null` to unlink (migration
 * 339). Maps to `PATCH /saved-views/:id` with `{ linkedRecordingId }`. The
 * server rejects a recording outside the page's workspace (or one the caller
 * cannot see). Returns the updated metadata, so the caller reads back the
 * committed link rather than assuming its optimistic value stuck.
 */
export async function setPageLinkedRecording(
  viewId: string,
  recordingId: string | null,
): Promise<ViewMetadata> {
  const res = await authFetch(`${API_URL}/api/saved-views/${viewId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ linkedRecordingId: recordingId }),
  });
  return json<ViewMetadata>(res);
}

/**
 * Toggle a page's "Sync to brain" mode (migration 001_doc_brain_sync). Maps to
 * `PATCH /saved-views/:id` with `{ brainSyncEnabled }` - mirrors
 * `setViewFullWidth`. When enabled, an authored-content change on save
 * auto-ingests the page into the brain. Returns the updated metadata.
 */
export async function setViewBrainSync(
  viewId: string,
  brainSyncEnabled: boolean,
): Promise<ViewMetadata> {
  const res = await authFetch(`${API_URL}/api/saved-views/${viewId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ brainSyncEnabled }),
  });
  return json<ViewMetadata>(res);
}

/**
 * Manually trigger a page's "Sync to brain" ingestion now. Maps to
 * `POST /api/saved-views/:id/ingest`; the server queues the distillation in the
 * background and returns 202. Resolves once queued.
 */
export async function ingestViewToBrain(viewId: string): Promise<void> {
  const res = await authFetch(`${API_URL}/api/saved-views/${viewId}/ingest`, {
    method: "POST",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ""}`);
  }
}

/**
 * Set a page's clearance (migration 212). Maps to `PATCH /saved-views/:id`
 * with `{ clearance }` — mirrors `setViewFullWidth`. The server rejects (403)
 * a value above the caller's own workspace clearance. Returns updated metadata.
 */
export async function setViewClearance(
  viewId: string,
  clearance: "public" | "internal" | "confidential",
): Promise<ViewMetadata> {
  const res = await authFetch(`${API_URL}/api/saved-views/${viewId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clearance }),
  });
  return json<ViewMetadata>(res);
}

/**
 * Result of the human auto-title trigger (migration 218). `applied` is
 * `false` when the server's authoritative re-check declined (the title was
 * no longer on its placeholder, or the body too short) — a safe no-op.
 */
export type AutoTitleResult = {
  title: string | null;
  /**
   * The emoji the generator suggested + the commit applied (null when the
   * model emitted none, or the user already had an icon). The editor swaps
   * the page icon to this alongside the title.
   */
  icon: string | null;
  applied: boolean;
};

/**
 * Ask the server to generate a page title from its body — the human-edit
 * trigger behind `useAutoTitle`. Maps to `POST /saved-views/:id/auto-title`;
 * the server re-checks the placeholder guard + size floor authoritatively, so
 * a stale or duplicate call returns `{ applied: false }`.
 */
export async function requestAutoTitle(viewId: string): Promise<AutoTitleResult> {
  const res = await authFetch(
    `${API_URL}/api/saved-views/${viewId}/auto-title`,
    { method: "POST" },
  );
  return json<AutoTitleResult>(res);
}

export async function deleteView(viewId: string): Promise<void> {
  // The legacy `/api/saved-views/:id` DELETE route is the canonical
  // hard-delete endpoint; the page-model route surface doesn't add a
  // separate one (per the plan doc — DELETE wraps the shared store).
  const res = await authFetch(`${API_URL}/api/saved-views/${viewId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ""}`);
  }
}

export async function createDraft(params: {
  workspaceId: string;
  name?: string;
  binding?: BindingConfig;
  /**
   * When set, the new draft is created nested under this page id (a
   * Notion-style sub-page). The server links a `child_page` block on
   * the parent and seeds the draft's `nestParentId`. Omit for a
   * root-level draft.
   */
  nestParentId?: string | null;
  /**
   * The teamspace to create in (migration 313). A teamspace id files the
   * page in that section; explicit `null` creates it PRIVATE to the
   * caller; omitted (`undefined`) lets the server default apply (the
   * General teamspace). Meaningless alongside `nestParentId` — a child
   * adopts its parent's teamspace server-side.
   */
  teamspaceId?: string | null;
  /**
   * Optional block seed (migration 281) — "Start from a template" creates the
   * draft pre-filled with a template's blocks. Omit for an empty page.
   */
  blocks?: Block[];
}): Promise<ViewMetadata> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${params.workspaceId}/views/draft`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(params.name ? { name: params.name } : {}),
        ...(params.binding ? { binding: params.binding } : {}),
        ...(params.nestParentId ? { nestParentId: params.nestParentId } : {}),
        // `null` is a meaningful value (private) — spread on `!== undefined`,
        // not truthiness, so it reaches the wire.
        ...(params.teamspaceId !== undefined
          ? { teamspaceId: params.teamspaceId }
          : {}),
        ...(params.blocks ? { blocks: params.blocks } : {}),
      }),
    },
  );
  return json<ViewMetadata>(res);
}

/**
 * Fire the deferred `created` page-event for an interactively-created draft
 * (migration 283). Safe to call more than once — the server flips the pending
 * flag atomically, so the typing-debounce call and the navigate-away flush
 * together fire the workflow exactly once. Returns whether THIS call won the
 * flip (`committed`). Best-effort at the call sites: a failure must never block
 * a page edit or navigation.
 */
export async function commitPageCreatedEvent(
  viewId: string,
): Promise<{ committed: boolean }> {
  const res = await authFetch(`${API_URL}/api/views/${viewId}/commit-created`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  return json<{ committed: boolean }>(res);
}

// ── Reparent / reorder ────────────────────────────────────────────────

/**
 * Move a page in the nested sidebar tree: set its parent and its
 * position among the new parent's children. `nestParentId: null`
 * promotes the page to a root-level entry. The server re-packs sibling
 * positions, so callers should refetch the sidebar list afterwards
 * rather than trusting a local position guess.
 *
 * `teamspaceId` (migration 313) is meaningful when `nestParentId` is
 * null — a root drop into a sidebar section: a teamspace id files the
 * page (and its whole subtree, server-side) into that teamspace, `null`
 * files it Private. Omitted = keep the current teamspace. When
 * `nestParentId` is a page, the child adopts the parent's teamspace
 * server-side regardless.
 *
 * Maps to `PATCH /api/views/:id/reparent` with body
 * `{ nestParentId, position, teamspaceId? }` → returns the updated
 * `ViewMetadata`.
 */
export async function reparentView(
  viewId: string,
  body: {
    nestParentId: string | null;
    position: number;
    teamspaceId?: string | null;
  },
): Promise<ViewMetadata> {
  const res = await authFetch(`${API_URL}/api/views/${viewId}/reparent`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return json<ViewMetadata>(res);
}

// ── Workspace assistants on the doc surface ───────────────────────
//
// The doc surface no longer needs a dedicated assistant. Doc-editing
// is a context-injected skill: any workspace assistant can author and edit
// pages when it runs on this surface (the backend injects the page tools off
// `appOrigin: "doc"`). The default interlocutor is the workspace primary;
// the chat dock offers a switcher to any other accessible assistant. This
// summary just powers that switcher + picks the default.

export type WorkspaceAssistantSummary = {
  id: string;
  name: string;
  // The assistant's configured creature seed (`GET /api/assistants` returns it
  // as `iconSeed: r.iconSeed ?? 0`). Carried through so the chat header,
  // switcher, and per-message avatars render the SAME icon the launcher does,
  // instead of falling back to `AssistantAvatar`'s id-hash creature.
  iconSeed: number | null;
  kind: "primary" | "standard" | "app";
  appType: "distribution" | null;
};

/**
 * Resolve a `BindingConfig` to a live A2UI ViewPayload without persisting
 * anything — used by the collaborative editor's data/chart node-views so each
 * embed resolves its own binding fresh on mount (never snapshotted into the
 * Y.Doc). Backed by the no-persistence `POST /api/workspaces/:id/views/render`.
 */
export async function renderBinding(
  workspaceId: string,
  binding: BindingConfig,
): Promise<ViewPayload> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${workspaceId}/views/render`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The route parses `req.body` directly as the BindingConfig — send it
      // UNWRAPPED, not `{ binding }` (a wrapper fails the schema → the embed
      // shows "Failed to load this data block").
      body: JSON.stringify(binding),
    },
  );
  if (!res.ok) throw new Error(`renderBinding failed: ${res.status}`);
  return (await res.json()) as ViewPayload;
}

export async function listWorkspaceAssistants(
  workspaceId: string,
): Promise<WorkspaceAssistantSummary[]> {
  // The assistants list lives at top-level `/api/assistants?workspaceId=`
  // — there's no `/api/workspaces/:id/assistants` GET. The workspace
  // POST under /api/workspaces is for kind='standard' assistants only;
  // app-kind assistants (distribution) flow through /api/assistants POST.
  const res = await authFetch(
    `${API_URL}/api/assistants?workspaceId=${encodeURIComponent(workspaceId)}`,
    { method: "GET", headers: { "content-type": "application/json" } },
  );
  if (!res.ok) {
    throw new Error(`Failed to list workspace assistants: ${res.status}`);
  }
  const data = (await res.json()) as { assistants?: WorkspaceAssistantSummary[] };
  return data.assistants ?? [];
}

/** The assistant's display identity — its name + the deterministic avatar seed
 *  `AssistantAvatar` renders (the doc assistant's creature icon). */
export type AssistantIdentity = { id: string; name: string; iconSeed: number | null };

/** Fetch one assistant's display identity (`GET /api/assistants/:id`). Returns
 *  `null` on any error so callers degrade to a generic label rather than throw
 *  into the comment thread. */
export async function getAssistantIdentity(
  assistantId: string,
): Promise<AssistantIdentity | null> {
  try {
    const res = await authFetch(
      `${API_URL}/api/assistants/${encodeURIComponent(assistantId)}`,
      { method: "GET", headers: { "content-type": "application/json" } },
    );
    if (!res.ok) return null;
    const a = (await res.json()) as { id: string; name: string; iconSeed: number | null };
    return { id: a.id, name: a.name, iconSeed: a.iconSeed ?? null };
  } catch {
    return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Mint a stable id for a new block. `crypto.randomUUID()` ships in
 * every modern browser + Node — the SSR/legacy fallback exists for
 * safety only. The block-id Zod bound is 1..128 chars; UUIDs are 36.
 */
export function newBlockId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `b_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/**
 * Auto-derive a page's icon from its type — the fallback glyph shown when a
 * page has no user-chosen emoji.
 *
 * A doc page is a blank document, not a typed entity table, so both a
 * fresh, untouched draft (`nameOrigin === 'placeholder'`) and a page the
 * user has hand-renamed (`nameOrigin === 'user'`) keep the generic
 * `FileText` glyph regardless of the row's default `tasks` binding — typing
 * a title doesn't turn a document into a task checklist, so the draft's one
 * icon **persists through a manual rename**. The only things that move a
 * page off the document glyph are an explicit emoji (handled by callers
 * before this fallback) and auto-title, which suggests an emoji *and* flips
 * `nameOrigin` to `'auto'` on its first run. So the entity-glyph branch
 * below only applies to a settled `'auto'` page the model gave no emoji, or
 * a genuinely-typed view a caller resolves without a page `nameOrigin`
 * (e.g. a `child_page` link).
 *
 * Pure: returns a `LucideIcon` component the caller renders with size/colour
 * props.
 */
export function derivePageIcon(params: {
  entity: ViewEntity;
  viewType: ViewType;
  nameOrigin?: NameOrigin;
}): LucideIcon {
  // A draft, or a page the user hand-titled, is a generic document — never
  // the entity's task checkbox. Only an emoji (set by the user or suggested
  // by auto-title) changes it.
  if (params.nameOrigin === "placeholder" || params.nameOrigin === "user") {
    return FileText;
  }
  switch (params.entity) {
    case "tasks":
      return CheckSquare;
    case "contacts":
      return Users;
    case "companies":
      return Building2;
    case "deals":
      return Briefcase;
    case "workflow_runs":
      return Workflow;
    default:
      // No entity match — distinguish a board layout from a plain doc.
      return params.viewType === "board" ? LayoutGrid : FileText;
  }
}

/**
 * Compute the auto-prune horizon as a human-friendly "N days" diff.
 * Returns negative on already-expired drafts (sidebar will style them
 * differently or filter them out). Returns `null` on saved rows
 * (no prune date).
 */
export function daysUntilPrune(autoPruneAtIso: string | null): number | null {
  if (!autoPruneAtIso) return null;
  const target = new Date(autoPruneAtIso).getTime();
  if (Number.isNaN(target)) return null;
  const now = Date.now();
  return Math.round((target - now) / (24 * 60 * 60 * 1000));
}

// ── Format conversion (doc-format-conversion feature) ────────────────
//
// Wrappers over the export/import HTTP routes in
// `packages/api/src/routes/views.ts`. The converters themselves are the pure
// hub in `@use-brian/core`; these are I/O glue. Downloads go through
// `authFetch` (blob), NOT a plain `<a href>`: auth is a bearer token read from
// JS, so a plain link/`window.open` can't carry it (it would 401).
// Spec: docs/architecture/features/doc-conversion.md.

export type ImportTarget = "page" | "brain" | "both";
export type ImportResult = {
  pageId: string | null;
  brainIngested: boolean;
  blockCount: number;
};

/** Export endpoint URL for a page + format. Pure — unit-tested. */
export function exportUrl(pageId: string, format: "md" | "docx"): string {
  return `${API_URL}/api/views/${encodeURIComponent(pageId)}/export?format=${format}`;
}

/** Download filename from a page title + format (path-hostile chars stripped).
 *  Pure — unit-tested. */
export function exportFilename(title: string, format: "md" | "docx"): string {
  const base =
    (title || "document").replace(/[\\/?%*:|"<>]/g, "").trim().slice(0, 100) ||
    "document";
  return `${base}.${format}`;
}

/** Fetch a page's Markdown text — backs "Copy as Markdown". */
export async function fetchPageMarkdown(pageId: string): Promise<string> {
  const res = await authFetch(exportUrl(pageId, "md"));
  if (!res.ok) throw new Error(`Export failed (${res.status})`);
  return res.text();
}

/** Download a page as a `.md` / `.docx` file (the Export menu). */
export async function downloadPageExport(
  pageId: string,
  format: "md" | "docx",
  title: string,
): Promise<void> {
  const res = await authFetch(exportUrl(pageId, format));
  if (!res.ok) throw new Error(`Export failed (${res.status})`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = exportFilename(title, format);
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Import a `.docx`/`.md` file into the workspace (journey A). Multipart POST;
 *  `target` chooses page / brain / both. Returns the new page id (if any). */
export async function importDocument(
  workspaceId: string,
  file: File,
  target: ImportTarget = "page",
): Promise<ImportResult> {
  const body = new FormData();
  body.set("file", file);
  body.set("target", target);
  const res = await authFetch(
    `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/views/import`,
    { method: "POST", body },
  );
  if (!res.ok) {
    let message = `Import failed (${res.status})`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j?.error) message = j.error;
    } catch {
      // non-JSON error body — keep the status message
    }
    throw new Error(message);
  }
  return res.json() as Promise<ImportResult>;
}
