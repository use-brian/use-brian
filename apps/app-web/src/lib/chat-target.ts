/**
 * Pure resolver for the chat's "what will my next message act on?" chip.
 *
 * The doc chat anchors to whatever page is open in the URL: when a
 * `/p/<pageId>` segment is present the model edits that page (`patchPage`);
 * with none it mints a brand-new draft (`renderPage`). The decision is
 * implicit in the request body (`docViewId` present or absent) — there
 * is no draft picker. This helper turns the two inputs the chat already
 * has (the path-derived target id + the shell-owned active-page metadata)
 * into a single descriptor the composer renders above the input, so the
 * user can see which draft they're about to edit before they hit send.
 *
 * Kept pure (no React, no fetch) so the edit-vs-create branching is unit
 * tested directly without mounting `<FloatingChat>` and its chat-ui hooks.
 *
 * See docs/architecture/features/doc.md → "Chat target indicator".
 *
 * [COMP:app-web/chat-target]
 */

import type {
  NameOrigin,
  ViewEntity,
  ViewState,
  ViewType,
} from "@/lib/api/views";

/**
 * The slice of a page's metadata the chip needs. Structurally satisfied by
 * `ViewMetadata` (the shell's `activeView`), so callers pass that straight
 * in — no mapping.
 */
export type ChatTargetPage = {
  id: string;
  name: string;
  state: ViewState;
  icon: string | null;
  entity: ViewEntity;
  viewType: ViewType;
  /** Title provenance — a `'placeholder'` target shows the generic draft glyph. */
  nameOrigin: NameOrigin;
};

/**
 * What the next chat message will do:
 *  - `create`       — no page open; the message mints a new draft.
 *  - `edit`         — the open page's metadata is resolved; edits land here.
 *  - `edit-pending` — a page id is open but its metadata hasn't arrived yet
 *                     (the brief mid-switch / deep-link-load window). The
 *                     chip shows a generic "editing this page" rather than a
 *                     stale name, so it never names the wrong target.
 */
export type ChatTarget =
  | { mode: "create" }
  | { mode: "edit"; page: ChatTargetPage }
  | { mode: "edit-pending" };

/**
 * Resolve the chip descriptor. `targetPageId` is the path-derived id the
 * chat actually sends as `docViewId` (the source of truth); `activePage`
 * is the shell's fetched metadata, which may lag the path by one tick during
 * a page switch. We only name the page when the two agree — otherwise the
 * chip would name the previous page while the message targets the new one.
 */
export function resolveChatTarget(
  targetPageId: string | null,
  activePage: ChatTargetPage | null,
): ChatTarget {
  if (!targetPageId) return { mode: "create" };
  if (activePage && activePage.id === targetPageId) {
    return { mode: "edit", page: activePage };
  }
  return { mode: "edit-pending" };
}
