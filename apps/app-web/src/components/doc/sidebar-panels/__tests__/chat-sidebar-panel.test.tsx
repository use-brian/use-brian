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
import { resetSurfaceCache } from "@/lib/surface-cache";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navigation = vi.hoisted(() => ({
  search: "v=workspace&s=room-1",
  replace: vi.fn(),
  push: vi.fn(),
}));

const projectsApi = vi.hoisted(() => ({ listContextProjects: vi.fn() }));
vi.mock("@/lib/api/context-scopes", () => projectsApi);

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

async function renderPanel() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider locale="en" dict={en}>
        <ChatSidebarPanel workspaceId="workspace-1" />
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
