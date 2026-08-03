/**
 * [COMP:app-web/brain-content-cache] — viewer-scoped persistent Brain reads.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrainRow } from "@/lib/api/brain";

const storage = vi.hoisted(() => new Map<string, unknown>());

vi.mock("@/lib/offline/idb", () => ({
  idbGet: vi.fn(async (key: string) => storage.get(key) ?? null),
  idbSet: vi.fn(async (key: string, value: unknown) => {
    storage.set(key, value);
  }),
  idbDelete: vi.fn(async (key: string) => {
    storage.delete(key);
  }),
}));

import {
  BRAIN_ENTRIES_RESOURCE,
  brainContentCacheKey,
  deleteBrainContentCache,
  isBrainEntriesSnapshot,
  isBrainGraph,
  projectCachedBrainRows,
  readBrainContentCache,
  writeBrainContentCache,
  type BrainContentCacheScope,
} from "@/lib/offline/brain-content-cache";

const scope: BrainContentCacheScope = {
  viewerId: "user-1",
  workspaceId: "workspace-1",
  viewpointAssistantId: "assistant-1",
};

const row = (
  id: string,
  kind: BrainRow["kind"],
  name: string,
  summary?: string,
): BrainRow => ({ id, kind, name, summary, sensitivity: "internal" });

describe("[COMP:app-web/brain-content-cache] Brain content cache", () => {
  beforeEach(() => storage.clear());

  it("isolates keys by viewer, workspace, viewpoint, and resource", () => {
    const base = brainContentCacheKey(scope, "graph");
    expect(
      brainContentCacheKey({ ...scope, viewerId: "user-2" }, "graph"),
    ).not.toBe(base);
    expect(
      brainContentCacheKey({ ...scope, workspaceId: "workspace-2" }, "graph"),
    ).not.toBe(base);
    expect(
      brainContentCacheKey(
        { ...scope, viewpointAssistantId: "assistant-2" },
        "graph",
      ),
    ).not.toBe(base);
    expect(brainContentCacheKey(scope, "skills")).not.toBe(base);
  });

  it("round-trips a versioned last-known-good snapshot", async () => {
    const snapshot = {
      rows: [row("1", "memories", "Launch date")],
      nextCursor: "next",
    };
    await writeBrainContentCache(scope, BRAIN_ENTRIES_RESOURCE, snapshot);
    const read = await readBrainContentCache(
      scope,
      BRAIN_ENTRIES_RESOURCE,
      isBrainEntriesSnapshot,
    );
    expect(read?.value).toEqual(snapshot);
    expect(read?.updatedAt).toEqual(expect.any(Number));

    await deleteBrainContentCache(scope, BRAIN_ENTRIES_RESOURCE);
    expect(
      await readBrainContentCache(
        scope,
        BRAIN_ENTRIES_RESOURCE,
        isBrainEntriesSnapshot,
      ),
    ).toBeNull();
  });

  it("rejects malformed or old envelopes instead of trusting IndexedDB", async () => {
    const key = brainContentCacheKey(scope, BRAIN_ENTRIES_RESOURCE);
    storage.set(key, { version: 0, updatedAt: Date.now(), value: {} });
    expect(
      await readBrainContentCache(
        scope,
        BRAIN_ENTRIES_RESOURCE,
        isBrainEntriesSnapshot,
      ),
    ).toBeNull();

    storage.set(key, {
      version: 1,
      updatedAt: Date.now(),
      value: { rows: [{ nope: true }], nextCursor: null },
    });
    expect(
      await readBrainContentCache(
        scope,
        BRAIN_ENTRIES_RESOURCE,
        isBrainEntriesSnapshot,
      ),
    ).toBeNull();
  });

  it("rejects legacy raw graph snapshots that exceed semantic-zoom budgets", () => {
    const node = (index: number) => ({
      id: `node-${index}`,
      kind: "person" as const,
      name: `Node ${index}`,
      sensitivity: "internal" as const,
      degree: 0,
    });
    expect(
      isBrainGraph({
        nodes: Array.from({ length: 201 }, (_, index) => node(index)),
        edges: [],
        truncated: false,
      }),
    ).toBe(false);
    expect(
      isBrainGraph({
        nodes: [node(1)],
        edges: [],
        truncated: false,
        totalNodes: 1,
      }),
    ).toBe(true);
  });

  it("projects primitive filters and literal search from the one default corpus", () => {
    const rows = [
      row("p", "person", "Ada Lovelace", "Investor intro"),
      row("c", "companies", "Acme", "Enterprise customer"),
      row("m", "memories", "Roadmap", "Launch in September"),
    ];
    expect(projectCachedBrainRows(rows, ["people"], "ada").map((r) => r.id)).toEqual([
      "p",
    ]);
    expect(projectCachedBrainRows(rows, [], "enterprise").map((r) => r.id)).toEqual([
      "c",
    ]);
    expect(projectCachedBrainRows(rows, ["memories"], "launch").map((r) => r.id)).toEqual([
      "m",
    ]);
  });
});
