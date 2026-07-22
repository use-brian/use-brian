"use client";

/**
 * Renders a `data` block — wraps the existing <ViewRenderer /> from
 * @use-brian/views-renderer. The resolved A2UI widget is supplied by the
 * caller, so the host owns payload fetching.
 *
 * **Shared interaction surface — do NOT delete with the legacy renderer.**
 * Two hosts mount this: the legacy `page-renderer` (one payload fetch per
 * page) and, now, the collaborative editor's `node-views/embed-view.tsx`
 * (each `data`/`chart` embed resolves its own binding via `renderBinding`
 * and passes `onDataMutated` to re-resolve after a write). All data-block
 * interaction — inline cell edit, add/delete row, board card
 * moves — lives here so both hosts behave identically; when the legacy
 * page-renderer path is finally removed, this component stays.
 *
 * Phase 2 (Notion-feel) — `cell-update` actions from the property
 * Editors are routed to `PATCH /api/<entity>/<id>`. Optimistic UI: the
 * commit value lands in `rowOverrides` immediately, the row paints the
 * new value, then on failure we snap back and surface a transient
 * inline alert.
 *
 * Phase 3 — the remaining write-back actions:
 *   - `row-open` / `open-entity`  → for TABLES/BOARDS intentionally NOT
 *     handled. The row detail drawer was removed: the table already
 *     shows every field inline and edits commit inline, so clicking a
 *     row's "Open" menu item or a relation pill is inert (the shared
 *     renderer still emits these host-agnostic actions; this host
 *     ignores them, like `apps/web` does). For a CALENDAR chip the
 *     rationale inverts — a chip shows only a truncated title — so the
 *     click opens the /tasks-surface task peek (`TaskRecordDetail`)
 *     over the doc, with commits on the supersession-aware brain
 *     adjust wire + an `onDataMutated` re-resolve.
 *   - `row-delete`  → confirm, optimistically drop the row, then
 *     `deleteEntity` (D.4 soft-delete). On failure, restore + alert.
 *   - `row-add`     → `createEntity` with the entity's minimal defaults,
 *     then ask the parent to refetch the resolved payload so the new
 *     row's cells line up (data blocks are never snapshotted — see the
 *     freshness rule in app-web/CLAUDE.md).
 *   - `move-card`   → a board drop changed the card's group (status for
 *     tasks, stage for deals). The Board already moved the card locally;
 *     we route the group change through the same `patchEntity` path as a
 *     cell-update, and on failure refetch so the board snaps back to
 *     server truth.
 *   - `reschedule`  → a calendar chip was dropped on another day. The
 *     Calendar already moved the chip optimistically; we PATCH the row's
 *     date field (`due` for tasks) through the same `patchEntity` path,
 *     then refetch — success re-renders server truth (clearing the
 *     renderer's optimistic overlay), failure snaps the chip back.
 *
 * [COMP:app-web/block-data]
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useT, format } from "@/lib/i18n/client";
import { renderWidget } from "@use-brian/views-renderer";
import type {
  A2UIRow,
  A2UIRowValue,
  A2UIWidget,
  BoardWidget,
  CalendarWidget,
  ColumnMenuLabels,
  OnActionHandler,
  TableWidget,
} from "@use-brian/views-renderer";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { useWorkspaceContext } from "@/lib/workspace-context";
import {
  patchEntity,
  createEntity,
  deleteEntity,
  type EntityKind,
} from "@/lib/api/entities";
import {
  createEntity as createCustomEntity,
  deleteEntity as deleteCustomEntity,
  updateEntity as updateCustomEntity,
  type CellValue,
  type PropertyKind,
} from "@/lib/api/doc-entities";
import { TaskRecordDetail } from "@/components/tasks/task-record-detail";
import {
  adjustBrainRow,
  type AdjustMemoryChanges,
} from "@/lib/api/brain-inbox";
import { fetchWorkspaceTasks, type TaskRow } from "@/lib/api/tasks";
import { projectOptions } from "@/lib/tasks-view";
import { loadWorkspaceRoster } from "@/lib/api/workspace-roster";
import type { AssignableMember } from "@/components/brain/property-edit";

type CellUpdateParams = {
  entity: string;
  rowId: string;
  field: string;
  value: A2UIRowValue;
};

function isSupportedEntity(entity: string): entity is EntityKind {
  return (
    entity === "tasks" ||
    entity === "deals" ||
    entity === "contacts" ||
    entity === "companies"
  );
}

/**
 * Infer the entity a board operates on from its `groupBy` axis. Only
 * tasks (group by `status`) and deals (group by `stage`) support the
 * board view — the binding schema rejects `companies`/`contacts` boards
 * — so the axis is a sufficient discriminator. Boards carry no
 * `rowAction`, so this is the only entity hint available to the host.
 */
