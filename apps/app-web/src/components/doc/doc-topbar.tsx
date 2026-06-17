"use client";

/**
 * The Doc top "layer" — Notion's upper top-bar row, above the breadcrumb.
 *
 *   [ ☰ ] [ ‹ ] [ › ]   ⚽ Goals ✕   📄 Untitled ✕   ＋
 *    │      │     │      └──────────── open-tab strip ──────────┘
 *    │      └─ back / forward through the ACTIVE tab's browse history
 *    └─ collapse / expand the left sidebar (desktop)
 *
 * Persistent chrome: rendered on every Doc state (loaded page, blank
 * tab, empty selection, error) so the sidebar toggle, history arrows, and
 * tab strip never disappear. The second row — the location breadcrumb +
 * action cluster — is the separate `PageHeader`, shown only when a page is
 * loaded.
 *
 * All state lives in `doc-shell.tsx` (the `doc-tabs` reducer + the
 * sidebar-collapse flag); this component is presentational and raises intent
 * callbacks, so it SSR-renders for tests with no router/jsdom.
 *
 * Mobile: the sidebar toggle is hidden (the shell's fixed hamburger drives
 * the drawer there); a leading spacer keeps the strip clear of it. The
 * history arrows + tab strip stay, the strip scrolling horizontally.
 *
 * [COMP:app-web/doc-topbar]
 */

import {
  ChevronLeft,
  ChevronRight,
  FileText,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Sparkles,
  X,
} from "lucide-react";
import {
  derivePageIcon,
  type NameOrigin,
  type ViewEntity,
  type ViewType,
} from "@/lib/api/views";
import { useT } from "@/lib/i18n/client";

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
  /** The page the tab shows, or `null` for a blank "new tab". */
  pageId: string | null;
  isActive: boolean;
  /** Page name; `null` for a blank tab or an as-yet-untitled page. */
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
  tabs: TabView[];
  canBack: boolean;
  canForward: boolean;
  /** Desktop sidebar collapse state — flips the toggle glyph + aria-label. */
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onBack: () => void;
  onForward: () => void;
  onSwitchTab: (key: string) => void;
  onCloseTab: (key: string) => void;
  onNewTab: () => void;
};

export function DocTopBar({
  tabs,
  canBack,
  canForward,
  sidebarCollapsed,
  onToggleSidebar,
  onBack,
  onForward,
  onSwitchTab,
  onCloseTab,
  onNewTab,
}: DocTopBarProps) {
  const t = useT().docPage;

  return (
    <div
      data-doc-chrome
      data-doc-topbar
      className="flex h-11 shrink-0 items-center gap-0.5 border-b border-sidebar-border bg-sidebar pr-2 pl-1"
    >
      {/* Sidebar collapse / expand — desktop only. Mobile drives the drawer
          from the shell's fixed hamburger, so this hides and a spacer keeps
          the strip clear of that floating button. */}
      <button
        type="button"
        onClick={onToggleSidebar}
        aria-label={
          sidebarCollapsed ? t.topbarSidebarExpandAria : t.topbarSidebarCollapseAria
        }
        title={
          sidebarCollapsed ? t.topbarSidebarExpandAria : t.topbarSidebarCollapseAria
        }
        className="hidden size-7 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground md:inline-flex"
      >
        {sidebarCollapsed ? (
          <PanelLeftOpen className="size-4" aria-hidden />
        ) : (
          <PanelLeftClose className="size-4" aria-hidden />
        )}
      </button>
      <div className="w-12 shrink-0 md:hidden" aria-hidden />

      {/* Browse history — back / forward through the active tab. */}
      <button
        type="button"
        onClick={onBack}
        disabled={!canBack}
        aria-label={t.topbarBackAria}
        title={t.topbarBackAria}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-35"
      >
        <ChevronLeft className="size-4" aria-hidden />
      </button>
      <button
        type="button"
        onClick={onForward}
        disabled={!canForward}
        aria-label={t.topbarForwardAria}
        title={t.topbarForwardAria}
        className="mr-1 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-35"
      >
        <ChevronRight className="size-4" aria-hidden />
      </button>

      {/* Open-tab strip — tabs are BOTTOM-aligned and full-bar-height so the
          active tab can merge into the page below. `items-end self-stretch`
          drops them to the bar's baseline; no `overflow-x` (which would
          vertically clip the active tab's 1px merge overhang) — tabs shrink +
          fade their title instead of scrolling. */}
      <div className="flex min-w-0 flex-1 items-end self-stretch gap-1">
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
        <button
          type="button"
          onClick={onNewTab}
          aria-label={t.topbarNewTabAria}
          title={t.topbarNewTabAria}
          className="ml-0.5 inline-flex size-7 shrink-0 items-center justify-center self-center rounded-md text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          <Plus className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}

/** A single tab chip: leading icon, label, and a hover-revealed close ✕. */
function TabChip({
  tab,
  closable,
  onSwitch,
  onClose,
  untitledLabel,
  newTabLabel,
  closeAria,
}: {
  tab: TabView;
  closable: boolean;
  onSwitch: () => void;
  onClose: () => void;
  untitledLabel: string;
  newTabLabel: string;
  closeAria: string;
}) {
  const label = tab.pageId
    ? tab.title?.trim() || untitledLabel
    : newTabLabel;

  return (
    <div
      // In the desktop shell the whole top bar is an OS window-drag handle; a tab
      // chip must stay clickable (switch / close), so it opts out of the drag.
      data-no-drag
      className={[
        // Every tab is the SAME fixed width (`w-[200px]`) regardless of title
        // length — short and long names get identical chips, the title fades at
        // the edge via TITLE_FADE_MASK. `min-w-0` + default flex-shrink lets
        // them compress equally (staying uniform) when the strip gets crowded.
        "group/tab flex h-9 w-[200px] min-w-0 items-center gap-1.5 rounded-t-lg pl-3 pr-1.5 text-sm",
        tab.isActive
          ? // White tab with a top/side outline and NO bottom — pulled down 1px
            // (`-mb-px`) so it covers the bar's `border-b` and its white floor
            // flows into the white page row below: the tab "merges" downward.
            "relative z-10 -mb-px border border-b-0 border-sidebar-border bg-background font-medium text-foreground"
          : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      ].join(" ")}
    >
      <span className="grid size-4 shrink-0 place-items-center text-[14px] leading-none">
        <TabIcon tab={tab} />
      </span>
      <button
        type="button"
        onClick={onSwitch}
        title={label}
        className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-left"
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
            "grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100",
            tab.isActive ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100",
          ].join(" ")}
        >
          <X className="size-3.5" aria-hidden />
        </button>
      )}
    </div>
  );
}

/** A tab's leading icon: emoji if set, the AI sparkle for the blank
 *  "Suggested for you" home, the type glyph for a page, else a generic doc
 *  glyph for a page whose type hasn't resolved yet. */
function TabIcon({ tab }: { tab: TabView }) {
  if (tab.icon) return <span aria-hidden>{tab.icon}</span>;
  // A pageless tab is the Suggested-for-you home → the AI sparkle (palette
  // primary), matching the sidebar entry.
  if (!tab.pageId) {
    return <Sparkles className="size-4 text-primary" aria-hidden />;
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
