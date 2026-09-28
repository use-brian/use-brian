// @vitest-environment jsdom
import { StrictMode, act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { DesktopBrowserControlMessage } from "@/lib/desktop-auth-source";

const api = vi.hoisted(() => ({ listBrowserProfiles: vi.fn(), pairBrowserExtension: vi.fn() }));
vi.mock("@/lib/api/computer", () => api);
import { DesktopBrowserCoordinator } from "../desktop-browser-coordinator";
import { loadSurfaceCache, markSurfaceCacheStale, resetSurfaceCache } from "@/lib/surface-cache";
import { browserProfilesCacheKey } from "@/lib/surface-prefetch";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

it("[COMP:app-web/automatic-desktop-browser] reacts to shared setup/removal invalidation outside profiles with one StrictMode owner", async () => {
  resetSurfaceCache();
  const key = browserProfilesCacheKey("coordinator-workspace");
  const roster = (profiles: unknown[]) => ({ configured: true, credentialAuthConfigured: false, profiles });
  await loadSurfaceCache(key, async () => roster([]));
  let connected = false;
  const control = vi.fn(async (message: DesktopBrowserControlMessage) => {
    if (message.type === "pair") connected = true;
    if (message.type === "disconnect") connected = false;
    return { ok: true, controlEpoch: 0, connected, workspaceId: connected ? "coordinator-workspace" : "", browserProfileId: connected ? "p" : "" };
  });
  window.usebrianDesktop = { browserControl: control, signIn: vi.fn() };
  api.pairBrowserExtension.mockResolvedValue({ relayUrl: "wss://relay.test", pairingToken: "token" });
  const el = document.createElement("div");
  const root = createRoot(el);
  try {
    await act(async () => { root.render(<StrictMode><DesktopBrowserCoordinator workspaceId="coordinator-workspace" /></StrictMode>); await settle(); });
    expect(api.listBrowserProfiles).not.toHaveBeenCalled();
    expect(api.pairBrowserExtension).not.toHaveBeenCalled();
    expect(el.innerHTML).toBe("");
    api.listBrowserProfiles.mockResolvedValue(roster([{ id: "p", defaultBackend: "local", canManage: true }]));
    await act(async () => { markSurfaceCacheStale(key); await settle(); });
    await act(settle);
    expect(api.listBrowserProfiles).toHaveBeenCalledOnce();
    expect(api.pairBrowserExtension).toHaveBeenCalledOnce();
    expect(control).toHaveBeenCalledWith(expect.objectContaining({ type: "pair", automatic: true }));
    api.listBrowserProfiles.mockResolvedValue(roster([{ id: "p", defaultBackend: "cloud", canManage: true }]));
    await act(async () => { markSurfaceCacheStale(key); await settle(); });
    await act(settle);
    expect(control).toHaveBeenCalledWith({ type: "disconnect" });
    expect(api.pairBrowserExtension).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    delete window.usebrianDesktop;
    resetSurfaceCache();
  }
});
