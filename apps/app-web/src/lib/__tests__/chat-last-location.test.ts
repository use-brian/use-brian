// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearChatLocation,
  readChatLocation,
  seedChatLocation,
  writeChatLocation,
} from "../chat-last-location";

describe("[COMP:app-web/chat-last-location] remembered chat location", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("round-trips the audience and the open thread, per workspace", () => {
    writeChatLocation("w1", { view: "workspace", sessionId: "s-1" });
    writeChatLocation("w2", { view: "personal", sessionId: "s-2" });

    expect(readChatLocation("w1")).toEqual({
      view: "workspace",
      sessionId: "s-1",
    });
    expect(readChatLocation("w2")).toEqual({
      view: "personal",
      sessionId: "s-2",
    });
  });

  it("remembers a fresh pane (no open thread) as such", () => {
    writeChatLocation("w1", { view: "workspace", sessionId: null });
    expect(readChatLocation("w1")).toEqual({
      view: "workspace",
      sessionId: null,
    });
  });

  it("has nothing to say about an unvisited workspace, and forgets on clear", () => {
    expect(readChatLocation("w1")).toBeNull();
    writeChatLocation("w1", { view: "workspace", sessionId: "s-1" });
    clearChatLocation("w1");
    expect(readChatLocation("w1")).toBeNull();
  });

  it("degrades to no memory on a corrupt or foreign payload", () => {
    window.localStorage.setItem("sidan:chat-location:w1", "not json");
    expect(readChatLocation("w1")).toBeNull();
    // A shape that parses but says nothing useful reads as the safe default,
    // never a thrown surface.
    window.localStorage.setItem("sidan:chat-location:w2", JSON.stringify({ v: 7, s: 9 }));
    expect(readChatLocation("w2")).toEqual({ view: "personal", sessionId: null });
  });

  it("restores the remembered location for a BARE entry URL", () => {
    expect(
      seedChatLocation({ view: "workspace", sessionId: "s-1" }, false),
    ).toEqual({ view: "workspace", sessionId: "s-1" });
    // The audience alone is worth restoring — a Workspace fresh pane is not
    // what a bare URL means.
    expect(seedChatLocation({ view: "workspace", sessionId: null }, false)).toEqual({
      view: "workspace",
      sessionId: null,
    });
    expect(seedChatLocation({ view: "personal", sessionId: "s-2" }, false)).toEqual({
      view: "personal",
      sessionId: "s-2",
    });
  });

  it("lets a URL that names a location win", () => {
    // Deep link, rail row, in-surface navigation, installer `?assistant=` hint.
    expect(
      seedChatLocation({ view: "workspace", sessionId: "s-1" }, true),
    ).toBeNull();
  });

  it("restores nothing when there is nothing to restore", () => {
    expect(seedChatLocation(null, false)).toBeNull();
    // The remembered location IS what a bare URL already means.
    expect(seedChatLocation({ view: "personal", sessionId: null }, false)).toBeNull();
  });
});
