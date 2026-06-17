/**
 * Route leaf for the canonical Doc page URL
 * `/w/[workspaceId]/p/[pageId]`.
 *
 * Renders nothing. The Doc surface — assistant gate + `<DocShell>`
 * — is mounted by the shared `p/layout.tsx`, which **persists** across
 * `[pageId]` navigation. The shell reads the active page id straight off
 * the path (`usePathname()` → `pageIdFromPathname`), so switching pages
 * swaps only what the persistent shell paints in its centre pane — it
 * never remounts the sidebar, drafts list, or chat.
 *
 * Mounting the shell *here* (the old design) put it inside a page, and
 * App Router pages do not persist across navigation: every draft click
 * remounted the shell, flashing the empty "no drafts" sidebar and the
 * full-screen gate spinner. The fix was to hoist it to the layout — see
 * `p/layout.tsx`. This leaf exists only to make the path a valid route.
 *
 * Spec:
 *  - `docs/plans/doc-v1-execution.md` §9.3 (URL redirects)
 *  - `docs/architecture/features/doc.md` → "Routes"
 *
 * [COMP:app-web/page-route]
 */

export default function WorkspacePageRoute() {
  return null;
}
