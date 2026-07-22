/**
 * [COMP:app-web/feed-policy] Feed reply policy — static render contract +
 * the ported pure helpers.
 *
 * vitest in app-web is node-only — `renderToString` + module mocks (the
 * feed-inbox test shape). Effects never run under SSR, so a connected
 * platform stays in the loading-skeleton contract and the not-connected
 * empty state renders its feed-home setup link. The line-list
 * serialization pair (`parsePolicyList`/`formatPolicyList`) carries the
 * PATCH body contract and is asserted directly. Mode selection, save, and
 * the raw-JSON disclosure are web-QA.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

import type { FeedWorkspaceValue } from "@/contexts/feed-profiles-context";

const workspaceRef = vi.hoisted(
  () => ({ current: null }) as { current: unknown },
);
const paramsRef = vi.hoisted(
  () => ({ current: {} }) as { current: Record<string, string> },
);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => paramsRef.current,
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
import { format } from "@/lib/i18n/format";
import type { FeedProfile } from "@/lib/api/feed";
import { FeedPolicy, formatPolicyList, parsePolicyList } from "../feed-policy";

const dict = en as unknown as Dictionary;
const td = en.feedPage.policy;

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
    role: "owner",
    canDraft: true,
    me: { id: "u-1" },
    profiles,
    assistants: [],
    refresh: async () => {},
  };
}

function render(profiles: FeedProfile[], platform = "threads"): string {
  workspaceRef.current = workspace(profiles);
  paramsRef.current = { workspaceId: "ws-1", platform };
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      <FeedPolicy />
    </I18nProvider>,
  );
}

describe("[COMP:app-web/feed-policy] FeedPolicy", () => {
  it("not connected: empty state with the feed-home setup link", () => {
    const html = render([], "threads");
    expect(html).toContain(format(td.notConnectedTitle, { platform: "Threads" }));
    expect(html).toContain(format(td.notConnectedBody, { platform: "Threads" }));
    expect(html).toContain(td.startSetup);
    expect(html).toContain('href="/w/ws-1/feed"');
  });

  it("connected platform renders the loading-skeleton contract (SSR, effect dormant)", () => {
    const html = render([profile("twitter", "acme")], "twitter");
    expect(html).toContain("skeleton");
    // The form only renders after the profile-detail fetch resolves.
    expect(html).not.toContain(format(td.heading, { platform: "X" }));
    expect(html).not.toContain(td.saveCta);
  });

  it("parsePolicyList: one entry per line, trimmed, empties dropped, CRLF-safe", () => {
    expect(parsePolicyList("alice\n  bob \n\n\r\ncarol\r\n")).toEqual([
      "alice",
      "bob",
      "carol",
    ]);
    expect(parsePolicyList("")).toEqual([]);
    expect(parsePolicyList("   \n \n")).toEqual([]);
  });

  it("formatPolicyList: newline-joined textarea seed; missing list renders empty", () => {
    expect(formatPolicyList(["alice", "bob"])).toBe("alice\nbob");
    expect(formatPolicyList([])).toBe("");
    expect(formatPolicyList(undefined)).toBe("");
  });

  it("round-trip: format → parse is identity for clean lists", () => {
    const list = ["trustedhandle1", "trustedhandle2"];
    expect(parsePolicyList(formatPolicyList(list))).toEqual(list);
  });
});
