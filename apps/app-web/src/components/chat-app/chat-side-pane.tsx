"use client";

/**
 * The Chat side pane (chat-parity D4-D8): one right-hand pane that holds
 * tabs and stays with each chat. It replaces both the raw-document split
 * view and the standalone Work Bench rail.
 *
 * - **Tab strip:** the fixed **Work** tab first (Live work, Stop, worker
 *   runs, pins; never closed, the default), then pinned tabs, then open
 *   tabs. Each tab keeps its own Back / Forward history.
 * - **State:** the tabs, the active tab and whether the pane is open live in
 *   the per-chat store (`lib/chat-pane-session.ts`), never in this component
 *   or the surface, so they survive surface switches. Nothing collapses the
 *   pane automatically; only the close control here does (D8).
 * - **Layout:** a resizable split section beside the transcript on desktop
 *   (`usePeekResize`, key `chat:side-pane-width`); a full-screen overlay
 *   below `sm` (T11), opened from the header's tab-count button.
 *
 * The host renders the bodies it owns (`renderTab`: Work, and the kinds
 * later phases add); this component renders the `document` and `file`
 * bodies itself.
 * - **Pins (D7):** with `pins`, a pinnable tab offers Pin / Unpin. A pinned
 *   tab is a `session_pins` row: it shows a pin glyph and has no close
 *   control (unpin it first), and every client of the chat shows it.
 *
 * Spec: docs/architecture/features/chat-app.md -> "Side pane".
 *
 * [COMP:app-web/chat-side-pane]
 */

