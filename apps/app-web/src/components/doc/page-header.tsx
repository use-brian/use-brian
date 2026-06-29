"use client";

/**
 * Page top bar — Row 2, the Notion-style **navbar** (location + actions).
 *
 *   [ ⌂ Workspace › Ancestor › 📄 Current ]      [sync?] [avatars] [Share] [★] [⋯]
 *
 * Left: the location **breadcrumb** (workspace → ancestors → current page);
 * the current crumb is click-to-rename (`onRenameValue`). Right, an action
 * cluster that mirrors Notion:
 *   - **Sync pill** — `CollabStatusIndicator`, LEFTMOST so it only extends the
 *     right-anchored cluster into empty space when it appears; shown only
 *     after the connection has been unhealthy for >1s (debounced — a
 *     page-switch reconnect never flashes it). Quiet when healthy.
 *   - **Presence face-pile** — live collaborators from the shared Yjs
 *     awareness (`usePresence` over the lifted `provider`).
 *   - **Share** — copies the page's canonical link (anyone in the workspace
 *     can open it); the label flips to "Link copied" briefly.
 *   - **Favorite star** — toggles saved/draft (a saved page is a Favorite).
 *   - **⋯ menu** — Duplicate / Full width / Delete, via the on-brand
 *     `DropdownMenu` + `confirmDialog` for the destructive delete.
 *
 * The big editable title lives in the page *body* (`PageTitle`) — the bar is
 * chrome, the title is content. The **top "layer"** (tabs + back/forward +
 * sidebar toggle) is a SEPARATE row mounted ABOVE this by `doc-shell` —
 * `doc-topbar.tsx`. This component is only the navbar (Row 2).
 *
 * [COMP:app-web/page-header]
 */

import { useEffect, useRef, useState } from "react";
import { Check, Lock, MoreHorizontal, Star, Trash2 } from "lucide-react";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  deleteView,
  downloadPageExport,
  fetchPageMarkdown,
  importDocument,
  ingestViewToBrain,
  saveView,
  setViewBrainSync,
  unsaveView,
  type ViewMetadata,
} from "@/lib/api/views";
import type { Crumb } from "@/lib/sidebar-tree";
import type { CollabStatus } from "@/lib/collab/use-collab-provider";
import { usePresence } from "@/lib/collab/use-presence";
import { useT, format } from "@/lib/i18n/client";
import { Breadcrumb } from "./breadcrumb";
import { CollabStatusIndicator } from "./error-states";
import { PresenceAvatars } from "./presence-avatars";
import { ScheduleBadge } from "./schedule-badge";
import { PageWorkflowRuns } from "./page-workflow-runs";
import { CommentHistory } from "./comment-history";
import { ShareDialog } from "./share-dialog";

type PageHeaderProps = {
  view: ViewMetadata;
  /** Ancestor chain root → … → active (for the breadcrumb). */
  breadcrumb: Crumb[];
  /** Shared collab provider — drives the live presence face-pile. */
  provider: HocuspocusProvider | null;
  status: CollabStatus;
  synced: boolean;
  /** Navigate to a page id, or to the workspace home with `null`. */
  onNavigate: (viewId: string | null) => void;
  onMutated: (next: ViewMetadata) => void;
  onDeleted: () => void;
  /** Commit a new title directly — drives the breadcrumb's inline rename. */
  onRenameValue: (id: string, name: string) => void;
  onDuplicate: (id: string) => void;
  /** Snapshot this page's current content as a reusable custom template (the
   *  ⋯ menu "Save as template"). When absent the item is hidden. */
  onSaveAsTemplate?: (id: string) => void;
  /** Current Notion-style page-width mode (false = constrained column). */
  fullWidth: boolean;
  /** Flip the page-width mode (per-page, persisted). Lives in the ⋯ menu. */
  onToggleFullWidth: (next: boolean) => void;
  /** The requesting member's own clearance — bounds the clearance picker. */
  memberClearance: Clearance;
  /** Set the page's clearance (per-page, persisted). Server rejects above
   *  the member's own clearance; declassify is confirmed first. */
  onChangeClearance: (next: Clearance) => void;
  /** The workspace's doc assistant id — lets the read-only History panel
   *  attribute assistant rows with the real assistant identity. */
  assistantId?: string;
  /** The signed-in viewer — History labels their own comment rows by name. */
  currentUser: { id: string; name: string; avatarUrl?: string | null };
};

