import { describe, expect, it, vi } from "vitest";
import { AutomaticDesktopBrowser, chooseLocalProfile } from "../automatic-desktop-browser";
import type { DesktopBridge, DesktopBrowserControlMessage } from "../desktop-auth-source";

vi.mock("../desktop-auth-source", () => ({ desktopBridge: () => undefined }));
vi.mock("../api/computer", () => ({ pairBrowserExtension: vi.fn() }));
const profiles = ["b", "a"].map(id => ({ id, defaultBackend: "local", canManage: true }));
const token = { relayUrl: "wss://relay.test", pairingToken: "secret", browserProfileId: "a", expiresInSeconds: 600 };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function setup() {
  let status = { ok: true, controlEpoch: 0, connected: false, automaticBlocked: false, workspaceId: "w", browserProfileId: "a" };
  const control = vi.fn(async (m: DesktopBrowserControlMessage) => {
    if (m.type === "pair") {
      if (m.expectedControlEpoch !== undefined && m.expectedControlEpoch !== status.controlEpoch) return { ...status, ok: false };
      status = { ...status, connected: true, automaticBlocked: false };
    }
    if (m.type === "disconnect") status = { ...status, connected: false, workspaceId: "", browserProfileId: "" };
    return { ...status };
  });
  const mint = vi.fn(async () => token);
  const browser = new AutomaticDesktopBrowser(() => control as NonNullable<DesktopBridge["browserControl"]>, mint);
  return { browser, control, mint, status: (patch: Partial<typeof status>) => { status = { ...status, ...patch }; } };
}
describe("[COMP:app-web/automatic-desktop-browser] lifecycle", () => {
  it("selects deterministically, preserves configured active local identity, excludes remote/shared profiles", () => {
    expect(chooseLocalProfile(profiles)?.id).toBe("a");
    expect(chooseLocalProfile(profiles, "b")?.id).toBe("b");
    expect(chooseLocalProfile([{ id: "c", defaultBackend: "cloud", canManage: true }, { id: "d", defaultBackend: "local" }])).toBeUndefined();
  });
  it("deduplicates concurrent checks and StrictMode setup/cleanup, then focuses without minting", async () => {
    const { browser, control, mint } = setup();
    browser.configure("w", profiles); browser.leave(); browser.configure("w", profiles);
    void browser.check(); await flush();
    expect(mint).toHaveBeenCalledTimes(1);
    expect(control.mock.calls.filter(([m]) => m.type === "pair")).toHaveLength(1);
    expect(control).toHaveBeenCalledWith(expect.objectContaining({ type: "pair", automatic: true }));
    await browser.show(); expect(control).toHaveBeenLastCalledWith({ type: "show" });
    expect(browser.snapshot().phase).toBe("connected");
  });
  it("does not steal an active workspace or profile", async () => {
    const { browser, mint, status } = setup();
    status({ connected: true, workspaceId: "other" });
    browser.configure("w", profiles); await flush(); await browser.check();
    expect(mint).not.toHaveBeenCalled();
  });
  it("respects Stop/denial until explicit resume", async () => {
    const { browser, mint, status, control } = setup();
    status({ automaticBlocked: true });
    browser.configure("w", profiles); await flush(); await browser.check();
    expect(mint).not.toHaveBeenCalled(); expect(browser.snapshot().phase).toBe("paused");
    await browser.retry();
    expect(control).toHaveBeenCalledWith(expect.objectContaining({ type: "pair", automatic: false, expectedControlEpoch: 0 }));
  });
  it("does not loop after failure, permits explicit retry", async () => {
    const { browser, mint } = setup();
    mint.mockRejectedValueOnce(new Error("offline"));
    browser.configure("w", profiles); await flush(); await browser.check();
    expect(mint).toHaveBeenCalledTimes(1); expect(browser.snapshot().phase).toBe("failed");
    await browser.retry(); expect(mint).toHaveBeenCalledTimes(2);
  });
  it("aborts token work on workspace exit and never pairs stale credentials", async () => {
    const { browser, mint, control } = setup();
    let resolve!: (value: typeof token) => void;
    mint.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    browser.configure("w", profiles); await flush(); browser.leave(); resolve(token); await flush();
    expect(control.mock.calls.some(([m]) => m.type === "pair")).toBe(false);
  });
  it("rechecks a Stop received while minting", async () => {
    const { browser, mint, control, status } = setup();
    mint.mockImplementationOnce(async () => { status({ automaticBlocked: true }); return token; });
    browser.configure("w", profiles); await flush();
    expect(control.mock.calls.some(([m]) => m.type === "pair")).toBe(false);
    expect(browser.snapshot().phase).toBe("paused");
  });
  it.each([{ remaining: [] }, { remaining: [{ ...profiles[1], defaultBackend: "cloud" }] }])("disconnects removed/remote profiles", async ({ remaining }) => {
    const { browser, control } = setup();
    browser.configure("w", profiles); await flush();
    browser.configure("w", remaining); await flush();
    expect(control).toHaveBeenCalledWith({ type: "disconnect" });
  });
  it("does not disconnect another workspace on roster removal", async () => {
    const { browser, control, status } = setup();
    browser.configure("w", profiles); await flush();
    status({ workspaceId: "other" }); browser.configure("w", []); await flush();
    expect(control).not.toHaveBeenCalledWith({ type: "disconnect" });
  });
  it("cancels an in-flight native consent on exit without setting a pause latch", async () => {
    let resolve!: (value: { ok: boolean; controlEpoch: number }) => void;
    const control = vi.fn(async (m: DesktopBrowserControlMessage) => m.type === "pair"
      ? new Promise<{ ok: boolean; controlEpoch: number }>(r => { resolve = r; }) : { ok: true, controlEpoch: 0 });
    const browser = new AutomaticDesktopBrowser(() => control, async () => token);
    browser.configure("w", profiles); await flush(); browser.leave();
    expect(control).toHaveBeenCalledWith({ type: "cancel" });
    expect(control).not.toHaveBeenCalledWith({ type: "disconnect" });
    resolve({ ok: false, controlEpoch: 0 }); await flush();
  });
  it("never sends a stale pair when switching workspaces during HTTP", async () => {
    let resolve!: (value: typeof token) => void;
    let firstSignal: AbortSignal | undefined;
    const mint = vi.fn(async (_workspace: string, _profile?: string, signal?: AbortSignal) => {
      if (!firstSignal) {
        firstSignal = signal;
        return new Promise<typeof token>(r => { resolve = r; });
      }
      return { ...token, pairingToken: "new-workspace" };
    });
    const control = vi.fn(async (_m: DesktopBrowserControlMessage) => ({ ok: true, controlEpoch: 0 }));
    const browser = new AutomaticDesktopBrowser(() => control, mint);
    browser.configure("w", profiles); await flush();
    browser.leave(); browser.configure("next", profiles);
    expect(firstSignal?.aborted).toBe(true);
    resolve(token); await flush();
    const pairs = control.mock.calls.filter(([m]) => m.type === "pair");
    expect(pairs).toEqual([[expect.objectContaining({ pairingToken: "new-workspace" })]]);
  });

  it.each(["w", "other"])("reconciles a host that finished before the pair reply (%s workspace)", async (nativeWorkspace) => {
    const { browser, control, status, mint } = setup();
    let resolve!: (value: Awaited<ReturnType<typeof control>>) => void;
    const original = control.getMockImplementation()!;
    control.mockImplementation(async (message) => {
      if (message.type === "pair") {
        // Native has already installed the host; cancelPending is now a no-op.
        status({ connected: true, workspaceId: nativeWorkspace });
        return new Promise(r => { resolve = r; });
      }
      return original(message);
    });
    browser.configure("w", profiles); await flush();
    browser.configure("w", []); await flush();
    expect(control).toHaveBeenCalledWith({ type: "cancel" });
    resolve({ ok: true, controlEpoch: 0, connected: true, automaticBlocked: false, workspaceId: nativeWorkspace, browserProfileId: "a" });
    await flush();
    if (nativeWorkspace === "w") expect(control).toHaveBeenCalledWith({ type: "disconnect" });
    else expect(control).not.toHaveBeenCalledWith({ type: "disconnect" });
    expect(mint).toHaveBeenCalledTimes(1);
  });
  it("retains Stop when removing A, rather than automatically pairing B", async () => {
    const { browser, control, status, mint } = setup();
    browser.configure("w", profiles); await flush();
    status({ connected: false, automaticBlocked: true, controlEpoch: 1 });
    browser.configure("w", [profiles[0]]); await flush();
    expect(control).toHaveBeenCalledWith({ type: "disconnect" });
    expect(await control({ type: "status" })).toMatchObject({ workspaceId: "", browserProfileId: "", automaticBlocked: true });
    expect(browser.snapshot()).toEqual({ workspaceId: "w", profileId: "b", phase: "paused" });
    await browser.check();
    expect(mint).toHaveBeenCalledTimes(1);
  });
  it("aborts Resume when a NEW Stop arrives during token minting", async () => {
    const { browser, control, status, mint } = setup();
    status({ automaticBlocked: true, controlEpoch: 1 });
    browser.configure("w", profiles); await flush();
    let resolve!: (value: typeof token) => void;
    mint.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const retry = browser.retry(); await flush();
    status({ automaticBlocked: true, controlEpoch: 2 });
    resolve(token); await retry;
    expect(control.mock.calls.some(([m]) => m.type === "pair")).toBe(false);
    expect(browser.snapshot().phase).toBe("paused");
    await browser.check();
    expect(mint).toHaveBeenCalledTimes(1);
  });
  it("passes the pre-HTTP epoch so native rejects Stop after the final status check", async () => {
    const { browser, control, status } = setup();
    status({ automaticBlocked: true, controlEpoch: 1 });
    browser.configure("w", profiles); await flush();
    const original = control.getMockImplementation()!;
    control.mockImplementation(async (message) => {
      if (message.type === "pair") status({ automaticBlocked: true, controlEpoch: 2 });
      return original(message);
    });
    await browser.retry();
    expect(control).toHaveBeenCalledWith(expect.objectContaining({ type: "pair", automatic: false, expectedControlEpoch: 1 }));
    expect(browser.snapshot().phase).toBe("paused");
    expect(await control({ type: "status" })).toMatchObject({ connected: false, automaticBlocked: true });
  });

});
