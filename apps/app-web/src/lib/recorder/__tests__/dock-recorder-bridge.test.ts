import { afterEach, describe, expect, it, vi } from "vitest";
import type { DockRecorderApi } from "../use-dock-recorder";
import {
  getDockRecorderController,
  getDockRecorderSessionId,
  publishDockRecorderController,
  registerDockRecorderChatTarget,
  resetDockRecorderBridgeForTest,
  sendDockRecorderVoiceClip,
} from "../dock-recorder-bridge";

afterEach(() => resetDockRecorderBridgeForTest());

describe("[COMP:app-web/dock-recorder] replacement-chat bridge", () => {
  it("keeps the newest published controller when an older publisher releases", () => {
    const first = { phase: { kind: "idle" } } as DockRecorderApi;
    const second = { phase: { kind: "arming" } } as DockRecorderApi;
    const releaseFirst = publishDockRecorderController(first);
    const releaseSecond = publishDockRecorderController(second);

    releaseFirst();
    expect(getDockRecorderController()).toBe(second);
    releaseSecond();
    expect(getDockRecorderController()).toBeNull();
  });

  it("routes short captures and their upload session to the visible target", async () => {
    const fallbackSend = vi.fn(async () => true);
    const targetSend = vi.fn(async () => true);
    const release = registerDockRecorderChatTarget({
      sendVoiceClip: targetSend,
      getSessionId: () => "tuning-session",
    });

    await expect(sendDockRecorderVoiceClip("file-1", fallbackSend)).resolves.toBe(true);
    expect(targetSend).toHaveBeenCalledWith("file-1");
    expect(fallbackSend).not.toHaveBeenCalled();
    expect(getDockRecorderSessionId(() => "global-session")).toBe("tuning-session");

    release();
    await sendDockRecorderVoiceClip("file-2", fallbackSend);
    expect(fallbackSend).toHaveBeenCalledWith("file-2");
    expect(getDockRecorderSessionId(() => "global-session")).toBe("global-session");
  });

  it("restores the prior target after an overlapping target releases", async () => {
    const first = vi.fn(async () => true);
    const second = vi.fn(async () => true);
    const releaseFirst = registerDockRecorderChatTarget({
      sendVoiceClip: first,
      getSessionId: () => "first",
    });
    const releaseSecond = registerDockRecorderChatTarget({
      sendVoiceClip: second,
      getSessionId: () => "second",
    });

    await sendDockRecorderVoiceClip("new", async () => false);
    expect(second).toHaveBeenCalledWith("new");
    releaseSecond();
    await sendDockRecorderVoiceClip("old", async () => false);
    expect(first).toHaveBeenCalledWith("old");
    releaseFirst();
  });
});