type Clearance = "public" | "internal" | "confidential";
const CLEARANCE_RANK: Record<Clearance, number> = {
  public: 1,
  internal: 2,
  confidential: 3,
};
const CLEARANCE_ORDER: Clearance[] = ["public", "internal", "confidential"];

/** How long the connection must stay unhealthy before we surface the sync
 * indicator. Below this, a reconnect (e.g. a page switch re-dialing the
 * socket) resolves silently — no flash. */
const CONNECTING_GRACE_MS = 1000;

export function PageHeader({
  view,
  breadcrumb,
  provider,
  status,
  synced,
  onNavigate,
  onMutated,
  onDeleted,
  onRenameValue,
  onDuplicate,
  onSaveAsTemplate,
  fullWidth,
  onToggleFullWidth,
  memberClearance,
  onChangeClearance,
  assistantId,
  currentUser,
}: PageHeaderProps) {
  const t = useT().docPage;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const presence = usePresence(provider);
  const isSaved = view.state === "saved";
  const live = status === "connected" && synced;

  // Debounced "connecting" flag: surface the sync indicator only once the
  // connection has been unhealthy for >1s. A quick reconnect — notably a
  // page switch, which re-dials the socket — clears the timer before it
  // fires, so the indicator never flashes.
  const [showConnecting, setShowConnecting] = useState(false);
  useEffect(() => {
    if (live) {
      setShowConnecting(false);
      return;
    }
    const id = window.setTimeout(
      () => setShowConnecting(true),
      CONNECTING_GRACE_MS,
    );
    return () => window.clearTimeout(id);
  }, [live]);

  async function toggleFavorite() {
    setBusy(true);
    setError(null);
    try {
      const updated = isSaved ? await unsaveView(view.id) : await saveView(view.id);
      onMutated(updated);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(format(isSaved ? t.unsaveFailed : t.saveFailed, { message }));
    } finally {
      setBusy(false);
    }
  }

  // Flip the per-page "Sync to brain" toggle. Enabling it auto-ingests on the
  // next authored-content change; we also kick one ingest now so an already-
  // written page enters the brain immediately. Reflects via `onMutated`.
  async function toggleBrainSync(next: boolean) {
    setError(null);
    try {
      const updated = await setViewBrainSync(view.id, next);
      onMutated(updated);
      if (next) {
        // Best-effort immediate sync; the server queues it in the background.
        await ingestViewToBrain(view.id).catch(() => {});
        setNotice(t.brainSyncOnNotice);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(format(t.brainSyncFailed, { message }));
    }
  }

  async function handleDelete() {
    const ok = await confirmDialog({
      title: t.deleteConfirmTitle,
      description: t.deleteConfirm,
      confirmLabel: t.deleteConfirmAction,
      cancelLabel: t.cancel,
      variant: "destructive",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await deleteView(view.id);
      onDeleted();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(format(t.saveFailed, { message }));
      setBusy(false);
    }
  }

  // Copy the page as Markdown to the clipboard (reuses the export endpoint, so
  // copy and file-export never drift). Transient success notice, like Share.
  async function handleCopyMarkdown() {
    setError(null);
    try {
      const md = await fetchPageMarkdown(view.id);
      await navigator.clipboard.writeText(md);
      setNotice(t.copiedAsMarkdown);
      window.setTimeout(() => setNotice(null), 1600);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(format(t.copyFailed, { message }));
    }
  }

  // PAGE-5 — copy the canonical page URL to the clipboard (Notion's ⋯ "Copy
  // link"). The Share button copies the same link, but Notion users expect it
  // in the ⋯ menu too. Transient "Link copied" notice, like copy-as-Markdown.
  async function handleCopyLink() {
    setError(null);
    try {
      const url = `${window.location.origin}/w/${view.workspaceId}/p/${view.id}`;
      await navigator.clipboard.writeText(url);
      setNotice(t.headerLinkCopied);
      window.setTimeout(() => setNotice(null), 1600);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(format(t.copyFailed, { message }));
    }
  }

  // Download the page as .md / .docx (blob via authFetch — see the SDK note).
  async function handleExport(fmt: "md" | "docx") {
    setError(null);
    try {
      await downloadPageExport(view.id, fmt, view.name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(format(t.exportFailed, { message }));
    }
  }

  // Import a .docx/.md file as a NEW page, then navigate to it (journey A).
  const importInputRef = useRef<HTMLInputElement>(null);
  async function handleImportPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    setError(null);
    try {
      const result = await importDocument(view.workspaceId, file, "page");
      if (result.pageId) {
        setNotice(t.importedToPage);
        window.setTimeout(() => setNotice(null), 1600);
        onNavigate(result.pageId);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(format(t.importFailed, { message }));
    }
  }

  return (
    <div data-doc-chrome className="flex flex-col border-b border-border">
      <div className="flex h-12 items-center justify-between gap-2 pl-3 pr-2 md:pl-4 md:pr-3">
        <div className="flex min-w-0 flex-1 items-center">
          <Breadcrumb
            crumbs={breadcrumb}
            onNavigate={onNavigate}
            onRenameCurrent={(name) => onRenameValue(view.id, name)}
          />
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {/* Save-state indicator — LEFTMOST. A calm always-on "Saved" chip
              when the doc is connected + synced (PAGE-1: Notion always affirms
              the page is persisted); the reconnecting pill only once unhealthy
              for >1s (the debounce keeps a page-switch reconnect silent). */}
          {showConnecting ? (
            <CollabStatusIndicator
              status={status}
              synced={synced}
              className="hidden sm:inline-flex"
            />
          ) : live ? (
            <span
              className="hidden items-center gap-1 px-1.5 text-xs text-muted-foreground sm:inline-flex"
              aria-label={t.headerSaved}
            >
              <Check className="h-3 w-3" aria-hidden />
              {t.headerSaved}
            </span>
          ) : null}

          <ClearancePill
            clearance={(view.clearance ?? "internal") as Clearance}
            memberClearance={memberClearance}
            onChange={onChangeClearance}
            t={t}
          />

          {/* Schedule badge (migration 229) — the recurring "research & update
              this page" jobs the assistant set up. Only renders when the page
              has at least one enabled schedule targeting it. */}
          {view.scheduledJobs && view.scheduledJobs.length > 0 && (
            <ScheduleBadge jobs={view.scheduledJobs} />
          )}

          {/* Workflow runs this page triggered (migration 282) — self-fetches
              and renders nothing unless the page has fired a run. */}
          <PageWorkflowRuns pageId={view.id} workspaceId={view.workspaceId} />

          <PresenceAvatars users={presence} />

          <ShareDialog
            pageId={view.id}
            workspaceId={view.workspaceId}
            currentUser={currentUser}
          />

          {/* History — icon-only, grouped with the favorite star + overflow
              menu as the trailing icon cluster. */}
          <CommentHistory
            pageId={view.id}
            assistantId={assistantId}
            currentUser={currentUser}
            originPrompt={view.originPrompt}
          />

          <button
            type="button"
            onClick={toggleFavorite}
            disabled={busy}
            aria-pressed={isSaved}
            aria-label={isSaved ? t.headerFavoriteRemove : t.headerFavoriteAdd}
            title={isSaved ? t.headerFavoriteRemove : t.headerFavoriteAdd}
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            <Star
              className={
                isSaved ? "size-4 fill-amber-400 text-amber-500" : "size-4"
              }
              aria-hidden
            />
          </button>

          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label={t.headerMoreAria}
                  className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground aria-expanded:bg-muted"
                >
                  <MoreHorizontal className="size-4" aria-hidden />
                </button>
              }
            />
            <DropdownMenuContent>
              <DropdownMenuItem onClick={() => onDuplicate(view.id)}>
                {t.sidebarRowDuplicate}
              </DropdownMenuItem>
              {onSaveAsTemplate ? (
                <DropdownMenuItem onClick={() => onSaveAsTemplate(view.id)}>
                  {t.saveAsTemplate}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onClick={() => void handleCopyLink()}>
                {t.headerCopyLink}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleCopyMarkdown}>
                {t.copyAsMarkdown}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void handleExport("md")}>
                {t.exportMarkdown}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void handleExport("docx")}>
                {t.exportWord}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => importInputRef.current?.click()}>
                {t.importFile}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {/* Full width — a Notion-style switch ROW (label left, Switch
                  right), NOT a DropdownMenuItem: base-ui `Menu.Item` closes the
                  menu on click, but flipping a page setting should keep the menu
                  open so the page reflow is visible underneath. A plain
                  container row sidesteps the close-on-click; the Switch carries
                  the role/aria/keyboard contract. */}
              <label className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-sm select-none hover:bg-accent hover:text-accent-foreground">
                <span>{t.headerFullWidth}</span>
                <Switch
                  checked={fullWidth}
                  onCheckedChange={onToggleFullWidth}
                  aria-label={t.headerFullWidth}
                />
              </label>
              {/* Sync to brain — a switch ROW like Full width (kept open on
                  click so the toggle state is visible). Enabling it distils the
                  page's authored prose into searchable brain facts and keeps it
                  in sync as the page is edited. */}
              <label className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-sm select-none hover:bg-accent hover:text-accent-foreground">
                <span>{t.brainSync}</span>
                <Switch
                  checked={view.brainSyncEnabled}
                  onCheckedChange={(next) => void toggleBrainSync(next)}
                  aria-label={t.brainSync}
                />
              </label>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={handleDelete}>
                <Trash2 aria-hidden />
                {t.sidebarRowDelete}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Hidden picker for the "Import file" menu item (journey A). */}
          <input
            ref={importInputRef}
            type="file"
            accept=".docx,.md,.markdown,.txt,text/markdown,text/plain"
            className="hidden"
            onChange={handleImportPicked}
          />
        </div>
      </div>
      {error && (
        <p
          role="alert"
          aria-live="polite"
          className="px-4 pb-2 text-xs text-destructive md:px-4"
        >
          {error}
        </p>
      )}
      {notice && (
        <p
          role="status"
          aria-live="polite"
          className="px-4 pb-2 text-xs text-emerald-600 md:px-4 dark:text-emerald-400"
        >
          {notice}
        </p>
      )}
    </div>
  );
}

