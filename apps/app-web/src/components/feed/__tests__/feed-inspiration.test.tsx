/**
 * [COMP:app-web/feed-inspiration] Feed inspiration — static render contract
 * + the ported pure helpers.
 *
 * vitest in app-web is node-only — `renderToString` + module mocks (the
 * feed-inbox test shape). Effects never run under SSR, so the config fetch
 * stays dormant (`config === null` → the no-keywords contract): header with
 * the Config button and a disabled Run button, plus the no-keywords empty
 * state gated on `canDraft`; the connect-first gate renders when the
 * platform has no profile. The pure helpers (`applyAddKeyword`,
 * `normalizeInspirationConfig`, `buildInspirationSeed`) carry the config
 * and seed contracts and are asserted directly. Scan flow, the config
 * modal, and draft creation are web-QA.
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
  FeedInspiration,
  applyAddKeyword,
  buildInspirationSeed,
  normalizeInspirationConfig,
} from "../feed-inspiration";

const dict = en as unknown as Dictionary;
const td = en.feedPage.inspiration;

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
  opts: { canDraft?: boolean } = {},
): FeedWorkspaceValue {
  return {
    workspaceId: "ws-1",
    name: "Acme Team",
    role: "member",
    canDraft: opts.canDraft ?? true,
    me: { id: "u-1" },
    profiles,
    assistants: [],
    refresh: async () => {},
  };
}

function render(
  profiles: FeedProfile[],
  platform = "threads",
  opts: { canDraft?: boolean } = {},
): string {
  workspaceRef.current = workspace(profiles, opts);
  paramsRef.current = { workspaceId: "ws-1", platform };
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      <FeedInspiration />
    </I18nProvider>,
  );
}

describe("[COMP:app-web/feed-inspiration] FeedInspiration", () => {
  it("renders the header + no-keywords contract while the config is unloaded (SSR)", () => {
    const html = render([profile("threads", "acme")]);
    expect(html).toContain("Inspiration · Threads");
    // config === null → the no-keywords subtitle and a disabled Run.
    expect(html).toContain(td.subtitleNoKeywords);
    expect(html).toContain(td.configButton);
    expect(html).toContain(td.runButton);
    expect(html).toContain("disabled");
    // Empty-state body for draft-capable users, with the Config CTA.
    expect(html).toContain(td.noKeywordsTitle);
    expect(html).toContain(td.noKeywordsBodyCanEdit);
    expect(html).toContain(td.openConfig);
    // The modal is closed by default.
    expect(html).not.toContain(td.configModalTitle);
  });

  it("twitter platform renders under the X label", () => {
    const html = render([profile("twitter", "acme")], "twitter");
    expect(html).toContain("Inspiration · X");
  });

  it("read-only members see the ask-for-access body and no Config CTA", () => {
    const html = render([profile("threads", "acme")], "threads", {
      canDraft: false,
    });
    expect(html).toContain(td.noKeywordsTitle);
    expect(html).toContain(td.noKeywordsBodyNoEdit);
    expect(html).not.toContain(td.openConfig);
  });

  it("not-connected platform renders the connect-first gate linking to the feed home", () => {
    const html = render([], "twitter");
    expect(html).toContain("Connect X first");
    expect(html).toContain("Connect a X account to run inspiration scans.");
    expect(html).toContain('href="/w/ws-1/feed"');
    expect(html).not.toContain(td.runButton);
  });

  it("applyAddKeyword: trims + caps at 100 chars; rejects empties, duplicates, and a full list", () => {
    expect(applyAddKeyword([], "  ai agents  ")).toEqual(["ai agents"]);
    expect(applyAddKeyword(["ai"], "ai")).toBeNull();
    expect(applyAddKeyword(["ai"], "   ")).toBeNull();
    const long = "x".repeat(120);
    expect(applyAddKeyword([], long)).toEqual(["x".repeat(100)]);
    const full = Array.from({ length: 20 }, (_, i) => `kw${i}`);
    expect(applyAddKeyword(full, "one more")).toBeNull();
  });

  it("normalizeInspirationConfig: fills defaults and guarantees a keyword list", () => {
    expect(normalizeInspirationConfig(undefined)).toEqual({
      keywords: [],
      resultCount: 5,
    });
    expect(
      normalizeInspirationConfig({ keywords: ["ai"], resultCount: 9 }),
    ).toEqual({ keywords: ["ai"], resultCount: 9 });
  });

  it("buildInspirationSeed maps a candidate onto the seed the backend parses (no permalink)", () => {
    const seed = buildInspirationSeed("inspiration-reply", "twitter", {
      externalId: "123",
      text: "worth replying to",
      author: { handle: "bob", displayName: "Bob" },
    });
    expect(seed).toEqual({
      kind: "inspiration-reply",
      candidate: {
        platform: "twitter",
        externalId: "123",
        text: "worth replying to",
        authorHandle: "bob",
      },
    });
  });
});
