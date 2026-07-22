/**
 * [COMP:app-web/feed-ready] Ready-to-post queue — static render contract.
 *
 * Node-only renderToString + module mocks (the feed test-file pattern).
 * Effects never run, so the list stays in its loading shell; what's
 * asserted is the page chrome: heading, subtitle, and that the component
 * mounts with zero profiles (the Create split's zero-connection contract).
 */

import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

const workspaceRef = vi.hoisted(
  () => ({ current: null }) as { current: unknown },
);

vi.mock("next/navigation", () => ({
  usePathname: () => "/w/ws-1/feed/ready",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ workspaceId: "ws-1" }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/contexts/feed-profiles-context", () => ({
  useFeedWorkspace: () => workspaceRef.current,
}));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));

import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { FeedReady } from "../feed-ready";

const dict = en as unknown as Dictionary;

function render(assistants: Array<{ id: string; name: string }>): string {
  workspaceRef.current = {
    workspaceId: "ws-1",
    name: "Acme Team",
    role: "admin",
    canDraft: true,
    me: { id: "u-1" },
    profiles: [],
    assistants,
    refresh: async () => {},
  };
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      <FeedReady />
    </I18nProvider>,
  );
}

describe("[COMP:app-web/feed-ready] FeedReady", () => {
  it("renders the heading and subtitle with zero connections", () => {
    const html = render([{ id: "a-brand", name: "Brand EN" }]);
    expect(html).toContain(en.feedPage.sections.ready);
    expect(html).toContain(en.feedPage.ready.subtitle);
  });

  it("mounts with no assistants at all (empty queue shell)", () => {
    const html = render([]);
    expect(html).toContain(en.feedPage.sections.ready);
  });
});
