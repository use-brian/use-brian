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
import { mutateSurfaceCache, resetSurfaceCache } from "@/lib/surface-cache";
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
    ...props
  }: {
    href: string;
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
  listSessionsForAssistants: vi.fn(),
  listWorkspaceSessions: vi.fn(),
  renameSessionTitle: vi.fn(),
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

vi.mock("@/components/assistant-avatar", () => ({
  AssistantAvatar: ({ name }: { name: string }) => <span>{name}</span>,
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
  const button = [...container!.querySelectorAll("button")].find(
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
  sessionApi.listSessionsForAssistants.mockResolvedValue([]);
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
  dialogs.confirmDialog.mockResolvedValue(true);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
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
  it("pulses a running room avatar and settles from the same-tab activity signal", async () => {
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
    expect(working?.classList.contains("animate-pulse")).toBe(true);
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

describe("[COMP:app-web/sidebar-panel-chat] one row renderer for both rails (chat-parity T4)", () => {
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

  it("pulses a running personal chat exactly as it pulses a room", async () => {
    navigation.search = "";
    sessionApi.listSessionsForAssistants.mockResolvedValue([personalRow]);
    await renderPanel();
    const working = container!.querySelector('[data-chat-working="true"]');
    expect(working).not.toBeNull();
    expect(working?.getAttribute("aria-label")).toBe("Brian is working");
  });

  it("never dots a conversation with one human", async () => {
    seen.isRoomUnread.mockReturnValue(true);
    navigation.search = "";
    sessionApi.listSessionsForAssistants.mockResolvedValue([{ ...personalRow, status: "idle" }]);
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
    sessionApi.listSessionsForAssistants.mockResolvedValue([
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

  it("keeps channels, transports and topics distinct, while Feishu threads share a heading", async () => {
    sessionApi.listSessionsForAssistants.mockResolvedValue([
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
    sessionApi.listSessionsForAssistants.mockResolvedValue([
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
    sessionApi.listSessionsForAssistants.mockResolvedValue([chat("project-a", { contextProjectId: project.id })]);
    await renderPanel();
    expect(container!.querySelector('[role="alert"]')?.textContent).toBe(en.chatApp.personalProjectsFailed);
    expect(group(en.chatApp.otherProjects).textContent).toContain("Discussion project-a");
  });

  it("places General first and orders other groups and rows by newest activity", async () => {
    sessionApi.listSessionsForAssistants.mockResolvedValue([
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
    sessionApi.listSessionsForAssistants.mockResolvedValue(rows);
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
