/**
 * Pure-logic tests for `lib/doc-sse.ts`.
 *
 * Covers the SSE bridge between the chat panel and the page renderer:
 *
 *   - `applyOpsLocal` — vendored mirror of the core executor. Verified
 *     against each op variant (add / edit / delete / move / setTitle)
 *     and the failure paths the renderer relies on (throws on missing
 *     anchor / target so callers can refetch).
 *   - `parseDocOpEvent` — defensive parse of the inbound payload.
 *   - `subscribeDocOps` + `publishDocOpEvent` — the window-event
 *     bridge, scoped to a pageId. Uses `jsdom`-less `EventTarget`
 *     polyfill if not present (vitest config in app-web is no-DOM).
 *
 * [COMP:app-web/sse-bridge]
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyOpsLocal,
  parseDocOpEvent,
  publishDocOpEvent,
  subscribeDocOps,
  type DocOp,
  type DocOpEvent,
} from "../doc-sse";
import type { Page } from "../api/views";

// ── applyOpsLocal ─────────────────────────────────────────────────────

describe("[COMP:app-web/sse-bridge] applyOpsLocal", () => {
  const basePage: Page = {
    blocks: [
      { kind: "heading", id: "h1", level: 1, text: "Hello" },
      { kind: "text", id: "t1", text: "First paragraph" },
      { kind: "divider", id: "d1" },
    ],
  };

  it("adds a block after a known anchor", () => {
    const op: DocOp = {
      op: "add",
      after: "h1",
      block: { kind: "text", id: "t2", text: "Inserted" },
    };
    const { page } = applyOpsLocal(basePage, [op]);
    expect(page.blocks.map((b) => b.id)).toEqual(["h1", "t2", "t1", "d1"]);
  });

  it("adds a block at 'start' and 'end'", () => {
    const opStart: DocOp = {
      op: "add",
      after: "start",
      block: { kind: "divider", id: "d0" },
    };
    const opEnd: DocOp = {
      op: "add",
      after: "end",
      block: { kind: "divider", id: "d2" },
    };
    const { page } = applyOpsLocal(basePage, [opStart, opEnd]);
    expect(page.blocks.map((b) => b.id)).toEqual([
      "d0",
      "h1",
      "t1",
      "d1",
      "d2",
    ]);
  });

  it("edits a block (preserves id + kind)", () => {
    const op: DocOp = {
      op: "edit",
      blockId: "t1",
      patch: { text: "Updated" } as Partial<Page["blocks"][number]>,
    };
    const { page } = applyOpsLocal(basePage, [op]);
    const edited = page.blocks.find((b) => b.id === "t1");
    expect(edited).toEqual({ kind: "text", id: "t1", text: "Updated" });
  });

  it("deletes a block by id", () => {
    const op: DocOp = { op: "delete", blockId: "t1" };
    const { page } = applyOpsLocal(basePage, [op]);
    expect(page.blocks.map((b) => b.id)).toEqual(["h1", "d1"]);
  });

  it("moves a block to a new anchor", () => {
    const op: DocOp = { op: "move", blockId: "h1", after: "d1" };
    const { page } = applyOpsLocal(basePage, [op]);
    expect(page.blocks.map((b) => b.id)).toEqual(["t1", "d1", "h1"]);
  });

  it("setTitle updates the working title without touching blocks", () => {
    const op: DocOp = { op: "setTitle", title: "New title" };
    const { page, title } = applyOpsLocal(basePage, [op], "Old title");
    expect(title).toBe("New title");
    expect(page.blocks).toEqual(basePage.blocks);
  });

  it("throws when an add anchor is missing", () => {
    const op: DocOp = {
      op: "add",
      after: "missing-anchor",
      block: { kind: "divider", id: "d2" },
    };
    expect(() => applyOpsLocal(basePage, [op])).toThrow(/anchor/);
  });

  it("throws when an edit target is missing", () => {
    const op: DocOp = {
      op: "edit",
      blockId: "missing",
      patch: {} as Partial<Page["blocks"][number]>,
    };
    expect(() => applyOpsLocal(basePage, [op])).toThrow(/edit target/);
  });

  it("does not mutate the input page", () => {
    const op: DocOp = { op: "delete", blockId: "t1" };
    const snapshot = JSON.stringify(basePage);
    applyOpsLocal(basePage, [op]);
    expect(JSON.stringify(basePage)).toBe(snapshot);
  });
});

// ── parseDocOpEvent ────────────────────────────────────────────────

describe("[COMP:app-web/sse-bridge] parseDocOpEvent", () => {
  it("parses a well-formed payload", () => {
    const detail = {
      pageId: "page-1",
      op: { op: "delete", blockId: "b1" },
      opIndex: 0,
      newVersion: 2,
    };
    expect(parseDocOpEvent(detail)).toEqual(detail);
  });

  it("rejects payload with missing pageId", () => {
    expect(
      parseDocOpEvent({
        op: { op: "delete", blockId: "b1" },
        opIndex: 0,
        newVersion: 2,
      }),
    ).toBeNull();
  });

  it("rejects payload with unknown op tag", () => {
    expect(
      parseDocOpEvent({
        pageId: "page-1",
        op: { op: "rebuild" },
        opIndex: 0,
        newVersion: 2,
      }),
    ).toBeNull();
  });

  it("rejects non-object detail", () => {
    expect(parseDocOpEvent(null)).toBeNull();
    expect(parseDocOpEvent(undefined)).toBeNull();
    expect(parseDocOpEvent("string")).toBeNull();
    expect(parseDocOpEvent(42)).toBeNull();
  });

  it("rejects payload with non-finite opIndex", () => {
    expect(
      parseDocOpEvent({
        pageId: "page-1",
        op: { op: "delete", blockId: "b1" },
        opIndex: Number.NaN,
        newVersion: 2,
      }),
    ).toBeNull();
  });
});

// ── subscribeDocOps + publishDocOpEvent ────────────────────────

describe("[COMP:app-web/sse-bridge] window event bridge", () => {
  // Vitest in app-web is no-DOM, so we stand up a minimal window
  // polyfill via EventTarget so the bridge has somewhere to dispatch.
  // We cast through `unknown` because the DOM lib's `Window` type is
  // intersected with `typeof globalThis` and we don't want to replicate
  // 700+ globals just to forward addEventListener.
  let originalWindow: unknown;
  let target: EventTarget;
  const globalRef = globalThis as Record<string, unknown>;

  beforeEach(() => {
    target = new EventTarget();
    originalWindow = globalRef.window;
    const fakeWindow = {
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
      dispatchEvent: target.dispatchEvent.bind(target),
    };
    globalRef.window = fakeWindow;
  });

  afterEach(() => {
    if (originalWindow === undefined) {
      delete globalRef.window;
    } else {
      globalRef.window = originalWindow;
    }
  });

  it("delivers events to a matching pageId subscriber", () => {
    const onOp = vi.fn();
    const unsubscribe = subscribeDocOps("page-1", { onOp });

    const event: DocOpEvent = {
      pageId: "page-1",
      op: { op: "delete", blockId: "b1" },
      opIndex: 0,
      newVersion: 5,
    };
    publishDocOpEvent(event);

    expect(onOp).toHaveBeenCalledTimes(1);
    expect(onOp).toHaveBeenCalledWith(event);
    unsubscribe();
  });

  it("filters events for other pageIds", () => {
    const onOp = vi.fn();
    const unsubscribe = subscribeDocOps("page-1", { onOp });

    publishDocOpEvent({
      pageId: "page-2",
      op: { op: "delete", blockId: "b1" },
      opIndex: 0,
      newVersion: 5,
    });

    expect(onOp).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("stops delivering after unsubscribe", () => {
    const onOp = vi.fn();
    const unsubscribe = subscribeDocOps("page-1", { onOp });
    unsubscribe();

    publishDocOpEvent({
      pageId: "page-1",
      op: { op: "delete", blockId: "b1" },
      opIndex: 0,
      newVersion: 5,
    });

    expect(onOp).not.toHaveBeenCalled();
  });

  it("ignores malformed payloads", () => {
    const onOp = vi.fn();
    const unsubscribe = subscribeDocOps("page-1", { onOp });

    // Dispatch a raw CustomEvent with garbage detail.
    target.dispatchEvent(
      new CustomEvent("doc:op-applied", {
        detail: { pageId: "page-1", op: { op: "rebuild" } },
      }),
    );

    expect(onOp).not.toHaveBeenCalled();
    unsubscribe();
  });
});
