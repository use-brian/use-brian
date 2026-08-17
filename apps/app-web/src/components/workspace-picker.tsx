"use client";

/**
 * Thresholded workspace picker shared by the Next full-page picker and the
 * bundled desktop shell. Five or fewer workspaces keep the original cards;
 * six or more get searchable, preference-backed sections.
 *
 * [COMP:app-web/workspace-picker]
 */

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  Eye,
  EyeOff,
  MoreHorizontal,
  Pin,
  PinOff,
  Search,
} from "lucide-react";
import { TeamAvatar } from "@/components/team-avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { routeProgress } from "@/lib/route-progress";
import {
  organizeWorkspacePicker,
  usesScalableWorkspacePicker,
  type WorkspacePickerItem,
} from "@/lib/workspace-picker";
import {
  updateWorkspacePickerPreferences,
  type WorkspacePickerPreferencePatch,
  type WorkspacePickerPreferenceState,
} from "@/lib/api/workspaces";

export function WorkspacePicker({
  initialWorkspaces,
  next = "",
  apiUrl,
}: {
  initialWorkspaces: WorkspacePickerItem[];
  next?: string;
  apiUrl?: string;
}) {
  const t = useT().teams;
  const [workspaces, setWorkspaces] = useState(initialWorkspaces);
  const [query, setQuery] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scalable = usesScalableWorkspacePicker(workspaces.length);
  const groups = useMemo(
    () => organizeWorkspacePicker(workspaces, query),
    [workspaces, query],
  );
  const hiddenTotal = workspaces.filter(
    (workspace) => !!workspace.pickerHiddenAt,
  ).length;

  function workspaceHref(workspaceId: string): string {
    return `/w/${workspaceId}${next}`;
  }

  function markOpened(workspaceId: string) {
    const now = new Date().toISOString();
    setWorkspaces((current) =>
      current.map((workspace) =>
        workspace.id === workspaceId
          ? { ...workspace, pickerLastOpenedAt: now }
          : workspace,
      ),
    );
    void updateWorkspacePickerPreferences(
      workspaceId,
      { opened: true },
      apiUrl,
    ).catch(() => {
      // Navigation must not be blocked by a non-critical recency write.
    });
    routeProgress.start();
  }

  async function updatePreference(
    workspaceId: string,
    patch: WorkspacePickerPreferencePatch,
  ) {
    if (pendingId) return;
    const previous = workspaces;
    const now = new Date().toISOString();
    setPendingId(workspaceId);
    setError(null);
    setWorkspaces((current) =>
      current.map((workspace) => {
        if (workspace.id !== workspaceId) return workspace;
        if (patch.pinned !== undefined) {
          return {
            ...workspace,
            pickerPinnedAt: patch.pinned ? now : null,
            pickerHiddenAt: patch.pinned ? null : workspace.pickerHiddenAt,
          };
        }
        if (patch.hidden !== undefined) {
          return {
            ...workspace,
            pickerHiddenAt: patch.hidden ? now : null,
            pickerPinnedAt: patch.hidden ? null : workspace.pickerPinnedAt,
          };
        }
        return workspace;
      }),
    );

    try {
      const persisted = await updateWorkspacePickerPreferences(
        workspaceId,
        patch,
        apiUrl,
      );
      setWorkspaces((current) =>
        mergePreferenceState(current, workspaceId, persisted),
      );
    } catch {
      setWorkspaces(previous);
      setError(t.updateError);
    } finally {
      setPendingId(null);
    }
  }

  if (!scalable) {
    return (
      <ul className="space-y-2 animate-stagger">
        {workspaces.map((workspace) => (
          <li key={workspace.id}>
            <Link
              href={workspaceHref(workspace.id)}
              onClick={() => markOpened(workspace.id)}
              className="group flex items-center justify-between rounded-xl border border-border bg-card px-4 py-3.5 transition-all duration-200 hover:border-primary/40 hover:bg-accent active:bg-accent/80 hover-lift"
            >
              <div className="space-y-0.5">
                <div className="text-sm font-medium">{workspace.name}</div>
                {workspace.role ? (
                  <div className="text-xs text-muted-foreground capitalize">
                    {workspace.role}
                  </div>
                ) : null}
              </div>
              <span
                aria-hidden
                className="text-muted-foreground transition-all duration-200 group-hover:text-primary group-hover:translate-x-0.5"
              >
                →
              </span>
            </Link>
          </li>
        ))}
      </ul>
    );
  }

  const hasVisibleMatches =
    groups.pinned.length + groups.recent.length + groups.all.length > 0;

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card/95 shadow-sm backdrop-blur">
      <div className="border-b border-border p-3">
        <label className="relative block">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <span className="sr-only">{t.searchLabel}</span>
          <input
            autoFocus
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t.searchPlaceholder}
            className="h-10 w-full rounded-xl border border-border bg-background pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground"
          />
        </label>
        {error ? (
          <p className="px-1 pt-2 text-xs text-destructive">{error}</p>
        ) : null}
      </div>

      <div className="max-h-[min(64vh,640px)] overflow-y-auto p-2">
        <WorkspaceSection
          title={t.pinned}
          rows={groups.pinned}
          pendingId={pendingId}
          hrefFor={workspaceHref}
          onOpened={markOpened}
          onPreference={updatePreference}
        />
        <WorkspaceSection
          title={t.recent}
          rows={groups.recent}
          pendingId={pendingId}
          hrefFor={workspaceHref}
          onOpened={markOpened}
          onPreference={updatePreference}
        />
        <WorkspaceSection
          title={format(t.allWorkspaces, { count: groups.allCount })}
          rows={groups.all}
          pendingId={pendingId}
          hrefFor={workspaceHref}
          onOpened={markOpened}
          onPreference={updatePreference}
        />

        {!hasVisibleMatches && (!showHidden || groups.hidden.length === 0) ? (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">
            {t.noMatches}
          </p>
        ) : null}

        {hiddenTotal > 0 ? (
          <div className="mt-1 border-t border-border pt-1">
            <button
              type="button"
              onClick={() => setShowHidden((current) => !current)}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-expanded={showHidden}
            >
              {showHidden ? (
                <EyeOff aria-hidden className="size-3.5" />
              ) : (
                <Eye aria-hidden className="size-3.5" />
              )}
              <span>
                {format(t.hidden, {
                  count: hiddenTotal,
                })}
              </span>
            </button>
            {showHidden ? (
              groups.hidden.length > 0 ? (
                <WorkspaceSection
                  rows={groups.hidden}
                  pendingId={pendingId}
                  hrefFor={workspaceHref}
                  onOpened={markOpened}
                  onPreference={updatePreference}
                  hidden
                />
              ) : (
                <p className="px-3 py-4 text-sm text-muted-foreground">
                  {t.noMatches}
                </p>
              )
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function mergePreferenceState(
  workspaces: WorkspacePickerItem[],
  workspaceId: string,
  state: WorkspacePickerPreferenceState,
): WorkspacePickerItem[] {
  return workspaces.map((workspace) =>
    workspace.id === workspaceId ? { ...workspace, ...state } : workspace,
  );
}

function WorkspaceSection({
  title,
  rows,
  pendingId,
  hrefFor,
  onOpened,
  onPreference,
  hidden = false,
}: {
  title?: string;
  rows: WorkspacePickerItem[];
  pendingId: string | null;
  hrefFor: (workspaceId: string) => string;
  onOpened: (workspaceId: string) => void;
  onPreference: (
    workspaceId: string,
    patch: WorkspacePickerPreferencePatch,
  ) => void;
  hidden?: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <section className="mb-2 last:mb-0">
      {title ? (
        <h2 className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h2>
      ) : null}
      <ul className="space-y-0.5">
        {rows.map((workspace) => (
          <WorkspacePickerRow
            key={workspace.id}
            workspace={workspace}
            href={hrefFor(workspace.id)}
            pending={pendingId === workspace.id}
            onOpened={() => onOpened(workspace.id)}
            onPreference={(patch) => onPreference(workspace.id, patch)}
            hidden={hidden}
          />
        ))}
      </ul>
    </section>
  );
}

function WorkspacePickerRow({
  workspace,
  href,
  pending,
  onOpened,
  onPreference,
  hidden,
}: {
  workspace: WorkspacePickerItem;
  href: string;
  pending: boolean;
  onOpened: () => void;
  onPreference: (patch: WorkspacePickerPreferencePatch) => void;
  hidden: boolean;
}) {
  const t = useT().teams;
  return (
    <li className="group flex min-w-0 items-center rounded-xl transition-colors hover:bg-accent">
      <Link
        href={href}
        onClick={onOpened}
        className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5"
      >
        <TeamAvatar
          id={workspace.id}
          name={workspace.name}
          iconSeed={workspace.iconSeed}
          iconUrl={workspace.iconUrl}
          size="sm"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">
            {workspace.name}
          </span>
          {workspace.role ? (
            <span className="block text-xs capitalize text-muted-foreground">
              {workspace.role}
            </span>
          ) : null}
        </span>
      </Link>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              disabled={pending}
              aria-label={format(t.workspaceActions, { name: workspace.name })}
              className="mr-2 inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground opacity-70 transition-colors hover:bg-muted hover:text-foreground focus:opacity-100 disabled:cursor-wait disabled:opacity-40 group-hover:opacity-100"
            >
              <MoreHorizontal aria-hidden className="size-4" />
            </button>
          }
        />
        <DropdownMenuContent align="end">
          {hidden ? (
            <DropdownMenuItem onClick={() => onPreference({ hidden: false })}>
              <Eye aria-hidden />
              {t.restore}
            </DropdownMenuItem>
          ) : (
            <>
              <DropdownMenuItem
                onClick={() =>
                  onPreference({ pinned: !workspace.pickerPinnedAt })
                }
              >
                {workspace.pickerPinnedAt ? (
                  <PinOff aria-hidden />
                ) : (
                  <Pin aria-hidden />
                )}
                {workspace.pickerPinnedAt ? t.unpin : t.pin}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onPreference({ hidden: true })}>
                <EyeOff aria-hidden />
                {t.hideFromList}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
