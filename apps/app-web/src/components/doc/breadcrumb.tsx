"use client";

/**
 * The page top-bar breadcrumb — Notion's "location" trail.
 *
 * Two shapes, by depth:
 *  - **Root-level page** (no ancestors) → the page *is* the root, so we show
 *    only the page itself (its icon + name). No workspace crumb, no chain.
 *  - **Nested page** (≥1 ancestor) → the full Notion trail
 *    **workspace / ancestor / … / current page**, `/`-separated, with an icon
 *    on every crumb. The leading crumb carries the workspace's team avatar +
 *    name (→ workspace home); intermediate crumbs navigate to that ancestor;
 *    the trailing crumb is the current page. Below `sm` the workspace +
 *    ancestors collapse away, leaving just the current crumb.
 *
 * The **current crumb is the page's rename affordance**: when `onRenameCurrent`
 * is wired (it is, from `PageHeader`), clicking it opens a **Notion-style
 * inline edit popover** anchored under the crumb — the page icon + an
 * autofocused, all-selected text field that commits on Enter or click-away
 * and cancels on Escape (no modal dialog). So the title in the chrome is
 * click-to-rename, and the ⋯ menu carries no redundant "Rename" item. Without
 * the prop the current crumb is a plain non-interactive label.
 *
 * The chain is derived from the page's `nest_parent_id` links client-side
 * (`buildBreadcrumb`); the URL stays the flat `/p/<pageId>` at any depth, so
 * the breadcrumb is a pure view over the tree — deep links never break when a
 * page is re-parented. Each crumb renders its own icon (emoji, else the
 * type-derived glyph). Untitled pages fall back to a localized placeholder.
 *
 * [COMP:app-web/breadcrumb]
 */

import { type ReactNode, useEffect, useRef, useState } from "react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { derivePageIcon } from "@/lib/api/views";
import type { Crumb } from "@/lib/sidebar-tree";
import { useT } from "@/lib/i18n/client";
import { TeamAvatar } from "@/components/team-avatar";
import { useWorkspaceContext } from "@/lib/workspace-context";

type BreadcrumbProps = {
  /** Full chain root → … → active (from `buildBreadcrumb`). */
  crumbs: Crumb[];
  /** Navigate to a page id, or to the workspace home with `null`. */
  onNavigate: (viewId: string | null) => void;
  /**
   * Commit a new name for the current (trailing) page. When provided, the
   * current crumb becomes a click-to-rename trigger that opens an inline edit
   * popover and calls this with the trimmed value on commit; omitted → plain
   * non-interactive label.
   */
  onRenameCurrent?: (name: string) => void;
};

export function Breadcrumb({ crumbs, onNavigate, onRenameCurrent }: BreadcrumbProps) {
  const t = useT().docPage;
  const ws = useWorkspaceContext();
  const label = (name: string) => (name.trim() ? name : t.breadcrumbUntitled);

  if (crumbs.length === 0) return null;
  const current = crumbs[crumbs.length - 1];
  const ancestors = crumbs.slice(0, -1);

  // Root-level page: the page is the root — just show it, no workspace/chain.
  if (ancestors.length === 0) {
    return (
      <nav
        aria-label="Breadcrumb"
        className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-foreground"
      >
        <CurrentCrumb crumb={current} label={label} onRename={onRenameCurrent} t={t} />
      </nav>
    );
  }

  // Nested page: workspace / ancestor / … / current — icons on each crumb.
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground"
    >
      <button
        type="button"
        onClick={() => onNavigate(null)}
        aria-label={t.breadcrumbHomeAria}
        className="hidden shrink-0 items-center gap-1.5 rounded px-1 py-0.5 hover:bg-muted hover:text-foreground sm:flex"
      >
        <span className="grid size-[18px] place-items-center [&_svg]:size-[18px]">
          <TeamAvatar id={ws.workspaceId} name={ws.name} size="sm" />
        </span>
        <span className="max-w-[140px] truncate">{ws.name}</span>
      </button>

      {ancestors.map((crumb) => (
        <span key={crumb.id} className="hidden min-w-0 items-center gap-1 sm:flex">
          <Separator t={t} />
          <button
            type="button"
            onClick={() => onNavigate(crumb.id)}
            title={label(crumb.name)}
            className="flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 hover:bg-muted hover:text-foreground"
          >
            <CrumbIcon crumb={crumb} />
            <span className="max-w-[140px] truncate">{label(crumb.name)}</span>
          </button>
        </span>
      ))}

      <span className="hidden sm:inline">
        <Separator t={t} />
      </span>
      <CurrentCrumb crumb={current} label={label} onRename={onRenameCurrent} t={t} />
    </nav>
  );
}

