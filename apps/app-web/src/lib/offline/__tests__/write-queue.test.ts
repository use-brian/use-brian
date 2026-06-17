/**
 * Unit tests for the offline write-queue (pure data-structure logic).
 * [COMP:app-web/offline-write-queue]
 */

import { describe, expect, it, vi } from "vitest";
import {
  enqueueWrite,
  replayQueue,
  serializeQueue,
  parseQueue,
  type QueuedWrite,
} from "../write-queue";

let seq = 0;
function op(over: Partial<QueuedWrite> = {}): QueuedWrite {
  seq += 1;
  return {
    id: `op-${seq}`,
    kind: "view.rename",
    payload: { name: `n${seq}` },
    coalesceKey: null,
    enqueuedAt: 1000 + seq,
    attempts: 0,
    ...over,
  };
}

describe("[COMP:app-web/offline-write-queue] enqueueWrite", () => {
  it("appends ops with a null coalesceKey, in order (creates, reparent)", () => {
    const a = op({ kind: "view.create", coalesceKey: null });
    const b = op({ kind: "view.reparent", coalesceKey: null });
    const q = enqueueWrite(enqueueWrite([], a), b);
    expect(q.map((o) => o.id)).toEqual([a.id, b.id]);
  });

  it("never mutates the input array", () => {
    const start: QueuedWrite[] = [];
    const after = enqueueWrite(start, op());
    expect(start).toEqual([]);
    expect(after).toHaveLength(1);
  });

  it("replaces last-write-wins ops in place, keeping the original id + position", () => {
    const create = op({ id: "c1", kind: "view.create", coalesceKey: null });
    const rename1 = op({ id: "r1", kind: "view.rename", coalesceKey: "view.rename:p1", payload: { name: "first" } });
    const rename2 = op({ id: "r2", kind: "view.rename", coalesceKey: "view.rename:p1", payload: { name: "second" } });

    let q = enqueueWrite([], create);
    q = enqueueWrite(q, rename1);
    q = enqueueWrite(q, rename2);

    expect(q).toHaveLength(2); // create + a single collapsed rename
    expect(q[0].id).toBe("c1"); // create stays first
    expect(q[1].id).toBe("r1"); // original op id preserved
    expect(q[1].payload).toEqual({ name: "second" }); // latest value wins
  });

  it("does not collapse ops of a different kind sharing a key", () => {
    const rename = op({ kind: "view.rename", coalesceKey: "p1" });
    const icon = op({ kind: "view.icon", coalesceKey: "p1" });
    const q = enqueueWrite(enqueueWrite([], rename), icon);
    expect(q).toHaveLength(2);
  });

  it("merges per-field for entity patches when a merger is supplied", () => {
    const merge = (a: unknown, b: unknown) => ({ ...(a as object), ...(b as object) });
    const k = "entity.patch:tasks:t1";
    const p1 = op({ kind: "entity.patch", coalesceKey: k, payload: { status: "open" } });
    const p2 = op({ kind: "entity.patch", coalesceKey: k, payload: { owner: "ada" } });
    const p3 = op({ kind: "entity.patch", coalesceKey: k, payload: { status: "done" } });

    let q = enqueueWrite([], p1, merge);
    q = enqueueWrite(q, p2, merge);
    q = enqueueWrite(q, p3, merge);

    expect(q).toHaveLength(1);
    // both fields survive; status takes the latest value
    expect(q[0].payload).toEqual({ status: "done", owner: "ada" });
  });

  it("resets attempts when an op is re-queued via coalescing", () => {
    const k = "view.icon:p1";
    const first = op({ kind: "view.icon", coalesceKey: k, attempts: 3 });
    const second = op({ kind: "view.icon", coalesceKey: k, payload: { icon: "🌟" } });
    const q = enqueueWrite([first], second);
    expect(q[0].attempts).toBe(0);
  });
});

describe("[COMP:app-web/offline-write-queue] replayQueue", () => {
  it("flushes the whole queue in order on success", async () => {
    const q = [op({ id: "a" }), op({ id: "b" }), op({ id: "c" })];
    const seen: string[] = [];
    const res = await replayQueue(q, async (o) => {
      seen.push(o.id);
    });
    expect(seen).toEqual(["a", "b", "c"]);
    expect(res.flushed.map((o) => o.id)).toEqual(["a", "b", "c"]);
    expect(res.remaining).toEqual([]);
    expect(res.dead).toEqual([]);
  });

  it("stops at the first failure, preserving order for the retry", async () => {
    const q = [op({ id: "a" }), op({ id: "b" }), op({ id: "c" })];
    const res = await replayQueue(q, async (o) => {
      if (o.id === "b") throw new Error("network down");
    });
    expect(res.flushed.map((o) => o.id)).toEqual(["a"]);
    expect(res.remaining.map((o) => o.id)).toEqual(["b", "c"]); // b first, attempts bumped
    expect(res.remaining[0].attempts).toBe(1);
    expect(res.dead).toEqual([]);
  });

  it("dead-letters a poison op after maxAttempts and keeps draining", async () => {
    // `b` has already failed 4 times; this 5th failure dead-letters it.
    const q = [op({ id: "a" }), op({ id: "b", attempts: 4 }), op({ id: "c" })];
    const res = await replayQueue(
      q,
      async (o) => {
        if (o.id === "b") throw new Error("always fails");
      },
      { maxAttempts: 5 },
    );
    expect(res.flushed.map((o) => o.id)).toEqual(["a", "c"]); // c still drains
    expect(res.dead.map((d) => d.op.id)).toEqual(["b"]);
    expect(res.dead[0].error).toBe("always fails");
    expect(res.remaining).toEqual([]);
  });

  it("does not call the executor again after stopping", async () => {
    const q = [op({ id: "a" }), op({ id: "b" }), op({ id: "c" })];
    const exec = vi.fn(async (o: QueuedWrite) => {
      if (o.id === "a") throw new Error("down");
    });
    await replayQueue(q, exec);
    expect(exec).toHaveBeenCalledTimes(1); // stopped at `a`
  });
});

describe("[COMP:app-web/offline-write-queue] serialize/parse", () => {
  it("round-trips a queue", () => {
    const q = [op({ id: "a", coalesceKey: "k" }), op({ id: "b" })];
    expect(parseQueue(serializeQueue(q))).toEqual(q);
  });

  it("returns [] for malformed JSON or a non-array", () => {
    expect(parseQueue("{not json")).toEqual([]);
    expect(parseQueue('{"foo":1}')).toEqual([]);
  });

  it("drops malformed entries but keeps valid ones", () => {
    const good = op({ id: "good" });
    const raw = JSON.stringify([good, { id: "bad" }, { kind: "x" }, 42, null]);
    expect(parseQueue(raw)).toEqual([good]);
  });
});
