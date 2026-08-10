/**
 * [COMP:app-web/feed-draft-sessions] Draft-session list render contracts and
 * pure helpers.
 *
 * vitest in app-web is node-only — `renderToString` + module mocks (the
 * feed-inbox test shape). Effects never run under SSR, so the list always
 * paints its loading skeleton. The no-brand and unconnected-platform paths
 * are rendered explicitly. Interactive list behavior remains web-QA; the
 * exported URL, status, filter, and card helpers are asserted directly.
 *
 * SSR quirk: adjacent text/expression JSX renders with comment-node
 * separators — assertions stick to substrings that live inside a single
 * expression.
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
import type { FeedProfile } from "@/lib/api/feed";
import {
  DraftSessionsList,
  deriveCardKind,
  deriveStatus,
  displayDraftText,
  parseFilterParam,
  parseReplyUrl,
} from "../draft-sessions-list";

const dict = en as unknown as Dictionary;
const td = en.feedPage.draftSessions;

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
    brand: null,
    refresh: async () => {},
  };
}

function renderList(
  profiles: FeedProfile[],
  assistants: Array<{ id: string; name: string }> = [],
): string {
  workspaceRef.current = { ...workspace(profiles), assistants };
  paramsRef.current = { workspaceId: "ws-1", platform: "threads" };
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      <DraftSessionsList />
    </I18nProvider>,
  );
}

describe("[COMP:app-web/feed-draft-sessions] Draft sessions", () => {
  // ── List: static render contract ─────────────────────────────

  it("list: renders the header, the composer stack, and the loading skeleton", () => {
    const html = renderList([profile("threads", "acme")]);
    expect(html).toContain("Drafts · Threads");
    expect(html).toContain(td.subtitle);
    // canDraft → the reply-input + new-post pair.
    expect(html).toContain(td.newReply);
    expect(html).toContain(td.newPost);
    // Loading skeleton, not the empty state, no filter strip yet.
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain(td.emptyTitle);
    expect(html).not.toContain('role="tablist"');
  });

  it("list: no brand voice at all paints the no-brand gate linking to the feed home", () => {
    const html = renderList([]);
    expect(html).toContain(td.noBrandTitle);
    expect(html).toContain("/w/ws-1/feed");
    expect(html).not.toContain(td.subtitle);
  });

  it("list: an unconnected platform still drafts via the brand assistant (feed-create-split D7/D8)", () => {
    const html = renderList([], [{ id: "a-brand", name: "Brand EN" }]);
    expect(html).toContain("Drafts · Threads");
    expect(html).toContain(td.subtitle);
    expect(html).toContain(td.newPost);
  });

  // ── List: pure helpers ───────────────────────────────────────

  it("parseReplyUrl: Threads and X post URLs parse to structured reply candidates", () => {
    expect(
      parseReplyUrl("https://www.threads.com/@jane.doe/post/DX4FjS5Gl5x"),
    ).toEqual({
      platform: "threads",
      handle: "jane.doe",
      externalId: "DX4FjS5Gl5x",
      permalink: "https://www.threads.com/@jane.doe/post/DX4FjS5Gl5x",
    });
    // threads.net + x.com/twitter.com all normalize.
    expect(
      parseReplyUrl("https://threads.net/@bob/post/Cxyz")?.permalink,
    ).toBe("https://www.threads.com/@bob/post/Cxyz");
    expect(parseReplyUrl("https://twitter.com/bob/status/123456")).toEqual({
      platform: "twitter",
      handle: "bob",
      externalId: "123456",
      permalink: "https://x.com/bob/status/123456",
    });
    // Junk: wrong host, missing @, non-numeric status id, non-URL.
    expect(parseReplyUrl("https://example.com/@a/post/B")).toBeNull();
    expect(parseReplyUrl("https://threads.com/jane/post/DX4")).toBeNull();
    expect(parseReplyUrl("https://x.com/bob/status/notanid")).toBeNull();
    expect(parseReplyUrl("not a url")).toBeNull();
  });

  it("deriveStatus: the strongest act-on-me signal wins", () => {
    const counts = (
      pending: number,
      posted: number,
      rejected: number,
      deleted: number,
      draftText: string | null = null,
      ready = 0,
    ) => ({ draftCounts: { pending, ready, posted, rejected, deleted }, draftText });
    expect(deriveStatus(counts(1, 2, 3, 4))).toBe("ready");
    expect(deriveStatus(counts(0, 0, 0, 0, null, 1))).toBe("ready-to-post");
    expect(deriveStatus(counts(0, 1, 1, 1))).toBe("posted");
    expect(deriveStatus(counts(0, 0, 1, 1))).toBe("deleted");
    expect(deriveStatus(counts(0, 0, 1, 0))).toBe("resolved");
    expect(deriveStatus(counts(0, 0, 0, 0, "draft"))).toBe("drafting");
    expect(deriveStatus(counts(0, 0, 0, 0))).toBe("in-progress");
  });

  it("parseFilterParam: known ids pass through, junk falls back to all", () => {
    expect(parseFilterParam("posted")).toBe("posted");
    expect(parseFilterParam("in-progress")).toBe("in-progress");
    expect(parseFilterParam("bogus")).toBe("all");
    expect(parseFilterParam(null)).toBe("all");
  });

  it("displayDraftText + deriveCardKind: saved draft wins over the chat candidate; reply target wins over both", () => {
    expect(
      displayDraftText({
        selectedDraft: { text: "saved", status: "posted" },
        draftText: "chat",
      }),
    ).toBe("saved");
    expect(displayDraftText({ selectedDraft: null, draftText: "chat" })).toBe(
      "chat",
    );
    expect(
      deriveCardKind({
        replyTarget: { authorHandle: "a", text: "t", permalink: null },
        selectedDraft: null,
        draftText: "x",
      }),
    ).toBe("reply");
    expect(
      deriveCardKind({ replyTarget: null, selectedDraft: null, draftText: "x" }),
    ).toBe("original");
    expect(
      deriveCardKind({ replyTarget: null, selectedDraft: null, draftText: null }),
    ).toBe("pending");
  });
});
