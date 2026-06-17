"use client";

/**
 * React node-view for the opaque `embed` atom — dispatches on the parsed
 * `block.kind`. data/chart resolve their own binding live via `renderBinding`
 * (never snapshotted into the Y.Doc) and render through the shared
 * `<BlockData>` interaction surface; the other embed kinds render a compact
 * reference card.
 *
 * The interactive table/board (inline cell edit, add/delete row, the row
 * drawer, board card DnD) is owned by `<BlockData>` — the SAME component the
 * legacy page renderer used — so the collaborative editor inherits the full
 * data-block interaction surface instead of a partial reimplementation. This
 * embed only adds the view-config chrome (search / filter / sort / group /
 * properties) above a table and re-resolves the binding after a server
 * mutation (`onDataMutated`). For pointer events to actually reach the widget,
 * the node-view is registered with `stopEvent: () => true` (see
 * `doc-schema.ts`) — otherwise ProseMirror captures clicks as an atom
 * NodeSelection and the whole thing is read-only.
 *
 * [COMP:app-web/data-embed]
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { Code2, Database, Film, Music, Share2 } from "lucide-react";
import type {
  A2UIWidget,
  TableWidget,
  ViewPayload,
} from "@sidanclaw/views-renderer";
import {
  renderBinding,
  type Block,
  type BindingConfig,
  type DataBlock,
  type ChartBlock,
  type DiagramBlock,
  type ChildPageBlock,
  type ImageBlock,
  type FileBlock,
} from "@/lib/api/views";
import { useT, format } from "@/lib/i18n/client";
import { useWorkspaceContext } from "@/lib/workspace-context";
import { BlockData } from "../block-data";
import { chartBlockToWidget, diagramBlockToWidget } from "../block-visual";
import { BlockChildPage } from "../block-child-page";
import { BlockImage } from "../block-image";
import { BlockFile } from "../block-file";
import { BlockBookmark, type BookmarkBlock } from "../block-bookmark";
import { ZoomableVisual } from "../visual-lightbox";
import { ViewToolbar, type ViewToolbarValue } from "../view-config/view-toolbar";
import { applyViewConfig } from "../view-config/apply-view-config";
import {
  displayToToolbarValue,
  reduceColumnOp,
  toolbarValueToDisplay,
} from "../view-config/view-display";
import {
  addProperty,
  getEntityType,
  removeProperty,
  updateEntityTypeProperties,
  uniquePropertyName,
  type EntityType,
} from "@/lib/api/doc-entities";
import { promptDialog } from "@/components/ui/prompt-dialog";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  kindPickerDialog,
  PICKABLE_KINDS,
  type PickableKind,
} from "@/components/ui/kind-picker-dialog";
import { ErrorBoundary } from "../error-states";
import { isDesktopAuth } from "@/lib/desktop-auth-source";
import { idbGet, idbSet } from "@/lib/offline/idb";
import { resolveDataBlockRender } from "@/lib/offline/data-block-policy";

/** Renderer `column-*` actions that mutate the SCHEMA (custom tables only),
 *  vs the display-only ops folded by `reduceColumnOp`. */
const SCHEMA_EDIT_OPS = new Set([
  "column-rename",
  "column-delete",
  "column-insert",
  "column-duplicate",
  "column-retype",
]);
const PICKABLE_SET = new Set<string>(PICKABLE_KINDS.map((k) => k.kind));

function isTableRoot(widget: A2UIWidget | undefined | null): widget is TableWidget {
  return !!widget && widget.type === "table";
}

