"use client";

import { useCallback, useRef, useState } from "react";
import {
  NodeViewWrapper,
  NodeViewContent,
  type NodeViewProps,
} from "@tiptap/react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Copy,
  Eraser,
  GripHorizontal,
  GripVertical,
  Plus,
  Search,
  Table2,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/lib/i18n/client";
import {
  moveTableAxis,
  runTableCommand,
  selectTableAxis,
  tableHeaderState,
  type TableAxis,
  type TableCommand,
  type TableTarget,
} from "../table-controls";

type AxisHandle = {
  index: number;
  offset: number;
  size: number;
};

type DragTarget = TableTarget | null;

type PointerDrag = {
  source: TableTarget;
  pointerId: number;
  startX: number;
  startY: number;
  dragging: boolean;
};

const DRAG_THRESHOLD_PX = 5;

type TableText = ReturnType<typeof useT>["docPage"]["table"];

type AxisMenuAction = {
  command: TableCommand;
  label: string;
  icon: LucideIcon;
  group: number;
  checked?: boolean;
  destructive?: boolean;
};

function AxisMenuContent({
  axis,
  headerEnabled,
  query,
  onQueryChange,
  onRun,
  t,
}: {
  axis: TableAxis;
  headerEnabled: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  onRun: (command: TableCommand) => void;
  t: TableText;
}) {
  const actions: AxisMenuAction[] =
    axis === "row"
      ? [
          {
            command: "toggleHeaderRow",
            label: t.headerRow,
            icon: Table2,
            group: 0,
            checked: headerEnabled,
          },
          {
            command: "addRowBefore",
            label: t.insertRowAbove,
            icon: ArrowUp,
            group: 1,
          },
          {
            command: "addRowAfter",
            label: t.insertRowBelow,
            icon: ArrowDown,
            group: 1,
          },
          {
            command: "duplicateRow",
            label: t.duplicateRow,
            icon: Copy,
            group: 2,
          },
          {
            command: "clearRow",
            label: t.clearRowContents,
            icon: Eraser,
            group: 2,
          },
          {
            command: "deleteRow",
            label: t.deleteRow,
            icon: Trash2,
            group: 3,
            destructive: true,
          },
        ]
      : [
          {
            command: "toggleHeaderColumn",
            label: t.headerColumn,
            icon: Table2,
            group: 0,
            checked: headerEnabled,
          },
          {
            command: "addColumnBefore",
            label: t.insertColumnLeft,
            icon: ArrowLeft,
            group: 1,
          },
          {
            command: "addColumnAfter",
            label: t.insertColumnRight,
            icon: ArrowRight,
            group: 1,
          },
          {
            command: "duplicateColumn",
            label: t.duplicateColumn,
            icon: Copy,
            group: 2,
          },
          {
            command: "clearColumn",
            label: t.clearColumnContents,
            icon: Eraser,
            group: 2,
          },
          {
            command: "deleteColumn",
            label: t.deleteColumn,
            icon: Trash2,
            group: 3,
            destructive: true,
          },
        ];
  const needle = query.trim().toLocaleLowerCase();
  const visible = needle
    ? actions.filter((action) => action.label.toLocaleLowerCase().includes(needle))
    : actions;

  return (
    <>
      <div
        className="doc-table-action-search"
        onKeyDown={(event) => {
          // Keep menu typeahead/navigation out of the text field, but let the
          // menu root receive Escape so the familiar close shortcut still works.
          if (event.key !== "Escape") event.stopPropagation();
        }}
      >
        <Search aria-hidden />
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t.searchActions}
          aria-label={t.searchActions}
          autoFocus
        />
      </div>
      {visible.length === 0 ? (
        <p className="doc-table-action-empty">{t.noMatchingActions}</p>
      ) : (
        visible.map((action, index) => {
          const Icon = action.icon;
          const needsSeparator = index > 0 && visible[index - 1]!.group !== action.group;
          return (
            <div key={action.command}>
              {needsSeparator ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem
                variant={action.destructive ? "destructive" : "default"}
                onClick={() => onRun(action.command)}
              >
                <Icon aria-hidden />
                <span className="flex-1">{action.label}</span>
                {typeof action.checked === "boolean" ? (
                  <Switch
                    checked={action.checked}
                    tabIndex={-1}
                    aria-hidden
                    className="pointer-events-none ml-auto"
                  />
                ) : null}
              </DropdownMenuItem>
            </div>
          );
        })
      )}
    </>
  );
}

/**
 * React node-view for the native simple table.
 *
 * The table body stays entirely ProseMirror-managed. React owns only the
 * padded edge frame around it: the row/column grips, their portalled menus,
 * and the append rails. Because every control is inside that one frame, the
 * pointer never crosses an uncovered hover gap on its way from a cell to a
 * handle (the old detached toolbar disappeared during that crossing).
 *
 * [COMP:app-web/doc-table]
 */
