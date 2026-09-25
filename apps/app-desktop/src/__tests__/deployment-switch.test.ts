import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { DeploymentAccounts, deploymentAccountKey, deploymentKey, type AccountTarget } from "../deployment-accounts.js";
import { serializePersistedTarget } from "../target-store.js";
import type { StoredTokens } from "../desktop-token-store.js";

const state = vi.hoisted(() => ({ files: new Map<string, Buffer>(), handlers: new Map<string, Function>(), windows: [] as any[], app: null as any, partitions: new Map<string, any>(), makeSession: null as null | (() => any), refresh: vi.fn(), request: vi.fn() }));
vi.mock("electron-updater", () => ({ default: { autoUpdater: {} } }));
vi.mock("../desktop-auth.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../desktop-auth.js")>(), refreshSession: state.refresh }));
vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  readFileSync: (path: string, encoding?: string) => {
    const value = state.files.get(String(path));
    if (!value) throw new Error("ENOENT");
    return encoding ? value.toString() : value;
  },
  writeFileSync: (path: string, data: string | Buffer) => state.files.set(String(path), Buffer.from(data)),
  renameSync: (from: string, to: string) => { state.files.set(to, state.files.get(from)!); state.files.delete(from); },
  rmSync: (path: string) => state.files.delete(String(path)),
  existsSync: (path: string) => String(path).endsWith("renderer/index.html") || state.files.has(String(path)),
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  const app = Object.assign(new EventEmitter(), { name: "Use Brian", isPackaged: true,
    getPath: () => "/tmp/desktop-switch-test", requestSingleInstanceLock: () => true,
    whenReady: () => new Promise(() => {}), focus: vi.fn(), quit: vi.fn(), relaunch: vi.fn(), exit: vi.fn() });
  state.app = app;
  const makeSession = () => {
    const values = new Map<string, any>();
    const key = (cookie: any) => JSON.stringify([cookie.name, cookie.domain, cookie.path]);
    const cookies = Object.assign(new EventEmitter(), {
      get: vi.fn(async ({ name }: any = {}) => [...values.values()].filter((cookie) => !name || cookie.name === name)),
      set: vi.fn(async (input: any) => {
        const cookie = { hostOnly: !input.domain, path: "/", domain: new URL(input.url).hostname,
          session: input.expirationDate === undefined, ...input };
        values.set(key(cookie), cookie); cookies.emit("changed", {}, cookie, "explicit", false);
      }),
      remove: vi.fn(async (_url: string, name: string) => {
        for (const [cookieKey, cookie] of values) if (cookie.name === name) {
          values.delete(cookieKey); cookies.emit("changed", {}, cookie, "explicit", true);
        }
      }),
    });
    return Object.assign(new EventEmitter(), {
      setPermissionRequestHandler: vi.fn(), setDisplayMediaRequestHandler: vi.fn(),
      webRequest: { onHeadersReceived: vi.fn(), onBeforeSendHeaders: vi.fn(), onBeforeRedirect: vi.fn(), onCompleted: vi.fn() },
      cookies, fetch: vi.fn(async (input: string) => new Response(JSON.stringify(input.endsWith("/health")
        ? { status: "ok" } : { apiUrl: "http://localhost:4000", edition: "oss" }), { status: 200 })),
    });
  };
  state.makeSession = makeSession;
  class Window extends EventEmitter {
    destroyed = false; preventClose = false; options: any; bounds = { x: 30, y: 40, width: 1000, height: 700 }; webContents: any;
    constructor(options: any) {
      super(); this.options = options;
      let url = "";
      this.webContents = Object.assign(new EventEmitter(), {
        id: state.windows.length + 1, isDestroyed: () => this.destroyed,
        mainFrame: {}, getURL: () => url, loadFile: vi.fn(async (path: string) => { url = `file://${path}`; }),
        loadURL: vi.fn(async (value: string) => { url = value; }), setWindowOpenHandler: vi.fn(), focus: vi.fn(), send: vi.fn(),
      });
      state.windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    getBounds() { return this.bounds; }
    setBounds(value: any) { this.bounds = value; }
    show() {} focus() {} setTitle() {} setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {}
    close() { if (this.preventClose) this.webContents.emit("will-prevent-unload", {}); else { this.destroyed = true; this.emit("closed"); } }
  }
  return { app, BrowserWindow: Window, ipcMain: { on: (name: string, fn: Function) => state.handlers.set(name, fn), handle: (name: string, fn: Function) => state.handlers.set(name, fn) },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
    session: { defaultSession: makeSession(), fromPartition: (key: string) => { if (!state.partitions.has(key)) state.partitions.set(key, makeSession()); return state.partitions.get(key); } },
    Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: vi.fn() },
    dialog: { showErrorBox: vi.fn() }, net: { fetch: vi.fn(), request: state.request, isOnline: () => true },
    powerMonitor: new EventEmitter(), powerSaveBlocker: {}, globalShortcut: {}, shell: {},
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }) },
    systemPreferences: {}, Tray: class {}, Notification: class {}, nativeImage: {}, desktopCapturer: {},
  };
});
const local: AccountTarget = { kind: "local", appUrl: "http://localhost:3003", apiUrl: "http://localhost:4000", auth: "pkce" };
const cloud: AccountTarget = { kind: "cloud", appUrl: "https://app.usebrian.ai", apiUrl: "https://api.usebrian.ai", auth: "pkce" };
const tokens = (name: string): StoredTokens => ({ accessToken: `${name}-access`, refreshToken: `${name}-refresh`, accessTokenExpiresAt: Date.now() + 3600_000, user: { id: "same-user", name, email: "person@example.com" } });
function targetJar(target: AccountTarget) {
  const hash = createHash("sha256").update(deploymentKey(target)).digest("hex");
  const partition = `persist:deployment-${hash}`;
  if (!state.partitions.has(partition)) state.partitions.set(partition, state.makeSession!());
  return state.partitions.get(partition);
}
let store: DeploymentAccounts;
async function setup(auth: AccountTarget["auth"] = "pkce", bundled = true) {
  state.app?.removeAllListeners();
  vi.resetModules(); state.files.clear(); state.handlers.clear(); state.windows.length = 0; state.partitions.clear();
  vi.stubEnv("USEBRIAN_APP_URL", ""); vi.stubEnv("USEBRIAN_API_URL", ""); vi.stubEnv("USEBRIAN_BUNDLED", String(bundled));
  state.files.set("/tmp/desktop-switch-test/target.json", Buffer.from(serializePersistedTarget("local", local.appUrl, local.apiUrl, auth)));
  store = new DeploymentAccounts({ isAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() },
    () => state.files.get("/tmp/desktop-switch-test/deployment-accounts.bin")!,
    (blob) => { state.files.set("/tmp/desktop-switch-test/deployment-accounts.bin", blob); });
  store.put({ ...local, auth }, tokens("local")); store.put(cloud, tokens("cloud"));
  state.request.mockReset();
  state.refresh.mockReset().mockResolvedValue({ accessToken: "cloud-new", refreshToken: "cloud-rotated", accessTokenExpiresIn: 3600 });
  await import("../main.js");
  state.app.emit("second-instance", {}, []);
  await new Promise((resolve) => setTimeout(resolve, 0));
}
beforeEach(() => setup());
afterEach(() => { vi.unstubAllEnvs(); });
const sender = () => ({ sender: state.windows.at(-1).webContents, senderFrame: state.windows.at(-1).webContents.mainFrame });

