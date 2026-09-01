import { describe, expect, it } from "vitest";

import {
  desktopChatRoute,
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
  });
});
