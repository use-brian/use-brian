/**
 * [COMP:app-web/sidebar-panel-feed] Feed rail — static render contract.
 *
 * vitest in app-web is node-only — `renderToString` + module mocks
 * (next/navigation, the sidebar-data provider). Effects never run, so anything
 * effect-driven (the post list, the resolved current platform, the review
 * badge) stays at its initial value here; what is asserted is the platform-led
 * nav STRUCTURE: Company above one platform switcher with scoped hosted tools,
 * then the platform-drafts group. The duplicate Platforms list is retired.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

const pathnameRef = vi.hoisted(() => ({ current: "/w/ws-1/feed" }));
const sidebarDataRef = vi.hoisted(
  () => ({ current: { feedProfiles: null } }) as {
    current: { feedProfiles: unknown };
  },
);

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameRef.current,
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/doc/doc-sidebar-data", () => ({
  useSidebarData: () => sidebarDataRef.current,
}));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));

import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import type { FeedProfile } from "@/lib/api/feed";
import { FeedSidebarPanel } from "../feed-sidebar-panel";

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

function render(profiles: FeedProfile[] | null, pathname: string): string {
  pathnameRef.current = pathname;
  sidebarDataRef.current = { feedProfiles: profiles };
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      <FeedSidebarPanel workspaceId="ws-1" />
    </I18nProvider>,
  );
}

describe("[COMP:app-web/sidebar-panel-feed] FeedSidebarPanel", () => {
  it("renders Company above Platform above Platform drafts", () => {
    const html = render([profile("threads", "acme")], "/w/ws-1/feed");
    const company = html.indexOf(en.feedPage.groups.company);
    const platform = html.indexOf(en.feedPage.groups.platform);
    const drafts = html.indexOf(en.feedPage.groups.drafts);
    expect(company).toBeGreaterThan(-1);
    // Scope narrows as you descend; the order carries that meaning.
    expect(platform).toBeGreaterThan(company);
    expect(drafts).toBeGreaterThan(platform);
  });

  it("puts company voice and the plan calendar in the Company group", () => {
    const html = render([profile("threads", "acme")], "/w/ws-1/feed");
    expect(html).toContain('href="/w/ws-1/feed/voice"');
    expect(html).toContain('href="/w/ws-1/feed"');
  });

  it("scopes the platform voice row to the current platform", () => {
    // The URL is authoritative when it carries a platform, so the row and the
    // pane can never disagree.
    const html = render(
      [profile("threads", "acme")],
      "/w/ws-1/feed/twitter/voice",
    );
    expect(html).toContain('href="/w/ws-1/feed/twitter/voice"');
  });

  it("offers a New post entry under the drafts group", () => {
    const html = render([profile("threads", "acme")], "/w/ws-1/feed");
    expect(html).toContain(en.feedPage.posts.newPost);
  });

  // The queue page is retired (D14) — the list is the sidebar.
  it("no longer links a standalone posts queue", () => {
    const html = render([profile("threads", "acme")], "/w/ws-1/feed");
    expect(html).not.toContain('href="/w/ws-1/feed/posts"');
    expect(html).not.toContain('href="/w/ws-1/feed/drafts"');
    expect(html).not.toContain('href="/w/ws-1/feed/inbox"');
  });

  it("renders hosted tools for the current connected platform without a second platform list", () => {
    const html = render(
      [profile("threads", "acme"), profile("twitter", "acmex")],
      "/w/ws-1/feed/threads/insights",
    );
    expect(html).toContain('href="/w/ws-1/feed/threads/insights"');
    expect(html).toContain('href="/w/ws-1/feed/threads/inspiration"');
    expect(html).toContain('href="/w/ws-1/feed/threads/settings"');
    expect(html).not.toContain('href="/w/ws-1/feed/threads/connection"');
    expect(html).not.toContain('href="/w/ws-1/feed/threads/policy"');
    expect(html).not.toContain('href="/w/ws-1/feed/twitter/insights"');
    expect(html).not.toContain(en.feedPage.groups.platforms);
  });

  it("gives an unconnected X one settings-backed connect entry", () => {
    const html = render([], "/w/ws-1/feed/twitter/voice");
    expect(html).toContain('href="/w/ws-1/feed/twitter/settings"');
    expect(html).toContain(en.feedPage.connection.connectCta);
    expect(html).not.toContain('href="/w/ws-1/feed/twitter/connection"');
    expect(html).not.toContain('href="/w/ws-1/feed/twitter/insights"');
  });

  it("keeps Company and Platform but hides the hosted group in OSS", () => {
    const previous = process.env.NEXT_PUBLIC_USEBRIAN_EDITION;
    try {
      process.env.NEXT_PUBLIC_USEBRIAN_EDITION = "oss";
      const html = render([], "/w/ws-1/feed");
      expect(html).toContain(en.feedPage.groups.company);
      expect(html).toContain(en.feedPage.groups.platform);
      expect(html).toContain(en.feedPage.groups.drafts);
      expect(html).not.toContain('href="/w/ws-1/feed/instagram/settings"');
      expect(html).not.toContain(en.feedPage.groups.platforms);
    } finally {
      if (previous === undefined) {
        delete process.env.NEXT_PUBLIC_USEBRIAN_EDITION;
      } else {
        process.env.NEXT_PUBLIC_USEBRIAN_EDITION = previous;
      }
    }
  });
});
