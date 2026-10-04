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

  it("preserves a project-scoped editable draft through storage", () => {
    const payload={...base,contextProjectId:"project-1",draftOnly:true};
    const requestId=stashChatHandoff(payload);
    expect(takeChatHandoff(base.workspaceId,base.ts)).toEqual({...payload,requestId});
    expect(parsePendingChatHandoff(JSON.stringify({...payload,contextProjectId:42,draftOnly:"true"})))
      .toEqual(base);
  });

  it("parses a valid payload and trims its prompt", () => {
    expect(
      parsePendingChatHandoff(JSON.stringify({ ...base, text: "  Ask Brian  " })),
    ).toEqual({ ...base, text: "Ask Brian" });
  });

  it("carries the Pages landing's research flag and attachments", () => {
    expect(
      parsePendingChatHandoff(
        JSON.stringify({
          ...base,
          researchMode: true,
          fileIds: ["file-1", 7, ""],
          attachedRecordingIds: ["rec-1"],
        }),
      ),
    ).toEqual({
      ...base,
      researchMode: true,
      fileIds: ["file-1"],
      attachedRecordingIds: ["rec-1"],
    });
  });

  it("accepts an attachment-only payload with no prompt text", () => {
    expect(
      parsePendingChatHandoff(
        JSON.stringify({ ...base, text: "  ", fileIds: ["file-1"] }),
      ),
    ).toEqual({ ...base, text: "", fileIds: ["file-1"] });
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
    const requestId = stashChatHandoff(base);
    expect(takeChatHandoff(base.workspaceId, base.ts)).toEqual({ ...base, requestId });
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
