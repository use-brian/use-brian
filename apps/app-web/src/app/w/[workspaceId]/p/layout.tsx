"use client";

/**
 * Shared layout for the Doc surface — `/w/[workspaceId]/p` (index) and
 * `/w/[workspaceId]/p/[pageId]` (a specific page).
 *
 * This is where `<DocShell>` is mounted, and that placement is load-bearing.
 * App Router **layouts persist across navigation** within their subtree;
 * **pages do not** — a page is torn down and remounted on every route
 * change. The active page id lives in the `[pageId]` path segment, so
 * clicking a draft is a route change between two `[pageId]` values. With
 * the shell in the page leaf (the old design) every click remounted it:
 * `drafts`/`saved`/`recents` reset to empty (the "no drafts" flash in the
 * sidebar) and the gate re-ran (the full-screen loading spinner) — the
 * whole surface repainted.
 *
 * Mounting the shell in the layout makes `router.replace('/p/<id>')` a
 * true soft swap. The layout — sidebar, drafts, chat — stays mounted;
 * `<DocShell>` reads the new active id off the pathname
 * (`usePathname()` → `pageIdFromPathname`) and, for the *centre pane*
 * only, dials the new page's Yjs socket (keyed on the URL id, so it
 * connects in parallel) while its metadata refetches. The editor stays
 * mounted across the switch and shows a chrome skeleton for the ~one
 * round-trip the metadata takes — no full-pane teardown. Nothing else
 * re-renders.
 *
 * **No assistant gate.** This layout used to fetch `listWorkspaceAssistants`
 * itself and render a centred "Loading..." line until it resolved, so entering
 * the doc surface from Brain or Studio cost a full round trip before any page
 * chrome appeared. That fetch duplicated one `WorkspaceChrome` was already
 * making a level up for the chat dock. Both now read
 * `usePrimaryAssistant()` ([COMP:app-web/primary-assistant-context]), which resolves
 * once in the workspace layout — so the shell mounts on the first frame and
 * the assistant id fills in when it lands. `assistantId` is optional all the
 * way down (`SuggestedView`, `EmptyPageLanding`, the page header), which is
 * what makes rendering ahead of it safe.
 *
 * The page leaves under this layout render nothing; their only job is to
 * make each path a valid route.
 *
 * Spec:
 *  - `docs/architecture/features/doc.md` → "Routes"
 *  - `docs/architecture/features/perceived-performance.md`
 *  - `docs/plans/doc-v1-execution.md` §9.3 (URL redirects)
 *
 * [COMP:app-web/page-layout]
 */

import { use } from "react";
import { DocShell } from "@/components/doc/doc-shell";
import { usePrimaryAssistant } from "@/contexts/primary-assistant";

export default function DocSurfaceLayout(props: {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = use(props.params);

  // The default interlocutor is the workspace PRIMARY assistant — the doc
  // assistant has been demoted to a context-injected skill, so the backend
  // injects the doc-editing tools off `appOrigin: "doc"` regardless of
  // which assistant runs. `<FloatingChat>` defaults to this id and offers a
  // switcher to any other accessible workspace assistant.
  const { assistantId } = usePrimaryAssistant();

  // The shell owns the 3-column layout and reads the active page id from
  // the pathname. `children` is the (inert) route leaf — rendered to keep
  // the route tree honest, but it renders nothing.
  return (
    <div className="relative h-full w-full">
      <DocShell
        workspaceId={workspaceId}
        assistantId={assistantId ?? undefined}
      />
      {props.children}
    </div>
  );
}