describe("[COMP:app-desktop/main] deployment switching", () => {
  it("keeps the recorder overlay in the active deployment session", () => {
    const main = state.windows[0];
    state.handlers.get("Use Brian:recording-state")!({}, true);
    const overlay = state.windows[1];

    expect(overlay.options.webPreferences.session).toBe(main.options.webPreferences.session);
    expect(overlay.webContents.loadURL).toHaveBeenCalledWith(`${local.appUrl}/recorder-overlay`);
  });

  it("switches local to cloud and back without restarting, preserving sessions and isolated caches", async () => {
    const first = state.windows[0];
    const key = deploymentAccountKey({ target: cloud, tokens: tokens("cloud") });
    const result = await state.handlers.get("Use Brian:select-account")!(sender(), key);
    expect(result).toEqual({ ok: true });
    expect(state.refresh).toHaveBeenCalledWith(cloud.apiUrl, "cloud-refresh", undefined);
    expect(first.destroyed).toBe(true);
    expect(state.windows).toHaveLength(2);
    expect(state.windows[1].bounds).toEqual(first.bounds);
    expect(state.windows[1].options.webPreferences.session).not.toBe(first.options.webPreferences.session);
    expect(state.app.relaunch).not.toHaveBeenCalled();
    expect(state.app.exit).not.toHaveBeenCalled();
    expect(store.current(local)?.refreshToken).toBe("local-refresh");
    expect(store.current(cloud)?.refreshToken).toBe("cloud-rotated");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const active = { ...sender(), returnValue: undefined as unknown };
    state.handlers.get("Use Brian:get-tokens")!(active);
    expect(active.returnValue).toMatchObject({ accessToken: "cloud-new" });
    expect(state.windows[1].webContents.loadFile).toHaveBeenCalledWith(
      expect.any(String), expect.objectContaining({ query: expect.objectContaining({ app: cloud.appUrl }) }),
    );
    const stale = { sender: first.webContents, returnValue: undefined as unknown };
    state.handlers.get("Use Brian:get-tokens")!(stale);
    expect(stale.returnValue).toBeNull();
    state.handlers.get("Use Brian:set-tokens")!(stale, { accessToken: "wrong", refreshToken: "wrong" });
    expect(store.current(cloud)?.refreshToken).toBe("cloud-rotated");
    state.refresh.mockResolvedValue({ accessToken: "local-new", refreshToken: "local-rotated", accessTokenExpiresIn: 3600 });
    expect(await state.handlers.get("Use Brian:select-account")!(sender(), deploymentAccountKey({ target: local, tokens: tokens("local") }))).toEqual({ ok: true });
    expect(state.windows[2].options.webPreferences.session).toBe(first.options.webPreferences.session);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.windows[2].webContents.loadFile).toHaveBeenCalledWith(
      expect.any(String), expect.objectContaining({ query: expect.objectContaining({ app: local.appUrl }) }),
    );
  });
  it("keeps the active account and window if the selected server is offline", async () => {
    state.refresh.mockRejectedValue(new Error("offline"));
    expect(await state.handlers.get("Use Brian:select-account")!(sender(), deploymentAccountKey({ target: cloud, tokens: tokens("cloud") }))).toEqual({ ok: false, error: "switch" });
    expect(state.windows).toHaveLength(1);
    expect(state.windows[0].destroyed).toBe(false);
    expect(store.current(local)?.refreshToken).toBe("local-refresh");
  });
  it("honors an unsaved-work close veto without changing the selected target", async () => {
    state.windows[0].preventClose = true;
    expect(await state.handlers.get("Use Brian:select-cloud")!(sender())).toEqual({ ok: false });
    expect(state.windows[0].destroyed).toBe(false);
    expect(JSON.parse(state.files.get("/tmp/desktop-switch-test/target.json")!.toString()).kind).toBe("local");
  });
  it("removes one inactive connection and prunes the identity from its target cookie partition", async () => {
    const stale: AccountTarget = { kind: "local", appUrl: "https://brain.example.com", apiUrl: "https://brain.example.com", auth: "local-session" };
    const staleTokens = { ...tokens("stale"), user: { id: "stale-user", name: "Stale", email: "stale@example.com" } };
    store.put(stale, staleTokens);
    const jar = targetJar(stale);
    for (const [name, value] of Object.entries({
      access_token: "stale-access",
      refresh_token: "stale-refresh",
      user: JSON.stringify(staleTokens.user),
      accounts_store: JSON.stringify({ "stale-user": "stale-refresh" }),
      accounts_dir: JSON.stringify([staleTokens.user]),
    })) await jar.cookies.set({ url: stale.appUrl, name, value });

    const key = deploymentAccountKey({ target: stale, tokens: staleTokens });
    expect(await state.handlers.get("Use Brian:remove-account")!(sender(), key)).toEqual({ ok: true });
    expect(store.find(key)).toBeNull();
    expect(store.current(local)?.refreshToken).toBe("local-refresh");
    const cookies = await jar.cookies.get({ url: stale.appUrl });
    expect(cookies.filter((cookie: any) => ["access_token", "refresh_token", "user"].includes(cookie.name))).toHaveLength(0);
    expect(JSON.parse(cookies.find((cookie: any) => cookie.name === "accounts_store").value)).toEqual({});
    expect(JSON.parse(cookies.find((cookie: any) => cookie.name === "accounts_dir").value)).toEqual([]);
  });
  it("refuses to remove the active connection", async () => {
    const key = deploymentAccountKey({ target: local, tokens: tokens("local") });
    expect(await state.handlers.get("Use Brian:remove-account")!(sender(), key)).toEqual({ ok: false, error: "active" });
    expect(store.find(key)).not.toBeNull();
  });
  it("rejects account removal from an untrusted renderer", async () => {
    const key = deploymentAccountKey({ target: cloud, tokens: tokens("cloud") });
    const untrusted = { sender: { id: 999 }, senderFrame: {} };
    expect(await state.handlers.get("Use Brian:remove-account")!(untrusted, key)).toEqual({ ok: false, error: "remove" });
    expect(store.find(key)).not.toBeNull();
  });
});


