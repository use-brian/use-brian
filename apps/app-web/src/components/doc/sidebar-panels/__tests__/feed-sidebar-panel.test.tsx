/**
 * [COMP:app-web/sidebar-panel-feed] Feed rail — static render contract.
 *
 * vitest in app-web is node-only — `renderToString` + module mocks
 * (next/navigation, the sidebar-data provider). Effects never run, so the
 * inbox badge (an effect-driven fetch) stays at zero here; what's asserted
 * is the nav structure: Create rows always, one Platforms row per target
 * platform (connected → insights + expanded sub-rows inside its path,
 * unconnected → connection / coming-soon), hrefs built through `feedPath`.
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
  it("renders the Create rows with feedPath hrefs", () => {
    const html = render([profile("threads", "acme")], "/w/ws-1/feed");
    expect(html).toContain('href="/w/ws-1/feed"');
    expect(html).toContain('href="/w/ws-1/feed/voice"');
    expect(html).toContain('href="/w/ws-1/feed/drafts"');
    expect(html).toContain('href="/w/ws-1/feed/inbox"');
    expect(html).toContain('href="/w/ws-1/feed/ready"');
  });

  it("renders one row per target platform: connected to insights, unconnected to connection", () => {
    const html = render([profile("threads", "acme")], "/w/ws-1/feed");
    // Connected Threads → insights + handle.
    expect(html).toContain('href="/w/ws-1/feed/threads/insights"');
    expect(html).toContain("acme");
    // Unconnected connectable (X) → connection page.
    expect(html).toContain('href="/w/ws-1/feed/twitter/connection"');
    // Create-only targets → connection page (coming-soon stub) + label.
    expect(html).toContain('href="/w/ws-1/feed/instagram/connection"');
    expect(html).toContain('href="/w/ws-1/feed/xhs/connection"');
    expect(html).toContain(en.feedPage.platformStatusComingSoon);
  });

  it("expands sub-rows only inside a connected platform's path", () => {
    const home = render([profile("threads", "acme")], "/w/ws-1/feed");
    expect(home).not.toContain('href="/w/ws-1/feed/threads/inspiration"');
    const inside = render(
      [profile("threads", "acme"), profile("twitter", "acmex")],
      "/w/ws-1/feed/twitter/insights",
    );
    expect(inside).toContain('href="/w/ws-1/feed/twitter/inspiration"');
    expect(inside).toContain('href="/w/ws-1/feed/twitter/settings"');
    // The other platform stays collapsed.
    expect(inside).not.toContain('href="/w/ws-1/feed/threads/inspiration"');
  });

  it("still renders the platform rows with no connected profiles", () => {
    const html = render([], "/w/ws-1/feed");
    expect(html).toContain('href="/w/ws-1/feed/drafts"');
    expect(html).toContain('href="/w/ws-1/feed/threads/connection"');
    expect(html).toContain(en.feedPage.platformStatusNotConnected);
    expect(html).toContain(en.feedPage.platformStatusComingSoon);
  });
});