/**
 * Page-clearance pill (migration 212). Shows the page's current clearance and
 * opens a picker bounded to the member's own clearance (a member can't set a
 * page above what they can see; the PATCH route enforces the same). Lowering
 * (declassify) widens read access, so it's confirmed first. `confidential`
 * renders emphasized.
 */
function ClearancePill({
  clearance,
  memberClearance,
  onChange,
  t,
}: {
  clearance: Clearance;
  memberClearance: Clearance;
  onChange: (next: Clearance) => void;
  t: ReturnType<typeof useT>["docPage"];
}) {
  const labelFor: Record<Clearance, string> = {
    public: t.clearancePublic,
    internal: t.clearanceInternal,
    confidential: t.clearanceConfidential,
  };
  const isConfidential = clearance === "confidential";

  async function pick(next: Clearance) {
    if (next === clearance) return;
    // Declassify (lowering) exposes the page to more members — confirm it.
    if (CLEARANCE_RANK[next] < CLEARANCE_RANK[clearance]) {
      const ok = await confirmDialog({
        title: t.clearanceDeclassifyTitle,
        description: format(t.clearanceDeclassifyConfirm, {
          from: labelFor[clearance],
          to: labelFor[next],
        }),
        confirmLabel: t.clearanceDeclassifyAction,
        cancelLabel: t.cancel,
        variant: "destructive",
      });
      if (!ok) return;
    }
    onChange(next);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={t.clearancePill}
            title={t.clearancePill}
            className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors aria-expanded:bg-muted ${
              isConfidential
                ? "bg-destructive/10 text-destructive hover:bg-destructive/15"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            <Lock className="size-3.5" aria-hidden />
            <span className="hidden sm:inline">{labelFor[clearance]}</span>
          </button>
        }
      />
      <DropdownMenuContent>
        {CLEARANCE_ORDER.map((opt) => {
          const allowed = CLEARANCE_RANK[opt] <= CLEARANCE_RANK[memberClearance];
          return (
            <DropdownMenuItem
              key={opt}
              disabled={!allowed}
              onClick={() => {
                void pick(opt);
              }}
            >
              <Check
                className={opt === clearance ? "size-4" : "size-4 opacity-0"}
                aria-hidden
              />
              {labelFor[opt]}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
