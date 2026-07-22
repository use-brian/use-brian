/**
 * [COMP:app-web/feed-tuning-chat] Feed tuning chat — seed bus + static
 * dock contract.
 *
 * vitest in app-web is node-only — `renderToString` + module mocks (the
 * feed-inbox test shape). Covered here:
 *
 *   - `feed-chat-seed` pure logic: the event name (`feed:chat-seed`, which
 *     must NEVER equal the doc bus's `doc:chat-seed` — the two buses can't
 *     cross-fire), the payload shape, and the empty-prefill drop.
 *   - The collapsed dock's static render: FAB with the open aria-label AND
 *     the always-mounted (hidden) panel — header title, empty-state
 *     suggestions — plus the zero-assistant null render.
 *   - `FeedSurfaceShell` READY state mounts the feed dock alongside the
 *     children (the dock-swap contract; the `chatDockSuppression` hold is
 *     an effect, so its counter semantics are covered by
 *     `lib/__tests__/chat-dock-suppress.test.ts`).
 *
 * Streaming, uploads, model gating, and expand/collapse are web-QA.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

import type { FeedWorkspaceValue } from "@/contexts/feed-profiles-context";

const ctxRef = vi.hoisted(() => ({
  workspace: null as unknown,
  state: null as unknown,
}));

vi.mock("@/lib/auth-fetch", () => ({
  authFetch: vi.fn(),
  getAccessToken: () => null,
}));
vi.mock("@/contexts/feed-profiles-context", () => ({
  FeedProfilesProvider: (props: { children?: React.ReactNode }) =>
    props.children,
  useFeedWorkspace: () => ctxRef.workspace,
  useFeedWorkspaceState: () => ctxRef.state,
}));
// The shell mounts the operator top bar above the gate; its router + layout
// sidebar state don't exist under bare SSR, so mock the hooks it reads.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ back: vi.fn(), forward: vi.fn() }),
}));
vi.mock("@/components/doc/doc-sidebar-data", () => ({
  useSidebarData: () => ({
    sidebarCollapsed: false,
    setSidebarCollapsed: vi.fn(),
  }),
}));

import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import type { FeedProfile } from "@/lib/api/feed";
import {
  FEED_CHAT_SEED_EVENT,
  requestFeedChatSeed,
} from "@/lib/feed-chat-seed";
import { CHAT_SEED_EVENT as DOC_CHAT_SEED_EVENT } from "@/lib/chat-seed";
import { FeedFloatingChat } from "../feed-floating-chat";
import { FeedSurfaceShell } from "../feed-surface-shell";

const dict = en as unknown as Dictionary;

afterEach(() => {
  vi.unstubAllGlobals();
});

function profile(handle: string, assistantId = `a-${handle}`): FeedProfile {
  return {
    assistantId,
    platform: "threads",
    platformHandle: handle,
    profilePictureUrl: null,
    enabled: true,
    assistant: { id: assistantId, name: handle, iconSeed: 0 },
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

function renderDock(profiles: FeedProfile[]): string {
  ctxRef.workspace = workspace(profiles);
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      <FeedFloatingChat />
    </I18nProvider>,
  );
}

describe("[COMP:app-web/feed-tuning-chat] feed chat seed bus", () => {
  it("uses its own event name, distinct from the doc chat-seed bus", () => {
    expect(FEED_CHAT_SEED_EVENT).toBe("feed:chat-seed");
    expect(FEED_CHAT_SEED_EVENT).not.toBe(DOC_CHAT_SEED_EVENT);
  });

  it("dispatches a one-shot CustomEvent with the seed payload; empty prefills are dropped", () => {
    const dispatched: Array<{ type: string; detail: unknown }> = [];
    class FakeCustomEvent {
      type: string;
      detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    }
    vi.stubGlobal("CustomEvent", FakeCustomEvent);
    vi.stubGlobal("window", {
      dispatchEvent: (e: FakeCustomEvent) => {
        dispatched.push({ type: e.type, detail: e.detail });
        return true;
      },
    });

    requestFeedChatSeed({ prefill: "About this voice rule…", researchMode: true });
    requestFeedChatSeed({ prefill: "   " });

    expect(dispatched).toEqual([
      {
        type: "feed:chat-seed",
        detail: { prefill: "About this voice rule…", researchMode: true },
      },
    ]);
  });
});

describe("[COMP:app-web/feed-tuning-chat] FeedFloatingChat", () => {
  it("collapsed dock: renders the FAB and the always-mounted (hidden) panel", () => {
    const html = renderDock([profile("acme")]);
    // FAB (the collapsed state's only visible affordance).
    expect(html).toContain(en.feedPage.tuningChat.openAria);
    // Panel is mounted even while collapsed — header + empty state ship in
    // the initial markup so an expand never remounts the conversation.
    expect(html).toContain(en.feedPage.tuningChat.title);
    expect(html).toContain(en.feedPage.tuningChat.emptyTitle);
    expect(html).toContain(en.feedPage.tuningChat.suggestion2);
  });

  it("no connected assistant: renders nothing (feed home owns the empty state)", () => {
    const html = renderDock([]);
    expect(html).not.toContain(en.feedPage.tuningChat.openAria);
    expect(html).not.toContain(en.feedPage.tuningChat.title);
  });
});

describe("[COMP:app-web/feed-tuning-chat] FeedSurfaceShell dock swap", () => {
  it("READY state mounts the feed dock alongside the children", () => {
    ctxRef.workspace = workspace([profile("acme")]);
    ctxRef.state = { status: "ready", value: ctxRef.workspace };
    const html = renderToString(
      <I18nProvider locale="en" dict={dict}>
        <FeedSurfaceShell workspaceId="ws-1">
          <div data-feed-page>page body</div>
        </FeedSurfaceShell>
      </I18nProvider>,
    );
    expect(html).toContain("data-feed-page");
    expect(html).toContain(en.feedPage.tuningChat.openAria);
  });

  it("loading state renders neither the children nor the dock", () => {
    ctxRef.state = { status: "loading" };
    const html = renderToString(
      <I18nProvider locale="en" dict={dict}>
        <FeedSurfaceShell workspaceId="ws-1">
          <div data-feed-page>page body</div>
        </FeedSurfaceShell>
      </I18nProvider>,
    );
    expect(html).toContain(en.feedPage.shell.loading);
    expect(html).not.toContain("data-feed-page");
    expect(html).not.toContain(en.feedPage.tuningChat.openAria);
  });
});
