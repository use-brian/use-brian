"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { WorkspaceTopbar } from "@/components/chrome/workspace-topbar";

/** Page tabs inside the shared workspace top bar. Active-tab browse history,
 * switching, closing, title fading and phone overflow remain presentational
 * callbacks owned by doc-shell. The workspace rail owns sidebar collapse.
 * Spec: docs/architecture/features/workspace-navigation.md → "Shared top bar".
 * [COMP:app-web/doc-topbar] */

import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileText,
  Plus,
  PanelsTopLeft,
  Sparkles,
  Target,
  X,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  derivePageIcon,
  type NameOrigin,
  type ViewEntity,
  type ViewType,
} from "@/lib/api/views";
import { PageIcon } from "./page-icon";
import { type PanelId } from "@/lib/doc-page-url";
import { format, useT } from "@/lib/i18n/client";

/** Label chips the phone strip keeps before collapsing into the tabs menu. */
export const PHONE_TAB_CHIPS = 1;

/**
 * The phone strip's collapse rule (pure). Up to `max` tabs render as label
 * chips; past that only the ACTIVE tab keeps a chip and every tab (the active
 * one included, so the list reads as the full set) moves into the menu.
 */
export function collapseTabStrip<T extends { isActive: boolean }>(
  tabs: readonly T[],
  max = PHONE_TAB_CHIPS,
): { chips: T[]; menu: T[] } {
  if (tabs.length <= max) return { chips: [...tabs], menu: [] };
  const active = tabs.find((tab) => tab.isActive) ?? tabs[0];
  return { chips: active ? [active] : [], menu: [...tabs] };
}

/** Permanent right-edge mist on every tab title: the tail dissolves into the
 *  tab over its last ~1.75rem so the text softens toward the edge instead of
 *  butting hard against the close ✕ / tab boundary — and a too-long name fades
 *  out cleanly rather than hard-clipping. Anchored at the label's right edge,
 *  so a short title that doesn't reach the edge is left untouched. */
const TITLE_FADE_MASK =
  "linear-gradient(to right, #000 calc(100% - 1.75rem), transparent)";

/** One open tab, resolved to its display label/icon by `doc-shell.tsx`. */
export type TabView = {
  key: string;
  /** The page the tab shows, or `null` for a blank "new tab" OR a panel tab. */
  pageId: string | null;
  /** A panel tab (Approvals / Autopilot) — its own fixed label + glyph, no
   *  page. Mutually exclusive with a non-null `pageId`. */
  panel?: PanelId;
  isActive: boolean;
  /** Page/panel name; `null` for a blank tab or an as-yet-untitled page. */
  title: string | null;
  /** Emoji icon, or `null` to fall back to the type-derived glyph. */
  icon: string | null;
  /** For the `derivePageIcon` fallback when `icon` is null + `pageId` set. */
  entity?: ViewEntity;
  viewType?: ViewType;
  /** Title provenance — a `'placeholder'` tab shows the generic draft glyph. */
  nameOrigin?: NameOrigin;
};

type DocTopBarProps = {
  pageHeader?: ReactNode;
  tabs: TabView[];
  canBack: boolean;
  canForward: boolean;
  /** Sidebar state for native title-bar clearance; the rail owns its toggle. */
  sidebarCollapsed: boolean;
  onBack: () => void;
  onForward: () => void;
  onSwitchTab: (key: string) => void;
  onCloseTab: (key: string) => void;
  onNewTab: () => void;
};