export function boardEntity(groupBy: string): EntityKind | null {
  if (groupBy === "status") return "tasks";
  if (groupBy === "stage") return "deals";
  return null;
}

/**
 * Map property-Editor commit values onto the server's PATCH allowlist.
 * The Editor returns whatever shape its cell uses (string, number,
 * PersonWidget, RelationWidget, container-of-badges, ISO string, null).
 * The server wants per-field primitives — translate at the host edge
 * so the wire surface stays narrow.
 */
export function translateCommit(
  field: string,
  value: A2UIRowValue,
): Record<string, unknown> | null {
  if (field === "tags") {
    if (value === null) return { tags: [] };
    if (typeof value === "string") return { tags: value.length ? [value] : [] };
    if (typeof value === "object" && value.type === "container") {
      const tags: string[] = [];
      for (const child of value.children) {
        if (typeof child === "object" && child.type === "badge") tags.push(child.text);
      }
      return { tags };
    }
    return null;
  }
  if (field === "assigneeId" || field === "assignee" || field === "owner") {
    if (value === null) return { assigneeId: null };
    if (typeof value === "object" && value.type === "person") {
      return { assigneeId: value.id };
    }
    return null;
  }
  if (field === "companyId" || field === "contactId" || field === "parentId") {
    if (value === null) return { [field]: null };
    if (typeof value === "object" && value.type === "relation") {
      return { [field]: value.id };
    }
    if (typeof value === "string") return { [field]: value };
    return null;
  }
  if (field === "due" || field === "closeDate" || field === "dueAt") {
    const key = field === "dueAt" ? "due" : field;
    if (value === null) return { [key]: null };
    if (typeof value === "string") return { [key]: value };
    if (typeof value === "object" && value.type === "date") {
      return { [key]: value.iso };
    }
    return null;
  }
  if (field === "amount") {
    if (value === null) return { amount: null };
    if (typeof value === "number") return { amount: value };
    if (typeof value === "object" && value.type === "number") {
      return { amount: value.value };
    }
    return null;
  }
  if (field === "status" || field === "stage") {
    if (value === null) return { [field]: null };
    if (typeof value === "string") return { [field]: value };
    if (typeof value === "object" && value.type === "badge") {
      return { [field]: value.text };
    }
    // The inline `status` editor commits a StatusWidget — persist its
    // `optionId` (the schema value the row stores).
    if (typeof value === "object" && value.type === "status") {
      return { [field]: value.optionId };
    }
    return null;
  }
  if (value === null) return { [field]: null };
  if (typeof value === "string" || typeof value === "number") {
    return { [field]: value };
  }
  return null;
}

/**
 * Map a property `Editor` commit value onto a user-defined entity `CellValue`
 * (`{ kind, value }`) for `updateEntity`. The companion to `translateCommit`
 * (built-ins), keyed by the entity property kind (the real kind — e.g.
 * `multi_select`, not the renderer's `tags`). Returns null for kinds with no
 * inline editor (person / relation / files / auto-stamps).
 */
