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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navigation = vi.hoisted(() => ({
  search: "v=workspace&s=room-1",
  replace: vi.fn(),
  push: vi.fn(),
}));

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

vi.mock("@/lib/chat-seen", () => ({ isRoomUnread: () => false }));
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
  vi.clearAllMocks();
  navigation.search = "v=workspace&s=room-1";
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
