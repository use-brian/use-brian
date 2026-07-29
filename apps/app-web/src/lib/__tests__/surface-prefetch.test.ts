/**
 * [COMP:app-web/surface-prefetch] — the pure half of intent prefetch: the cache
 * keys, and the workspace id parsed out of a link's href.
 *
 * These matter because the KEY IS THE CONTRACT. A hover warms
 * `surfaceDataKey('tasks', wid)` and the Tasks surface mounts reading the same
 * call. If the two ever produce different strings the prefetch still "works" —
 * it just fills a slot nobody reads, and every navigation silently pays full
 * price again while looking like it was optimised.
 */

import { describe, expect, it } from "vitest";
import {
  docPageCacheKey,
  surfaceDataKey,
  workspaceIdFromPath,
} from "@/lib/surface-prefetch";

describe("[COMP:app-web/surface-prefetch] Surface prefetch keys", () => {
  it("keys the warmable surfaces per workspace", () => {
    expect(surfaceDataKey("tasks", "w1")).toBe("tasks:w1");
    expect(surfaceDataKey("crm", "w1")).toBe("crm:w1");
    expect(surfaceDataKey("workflow", "w1")).toBe("workflow:w1");
  });

  it("scopes keys by workspace so two workspaces never share a list", () => {
    expect(surfaceDataKey("tasks", "w1")).not.toBe(surfaceDataKey("tasks", "w2"));
  });

  it("returns null for surfaces with no single landing list", () => {
    // Brain's graph, Studio's per-section fetches and the doc surface's
    // per-page metadata are deliberately not keyed here — a half-right key
    // would mask a miss rather than warm anything.
    expect(surfaceDataKey("brain", "w1")).toBeNull();
    expect(surfaceDataKey("studio", "w1")).toBeNull();
    expect(surfaceDataKey("p", "w1")).toBeNull();
    expect(surfaceDataKey(null, "w1")).toBeNull();
  });

  it("returns null without a workspace id", () => {
    expect(surfaceDataKey("tasks", null)).toBeNull();
    expect(surfaceDataKey("tasks", undefined)).toBeNull();
    expect(surfaceDataKey("tasks", "")).toBeNull();
  });

  it("keys doc pages per page, not per surface", () => {
    expect(docPageCacheKey("abc")).toBe("page:abc");
    expect(docPageCacheKey("abc")).not.toBe(docPageCacheKey("def"));
  });

  it("parses the workspace id out of an in-app href", () => {
    expect(workspaceIdFromPath("/w/w1/tasks")).toBe("w1");
    expect(workspaceIdFromPath("/w/w1/p/page-id")).toBe("w1");
    expect(workspaceIdFromPath("/w/w1")).toBe("w1");
    expect(workspaceIdFromPath("/w/w1?x=1")).toBe("w1");
  });

  it("returns null for hrefs outside a workspace", () => {
    expect(workspaceIdFromPath("/teams")).toBeNull();
    expect(workspaceIdFromPath("/login")).toBeNull();
    expect(workspaceIdFromPath("")).toBeNull();
  });
});
