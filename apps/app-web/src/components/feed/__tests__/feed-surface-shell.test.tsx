/**
 * [COMP:app-web/feed-surface-shell] Readiness gate contract.
 *
 * vitest in app-web is node-only — `renderToString` + static markup, the
 * doc-sidebar-row.test.tsx shape. Effects never run under SSR, so the
 * provider stays in its initial `loading` state and the gate must render
 * the loading status INSTEAD of children — the invariant ported feed pages
 * rely on (they read `useFeedWorkspace()` synchronously).
 */

import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));
// The shell mounts the operator top bar above the gate; its router + layout
// sidebar state don't exist under bare SSR, so mock the hooks it reads.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ back: vi.fn(), forward: vi.fn() }),
}));
vi.mock("@/components/doc/doc-sidebar-data", () => ({
  useSidebarData: () => ({
    sidebarCollapsed: false,
    setSidebarCollapsed: vi.fn(),
  }),
}));

import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { FeedSurfaceShell } from "../feed-surface-shell";

const dict = en as unknown as Dictionary;

describe("[COMP:app-web/feed-surface-shell] FeedSurfaceShell", () => {
  it("gates children behind the loading state (no premature context reads)", () => {
    const html = renderToString(
      <I18nProvider locale="en" dict={dict}>
        <FeedSurfaceShell workspaceId="ws-1">
          <div data-feed-page>should not render while loading</div>
        </FeedSurfaceShell>
      </I18nProvider>,
    );
    expect(html).toContain(en.feedPage.shell.loading);
    expect(html).not.toContain("data-feed-page");
  });

  it("mounts the operator top bar ABOVE the gate (chrome on every state)", () => {
    const html = renderToString(
      <I18nProvider locale="en" dict={dict}>
        <FeedSurfaceShell workspaceId="ws-1">
          <div data-feed-page>gated</div>
        </FeedSurfaceShell>
      </I18nProvider>,
    );
    // Still loading, yet the Feed tab chip + chrome row already render.
    expect(html).toContain(en.operatorBar.feed);
    expect(html).toContain("data-doc-topbar");
  });
});