export function DocTopBar({
  pageHeader,
  tabs,
  canBack,
  canForward,
  sidebarCollapsed,
  onBack,
  onForward,
  onSwitchTab,
  onCloseTab,
  onNewTab,
}: DocTopBarProps) {
  const copy = useT();
  const t = copy.docPage;
  const appIdentity = <div data-workspace-app-identity className="flex min-w-0 items-center gap-2"><FileText className="size-4 shrink-0" aria-hidden /><span className="truncate">{copy.operatorBar.page}</span></div>;

  return (
    <WorkspaceTopbar identity={appIdentity} sidebarCollapsed={sidebarCollapsed} history={{ onBack, onForward, canBack, canForward }}
      className={pageHeader ? "h-auto flex-wrap gap-y-0 border-b-0 md:h-10 md:flex-nowrap [&>[data-workspace-search-slot]]:order-2 md:[&>[data-workspace-search-slot]]:order-3" : undefined}>
      {pageHeader && <div data-doc-page-toolbar className="order-3 w-full min-w-0 md:order-1 md:w-auto md:flex-1">{pageHeader}</div>}
      {/* A loaded desktop Page uses the tabs menu; blank/panel states keep
          the strip. New tab stays beside the tabs in either presentation. */}
      <div data-doc-tabs className={cn("flex min-w-0 flex-1 items-center self-stretch gap-1", pageHeader && "order-1 md:order-2 md:flex-none md:border-l md:border-border/60 md:pl-1")}>
        {/* Desktop strip: one chip per tab. */}
        <div className={cn("hidden min-w-0 items-end gap-1 self-stretch", !pageHeader && "md:flex")}>
          {tabs.map((tab) => (
            <TabChip
              key={tab.key}
              tab={tab}
              closable={tabs.length > 1}
              onSwitch={() => onSwitchTab(tab.key)}
              onClose={() => onCloseTab(tab.key)}
              untitledLabel={t.breadcrumbUntitled}
              newTabLabel={t.topbarNewTabLabel}
              closeAria={t.topbarCloseTabAria}
            />
          ))}
        </div>
        {/* Phone strip: label chips up to PHONE_TAB_CHIPS, then the active chip
            + an "N tabs" menu (responsive contract M8). */}
        <PhoneTabStrip
          desktopMenu={!!pageHeader}
          history={{ onBack, onForward, canBack, canForward }}
          tabs={tabs}
          onSwitchTab={onSwitchTab}
          onCloseTab={onCloseTab}
          untitledLabel={t.breadcrumbUntitled}
          newTabLabel={t.topbarNewTabLabel}
          closeAria={t.topbarCloseTabAria}
          menuLabel={format(t.topbarTabsMenu, { count: tabs.length })}
          menuAria={t.topbarTabsMenuAria}
        />
        <button
          type="button"
          onClick={onNewTab}
          aria-label={t.topbarNewTabAria}
          title={t.topbarNewTabAria}
          className="ml-0.5 inline-flex size-11 shrink-0 items-center justify-center self-center rounded-md text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground md:size-7"
        >
          <Plus className="size-4" aria-hidden />
        </button>
      </div>
    </WorkspaceTopbar>
  );
}

/** Resolve a tab's display label (panel label, page title, or the blank-tab name). */
function tabLabel(tab: TabView, untitledLabel: string, newTabLabel: string): string {
  return tab.panel
    ? (tab.title ?? "")
    : tab.pageId
      ? tab.title?.trim() || untitledLabel
      : newTabLabel;
}

/**
 * Phone tab chips with a menu for history and every open tab. Loaded desktop
 * Pages reuse only the menu, leaving room for location and actions in one row.
 * CSS handles the breakpoint without remounting page controls.
 */
