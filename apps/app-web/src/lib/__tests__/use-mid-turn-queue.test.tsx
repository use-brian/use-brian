// @vitest-environment jsdom
/** [COMP:app-web/mid-turn-queue] Session ownership and completion races. */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { joinQueuedInputs, useMidTurnQueue } from "../use-mid-turn-queue";

vi.mock("../auth-fetch", () => ({ authFetch: vi.fn() }));
vi.mock("@/lib/runtime-public-config", () => ({ publicRuntimeConfig: () => ({ apiUrl: "https://api.test" }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
let sessionId: string | null;
let latest: ReturnType<typeof useMidTurnQueue>;
const sideStream = vi.fn().mockResolvedValue(undefined);
function Harness() {
  latest = useMidTurnQueue({ stream: { sideStream }, getSessionId: () => sessionId });
  return null;
}
function render() { act(() => root.render(createElement(Harness))); }
function enqueue(text: string) {
  act(() => { expect(latest.queue(text, false)).toBe(true); });
  return latest.queued.at(-1)!;
}
beforeEach(() => {
  sideStream.mockClear();
  sessionId = "A";
  host = document.createElement("div");
  root = createRoot(host);
  render();
});
afterEach(() => { act(() => root.unmount()); });

describe("[COMP:app-web/mid-turn-queue]", () => {
  it("keeps same-tick queue, steer, take and drain consistent", () => {
    act(() => {
      latest.queue(" first ", false);
      const id = sideStream.mock.calls[0][0].body.inputId;
      latest.steer(id);
      latest.steer(id);
      expect(sideStream).toHaveBeenCalledTimes(2);
      expect(latest.take(id, "A")).toMatchObject({ text: "first", sessionId: "A", steer: true });
      expect(latest.take(id, "A")).toBeNull();
      latest.queue("second", false);
      latest.queue("third", false);
      expect(joinQueuedInputs(latest.drain("A"))).toBe("second\n\nthird");
      expect(latest.drain("A")).toEqual([]);
    });
    expect(latest.queued).toEqual([]);
  });

  it("abandons inactive prompts and rejects stale steer even before rerender", () => {
    const a = enqueue("A prompt");
    sessionId = "B";
    act(() => latest.steer(a.inputId));
    expect(sideStream).toHaveBeenCalledTimes(1);
    render();
    expect(latest.queued).toEqual([]);
    const b = enqueue("B prompt");
    act(() => {
      expect(latest.take(a.inputId, "B")).toBeNull();
      expect(latest.drain("A")).toEqual([]);
      expect(latest.drain("B")).toEqual([b]);
    });
    sessionId = "A";
    render();
    expect(latest.queued).toEqual([]);
    act(() => latest.steer(a.inputId));
    expect(sideStream).toHaveBeenCalledTimes(2);
    act(() => expect(latest.drain("A")).toEqual([]));
  });

  it("late acknowledgements cannot consume or paint the new session", () => {
    const a = enqueue("A prompt");
    sessionId = "B";
    render();
    const b = enqueue("B prompt");
    act(() => expect(latest.take(a.inputId, "A")).toBeNull());
    expect(latest.queued).toEqual([b]);
    sessionId = "A";
    render();
    expect(latest.queued).toEqual([]);
  });

  it("async completion captured in A cannot drain B after a switch", async () => {
    enqueue("A prompt");
    let resolve!: () => void;
    const pending = new Promise<void>((done) => { resolve = done; });
    const owner = sessionId!;
    const completed = pending.then(() => latest.drain(owner));
    sessionId = "B";
    render();
    const b = enqueue("B prompt");
    await act(async () => { resolve(); expect(await completed).toEqual([]); });
    expect(latest.queued).toEqual([b]);
    sessionId = "A";
    render();
    expect(latest.queued).toEqual([]);
  });

  it("does not restore uncertain submissions on A -> B -> A with no callbacks in B", () => {
    const a = enqueue("possibly already applied on server");
    sessionId = "B";
    render();
    sessionId = "A";
    render();
    expect(latest.queued).toEqual([]);
    act(() => {
      latest.steer(a.inputId);
      expect(latest.take(a.inputId, "A")).toBeNull();
      expect(latest.drain("A")).toEqual([]);
    });
    expect(sideStream).toHaveBeenCalledTimes(1);
  });

  it.each(["queue", "steer", "take", "drain"] as const)(
    "%s detects a switch before render and permanently abandons the old queue",
    (operation) => {
      const a = enqueue("uncertain A delivery");
      act(() => {
        sessionId = "B";
        // All calls occur before React can render the new selection.
        if (operation === "queue") expect(latest.queue("stale host text", false)).toBe(false);
        if (operation === "steer") latest.steer(a.inputId);
        if (operation === "take") expect(latest.take(a.inputId, "A")).toBeNull();
        if (operation === "drain") expect(latest.drain("A")).toEqual([]);
        sessionId = "A";
        expect(latest.take(a.inputId, "A")).toBeNull();
        expect(latest.drain("A")).toEqual([]);
      });
      expect(latest.queued).toEqual([]);
      expect(sideStream).toHaveBeenCalledTimes(1);
    },
  );

  it("clears the queue when leaving for a sessionless pane", () => {
    enqueue("A prompt");
    sessionId = null;
    render();
    sessionId = "A";
    render();
    expect(latest.queued).toEqual([]);
    act(() => expect(latest.drain("A")).toEqual([]));
  });

  it("fails closed without an owner and rejects empty input", () => {
    act(() => {
      expect(latest.queue("  ", false)).toBe(false);
      sessionId = null;
      expect(latest.queue("no session", false)).toBe(false);
      // Legacy callers must not silently drain the current session.
      expect(latest.drain(undefined as unknown as string)).toEqual([]);
    });
    expect(sideStream).not.toHaveBeenCalled();
  });
});