export function TableView(props: NodeViewProps) {
  const t = useT().docPage.table;
  const frameRef = useRef<HTMLDivElement | null>(null);
  const tableRef = useRef<HTMLTableElement | null>(null);
  const dragRef = useRef<DragTarget>(null);
  const pointerDragRef = useRef<PointerDrag | null>(null);
  const dropTargetRef = useRef<DragTarget>(null);
  const suppressClickRef = useRef(false);
  const [rowHandle, setRowHandle] = useState<AxisHandle | null>(null);
  const [columnHandle, setColumnHandle] = useState<AxisHandle | null>(null);
  const [hotAxis, setHotAxis] = useState<TableAxis | null>(null);
  const [openMenu, setOpenMenu] = useState<TableAxis | null>(null);
  const [menuQuery, setMenuQuery] = useState("");
  const [dropTarget, setDropTarget] = useState<DragTarget>(null);
  const [dropHandle, setDropHandle] = useState<AxisHandle | null>(null);

  const targetFromCell = useCallback((cell: HTMLTableCellElement): {
    row: AxisHandle;
    column: AxisHandle;
  } | null => {
    const frame = frameRef.current;
    const table = tableRef.current;
    const row = cell.parentElement as HTMLTableRowElement | null;
    if (!frame || !table || !row || !table.contains(cell)) return null;
    // ReactNodeViewContent adds its own wrapper between <tbody> and <tr>, so
    // HTMLTableElement.rows / HTMLTableCellElement.cellIndex are not reliable
    // in the live node-view DOM. Query the rendered rows/cells explicitly.
    const rowIndex = Array.from(table.querySelectorAll("tr")).indexOf(row);
    const columnIndex = Array.from(row.querySelectorAll("td, th")).indexOf(cell);
    if (rowIndex < 0 || columnIndex < 0) return null;
    const frameRect = frame.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const cellRect = cell.getBoundingClientRect();
    return {
      row: {
        index: rowIndex,
        offset: rowRect.top - frameRect.top,
        size: rowRect.height,
      },
      column: {
        index: columnIndex,
        offset: cellRect.left - frameRect.left,
        size: cellRect.width,
      },
    };
  }, []);

  const cellFromElement = (target: Element | null): HTMLTableCellElement | null => {
    if (!target) return null;
    const cell = target.closest<HTMLTableCellElement>("td, th");
    return cell && tableRef.current?.contains(cell) ? cell : null;
  };

  const cellFromEvent = (event: React.SyntheticEvent): HTMLTableCellElement | null =>
    cellFromElement(event.target instanceof Element ? event.target : null);

  const onPointerMove = (event: React.PointerEvent) => {
    if (pointerDragRef.current) {
      movePointerDrag(event);
      return;
    }
    if (openMenu || dragRef.current) return;
    const cell = cellFromEvent(event);
    if (!cell) {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest(".doc-table-column-handle-slot, .doc-table-row-handle-slot")) {
        setHotAxis(null);
      }
      return;
    }
    const handles = targetFromCell(cell);
    if (!handles) return;
    setRowHandle(handles.row);
    setColumnHandle(handles.column);
    // Cell hover paints only the restrained boundary cue. The actual grip is
    // promoted when the pointer enters that cue's slot.
    setHotAxis(null);
  };

  const closeHover = () => {
    if (openMenu || dragRef.current) return;
    setRowHandle(null);
    setColumnHandle(null);
    setHotAxis(null);
  };

  const run = (command: TableCommand, target: TableTarget) => {
    runTableCommand(props.editor, props.getPos, props.node, command, target);
  };

  const setMenu = (axis: TableAxis, open: boolean, index: number) => {
    if (suppressClickRef.current) return;
    setOpenMenu(open ? axis : null);
    if (open) {
      setHotAxis(axis);
      selectTableAxis(props.editor, props.getPos, { axis, index });
    } else {
      setMenuQuery("");
    }
  };

  const setCurrentDropTarget = (target: DragTarget, handle: AxisHandle | null) => {
    dropTargetRef.current = target;
    setDropTarget(target);
    setDropHandle(handle);
  };

  const beginPointerDrag = (
    axis: TableAxis,
    index: number,
    event: React.PointerEvent<Element>,
  ) => {
    if (event.button !== 0) return;
    pointerDragRef.current = {
      source: { axis, index },
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Older embedded webviews can omit pointer capture. Their pointer events
      // still remain on the button for ordinary mouse drags.
    }
  };

  const movePointerDrag = (event: React.PointerEvent<Element>) => {
    const pending = pointerDragRef.current;
    if (!pending || pending.pointerId !== event.pointerId) return;
    if (!pending.dragging) {
      const distance = Math.hypot(
        event.clientX - pending.startX,
        event.clientY - pending.startY,
      );
      if (distance < DRAG_THRESHOLD_PX) return;
      pending.dragging = true;
      dragRef.current = pending.source;
      setHotAxis(pending.source.axis);
      setCurrentDropTarget(
        pending.source,
        pending.source.axis === "row" ? rowHandle : columnHandle,
      );
      selectTableAxis(props.editor, props.getPos, pending.source);
    }

    event.preventDefault();
    event.stopPropagation();
    const hit = document.elementFromPoint(event.clientX, event.clientY);
    const cell = cellFromElement(hit);
    if (!cell) return;
    const handles = targetFromCell(cell);
    if (!handles) return;
    const handle = pending.source.axis === "row" ? handles.row : handles.column;
    setCurrentDropTarget(
      { axis: pending.source.axis, index: handle.index },
      handle,
    );
  };

  const finishPointerDrag = (
    event: React.PointerEvent<Element>,
    cancelled = false,
  ) => {
    const pending = pointerDragRef.current;
    if (!pending || pending.pointerId !== event.pointerId) return;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // See the capture fallback above.
    }
    if (pending.dragging) {
      event.preventDefault();
      event.stopPropagation();
      const target = dropTargetRef.current;
      if (!cancelled && target?.axis === pending.source.axis) {
        moveTableAxis(
          props.editor,
          props.getPos,
          pending.source.axis,
          pending.source.index,
          target.index,
        );
      }
    } else if (!cancelled) {
      // Base UI normally opens on mousedown, which is too early to distinguish
      // a click from a drag. Open the controlled menu only after a true click.
      setMenu(
        pending.source.axis,
        openMenu !== pending.source.axis,
        pending.source.index,
      );
    }
    // Swallow the browser's synthetic click after pointerup. For a drag this
    // keeps the menu closed; for a click it prevents the just-opened menu from
    // being toggled closed again by the trigger.
    suppressClickRef.current = true;
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
    pointerDragRef.current = null;
    dragRef.current = null;
    setCurrentDropTarget(null, null);
    setHotAxis(null);
  };

  const handleAxisClick = (
    axis: TableAxis,
    index: number,
    event: React.MouseEvent<HTMLElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (suppressClickRef.current) return;
    setMenu(axis, openMenu !== axis, index);
  };

  const lastRow = Math.max(0, props.node.childCount - 1);
  const lastColumn = Math.max(0, (props.node.firstChild?.childCount ?? 1) - 1);
  const menuOpen = openMenu !== null;
  const headers = tableHeaderState(props.node);
  const selectedAxis = openMenu ?? dragRef.current?.axis ?? null;

  return (
    <NodeViewWrapper className="doc-table-block">
      <div
        ref={frameRef}
        className="doc-table-frame"
        data-menu-open={menuOpen ? "true" : undefined}
        data-selected-axis={selectedAxis ?? undefined}
        data-area-select-ignore
        onPointerMove={onPointerMove}
        onPointerUp={(event) => finishPointerDrag(event)}
        onPointerCancel={(event) => finishPointerDrag(event, true)}
        onPointerLeave={closeHover}
      >
        {columnHandle ? (
          <div
            className="doc-table-column-handle-slot"
            style={{ left: columnHandle.offset, width: columnHandle.size }}
            data-active={
              hotAxis === "column" || openMenu === "column" || dragRef.current?.axis === "column"
                ? "true"
                : undefined
            }
            contentEditable={false}
            onPointerEnter={() => setHotAxis("column")}
            onPointerLeave={() => {
              if (!openMenu && !dragRef.current) setHotAxis(null);
            }}
            onPointerDownCapture={(event) => {
              const target = event.target instanceof Element ? event.target : null;
              if (target?.closest('[data-table-axis="column"]')) {
                beginPointerDrag("column", columnHandle.index, event);
              }
            }}
            onPointerMove={movePointerDrag}
            onPointerUp={(event) => finishPointerDrag(event)}
            onPointerCancel={(event) => finishPointerDrag(event, true)}
            onMouseDownCapture={(event) => {
              const target = event.target instanceof Element ? event.target : null;
              if (!target?.closest('[data-table-axis="column"]')) return;
              // Base UI opens menus on mousedown. Holding this event lets the
              // pointer threshold decide whether this gesture is a click or a drag.
              event.preventDefault();
              event.stopPropagation();
            }}
            onClickCapture={(event) => {
              const target = event.target instanceof Element ? event.target : null;
              if (target?.closest('[data-table-axis="column"]')) {
                handleAxisClick("column", columnHandle.index, event);
              }
            }}
          >
            <span className="doc-table-axis-cue" aria-hidden />
            <DropdownMenu
              open={openMenu === "column"}
              onOpenChange={(open) => setMenu("column", open, columnHandle.index)}
            >
              <DropdownMenuTrigger
                render={
                  <button
                    type="button"
                    data-table-axis="column"
                    data-table-index={columnHandle.index}
                    data-drop-target={
                      dropTarget?.axis === "column" &&
                      dropTarget.index === columnHandle.index
                        ? "true"
                        : undefined
                    }
                    className="doc-table-axis-handle doc-table-column-handle"
                    aria-label={t.columnOptions}
                    title={t.moveColumn}
                  >
                    <GripHorizontal aria-hidden />
                  </button>
                }
              />
              <DropdownMenuContent
                side="top"
                align="center"
                className="doc-table-action-menu w-64"
              >
                <AxisMenuContent
                  axis="column"
                  headerEnabled={headers.column}
                  query={menuQuery}
                  onQueryChange={setMenuQuery}
                  onRun={(command) =>
                    run(command, { axis: "column", index: columnHandle.index })
                  }
                  t={t}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null}

        {rowHandle ? (
          <div
            className="doc-table-row-handle-slot"
            style={{ top: rowHandle.offset, height: rowHandle.size }}
            data-active={
              hotAxis === "row" || openMenu === "row" || dragRef.current?.axis === "row"
                ? "true"
                : undefined
            }
            contentEditable={false}
            onPointerEnter={() => setHotAxis("row")}
            onPointerLeave={() => {
              if (!openMenu && !dragRef.current) setHotAxis(null);
            }}
            onPointerDownCapture={(event) => {
              const target = event.target instanceof Element ? event.target : null;
              if (target?.closest('[data-table-axis="row"]')) {
                beginPointerDrag("row", rowHandle.index, event);
              }
            }}
            onPointerMove={movePointerDrag}
            onPointerUp={(event) => finishPointerDrag(event)}
            onPointerCancel={(event) => finishPointerDrag(event, true)}
            onMouseDownCapture={(event) => {
              const target = event.target instanceof Element ? event.target : null;
              if (!target?.closest('[data-table-axis="row"]')) return;
              event.preventDefault();
              event.stopPropagation();
            }}
            onClickCapture={(event) => {
              const target = event.target instanceof Element ? event.target : null;
              if (target?.closest('[data-table-axis="row"]')) {
                handleAxisClick("row", rowHandle.index, event);
              }
            }}
          >
            <span className="doc-table-axis-cue" aria-hidden />
            <DropdownMenu
              open={openMenu === "row"}
              onOpenChange={(open) => setMenu("row", open, rowHandle.index)}
            >
              <DropdownMenuTrigger
                render={
                  <button
                    type="button"
                    data-table-axis="row"
                    data-table-index={rowHandle.index}
                    data-drop-target={
                      dropTarget?.axis === "row" && dropTarget.index === rowHandle.index
                        ? "true"
                        : undefined
                    }
                    className="doc-table-axis-handle doc-table-row-handle"
                    aria-label={t.rowOptions}
                    title={t.moveRow}
                  >
                    <GripVertical aria-hidden />
                  </button>
                }
              />
              <DropdownMenuContent
                side="left"
                align="center"
                className="doc-table-action-menu w-64"
              >
                <AxisMenuContent
                  axis="row"
                  headerEnabled={headers.row}
                  query={menuQuery}
                  onQueryChange={setMenuQuery}
                  onRun={(command) =>
                    run(command, { axis: "row", index: rowHandle.index })
                  }
                  t={t}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null}

        <table ref={tableRef} className="doc-table">
          <NodeViewContent as="tbody" />
        </table>

        {dropTarget && dropHandle ? (
          <div
            className={`doc-table-drop-indicator doc-table-drop-indicator-${dropTarget.axis}`}
            style={
              dropTarget.axis === "row"
                ? { top: dropHandle.offset, height: dropHandle.size }
                : { left: dropHandle.offset, width: dropHandle.size }
            }
            contentEditable={false}
            aria-hidden
          />
        ) : null}

        <button
          type="button"
          tabIndex={-1}
          className="doc-table-add-rail doc-table-add-column"
          contentEditable={false}
          aria-label={t.addColumn}
          title={t.addColumn}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            run("addColumnAfter", { axis: "column", index: lastColumn });
          }}
        >
          <Plus aria-hidden />
        </button>
        <button
          type="button"
          tabIndex={-1}
          className="doc-table-add-rail doc-table-add-row"
          contentEditable={false}
          aria-label={t.addRow}
          title={t.addRow}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            run("addRowAfter", { axis: "row", index: lastRow });
          }}
        >
          <Plus aria-hidden />
        </button>
      </div>
    </NodeViewWrapper>
  );
}
