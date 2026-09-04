/**
 * [COMP:app-web/feed-tuning-chat] Feed tuning chat — seed bus + static
 * dock contract.
 *
 * vitest in app-web is node-only — `renderToString` + module mocks (the
 * feed-inbox test shape). Covered here:
 *
 *   - Feed chat open + seed buses: distinct event names, seed payload, and
 *     the empty-prefill drop.
 *   - The collapsed dock's static render: the launcher pill (open aria-label
 *     + explicit idle creation copy — the app-standard pill idiom, not a
 *     FAB), live tool/text/thinking label priority, AND the always-mounted
 *     (hidden) panel — header title, empty-state suggestions, and the global
 *     dock's top/left/corner resize chrome — plus the zero-assistant null
 *     render.
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
import type { DockRecorderApi } from "@/lib/recorder/use-dock-recorder";

const ctxRef = vi.hoisted(() => ({
  workspace: null as unknown,
  state: null as unknown,
}));
const recorderRef = vi.hoisted(() => ({
  current: null as DockRecorderApi | null,
}));
const pathnameRef = vi.hoisted(() => ({
  current: "/w/ws-1/feed/voice",
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
vi.mock("@/lib/recorder/dock-recorder-bridge", () => ({
  useGlobalDockRecorder: () => recorderRef.current,
  registerDockRecorderChatTarget: () => () => {},
}));
// The shell mounts the operator top bar above the gate; its router + layout
// sidebar state don't exist under bare SSR, so mock the hooks it reads.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ back: vi.fn(), forward: vi.fn() }),
  // The dock reads the pathname only to yield to a selected post's Refine
  // chat. Every other route keeps the same Feed control conversation.
  usePathname: () => pathnameRef.current,
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
  FEED_CHAT_OPEN_EVENT,
  FEED_CHAT_SEED_EVENT,
  requestFeedChatOpen,
  requestFeedChatSeed,
} from "@/lib/feed-chat-seed";
import { CHAT_SEED_EVENT as DOC_CHAT_SEED_EVENT } from "@/lib/chat-seed";
import {
  FeedFloatingChat,
  feedChatLauncherLabel,
} from "../feed-floating-chat";
import {
  reduceTuningToolActivity,
  type TuningChatActivity,
} from "../tuning-chat-panel";
import { FeedSurfaceShell } from "../feed-surface-shell";

const dict = en as unknown as Dictionary;

afterEach(() => {
  vi.unstubAllGlobals();
  pathnameRef.current = "/w/ws-1/feed/voice";
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
    brand: null,
    refresh: async () => {},
  };
}

function renderDock(profiles: FeedProfile[]): string {
  recorderRef.current = {
    phase: { kind: "idle" },
    active: false,
    elapsedMs: () => 0,
    notice: null,
    clearNotices: vi.fn(),
    onPressStart: vi.fn(),
    onPressEnd: vi.fn(),
    stop: vi.fn(),
    discard: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    level: () => 0,
    computerAudioAvailable: false,
    includeComputerAudio: false,
    setIncludeComputerAudio: vi.fn(),
    livePageEnabled: false,
    setLivePageEnabled: vi.fn(),
    includesSystemAudio: () => false,
    screenCaptureAvailable: false,
    capturePickerAvailable: false,
    captureSource: "mic" as const,
    setCaptureSource: () => {},
    capturesScreen: () => false,
    recovery: [],
    saveRecovery: vi.fn(),
    discardRecovery: vi.fn(),
  };
  ctxRef.workspace = workspace(profiles);
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      <FeedFloatingChat />
    </I18nProvider>,
  );
}

describe("[COMP:app-web/feed-tuning-chat] feed chat buses", () => {
  it("uses Feed-specific event names, distinct from the doc chat-seed bus", () => {
    expect(FEED_CHAT_OPEN_EVENT).toBe("feed:chat-open");
    expect(FEED_CHAT_SEED_EVENT).toBe("feed:chat-seed");
    expect(FEED_CHAT_SEED_EVENT).not.toBe(DOC_CHAT_SEED_EVENT);
  });

  it("opens without changing the composer or dispatches a seed payload; empty prefills are dropped", () => {
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

    requestFeedChatOpen();
    requestFeedChatSeed({ prefill: "About this voice rule…", researchMode: true });
    requestFeedChatSeed({ prefill: "   " });

    expect(dispatched).toEqual([
      {
        type: "feed:chat-open",
        detail: undefined,
      },
      {
        type: "feed:chat-seed",
        detail: { prefill: "About this voice rule…", researchMode: true },
      },
    ]);
  });
});

describe("[COMP:app-web/feed-tuning-chat] FeedFloatingChat", () => {
  it("replaces the idle launcher copy with live tool, text, then thinking activity", () => {
    const activity = (
      patch: Partial<TuningChatActivity>,
    ): TuningChatActivity => ({
      isStreaming: true,
      streamingText: "",
      activeLabel: null,
      ...patch,
    });

    expect(
      feedChatLauncherLabel(
        { isStreaming: false, streamingText: "", activeLabel: null },
        "Create with Acme",
        "Thinking...",
      ),
    ).toBe("Create with Acme");
    expect(
      feedChatLauncherLabel(
        activity({
          streamingText: "A reply that should lose to the tool",
          activeLabel: "Searching launch notes",
        }),
        "Create with Acme",
        "Thinking...",
      ),
    ).toBe("Searching launch notes");
    expect(
      feedChatLauncherLabel(
        activity({ streamingText: "## Draft\n\nWriting the launch recap" }),
        "Create with Acme",
        "Thinking...",
      ),
    ).toBe("Draft Writing the launch recap");
    expect(
      feedChatLauncherLabel(
        activity({}),
        "Create with Acme",
        "Thinking...",
      ),
    ).toBe("Thinking...");
  });

  it("reduces tool events into input-aware launcher narration", () => {
    const started = reduceTuningToolActivity(
      [],
      "tool_start",
      { id: "tool-1", name: "webSearch" },
      en.chat.toolNarration,
    );
    expect(started).toEqual([
      {
        id: "tool-1",
        name: "webSearch",
        description: en.chat.toolNarration.webSearch,
        status: "running",
      },
    ]);

    const described = reduceTuningToolActivity(
      started ?? [],
      "tool_input",
      {
        id: "tool-1",
        name: "webSearch",
        input: { query: "August launch notes" },
      },
      en.chat.toolNarration,
    );
    expect(described?.[0]?.description).toContain("August launch notes");
    expect(
      reduceTuningToolActivity(
        described ?? [],
        "tool_result",
        { id: "tool-1" },
        en.chat.toolNarration,
      )?.[0]?.status,
    ).toBe("done");
  });

  it("collapsed dock: renders the launcher pill and the always-mounted (hidden) panel", () => {
    const html = renderDock([profile("acme")]);
    // Launcher pill carries the open aria-label and says what Feed controls.
    expect(html).toContain(en.feedPage.tuningChat.openAria);
    expect(html).toContain("Create with acme");
    expect(html).toContain('data-feed-chat-channel="plan"');
    // Panel is mounted even while collapsed — header + empty state ship in
    // the initial markup so an expand never remounts the conversation.
    expect(html).toContain(en.feedPage.tuningChat.title);
    expect(html).toContain(en.feedPage.tuningChat.emptyTitle);
    expect(html).toContain(en.feedPage.tuningChat.suggestion2);
    // Feed's replacement dock must retain the global dock's resize contract:
    // an accessible corner handle plus the full top and left drag targets.
    expect(html).toContain(`aria-label="${en.chat.resizeHandle}"`);
    expect(html).toContain("cursor-nwse-resize");
    expect(html).toContain("cursor-ns-resize");
    expect(html).toContain("cursor-ew-resize");
    expect(html).toContain("width:460px;height:640px");
    // Feed replaces the global CHAT chrome, not the app-wide recorder. The
    // same record-dot affordance must remain beside the Feed launcher.
    expect(html).toContain(`aria-label="${en.recorder.start}"`);
    // The rounded composite box owns focus. The inner textarea must suppress
    // the global :focus-visible shadow or the composer gets a second, sharp
    // blue rectangle inside its rounded ring.
    expect(html).toContain("focus-visible:shadow-none");
  });

  it("keeps the same master channel on Plan and Voice routes", () => {
    pathnameRef.current = "/w/ws-1/feed";
    expect(renderDock([profile("acme")])).toContain(
      'data-feed-chat-channel="plan"',
    );
    pathnameRef.current = "/w/ws-1/feed/voice";
    expect(renderDock([profile("acme")])).toContain(
      'data-feed-chat-channel="plan"',
    );
  });

  it("no connected assistant: renders nothing (feed home owns the empty state)", () => {
    const html = renderDock([]);
    expect(html).not.toContain(en.feedPage.tuningChat.openAria);
    expect(html).not.toContain(en.feedPage.tuningChat.title);
  });

  it("post editor: suppresses the floating chat so the inline Refine rail is the only chat", () => {
    pathnameRef.current = "/w/ws-1/feed/twitter/posts/session-1";
    const html = renderDock([profile("acme")]);
    expect(html).not.toContain(en.feedPage.tuningChat.openAria);
    expect(html).not.toContain("Create with acme");
    expect(html).not.toContain(`aria-label="${en.recorder.start}"`);
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
    expect(html).toContain(en.feedPage.tuningChat.topbarAction);
  });

  it("selected post leaves both master-chat entries to the inline Refine rail", () => {
    pathnameRef.current = "/w/ws-1/feed/twitter/posts/session-1";
    ctxRef.workspace = workspace([profile("acme")]);
    ctxRef.state = { status: "ready", value: ctxRef.workspace };
    const html = renderToString(
      <I18nProvider locale="en" dict={dict}>
        <FeedSurfaceShell workspaceId="ws-1">
          <div data-post-editor>post editor</div>
        </FeedSurfaceShell>
      </I18nProvider>,
    );
    expect(html).toContain("data-post-editor");
    expect(html).not.toContain(en.feedPage.tuningChat.openAria);
    expect(html).not.toContain(en.feedPage.tuningChat.topbarAction);
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