function sessionJwt(seconds: number, suffix: string) {
  return `e30.${Buffer.from(JSON.stringify({ sub: "same-user", exp: Math.floor(Date.now() / 1000) + seconds })).toString("base64url")}.${suffix}`;
}
const ownerTarget = { ...local, auth: "local-session" as const };

/** Model actual Chromium behavior: cookie events precede response/redirect. */
async function mockAppBridge(options: { status?: number; error?: string; pause?: Promise<void>; omitCookies?: boolean; location?: string } = {}) {
  const { EventEmitter } = await import("node:events");
  const pair = { accessToken: sessionJwt(3600, "fresh-access"), refreshToken: sessionJwt(2592000, "fresh-refresh") };
  state.request.mockImplementation((requestOptions: any) => {
    const request = Object.assign(new EventEmitter(), { setHeader: vi.fn(), write: vi.fn(), abort: vi.fn(), end: () => {
      void (async () => {
        await options.pause;
        const status = options.status ?? 200;
        if ((status === 200 || status === 307) && !options.omitCookies) {
          for (const [name, value] of Object.entries({ access_token: pair.accessToken, refresh_token: pair.refreshToken,
            user: encodeURIComponent(JSON.stringify({ id: "same-user", name: "You", email: "owner@local" })) })) {
            await requestOptions.session.cookies.set({ url: ownerTarget.appUrl, name, value });
          }
        }
        if (options.location) {
          request.emit("redirect", status, "GET", options.location, {});
          request.emit("error", new Error("Redirect was cancelled"));
          return;
        }
        const response = Object.assign(new EventEmitter(), { statusCode: status, headers: { "content-type": "application/json" } });
        request.emit("response", response);
        response.emit("data", Buffer.from(JSON.stringify(options.error ? { error: options.error } : { accessToken: pair.accessToken })));
        response.emit("end");
      })();
    }});
    return request;
  });
  return pair;
}

