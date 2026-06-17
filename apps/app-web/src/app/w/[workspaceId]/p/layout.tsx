"use client";

/**
 * Shared layout for the Doc surface — `/w/[workspaceId]/p` (index) and
 * `/w/[workspaceId]/p/[pageId]` (a specific page).
 *
 * This is where the assistant gate + `<DocShell>` are mounted, and that
 * placement is load-bearing. App Router **layouts persist across
 * navigation** within their subtree; **pages do not** — a page is torn
 * down and remounted on every route change. The active page id lives in
 * the `[pageId]` path segment, so clicking a draft is a route change
 * between two `[pageId]` values. With the shell in the page leaf (the old
 * design) every click remounted it: `drafts`/`saved`/`recents` reset to
 * empty (the "no drafts" flash in the sidebar) and the gate re-ran (the
 * full-screen loading spinner) — the whole surface repainted.
 *
 * Mounting the shell in the layout makes `router.replace('/p/<id>')` a
 * true soft swap. The layout — sidebar, drafts, chat, gate — stays
 * mounted; `<DocShell>` reads the new active id off the pathname
 * (`usePathname()` → `pageIdFromPathname`) and, for the *centre pane*
 * only, dials the new page's Yjs socket (keyed on the URL id, so it
 * connects in parallel) while its metadata refetches. The editor stays
 * mounted across the switch and shows a chrome skeleton for the ~one
 * round-trip the metadata takes — no full-pane teardown. Nothing else
 * re-renders.
 *
 * The gate is hoisted here too, so `listWorkspaceAssistants` runs once per
 * surface entry instead of once per page open. The page leaves under this
 * layout render nothing; their only job is to make each path a valid
 * route.
 *
 * Spec:
 *  - `docs/architecture/features/doc.md` → "Routes"
 *  - `docs/plans/doc-v1-execution.md` §9.3 (URL redirects)
 *
 * [COMP:app-web/page-layout]
 */

import { use, useEffect, useState } from "react";
import { DocShell } from "@/components/doc/doc-shell";
import { listWorkspaceAssistants } from "@/lib/api/views";
import { useT } from "@/lib/i18n/client";

export default function DocSurfaceLayout(props: {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = use(props.params);
  const t = useT().docPage;

  // The default interlocutor is the workspace PRIMARY assistant — the doc
  // assistant has been demoted to a context-injected skill, so the backend
  // injects the doc-editing tools off `appOrigin: "doc"` regardless of
  // which assistant runs. `<FloatingChat>` defaults to this id and offers a
  // switcher to any other accessible workspace assistant.
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; defaultAssistantId: string | null }
    | { kind: "error"; message: string }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    listWorkspaceAssistants(workspaceId)
      .then((assistants) => {
        if (cancelled) return;
        // Prefer the primary; if somehow absent (data drift), fall back to the
        // first accessible assistant so the shell still renders rather than
        // stranding the user on an empty surface.
        const primary = assistants.find((a) => a.kind === "primary");
        setState({
          kind: "ready",
          defaultAssistantId: primary?.id ?? assistants[0]?.id ?? null,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ kind: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  if (state.kind === "loading") {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        {t.dataBlockLoading}
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {state.message}
        </div>
      </div>
    );
  }

  // The shell owns the 3-column layout and reads the active page id from
  // the pathname. `children` is the (inert) route leaf — rendered to keep
  // the route tree honest, but it renders nothing. A primary always exists,
  // so there's no setup-wizard gate any more; the shell renders for every
  // workspace and the chat dock defaults to the primary assistant.
  return (
    <div className="relative h-full w-full">
      <DocShell
        workspaceId={workspaceId}
        assistantId={state.defaultAssistantId ?? undefined}
      />
      {props.children}
    </div>
  );
}
