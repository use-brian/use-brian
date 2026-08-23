// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedDock } from "@/lib/api/home-dock";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const nav = vi.hoisted(() => ({ push: vi.fn() }));
const sidebar = vi.hoisted(() => ({
  dock: null as ResolvedDock | null,
  dockLoading: true,
  reloadDock: vi.fn(),
  setDock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => nav,
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@/lib/i18n/client", () => ({
  useT: () => ({
    docPage: {
      suggested: {
        greetingMorning: "Good morning",
        greetingAfternoon: "Good afternoon",
        greetingEvening: "Good evening",
        subtitle: "Curated by your assistant",
        refresh: "Refresh",
        refreshing: "Refreshing",
        buildPlaceholder: "Ask anything",
        needsYou: "Needs you",
        approvalsTitle: "Approvals waiting",
        approvalsCaption: "Grouped by what happens next",
        approvalsCta: "Open approvals",
        approvalGroups: {
          externalActionsTitle: "Actions to approve",
          externalActionsCaption: "Emails and tool calls",
          contentReviewTitle: "Content to review",
          contentReviewCaption: "Posts and replies",
          systemImprovementsTitle: "Improvements to apply",
          systemImprovementsCaption: "Skills and workflows",
          questionsAndAccessTitle: "Questions and access",
          questionsAndAccessCaption: "Questions and email senders",
        },
        yourBrain: "Your brain",
        entries: "entries",
        quietWeek: "Quiet this week",
        comingUp: "Coming up",
        noScheduledTitle: "No scheduled runs",
        noScheduledBody: "Scheduled workflows show here.",
        buildWorkflow: "Build a workflow",
      },
    },
    chat: {
      switchAssistant: "Switch assistant",
      switchAssistantTitle: "Talk to",
      send: "Send",
    },
  }),
}));

vi.mock("@/components/assistant-avatar", () => ({
  AssistantAvatar: ({ name }: { name: string }) => (
    <span data-assistant-avatar={name}>{name}</span>
  ),
}));

vi.mock("@/components/doc/suggested-file-drop", () => ({
  SuggestedFileDrop: () => null,
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children, ...props }: { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/lib/api/views", () => ({
  listWorkspaceAssistants: vi.fn().mockResolvedValue([
    {
      id: "assistant-primary",
      name: "Brian",
      iconSeed: 1,
      kind: "primary",
      appType: null,
    },
    {
      id: "assistant-specialist",
      name: "Researcher",
      iconSeed: 2,
      kind: "standard",
      appType: null,
    },
  ]),
}));

vi.mock("@/lib/api/home-dock", () => ({
  refreshHomeDock: vi.fn(),
  pendingApprovalTotal: (dock: ResolvedDock | null) =>
    Math.max(
      0,
      dock?.needsYou.find((need) => need.kind === "approvals")?.count ?? 0,
    ),
}));

vi.mock("../doc-sidebar-data", () => ({
  useSidebarData: () => ({
    dock: sidebar.dock,
    dockLoading: sidebar.dockLoading,
    reloadDock: sidebar.reloadDock,
    setDock: sidebar.setDock,
  }),
}));

import { takeChatHandoff } from "@/lib/chat-handoff";
import { SuggestedView } from "../suggested-view";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  nav.push.mockReset();
  sidebar.dock = null;
  sidebar.dockLoading = true;
  sidebar.reloadDock.mockReset();
  sidebar.setDock.mockReset();
  window.sessionStorage.clear();
  takeChatHandoff("workspace-1", Date.now());
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("[COMP:app-web/home-suggested] Personal-chat launcher", () => {
  it("chooses an assistant and hands the prompt to a fresh Personal chat", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <SuggestedView
          workspaceId="workspace-1"
          assistantId="assistant-primary"
          userName="You"
        />,
      );
    });

    const researcher = container
      .querySelector('[data-assistant-avatar="Researcher"]')
      ?.closest("button");
    expect(researcher).toBeTruthy();
    act(() => researcher?.click());

    const input = container.querySelector<HTMLInputElement>(
      'input[placeholder="Ask anything"]',
    );
    expect(input).toBeTruthy();
    await act(async () => {
      if (!input) return;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        input,
        "  Compare this week's pipeline  ",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container
        ?.querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(nav.push).toHaveBeenCalledWith(
      "/w/workspace-1/chat?v=personal&assistant=assistant-specialist",
    );
    expect(takeChatHandoff("workspace-1", Date.now())).toMatchObject({
      workspaceId: "workspace-1",
      assistantId: "assistant-specialist",
      text: "Compare this week's pipeline",
    });
  });

  it("renders pending approvals as four live groups and opens the queue", async () => {
    const onOpenPanel = vi.fn();
    sidebar.dockLoading = false;
    sidebar.dock = {
      source: "default",
      generatedAt: null,
      note: null,
      needsYou: [{ kind: "approvals", count: 10, caption: null }],
      approvalGroups: {
        externalActions: 4,
        contentReview: 1,
        systemImprovements: 3,
        questionsAndAccess: 2,
      },
      pickUp: [],
      comingUp: [],
      brain: {
        entryCount: 0,
        growth7d: 0,
        sparkline: [],
        hasConnector: true,
      },
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <SuggestedView
          workspaceId="workspace-1"
          assistantId="assistant-primary"
          onOpenPanel={onOpenPanel}
        />,
      );
    });

    expect(container.textContent).toContain("Actions to approve");
    expect(container.textContent).toContain("Content to review");
    expect(container.textContent).toContain("Improvements to apply");
    expect(container.textContent).toContain("Questions and access");
    expect(container.textContent).toContain("10");

    const approvalButton = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Open approvals"),
    );
    expect(approvalButton).toBeTruthy();
    act(() => approvalButton?.click());
    expect(onOpenPanel).toHaveBeenCalledWith("approvals");
  });
});
