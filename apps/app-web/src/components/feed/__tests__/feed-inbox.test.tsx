/**
 * [COMP:app-web/feed-inbox] Feed inbox — static render contract.
 *
 * vitest in app-web is node-only — `renderToString` + module mocks (the
 * feed-home test shape). Effects never run under SSR, so the approvals
 * fetch stays dormant and the page always paints its loading state: header
 * (title, count-less badge slot, subtitle) + the card skeleton grid. The
 * pure card helpers (`deriveKind`, `reminderHref`) are asserted directly —
 * they carry the deep-link contract into `/feed/[platform]/draft-sessions`.
 * Dismiss/filter interactions and the live fetch path are web-QA.
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
import { FeedInbox, deriveKind, reminderHref } from "../feed-inbox";

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

function workspace(profiles: FeedProfile[]): FeedWorkspaceValue {
  return {
    workspaceId: "ws-1",
    name: "Acme Team",
    role: "admin",
    canDraft: true,
    me: { id: "u-1" },
    profiles,
    assistants: [],
    refresh: async () => {},
  };
}

function render(profiles: FeedProfile[]): string {
  workspaceRef.current = workspace(profiles);
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      <FeedInbox />
    </I18nProvider>,
  );
}

describe("[COMP:app-web/feed-inbox] FeedInbox", () => {
  it("renders the header and the loading skeleton (effects never run under SSR)", () => {
    const html = render([profile("threads", "acme")]);
    expect(html).toContain(en.feedPage.sections.inbox);
    expect(html).toContain(en.feedPage.inbox.subtitle);
    // Loading: skeleton cards, no empty state, no filter tab strip.
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain(en.feedPage.inbox.emptyTitle);
    expect(html).not.toContain('role="tablist"');
  });

  it("zero connected assistants still paints the same loading contract", () => {
    const html = render([]);
    expect(html).toContain(en.feedPage.sections.inbox);
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain(en.feedPage.inbox.emptyTitle);
  });

  it("deriveKind: a reply author or reply text marks the card as a reply", () => {
    expect(deriveKind({ metadata: { replyAuthor: "someone" } })).toBe("reply");
    expect(deriveKind({ metadata: { replyText: "hello" } })).toBe("reply");
    expect(deriveKind({ metadata: { draftText: "just a post" } })).toBe(
      "original",
    );
    expect(deriveKind({ metadata: null })).toBe("original");
  });

  it("reminderHref: session-carrying drafts deep-link into the unified session view", () => {
    expect(
      reminderHref("ws-1", {
        platform: "threads",
        metadata: { sessionId: "s-1" },
      }),
    ).toBe("/w/ws-1/feed/threads/draft-sessions/s-1");
    // L5 pipeline drafts (no session) fall back to the platform's list.
    expect(reminderHref("ws-1", { platform: "twitter", metadata: null })).toBe(
      "/w/ws-1/feed/twitter/draft-sessions",
    );
  });
});
