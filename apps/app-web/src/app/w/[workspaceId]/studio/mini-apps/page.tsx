"use client";

/**
 * Studio → Mini apps — which operator apps show on Home, and in what order.
 *
 * This tab existed once (deleted 2026-07-23) as a card gallery over the
 * dormant `MINI_APPS` shared registry. It returns doing a **different job**:
 * it is a configurator over the operator-app registry, writing
 * `workspaces.home_apps` (migration 385). The old registry is not reused and
 * not touched.
 *
 * Config is workspace-wide (D1): one strip, set by an owner/admin, seen by
 * every member. Per-user overrides are deferred.
 *
 * Four behaviours worth stating, because each is a decision rather than a
 * default:
 *
 *   - **Save on change**, no Save button (the workspace-sections precedent).
 *     A toggle that needs confirming reads as a form; this is a preference.
 *     The optimistic flip reverts if the write fails.
 *   - **Disabling is not removing** (T11). Routes stay reachable, so a
 *     bookmark, a notification deep link, or a home-dock card into a hidden
 *     app all keep working. The note under the grid says so, because "hidden"
 *     otherwise reads as "gone".
 *   - **Hiding the app you are standing in** asks first, via `confirmDialog` —
 *     the strip entry disappearing under the user is exactly the moment a
 *     silent save feels like a bug.
 *   - **Order is the array**, dragged here. `home_apps` renders in stored
 *     order end to end (nothing downstream sorts it), so the shown apps are a
 *     sortable list rather than a grid, and the hidden ones sit below it —
 *     position only means something for an app that is actually on the strip.
 *     Turning an app on therefore **appends**; re-inserting it at its registry
 *     slot would shove aside a position the admin had chosen.
 *
 * The catch this layout solves: the strip lives in the sidebar under Home and
 * renders NOTHING outside the operator family, so an admin standing in Studio
 * cannot see the thing they are configuring. `HomeStripPreview` mirrors it
 * here, and updates on every drag-over rather than on drop — the order is a
 * visual property, so the feedback has to be visual and has to arrive before
 * the commit.
 *
 * Spec: docs/architecture/features/home-apps.md.
 * [COMP:app-web/studio-mini-apps]
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, usePathname } from "next/navigation";
import {
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Home, type LucideIcon } from "lucide-react";
import { useT, format } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { Tooltip } from "@/components/ui/tooltip";
import { APP_ICON } from "@/components/doc/operator-app-bar";
import { CustomAppsSection } from "@/components/studio/custom-apps-section";
import {
  HOME_APPS_MAX,
  isBuiltinHomeAppKey,
  OPERATOR_APP_KEYS,
  homeAppFromPathname,
  reorderHomeApps,
  type HomeAppEntry,
  type OperatorAppKey,
} from "@/lib/operator-apps";
import { surfaceFromPathname } from "@/lib/doc-page-url";
import {
  getWorkspaceHomeApps,
  getWorkspaceRole,
  setWorkspaceHomeApps,
} from "@/lib/api/workspaces";

export default function StudioMiniAppsPage() {
  const params = useParams<{ workspaceId: string }>();
  const workspaceId = params?.workspaceId ?? "";
  const pathname = usePathname();
  const t = useT();
  const copy = t.studioPage.miniAppsPage;
  const appLabels = t.operatorBar;

  const [homeApps, setHomeApps] = useState<HomeAppEntry[] | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /**
   * The in-flight drag, as (what is moving, what it is hovering). Held rather
   * than mutating the list mid-drag: dnd-kit already animates the row
   * displacement, and re-seeding the array under it makes the drop jumpy. The
   * preview strip is the one thing that needs the hypothetical order, so it
   * derives it and the list is left alone.
   */
  const [drag, setDrag] = useState<{
    active: OperatorAppKey;
    over: OperatorAppKey;
  } | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    void getWorkspaceHomeApps(workspaceId).then((apps) => {
      if (!cancelled) setHomeApps(apps);
    });
    void getWorkspaceRole(workspaceId).then((role) => {
      // A failed probe resolves to `null` → read-only. Never grant an
      // affordance the server would refuse.
      if (!cancelled) setCanEdit(role === "owner" || role === "admin");
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  /** The shown built-ins, in strip order — this is what the list sorts. */
  const shown = useMemo(
    () => (homeApps ?? []).filter(isBuiltinHomeAppKey),
    [homeApps],
  );
  /**
   * Everything in the config array this page does not sort — `custom:<id>`
   * entries, whose icon and label are workspace data owned by
   * `CustomAppsSection` below. Carried through every write verbatim so a save
   * from this tab can never drop one.
   */
  const extras = useMemo(
    () => (homeApps ?? []).filter((entry) => !isBuiltinHomeAppKey(entry)),
    [homeApps],
  );
  const enabled = useMemo(() => new Set(shown), [shown]);
  /** Off the strip, listed in registry order — they have no position yet. */
  const hidden = useMemo(
    () => OPERATOR_APP_KEYS.filter((key) => !enabled.has(key)),
    [enabled],
  );

  /** The app the user is standing in right now, if any. */
  const activeApp = homeAppFromPathname(surfaceFromPathname(pathname), pathname);

  // Mouse drag (4px activation so a plain click on the grip doesn't start a
  // drag) + keyboard reorder (arrow keys move a focused grip) — the same
  // sensor pair the property menu and the page-block list use, so the grip is
  // operable without a pointer.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const persist = useCallback(
    async (next: HomeAppEntry[], previous: HomeAppEntry[]) => {
      setSaving(true);
      setError(null);
      setHomeApps(next); // optimistic — a preference should feel instant
      try {
        setHomeApps(await setWorkspaceHomeApps(workspaceId, next));
      } catch {
        setHomeApps(previous); // the strip must never claim a state the server refused
        setError(copy.saveFailed);
      } finally {
        setSaving(false);
      }
    },
    [copy.saveFailed, workspaceId],
  );

  const toggle = useCallback(
    async (key: OperatorAppKey) => {
      if (!homeApps || !canEdit || saving) return;
      const on = enabled.has(key);

      if (on) {
        if (enabled.size <= 1) {
          setError(copy.atLeastOne);
          return;
        }
        if (key === activeApp) {
          const ok = await confirmDialog({
            title: copy.leavingTitle,
            description: format(copy.leavingBody, { name: appLabels[key] }),
            confirmLabel: copy.leavingConfirm,
            variant: "destructive",
          });
          if (!ok) return;
        }
        await persist(
          homeApps.filter((entry) => entry !== key),
          homeApps,
        );
        return;
      }

      if (homeApps.length >= HOME_APPS_MAX) {
        setError(format(copy.atMost, { max: HOME_APPS_MAX }));
        return;
      }
      // APPEND, not registry-slot insert: order is the admin's now, so
      // slotting a re-enabled app back into the middle would move apps they
      // had positioned. It lands at the end of the strip, where they can drag
      // it wherever they meant.
      await persist([...shown, key, ...extras], homeApps);
    },
    [
      activeApp,
      appLabels,
      canEdit,
      copy,
      enabled,
      extras,
      homeApps,
      persist,
      saving,
      shown,
    ],
  );

  /** Where the strip would land if the drag ended now — the live preview. */
  const previewOrder = useMemo(
    () => (drag ? reorderHomeApps(shown, drag.active, drag.over) : shown),
    [drag, shown],
  );

  const onDragStart = useCallback((event: DragStartEvent) => {
    const key = String(event.active.id) as OperatorAppKey;
    setDrag({ active: key, over: key });
  }, []);

  const onDragOver = useCallback((event: DragOverEvent) => {
    const over = event.over?.id;
    if (over === undefined) return;
    setDrag((current) =>
      current ? { ...current, over: String(over) as OperatorAppKey } : current,
    );
  }, []);

  const onDragEnd = useCallback(
    async (event: DragEndEvent) => {
      setDrag(null);
      const { active, over } = event;
      if (!homeApps || !over || active.id === over.id) return;
      const next = reorderHomeApps(
        shown,
        String(active.id) as OperatorAppKey,
        String(over.id) as OperatorAppKey,
      );
      await persist([...next, ...extras], homeApps);
    },
    [extras, homeApps, persist, shown],
  );

  const busy = !canEdit || homeApps === null || saving;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <p className="text-sm text-muted-foreground">{copy.intro}</p>

      <p className="mt-4 text-xs font-medium text-muted-foreground tabular-nums">
        {format(copy.counter, {
          count: homeApps?.length ?? 0,
          max: HOME_APPS_MAX,
        })}
      </p>

      {!canEdit && (
        <p className="mt-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          {copy.readOnlyNote}
        </p>
      )}
      {error && (
        <p className="mt-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}

      <HomeStripPreview
        title={copy.previewTitle}
        homeLabel={t.docPage.iconHome}
        order={previewOrder}
        moving={drag?.active ?? null}
        labels={appLabels}
      />

      {homeApps === null ? (
        <ul className="mt-4 flex flex-col gap-2" aria-hidden>
          {OPERATOR_APP_KEYS.map((key) => (
            <li key={key} className="h-[46px] animate-pulse rounded-lg bg-muted" />
          ))}
        </ul>
      ) : (
        <>
          <p className="mt-5 text-xs font-medium text-foreground">
            {copy.onHomeHeading}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{copy.reorderHint}</p>

          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDragCancel={() => setDrag(null)}
            onDragEnd={(event) => void onDragEnd(event)}
          >
            <SortableContext items={shown} strategy={verticalListSortingStrategy}>
              <ul className="mt-2 flex flex-col gap-2">
                {shown.map((key) => (
                  <SortableAppRow
                    key={key}
                    appKey={key}
                    label={appLabels[key]}
                    dragLabel={format(copy.dragAria, { name: appLabels[key] })}
                    toggleLabel={format(copy.toggleAria, {
                      name: appLabels[key],
                    })}
                    disabled={busy}
                    onToggle={() => void toggle(key)}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>

          {hidden.length > 0 && (
            <>
              <p className="mt-5 text-xs font-medium text-muted-foreground">
                {copy.hiddenHeading}
              </p>
              <ul className="mt-2 flex flex-col gap-2">
                {hidden.map((key) => (
                  <HiddenAppRow
                    key={key}
                    appKey={key}
                    label={appLabels[key]}
                    toggleLabel={format(copy.toggleAria, {
                      name: appLabels[key],
                    })}
                    disabled={busy}
                    onToggle={() => void toggle(key)}
                  />
                ))}
              </ul>
            </>
          )}
        </>
      )}

      <p className="mt-4 text-xs text-muted-foreground">{copy.routesStayNote}</p>

      <CustomAppsSection workspaceId={workspaceId} canEdit={canEdit} />
    </div>
  );
}

/**
 * The Home dock as it will render, mirroring `OperatorAppBar` deliberately
 * closely — the sidebar chrome tokens (`bg-sidebar`, `doc-nav-active`), the
 * 28px icon squares, the `pl-4` indent under the Home pill. The point is
 * recognition: an admin should see the actual thing, not an abstraction of it,
 * because the strip is unreachable from Studio (the bar renders nothing off
 * the operator family) and icon order is exactly the kind of change you cannot
 * evaluate from a list of names.
 *
 * `moving` highlights the app under the cursor so the eye can follow it
 * through the drag.
 */
function HomeStripPreview({
  title,
  homeLabel,
  order,
  moving,
  labels,
}: {
  title: string;
  homeLabel: string;
  order: readonly OperatorAppKey[];
  moving: OperatorAppKey | null;
  labels: Record<OperatorAppKey, string>;
}) {
  return (
    <div className="mt-4 overflow-hidden rounded-lg border border-border">
      <p className="border-b border-border bg-muted/40 px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
        {title}
      </p>
      <div className="bg-sidebar px-2 py-2 text-sidebar-foreground">
        {/* The Home pill, so the strip below reads as its children the way it
            does in the sidebar. Inert: this is a picture, not a nav. */}
        <div className="flex flex-row items-center gap-0.5 pb-1.5">
          <span className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md doc-nav-active px-2 text-[13px] font-medium text-sidebar-accent-foreground">
            <Home className="size-[17px] shrink-0" aria-hidden />
            {homeLabel}
          </span>
        </div>
        <div
          role="group"
          aria-label={title}
          className="flex flex-row items-center gap-0.5 pl-4 pr-2"
        >
          {order.map((key) => {
            const Icon: LucideIcon = APP_ICON[key];
            const isMoving = key === moving;
            return (
              <Tooltip key={key} label={labels[key]}>
                <span
                  role="img"
                  aria-label={labels[key]}
                  className={cn(
                    "flex size-7 shrink-0 items-center justify-center rounded-md transition-colors",
                    isMoving && "doc-nav-active",
                  )}
                >
                  <Icon
                    className={cn(
                      "size-4 shrink-0",
                      isMoving ? "text-primary" : "text-sidebar-foreground/55",
                    )}
                    strokeWidth={1.8}
                    aria-hidden
                  />
                </span>
              </Tooltip>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * One shown app: grip, icon, name, switch. Only the grip carries the sortable
 * listeners, so the switch stays a plain click target and a click on the row
 * does nothing (the whole card was the switch before ordering existed — a
 * card that both drags and toggles is a card that does the wrong one).
 */
function SortableAppRow({
  appKey,
  label,
  dragLabel,
  toggleLabel,
  disabled,
  onToggle,
}: {
  appKey: OperatorAppKey;
  label: string;
  dragLabel: string;
  toggleLabel: string;
  disabled: boolean;
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
  } = useSortable({ id: appKey, disabled });
  const Icon: LucideIcon = APP_ICON[appKey];

  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        zIndex: isDragging ? 1 : undefined,
      }}
      data-app={appKey}
      className="flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 px-2 py-2.5"
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        data-action="reorder"
        aria-label={dragLabel}
        disabled={disabled}
        className="flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/60 hover:bg-border hover:text-foreground active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-3.5" aria-hidden />
      </button>
      <Icon className="size-4 shrink-0 text-primary" strokeWidth={1.8} aria-hidden />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
      <AppSwitch on label={toggleLabel} disabled={disabled} onToggle={onToggle} />
    </li>
  );
}

/** One hidden app. No grip: position means nothing until it is on the strip. */
function HiddenAppRow({
  appKey,
  label,
  toggleLabel,
  disabled,
  onToggle,
}: {
  appKey: OperatorAppKey;
  label: string;
  toggleLabel: string;
  disabled: boolean;
  onToggle: () => void;
}) {
  const Icon: LucideIcon = APP_ICON[appKey];
  return (
    <li
      data-app={appKey}
      className="flex items-center gap-2 rounded-lg border border-border bg-background px-2 py-2.5"
    >
      {/* Keeps the icon and name on the same x as the sortable rows above. */}
      <span className="size-6 shrink-0" aria-hidden />
      <Icon
        className="size-4 shrink-0 text-muted-foreground"
        strokeWidth={1.8}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-muted-foreground">
        {label}
      </span>
      <AppSwitch
        on={false}
        label={toggleLabel}
        disabled={disabled}
        onToggle={onToggle}
      />
    </li>
  );
}

function AppSwitch({
  on,
  label,
  disabled,
  onToggle,
}: {
  on: boolean;
  label: string;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      data-action="toggle-app"
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "relative h-4 w-7 shrink-0 rounded-full transition-colors",
        on ? "bg-primary" : "bg-muted-foreground/30",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute top-0.5 size-3 rounded-full bg-background transition-all",
          on ? "left-3.5" : "left-0.5",
        )}
      />
    </button>
  );
}
