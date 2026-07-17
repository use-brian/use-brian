"use client";

// [COMP:app-web/view-config-property-toggle-menu]
/**
 * Phase 3 — Property toggle / reorder menu.
 *
 * The "Properties" affordance — shows the column directory with two
 * controls per row: a **drag handle** (the ⋮⋮ grip — controls `order`
 * via dnd-kit sortable) and a **visibility toggle** (the eye — controls
 * `visibleProperties`). Dragging a row reorders the property; the same
 * sensor pair the page-block list uses (`PointerSensor` for mouse/touch
 * + `KeyboardSensor` for arrow-key reorder) makes the grip operable
 * without a pointer, so the dnd-kit graduation keeps the keyboard a11y
 * the old move-up/move-down button-pair had.
 *
 * Stateless wrt the larger app: `visibleProperties` and `order` are
 * controlled props, and `onChange(visibleProperties, order)` fires on
 * every commit. Both arrays carry property `field` names (the stable
 * key — `header` is i18n-mutable).
 *
 * SSR-safe: the popover starts closed, so the `<DndContext>` only mounts
 * after a client-side open — the closed-state SSR test never renders it.
 */

import {
  useEffect,
  useRef,
  useState,
} from "react";
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Columns, Eye, EyeOff, GripVertical } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import type { A2UIColumn } from "@use-brian/views-renderer";

export type PropertyToggleMenuProps = {
  columns: readonly A2UIColumn[];
  /** Currently visible property fields. */
  visibleProperties: readonly string[];
  /** Current order — every column appears exactly once. */
  order: readonly string[];
  /** Fires when the user toggles visibility or reorders. */
  onChange: (visibleProperties: string[], order: string[]) => void;
  className?: string;
};

export function PropertyToggleMenu({
  columns,
  visibleProperties,
  order,
  onChange,
  className,
}: PropertyToggleMenuProps) {
  const t = useT().docPage.viewToolbar;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Mouse drag (4px activation so a plain click on the grip doesn't start
  // a drag) + keyboard reorder (arrow keys move a focused grip) — the same
  // sensor pair the page-block list and Board use.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Outside click → close
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (typeof document !== "undefined") {
      document.addEventListener("mousedown", onDocClick);
      return () => document.removeEventListener("mousedown", onDocClick);
    }
    return undefined;
  }, [open]);

  // Esc → close
  useEffect(() => {
    if (!open) return;
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    if (typeof document !== "undefined") {
      document.addEventListener("keydown", onKey);
      return () => document.removeEventListener("keydown", onKey);
    }
    return undefined;
  }, [open]);

  const visibleSet = new Set(visibleProperties);
  const orderedColumns = order
    .map((field) => columns.find((c) => c.field === field))
    .filter((c): c is A2UIColumn => c !== undefined);

  const handleToggle = (field: string) => {
    const next = visibleSet.has(field)
      ? visibleProperties.filter((f) => f !== field)
      : [...visibleProperties, field];
    onChange(next, [...order]);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    // Operate on the canonical `order` array — every rendered grip's id is
    // a field that lives in `order`, so the indices are always valid.
    const from = order.indexOf(String(active.id));
    const to = order.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    onChange([...visibleProperties], arrayMove([...order], from, to));
  };

  const handleShowAll = () => {
    onChange(
      columns.map((c) => c.field),
      [...order],
    );
  };

  const handleHideAll = () => {
    onChange([], [...order]);
  };

  return (
    <div className={"relative " + (className ?? "")} ref={ref}>
      <button
        type="button"
        data-action="open-properties"
        aria-label={t.propertiesButtonAria}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Columns className="h-3.5 w-3.5" aria-hidden />
        <span>{t.propertiesButton}</span>
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label={t.propertiesButton}
          data-popover="properties"
          className="absolute right-0 top-full z-40 mt-1 w-72 rounded-md border border-border bg-popover p-2 text-sm shadow-lg"
        >
          <div className="flex items-center justify-between gap-1 border-b border-border pb-1.5">
            <button
              type="button"
              data-action="show-all"
              onClick={handleShowAll}
              className="h-6 rounded px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {t.propertiesShowAll}
            </button>
            <button
              type="button"
              data-action="hide-all"
              onClick={handleHideAll}
              className="h-6 rounded px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {t.propertiesHideAll}
            </button>
          </div>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={orderedColumns.map((c) => c.field)}
              strategy={verticalListSortingStrategy}
            >
              <ul className="mt-1 max-h-72 overflow-y-auto">
                {orderedColumns.map((col) => (
                  <SortablePropertyRow
                    key={col.field}
                    col={col}
                    visible={visibleSet.has(col.field)}
                    dragLabel={format(t.propertyDragAria, { name: col.header })}
                    toggleLabel={format(t.propertyVisibleAria, {
                      name: col.header,
                    })}
                    onToggle={() => handleToggle(col.field)}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        </div>
      ) : null}
    </div>
  );
}

/**
 * One draggable property row. The grip (⋮⋮) is the drag activator — only
 * it carries the sortable `listeners`, so the visibility toggle stays a
 * plain click target. `setNodeRef` lifts the whole `<li>` during a drag.
 */
function SortablePropertyRow({
  col,
  visible,
  dragLabel,
  toggleLabel,
  onToggle,
}: {
  col: A2UIColumn;
  visible: boolean;
  dragLabel: string;
  toggleLabel: string;
  onToggle: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: col.field });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 1 : undefined,
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      data-row="property"
      data-property={col.field}
      className="group flex items-center gap-1 rounded px-1 py-1 hover:bg-muted"
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        data-action="reorder"
        aria-label={dragLabel}
        className="flex h-5 w-5 flex-shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/60 hover:bg-border hover:text-foreground active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-3.5 w-3.5" aria-hidden />
      </button>
      <span className="flex-1 truncate text-sm">{col.header}</span>
      <button
        type="button"
        data-action="toggle-visible"
        aria-label={toggleLabel}
        aria-pressed={visible}
        onClick={onToggle}
        className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-border hover:text-foreground"
      >
        {visible ? (
          <Eye className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <EyeOff className="h-3.5 w-3.5 opacity-50" aria-hidden />
        )}
      </button>
    </li>
  );
}