/**
 * The trailing (current-page) crumb. Without `onRename` it's a plain
 * non-interactive label. With `onRename` it's a click-to-rename trigger that
 * opens a Notion-style inline edit popover (icon + autofocused, all-selected
 * text field). The field commits the trimmed value on Enter or click-away and
 * discards on Escape — base-ui reports the close `reason`, so escape cancels
 * while every other close path commits. The trigger keeps the same icon + name
 * as a plain crumb, so it reads identically apart from the hover/click target.
 */
function CurrentCrumb({
  crumb,
  label,
  onRename,
  t,
}: {
  crumb: Crumb;
  label: (name: string) => string;
  onRename?: (name: string) => void;
  t: ReturnType<typeof useT>["docPage"];
}) {
  const inner = (
    <>
      <CrumbIcon crumb={crumb} />
      <span className="min-w-0 truncate">{label(crumb.name)}</span>
    </>
  );

  if (!onRename) {
    return (
      <span className="flex min-w-0 items-center gap-1.5 px-1 py-0.5 font-medium text-foreground">
        {inner}
      </span>
    );
  }

  return <RenamePopover crumb={crumb} inner={inner} onRename={onRename} t={t} />;
}

/**
 * The inline rename popover for the current crumb. Controlled-open base-ui
 * Popover so we can seed the field from the live name on each open and decide
 * commit-vs-cancel from the close reason. Enter commits then closes; Escape
 * (base-ui, `reason === "escape-key"`) discards; outside-press / focus-out
 * commit. A blank or unchanged value is a no-op commit.
 */
function RenamePopover({
  crumb,
  inner,
  onRename,
  t,
}: {
  crumb: Crumb;
  inner: ReactNode;
  onRename: (name: string) => void;
  t: ReturnType<typeof useT>["docPage"];
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(crumb.name);
  const inputRef = useRef<HTMLInputElement>(null);
  // Guards `onRename` to fire at most once per open session. Enter commits
  // then closes directly; a controlled close doesn't re-fire base-ui's
  // `onOpenChange`, but this keeps "one rename per edit" true by construction
  // regardless of base-ui's close semantics — reset on each open.
  const committedRef = useRef(false);

  // Focus + select-all once the field is mounted, so the whole name is ready
  // to overwrite (Notion behavior). Client-only; SSR renders just the trigger.
  useEffect(() => {
    if (!open) return;
    const el = inputRef.current;
    if (!el) return;
    const id = window.setTimeout(() => {
      el.focus();
      el.select();
    }, 0);
    return () => window.clearTimeout(id);
  }, [open]);

  function commit() {
    if (committedRef.current) return;
    const value = draft.trim();
    if (value && value !== crumb.name) {
      committedRef.current = true;
      onRename(value);
    }
  }

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next, details) => {
        if (next) {
          setDraft(crumb.name); // seed from the live name on every open
          committedRef.current = false;
          setOpen(true);
          return;
        }
        // Closed by base-ui (outside-press, focus-out, escape). Escape discards;
        // every other close path commits, matching Notion's click-away-saves.
        if (details.reason !== "escape-key") commit();
        setOpen(false);
      }}
    >
      <PopoverPrimitive.Trigger
        render={
          <button
            type="button"
            title={t.breadcrumbRenameHint}
            aria-label={t.breadcrumbRenameHint}
            className="flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 font-medium text-foreground hover:bg-muted aria-expanded:bg-muted"
          >
            {inner}
          </button>
        }
      />
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner side="bottom" align="start" sideOffset={6} className="isolate z-50">
          <PopoverPrimitive.Popup
            data-slot="breadcrumb-rename"
            className="flex items-center gap-2 rounded-lg bg-popover px-2.5 py-2 text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
          >
            <span className="grid size-6 shrink-0 place-items-center text-[15px] leading-none">
              <CrumbIcon crumb={crumb} />
            </span>
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commit();
                  setOpen(false);
                }
              }}
              placeholder={t.breadcrumbUntitled}
              aria-label={t.breadcrumbRenameHint}
              spellCheck={false}
              className="w-64 max-w-[60vw] border-0 bg-transparent p-0 text-sm font-medium text-foreground outline-none placeholder:text-muted-foreground/50"
            />
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/** A crumb's leading icon: the emoji if set, else the type-derived glyph. */
function CrumbIcon({ crumb }: { crumb: Crumb }) {
  if (crumb.icon) {
    return (
      <span className="shrink-0 text-[15px] leading-none">{crumb.icon}</span>
    );
  }
  const Glyph = derivePageIcon({
    entity: crumb.entity,
    viewType: crumb.viewType,
    nameOrigin: crumb.nameOrigin,
  });
  return <Glyph className="size-4 shrink-0 text-muted-foreground" aria-hidden />;
}

function Separator({ t }: { t: ReturnType<typeof useT>["docPage"] }) {
  return (
    <span aria-hidden className="shrink-0 select-none text-muted-foreground/50">
      {t.breadcrumbSeparator}
    </span>
  );
}
