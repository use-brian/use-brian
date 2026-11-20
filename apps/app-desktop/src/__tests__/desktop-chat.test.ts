import { describe, expect, it } from "vitest";

import {
  chatWindowSurvivesIdentityChange,
  companionClickFollowsChatBlur,
  desktopChatRoute,
  nativeUseBrianTarget,
  parseCompanionState,
  workspaceIdFromDesktopRoute,
} from "../desktop-chat.js";

describe("[COMP:app-desktop/awake-brian] desktop chat routing", () => {
  it("extracts workspace ids only from canonical workspace routes", () => {
    expect(workspaceIdFromDesktopRoute("/w/ws-1/p/page-1")).toBe("ws-1");
    expect(workspaceIdFromDesktopRoute("/w/team%20one/brain")).toBe("team one");
    expect(workspaceIdFromDesktopRoute("/desktop/chat/ws-1")).toBeNull();
    expect(workspaceIdFromDesktopRoute("/workspaces/ws-1")).toBeNull();
    expect(workspaceIdFromDesktopRoute("/w/%2F/brain")).toBeNull();
  });

  it("builds the shared live and bundled chat route", () => {
    expect(desktopChatRoute("team one")).toBe("/desktop/chat/team%20one");
    expect(desktopChatRoute("team one", "assistant/one")).toBe(
      "/desktop/chat/team%20one?assistant=assistant%2Fone",
    );
  });

  it("routes native Use Brian requests to the one visible chat owner", () => {
    expect(nativeUseBrianTarget(false, "ws-1")).toBe("main");
    expect(nativeUseBrianTarget(false, null)).toBe("main");
    expect(nativeUseBrianTarget(true, "ws-1")).toBe("nearby");
    expect(nativeUseBrianTarget(true, null)).toBe("nearby-pending");
  });

  it("accepts only bounded display-only companion state", () => {
    expect(parseCompanionState({ phase: "thinking", label: "Searching\nnow" })).toEqual({
      phase: "thinking",
      label: "Searching now",
    });
    expect(parseCompanionState({ phase: "unknown", label: "no" })).toBeNull();
    expect(parseCompanionState({ phase: "idle", label: "x".repeat(200) })?.label).toHaveLength(120);
  });

  it("treats the companion click that caused blur as a close, not a reopen", () => {
    expect(companionClickFollowsChatBlur(1_250, 1_000)).toBe(true);
    expect(companionClickFollowsChatBlur(1_500, 1_000)).toBe(false);
    expect(companionClickFollowsChatBlur(1_000, 0)).toBe(false);
  });
});

describe("[COMP:app-desktop/awake-brian] chat window identity isolation rule", () => {
  it("retires the chat window on every account, deployment and sign-out transition", () => {
    expect(chatWindowSurvivesIdentityChange({ kind: "account-switch" })).toBe(false);
    expect(chatWindowSurvivesIdentityChange({ kind: "deployment-switch" })).toBe(false);
    expect(chatWindowSurvivesIdentityChange({ kind: "sign-out" })).toBe(false);
  });

  it("keeps the chat window only for a restore proven to be the same identity", () => {
    const restored = (previousUserId?: string | null, intendedUserId?: string | null, restoredUserId = "user-a") =>
      chatWindowSurvivesIdentityChange({ kind: "session-restored", restoredUserId, previousUserId, intendedUserId });
    expect(restored("user-a")).toBe(true);
    expect(restored(null, "user-a")).toBe(true);
    expect(restored("user-b")).toBe(false);
    expect(restored("user-b", "user-a")).toBe(false);
    expect(restored(null, "user-b")).toBe(false);
    expect(restored(null, null)).toBe(false);
    expect(restored(undefined, undefined)).toBe(false);
    expect(restored("", "", "")).toBe(false);
  });
});
