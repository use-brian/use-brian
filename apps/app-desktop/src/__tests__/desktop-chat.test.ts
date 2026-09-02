import { describe, expect, it } from "vitest";

import {
  companionClickFollowsChatBlur,
  desktopChatRoute,
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
