/**
 * [COMP:app-web/feed-connection] Feed connection — static render contract.
 *
 * vitest in app-web is node-only — `renderToString` + module mocks (the
 * feed-inbox test shape). Effects never run under SSR, so the page renders
 * its synchronous states: the not-connected onboarding (admin-gated connect
 * CTA vs the admins-only notice) and the connected card (handle, enabled /
 * disabled badge, assistant name, admin-gated reconnect + disconnect).
 * The OAuth redirect, disconnect confirm, and `refresh()` flows are web-QA.
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
import { FeedConnection } from "../feed-connection";

const dict = en as unknown as Dictionary;
const td = en.feedPage.connection;

function profile(
  platform: FeedProfile["platform"],
  handle: string,
  opts: { enabled?: boolean } = {},
): FeedProfile {
  return {
    assistantId: `a-${handle}`,
    platform,
    platformHandle: handle,
    profilePictureUrl: null,
    enabled: opts.enabled ?? true,
    assistant: { id: `a-${handle}`, name: `${handle} voice`, iconSeed: 0 },
  };
}

function workspace(
  profiles: FeedProfile[],
  role: FeedWorkspaceValue["role"],
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

function render(
  profiles: FeedProfile[],
  role: FeedWorkspaceValue["role"] = "owner",
  platform = "threads",
): string {
  workspaceRef.current = workspace(profiles, role);
  paramsRef.current = { workspaceId: "ws-1", platform };
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      <FeedConnection />
    </I18nProvider>,
  );
}

describe("[COMP:app-web/feed-connection] FeedConnection", () => {
  it("not connected + admin: onboarding header and the connect CTA", () => {
    const html = render([], "admin");
    expect(html).toContain(format(td.notConnectedTitle, { platform: "Threads" }));
    expect(html).toContain(
      format(td.notConnectedBody, { platform: "Threads" }),
    );
    expect(html).toContain(td.connectCta);
    expect(html).not.toContain(td.adminOnlyConnect);
  });

  it("not connected + member: admins-only notice, no connect CTA", () => {
    const html = render([], "member");
    expect(html).toContain(td.adminOnlyConnect);
    expect(html).not.toContain(td.connectCta);
  });

  it("connected + admin: heading, handle, enabled badge, reconnect + disconnect", () => {
    const html = render([profile("threads", "acme")], "owner");
    expect(html).toContain(format(td.heading, { platform: "Threads" }));
    expect(html).toContain(td.subtitle);
    // SSR splits the `@{handle}` text nodes with a comment marker.
    expect(html).toContain(td.handleLabel);
    expect(html).toContain("acme");
    expect(html).toContain(td.statusEnabled);
    expect(html).toContain("acme voice");
    expect(html).toContain(td.reconnect);
    expect(html).toContain(td.disconnect);
    expect(html).not.toContain(td.adminOnlyManage);
  });

  it("connected + member: admins-only manage notice, no action buttons", () => {
    const html = render([profile("threads", "acme")], "member");
    expect(html).toContain(td.adminOnlyManage);
    expect(html).not.toContain(td.reconnect);
    expect(html).not.toContain(td.disconnect);
  });

  it("disabled profile renders the amber disabled badge under the X label", () => {
    const html = render(
      [profile("twitter", "acme", { enabled: false })],
      "owner",
      "twitter",
    );
    expect(html).toContain(format(td.heading, { platform: "X" }));
    expect(html).toContain(td.statusDisabled);
    expect(html).not.toContain(td.statusEnabled);
  });
});