export function translateCustomCommit(
  value: A2UIRowValue,
  kind: PropertyKind,
): CellValue | null {
  const w = typeof value === "object" && value !== null ? value : null;
  switch (kind) {
    case "text":
      return { kind: "text", value: typeof value === "string" ? value : null };
    case "url":
    case "email":
    case "phone":
      return { kind, value: typeof value === "string" ? value : value == null ? null : String(value) };
    case "number": {
      if (value == null) return { kind: "number", value: null };
      if (typeof value === "number") return { kind: "number", value };
      if (w && w.type === "number") return { kind: "number", value: w.value ?? null };
      const n = Number(value);
      return { kind: "number", value: Number.isFinite(n) ? n : null };
    }
    case "checkbox":
      // A2UIRowValue carries no boolean; the cell is a "✓" glyph / number /
      // stringified bool. `String(value)` also catches a runtime boolean.
      return { kind: "checkbox", value: value === "✓" || value === 1 || String(value) === "true" };
    case "date": {
      if (value == null) return { kind: "date", value: null };
      const iso = typeof value === "string" ? value : w && w.type === "date" ? w.iso : null;
      return { kind: "date", value: iso ? { start: iso } : null };
    }
    case "select": {
      if (value == null) return { kind: "select", value: null };
      if (typeof value === "string") return { kind: "select", value };
      if (w && w.type === "badge") return { kind: "select", value: w.text };
      if (w && w.type === "status") return { kind: "select", value: w.optionId };
      return { kind: "select", value: null };
    }
    case "status": {
      if (value == null) return { kind: "status", value: null };
      if (typeof value === "string") return { kind: "status", value };
      if (w && w.type === "status") return { kind: "status", value: w.optionId };
      if (w && w.type === "badge") return { kind: "status", value: w.text };
      return { kind: "status", value: null };
    }
    case "multi_select": {
      if (Array.isArray(value)) return { kind: "multi_select", value: value.map(String) };
      if (w && w.type === "container") {
        const ids: string[] = [];
        for (const c of w.children) if (c.type === "badge") ids.push(c.text);
        return { kind: "multi_select", value: ids };
      }
      if (typeof value === "string") return { kind: "multi_select", value: value ? [value] : [] };
      return { kind: "multi_select", value: [] };
    }
    default:
      return null;
  }
}

/**
 * Merge optimistic row overrides into a TableWidget and drop rows that
 * were optimistically deleted. Rows are matched by `id` cell (the
 * Phase-0 convention is every row carries an `id` field with the entity
 * primary key). Rows without overrides pass through unchanged; deleted
 * rows are removed entirely.
 */
export function applyOverrides(
  widget: A2UIWidget,
  rowOverrides: Record<string, Record<string, A2UIRowValue>>,
  deletedRowIds: ReadonlySet<string>,
): A2UIWidget {
  if (widget.type !== "table") return widget;
  if (Object.keys(rowOverrides).length === 0 && deletedRowIds.size === 0) {
    return widget;
  }
  const table = widget as TableWidget;
  return {
    ...table,
    rows: table.rows
      .filter((row) => {
        const id = typeof row.id === "string" ? row.id : null;
        return !(id && deletedRowIds.has(id));
      })
      .map((row): A2UIRow => {
        const id = typeof row.id === "string" ? row.id : null;
        if (!id) return row;
        const patch = rowOverrides[id];
        if (!patch) return row;
        const next: A2UIRow = { ...row };
        for (const [k, v] of Object.entries(patch)) {
          next[k] = v;
        }
        return next;
      }),
  };
}

