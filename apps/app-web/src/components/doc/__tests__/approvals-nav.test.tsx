import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedDock } from "@/lib/api/home-dock";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { ApprovalsNav } from "../approvals-nav";

const state = vi.hoisted(() => ({ dock: null as ResolvedDock | null }));
vi.mock("../doc-sidebar-data", () => ({ useSidebarData: () => state }));
vi.mock("next/link", () => ({
  default: ({ children, prefetch: _prefetch, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { prefetch?: boolean }) => (
    <a {...props}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/w/workspace-1/chat",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/sidebar-close", () => ({ requestSidebarClose: () => undefined }));

const render = () =>
  renderToStaticMarkup(
    <I18nProvider locale="en" dict={en}>
      <ApprovalsNav workspaceId="workspace-1" />
    </I18nProvider>,
  );

beforeEach(() => {
  state.dock = {
    source: "default",
    generatedAt: null,
    note: null,
    needsYou: [],
    pickUp: [],
    comingUp: [],
    brain: { entryCount: 0, growth7d: 0, hasConnector: true },
  };
});

describe("[COMP:app-web/approvals] durable Approvals sidebar entry", () => {
  it("always links into the Approvals panel, even with an empty dock", () => {
    const html = render();
    expect(html).toContain('href="/w/workspace-1/p?panel=approvals"');
    expect(html).toContain(en.approvalsPage.title);
    expect(html).toContain('data-approvals-nav');
  });

  it("shows the pending count from the home-dock approvals card", () => {
    state.dock!.needsYou = [{ kind: "approvals", count: 3, caption: null }];
    expect(render()).toContain(">3<");
  });
});
