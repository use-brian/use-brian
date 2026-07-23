"use client";

/**
 * Ownership of the Doc top bar's tab strip — seeding, the two URL sync
 * effects, and (see `doc-tabs-session.ts`) survival across a surface switch.
 *
 * `doc-tabs.ts` is the pure reducer; this hook is the React half that binds it
 * to the URL. It was lifted out of `doc-shell.tsx` so the seed ⇄ URL
 * reconciliation has a test seam that can be mounted, unmounted, and remounted
 * — which is exactly the lifecycle the tab strip has to survive.
 *
 * **Why the lifecycle matters.** `<DocShell>` is mounted by
 * `/w/[workspaceId]/p/layout.tsx`. That layout persists across `/p/<pageId>`
 * soft swaps but is torn down the moment the user leaves the doc surface for
 * a sibling one (Brain / Studio / Workflow / Feed / Approvals live under the
 * *workspace* layout, not under `p/`). React state in the shell therefore dies
 * on every surface switch — so a strip held in a bare `useState` came back as
 * a single fresh tab when the user returned to Home. The strip is restored
 * from the session store instead; see `doc-tabs-session.ts` for the scope.
 *
 * [COMP:app-web/doc-tabs-session]
 */

import * as React from "react";
import {
  activePageId,
  blankActiveTab,
  openPage,
  type TabsState,
} from "./doc-tabs";
import {
  readDocTabsSession,
  seedDocTabs,
  writeDocTabsSession,
} from "./doc-tabs-session";

/**
 * Own the tab strip for one mount of the doc surface.
 *
 * `urlEntry` is the entry the URL currently points at (a page id, a
 * `panel:<id>` sentinel, or null at the `/p` index). `syncUrl` mirrors the
 * active tab's entry back into the URL — `router.replace(docEntryPath(...))`
 * in the shell, a plain assignment in tests.
 */
export function useDocTabs(
  workspaceId: string,
  urlEntry: string | null,
  syncUrl: (entry: string | null) => void,
): [TabsState, React.Dispatch<React.SetStateAction<TabsState>>] {
  // Seeded once per mount from the workspace's session strip (`seedDocTabs`
  // decides whether the restored strip or the URL wins — see its doc).
  const seed = React.useRef<ReturnType<typeof seedDocTabs> | null>(null);
  if (seed.current === null) {
    seed.current = seedDocTabs(readDocTabsSession(workspaceId), urlEntry);
  }
  const [tabsState, setTabsState] = React.useState<TabsState>(
    () => seed.current!.state,
  );

  // When the restored strip won, the URL is the stale side: the tabs → URL
  // effect below rewrites it, and the URL → tabs effect must NOT adopt the
  // stale value back on that first commit (it would blank the very tab we just
  // restored). One-shot — every later URL change is a real navigation.
  const skipFirstUrlAdopt = React.useRef(!seed.current.urlAgrees);

  // Hand the strip back to the session store on every commit, so the state the
  // surface is torn down with is the state it comes back with.
  React.useEffect(() => {
    writeDocTabsSession(workspaceId, tabsState);
  }, [workspaceId, tabsState]);

  const activeEntry = activePageId(tabsState);
  // Latest active entry, read by the URL → tabs effect for COMPARISON only.
  const activeEntryRef = React.useRef(activeEntry);
  activeEntryRef.current = activeEntry;
  // Latest URL-derived entry, read by the tabs → URL effect for COMPARISON
  // only (never as a trigger — see below).
  const urlEntryRef = React.useRef(urlEntry);
  urlEntryRef.current = urlEntry;
  // The router callback changes identity every render in the shell; hold it in
  // a ref so it never widens the effect's dependency set.
  const syncUrlRef = React.useRef(syncUrl);
  syncUrlRef.current = syncUrl;

  // tabs → URL: mirror the active tab's current entry into the canonical URL.
  // Triggered ONLY by the active entry (the tab side owns this direction); it
  // reads the URL entry through a ref purely to no-op once they already match.
  //
  // The URL entry must NOT be a dependency. If it were, an EXTERNAL url change —
  // the editor's "/"→Page `router.push`, floating-chat's `router.replace`, a
  // deep link, browser back/forward — would re-fire this effect in the render
  // where `urlEntry` has advanced but `activeEntry` still lags by one commit.
  // It would then replace the URL back to the stale active entry, while the
  // URL → tabs effect simultaneously adopts the new one, leaving the two a
  // half-step out of phase forever: the page and its child page ping-pong
  // endlessly. Reacting to the active entry alone lets the URL → tabs effect
  // own external changes and this effect own tab-driven ones; both guard on
  // equality, so they converge.
  React.useEffect(() => {
    if (urlEntryRef.current !== activeEntry) syncUrlRef.current(activeEntry);
  }, [activeEntry]);

  // URL → tabs: reconcile a URL change from OUTSIDE the tab actions — a
  // chat-created draft auto-navigation (`floating-chat` calls `router.replace`
  // directly), a page link, a `?panel=` deep link, a redirect from the legacy
  // `/approvals` / `/goals` routes, a deep link followed in-session. Reacting to
  // `urlEntry` alone (latest active entry read via the ref) keeps a tab switch's
  // not-yet-synced URL from being mistaken for an external change; both effects
  // guard on equality, so they converge with no ping-pong.
  React.useEffect(() => {
    if (skipFirstUrlAdopt.current) {
      skipFirstUrlAdopt.current = false;
      return;
    }
    if (urlEntry === activeEntryRef.current) return;
    setTabsState((s) => (urlEntry ? openPage(s, urlEntry) : blankActiveTab(s)));
  }, [urlEntry]);

  return [tabsState, setTabsState];
}
