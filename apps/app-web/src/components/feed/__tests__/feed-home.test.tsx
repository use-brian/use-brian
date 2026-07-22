/**
 * [COMP:app-web/feed-home] Feed home dashboard — static render contract.
 *
 * vitest in app-web is node-only — `renderToString` + module mocks (the
 * feed-surface-shell test shape). Effects never run under SSR, so the stats
 * fetch and the SSE subscription stay dormant; what's asserted is the two
 * top-level states: the zero-profile onboarding (connect CTA gated on
 * admin/owner) and the dashboard (stat cards, platform cards with
 * `feedPath`-built quick links, recent-activity skeleton while loading).
 */

import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

import type { FeedWorkspaceValue } from "@/contexts/feed-profiles-context";

const workspaceRef = vi.hoisted(
  () => ({ current: null }) as { current: unknown },
);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/auth-fetch", () => ({
  authFetch: vi.fn(),
  getAccessToken: () => null,
}));
vi.mock("@/contexts/feed-profiles-context", () => ({
  useFeedWorkspace: () => workspaceRef.current,
}));

import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import type { FeedProfile } from "@/lib/api/feed";
import { FeedHome } from "../feed-home";

const dict = en as unknown as Dictionary;

function profile(
  platform: FeedProfile["platform"],
  handle: string,
): FeedProfile {
  return {
    assistantId: `a-${handle}`,
    platform,
    platformHandle: handle,
    profilePictureUrl: null,
    enabled: true,
    assistant: { id: `a-${handle}`, name: handle, iconSeed: 0 },
  };
}

function workspace(
  profiles: FeedProfile[],
  role: FeedWorkspaceValue["role"] = "admin",
): FeedWorkspaceValue {
  return {
    workspaceId: "ws-1",
    name: "Acme Team",
    role,
    canDraft: true,
    me: { id: "u-1" },
    profiles,
    assistants: [],
    refresh: async () => {},
  };
}

function render(
  profiles: FeedProfile[],
  role: FeedWorkspaceValue["role"] = "admin",
): string {
  workspaceRef.current = workspace(profiles, role);
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      <FeedHome />
    </I18nProvider>,
  );
}

describe("[COMP:app-web/feed-home] FeedHome", () => {
  it("zero profiles: renders the onboarding state with the connect CTA for an admin", () => {
    const html = render([], "admin");
    expect(html).toContain(en.feedPage.home.emptyTitle);
    expect(html).toContain(en.feedPage.home.emptyCta);
    expect(html).not.toContain(en.feedPage.home.emptyAskAdmin);
    // No dashboard chrome in the empty state.
    expect(html).not.toContain(en.feedPage.home.recentHeading);
  });

  it("zero profiles: a member sees the ask-an-admin line, not the CTA", () => {
    const html = render([], "member");
    expect(html).toContain(en.feedPage.home.emptyTitle);
    expect(html).toContain(en.feedPage.home.emptyAskAdmin);
    expect(html).not.toContain(en.feedPage.home.emptyCta);
  });

  it("with profiles: renders the dashboard with feedPath-built quick links", () => {
    const html = render([profile("threads", "acme")], "owner");
    expect(html).toContain("Acme Team");
    expect(html).toContain(en.feedPage.home.statPendingLabel);
    expect(html).toContain(en.feedPage.home.statPostedLabel);
    expect(html).toContain(en.feedPage.home.statAccountsLabel);
    expect(html).toContain(en.feedPage.home.platformsHeading);
    // SSR splits `@{handle}` with a comment node — match the handle alone.
    expect(html).toContain("acme");
    // Quick links land inside the Feed surface, never on feed-web paths.
    expect(html).toContain('href="/w/ws-1/feed/inbox"');
    expect(html).toContain('href="/w/ws-1/feed/threads/policy"');
    expect(html).toContain('href="/w/ws-1/feed/threads/connection"');
    // Admin/owner sees the "Add another" entry point.
    expect(html).toContain(en.feedPage.home.addAnother);
    // Effects never ran → still loading → the recent list renders skeletons.
    expect(html).toContain(en.feedPage.home.recentHeading);
    expect(html).not.toContain(en.feedPage.home.recentEmpty);
  });

  it("with profiles: a member gets no connect entry point", () => {
    const html = render([profile("twitter", "acmex")], "member");
    expect(html).not.toContain(en.feedPage.home.addAnother);
    expect(html).toContain('href="/w/ws-1/feed/twitter/policy"');
  });
});