function PhoneTabStrip({
  desktopMenu = false,
  history,
  tabs,
  onSwitchTab,
  onCloseTab,
  untitledLabel,
  newTabLabel,
  closeAria,
  menuLabel,
  menuAria,
}: {
  desktopMenu?: boolean;
  history: { onBack: () => void; onForward: () => void; canBack: boolean; canForward: boolean };
  tabs: TabView[];
  onSwitchTab: (key: string) => void;
  onCloseTab: (key: string) => void;
  untitledLabel: string;
  newTabLabel: string;
  closeAria: string;
  menuLabel: string;
  menuAria: string;
}) {
  const t = useT().docPage;
  const { chips, menu } = collapseTabStrip(tabs);
  return (
    <div
      data-doc-tab-strip="phone"
      className={cn("flex min-w-0 flex-1 items-center gap-1 self-stretch", !desktopMenu && "md:hidden")}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1 md:hidden">
        {chips.map((tab) => (
          <TabChip
            key={tab.key}
            tab={tab}
            compact
            closable={tabs.length > 1}
            onSwitch={() => onSwitchTab(tab.key)}
            onClose={() => onCloseTab(tab.key)}
            untitledLabel={untitledLabel}
            newTabLabel={newTabLabel}
            closeAria={closeAria}
          />
        ))}
      </div>
      {(
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                data-no-drag
                data-doc-tabs-menu
                aria-label={menuAria}
                title={menuAria}
                className="inline-flex h-11 min-w-11 shrink-0 items-center justify-center gap-1 self-center rounded-md px-2 md:h-7 md:min-w-7 text-sm font-medium text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground aria-expanded:bg-sidebar-accent"
              >
                <span className="sr-only">{menuLabel}</span>
                {desktopMenu && <PanelsTopLeft className="hidden size-4 md:block" aria-hidden />}
                {desktopMenu && tabs.length > 1 && <span className="hidden text-xs md:inline" aria-hidden>{tabs.length}</span>}
                <ChevronDown className={cn("size-4", desktopMenu && "md:hidden")} aria-hidden />
              </button>
            }
          />
          <DropdownMenuContent align="end" className="w-[min(20rem,calc(100vw-1rem))]">
            <DropdownMenuItem disabled={!history.canBack} onClick={history.onBack} className="min-h-8 max-md:min-h-11 gap-2"><ChevronLeft className="size-4" aria-hidden />{t.topbarBackAria}</DropdownMenuItem>
            <DropdownMenuItem disabled={!history.canForward} onClick={history.onForward} className="min-h-8 max-md:min-h-11 gap-2"><ChevronRight className="size-4" aria-hidden />{t.topbarForwardAria}</DropdownMenuItem>
            <div role="separator" className="my-1 border-t border-border" />
            {(menu.length ? menu : tabs).map((tab) => (
              <DropdownMenuItem
                key={tab.key}
                className="min-h-8 max-sm:min-h-11 gap-2"
                onClick={() => onSwitchTab(tab.key)}
              >
                <span className="grid size-4 shrink-0 place-items-center text-[14px] leading-none">
                  <TabIcon tab={tab} />
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {tabLabel(tab, untitledLabel, newTabLabel)}
                </span>
                {tab.isActive ? (
                  <Check className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                ) : null}
                {tabs.length > 1 ? (
                  <button
                    type="button"
                    aria-label={closeAria}
                    title={closeAria}
                    onClick={(e) => {
                      // A row click switches; the ✕ inside it closes instead.
                      e.stopPropagation();
                      onCloseTab(tab.key);
                    }}
                    className="grid size-11 shrink-0 place-items-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                  >
                    <X className="size-3.5" aria-hidden />
                  </button>
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

/** A single tab chip: leading icon, label, and a hover-revealed close ✕. */
function TabChip({
  tab,
  closable,
  compact = false,
  onSwitch,
  onClose,
  untitledLabel,
  newTabLabel,
  closeAria,
}: {
  tab: TabView;
  closable: boolean;
  /** Phone-strip sizing: share the row instead of the fixed 200px width. */
  compact?: boolean;
  onSwitch: () => void;
  onClose: () => void;
  untitledLabel: string;
  newTabLabel: string;
  closeAria: string;
}) {
  const label = tabLabel(tab, untitledLabel, newTabLabel);

  return (
    <div
      // In the desktop shell the whole top bar is an OS window-drag handle; a tab
      // chip must stay clickable (switch / close), so it opts out of the drag.
      data-no-drag
      data-doc-tab
      data-active={tab.isActive ? "true" : "false"}
      className={[
        // Every desktop tab is the SAME fixed width (`w-[200px]`) regardless of
        // title length — short and long names get identical chips, the title
        // fades at the edge via TITLE_FADE_MASK. `min-w-0` + default flex-shrink
        // lets them compress equally (staying uniform) when the strip gets
        // crowded. The phone chip shares the row instead (`flex-1`), capped so a
        // lone active chip does not stretch across the whole bar.
        compact
          ? "group/tab flex h-11 md:h-8 min-w-0 flex-1 basis-0 max-w-[14rem] items-center gap-1.5 rounded-lg pl-2.5 pr-1 text-sm"
          : "group/tab flex h-11 md:h-[34px] w-[200px] min-w-0 items-center gap-1.5 rounded-lg md:rounded-b-none pl-3 pr-1.5 text-sm",
        "ring-1 ring-inset ring-border",
        tab.isActive
          ? "bg-background font-medium text-foreground"
          : "bg-foreground/5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground",
      ].join(" ")}
    >
      <span className="grid size-4 shrink-0 place-items-center text-[14px] leading-none">
        <TabIcon tab={tab} />
      </span>
      <button
        type="button"
        onClick={onSwitch}
        aria-current={tab.isActive ? "page" : undefined}
        title={label}
        className="min-w-0 flex-1 self-stretch overflow-hidden whitespace-nowrap text-left"
        style={{ maskImage: TITLE_FADE_MASK, WebkitMaskImage: TITLE_FADE_MASK }}
      >
        {label}
      </button>
      {closable && (
        <button
          type="button"
          aria-label={closeAria}
          title={closeAria}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className={[
            // 44px on a phone, the
            // desktop 20px glyph from `md`. An INACTIVE tab's ✕ is dimmed on
            // touch rather than hidden (responsive contract M2: the hover
            // reveal stays behind `md:`), so it is always tappable.
            "grid size-11 shrink-0 place-items-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 md:size-5",
            tab.isActive
              ? "opacity-100"
              : "opacity-60 md:opacity-0 md:group-hover/tab:opacity-100",
          ].join(" ")}
        >
          <X className="size-3.5" aria-hidden />
        </button>
      )}
    </div>
  );
}

/** A tab's leading icon: the panel glyph for Approvals / Autopilot, an emoji if
 *  set, the AI sparkle for the blank "Suggested for you" home, the type glyph
 *  for a page, else a generic doc glyph for a page whose type hasn't resolved. */
function TabIcon({ tab }: { tab: TabView }) {
  // Panel tabs carry a fixed glyph (they have no page metadata / emoji).
  if (tab.panel === "approvals") {
    return <CheckCircle2 className="size-4 text-rose-500" aria-hidden />;
  }
  if (tab.panel === "goals") {
    return <Target className="size-4 text-violet-500" aria-hidden />;
  }
  if (tab.icon) {
    const Fallback = FileText;
    return (
      <PageIcon
        icon={tab.icon}
        fallback={Fallback}
        glyphClassName="size-4 text-muted-foreground"
        imgClassName="size-4 rounded-[3px] object-cover"
      />
    );
  }
  // A pageless tab is the Suggested-for-you home → the AI sparkle (palette
  // primary), matching the sidebar entry.
  if (!tab.pageId) {
    return <Sparkles className="size-4 text-muted-foreground" aria-hidden />;
  }
  // A page whose type metadata hasn't resolved yet → generic doc glyph.
  if (!tab.entity || !tab.viewType) {
    return <FileText className="size-4 text-muted-foreground" aria-hidden />;
  }
  const Glyph = derivePageIcon({
    entity: tab.entity,
    viewType: tab.viewType,
    nameOrigin: tab.nameOrigin,
  });
  return <Glyph className="size-4 text-muted-foreground" aria-hidden />;
}
