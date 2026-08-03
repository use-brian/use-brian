// @vitest-environment jsdom
/**
 * [COMP:app-web/skill-iteration-chat] — the creator's replacement chat must
 * rehost the one app-wide recorder and own its short-voice hand-off while the
 * global chat chrome is suppressed.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DockRecorderApi } from "@/lib/recorder/use-dock-recorder";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const bridge = vi.hoisted(() => ({
  release: vi.fn(),
  register: vi.fn(),
  recorder: { phase: { kind: "idle" } } as DockRecorderApi,
}));
bridge.register.mockImplementation(() => bridge.release);

const attachmentApi = vi.hoisted(() => ({
  attachments: [],
  uploading: false,
  upload: vi.fn(),
  remove: vi.fn(),
  fileIds: vi.fn(() => []),
  clear: vi.fn(),
}));
const draftApi = vi.hoisted(() => ({
  turn: vi.fn(),
}));

vi.mock("@/lib/recorder/dock-recorder-bridge", () => ({
  useGlobalDockRecorder: () => bridge.recorder,
  registerDockRecorderChatTarget: bridge.register,
}));
vi.mock("@/components/chrome/dock-recorder", async () => {
  const React = await import("react");
  return {
    DockRecorderButton: () =>
      React.createElement("button", { "data-skill-recorder": "button" }),
    DockRecorderNotice: () =>
      React.createElement("div", { "data-skill-recorder": "notice" }),
    DockRecorderRecovery: () =>
      React.createElement("div", { "data-skill-recorder": "recovery" }),
    DockRecorderStrip: () =>
      React.createElement("div", { "data-skill-recorder": "strip" }),
  };
});
vi.mock("@/components/doc/composer-controls", async () => {
  const React = await import("react");
  return {
    useComposerControls: () => ({
      model: "standard",
      setModel: vi.fn(),
      plan: "max",
      researchMode: false,
      setResearchMode: vi.fn(),
      researchQuota: null,
      researchExhausted: false,
    }),
    ComposerControls: () =>
      React.createElement("div", { "data-composer-controls": true }),
  };
});
vi.mock("@/lib/use-file-attachments", () => ({
  useFileAttachments: () => attachmentApi,
}));
vi.mock("@/lib/use-file-drop", () => ({
  useFileDrop: () => ({ isDragging: false, dropProps: {} }),
}));
vi.mock("@/lib/use-auto-grow-textarea", () => ({
  useAutoGrowTextarea: () => {},
}));
vi.mock("@/lib/api/skills", () => ({
  draftSkillTurn: draftApi.turn,
}));
vi.mock("@/components/chrome/chat-code-block", () => ({
  chatMarkdownCodeComponents: {},
}));
vi.mock("@use-brian/chat-ui", async () => {
  const React = await import("react");
  return {
    ChatMarkdown: ({ text }: { text: string }) => React.createElement("div", null, text),
  };
});
vi.mock("@/lib/i18n/client", () => ({
  useT: () => ({
    brainPage: {
      skillChat: {
        emptyHint: "Ask for changes",
        placeholder: "Tell the assistant what to change",
        draftApplied: "Draft updated",
        drafting: "Drafting",
        send: "Send",
        attach: "Attach files",
        voiceMessage: "Voice message",
      },
    },
  }),
}));

import { SkillIterationChat } from "../skill-iteration-chat";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
  bridge.register.mockImplementation(() => bridge.release);
});

describe("[COMP:app-web/skill-iteration-chat] shared recorder", () => {
  it("renders the recorder chrome and routes a short clip into this visible chat", async () => {
    draftApi.turn.mockResolvedValue({
      ok: true,
      kind: "reply",
      message: "Updated from voice",
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root!.render(
        <SkillIterationChat
          workspaceId="w-1"
          getDraft={() => ({
            name: "Skill",
            description: "Description",
            whenToUse: "When",
            content: "# Steps",
            sensitivity: "internal",
          })}
          onDraft={vi.fn()}
        />,
      );
    });

    expect(container.querySelector('[data-skill-recorder="button"]')).not.toBeNull();
    expect(container.querySelector('[data-skill-recorder="recovery"]')).not.toBeNull();
    expect(container.querySelector('[data-skill-recorder="notice"]')).not.toBeNull();
    expect(container.querySelector('[data-skill-recorder="strip"]')).not.toBeNull();
    expect(bridge.register).toHaveBeenCalledTimes(1);
    const target = bridge.register.mock.calls[0]![0];
    expect(target.getSessionId()).toBeUndefined();

    let sent = false;
    await act(async () => {
      sent = await target.sendVoiceClip("f-voice");
    });
    expect(sent).toBe(true);
    expect(draftApi.turn).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "w-1",
        fileIds: ["f-voice"],
        messages: [{ role: "user", content: "Voice message" }],
      }),
    );
    // A voice auto-send must not consume files the user staged separately in
    // the visible composer.
    expect(attachmentApi.clear).not.toHaveBeenCalled();
  });
});
