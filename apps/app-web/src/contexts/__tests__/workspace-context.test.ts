import { describe, it, expect, beforeEach } from "vitest";
import {
  setWorkspaces,
  updateWorkspace,
  getCachedWorkspaces,
  getActiveWorkspaceId,
  setActiveWorkspaceId,
  __resetWorkspaceCacheForTest,
  type Workspace,
} from "../workspace-context";

/**
 * Pure cache-logic tests for the app-web `useWorkspaces()` adapter (the
 * consolidation foundation). The hook itself (route-derived `activeId` +
 * `setActive` navigation) needs a React renderer and is covered by surface
 * QA; here we test the framework-free list cache + the route-id mirror.
 *
 * Spec: docs/architecture/features/doc.md §5a.
 */
describe("[COMP:app-web/workspaces-adapter] useWorkspaces adapter cache", () => {
  beforeEach(() => {
    __resetWorkspaceCacheForTest();
  });

  const ws = (id: string, name: string): Workspace => ({ id, name });

  it("setWorkspaces replaces the cached list", () => {
    setWorkspaces([ws("a", "Acme"), ws("b", "Beta")]);
    expect(getCachedWorkspaces().map((w) => w.id)).toEqual(["a", "b"]);
  });

  it("setWorkspaces ignores a non-array argument", () => {
    setWorkspaces([ws("a", "Acme")]);
    // @ts-expect-error — exercising the runtime guard for bad API payloads
    setWorkspaces(null);
    expect(getCachedWorkspaces().map((w) => w.id)).toEqual(["a"]);
  });

  it("updateWorkspace patches a matching workspace in place", () => {
    setWorkspaces([ws("a", "Acme"), ws("b", "Beta")]);
    updateWorkspace("b", { name: "Beta Renamed", iconSeed: 7 });
    const b = getCachedWorkspaces().find((w) => w.id === "b");
    expect(b).toMatchObject({ id: "b", name: "Beta Renamed", iconSeed: 7 });
  });

  it("updateWorkspace is a no-op for an unknown id", () => {
    setWorkspaces([ws("a", "Acme")]);
    const before = getCachedWorkspaces();
    updateWorkspace("zzz", { name: "Nope" });
    // Unknown id leaves the list reference untouched (no emit, no remap).
    expect(getCachedWorkspaces()).toBe(before);
  });

  it("active id is route-derived: imperative setter is a no-op, read starts null", () => {
    expect(getActiveWorkspaceId()).toBeNull();
    setActiveWorkspaceId("a");
    // In app-web the route is the source of truth; the imperative setter
    // does not flip the active id (the hook mirrors the route instead).
    expect(getActiveWorkspaceId()).toBeNull();
  });
});