import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  FileText,
  Globe,
  Monitor,
  NotebookText,
  Paperclip,
  Pin,
  PinOff,
  X,
} from "lucide-react";
import { format, useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import {
  PeekResizeHandle,
  usePeekResize,
} from "@/components/operator/resizable-peek";
import { FilePreviewBody } from "@/components/doc/file-preview";
import type { ChatPane } from "@/lib/chat-pane-session";
import type { ChatPanePins } from "@/lib/use-chat-pane-pins";
import {
  activeTab,
  canGoBackInTab,
  canGoForwardInTab,
  tabRef,
  WORK_TAB_KEY,
  type PaneRef,
  type PaneTab,
} from "@/lib/chat-pane-tabs";
import { docPagePath } from "@/lib/doc-page-url";
import { ChatDocumentBody } from "./chat-document-viewer";
import { PanePageBody, PaneUrlBody } from "./chat-pane-bodies";
import { PaneBrowserBody } from "./chat-pane-browser";

const CHAT_SIDE_PANE_ID = "chat-side-pane";

/** A tab's visible label. */
function paneTabLabel(
  ref: PaneRef,
  t: { work: string; untitledPage: string; browser: string },
): string {
  switch (ref.kind) {
    case "work":
      return t.work;
    case "document":
      return ref.document.title;
    case "file":
      return ref.name;
    case "page":
      return ref.title?.trim() || t.untitledPage;
    case "url":
      return ref.title?.trim() || hostOf(ref.url);
    case "browser":
      return ref.title?.trim() || (ref.url ? hostOf(ref.url) : t.browser);
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function TabIcon({ kind }: { kind: PaneRef["kind"] }) {
  const cls = "size-3.5 shrink-0";
  switch (kind) {
    case "work":
      return <Activity className={cls} aria-hidden />;
    case "document":
      return <FileText className={cls} aria-hidden />;
    case "file":
      return <Paperclip className={cls} aria-hidden />;
    case "page":
      return <NotebookText className={cls} aria-hidden />;
    case "url":
      return <Globe className={cls} aria-hidden />;
    case "browser":
      return <Monitor className={cls} aria-hidden />;
  }
}

export function ChatSidePane({
  workspaceId,
  chatKey,
  pane,
  renderTab,
  tabActions,
  pins = null,
}: {
  workspaceId: string;
  /** The open chat: a desktop browser slot reports it so the shell swaps tabs (T7). */
  chatKey: string | null;
  pane: ChatPane;
  /**
   * The host's bodies: the Work tab, and any kind it owns. Returning
   * `undefined` falls back to the built-in `document` / `file` bodies.
   */
  renderTab: (ref: PaneRef, tab: PaneTab) => ReactNode | undefined;
  /** Extra per-tab actions (pin, open full page, open in browser, detach). */
  tabActions?: (ref: PaneRef, tab: PaneTab) => ReactNode;
  /** Pinned tabs (D7); null where this chat cannot pin. */
  pins?: ChatPanePins | null;
}) {
  const t = useT().chatApp.sidePane;
  const router = useRouter();
  const { width, resizing, handleProps } = usePeekResize("chat:side-pane-width");
  const { state } = pane;
  if (!state.open) return null;
  const current = activeTab(state);
  const ref = tabRef(current);
  const hostBody = renderTab(ref, current);
  const body =
    hostBody !== undefined ? hostBody : ref.kind === "document" ? (
      <ChatDocumentBody document={ref.document} />
    ) : ref.kind === "file" ? (
      <FilePreviewBody
        workspaceId={workspaceId}
        name={ref.name}
        mime={ref.mime}
        fileId={ref.fileId}
        dataUrl={ref.dataUrl ?? null}
        source={ref.source ?? "cache"}
      />
    ) : ref.kind === "page" ? (
      <PanePageBody key={ref.pageId} pageId={ref.pageId} />
    ) : ref.kind === "url" ? (
      <PaneUrlBody key={ref.url} url={ref.url} title={ref.title ?? null} />
    ) : ref.kind === "browser" ? (
      <PaneBrowserBody
        key={ref.browserId}
        workspaceId={workspaceId}
        chatKey={chatKey}
        browserId={ref.browserId}
        url={ref.url ?? null}
      />
    ) : null;
  // The explicit ways out of the pane (D9): a page's full view, a link in
  // the user's browser. Nothing else in the chat navigates away.
  const builtinAction =
    ref.kind === "page" ? (
      <button
        type="button"
        onClick={() => router.push(docPagePath(workspaceId, ref.pageId))}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground sm:min-h-7"
      >
        <ExternalLink className="size-3.5" aria-hidden />
        {t.openFullPage}
      </button>
    ) : ref.kind === "url" ? (
      <a
        href={ref.url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground sm:min-h-7"
      >
        <ExternalLink className="size-3.5" aria-hidden />
        {t.openInBrowser}
      </a>
    ) : null;
  const pinAction =
    pins && current.key !== WORK_TAB_KEY && pins.pinnable(current) ? (
      <>
        {pins.failedKey === current.key && (
          <span role="status" className="px-1 text-xs text-destructive">
            {current.pinId ? t.unpinFailed : t.pinFailed}
          </span>
        )}
        <button
          type="button"
          onClick={() => pins.toggle(current)}
          aria-pressed={!!current.pinId}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground sm:min-h-7"
        >
          {current.pinId ? <PinOff className="size-3.5" aria-hidden /> : <Pin className="size-3.5" aria-hidden />}
          {current.pinId ? t.unpinTab : t.pinTab}
        </button>
      </>
    ) : null;
  const historyNav = current.key !== WORK_TAB_KEY && (canGoBackInTab(current) || canGoForwardInTab(current));

  return (
    <aside
      id={CHAT_SIDE_PANE_ID}
      aria-label={t.label}
      style={width !== null ? { width } : undefined}
      className={cn(
        "relative flex h-full max-w-full shrink-0 flex-col overflow-hidden border-l border-border bg-background",
        width === null && "w-full sm:w-[380px] lg:w-[440px]",
        // Below `sm` the pane is a full-screen OVERLAY, never a flex sibling
        // that would squeeze the transcript to nothing (T11, responsive M5).
        "max-sm:absolute max-sm:inset-0 max-sm:z-20 max-sm:!w-full max-sm:border-l-0",
        !resizing && "transition-[width] duration-200 ease-out",
        resizing && "select-none",
      )}
    >
      <PeekResizeHandle resizing={resizing} {...handleProps} />

      <header className="flex shrink-0 items-center gap-1 border-b border-border/70 py-1.5 pl-2 pr-1.5">
        <div
          role="tablist"
          aria-label={t.tabs}
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]"
        >
          {state.tabs.map((tab) => {
            const tabValue = tabRef(tab);
            const label = paneTabLabel(tabValue, t);
            const active = tab.key === state.activeKey;
            return (
              <div
                key={tab.key}
                className={cn(
                  "group/tab flex min-w-0 max-w-44 shrink-0 items-center rounded-md text-xs transition-colors",
                  active
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-controls={`${CHAT_SIDE_PANE_ID}-body`}
                  data-pane-tab={tab.key}
                  onClick={() => pane.activate(tab.key)}
                  title={label}
                  className="flex min-h-11 min-w-0 items-center gap-1.5 px-2 sm:min-h-8"
                >
                  <TabIcon kind={tabValue.kind} />
                  <span className="truncate">{label}</span>
                  {tab.pinId && (
                    <>
                      <Pin className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="sr-only">{t.pinned}</span>
                    </>
                  )}
                </button>
                {tab.key !== WORK_TAB_KEY && !tab.pinId && (
                  <button
                    type="button"
                    onClick={() => pane.close(tab.key)}
                    aria-label={format(t.closeTab, { title: label })}
                    title={format(t.closeTab, { title: label })}
                    className="mr-0.5 grid size-11 shrink-0 place-items-center rounded text-muted-foreground opacity-100 hover:bg-background hover:text-foreground sm:size-6 md:opacity-0 md:group-hover/tab:opacity-100 md:focus-visible:opacity-100"
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => pane.setOpen(false)}
          aria-label={t.closePane}
          title={t.closePane}
          aria-controls={CHAT_SIDE_PANE_ID}
          className="grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:size-8"
        >
          <X className="size-4" aria-hidden />
        </button>
      </header>

      {(historyNav || tabActions || builtinAction || pinAction) && current.key !== WORK_TAB_KEY && (
        <div className="flex shrink-0 items-center gap-1 border-b border-border/70 px-2 py-1">
          {historyNav && (
            <>
              <button
                type="button"
                onClick={() => pane.step(-1)}
                disabled={!canGoBackInTab(current)}
                aria-label={t.back}
                title={t.back}
                className="grid size-11 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 sm:size-7"
              >
                <ArrowLeft className="size-3.5" aria-hidden />
              </button>
              <button
                type="button"
                onClick={() => pane.step(1)}
                disabled={!canGoForwardInTab(current)}
                aria-label={t.forward}
                title={t.forward}
                className="grid size-11 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 sm:size-7"
              >
                <ArrowRight className="size-3.5" aria-hidden />
              </button>
            </>
          )}
          <div className="ml-auto flex items-center gap-1">
            {tabActions?.(ref, current)}
            {pinAction}
            {builtinAction}
          </div>
        </div>
      )}

      <div
        id={`${CHAT_SIDE_PANE_ID}-body`}
        role="tabpanel"
        data-pane-kind={ref.kind}
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        {body}
      </div>
    </aside>
  );
}

/**
 * The header control that opens the pane, with its tab count (T11: the
 * phone's way in; on desktop the same control reopens a closed pane).
 */
export function ChatSidePaneToggle({ pane, className }: { pane: ChatPane; className?: string }) {
  const t = useT().chatApp.sidePane;
  const count = pane.state.tabs.length - 1;
  const label = count > 0 ? format(t.openPaneCount, { count: String(count) }) : t.openPane;
  if (pane.state.open) return null;
  return (
    <button
      type="button"
      onClick={() => pane.setOpen(true)}
      aria-label={label}
      title={label}
      aria-controls={CHAT_SIDE_PANE_ID}
      aria-expanded={false}
      data-pane-toggle
      className={cn(
        "relative inline-flex h-11 min-w-11 items-center justify-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:h-8 sm:min-w-8",
        className,
      )}
    >
      <Activity className="size-4" aria-hidden />
      {count > 0 && <span className="tabular-nums">{count}</span>}
    </button>
  );
}
