import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppSessionController, safeAccountReturn, type SessionAdapter, type SessionCache } from "../app-session";
const workspace = { id: "workspace-one", name: "Example workspace", role: "owner" as const, me: { id: "user-one" } };
const context = { workspaceId: workspace.id, name: workspace.name, role: "owner", clearance: "internal", me: workspace.me };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
let identity: string | null, credential: boolean, adapter: SessionAdapter, controller: AppSessionController;
let cache: SessionCache;
beforeEach(() => {
  identity = "deployment-a/user-one"; credential = true;
  cache = { identity, workspaces: [workspace], contexts: { [workspace.id]: context as never } };
  adapter = { identity: () => identity, subject: () => "user-one", hasCredential: () => credential,
    session: vi.fn().mockResolvedValue({ status: 200, data: { workspaces: [workspace] } }),
    workspace: vi.fn().mockResolvedValue({ status: 200, data: workspace }),
    read: vi.fn(async () => cache), write: vi.fn(async () => {}),
  };
  controller = new AppSessionController(adapter);
});
describe("[COMP:app-web/app-session] session and workspace admission", () => {
  it("joins concurrent probes and withholds workspace authority until the live response settles", async () => {
    const probe = deferred<{ status: number; data: unknown }>(); adapter.session = vi.fn(() => probe.promise);
    const one = controller.check(), two = controller.check();
    expect(one).toBe(two); expect(adapter.session).toHaveBeenCalledOnce();
    expect(controller.snapshot().session).toBe("checking");
    probe.resolve({ status: 200, data: { workspaces: [workspace] } }); await one;
    const admission = deferred<{ status: number; data: unknown }>(); adapter.workspace = vi.fn(() => admission.promise);
    const allowed = controller.admit(workspace.id); expect(controller.snapshot().admissions[workspace.id].kind).toBe("checking");
    expect(controller.admit(workspace.id)).toBe(allowed);
    admission.resolve({ status: 200, data: workspace }); await allowed;
    expect(controller.snapshot().admissions[workspace.id]).toMatchObject({ kind: "allowed", value: { workspaceId: workspace.id } });
  });
  it("never treats saved rows as authentication without a credential", async () => {
    identity = null; credential = false; adapter.session = vi.fn().mockResolvedValue({ status: 401 });
    await controller.check(); expect(controller.snapshot().session).toBe("signed-out"); expect(adapter.read).not.toHaveBeenCalled();
  });
  it("keeps the original identity for reconnect when refresh clears the credential", async () => {
    adapter.session = vi.fn(async () => { identity = null; credential = false; return { status: 401 }; });
    await controller.check(); expect(controller.snapshot()).toMatchObject({ session: "reauthenticate", identity: cache.identity, workspaces: [] });
  });
  it.each([403, 404, 429, 500, 503])("never falls back to workspace cache for live HTTP %s", async status => {
    await controller.check(); adapter.workspace = vi.fn().mockResolvedValue({ status });
    await controller.admit(workspace.id);
    expect(controller.snapshot().admissions[workspace.id].kind).toBe(status === 403 ? "forbidden" : status === 404 ? "missing" : "unavailable");
    expect(controller.snapshot().session).toBe("authenticated");
  });
  it("supports only an identity-matching verified cache during transport failure", async () => {
    adapter.session = vi.fn().mockRejectedValue(new TypeError("network"));
    adapter.workspace = vi.fn().mockRejectedValue(new TypeError("network"));
    await controller.check(); await controller.admit(workspace.id);
    expect(controller.snapshot()).toMatchObject({ session: "authenticated", connection: "offline", admissions: { [workspace.id]: { kind: "allowed" } } });
  });
  it.each(["another-deployment/user-one", "deployment-a/user-two"])("rejects cached authority from %s", async other => {
    cache.identity = other; adapter.session = vi.fn().mockRejectedValue(new TypeError("network"));
    await controller.check(); expect(controller.snapshot().session).not.toBe("authenticated");
  });
  it("does not use cache after a live session rejection", async () => {
    await controller.check(); await controller.admit(workspace.id);
    adapter.session = vi.fn().mockResolvedValue({ status: 401 }); await controller.check();
    adapter.session = vi.fn().mockRejectedValue(new TypeError("network")); await controller.check();
    expect(controller.snapshot().session).not.toBe("authenticated"); expect(controller.snapshot().admissions).toEqual({});
  });
  it("invalidates every protected admission immediately on logout and ignores late responses", async () => {
    await controller.check(); const pending = deferred<{ status: number; data: unknown }>(); adapter.workspace = vi.fn(() => pending.promise);
    const admission = controller.admit(workspace.id); controller.invalidate(true);
    expect(controller.snapshot()).toMatchObject({ session: "signed-out", admissions: {}, workspaces: [] });
    pending.resolve({ status: 200, data: workspace }); await admission;
    expect(controller.snapshot().session).toBe("signed-out");
  });
  it("ignores a rejection from an obsolete identity", async () => {
    await controller.check(); controller.invalidate(false, "another-deployment/user-one");
    expect(controller.snapshot().session).toBe("authenticated");
  });
  it("discards successful probes from a deployment/account that changed mid-request", async () => {
    const pending = deferred<{ status: number; data: unknown }>(); adapter.session = vi.fn(() => pending.promise);
    const checking = controller.check(); identity = "deployment-b/user-two";
    pending.resolve({ status: 200, data: { workspaces: [workspace] } }); await checking;
    expect(controller.snapshot().session).not.toBe("authenticated"); expect(adapter.write).not.toHaveBeenCalled();
  });
  it("closes the old session immediately when credentials change during an earlier probe", async () => {
    await controller.check(); await controller.admit(workspace.id);
    const old = deferred<{ status: number; data: unknown }>(); adapter.session = vi.fn(() => old.promise);
    const first = controller.check(); identity = "deployment-b/user-two";
    const next = deferred<{ status: number; data: unknown }>(); adapter.session = vi.fn(() => next.promise);
    const second = controller.check(); expect(controller.snapshot()).toMatchObject({ session: "checking", admissions: {}, workspaces: [] });
    old.resolve({ status: 200, data: { workspaces: [workspace] } }); await first;
    expect(controller.snapshot().session).toBe("checking");
    next.resolve({ status: 200, data: { workspaces: [] } }); await second;
    expect(controller.snapshot()).toMatchObject({ identity: "deployment-b/user-two", workspaces: [], admissions: {} });
  });
  it("does not flash a checking screen during a healthy foreground permission recheck", async () => {
    await controller.check(); await controller.admit(workspace.id);
    const pending = deferred<{ status: number; data: unknown }>(); adapter.workspace = vi.fn(() => pending.promise);
    const checking = controller.admit(workspace.id, true); expect(controller.snapshot().admissions[workspace.id].kind).toBe("allowed");
    pending.resolve({ status: 403, data: null }); await checking;
    expect(controller.snapshot().admissions[workspace.id].kind).toBe("forbidden");
  });
  it("rejects a workspace response or offline context belonging to another actor", async () => {
    await controller.check(); adapter.workspace = vi.fn().mockResolvedValue({ status: 200, data: { ...workspace, me: { id: "other-user" } } });
    await controller.admit(workspace.id); expect(controller.snapshot().admissions[workspace.id].kind).toBe("unavailable");
    const fresh = new AppSessionController(adapter); cache.contexts[workspace.id] = { ...context, me: { id: "other-user" } } as never;
    adapter.session = vi.fn().mockRejectedValue(new TypeError("network")); await fresh.check();
    expect(fresh.snapshot().workspaces).toEqual([]); expect(fresh.snapshot().session).not.toBe("authenticated");
  });
  it("rejects malformed success responses instead of inventing an admitted workspace", async () => {
    await controller.check(); adapter.workspace = vi.fn().mockResolvedValue({ status: 200, data: { name: "Wrong workspace" } });
    await controller.admit(workspace.id); expect(controller.snapshot().admissions[workspace.id].kind).toBe("unavailable");
  });
});
describe("[COMP:app-web/app-session] account return destinations", () => {
  it.each(["//evil.example/path", "/\\evil.example", "/\nevil", "https://evil.example", "/accounts?next=/w/one", "/login"])("rejects %j", path => {
    expect(safeAccountReturn(path, "https://app.example.com")).toBe("/");
  });
  it("preserves the requested resource/query/fragment after normalized origin validation", () => {
    expect(safeAccountReturn("/w/one/chat?thread=two#reply", "https://app.example.com")).toBe("/w/one/chat?thread=two#reply");
  });
});
