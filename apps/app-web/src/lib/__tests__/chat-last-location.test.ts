// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearChatLocation,
  navigateChatLocation,
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

describe("[COMP:app-web/chat-last-location] immediate same-screen navigation", () => {
  afterEach(() => { vi.restoreAllMocks(); window.history.replaceState(null, "", "/"); });

  it("pushes a chat selection synchronously and lets Next supply its history fields", () => {
    window.history.replaceState({ __NA: true }, "", "/w/w1/chat?s=first");
    const push = vi.spyOn(window.history, "pushState");
    expect(navigateChatLocation("/w/w1/chat?v=workspace&s=second")).toBe(true);
    expect(window.location.search).toBe("?v=workspace&s=second");
    expect(push).toHaveBeenCalledWith(null, "", expect.stringContaining("/w/w1/chat?v=workspace&s=second"));
    // Clicking the selected row must not create a second Back step.
    navigateChatLocation("/w/w1/chat?v=workspace&s=second");
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("replaces adoption/restoration and accepts query-only Chat Home selection", () => {
    window.history.replaceState(null, "", "/w/w1");
    const replace = vi.spyOn(window.history, "replaceState");
    expect(navigateChatLocation("/w/w1?s=created", true)).toBe(true);
    expect(replace).toHaveBeenCalledOnce();
    expect(window.location.search).toBe("?s=created");
  });

  it.each(["/w/w2/chat?s=second", "/w/w1/brain", "https://outside.example/w/w1/chat?s=second"])("leaves other routes and origins to the router: %s", href => {
    window.history.replaceState(null, "", "/w/w1/chat?s=first");
    const push = vi.spyOn(window.history, "pushState");
    expect(navigateChatLocation(href)).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });

  it("leaves the desktop hash route and non-Chat pages to their router", () => {
    window.history.replaceState(null, "", "/renderer/index.html#/w/w1/chat?s=first");
    expect(navigateChatLocation("/w/w1/chat?s=second")).toBe(false);
    window.history.replaceState(null, "", "/w/w1/brain");
    expect(navigateChatLocation("?s=second")).toBe(false);
  });
});
