/**
 * Route leaf for the Doc index `/w/[workspaceId]/p` — the
 * "latest-or-empty" landing (the 302 target for a legacy `/doc` link
 * that carried no `?viewId=`; see `src/lib/doc-redirect.ts`).
 *
 * Renders nothing. The assistant gate + `<DocShell>` are mounted by the
 * shared `p/layout.tsx`; with no `[pageId]` in the path the shell reads no
 * active page and renders its sidebar + empty-selection centre. Selecting
 * a row navigates on to `/p/<id>` (the shell's own URL handling), a soft
 * swap because the layout — and the shell — persist across that
 * navigation. See `p/layout.tsx` for why the shell lives in the layout.
 *
 * Spec:
 *  - `docs/plans/doc-v1-execution.md` §9.3 (URL redirects — 302 target)
 *  - `docs/architecture/features/doc.md` → "Routes"
 *
 * [COMP:app-web/page-index-route]
 */

export default function WorkspacePageIndexRoute() {
  return null;
}
