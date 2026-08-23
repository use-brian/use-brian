// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  CHAT_HANDOFF_TTL_MS,
  isPendingChatHandoffFresh,
  parsePendingChatHandoff,
  personalChatHandoffPath,
  resolveChatHandoffAction,
  stashChatHandoff,
  takeChatHandoff,
  type PendingChatHandoff,
} from "@/lib/chat-handoff";

const base: PendingChatHandoff = {
  workspaceId: "workspace-1",
  assistantId: "assistant-2",
  text: "Help me plan tomorrow",
  ts: 10_000,
};

describe("[COMP:app-web/chat-handoff] Home to Personal chat handoff", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    takeChatHandoff(base.workspaceId, base.ts);
  });

  it("parses a valid payload and trims its prompt", () => {
    expect(
      parsePendingChatHandoff(JSON.stringify({ ...base, text: "  Ask Brian  " })),
    ).toEqual({ ...base, text: "Ask Brian" });
  });

  it("rejects malformed or empty payloads", () => {
    expect(parsePendingChatHandoff(null)).toBeNull();
    expect(parsePendingChatHandoff("not json")).toBeNull();
    expect(
      parsePendingChatHandoff(JSON.stringify({ ...base, text: "  " })),
    ).toBeNull();
    expect(
      parsePendingChatHandoff(JSON.stringify({ ...base, ts: "now" })),
    ).toBeNull();
  });

  it("is workspace-scoped, fresh for three minutes, and rejects future dates", () => {
    expect(isPendingChatHandoffFresh(base, base.workspaceId, base.ts)).toBe(true);
    expect(
      isPendingChatHandoffFresh(
        base,
        base.workspaceId,
        base.ts + CHAT_HANDOFF_TTL_MS - 1,
      ),
    ).toBe(true);
    expect(
      isPendingChatHandoffFresh(
        base,
        base.workspaceId,
        base.ts + CHAT_HANDOFF_TTL_MS,
      ),
    ).toBe(false);
    expect(isPendingChatHandoffFresh(base, "workspace-2", base.ts)).toBe(false);
    expect(isPendingChatHandoffFresh(base, base.workspaceId, base.ts - 1)).toBe(false);
  });

  it("is single-consume and keeps the prompt out of the destination URL", () => {
    stashChatHandoff(base);
    expect(takeChatHandoff(base.workspaceId, base.ts)).toEqual(base);
    expect(takeChatHandoff(base.workspaceId, base.ts)).toBeNull();
    expect(personalChatHandoffPath(base.workspaceId, base.assistantId)).toBe(
      "/w/workspace-1/chat?v=personal&assistant=assistant-2",
    );
  });

  it("waits for the selected assistant, sends only to an exact match, and preserves invalid targets", () => {
    const common = {
      handoff: base,
      assistantIds: ["assistant-1", "assistant-2"],
      activeSessionId: null,
      view: "personal" as const,
    };
    expect(
      resolveChatHandoffAction({
        ...common,
        assistantsLoaded: false,
        activeAssistantId: null,
      }),
    ).toBe("wait");
    expect(
      resolveChatHandoffAction({
        ...common,
        assistantsLoaded: true,
        activeAssistantId: "assistant-1",
      }),
    ).toBe("wait");
    expect(
      resolveChatHandoffAction({
        ...common,
        assistantsLoaded: true,
        activeAssistantId: "assistant-2",
      }),
    ).toBe("send");
    expect(
      resolveChatHandoffAction({
        ...common,
        assistantsLoaded: true,
        assistantIds: ["assistant-1"],
        activeAssistantId: "assistant-1",
      }),
    ).toBe("prefill");
  });

  it("drops a handoff rather than injecting it into an existing thread or room", () => {
    expect(
      resolveChatHandoffAction({
        handoff: base,
        assistantsLoaded: true,
        assistantIds: [base.assistantId],
        activeAssistantId: base.assistantId,
        activeSessionId: "session-1",
        view: "personal",
      }),
    ).toBe("drop");
    expect(
      resolveChatHandoffAction({
        handoff: base,
        assistantsLoaded: true,
        assistantIds: [base.assistantId],
        activeAssistantId: base.assistantId,
        activeSessionId: null,
        view: "workspace",
      }),
    ).toBe("drop");
  });
});