describe("[COMP:app-desktop/main] bundled owner session refresh", () => {
  beforeEach(() => setup("local-session"));
  const refresh = () => state.handlers.get("Use Brian:refresh-tokens")!(sender());

  it("refreshes through app-web, persists first, and shares one request between renderers", async () => {
    let release!: () => void;
    const pair = await mockAppBridge({ pause: new Promise<void>((resolve) => { release = resolve; }) });
    const first = refresh(); const second = refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.request).toHaveBeenCalledTimes(1);
    expect(state.request.mock.calls[0][0]).toMatchObject({ url: `${ownerTarget.appUrl}/api/auth/refresh`, redirect: "manual", useSessionCookies: true });
    release();
    expect(await first).toMatchObject({ kind: "ok", tokens: pair });
    expect(await second).toMatchObject({ kind: "ok", tokens: pair });
    expect(store.current(ownerTarget)?.refreshToken).toBe(pair.refreshToken);
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it("rejects untrusted frames without exposing or rotating tokens", async () => {
    await mockAppBridge();
    expect(await state.handlers.get("Use Brian:refresh-tokens")!({ ...sender(), senderFrame: {} })).toEqual({ kind: "transient" });
    expect(state.request).not.toHaveBeenCalled();
  });

  it.each([
    { status: 403, error: "access_denied" },
    { status: 401, error: "gateway_expired" },
    { status: 503, error: "unavailable" },
    { omitCookies: true },
    { status: 307, location: "https://gateway.example.com/login" },
  ])("preserves durable credentials and original cookies on gateway or malformed replies", async (options) => {
    const jar = state.windows.at(-1).options.webPreferences.session;
    await jar.cookies.set({ url: ownerTarget.appUrl, name: "refresh_token", value: "existing-cookie" });
    await mockAppBridge(options);
    expect(await refresh()).toEqual({ kind: "transient" });
    expect(store.current(ownerTarget)?.refreshToken).toBe("local-refresh");
    expect((await jar.cookies.get({ name: "refresh_token" }))[0].value).toBe("existing-cookie");
  });

  it("clears only a definitively rejected owner session", async () => {
    await mockAppBridge({ status: 401, error: "refresh_rejected" });
    expect(await refresh()).toEqual({ kind: "unauthenticated" });
    expect(store.current(ownerTarget)).toBeNull();
    expect(store.current(cloud)?.refreshToken).toBe("cloud-refresh");
  });

  it("does not revive a signed-out credential even while its renderer remains trusted", async () => {
    let release!: () => void;
    await mockAppBridge({ pause: new Promise<void>((resolve) => { release = resolve; }) });
    const operation = refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    state.handlers.get("Use Brian:clear-tokens")!(sender());
    release();
    expect(await operation).toEqual({ kind: "transient" });
    expect(store.current(ownerTarget)).toBeNull();
  });

  it("drains an owner refresh before switching and keeps it scoped to the old deployment", async () => {
    let release!: () => void;
    const pair = await mockAppBridge({ pause: new Promise<void>((resolve) => { release = resolve; }) });
    const operation = refresh();
    const switching = state.handlers.get("Use Brian:select-account")!(sender(), deploymentAccountKey({ target: cloud, tokens: tokens("cloud") }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.windows).toHaveLength(1);
    release();
    expect(await operation).toMatchObject({ kind: "ok" });
    expect(await switching).toEqual({ ok: true });
    expect(store.current(ownerTarget)?.refreshToken).toBe(pair.refreshToken);
    expect(store.current(cloud)?.refreshToken).toBe("cloud-rotated");
  });
  it("withholds a refreshed token from a renderer that navigated away during the request", async () => {
    let release!: () => void;
    await mockAppBridge({ pause: new Promise<void>((resolve) => { release = resolve; }) });
    const operation = refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await state.windows.at(-1).webContents.loadURL("https://untrusted.example.com/");
    release();
    expect(await operation).toEqual({ kind: "transient" });
    expect(store.current(ownerTarget)?.refreshToken).toBe("local-refresh");
  });

  it("restores the destination cookie jar when a refreshed saved-account switch is cancelled", async () => {
    const ownerJar = state.windows.at(-1).options.webPreferences.session;
    await ownerJar.cookies.set({ url: ownerTarget.appUrl, name: "refresh_token", value: "owner-cookie-before-preflight" });
    expect(await state.handlers.get("Use Brian:select-account")!(sender(), deploymentAccountKey({ target: cloud, tokens: tokens("cloud") }))).toEqual({ ok: true });
    await mockAppBridge();
    state.windows.at(-1).preventClose = true;
    const result = await state.handlers.get("Use Brian:select-account")!(sender(), deploymentAccountKey({ target: ownerTarget, tokens: tokens("local") }));
    expect(result).toEqual({ ok: false, error: "switch" });
    expect((await ownerJar.cookies.get({ name: "refresh_token" }))[0].value).toBe("owner-cookie-before-preflight");
    expect(JSON.parse(state.files.get("/tmp/desktop-switch-test/target.json")!.toString()).kind).toBe("cloud");
  });

});


describe("[COMP:app-desktop/main] thin owner session refresh", () => {
  beforeEach(() => setup("local-session", false));
  it("uses the app bridge when an expired thin session needs to resume", async () => {
    const win = state.windows.at(-1);
    const jar = win.options.webPreferences.session;
    await jar.cookies.set({ url: ownerTarget.appUrl, name: "refresh_token", value: "thin-refresh" });
    await jar.cookies.set({ url: ownerTarget.appUrl, name: "user", value: JSON.stringify({ id: "same-user", name: "You", email: "owner@local" }) });
    const pair = await mockAppBridge();
    win.webContents.emit("will-navigate", { preventDefault: vi.fn() }, `${ownerTarget.appUrl}/api/auth/refresh-and-return?next=${encodeURIComponent(ownerTarget.appUrl + "/w/workspace")}`);
    await vi.waitFor(() => expect(win.webContents.getURL()).toBe(ownerTarget.appUrl + "/w/workspace"));
    expect((await jar.cookies.get({ name: "refresh_token" }))[0].value).toBe(pair.refreshToken);
    expect(state.request.mock.calls[0][0].url).toBe(`${ownerTarget.appUrl}/api/auth/refresh`);
    expect(state.refresh).not.toHaveBeenCalled();
  });
});


describe("[COMP:app-desktop/main] add self-hosted account in place", () => {
  it("opens the renderer dialog from the native action without loading the standalone page", async () => {
    const win = state.windows.at(-1);
    const before = win.webContents.getURL();
    state.handlers.get("Use Brian:account-dialog-ready")!(sender(), true);
    state.handlers.get("Use Brian:choose-deployment")!(sender());
    expect(win.webContents.send).toHaveBeenCalledWith("Use Brian:choose-deployment", local.appUrl);
    expect(win.webContents.getURL()).toBe(before);
    expect(win.destroyed).toBe(false);
  });
  it("keeps the current app and target when owner authentication is rejected", async () => {
    await mockAppBridge({ status: 403, error: "owner_denied" });
    const win = state.windows.at(-1);
    expect(await state.handlers.get("Use Brian:run-local")!(sender(), local.appUrl)).toMatchObject({ ok: false, error: "auth" });
    expect(win.destroyed).toBe(false);
    expect(JSON.parse(state.files.get("/tmp/desktop-switch-test/target.json")!.toString()).auth).toBe("pkce");
    expect(store.current(local)?.refreshToken).toBe("local-refresh");
  });
  it("completes the owner session before replacing the app window", async () => {
    const pair = await mockAppBridge({ status: 307, location: local.appUrl + "/" });
    const win = state.windows.at(-1);
    expect(await state.handlers.get("Use Brian:run-local")!(sender(), local.appUrl)).toMatchObject({ ok: true });
    expect(state.request.mock.calls[0][0].url).toBe(local.appUrl + "/api/auth/local-session");
    expect(win.destroyed).toBe(true);
    expect(store.current(ownerTarget)?.accessToken).toBe(pair.accessToken);
    expect(state.windows.at(-1).webContents.getURL()).not.toContain("signin.html");
  });
  it("honors an unsaved-work veto after owner auth without navigating away", async () => {
    await mockAppBridge({ status: 307, location: local.appUrl + "/" });
    const win = state.windows.at(-1);
    win.preventClose = true;
    expect(await state.handlers.get("Use Brian:run-local")!(sender(), local.appUrl)).toMatchObject({ ok: false, error: "switch" });
    expect(win.destroyed).toBe(false);
    expect(JSON.parse(state.files.get("/tmp/desktop-switch-test/target.json")!.toString()).auth).toBe("pkce");
  });
  it("keeps a fallback for older app views that have no dialog host", async () => {
    const win = state.windows.at(-1);
    state.handlers.get("Use Brian:choose-deployment")!(sender());
    expect(win.webContents.getURL()).toContain("signin.html");
    expect(win.webContents.send).not.toHaveBeenCalledWith("Use Brian:choose-deployment", local.appUrl);
  });
  it("does not activate a destination when the requesting page navigates away during owner auth", async () => {
    let release!: () => void;
    await mockAppBridge({ status: 307, location: local.appUrl + "/", pause: new Promise<void>(resolve => { release = resolve; }) });
    const win = state.windows.at(-1);
    const connecting = state.handlers.get("Use Brian:run-local")!(sender(), local.appUrl);
    await vi.waitFor(() => expect(state.request).toHaveBeenCalledOnce());
    await win.webContents.loadURL("https://untrusted.example.com/");
    release();
    expect(await connecting).toMatchObject({ ok: false, error: "switch" });
    expect(win.destroyed).toBe(false);
    expect(store.current(ownerTarget)).toBeNull();
  });

});
