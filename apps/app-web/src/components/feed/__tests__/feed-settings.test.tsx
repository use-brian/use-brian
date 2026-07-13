/**
 * [COMP:app-web/feed-settings] Feed settings (index + members) — static
 * render contracts + the ported pure helpers.
 *
 * vitest in app-web is node-only — `renderToString` + module mocks (the
 * feed-inbox test shape). The settings index is fully synchronous: the
 * three cards and their `feedPath` hrefs are asserted for connected and
 * not-connected platforms. The members page's effect never runs under SSR,
 * so it stays in the loading-skeleton contract; the admin gate banner and
 * the back link are static. The list-order / display-name / effective-
 * permission helpers (`sortMembersByRole`, `memberDisplayName`,
 * `effectiveDraftAccess`) are asserted directly. The toggle round-trip
 * (optimistic update + revert) is web-QA.
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
import type { FeedProfile, FeedWorkspaceMember } from "@/lib/api/feed";
import { FeedSettings } from "../feed-settings";
import {
  FeedSettingsMembers,
  effectiveDraftAccess,
  memberDisplayName,
  sortMembersByRole,
} from "../feed-settings-members";

const dict = en as unknown as Dictionary;
const td = en.feedPage.settings;

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
  role: FeedWorkspaceValue["role"] = "owner",
): FeedWorkspaceValue {
  return {
    workspaceId: "ws-1",
    name: "Acme Team",
    role,
    canDraft: true,
    me: { id: "u-1" },
    profiles,
    refresh: async () => {},
  };
}

function render(
  node: React.ReactElement,
  profiles: FeedProfile[],
  opts: { role?: FeedWorkspaceValue["role"]; platform?: string } = {},
): string {
  workspaceRef.current = workspace(profiles, opts.role ?? "owner");
  paramsRef.current = {
    workspaceId: "ws-1",
    platform: opts.platform ?? "threads",
  };
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      {node}
    </I18nProvider>,
  );
}

function member(
  userId: string,
  role: FeedWorkspaceMember["role"],
  overrides: Partial<FeedWorkspaceMember> = {},
): FeedWorkspaceMember {
  return {
    id: `wm-${userId}`,
    userId,
    email: `${userId}@acme.io`,
    userName: null,
    avatarUrl: null,
    role,
    canDraft: false,
    ...overrides,
  };
}

describe("[COMP:app-web/feed-settings] FeedSettings + FeedSettingsMembers", () => {
  it("settings index (connected): heading, connected-as subtitle, three feedPath cards", () => {
    const html = render(<FeedSettings />, [profile("threads", "acme")]);
    expect(html).toContain(format(td.heading, { platform: "Threads" }));
    expect(html).toContain(format(td.connectedAs, { handle: "acme" }));
    expect(html).toContain(td.policyTitle);
    expect(html).toContain(format(td.connectionDescConnected, { handle: "acme" }));
    expect(html).toContain(td.membersTitle);
    expect(html).toContain('href="/w/ws-1/feed/threads/policy"');
    expect(html).toContain('href="/w/ws-1/feed/threads/connection"');
    expect(html).toContain('href="/w/ws-1/feed/threads/settings/members"');
  });

  it("settings index (not connected): not-connected subtitle + connect card copy", () => {
    const html = render(<FeedSettings />, [], { platform: "twitter" });
    expect(html).toContain(format(td.heading, { platform: "X" }));
    expect(html).toContain(format(td.notConnectedSubtitle, { platform: "X" }));
    expect(html).toContain(
      format(td.connectionDescNotConnected, { platform: "X" }),
    );
    expect(html).toContain('href="/w/ws-1/feed/twitter/settings/members"');
  });

  it("members page (SSR): back link, header, draft-access intro, loading skeleton; no admin banner for owners", () => {
    const html = render(<FeedSettingsMembers />, [profile("threads", "acme")]);
    expect(html).toContain('href="/w/ws-1/feed/threads/settings"');
    expect(html).toContain(td.membersTitle);
    expect(html).toContain(td.membersIntroBefore);
    expect(html).toContain(td.draftAccess);
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain(td.membersAdminOnly);
  });

  it("members page: non-admin viewers see the admins-only banner", () => {
    const html = render(<FeedSettingsMembers />, [profile("threads", "acme")], {
      role: "member",
    });
    expect(html).toContain(td.membersAdminOnly);
  });

  it("sortMembersByRole: owners, then admins, then members; input untouched", () => {
    const input = [
      member("u-3", "member"),
      member("u-1", "owner"),
      member("u-2", "admin"),
    ];
    expect(sortMembersByRole(input).map((m) => m.userId)).toEqual([
      "u-1",
      "u-2",
      "u-3",
    ]);
    expect(input[0].userId).toBe("u-3");
  });

  it("memberDisplayName: trimmed name → email → 8-char id prefix", () => {
    expect(
      memberDisplayName({ userName: "  Ada  ", email: "a@b.c", userId: "x" }),
    ).toBe("Ada");
    expect(
      memberDisplayName({ userName: "   ", email: "a@b.c", userId: "x" }),
    ).toBe("a@b.c");
    expect(
      memberDisplayName({
        userName: null,
        email: null,
        userId: "0123456789abcdef",
      }),
    ).toBe("01234567");
  });

  it("effectiveDraftAccess: owner/admin always on; members follow canDraft", () => {
    expect(effectiveDraftAccess({ role: "owner", canDraft: false })).toBe(true);
    expect(effectiveDraftAccess({ role: "admin", canDraft: false })).toBe(true);
    expect(effectiveDraftAccess({ role: "member", canDraft: false })).toBe(false);
    expect(effectiveDraftAccess({ role: "member", canDraft: true })).toBe(true);
  });
});