function DataEmbed({
  block,
  binding,
  updateBlock,
}: {
  block: DataBlock;
  binding: BindingConfig;
  updateBlock: (next: Block) => void;
}) {
  const t = useT().docPage;
  const ws = useWorkspaceContext();
  const [payload, setPayload] = useState<ViewPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  // View-config state (search / filter / sort / group / properties / widths /
  // freeze). Seeded from the block's persisted `binding.display` the first time
  // a table payload lands; `null` until then so an unbound / non-table embed
  // shows no toolbar.
  const [viewConfig, setViewConfig] = useState<ViewToolbarValue | null>(null);
  // Bumped to re-resolve the binding after a server mutation (row add/delete,
  // failed move) — data blocks are never snapshotted, so the fresh payload is
  // the source of truth (app-web/CLAUDE.md freshness rule).
  const [reloadCount, setReloadCount] = useState(0);
  // Custom (user-defined) table state: the entity type drives the title +
  // backs the column schema-edit dialogs (rename / delete / insert / retype).
  const isCustom = binding.entity === "custom";
  const [entityType, setEntityType] = useState<EntityType | null>(null);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  useEffect(() => {
    if (!isCustom || !binding.entityTypeId) {
      setEntityType(null);
      return;
    }
    let cancelled = false;
    // Bundled-desktop offline cache (gated): entity-type schemas are near-immutable,
    // so cache on success and serve the cached schema on a failed (offline) fetch
    // — without it a custom data block can't render its columns offline even with a
    // cached payload. Web/thin never cache.
    const cacheKey = `entitytype:${ws.workspaceId}:${binding.entityTypeId}`;
    getEntityType(ws.workspaceId, binding.entityTypeId)
      .then((et) => {
        if (cancelled) return;
        setEntityType(et);
        if (isDesktopAuth()) void idbSet(cacheKey, et);
      })
      .catch(async () => {
        if (cancelled) return;
        if (isDesktopAuth()) {
          const cached = await idbGet<EntityType>(cacheKey);
          if (cancelled) return;
          if (cached) {
            setEntityType(cached);
            return;
          }
        }
        setEntityType(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isCustom, binding.entityTypeId, ws.workspaceId]);

  // Re-resolve only when the DATA-relevant binding fields change. The
  // presentational `display` (widths / sort / hidden / order / freeze) is
  // applied client-side via `applyViewConfig` and must NOT trigger a server
  // refetch — otherwise every column resize would re-fetch and flicker the
  // table. `display` rides on `binding` but is excluded from this key.
  const dataKey = useMemo(
    () =>
      JSON.stringify({
        entity: binding.entity,
        viewType: binding.viewType,
        filters: binding.filters ?? null,
        columns: binding.columns ?? null,
        groupBy: binding.groupBy ?? null,
      }),
    [binding.entity, binding.viewType, binding.filters, binding.columns, binding.groupBy],
  );

  useEffect(() => {
    let cancelled = false;
    setError(null);
    // Bundled-desktop offline cache (gated): cache each resolved payload, and on
    // a failed re-resolve serve the last snapshot (within the staleness ceiling)
    // instead of erroring. The app-level Offline pill signals that data is stale.
    // Web + thin shell never cache (the "live, not snapshot" contract holds).
    const cacheKey = `datablock:${ws.workspaceId}:${dataKey}`;
    renderBinding(ws.workspaceId, binding)
      .then((p) => {
        if (cancelled) return;
        setPayload(p);
        if (isDesktopAuth()) void idbSet(cacheKey, { payload: p, cachedAt: Date.now() });
      })
      .catch(async (e) => {
        if (cancelled) return;
        if (isDesktopAuth()) {
          const cached = await idbGet<{ payload: ViewPayload; cachedAt: number }>(cacheKey);
          if (cancelled) return;
          if (
            cached &&
            resolveDataBlockRender({
              isOnline: false,
              cache: { cachedAt: cached.cachedAt },
              nowMs: Date.now(),
            }).mode === "stale"
          ) {
            setPayload(cached.payload);
            return;
          }
        }
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
    // Keyed on `dataKey` (not `binding`) so display edits don't refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.workspaceId, dataKey, reloadCount]);

  // Seed the toolbar value from the block's persisted display once we know the
  // table's columns. Re-seeds only when the column SET changes (a binding
  // swap); persisting display never changes the column set, so a user's own
  // writes don't re-seed over their edits.
  const tableRoot = isTableRoot(payload?.root) ? payload?.root : null;
  const columnKey = tableRoot ? tableRoot.columns.map((c) => c.field).join("|") : "";
  useEffect(() => {
    if (tableRoot) setViewConfig(displayToToolbarValue(binding.display, tableRoot.columns));
    else setViewConfig(null);
    // Re-seed on column-set identity, not row data or display writes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnKey]);

  const refetch = () => setReloadCount((n) => n + 1);

  // Persist a toolbar value's durable bits to the data block's `binding.display`
  // (through Yjs → `updateBlock`). Skips the write when the projected display
  // is unchanged (a search keystroke, a no-op) so the doc isn't churned.
  const persistDisplay = useCallback(
    (next: ViewToolbarValue) => {
      if (!tableRoot) return;
      const nextDisplay = toolbarValueToDisplay(next, tableRoot.columns);
      if (JSON.stringify(nextDisplay) === JSON.stringify(binding.display ?? {})) return;
      updateBlock({ ...block, binding: { ...binding, display: nextDisplay } });
    },
    [tableRoot, block, binding, updateBlock],
  );

  // Toolbar change (search / filter / sort / group / properties). Search is
  // ephemeral; `persistDisplay` no-ops when only it changed.
  const handleToolbarChange = useCallback(
    (next: ViewToolbarValue) => {
      setViewConfig(next);
      persistDisplay(next);
    },
    [persistDisplay],
  );

  // Schema edits (custom tables only) — rename / delete / insert / duplicate /
  // retype a property via the entity REST API, then re-resolve the binding so
  // the new columns render. "Rename" changes the display LABEL (no key / data
  // migration); "retype" swaps the kind in place (cells lazily adopt it). A new
  // column appends at the end — drag it into place (the order persists).
  const handleSchemaEdit = useCallback(
    async (actionId: string, params: Record<string, unknown>) => {
      const etid = binding.entityTypeId;
      if (!etid || !entityType) return;
      const field = typeof params.field === "string" ? params.field : null;
      const names = entityType.properties.map((p) => p.name);
      const e = t.tableEdit;
      try {
        if (actionId === "column-rename" && field) {
          const prop = entityType.properties.find((p) => p.name === field);
          const label = await promptDialog({
            title: e.renameTitle,
            defaultValue: prop?.label ?? field,
            placeholder: e.renamePlaceholder,
          });
          if (!label) return;
          setEntityType(
            await updateEntityTypeProperties(
              ws.workspaceId,
              etid,
              entityType.properties.map((p) => (p.name === field ? { ...p, label } : p)),
            ),
          );
          refetch();
        } else if (actionId === "column-delete" && field) {
          const ok = await confirmDialog({
            title: e.deleteConfirmTitle,
            description: e.deleteConfirmBody,
            confirmLabel: e.deleteConfirmAction,
            cancelLabel: t.cancel,
            variant: "destructive",
          });
          if (!ok) return;
          setEntityType(await removeProperty(ws.workspaceId, etid, field));
          refetch();
        } else if (actionId === "column-insert") {
          const label = await promptDialog({
            title: e.newColumnTitle,
            placeholder: e.newColumnPlaceholder,
          });
          if (!label) return;
          setEntityType(
            await addProperty(ws.workspaceId, etid, {
              name: uniquePropertyName(label, names),
              label,
              config: { kind: "text" },
            }),
          );
          refetch();
        } else if (actionId === "column-duplicate" && field) {
          const prop = entityType.properties.find((p) => p.name === field);
          if (!prop) return;
          const label = `${prop.label ?? prop.name} copy`;
          setEntityType(
            await addProperty(ws.workspaceId, etid, {
              name: uniquePropertyName(label, names),
              label,
              config: prop.config,
            }),
          );
          refetch();
        } else if (actionId === "column-retype" && field) {
          const prop = entityType.properties.find((p) => p.name === field);
          const current = prop?.config.kind;
          const kind = await kindPickerDialog({
            current: PICKABLE_SET.has(current ?? "") ? (current as PickableKind) : undefined,
          });
          if (!kind) return;
          setEntityType(
            await updateEntityTypeProperties(
              ws.workspaceId,
              etid,
              entityType.properties.map((p) =>
                p.name === field ? { ...p, config: { ...p.config, kind } } : p,
              ),
            ),
          );
          refetch();
        }
      } catch (err) {
        setSchemaError(
          format(e.failed, { message: err instanceof Error ? err.message : String(err) }),
        );
      }
    },
    [binding.entityTypeId, entityType, ws.workspaceId, t],
  );

  // Renderer column op. Display ops (resize / sort / hide / freeze / reorder)
  // persist to binding.display; schema-edit ops route to the entity API (custom
  // tables only — the menu only offers them when `editableColumns`).
  const handleColumnOp = useCallback(
    (actionId: string, params: Record<string, unknown>) => {
      if (isCustom && SCHEMA_EDIT_OPS.has(actionId)) {
        void handleSchemaEdit(actionId, params);
        return;
      }
      setViewConfig((prev) => {
        if (!prev) return prev;
        const next = reduceColumnOp(prev, actionId, params);
        if (next !== prev) persistDisplay(next);
        return next;
      });
    },
    [isCustom, handleSchemaEdit, persistDisplay],
  );

  if (error)
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {t.dataBlockFailed}
      </div>
    );
  if (!payload)
    return (
      <div className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
        {t.dataBlockLoading}
      </div>
    );

  // Table embeds get the view-config chrome (filter / sort / group /
  // properties) above the widget, plus the Notion-database column / row menus
  // INSIDE the widget. `<BlockData>` renders + drives it (inline cell edit,
  // add/delete/duplicate row); column ops route back through `onColumnOp`.
  // Non-table roots (board / kpi / chart) render through `<BlockData>` bare.
  if (tableRoot && viewConfig) {
    const transformed = applyViewConfig(tableRoot, viewConfig, isCustom);
    const entityLabel =
      binding.entity === "custom"
        ? entityType?.name ?? ""
        : t.dataTable.entityLabels[binding.entity];
    return (
      <div className="group/datatable space-y-1.5">
        {schemaError ? (
          <div
            role="alert"
            className="flex items-center justify-between rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive"
          >
            <span>{schemaError}</span>
            <button
              type="button"
              onClick={() => setSchemaError(null)}
              className="text-muted-foreground hover:text-foreground"
              aria-label={t.cellEditor.dismissError}
            >
              ×
            </button>
          </div>
        ) : null}
        {/* Title + view-config options share ONE fixed-height row. The options
            (search / filter / sort / group / properties) fade in on hover or
            keyboard focus via opacity ALONE — they always occupy their layout
            slot, so revealing them never reflows the row or nudges the table
            below. The container settles at `opacity:1` when revealed, creating
            no stacking context then, so the popovers' `z-40` paints above the
            table's sticky `z-20` header. */}
        <div className="flex min-h-7 items-center gap-3">
          <div className="shrink-0 text-base font-semibold text-foreground">
            {entityLabel}
          </div>
          <div
            aria-label={t.dataTable.toolbarAria}
            className="min-w-0 flex-1 pointer-events-none opacity-0 transition-opacity duration-150 group-hover/datatable:pointer-events-auto group-hover/datatable:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100 motion-reduce:transition-none"
          >
            <ViewToolbar
              columns={tableRoot.columns}
              value={viewConfig}
              onChange={handleToolbarChange}
            />
          </div>
        </div>
        <BlockData
          widget={transformed}
          onDataMutated={refetch}
          enableColumnMenu
          tableLabels={t.tableMenu}
          onColumnOp={handleColumnOp}
          customEntity={
            isCustom && binding.entityTypeId
              ? { entityTypeId: binding.entityTypeId, properties: entityType?.properties ?? [] }
              : undefined
          }
        />
      </div>
    );
  }

  return <BlockData widget={payload.root} onDataMutated={refetch} />;
}

export function EmbedView(props: NodeViewProps) {
  const raw = props.node.attrs.block as string | null;
  const block = useMemo<Block | null>(() => {
    try {
      return raw ? (JSON.parse(raw) as Block) : null;
    } catch {
      return null;
    }
  }, [raw]);

  // Persist an in-place edit to the embed's block JSON (used by the media
  // URL-entry stub). Writes the attr through ProseMirror so it syncs via Yjs.
  const updateBlock = useCallback(
    (next: Block) => props.updateAttributes({ block: JSON.stringify(next) }),
    [props],
  );

  // Whole-block colour (the block-action menu's "Color"). The embed carries
  // the same named-palette `color` / `bgColor` global attrs as every other
  // block (doc-model `ID_NODE_TYPES`); surface them as `data-color` / `data-bg`
  // so the shared `[data-color]` / `[data-bg]` rules in globals.css tint the
  // block (a background wash is the visible effect for a widget; text colour
  // cascades to inner text). Omitted when null so an uncoloured embed renders
  // exactly as before.
  const color = props.node.attrs.color as string | null;
  const bgColor = props.node.attrs.bgColor as string | null;

  // Gate the in-place edit affordances (diagram source editor, media URL entry)
  // on the editor's editable state: a shared / read-only page can still *view*
  // a diagram's Mermaid source but not update it.
  const editable = props.editor.isEditable;

  return (
    <NodeViewWrapper
      className="doc-embed my-2"
      contentEditable={false}
      {...(color ? { "data-color": color } : {})}
      {...(bgColor ? { "data-bg": bgColor } : {})}
    >
      {/* A live data/chart widget can throw synchronously while painting a
          malformed payload; without a boundary that throw unwinds React up
          through the whole editor and blanks the ENTIRE page (every other
          block + the title + chrome), not just this block. Contain it with the
          shared doc `ErrorBoundary`, showing the same dashed tombstone as a
          failed data resolve. `key` on the block identity remounts the boundary
          when the attr changes (a chat/edit fix re-resolving the binding), so a
          repaired block recovers in place instead of staying latched. */}
      <ErrorBoundary
        key={(props.node.attrs.blockId as string | undefined) ?? raw ?? "embed"}
        fallback={() => <EmbedCrashFallback />}
      >
        {renderEmbed(block, updateBlock, editable)}
      </ErrorBoundary>
    </NodeViewWrapper>
  );
}

/**
 * Fallback for an embed node-view that threw while rendering (caught by the
 * shared `ErrorBoundary`). Mirrors the data-resolve failure card so a render
 * crash and a fetch failure read identically — the block is dead in place, the
 * rest of the page is untouched. Reuses the existing `dataBlockFailed` string.
 */
function EmbedCrashFallback() {
  const t = useT().docPage;
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {t.dataBlockFailed}
    </div>
  );
}

/** Dispatch the parsed block to its embed renderer. */
function renderEmbed(
  block: Block | null,
  updateBlock: (next: Block) => void,
  editable: boolean,
) {
  if (!block) {
    return <EmbedFallback kind="embed" />;
  }
  switch (block.kind) {
    case "data": {
      // The slash-menu insert mints this binding-less ("Table"); chat (or
      // the view-config UI) supplies the binding later. Until then render a
      // stub instead of trying to resolve an undefined binding.
      const binding = (block as { binding?: BindingConfig }).binding;
      return binding ? (
        <DataEmbed block={block} binding={binding} updateBlock={updateBlock} />
      ) : (
        <EmptyDataStub kind="data" />
      );
    }
    case "chart": {
      // Static (model-authored) charts render their inline `data` directly.
      // Live (binding) charts aren't resolved in the collab editor yet, so a
      // binding-only / empty chart shows the stub rather than mis-resolving
      // its AggregateBinding as a table. A rendered chart is zoomable —
      // double-click / expand opens the full-screen preview.
      const c = block as ChartBlock;
      const widget = chartBlockToWidget(c);
      return widget ? (
        <ZoomableVisual label={c.title}>
          <BlockData widget={widget} />
        </ZoomableVisual>
      ) : (
        <EmptyDataStub kind="chart" />
      );
    }
    case "diagram":
      // Model-authored Mermaid → SVG via the renderer's Diagram widget, now
      // with a human "view source / edit source" affordance (`DiagramEmbed`).
      return (
        <DiagramEmbed block={block as DiagramBlock} editable={editable} updateBlock={updateBlock} />
      );
    case "bookmark":
      // BLOCK-8: render the full OG card (favicon + title + description +
      // thumbnail) the user expects, not a bare truncated link. BlockBookmark
      // owns the empty-URL input → OG-fetch → card lifecycle; edits sync via
      // updateBlock (the editor's Yjs write path).
      return (
        <BlockBookmark
          block={block as unknown as BookmarkBlock}
          blockId={block.id}
          readOnly={!editable}
          onChange={(patch) => updateBlock({ ...block, ...patch } as Block)}
        />
      );
    case "video":
      return (
        <MediaEmbed
          block={block}
          kind="video"
          onUrl={(url) => updateBlock({ ...block, url })}
          onCaption={editable ? (caption) => updateBlock({ ...block, caption }) : undefined}
        />
      );
    case "audio":
      return (
        <MediaEmbed
          block={block}
          kind="audio"
          onUrl={(url) => updateBlock({ ...block, url })}
          onCaption={editable ? (caption) => updateBlock({ ...block, caption }) : undefined}
        />
      );
    case "image":
      return <ImageEmbed block={block} updateBlock={updateBlock} />;
    case "file":
      return <FileEmbed block={block} updateBlock={updateBlock} />;
    case "child_page":
      return <ChildPageEmbed block={block} />;
    default:
      return <EmbedFallback kind={block.kind} />;
  }
}

/** Generic dashed tombstone for an embed kind with no richer renderer yet. */
function EmbedFallback({ kind }: { kind: string }) {
  return (
    <div className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
      {kind}
    </div>
  );
}

/**
 * Diagram embed — the rendered Mermaid → SVG (zoomable, via `ZoomableVisual`)
 * plus a human **view source / edit source** affordance. v1 diagrams are a
 * snapshot of the model's Mermaid code; this lets a person read and hand-edit
 * that source without going through chat.
 *
 * Three states:
 *   - **Has code, collapsed** — render the diagram with a hover-revealed source
 *     button (top-left, opposite the lightbox expand button). The label reads
 *     "Edit source" when editable, "View source" when not.
 *   - **Editing / viewing source** — the inline `DiagramSourceEditor` (textarea
 *     + Update / Cancel; read-only + Close when the page isn't editable).
 *   - **Empty** — an editable page opens the editor straight away so a
 *     slash-inserted diagram is hand-authorable; a read-only page shows the
 *     "describe it in chat" stub (nothing to view yet).
 *
 * Update writes the new `code` back through `updateBlock` → the embed's `block`
 * attr → Yjs, so it syncs to every collaborator and re-renders the SVG (the
 * `Diagram` widget keys its mermaid compile on `widget.code`).
 *
 * [COMP:app-web/diagram-source]
 */
export function DiagramEmbed({
  block,
  editable,
  updateBlock,
}: {
  block: DiagramBlock;
  editable: boolean;
  updateBlock: (next: Block) => void;
}) {
  const t = useT().docPage;
  const [editing, setEditing] = useState(false);

  // An editable, codeless diagram opens its editor directly (author by hand);
  // otherwise the source editor is opt-in via the hover button.
  const showEditor = editing || (!block.code && editable);
  if (showEditor) {
    return (
      <DiagramSourceEditor
        code={block.code}
        editable={editable}
        // A codeless diagram has nothing to collapse back to, so it can't be
        // cancelled away (delete the block instead); a coded one returns to the
        // render.
        onCancel={block.code ? () => setEditing(false) : undefined}
        onSave={(code) => {
          updateBlock({ ...block, code });
          setEditing(false);
        }}
      />
    );
  }

  if (!block.code) return <EmptyDataStub kind="diagram" />;

  return (
    <div className="group/diagram relative">
      <ZoomableVisual label={block.title}>
        <BlockData widget={diagramBlockToWidget(block)} />
      </ZoomableVisual>
      <button
        type="button"
        aria-label={editable ? t.diagramSource.edit : t.diagramSource.view}
        title={editable ? t.diagramSource.edit : t.diagramSource.view}
        onClick={() => setEditing(true)}
        className="absolute left-2 top-2 z-10 rounded-md border border-border bg-background/80 p-1.5 text-muted-foreground opacity-0 shadow-sm backdrop-blur transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/diagram:opacity-100 motion-reduce:transition-none"
      >
        <Code2 className="size-4" aria-hidden />
      </button>
    </div>
  );
}

/**
 * Inline Mermaid source editor — a monospace textarea with Update / Cancel.
 * Read-only ("View source") when the page isn't editable: the textarea locks
 * and only a Close action returns to the render. Cmd/Ctrl+Enter commits, Esc
 * cancels. The embed node-view sets `stopEvent: () => true`, so these keys never
 * reach ProseMirror.
 */
function DiagramSourceEditor({
  code,
  editable,
  onSave,
  onCancel,
}: {
  code: string;
  editable: boolean;
  onSave: (code: string) => void;
  onCancel?: (() => void) | undefined;
}) {
  const t = useT().docPage.diagramSource;
  const [draft, setDraft] = useState(code);
  const trimmed = draft.trim();
  // Disable Update for an empty draft or a no-op (unchanged from the saved code).
  const canSave = editable && trimmed.length > 0 && trimmed !== code.trim();
  const rows = Math.min(20, Math.max(6, draft.split("\n").length + 1));

  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Code2 className="size-4 shrink-0" aria-hidden />
        <span>{t.label}</span>
      </div>
      <textarea
        value={draft}
        readOnly={!editable}
        spellCheck={false}
        rows={rows}
        aria-label={t.label}
        placeholder={t.placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (canSave && (e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            onSave(trimmed);
          } else if (e.key === "Escape" && onCancel) {
            e.preventDefault();
            onCancel();
          }
        }}
        className="w-full resize-y rounded border border-border bg-background px-2.5 py-2 font-mono text-xs leading-relaxed text-foreground outline-none focus-visible:border-primary/60 read-only:cursor-default read-only:opacity-90"
      />
      <div className="flex items-center justify-end gap-2">
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {editable ? t.cancel : t.close}
          </button>
        ) : null}
        {editable ? (
          <button
            type="button"
            onClick={() => onSave(trimmed)}
            disabled={!canSave}
            className="rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
          >
            {t.update}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Image block — mounts the durable-storage `BlockImage` (picker → upload to
 * `/api/doc-files` → signed read). `workspaceId` comes from context;
 * `onChange` writes the patched block back through `updateBlock`, which syncs
 * the new `ref` / caption to every collaborator via Yjs.
 */
function ImageEmbed({
  block,
  updateBlock,
}: {
  block: ImageBlock;
  updateBlock: (next: Block) => void;
}) {
  const { workspaceId } = useWorkspaceContext();
  return (
    <BlockImage
      block={block}
      blockId={block.id}
      workspaceId={workspaceId}
      onChange={(patch) => updateBlock({ ...block, ...patch })}
    />
  );
}

/** Generic file block — same durable-storage path as `ImageEmbed`, rendered as
 * a download pill by `BlockFile`. */
function FileEmbed({
  block,
  updateBlock,
}: {
  block: FileBlock;
  updateBlock: (next: Block) => void;
}) {
  const { workspaceId } = useWorkspaceContext();
  return (
    <BlockFile
      block={block}
      blockId={block.id}
      workspaceId={workspaceId}
      onChange={(patch) => updateBlock({ ...block, ...patch })}
    />
  );
}

/**
 * Inline video / audio player. With a URL it renders the native player; empty
 * (the freshly-inserted state) it shows a compact paste-a-URL form that writes
 * the URL back into the block attr (syncing through Yjs to every collaborator).
 */
function MediaEmbed({
  block,
  kind,
  onUrl,
  onCaption,
}: {
  block: { url: string; caption?: string };
  kind: "video" | "audio";
  onUrl: (url: string) => void;
  /** Editable caption write-back; omitted (read-only) → caption shows as text. */
  onCaption?: (caption: string) => void;
}) {
  const t = useT().docPage;
  const [draft, setDraft] = useState("");
  // BLOCK-7: local caption draft, committed on blur — mirrors the image
  // block's caption editor so video/audio can ADD a caption, not just display
  // one. Read-only (no onCaption) falls back to a static figcaption.
  const [caption, setCaption] = useState(block.caption ?? "");
  const Icon = kind === "video" ? Film : Music;

  if (block.url) {
    return (
      <figure className="space-y-1">
        {kind === "video" ? (
          <video
            src={block.url}
            controls
            className="w-full rounded-md border border-border bg-black/5"
          />
        ) : (
          <audio src={block.url} controls className="w-full" />
        )}
        {onCaption ? (
          <input
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            onBlur={() => {
              if (caption !== (block.caption ?? "")) onCaption(caption);
            }}
            placeholder={t.mediaBlock.captionPlaceholder}
            className="w-full bg-transparent text-xs text-muted-foreground outline-none placeholder:text-muted-foreground/50"
          />
        ) : block.caption ? (
          <figcaption className="text-xs text-muted-foreground">{block.caption}</figcaption>
        ) : null}
      </figure>
    );
  }

  const submit = () => {
    const url = draft.trim();
    if (url) onUrl(url);
  };

  return (
    <div className="flex items-center gap-2 rounded-md border border-dashed border-border bg-muted/20 px-3 py-2">
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <input
        type="url"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={kind === "video" ? t.embed.videoUrlPlaceholder : t.embed.audioUrlPlaceholder}
        className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/60"
      />
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={submit}
        disabled={!draft.trim()}
        className="shrink-0 rounded px-2 py-0.5 text-xs font-medium text-primary hover:bg-muted disabled:opacity-40"
      >
        {t.embed.addUrl}
      </button>
    </div>
  );
}

/** Inline link to a nested page — reuses the sidebar's child-page row. */
function ChildPageEmbed({ block }: { block: ChildPageBlock }) {
  const router = useRouter();
  const ws = useWorkspaceContext();
  return (
    <BlockChildPage
      block={block}
      onNavigate={(viewId) => router.push(`/w/${ws.workspaceId}/p/${viewId}`)}
    />
  );
}

/** Sourceless data / chart / diagram stub — the "describe it in chat" empty state. */
function EmptyDataStub({ kind }: { kind: "data" | "chart" | "diagram" }) {
  const t = useT().docPage;
  const Icon = kind === "diagram" ? Share2 : Database;
  const label =
    kind === "data"
      ? t.embed.emptyTable
      : kind === "chart"
        ? t.embed.emptyChart
        : t.embed.emptyDiagram;
  return (
    <div className="flex items-center gap-2 rounded-md border border-dashed border-border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
      <Icon className="size-4 shrink-0" aria-hidden />
      <span>{label}</span>
    </div>
  );
}
