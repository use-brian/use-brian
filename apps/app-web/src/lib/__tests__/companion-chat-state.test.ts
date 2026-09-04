import { describe, expect, it } from "vitest";

import { companionChatPhase } from "../companion-chat-state";

describe("[COMP:app-web/desktop-chat-window] companion chat state", () => {
  it("maps the chat lifecycle and gives required action highest priority", () => {
    expect(
      companionChatPhase({
        isStreaming: true,
        hasStreamingText: true,
        requiresAction: true,
        isLoading: false,
      }),
    ).toBe("action-required");
    expect(
      companionChatPhase({
        isStreaming: true,
        hasStreamingText: false,
        requiresAction: false,
        isLoading: false,
      }),
    ).toBe("thinking");
    expect(
      companionChatPhase({
        isStreaming: true,
        hasStreamingText: true,
        requiresAction: false,
        isLoading: false,
      }),
    ).toBe("responding");
    expect(
      companionChatPhase({
        isStreaming: false,
        hasStreamingText: false,
        requiresAction: false,
        isLoading: true,
      }),
    ).toBe("loading");
    expect(
      companionChatPhase({
        isStreaming: false,
        hasStreamingText: false,
        requiresAction: false,
        isLoading: false,
      }),
    ).toBe("idle");
  });
});
