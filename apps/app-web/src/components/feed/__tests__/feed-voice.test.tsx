/**
 * [COMP:app-web/feed-voice] Feed voice — static render contract.
 *
 * vitest in app-web is node-only — `renderToString` + module mocks (the
 * feed-inbox test shape). Effects never run under SSR, so the memories
 * fetch stays dormant and the page paints its loading state: header
 * (Voice title, rule-count badge, subtitle, admin-gated build controls) +
 * the card skeleton list. The zero-profile branch renders the
 * no-voice state whose CTA links to the feed home (feed-web's /onboarding
 * is not ported — §5 route map). The pure helpers (`parseTags`,
 * `buildDiscussPrompt`, `parseVoiceDetail`, `adjacentVoiceId`) are asserted
 * directly; the selected-rule render covers structured detail and persistent
 * refine controls. CRUD forms, filters, and seed dispatch are browser QA.
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
import {
  FeedVoice,
  VoiceRuleDetail,
  adjacentVoiceId,
  buildDiscussPrompt,
  parseTags,
  parseVoiceDetail,
} from "../feed-voice";

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
    brand: null,
    refresh: async () => {},
  };
}

function render(value: FeedWorkspaceValue): string {
  workspaceRef.current = value;
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      <FeedVoice scope="threads" />
    </I18nProvider>,
  );
}

describe("[COMP:app-web/feed-voice] FeedVoice", () => {
  it("renders the header and the loading skeletons (effects never run under SSR)", () => {
    const html = render(workspace([profile("acme")]));
    // The rail opens on a platform, and the heading names that scope rather
    // than the surface (feed-revamp.md D3).
    expect(html).toContain("Threads voice");
    // The scope rail is retired: the sidebar owns scope now (D13), so the
    // pane states its scope in the subtitle instead.
    expect(html).toContain("on top of the baseline");
    // Admin sees the add-rule button even while loading. Anchor on the
    // closing tag because the empty-state prose also contains its label.
    expect(html).toContain(`${en.feedPage.voice.injectRule}</button>`);
    // Admin sees the import menu trigger and the guided build action. The two
    // import items live in a closed Base UI portal, so their interaction is
    // browser QA (feed-import-account.md D8).
    expect(html).toContain(en.feedPage.voice.importMenu);
    expect(html).toContain(en.feedPage.voice.buildWithChat);
    // Loading: skeleton cards, no empty state.
    expect(html).toContain("skeleton");
    expect(html).not.toContain(en.feedPage.voice.emptyTitle);
  });

  it("hides voice-building controls from non-admin members", () => {
    const html = render(workspace([profile("acme")], "member"));
    expect(html).toContain("Threads voice");
    expect(html).not.toContain(`${en.feedPage.voice.injectRule}</button>`);
    expect(html).not.toContain(en.feedPage.voice.importMenu);
    expect(html).not.toContain(en.feedPage.voice.buildWithChat);
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

  it("turns imported plain-text detail into readable headings and lists", () => {
    expect(
      parseVoiceDetail(
        "Positioning:\n- Lead with firsthand experience\n- Prefer concrete examples\n\nKeep the tone understated.\nAvoid hype.",
      ),
    ).toEqual([
      { kind: "heading", text: "Positioning" },
      {
        kind: "list",
        ordered: false,
        items: ["Lead with firsthand experience", "Prefer concrete examples"],
      },
      {
        kind: "paragraph",
        text: "Keep the tone understated. Avoid hype.",
      },
    ]);
  });

  it("steps through visible rules without wrapping", () => {
    const items = [{ id: "one" }, { id: "two" }, { id: "three" }];
    expect(adjacentVoiceId(items, "two", -1)).toBe("one");
    expect(adjacentVoiceId(items, "two", 1)).toBe("three");
    expect(adjacentVoiceId(items, "one", -1)).toBeNull();
    expect(adjacentVoiceId(items, "three", 1)).toBeNull();
  });

  it("renders one selected rule as structured prose with persistent refine controls", () => {
    const html = renderToString(
      <I18nProvider locale="en" dict={dict}>
        <VoiceRuleDetail
          memory={{
            id: "voice-1",
            type: "voice",
            summary: "Write like an experienced operator",
            detail: "Principles:\n- Use concrete examples\n- Name the tradeoff",
            tags: ["linkedin", "tone"],
            sensitivity: "public",
            updatedAt: "2026-08-30T00:00:00.000Z",
          }}
          isAdmin
          deleting={false}
          position={1}
          total={3}
          previousId={null}
          nextId="voice-2"
          onSelect={() => {}}
          onEdit={() => {}}
          onDelete={() => {}}
          onDiscuss={() => {}}
        />
      </I18nProvider>,
    );

    expect(html).toContain("Write like an experienced operator");
    expect(html).toContain("<ul");
    expect(html).toContain("Use concrete examples");
    expect(html).toContain(en.feedPage.voice.refineInChat);
    expect(html).toContain(en.feedPage.voice.nextRule);
  });
});