export function BlockData({
  widget,
  onDataMutated,
  enableColumnMenu,
  tableLabels,
  onColumnOp,
  customEntity,
}: {
  widget: A2UIWidget | null;
  /**
   * Ask the parent (PageRenderer) to re-resolve this page's payload.
   * Fired after a `row-add` succeeds (and after a `row-delete` /
   * `move-card` fails) so the rendered view reflects server truth — data
   * blocks are never snapshotted (app-web/CLAUDE.md freshness rule).
   */
  onDataMutated?: () => void;
  /**
   * Notion-database chrome (doc data-table host). When set, the table
   * column / row menus appear and fire `column-*` / `row-duplicate`. Column
   * ops route to `onColumnOp` (the embed persists them to `binding.display`,
   * or — Phase B — to entity tools); `row-duplicate` is handled here.
   */
  enableColumnMenu?: boolean;
  tableLabels?: Partial<ColumnMenuLabels>;
  onColumnOp?: (actionId: string, params: Record<string, unknown>) => void;
  /**
   * Custom (user-defined) entity table (Phase B). When set, cell edits / row
   * add / delete / duplicate route through the entity REST API
   * (`updateEntity` / `createEntity` / `deleteEntity`) instead of the built-in
   * `PATCH /<entity>/<id>` path. `properties` supplies each field's kind for
   * `translateCustomCommit`.
   */
  customEntity?: {
    entityTypeId: string;
    properties: { name: string; config: { kind: PropertyKind } }[];
  };
}) {
  const t = useT().docPage;
  const workspace = useWorkspaceContext();
  const [rowOverrides, setRowOverrides] = useState<
    Record<string, Record<string, A2UIRowValue>>
  >({});
  const [deletedRowIds, setDeletedRowIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [cellError, setCellError] = useState<string | null>(null);

  // ── Calendar task peek ────────────────────────────────────────────────
  // Clicking a calendar chip opens the SAME floating task editor the
  // /tasks operator surface uses (`TaskRecordDetail`) — a chip shows only
  // a truncated title, so unlike a table row there is nothing to edit
  // inline. Rows + roster load lazily on the first chip click; commits go
  // through the supersession-aware brain adjust wire, then `onDataMutated`
  // re-resolves the calendar so the chip reflects the edit.
  const [peekTaskId, setPeekTaskId] = useState<string | null>(null);
  const [peekTasks, setPeekTasks] = useState<TaskRow[] | null>(null);
  const [peekRoster, setPeekRoster] = useState<AssignableMember[] | null>(null);
  useEffect(() => {
    if (!peekTaskId) return;
    let cancelled = false;
    // Refetch on every open — a drag-reschedule or another surface may have
    // changed the row since the last peek. A kept stale list is only used
    // as the fallback when the refetch fails mid-session.
    fetchWorkspaceTasks(workspace.workspaceId)
      .then((rows) => {
        if (!cancelled) setPeekTasks(rows);
      })
      .catch(() => {
        // No data at all → close rather than show an empty panel.
        if (!cancelled) setPeekTasks((prev) => (prev === null ? [] : prev));
      });
    if (peekRoster === null) {
      loadWorkspaceRoster(workspace.workspaceId)
        .then((r) => {
          if (!cancelled) setPeekRoster(r);
        })
        .catch(() => {
          if (!cancelled) setPeekRoster([]);
        });
    }
    return () => {
      cancelled = true;
    };
    // `peekRoster` is a load-once cache, not a retrigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peekTaskId, workspace.workspaceId]);
  const peekTask = useMemo(
    () => (peekTasks ?? []).find((r) => r.id === peekTaskId) ?? null,
    [peekTasks, peekTaskId],
  );
  const commitPeekField = useCallback(
    async (
      row: TaskRow,
      changes: AdjustMemoryChanges,
      patch: Partial<TaskRow>,
    ): Promise<{ ok: boolean; error?: string }> => {
      const result = await adjustBrainRow(
        workspace.workspaceId,
        "task",
        row.id,
        changes,
      );
      if (!result.ok) return { ok: false, error: result.error };
      // Apply the local patch + follow a supersession id swap, so the peek
      // stays anchored while the calendar refetches underneath.
      setPeekTasks((prev) =>
        prev
          ? prev.map((r) =>
              r.id === row.id ? { ...r, ...patch, id: result.newId ?? r.id } : r,
            )
          : prev,
      );
      setPeekTaskId((cur) => (cur === row.id ? (result.newId ?? row.id) : cur));
      onDataMutated?.();
      return { ok: true };
    },
    [workspace.workspaceId, onDataMutated],
  );

  // Apply optimistic overrides + deletions BEFORE rendering so editors
  // paint the new value (and removed rows vanish) in the same frame as
  // commit.
  const rendered = useMemo(() => {
    if (!widget) return null;
    return applyOverrides(widget, rowOverrides, deletedRowIds);
  }, [widget, rowOverrides, deletedRowIds]);

  if (!widget) {
    return (
      <div className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
        {t.dataBlockLoading}
      </div>
    );
  }

  const actionCarrier = isTableWidget(widget)
    ? widget
    : isCalendarWidget(widget)
      ? widget
      : null;
  const rowActionParams = actionCarrier?.rowAction?.params ?? {};
  const tableEntity =
    typeof rowActionParams.entity === "string" ? rowActionParams.entity : "row";

  // Resolve the entity for this block. Tables and calendars carry it on
  // `rowAction`; boards carry only `groupBy`, from which it is inferred.
  const blockEntity: string = isBoardWidget(widget)
    ? boardEntity(widget.groupBy) ?? "row"
    : tableEntity;

  // Custom-table property kinds, keyed by field — drives `translateCustomCommit`.
  const customKindByField = useMemo(
    () => new Map((customEntity?.properties ?? []).map((p) => [p.name, p.config.kind])),
    [customEntity],
  );

  // Server-commit a single field update (shared by inline cell-edit and
  // board move-card). Optimistic: the value lands in `rowOverrides`
  // first; on failure we snap back and surface an inline alert.
  function commitFieldUpdate(
    entity: string,
    rowId: string,
    field: string,
    value: A2UIRowValue,
  ): void {
    if (!isSupportedEntity(entity)) {
      setCellError(`Unsupported entity: ${entity}`);
      return;
    }
    const patch = translateCommit(field, value);
    if (!patch) {
      setCellError(`Cannot translate update for field: ${field}`);
      return;
    }
    const previous = rowOverrides[rowId] ?? {};
    setRowOverrides((prev) => ({
      ...prev,
      [rowId]: { ...(prev[rowId] ?? {}), [field]: value },
    }));
    setCellError(null);

    void patchEntity({ entity, id: rowId, patch }).then((result) => {
      if (!result.ok) {
        setRowOverrides((prev) => {
          const next = { ...prev };
          if (Object.keys(previous).length === 0) {
            delete next[rowId];
          } else {
            next[rowId] = previous;
          }
          return next;
        });
        setCellError(result.error);
      }
    });
  }

  // Custom-table cell edit → `updateEntity`. No optimistic override (the
  // committed widget value isn't always the rendered form), so re-resolve on
  // success to repaint the cell correctly; surface an inline alert on failure.
  function commitCustomCell(rowId: string, field: string, value: A2UIRowValue): void {
    if (!customEntity) return;
    const kind = customKindByField.get(field);
    const cell = kind ? translateCustomCommit(value, kind) : null;
    if (!cell) {
      setCellError(`Cannot update ${field}`);
      return;
    }
    setCellError(null);
    void updateCustomEntity(workspace.workspaceId, rowId, { [field]: cell })
      .then(() => onDataMutated?.())
      .catch((err) => setCellError(err instanceof Error ? err.message : String(err)));
  }

  // Duplicate a row (Notion row menu). Best-effort: reconstructs a create
  // payload from the source row's cells via `translateCommit` (the same
  // widget→field mapping inline edits use), then creates + refetches.
  // Read-only / unmapped fields (auto-stamps, untranslatable widgets) are
  // simply skipped, so only the table's own properties carry over.
  function handleRowDuplicate(rowId: string | null): void {
    if (!rowId) return;
    if (customEntity) {
      const tbl = isTableWidget(widget) ? (widget as TableWidget) : null;
      const src = tbl?.rows.find((r) => (typeof r.id === "string" ? r.id : null) === rowId);
      if (!src) return;
      const data: Record<string, CellValue> = {};
      for (const [field, cell] of Object.entries(src)) {
        if (field === "id") continue;
        const kind = customKindByField.get(field);
        const cv = kind ? translateCustomCommit(cell as A2UIRowValue, kind) : null;
        if (cv) data[field] = cv;
      }
      setCellError(null);
      void createCustomEntity(workspace.workspaceId, customEntity.entityTypeId, data)
        .then(() => onDataMutated?.())
        .catch((err) =>
          setCellError(format(t.dataRow.addFailed, { message: err instanceof Error ? err.message : String(err) })),
        );
      return;
    }
    if (!isSupportedEntity(blockEntity)) {
      setCellError(`Unsupported entity: ${blockEntity}`);
      return;
    }
    const table = isTableWidget(widget) ? (widget as TableWidget) : null;
    const srcRow = table?.rows.find(
      (r) => (typeof r.id === "string" ? r.id : null) === rowId,
    );
    if (!srcRow) return;
    const values: Record<string, unknown> = {};
    for (const [field, cell] of Object.entries(srcRow)) {
      if (field === "id") continue;
      const patch = translateCommit(field, cell as A2UIRowValue);
      if (patch) Object.assign(values, patch);
    }
    setCellError(null);
    void createEntity({
      entity: blockEntity,
      workspaceId: workspace.workspaceId,
      values,
    }).then((result) => {
      if (!result.ok) {
        setCellError(format(t.dataRow.addFailed, { message: result.error }));
        return;
      }
      onDataMutated?.();
    });
  }

  const onAction: OnActionHandler = (actionId, params) => {
    // ── Notion-database column ops → host ───────────────────────────
    // Display ops (resize / sort / hide / freeze / reorder) persist to
    // binding.display; schema-edit ops (rename / retype / insert / duplicate /
    // delete) route to entity tools. Both flow up through `onColumnOp`.
    if (actionId.startsWith("column-")) {
      onColumnOp?.(actionId, (params ?? {}) as Record<string, unknown>);
      return;
    }

    // ── Row duplicate (Notion row menu) ─────────────────────────────
    if (actionId === "row-duplicate") {
      handleRowDuplicate(typeof params?.rowId === "string" ? params.rowId : null);
      return;
    }

    // ── Inline cell edit ────────────────────────────────────────────
    if (actionId === "cell-update") {
      const p = (params ?? {}) as Partial<CellUpdateParams>;
      const entity = p.entity ?? tableEntity;
      const rowId = p.rowId;
      const field = p.field;
      const value =
        (p as { value?: A2UIRowValue }).value === undefined
          ? null
          : ((p as { value?: A2UIRowValue }).value as A2UIRowValue);
      if (
        typeof entity !== "string" ||
        typeof rowId !== "string" ||
        typeof field !== "string"
      ) {
        return;
      }
      if (customEntity) {
        commitCustomCell(rowId, field, value);
        return;
      }
      commitFieldUpdate(entity, rowId, field, value);
      return;
    }

    // ── Board drop → group-field update ─────────────────────────────
    // The Board fires `move-card { cardId, fromCol, toCol }` after its
    // own optimistic local move. `toCol` is the destination column id,
    // which equals the new group value (status / stage). We translate it
    // into the same per-field PATCH the cell editor uses.
    if (actionId === "move-card") {
      const cardId = typeof params?.cardId === "string" ? params.cardId : null;
      const toCol = typeof params?.toCol === "string" ? params.toCol : null;
      if (!cardId || !toCol || !isBoardWidget(widget)) return;
      const entity = boardEntity(widget.groupBy);
      if (!entity) return;
      const previous = rowOverrides[cardId] ?? {};
      setCellError(null);
      void patchEntity({
        entity,
        id: cardId,
        patch: { [widget.groupBy]: toCol },
      }).then((result) => {
        if (!result.ok) {
          // The Board moved the card locally; a refetch re-resolves the
          // payload so the card snaps back to its server position.
          setRowOverrides((prev) => {
            const next = { ...prev };
            if (Object.keys(previous).length === 0) delete next[cardId];
            else next[cardId] = previous;
            return next;
          });
          setCellError(format(t.dataRow.moveFailed, { message: result.error }));
          onDataMutated?.();
        }
      });
      return;
    }

    // ── Calendar day "+" → create a task due that day ───────────────
    // The hover affordance fires `date-add { date: 'YYYY-MM-DD' }`. Create
    // the entity with its date field pre-set (server fills the rest from
    // the frozen-v1 defaults), then refetch so the new chip renders; the
    // user clicks it to fill in the rest via the peek.
    if (actionId === "date-add") {
      const date = typeof params?.date === "string" ? params.date : null;
      if (!date || !isCalendarWidget(widget)) return;
      if (!isSupportedEntity(blockEntity)) {
        setCellError(`Unsupported entity: ${blockEntity}`);
        return;
      }
      setCellError(null);
      void createEntity({
        entity: blockEntity,
        workspaceId: workspace.workspaceId,
        values: { due: date },
      }).then((result) => {
        if (!result.ok) {
          setCellError(format(t.dataRow.addFailed, { message: result.error }));
          return;
        }
        onDataMutated?.();
      });
      return;
    }

    // ── Calendar chip drop → date-field update ──────────────────────
    // The Calendar fires `reschedule { rowId, date, dateField }` after its
    // own optimistic local move (`date` is the target day's YYYY-MM-DD;
    // `dateField` is the widget's dateColumnId, e.g. `due`). Route it
    // through the same per-field PATCH the cell editor uses, then refetch:
    // on success the fresh payload carries the new date (clearing the
    // renderer's overlay against server truth); on failure the refetch
    // snaps the chip back to its server day.
    if (actionId === "reschedule") {
      const rowId = typeof params?.rowId === "string" ? params.rowId : null;
      const date = typeof params?.date === "string" ? params.date : null;
      const dateField =
        typeof params?.dateField === "string" ? params.dateField : null;
      if (!rowId || !date || !dateField || !isCalendarWidget(widget)) return;
      if (!isSupportedEntity(blockEntity)) {
        setCellError(`Unsupported entity: ${blockEntity}`);
        return;
      }
      const patch = translateCommit(dateField, date);
      if (!patch) {
        setCellError(`Cannot translate update for field: ${dateField}`);
        return;
      }
      setCellError(null);
      void patchEntity({ entity: blockEntity, id: rowId, patch }).then(
        (result) => {
          if (!result.ok) {
            setCellError(
              format(t.dataRow.rescheduleFailed, { message: result.error }),
            );
          }
          onDataMutated?.();
        },
      );
      return;
    }

    // ── Row add ("+ Add row") ───────────────────────────────────────
    if (actionId === "row-add") {
      if (customEntity) {
        setCellError(null);
        void createCustomEntity(workspace.workspaceId, customEntity.entityTypeId, {})
          .then(() => onDataMutated?.())
          .catch((err) =>
            setCellError(format(t.dataRow.addFailed, { message: err instanceof Error ? err.message : String(err) })),
          );
        return;
      }
      if (!isSupportedEntity(blockEntity)) {
        setCellError(`Unsupported entity: ${blockEntity}`);
        return;
      }
      setCellError(null);
      void createEntity({
        entity: blockEntity,
        workspaceId: workspace.workspaceId,
        // Minimal defaults — the server fills the rest from the frozen-v1
        // column defaults (placeholder title/name, default status/stage).
        values: {},
      }).then((result) => {
        if (!result.ok) {
          setCellError(format(t.dataRow.addFailed, { message: result.error }));
          return;
        }
        // New row created server-side — re-resolve the payload so its
        // cells render. Optimistic insertion isn't feasible here (the
        // server synthesises the full A2UI row shape), so we refetch.
        onDataMutated?.();
      });
      return;
    }

    // ── Row delete (table row-menu) ─────────────────────────────────
    if (actionId === "row-delete") {
      const rowId = typeof params?.rowId === "string" ? params.rowId : null;
      if (!rowId) return;
      if (customEntity) {
        void confirmDialog({
          title: t.dataRow.deleteConfirmTitle,
          description: t.dataRow.deleteConfirm,
          confirmLabel: t.dataRow.deleteConfirmAction,
          cancelLabel: t.cancel,
          variant: "destructive",
        }).then((confirmed) => {
          if (!confirmed) return;
          setCellError(null);
          setDeletedRowIds((prev) => new Set(prev).add(rowId));
          void deleteCustomEntity(workspace.workspaceId, rowId).catch((err) => {
            setDeletedRowIds((prev) => {
              const next = new Set(prev);
              next.delete(rowId);
              return next;
            });
            setCellError(format(t.dataRow.deleteFailed, { message: err instanceof Error ? err.message : String(err) }));
          });
        });
        return;
      }
      if (!isSupportedEntity(blockEntity)) {
        setCellError(`Unsupported entity: ${blockEntity}`);
        return;
      }
      void confirmDialog({
        title: t.dataRow.deleteConfirmTitle,
        description: t.dataRow.deleteConfirm,
        confirmLabel: t.dataRow.deleteConfirmAction,
        cancelLabel: t.cancel,
        variant: "destructive",
      }).then((confirmed) => {
        if (!confirmed) return;
        setCellError(null);
        // Optimistic remove — drop the row immediately.
        setDeletedRowIds((prev) => {
          const next = new Set(prev);
          next.add(rowId);
          return next;
        });
        void deleteEntity({
          entity: blockEntity,
          id: rowId,
          workspaceId: workspace.workspaceId,
        }).then((result) => {
          if (!result.ok) {
            // Restore the row and surface the failure.
            setDeletedRowIds((prev) => {
              const next = new Set(prev);
              next.delete(rowId);
              return next;
            });
            setCellError(format(t.dataRow.deleteFailed, { message: result.error }));
          }
        });
      });
      return;
    }

    // ── Calendar chip click → task peek ─────────────────────────────
    // A calendar chip shows only a truncated title, so (unlike a table
    // row, where every field edits inline and `open-entity` stays
    // deliberately unhandled) a click opens the /tasks-surface peek
    // panel over the doc.
    if (
      (actionId === "open-entity" || actionId === "row-open") &&
      isCalendarWidget(widget) &&
      blockEntity === "tasks"
    ) {
      const rowId = typeof params?.rowId === "string" ? params.rowId : null;
      if (rowId) setPeekTaskId(rowId);
      return;
    }

    // `row-open` / `open-entity` on tables/boards are deliberately
    // unhandled — the row detail drawer was removed (see the header
    // note). Table row clicks edit cells inline; there is no detail
    // panel to open.
  };

  return (
    <div className="w-full">
      {cellError && (
        <div
          role="alert"
          className="mb-2 flex items-center justify-between rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive"
        >
          <span>
            {t.cellEditor.saveFailed}: {cellError}
          </span>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => setCellError(null)}
            aria-label={t.cellEditor.dismissError}
          >
            ×
          </button>
        </div>
      )}
      {rendered
        ? renderWidget(rendered, onAction, undefined, {
            enableColumnMenu,
            tableLabels,
          })
        : null}
      {peekTask && typeof document !== "undefined"
        ? // Portal to <body>: `ResizablePeek` positions with `absolute
          // inset-y-0 right-0` + a full-bleed backdrop, so it must anchor
          // to the viewport — rendered inline here it would anchor to the
          // nearest positioned/transformed editor ancestor and float
          // mid-page. The portal gives the /tasks + Brain drawer behavior:
          // slide-in right panel, click the dimmed whitespace (or Escape)
          // to collapse.
          createPortal(
            <div className="fixed inset-0 z-50">
              <TaskRecordDetail
                workspaceId={workspace.workspaceId}
                row={peekTask}
                roster={peekRoster}
                projects={projectOptions(peekTasks ?? [])}
                commitField={commitPeekField}
                onClose={() => setPeekTaskId(null)}
              />
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function isTableWidget(
  widget: A2UIWidget | null,
): widget is Extract<A2UIWidget, { type: "table" }> {
  return widget !== null && widget.type === "table";
}

function isBoardWidget(
  widget: A2UIWidget | null,
): widget is BoardWidget {
  return widget !== null && widget.type === "board";
}

function isCalendarWidget(
  widget: A2UIWidget | null,
): widget is CalendarWidget {
  return widget !== null && widget.type === "calendar";
}
