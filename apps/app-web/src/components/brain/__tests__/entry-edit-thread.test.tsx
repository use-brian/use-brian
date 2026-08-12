// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const chat = vi.hoisted(() => ({
  state: {
    messages: [],
    pendingConfirmations: [],
    isStreaming: false,
    streamingText: "",
  },
  dispatch: vi.fn(),
  setSession: vi.fn(),
  appendMessage: vi.fn(),
  addConfirmation: vi.fn(),
  updateConfirmation: vi.fn(),
  clearConfirmations: vi.fn(),
}));
const stream = vi.hoisted(() => ({
  start: vi.fn(),
  abort: vi.fn(),
}));

vi.mock("@use-brian/chat-ui", async () => {
  const React = await import("react");
  return {
    useChatSession: () => chat,
    useMessageStream: () => stream,
    ChatMarkdown: ({ text }: { text: string }) =>
      React.createElement("div", null, text),
  };
});
vi.mock("@/components/assistant-avatar", async () => {
  const React = await import("react");
  return { AssistantAvatar: () => React.createElement("div") };
});
vi.mock("@/components/chrome/chat-confirmation-card", async () => {
  const React = await import("react");
  return { ChatConfirmationCard: () => React.createElement("div") };
});
vi.mock("@/lib/i18n/client", () => ({
  useT: () => ({
    brainPage: {
      detailDrawer: {
        editThreadHeading: "Edit with assistant",
        editThreadEphemeral: "Temporary",
        editThreadDisclosure:
          "Edits only this entry. Nothing changes until you apply it.",
        editThreadPlaceholder: "Tell the assistant what to change...",
        editThreadSuggestion1: "Update outdated details",
        editThreadSuggestion2: "Rewrite the detail",
        editThreadSuggestion3: "Fix facts and wording",
        editThreadApply: "Apply changes",
        editThreadKeepEditing: "Keep editing",
        editThreadApplying: "Applying...",
        editThreadSuccess: "Changes applied to this entry.",
        threadStop: "Stop",
      },
    },
    memoriesReview: {
      unknownAuthor: "Assistant",
      askError: "Error",
      thinking: "Thinking",
      send: "Send",
    },
    chat: {},
  }),
}));
vi.mock("@/lib/api/brain-inbox", () => ({
  createBrainEditSession: vi.fn(),
}));
vi.mock("@/lib/brain-events", () => ({ requestBrainRefresh: vi.fn() }));

import { EntryEditThread } from "../entry-edit-thread";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe("[COMP:app-web/brain-entry-edit-thread] separate edit surface", () => {
  it("renders edit-specific guidance and never presents itself as the Ask thread", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <EntryEditThread
          workspaceId="workspace-1"
          primitive="memory"
          rowId="11111111-1111-4111-8111-111111111111"
          onUpdated={vi.fn()}
        />,
      );
    });

    expect(container.textContent).toContain("Edit with assistant");
    expect(container.textContent).toContain("Update outdated details");
    expect(container.textContent).toContain(
      "Nothing changes until you apply it",
    );
    expect(container.textContent).not.toContain("Ask about this entry");
    expect(stream.start).not.toHaveBeenCalled();
  });
});
