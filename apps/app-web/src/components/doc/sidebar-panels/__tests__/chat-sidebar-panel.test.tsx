// @vitest-environment jsdom

/**
 * [COMP:app-web/sidebar-panel-chat] Chat session rail routing.
 *
 * The Personal/Workspace audience is URL state. Deleting the open Workspace
 * chat must clear only its dead `s` selection and retain `v=workspace`; if the
 * rail replaces the URL with the bare Chat route, the surface silently falls
 * back to Personal.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { invalidateSurfaceCache, mutateSurfaceCache, resetSurfaceCache } from "@/lib/surface-cache";
import { chatSessionsCacheKey, chatSharedSessionsCacheKey } from "@/lib/surface-prefetch";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navigation = vi.hoisted(() => ({
  search: "v=workspace&s=room-1",
  replace: vi.fn(),
  push: vi.fn(),
}));

const projectsApi = vi.hoisted(() => ({ listContextProjects: vi.fn() }));
vi.mock("@/lib/api/context-scopes", () => projectsApi);
const viewer = vi.hoisted(() => ({ id: "viewer-1" }));
vi.mock("@/lib/user", () => ({ getUserInfo: () => ({ id: viewer.id }) }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/w/workspace-1/chat",
  useRouter: () => ({
    replace: navigation.replace,
    push: navigation.push,
  }),
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    prefetch: _prefetch,
    ...props
  }: {
    href: string;
    prefetch?: boolean;
    children: React.ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const sessionApi = vi.hoisted(() => ({
  createWorkspaceSession: vi.fn(),
  deleteSession: vi.fn(),
  listPersonalSessions: vi.fn(),
  listWorkspaceSessions: vi.fn(),
  renameSessionTitle: vi.fn(),
  setSessionArchived: vi.fn(),
}));

vi.mock("@/lib/api/sessions", () => sessionApi);

const viewApi = vi.hoisted(() => ({
  listWorkspaceAssistants: vi.fn(),
}));

vi.mock("@/lib/api/views", () => viewApi);

const dialogs = vi.hoisted(() => ({
  confirmDialog: vi.fn(),
  promptDialog: vi.fn(),
}));

vi.mock("@/components/ui/confirm-dialog", () => ({
  confirmDialog: dialogs.confirmDialog,
}));
vi.mock("@/components/ui/prompt-dialog", () => ({
  promptDialog: dialogs.promptDialog,
}));

const seen = vi.hoisted(() => ({ isRoomUnread: vi.fn(() => false) }));
vi.mock("@/lib/chat-seen", () => seen);
vi.mock("@/lib/chat-session-events", () => ({
  CHAT_SESSION_ACTIVITY_EVENT: "chat:session-activity",
  CHAT_SESSIONS_REFRESH_EVENT: "chat:sessions-refresh",
  dispatchChatSessionActivity: vi.fn(),
  dispatchChatSessionsRefresh: vi.fn(),
}));

import { ChatSidebarPanel } from "../chat-sidebar-panel";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function flushEffects() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderPanel(workspaceId = "workspace-1") {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider locale="en" dict={en}>
        <ChatSidebarPanel workspaceId={workspaceId} />
      </I18nProvider>,
    );
  });
  await flushEffects();
}

function buttonNamed(name: string): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!button) throw new Error(`Button not found: ${name}`);
  return button;
}

beforeEach(() => {
  localStorage.clear();
  viewer.id = "viewer-1";
  resetSurfaceCache();
  vi.clearAllMocks();
  resetSurfaceCache();
  navigation.search = "v=workspace&s=room-1";
  projectsApi.listContextProjects.mockResolvedValue([]);
  viewApi.listWorkspaceAssistants.mockResolvedValue([
    {
      id: "assistant-1",
      name: "Brian",
      kind: "primary",
      iconSeed: null,
    },
  ]);
  sessionApi.listPersonalSessions.mockResolvedValue([]);
  sessionApi.listWorkspaceSessions.mockResolvedValue([
    {
      id: "room-1",
      title: "Workspace launch",
      channelId: "channel-1",
      lastActive: "2026-08-01T01:00:00.000Z",
      appOrigin: "chat",
      assistantId: "assistant-1",
      status: "idle",
      startedByUserId: "user-1",
      startedByName: "Alice",
      startedByAvatarUrl: null,
    },
  ]);
  sessionApi.deleteSession.mockResolvedValue(undefined);
  sessionApi.setSessionArchived.mockResolvedValue(undefined);
  dialogs.confirmDialog.mockResolvedValue(true);
});

afterEach(() => {
  act(() => root?.unmount());
  window.history.replaceState(null, "", "/");
  container?.remove();
  root = null;
  container = null;
});

describe("[COMP:app-web/sidebar-panel-chat] failed history loads", () => {
  it("does not restart skeletons when a loaded rail loses access and Retry is pending", async () => {
    navigation.search = "";
    sessionApi.listPersonalSessions.mockResolvedValue([
      { id: "loaded-chat", title: "Existing plan", channelId: "channel-2", lastActive: "2026-10-01", appOrigin: "chat", assistantId: "assistant-1" },
    ]);
    await renderPanel();
    expect(container?.textContent).toContain("Existing plan");
    sessionApi.listPersonalSessions.mockRejectedValue(new Error("chat_list_failed: 403"));
    await act(async () => { invalidateSurfaceCache(chatSessionsCacheKey("workspace-1")); });
    await flushEffects();
    expect(container?.textContent).not.toContain("Existing plan");
    expect(container?.querySelector(".skeleton")).toBeNull();
    sessionApi.listPersonalSessions.mockImplementation(() => new Promise(() => {}));
    act(() => buttonNamed("Retry").click());
    await flushEffects();
    expect(container?.querySelector(".skeleton")).toBeNull();
    expect(container?.textContent).toContain(en.chatApp.railLoadFailed);
  });

  it("shows recovery instead of empty history and loads the chats when retried", async () => {
    navigation.search = "";
    sessionApi.listPersonalSessions.mockRejectedValue(new Error("chat_list_failed"));
    await renderPanel();
    expect(container?.querySelector('[role="alert"]')?.textContent).toContain("Could not load chats.");
    expect(container?.textContent).not.toContain(en.chatApp.railEmpty);
    sessionApi.listPersonalSessions.mockResolvedValue([
      { id: "recovered-chat", title: "Recovered plan", channelId: "channel-2", lastActive: "2026-10-01", appOrigin: "chat", assistantId: "assistant-1" },
    ]);
    await act(async () => buttonNamed("Retry").click());
    await flushEffects();
    expect(container?.textContent).toContain("Recovered plan");
    expect(container?.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("[COMP:app-web/sidebar-panel-chat] direct archive action", () => {
  it("archives from the row without opening the overflow menu or closing the chat", async () => {
    sessionApi.setSessionArchived.mockImplementationOnce(async () => { sessionApi.listWorkspaceSessions.mockResolvedValue([]); });
    await renderPanel();
    expect(container!.querySelector('section[aria-label="Archived chats"]')).toBeNull();
    const archive = container!.querySelector(`button[aria-label="${en.chatApp.archiveChat}"]`) as HTMLButtonElement;
    expect(archive).not.toBeNull();
    await act(async () => archive.click());
    expect(sessionApi.setSessionArchived).toHaveBeenCalledWith("room-1", true);
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(container!.querySelector('a[href*="s=room-1"]')).toBeNull();
    expect(sessionApi.deleteSession).not.toHaveBeenCalled();
  });
  it("keeps a failed archive visible and reports the failure", async () => {
    sessionApi.setSessionArchived.mockRejectedValueOnce(new Error("offline"));
    await renderPanel();
    const archive = container!.querySelector(`button[aria-label="${en.chatApp.archiveChat}"]`) as HTMLButtonElement;
    await act(async () => archive.click());
    expect(container!.textContent).toContain(en.chatApp.archiveFailed);
    expect(container!.querySelector('a[href*="s=room-1"]')).not.toBeNull();
  });
});

describe("[COMP:app-web/sidebar-panel-chat] open-chat deletion", () => {
  it("keeps the Workspace view after deleting its open chat", async () => {
    await renderPanel();

    const actions = container!.querySelector(
      `button[aria-label="${en.chatApp.rowActionsAria}"]`,
    ) as HTMLButtonElement | null;
    expect(actions).not.toBeNull();
    await act(async () => actions!.click());

    await act(async () => {
      buttonNamed(en.chatApp.delete).click();
    });
    await flushEffects();

    expect(sessionApi.deleteSession).toHaveBeenCalledWith("room-1");
    expect(navigation.replace).toHaveBeenCalledWith(
      "/w/workspace-1/chat?v=workspace",
      { scroll: false },
    );
  });
});

describe("[COMP:app-web/sidebar-panel-chat] live room activity", () => {
  it("shows a running-room spinner and settles from the same-tab activity signal", async () => {
    sessionApi.listWorkspaceSessions.mockResolvedValueOnce([
      {
        id: "room-1",
        title: "Workspace launch",
        channelId: "channel-1",
        lastActive: "2026-08-01T01:00:00.000Z",
        appOrigin: "chat",
        assistantId: "assistant-1",
        status: "running",
        startedByUserId: "user-1",
        startedByName: "Alice",
        startedByAvatarUrl: null,
      },
    ]);
    await renderPanel();

    const working = container!.querySelector('[data-chat-working="true"]');
    expect(working).not.toBeNull();
    expect(working?.classList.contains("animate-spin")).toBe(true);
    expect(working?.classList.contains("motion-reduce:animate-none")).toBe(true);
    expect(working?.getAttribute("aria-hidden")).toBe("false");
    expect(working?.getAttribute("role")).toBe("status");
    expect(working?.getAttribute("aria-label")).toBe("Brian is working");

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("chat:session-activity", {
          detail: {
            workspaceId: "workspace-1",
            sessionId: "room-1",
            working: false,
          },
        }),
      );
    });

    expect(container!.querySelector('[data-chat-working="true"]')).toBeNull();
  });
});

describe("[COMP:app-web/sidebar-panel-chat] overflowing title measurements", () => {
  let available: number;
  let observers: { notify: () => void; disconnect: ReturnType<typeof vi.fn> }[];

  beforeEach(() => {
    available = 120;
    observers = [];
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-sidebar-title") ? available : 0;
    });
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.parentElement?.hasAttribute("data-sidebar-title") ? (this.textContent?.length ?? 0) * 8 : 0;
    });
    vi.stubGlobal("ResizeObserver", class {
      disconnect = vi.fn();
      observe = vi.fn();
      constructor(notify: () => void) { observers.push({ notify, disconnect: this.disconnect }); }
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("adapts overflow to action gutters and sidebar resizing while fitting labels stay still", async () => {
    await renderPanel();
    const title = container!.querySelector<HTMLElement>('a[href*="s=room-1"] [data-sidebar-title]')!;
    const general = buttonNamed(en.chatApp.generalChats).querySelector('[data-sidebar-title]')!;
    expect(title.hasAttribute("data-overflow")).toBe(true);
    expect(general.hasAttribute("data-overflow")).toBe(false);

    await act(async () => { available = 100; observers.forEach(observer => observer.notify()); });
    expect(title.style.getPropertyValue("--chat-title-travel")).toBe("-28px");
    await act(async () => { available = 260; observers.forEach(observer => observer.notify()); });
    expect(title.hasAttribute("data-overflow")).toBe(false);
    expect(title.textContent).toBe("Workspace launch");

    act(() => root!.unmount());
    root = null;
    expect(observers.every(observer => observer.disconnect.mock.calls.length === 1)).toBe(true);
  });

  it("remeasures an auto-renamed title without duplicating its accessible text", async () => {
    await renderPanel();
    await act(async () => {
      mutateSurfaceCache(chatSharedSessionsCacheKey("workspace-1", null), () => [{
        id: "room-1", title: "Plan", channelId: "channel-1", lastActive: "2026-08-01T01:00:00.000Z",
        appOrigin: "chat", assistantId: "assistant-1", status: "idle",
      }]);
    });
    const title = container!.querySelector<HTMLElement>('a[href*="s=room-1"] [data-sidebar-title]')!;
    expect(title.textContent).toBe("Plan");
    expect(title.hasAttribute("data-overflow")).toBe(false);
    expect(title.querySelectorAll("span")).toHaveLength(1);
  });
});

describe("[COMP:app-web/sidebar-panel-chat] one row renderer for both rails (chat-parity T4)", () => {
  it.each(["personal", "workspace"])("shows only the title in an idle %s row while retaining accessible identity and transport", async (view) => {
    navigation.search = `${view === "workspace" ? "v=workspace&" : ""}s=transport-chat`;
    const row = {
      id: "transport-chat", title: "Channel updates", channelId: "channel-example",
      transport: "telegram", lastActive: "2026-08-01T01:00:00.000Z",
      appOrigin: "chat", assistantId: "assistant-1", status: "idle", humanCount: 1,
    };
    sessionApi.listPersonalSessions.mockResolvedValue([row]);
    sessionApi.listWorkspaceSessions.mockResolvedValue([{ ...row, startedByUserId: "user-1", startedByName: "Alex" }]);
    await renderPanel();
    const link = container!.querySelector<HTMLAnchorElement>('a[href*="s=transport-chat"]')!;
    expect(link).not.toBeNull();
    expect(link.querySelector("svg, img")).toBeNull();
    expect(link.textContent).toContain("Brian");
    expect(link.textContent).toContain("Group on Telegram");
    const visible = link.cloneNode(true) as HTMLAnchorElement;
    visible.querySelectorAll(".sr-only").forEach(node => node.remove());
    expect(visible.textContent?.trim()).toBe("Channel updates");
  });

  it("keeps starter attribution accessible without adding a second visible line", async () => {
    await renderPanel();
    const link = container!.querySelector<HTMLAnchorElement>('a[href*="s=room-1"]')!;
    expect(link.textContent).toContain("Workspace launch");
    const attribution = link.querySelector(".sr-only");
    expect(attribution?.textContent).toBe("Started by Alice");
    expect(link.querySelector(".mt-0\\.5")).toBeNull();
    expect(link.getAttribute("aria-current")).toBe("page");
  });

  it("keeps compose out of Projects where the viewer cannot create chats", async () => {
    projectsApi.listContextProjects.mockResolvedValue([
      { id: "project-readonly", name: "Reference Project", status: "active", shared: { status: "active", myRole: "oversight" } },
    ]);
    await renderPanel();
    expect(container!.querySelector('button[aria-label="New chat in General"]')).not.toBeNull();
    expect(buttonNamed("Reference Project")).toBeDefined();
    expect(container!.querySelector('button[aria-label="New chat in Reference Project"]')).toBeNull();
  });

  it("keeps the fresh-chat compose row quiet and leaves searching to the shared header", async () => {
    navigation.search = "";
    await renderPanel();
    const compose = container!.querySelector<HTMLAnchorElement>('a[href="/w/workspace-1/chat"]')!;
    expect(compose.textContent).toContain(en.chatApp.newChat);
    expect(compose.className).not.toContain('doc-nav-active');
    expect(container!.querySelector('input[type="search"]')).toBeNull();
  });

  const personalRow = {
    id: "chat-1",
    title: "Quarter plan",
    channelId: "channel-p",
    lastActive: "2026-08-01T01:00:00.000Z",
    appOrigin: "chat",
    assistantId: "assistant-1",
    status: "running",
    humanCount: 1,
    policy: { addressing: "every_message", multiVoice: true, pins: true, queue: true, post: false, presence: false },
  };

  it("shows a running-personal-chat spinner exactly as it does for a room", async () => {
    navigation.search = "";
    sessionApi.listPersonalSessions.mockResolvedValue([personalRow]);
    await renderPanel();
    const working = container!.querySelector('[data-chat-working="true"]');
    expect(working).not.toBeNull();
    expect(working?.getAttribute("aria-label")).toBe("Brian is working");
  });

  it("never dots a conversation with one human", async () => {
    seen.isRoomUnread.mockReturnValue(true);
    navigation.search = "";
    sessionApi.listPersonalSessions.mockResolvedValue([{ ...personalRow, status: "idle" }]);
    await renderPanel();
    expect(container!.querySelector(`[aria-label="${en.chatApp.unreadDotAria}"]`)).toBeNull();
    seen.isRoomUnread.mockReturnValue(false);
  });

  it("keeps the dot for a room another human takes part in", async () => {
    seen.isRoomUnread.mockReturnValue(true);
    navigation.search = "v=workspace";
    sessionApi.listWorkspaceSessions.mockResolvedValueOnce([
      {
        id: "room-2", title: "Launch", channelId: "channel-2", lastActive: "2026-08-01T01:00:00.000Z",
        appOrigin: "chat", assistantId: "assistant-1", status: "idle", startedByUserId: "user-1",
        startedByName: "Alice", startedByAvatarUrl: null, humanCount: 2,
      },
    ]);
    await renderPanel();
    expect(container!.querySelector(`[aria-label="${en.chatApp.unreadDotAria}"]`)).not.toBeNull();
    seen.isRoomUnread.mockReturnValue(false);
  });
});

it("loads an older Project independently and creates a chat with its backend scope", async () => {
  projectsApi.listContextProjects.mockResolvedValue([{ id: "project-1", name: "Sample Project", status: "active", shared: { status: "active", myRole: "participant" } }]);
  sessionApi.listWorkspaceSessions.mockImplementation(async (opts) => opts.contextProjectId === "project-1" ? [{
    id: "older-project-chat", title: "Older Project chat", contextProjectId: "project-1", channelId: "older", lastActive: "2025-01-01T00:00:00.000Z",
    appOrigin: "chat", assistantId: "assistant-1", status: "idle", startedByUserId: "user-1", startedByName: null, startedByAvatarUrl: null,
  }] : []);
  sessionApi.createWorkspaceSession.mockResolvedValue({ id: "new-project-chat", contextProjectId: "project-1" });
  await renderPanel();
  await act(async () => { buttonNamed("Sample Project").click(); });
  expect(container!.textContent).toContain("Older Project chat");
  const create = container!.querySelector('button[aria-label="New chat in Sample Project"]') as HTMLButtonElement;
  await act(async () => { create.click(); });
  expect(sessionApi.createWorkspaceSession).toHaveBeenCalledWith("workspace-1", undefined, { contextGroupId: null, contextProjectId: "project-1" });
});

describe("[COMP:app-web/sidebar-panel-chat] group disclosure persistence", () => {
  const project = { id: "project-1", name: "Sample Project", status: "active", shared: { status: "active", myRole: "participant" } };
  const room = (id: string, contextProjectId: string | null) => ({
    id, title: `Conversation ${id}`, contextProjectId, channelId: id,
    lastActive: "2026-08-01T01:00:00.000Z", appOrigin: "chat",
    assistantId: "assistant-1", status: "idle", startedByUserId: "user-1",
    startedByName: "Alex", startedByAvatarUrl: null,
  });
  const groupKey = (workspaceId: string, projectId: string | null) =>
    `doc:chat-group:${chatSharedSessionsCacheKey(workspaceId, projectId)}`;

  beforeEach(() => {
    projectsApi.listContextProjects.mockResolvedValue([project]);
    sessionApi.listWorkspaceSessions.mockImplementation(async opts =>
      opts.contextProjectId === "project-1"
        ? [room("project-chat", "project-1")]
        : [room("room-1", null)]);
  });

  async function remount(workspaceId = "workspace-1") {
    act(() => root!.unmount());
    container!.remove();
    await renderPanel(workspaceId);
  }

  it("switches the Project folder icon with its disclosure and omits the chevron", async () => {
    await renderPanel();
    const heading = buttonNamed("Sample Project");
    expect(heading.getAttribute("aria-expanded")).toBe("false");
    expect(heading.querySelector(".lucide-folder")).not.toBeNull();
    expect(heading.querySelector(".lucide-chevron-right")).toBeNull();
    await act(async () => heading.click());
    expect(heading.getAttribute("aria-expanded")).toBe("true");
    expect(heading.querySelector(".lucide-folder-open")).not.toBeNull();
    expect(container!.querySelector('a[href*="s=project-chat"]')).not.toBeNull();
  });

  it("focuses a tapped Project heading so touch users can reveal compose", async () => {
    await renderPanel();
    const heading = buttonNamed("Sample Project");
    const tap = new Event("pointerup", { bubbles: true });
    Object.defineProperty(tap, "pointerType", { value: "touch" });
    await act(async () => heading.dispatchEvent(tap));
    expect(document.activeElement).toBe(heading);
    expect(sessionApi.createWorkspaceSession).not.toHaveBeenCalled();
  });

  async function navigate(search: string) {
    navigation.search = search;
    await act(async () => root!.render(
      <I18nProvider locale="en" dict={en}>
        <ChatSidebarPanel workspaceId="workspace-1" />
      </I18nProvider>,
    ));
  }

  it("keeps the selected group collapsed when its cached rows refresh", async () => {
    await renderPanel();
    const general = buttonNamed(en.chatApp.generalChats);
    expect(general.getAttribute("aria-expanded")).toBe("true");
    await act(async () => general.click());
    await act(async () => mutateSurfaceCache(
      chatSharedSessionsCacheKey("workspace-1", null),
      () => [room("room-1", null), room("new-room", null)],
    ));
    expect(general.getAttribute("aria-expanded")).toBe("false");
    expect(buttonNamed("Sample Project").getAttribute("aria-expanded")).toBe("false");
  });

  it("restores independently collapsed General and expanded Project after a reload", async () => {
    await renderPanel();
    await act(async () => buttonNamed(en.chatApp.generalChats).click());
    await act(async () => buttonNamed("Sample Project").click());
    await act(async () => resetSurfaceCache());
    await remount();
    expect(buttonNamed(en.chatApp.generalChats).getAttribute("aria-expanded")).toBe("false");
    expect(buttonNamed("Sample Project").getAttribute("aria-expanded")).toBe("true");
    expect(container!.textContent).toContain("Conversation project-chat");
  });

  it("reveals only the newly selected group and respects collapsing it again", async () => {
    await renderPanel();
    await act(async () => buttonNamed(en.chatApp.generalChats).click());
    await navigate("v=workspace&s=project-chat");
    expect(buttonNamed("Sample Project").getAttribute("aria-expanded")).toBe("true");
    expect(buttonNamed(en.chatApp.generalChats).getAttribute("aria-expanded")).toBe("false");
    await act(async () => buttonNamed("Sample Project").click());
    await act(async () => mutateSurfaceCache(
      chatSharedSessionsCacheKey("workspace-1", "project-1"),
      () => [room("project-chat", "project-1")],
    ));
    expect(buttonNamed("Sample Project").getAttribute("aria-expanded")).toBe("false");
    await remount();
    expect(buttonNamed("Sample Project").getAttribute("aria-expanded")).toBe("false");
    await navigate("v=workspace&s=room-1");
    await navigate("v=workspace&s=project-chat");
    expect(buttonNamed("Sample Project").getAttribute("aria-expanded")).toBe("true");
  });

  it("scopes saved choices to the workspace and viewer", async () => {
    await renderPanel();
    await act(async () => buttonNamed(en.chatApp.generalChats).click());
    await act(async () => buttonNamed("Sample Project").click());
    await remount("workspace-2");
    expect(buttonNamed(en.chatApp.generalChats).getAttribute("aria-expanded")).toBe("true");
    expect(buttonNamed("Sample Project").getAttribute("aria-expanded")).toBe("false");
    viewer.id = "viewer-2";
    await remount();
    expect(buttonNamed(en.chatApp.generalChats).getAttribute("aria-expanded")).toBe("true");
    expect(buttonNamed("Sample Project").getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps a group collapsed when the remembered chat is restored after mount", async () => {
    await renderPanel();
    await act(async () => buttonNamed(en.chatApp.generalChats).click());
    navigation.search = "v=workspace";
    await remount();
    await navigate("v=workspace&s=room-1");
    expect(buttonNamed(en.chatApp.generalChats).getAttribute("aria-expanded")).toBe("false");
  });

  it("falls back to defaults when stored preferences are malformed", async () => {
    localStorage.setItem(groupKey("workspace-1", null), "broken JSON");
    localStorage.setItem(groupKey("workspace-1", "project-1"), JSON.stringify({ open: "yes" }));
    await renderPanel();
    expect(buttonNamed(en.chatApp.generalChats).getAttribute("aria-expanded")).toBe("true");
    expect(buttonNamed("Sample Project").getAttribute("aria-expanded")).toBe("false");
  });

  it("allows toggling when local storage is unavailable", async () => {
    const read = vi.spyOn(localStorage, "getItem").mockImplementation(() => { throw new Error("storage unavailable"); });
    const write = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("storage unavailable"); });
    try {
      await renderPanel();
      await act(async () => buttonNamed(en.chatApp.generalChats).click());
      await act(async () => buttonNamed("Sample Project").click());
      expect(buttonNamed(en.chatApp.generalChats).getAttribute("aria-expanded")).toBe("false");
      expect(buttonNamed("Sample Project").getAttribute("aria-expanded")).toBe("true");
    } finally {
      read.mockRestore();
      write.mockRestore();
    }
  });
});


describe("[COMP:app-web/sidebar-panel-chat] recent chat windows", () => {
  const recent = (count: number, fields = {}) => Array.from({ length: count }, (_, i) => ({
    id: `recent-${i}`, title: `Recent discussion ${i}`, channelId: `channel-${i}`,
    lastActive: `2026-10-${String(28 - Math.floor(i / 24)).padStart(2, "0")}T${String(23 - i % 24).padStart(2, "0")}:00:00.000Z`,
    appOrigin: "chat", transport: "web", assistantId: "assistant-1", status: "idle", ...fields,
  }));
  const group = () => container!.querySelector<HTMLElement>("[data-personal-chat-group=general], [data-workspace-chat-group=general]")!;
  const links = () => [...group().querySelectorAll<HTMLAnchorElement>("a")];
  const more = () => group().querySelector<HTMLButtonElement>("[data-chat-show-more]")!;

  it.each(["personal", "workspace"])("reveals five %s chats at a time and preserves the window across refresh", async view => {
    navigation.search = view === "workspace" ? "v=workspace" : "";
    const rows = recent(12);
    sessionApi.listPersonalSessions.mockResolvedValue(rows);
    sessionApi.listWorkspaceSessions.mockResolvedValue(rows);
    await renderPanel();
    expect(links()).toHaveLength(5);
    expect(more().textContent).toBe(en.chatApp.moreChats);
    expect(more().getAttribute("aria-label")).toContain(en.chatApp.generalChats);
    const requests = sessionApi.listWorkspaceSessions.mock.calls.length;
    await act(async () => more().click());
    expect(links()).toHaveLength(10);
    expect(sessionApi.listWorkspaceSessions.mock.calls).toHaveLength(requests);
    await act(async () => mutateSurfaceCache(
      view === "workspace" ? chatSharedSessionsCacheKey("workspace-1", null) : chatSessionsCacheKey("workspace-1"),
      () => rows.map(row => ({ ...row })),
    ));
    expect(links()).toHaveLength(10);
    await act(async () => more().click());
    expect(links()).toHaveLength(12);
    expect(more()).toBeNull();
  });

  it.each(["personal", "workspace"])("keeps an older selected %s chat visible without revealing the intervening history", async view => {
    navigation.search = `${view === "workspace" ? "v=workspace&" : ""}s=recent-11`;
    sessionApi.listPersonalSessions.mockResolvedValue(recent(12));
    sessionApi.listWorkspaceSessions.mockResolvedValue(recent(12));
    await renderPanel();
    expect(links()).toHaveLength(6);
    expect(links().at(-1)?.getAttribute("aria-current")).toBe("page");
    expect(group().querySelector('a[href*="s=recent-5"]')).toBeNull();
    await act(async () => more().click());
    expect(links()).toHaveLength(11);
    expect(links().filter(link => link.href.includes("s=recent-11"))).toHaveLength(1);
  });

  it("resets the display window when switching workspaces", async () => {
    navigation.search = "";
    sessionApi.listPersonalSessions.mockResolvedValue(recent(12));
    await renderPanel();
    await act(async () => more().click());
    expect(links()).toHaveLength(10);
    await act(async () => root!.render(<I18nProvider locale="en" dict={en}><ChatSidebarPanel workspaceId="workspace-2" /></I18nProvider>));
    await flushEffects();
    expect(links()).toHaveLength(5);
  });

  it("reveals cached Work chats before fetching another page and retains a pagination error", async () => {
    navigation.search = "v=workspace";
    sessionApi.listWorkspaceSessions.mockResolvedValue(recent(50));
    await renderPanel();
    const requests = sessionApi.listWorkspaceSessions.mock.calls.length;
    for (let i = 0; i < 9; i++) await act(async () => more().click());
    expect(links()).toHaveLength(50);
    expect(sessionApi.listWorkspaceSessions.mock.calls).toHaveLength(requests);
    sessionApi.listWorkspaceSessions.mockRejectedValueOnce(new Error("unavailable"));
    await act(async () => more().click());
    expect(group().querySelector('[role="alert"]')?.textContent).toBe(en.chatApp.projectChatsFailed);
    expect(links()).toHaveLength(50);
    sessionApi.listWorkspaceSessions.mockResolvedValueOnce(recent(50).map((row, i) => ({ ...row, id: `older-${i}` })));
    await act(async () => more().click());
    expect(links()).toHaveLength(55);
    expect(links().filter(link => link.href.includes("s=older-"))).toHaveLength(5);
    expect(sessionApi.listWorkspaceSessions.mock.calls).toHaveLength(requests + 2);
  }, 15_000);
});

describe("[COMP:app-web/sidebar-panel-chat] private Project and source-channel groups", () => {
  const chat = (id: string, fields = {}) => ({
    id, title: `Discussion ${id}`, channelId: id, transport: "web",
    lastActive: "2026-10-27T01:00:00.000Z", appOrigin: "chat",
    assistantId: "assistant-1", humanCount: 1, ...fields,
  });
  const group = (label: string) => buttonNamed(label).closest("section")!;
  const project = { id: "project-1", name: "Sample Project", status: "active" };

  beforeEach(() => {
    navigation.search = "";
    projectsApi.listContextProjects.mockResolvedValue([project]);
  });

  it("groups private web chats by Project and gives source channels precedence without sharing", async () => {
    sessionApi.listPersonalSessions.mockResolvedValue([
      chat("channel-a", { transport: "slack", channelId: "C_SAMPLE:thread:100.001", contextProjectId: project.id }),
      chat("project-a", { contextProjectId: project.id }),
      chat("general-a"),
      chat("channel-b", { transport: "slack", channelId: "C_SAMPLE:thread:200.001" }),
      chat("ambient-a", { appOrigin: "doc" }),
      chat("ambient-channel", { appOrigin: "doc", transport: "slack", channelId: "C_SAMPLE" }),
    ]);
    await renderPanel();
    expect(projectsApi.listContextProjects).toHaveBeenCalledWith("workspace-1", true);
    expect(group(en.chatApp.generalChats).textContent).toContain("Discussion general-a");
    expect(buttonNamed("Sample Project").getAttribute("aria-expanded")).toBe("false");
    await act(async () => buttonNamed("Sample Project").click());
    expect(group("Sample Project").textContent).toContain("Discussion project-a");
    expect(group("Sample Project").textContent).not.toContain("Discussion channel-a");
    await act(async () => buttonNamed("Slack: C_SAMPLE").click());
    for (const id of ["channel-a", "channel-b", "ambient-channel"]) {
      const link = group("Slack: C_SAMPLE").querySelector(`a[href="/w/workspace-1/chat?s=${id}"]`);
      expect(link).not.toBeNull();
      expect(link!.getAttribute("href")).not.toContain("v=workspace");
    }
    expect(group("Slack: C_SAMPLE").textContent).not.toContain("Discussion ambient-a");
    await act(async () => buttonNamed(en.chatApp.otherConversations + "1").click());
    expect(container!.textContent).toContain("Discussion ambient-a");
    expect(sessionApi.createWorkspaceSession).not.toHaveBeenCalled();
    expect(sessionApi.listWorkspaceSessions.mock.calls.every(([opts]) => opts.contextProjectId === undefined)).toBe(true);
  });

  it("shows provider icons and resolved channel/topic names while retaining source IDs in hover details", async () => {
    sessionApi.listPersonalSessions.mockResolvedValue([
      chat("slack-a", { transport: "slack", channelId: "C_ONE:thread:1.001" }),
      chat("slack-b", { transport: "slack", channelId: "C_ONE:thread:2.001", channelName: "#engineering" }),
      chat("topic-a", { transport: "telegram", channelId: "-1000000000000:topic:12", channelName: "Product team › Launch" }),
      chat("discord-a", { transport: "discord", channelId: "123456789012345678" }),
    ]);
    await renderPanel();
    const slack = buttonNamed("#engineering");
    expect(slack.title).toBe("#engineering (Slack: C_ONE)");
    expect(slack.querySelector('[data-channel-icon="slack"] svg')).not.toBeNull();
    expect(buttonNamed("Product team › Launch").querySelector('[data-channel-icon="telegram"] svg')).not.toBeNull();
    expect(buttonNamed("Discord: 123456789012345678").querySelector('[data-channel-icon="discord"] svg')).not.toBeNull();
    await act(async () => slack.click());
    expect(group("#engineering").querySelectorAll("a")).toHaveLength(2);
    await act(async () => mutateSurfaceCache<import("@/lib/api/sessions").DocSession[]>(chatSessionsCacheKey("workspace-1"), list => list.map(row => ({ ...row, ...(row.transport === "slack" ? { channelName: "#renamed" } : {}) }))));
    expect(buttonNamed("#renamed").getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps channels, transports and topics distinct, while Feishu threads share a heading", async () => {
    sessionApi.listPersonalSessions.mockResolvedValue([
      chat("slack-a", { transport: "slack", channelId: "C_ONE" }),
      chat("slack-b", { transport: "slack", channelId: "C_TWO" }),
      chat("feishu-a", { transport: "feishu", channelId: "C_ONE:thread:one" }),
      chat("feishu-b", { transport: "feishu", channelId: "C_ONE:thread:two" }),
      chat("topic-a", { transport: "telegram", channelId: "-1000000000000:topic:1" }),
      chat("topic-b", { transport: "telegram", channelId: "-1000000000000:topic:2" }),
    ]);
    await renderPanel();
    for (const label of ["Slack: C_ONE", "Slack: C_TWO", "Feishu: C_ONE", "Telegram: -1000000000000:topic:1", "Telegram: -1000000000000:topic:2"]) {
      expect(buttonNamed(label).getAttribute("aria-expanded")).toBe("false");
    }
    await act(async () => buttonNamed("Feishu: C_ONE").click());
    expect(group("Feishu: C_ONE").querySelectorAll("a")).toHaveLength(2);
    expect(container!.querySelectorAll("[data-personal-chat-group]")).toHaveLength(5);
  });

  it("resolves archived Project names and preserves unknown Projects without exposing identifiers", async () => {
    projectsApi.listContextProjects.mockResolvedValue([{ ...project, status: "archived" }]);
    sessionApi.listPersonalSessions.mockResolvedValue([
      chat("archived", { contextProjectId: project.id }),
      chat("missing", { contextProjectId: "undiscoverable-project-id" }),
    ]);
    await renderPanel();
    await act(async () => buttonNamed("Sample Project").click());
    expect(group("Sample Project").textContent).toContain("Discussion archived");
    await act(async () => buttonNamed(en.chatApp.otherProjects).click());
    expect(group(en.chatApp.otherProjects).textContent).toContain("Discussion missing");
    expect(container!.textContent).not.toContain("undiscoverable-project-id");
  });

  it("keeps readable chats available when Project metadata fails", async () => {
    projectsApi.listContextProjects.mockRejectedValue(new Error("unavailable"));
    navigation.search = "s=project-a";
    sessionApi.listPersonalSessions.mockResolvedValue([chat("project-a", { contextProjectId: project.id })]);
    await renderPanel();
    expect(container!.querySelector('[role="alert"]')?.textContent).toBe(en.chatApp.personalProjectsFailed);
    expect(group(en.chatApp.otherProjects).textContent).toContain("Discussion project-a");
  });

  it("places General first and orders other groups and rows by newest activity", async () => {
    sessionApi.listPersonalSessions.mockResolvedValue([
      chat("channel-new", { transport: "slack", channelId: "C_SAMPLE", lastActive: "2026-10-27T03:00:00.000Z" }),
      chat("project-a", { contextProjectId: project.id, lastActive: "2026-10-27T02:00:00.000Z" }),
      chat("channel-old", { transport: "slack", channelId: "C_SAMPLE" }),
      chat("general-a"),
    ]);
    await renderPanel();
    expect([...container!.querySelectorAll("[data-personal-chat-group] > button")].map(b => b.textContent)).toEqual([
      en.chatApp.generalChats, "Slack: C_SAMPLE", "Sample Project",
    ]);
    await act(async () => buttonNamed("Slack: C_SAMPLE").click());
    expect([...group("Slack: C_SAMPLE").querySelectorAll("a")].map(a => a.getAttribute("href"))).toEqual([
      "/w/workspace-1/chat?s=channel-new", "/w/workspace-1/chat?s=channel-old",
    ]);
  });

  it("retains private group choices through refresh/reload and reveals a different selected chat", async () => {
    navigation.search = "s=channel-a";
    const rows = [chat("channel-a", { transport: "slack", channelId: "C_SAMPLE" }), chat("project-a", { contextProjectId: project.id })];
    sessionApi.listPersonalSessions.mockResolvedValue(rows);
    await renderPanel();
    expect(buttonNamed("Slack: C_SAMPLE").getAttribute("aria-expanded")).toBe("true");
    await act(async () => buttonNamed("Slack: C_SAMPLE").click());
    await act(async () => mutateSurfaceCache(chatSessionsCacheKey("workspace-1"), () => rows.map(row => ({ ...row }))));
    expect(buttonNamed("Slack: C_SAMPLE").getAttribute("aria-expanded")).toBe("false");
    act(() => root!.unmount()); container!.remove();
    await renderPanel();
    expect(buttonNamed("Slack: C_SAMPLE").getAttribute("aria-expanded")).toBe("false");
    navigation.search = "s=project-a";
    await act(async () => root!.render(<I18nProvider locale="en" dict={en}><ChatSidebarPanel workspaceId="workspace-1" /></I18nProvider>));
    expect(buttonNamed("Sample Project").getAttribute("aria-expanded")).toBe("true");
    expect(buttonNamed("Slack: C_SAMPLE").getAttribute("aria-expanded")).toBe("false");
    viewer.id = "viewer-2";
    navigation.search = "";
    act(() => root!.unmount()); container!.remove();
    await renderPanel();
    expect(buttonNamed("Sample Project").getAttribute("aria-expanded")).toBe("false");
  });
});


describe("[COMP:app-web/sidebar-panel-chat] immediate selection", () => {
  it("changes a same-screen chat URL immediately without a route transition", async () => {
    window.history.replaceState(null, "", "/w/workspace-1/chat?v=workspace");
    await renderPanel();
    const row = container!.querySelector<HTMLAnchorElement>('a[href*="s=room-1"]')!;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    act(() => row.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(window.location.search).toBe("?v=workspace&s=room-1");
    expect(navigation.push).not.toHaveBeenCalled();
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it.each([{ctrlKey:true}, {metaKey:true}, {shiftKey:true}, {button:1}])("preserves modified clicks: %s", async modifiers => {
    // The handler's ordinary-link behavior is exercised through the real row.
      window.history.replaceState(null, "", "/w/workspace-1/chat?v=workspace");
      await renderPanel();
      const row = container!.querySelector<HTMLAnchorElement>('a[href*="s=room-1"]')!;
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...modifiers });
      act(() => row.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
      expect(window.location.search).toBe("?v=workspace");
  });
});
