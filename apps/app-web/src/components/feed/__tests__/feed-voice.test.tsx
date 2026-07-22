/**
 * [COMP:app-web/feed-voice] Feed voice — static render contract.
 *
 * vitest in app-web is node-only — `renderToString` + module mocks (the
 * feed-inbox test shape). Effects never run under SSR, so the memories
 * fetch stays dormant and the page paints its loading state: header
 * (Voice title, rule-count badge, subtitle, admin-gated "Inject rule") +
 * the card skeleton list. The zero-profile branch renders the
 * no-voice state whose CTA links to the feed home (feed-web's /onboarding
 * is not ported — §5 route map). The pure helpers (`parseTags`,
 * `buildDiscussPrompt`) are asserted directly — they carry the tag-split
 * and Discuss-seed contracts. CRUD forms, filters, and the discuss seed
 * dispatch are web-QA.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

import type { FeedWorkspaceValue } from "@/contexts/feed-profiles-context";

const workspaceRef = vi.hoisted(
  () => ({ current: null }) as { current: unknown },
);

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
import { FeedVoice, buildDiscussPrompt, parseTags } from "../feed-voice";

const dict = en as unknown as Dictionary;

function profile(handle: string): FeedProfile {
  return {
    assistantId: `a-${handle}`,
    platform: "threads",
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

function render(value: FeedWorkspaceValue): string {
  workspaceRef.current = value;
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      <FeedVoice />
    </I18nProvider>,
  );
}

describe("[COMP:app-web/feed-voice] FeedVoice", () => {
  it("renders the header and the loading skeletons (effects never run under SSR)", () => {
    const html = render(workspace([profile("acme")]));
    expect(html).toContain(en.feedPage.sections.voice);
    expect(html).toContain(en.feedPage.voice.subtitle);
    // Admin sees the Inject rule button even while loading. (Anchor on the
    // closing tag — the subtitle prose also contains "Inject rule".)
    expect(html).toContain(`${en.feedPage.voice.injectRule}</button>`);
    // Loading: skeleton cards, no empty state.
    expect(html).toContain("skeleton");
    expect(html).not.toContain(en.feedPage.voice.emptyTitle);
  });

  it("hides the Inject rule button from non-admin members", () => {
    const html = render(workspace([profile("acme")], "member"));
    expect(html).toContain(en.feedPage.sections.voice);
    expect(html).not.toContain(`${en.feedPage.voice.injectRule}</button>`);
  });

  it("zero profiles: renders the no-voice state with a CTA into the feed home", () => {
    const html = render(workspace([]));
    expect(html).toContain(en.feedPage.voice.noVoiceTitle);
    expect(html).toContain(en.feedPage.voice.noVoiceCta);
    // feed-web linked /onboarding; the port lands on the feed home, which
    // owns the connect-account onboarding (§5 route map).
    expect(html).toContain('href="/w/ws-1/feed"');
  });

  it("parseTags: splits on commas, trims, and drops empties", () => {
    expect(parseTags("tone, sign-off ,twitter")).toEqual([
      "tone",
      "sign-off",
      "twitter",
    ]);
    expect(parseTags("  ,, ")).toEqual([]);
    expect(parseTags("")).toEqual([]);
  });

  it("buildDiscussPrompt: quotes the rule, carries tags, drops blank summaries", () => {
    const t = en.feedPage.voice;
    expect(
      buildDiscussPrompt(t, {
        summary: "Always sign off with the team.",
        tags: ["tone", "sign-off"],
      }),
    ).toBe(
      "About this voice rule (tags: tone, sign-off):\n\n> Always sign off with the team.\n\nWhat would you change, soften, or split into a sharper rule?",
    );
    expect(
      buildDiscussPrompt(t, { summary: "No tags here.", tags: null }),
    ).toBe(
      "About this voice rule:\n\n> No tags here.\n\nWhat would you change, soften, or split into a sharper rule?",
    );
    expect(buildDiscussPrompt(t, { summary: "   ", tags: ["x"] })).toBeNull();
    expect(buildDiscussPrompt(t, { summary: null, tags: null })).toBeNull();
  });
});
