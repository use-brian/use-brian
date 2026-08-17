// @vitest-environment jsdom

/** [COMP:app-web/surface-chat-seed] Shared dock event contract. */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  requestSurfaceChatSeed,
  SURFACE_CHAT_SEED_EVENT,
  type SurfaceChatSeed,
} from "../surface-chat-seed";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("[COMP:app-web/surface-chat-seed] requestSurfaceChatSeed", () => {
  it("carries an explicitly confirmed auto-send instruction to the dock", () => {
    const seen: SurfaceChatSeed[] = [];
    window.addEventListener(
      SURFACE_CHAT_SEED_EVENT,
      (event: Event) => {
        seen.push((event as CustomEvent<SurfaceChatSeed>).detail);
      },
      { once: true },
    );

    requestSurfaceChatSeed({
      prefill: "Update task task-1",
      autoSend: true,
    });

    expect(seen).toEqual([
      { prefill: "Update task task-1", autoSend: true },
    ]);
  });

  it("drops an empty prefill", () => {
    const listener = vi.fn();
    window.addEventListener(SURFACE_CHAT_SEED_EVENT, listener, { once: true });

    requestSurfaceChatSeed({ prefill: "   ", autoSend: true });

    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener(SURFACE_CHAT_SEED_EVENT, listener);
  });
});
