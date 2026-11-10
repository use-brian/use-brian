import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { DeploymentAccounts, deploymentAccountKey, deploymentKey, type AccountTarget } from "../deployment-accounts.js";
import { parseDesktopConfig, serializePersistedTarget } from "../target-store.js";
import type { StoredTokens } from "../desktop-token-store.js";

const state = vi.hoisted(() => ({ browserOptions: undefined as undefined | ConstructorParameters<typeof import("../embedded-browser.js").EmbeddedBrowser>[0], files: new Map<string, Buffer>(), handlers: new Map<string, Function>(), windows: [] as any[], app: null as any, partitions: new Map<string, any>(), makeSession: null as null | (() => any), refresh: vi.fn(), request: vi.fn(), exchange: vi.fn(), openExternal: vi.fn(), servers: [] as any[] }));
vi.mock("../embedded-browser.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../embedded-browser.js")>();
  return { ...original, EmbeddedBrowser: class extends original.EmbeddedBrowser {
    constructor(options?: ConstructorParameters<typeof original.EmbeddedBrowser>[0]) {
      super(options);
      state.browserOptions = options;
    }
  } };
});
vi.mock("node:http", async () => {
  const { EventEmitter } = await import("node:events");
  return { createServer: (handler: Function) => {
    const server = Object.assign(new EventEmitter(), { handler, close: vi.fn(), address: () => ({ port: 32123 }),
      listen: (_port: number, _host: string, ready: () => void) => ready(),
    });
    state.servers.push(server); return server;
  } };
});
vi.mock("electron-updater", () => ({ default: { autoUpdater: {} } }));
vi.mock("../desktop-auth.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../desktop-auth.js")>(), refreshSession: state.refresh, exchangeCode: state.exchange }));
vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  readFileSync: (path: string, encoding?: string) => {
    const value = state.files.get(String(path));
    if (!value) throw new Error("ENOENT");
    return encoding ? value.toString() : value;
  },
  mkdirSync: vi.fn(),
  writeFileSync: (path: string, data: string | Buffer) => state.files.set(String(path), Buffer.from(data)),
  renameSync: (from: string, to: string) => { state.files.set(to, state.files.get(from)!); state.files.delete(from); },
  rmSync: (path: string) => state.files.delete(String(path)),
  existsSync: (path: string) => String(path).endsWith("renderer/index.html") || state.files.has(String(path)),
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  const app = Object.assign(new EventEmitter(), { name: "Use Brian", isPackaged: true, isReady: () => true,
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
    destroy() { this.destroyed = true; this.emit("closed"); }
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
    dialog: { showErrorBox: vi.fn(), showMessageBox: vi.fn() }, net: { fetch: vi.fn(), request: state.request, isOnline: () => true },
    powerMonitor: new EventEmitter(), powerSaveBlocker: {}, globalShortcut: {}, shell: { openExternal: state.openExternal },
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
async function setup(auth: AccountTarget["auth"] = "pkce", bundled = true, signedIn = true) {
  state.app?.removeAllListeners();
  vi.resetModules(); state.files.clear(); state.handlers.clear(); state.windows.length = 0; state.partitions.clear();
  vi.stubEnv("USEBRIAN_APP_URL", ""); vi.stubEnv("USEBRIAN_API_URL", ""); vi.stubEnv("USEBRIAN_BUNDLED", String(bundled));
  state.files.set("/tmp/desktop-switch-test/target.json", Buffer.from(serializePersistedTarget(signedIn ? "local" : "cloud", local.appUrl, local.apiUrl, auth)));
  store = new DeploymentAccounts({ isAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() },
    () => state.files.get("/tmp/desktop-switch-test/deployment-accounts.bin")!,
    (blob) => { state.files.set("/tmp/desktop-switch-test/deployment-accounts.bin", blob); });
  if (signedIn) { store.put({ ...local, auth }, tokens("local")); store.put(cloud, tokens("cloud")); }
  state.request.mockReset(); state.openExternal.mockReset(); state.servers.length = 0;
  state.exchange.mockReset().mockResolvedValue({ ...tokens("signed-in"), accessTokenExpiresIn: 3600 });
  state.refresh.mockReset().mockResolvedValue({ accessToken: "cloud-new", refreshToken: "cloud-rotated", accessTokenExpiresIn: 3600 });
  await import("../main.js");
  state.app.emit("second-instance", {}, []);
  await new Promise((resolve) => setTimeout(resolve, 0));
}
beforeEach(() => setup());
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const sender = () => ({ sender: state.windows.at(-1).webContents, senderFrame: state.windows.at(-1).webContents.mainFrame });

describe("[COMP:app-desktop/main] embedded browser IPC", () => {
  const invoke = (event: unknown, input: unknown) => state.handlers.get("Use Brian:browser-control")!(event, input);
  const pairInput = (userId = "same-user") => ({ type: "pair", relayUrl: "wss://relay.example/browser",
    pairingToken: `header.${Buffer.from(JSON.stringify({ kind: "browser-ext-pair", exp: 4_000_000_000,
      userId, workspaceId: "workspace", browserProfileId: "profile" })).toString("base64url")}.signature` });

  it('forwards live theme payloads only from the trusted app main frame', async () => {
    const { EmbeddedBrowser } = await import('../embedded-browser.js');
    const setTheme = vi.spyOn(EmbeddedBrowser.prototype, 'setTheme').mockImplementation(() => {});
    const receive = state.handlers.get('embedded-browser:theme')!;
    const input = { colorScheme: 'light' };
    receive(sender(), input);
    expect(setTheme).toHaveBeenCalledExactlyOnceWith(input);
    setTheme.mockClear();
    const website = { id: 999, isDestroyed: () => false, mainFrame: {}, getURL: () => 'https://example.com/' };
    receive({ sender: website, senderFrame: website.mainFrame }, input);
    receive({ ...sender(), senderFrame: {} }, input);
    await state.windows.at(-1).webContents.loadURL('https://untrusted.example.com/');
    receive(sender(), input);
    expect(setTheme).not.toHaveBeenCalled();
  });

  it('rejects theme updates during an account identity transition and accepts the replacement app', async () => {
    const { EmbeddedBrowser } = await import('../embedded-browser.js');
    const setTheme = vi.spyOn(EmbeddedBrowser.prototype, 'setTheme').mockImplementation(() => {});
    const receive = state.handlers.get('embedded-browser:theme')!;
    const oldSender = sender();
    let release!: (value: any) => void;
    state.refresh.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    const switching = state.handlers.get('Use Brian:select-account')!(oldSender,
      deploymentAccountKey({ target: cloud, tokens: tokens('cloud') }));
    receive(oldSender, { colorScheme: 'dark' });
    expect(setTheme).not.toHaveBeenCalled();
    release({ accessToken: 'new', refreshToken: 'rotated', accessTokenExpiresIn: 3600 });
    expect(await switching).toEqual({ ok: true });
    await new Promise(resolve => setTimeout(resolve, 0));
    receive(oldSender, { colorScheme: 'dark' });
    expect(setTheme).not.toHaveBeenCalled();
    receive(sender(), { colorScheme: 'light' });
    expect(setTheme).toHaveBeenCalledExactlyOnceWith({ colorScheme: 'light' });
  });

  it("supplies the current main window factory and preserves docked browser focus", async () => {
    const { EmbeddedBrowser } = await import("../embedded-browser.js");
    const main = state.windows[0];
    expect(state.browserOptions?.getDockWindow).toBeTypeOf("function");
    expect(state.browserOptions!.getDockWindow!()).toBe(main);
    expect(state.windows).toHaveLength(1);
    const dockFocused = vi.spyOn(EmbeddedBrowser.prototype, "isDockedFocused").mockReturnValue(true);
    main.webContents.focus.mockClear();
    main.emit("focus");
    expect(dockFocused).toHaveBeenCalledOnce();
    expect(main.webContents.focus).not.toHaveBeenCalled();
    dockFocused.mockReturnValue(false);
    main.emit("focus");
    expect(main.webContents.focus).toHaveBeenCalledOnce();
    const dispose = vi.spyOn(EmbeddedBrowser.prototype, "dispose");
    main.close();
    expect(dispose).toHaveBeenCalledOnce();
    const replacement = state.browserOptions!.getDockWindow!();
    expect(replacement).toBe(state.windows[1]);
    expect(replacement).not.toBe(main);
  });

  it("cancels pending native pairing when the main window closes", async () => {
    const { dialog } = await import("electron");
    let approve!: (answer: Electron.MessageBoxReturnValue) => void;
    const consent = vi.spyOn(dialog, "showMessageBox").mockReturnValueOnce(
      new Promise(resolve => { approve = resolve; }),
    );
    const pending = invoke(sender(), pairInput());
    expect(consent).toHaveBeenCalledOnce();
    state.windows[0].close();
    approve({ response: 1, checkboxChecked: false });
    expect(await pending).toEqual({ ok: false });
    expect(state.windows).toHaveLength(1);
    expect(state.windows[0].destroyed).toBe(true);
  });

  it.each(["status", "request-control", "pair", "show", "cancel", "disconnect"])("validates the sender and main frame for %s", async (type) => {
    const { EmbeddedBrowser } = await import("../embedded-browser.js");
    const pair = vi.spyOn(EmbeddedBrowser.prototype, "pair").mockResolvedValue(true);
    const status = vi.spyOn(EmbeddedBrowser.prototype, "status");
    const actions = ["show", "cancelPending", "dispose"].map(method => vi.spyOn(EmbeddedBrowser.prototype, method as "show"));
    const input = type === "pair" ? pairInput() : { type };
    const foreignContents = { id: 999, isDestroyed: () => false, mainFrame: {} };
    expect(await invoke({ sender: foreignContents, senderFrame: foreignContents.mainFrame }, input)).toEqual({ ok: false });
    expect(await invoke({ ...sender(), senderFrame: {} }, input)).toEqual({ ok: false });
    await state.windows.at(-1).webContents.loadURL("https://untrusted.example.com/");
    expect(await invoke(sender(), input)).toEqual({ ok: false });
    expect(pair).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    for (const action of actions) expect(action).not.toHaveBeenCalled();
  });

  it("reports capability to the trusted renderer and pairs only matching user claims", async () => {
    const { EmbeddedBrowser } = await import("../embedded-browser.js");
    const pair = vi.spyOn(EmbeddedBrowser.prototype, "pair").mockResolvedValue(true);
    for (const type of ["status", "request-control"]) {
      expect(await invoke(sender(), { type })).toEqual({ ok: true, hasControl: true, connected: false, automaticBlocked: false, controlEpoch: 0 });
    }
    expect(await invoke(sender(), pairInput("other-user"))).toEqual({ ok: false });
    expect(pair).not.toHaveBeenCalled();
    expect(await invoke(sender(), pairInput())).toEqual({ ok: true });
    expect(pair).toHaveBeenCalledExactlyOnceWith(pairInput(), JSON.stringify([local.appUrl, "same-user"]));
  });

  it.each([['show', 'show'], ['cancel', 'cancelPending'], ['disconnect', 'dispose']] as const)('delegates trusted %s requests', async (type, method) => {
    const { EmbeddedBrowser } = await import('../embedded-browser.js');
    const action = vi.spyOn(EmbeddedBrowser.prototype, method).mockImplementation(() => {});
    expect(await invoke(sender(), { type })).toEqual({ ok: true });
    expect(action).toHaveBeenCalledExactlyOnceWith(...(type === 'disconnect' ? [true] : []));
  });

  it.each(["sign-out", "clear-tokens"])("disposes browser control on %s", async (action) => {
    const { EmbeddedBrowser } = await import("../embedded-browser.js");
    const dispose = vi.spyOn(EmbeddedBrowser.prototype, "dispose");
    state.handlers.get(`Use Brian:${action}`)!(sender());
    await vi.waitFor(() => expect(dispose).toHaveBeenCalled());
  });

  it("disposes browser control when renderer tokens change account identity", async () => {
    const { EmbeddedBrowser } = await import("../embedded-browser.js");
    const dispose = vi.spyOn(EmbeddedBrowser.prototype, "dispose");
    state.handlers.get("Use Brian:set-tokens")!(sender(), tokens("renewed"));
    expect(dispose).not.toHaveBeenCalled();
    state.handlers.get("Use Brian:set-tokens")!(sender(), { ...tokens("other"), user: { ...tokens("other").user, id: "other-user" } });
    expect(dispose).toHaveBeenCalledOnce();
    expect(store.current(local)?.user?.id).toBe("other-user");
  });
});

describe("[COMP:app-desktop/main] deployment switching", () => {
  it("admits credentialed API reads only for current bundled top frames after a target switch", async () => {
    const select = (target: AccountTarget) => state.handlers.get("Use Brian:select-account")!(sender(),
      deploymentAccountKey({ target, tokens: tokens(target.kind) }));
    const upstream = { "access-control-allow-origin": ["null"], "access-control-allow-credentials": ["true"] };
    const hookFor = (target: AccountTarget) => targetJar(target).webRequest.onHeadersReceived.mock.calls.at(-1)[0];
    const reply = (hook: Function, input: Record<string, unknown>) => {
      const callback = vi.fn();
      hook({ method: "GET", url: `${local.apiUrl}/api/workspaces/example/member-directory`, responseHeaders: upstream, ...input }, callback);
      return callback.mock.calls[0][0];
    };

    expect(await select(cloud)).toEqual({ ok: true });
    const cloudHook = hookFor(cloud);
    const cloudReply = reply(cloudHook, { url: `${cloud.apiUrl}/api/assistants` });
    expect(cloudReply.responseHeaders["access-control-allow-credentials"]).toEqual(["true"]);

    expect(await select(local)).toEqual({ ok: true });
    const win = state.windows.at(-1);
    await vi.waitFor(() => expect(win.webContents.getURL()).toMatch(/^file:.*\/renderer\/index\.html/));
    const localHook = hookFor(local);
    expect(win.options.webPreferences.additionalArguments).toContain("--usebrian-local-target");
    const trusted = { webContentsId: win.webContents.id, webContents: win.webContents, frame: win.webContents.mainFrame };
    expect(reply(localHook, trusted).responseHeaders["Access-Control-Allow-Credentials"]).toEqual(["true"]);
    expect(reply(localHook, { method: "OPTIONS" }).responseHeaders["Access-Control-Allow-Credentials"]).toEqual(["true"]);

    for (const untrusted of [
      {}, { ...trusted, frame: {} }, { ...trusted, frame: null },
      { ...trusted, webContentsId: 999 }, { method: "OPTIONS", frame: null },
      { method: "OPTIONS", webContentsId: win.webContents.id },
    ]) {
      const headers = reply(localHook, untrusted).responseHeaders;
      expect(Object.keys(headers).some(name => name.toLowerCase() === "access-control-allow-credentials")).toBe(false);
    }
    expect(reply(localHook, { ...trusted, url: "https://untrusted.example/api/assistants" })).toEqual({});
    await win.webContents.loadURL("https://untrusted.example/");
    expect(reply(localHook, trusted).responseHeaders).not.toHaveProperty("Access-Control-Allow-Credentials");
  });

  it("allows presentation changes only from a current main frame without changing sessions", async () => {
    const key = deploymentAccountKey({ target: local, tokens: tokens("local") });
    const update = state.handlers.get("Use Brian:update-account-presentation")!;
    const move = state.handlers.get("Use Brian:move-account")!;
    expect(await update({ ...sender(), senderFrame: {} }, key, { displayName: "Studio", icon: "🏡" })).toEqual({ ok: false });
    expect(await update({ sender: { id: -1 }, senderFrame: {} }, key, { displayName: "Studio", icon: "🏡" })).toEqual({ ok: false });
    expect(await update(sender(), key, { displayName: "Studio", icon: "🏡" })).toMatchObject({ ok: true });
    expect(await move(sender(), key, "up")).toMatchObject({ ok: true, accounts: [expect.objectContaining({ key, displayName: "Studio", icon: "🏡" }), expect.anything()] });
    expect(store.current(local)?.user?.name).toBe("local");
    expect(state.windows).toHaveLength(1);
    expect(await move(sender(), key, "sideways")).toEqual({ ok: false });
  });
  it.each([true, false])("keeps recorder origin and session aligned (bundled=%s)", async (bundled) => {
    await setup("pkce", bundled);
    const main = state.windows[0];
    state.handlers.get("Use Brian:recording-state")!({}, true);
    const overlay = state.windows[1];

    expect(overlay.options.webPreferences.session).toBe(main.options.webPreferences.session);
    if (bundled) {
      expect(overlay.webContents.loadFile).toHaveBeenCalledWith(
        expect.stringContaining("renderer/index.html"), { hash: "/recorder-overlay" },
      );
      expect(overlay.webContents.loadURL).not.toHaveBeenCalled();
    } else {
      expect(overlay.webContents.loadURL).toHaveBeenCalledWith(`${local.appUrl}/recorder-overlay`);
    }
  });

  it("switches local to cloud and back without restarting, preserving sessions and isolated caches", async () => {
    const { EmbeddedBrowser } = await import("../embedded-browser.js");
    const dispose = vi.spyOn(EmbeddedBrowser.prototype, "dispose");
    const first = state.windows[0];
    const key = deploymentAccountKey({ target: cloud, tokens: tokens("cloud") });
    const result = await state.handlers.get("Use Brian:select-account")!(sender(), key);
    expect(result).toEqual({ ok: true });
    expect(dispose).toHaveBeenCalled();
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
async function mockAppBridge(options: { status?: number; error?: string; pause?: Promise<void>; omitCookies?: boolean; location?: string; appUrl?: string } = {}) {
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
            await requestOptions.session.cookies.set({ url: options.appUrl ?? ownerTarget.appUrl, name, value });
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
    const { EmbeddedBrowser } = await import("../embedded-browser.js");
    const dispose = vi.spyOn(EmbeddedBrowser.prototype, "dispose");
    await mockAppBridge({ status: 401, error: "refresh_rejected" });
    expect(await refresh()).toEqual({ kind: "unauthenticated" });
    expect(dispose).toHaveBeenCalled();
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
  it.each([true, false])("loads the main app and queues its dialog when the current view has no host (bundled: %s)", async (bundled) => {
    await setup("pkce", bundled);
    const win = state.windows.at(-1);
    state.handlers.get("Use Brian:choose-deployment")!(sender());
    await vi.waitFor(() => expect(win.webContents.send).toHaveBeenCalledWith("Use Brian:choose-deployment", local.appUrl));
    expect(win.webContents.getURL()).toContain("renderer/index.html");
    expect(win.webContents.loadFile).toHaveBeenLastCalledWith(expect.stringContaining("renderer/index.html"),
      expect.objectContaining({ query: expect.objectContaining({ accountEntry: "signed-out" }) }));
    // The exact entry renderer remains authorized for account IPC in thin mode.
    expect(await state.handlers.get("Use Brian:list-accounts")!(sender())).toHaveProperty("accounts");
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

describe("[COMP:app-desktop/main] connect a self-hosted PKCE deployment", () => {
  const targetFor = (appUrl = "https://brain.example.com"): AccountTarget => {
    const apiUrl = appUrl.replace("https://", "https://api.");
    const publicConfig = parseDesktopConfig({ apiUrl, edition: "outpost", primaryAuthUrl: "https://auth.example.com" })!.publicConfig;
    return { kind: "local", appUrl, apiUrl, auth: "pkce", publicConfig };
  };
  const configure = async (destination = targetFor()) => {
    const { net } = await import("electron");
    const declared = { ...destination.publicConfig, apiUrl: destination.apiUrl, edition: "outpost" };
    vi.mocked(net.fetch).mockResolvedValue(new Response(JSON.stringify(declared)));
    targetJar(destination).fetch.mockImplementation(async (url: string) => new Response(JSON.stringify(url.endsWith("/health") ? { status: "ok" } : declared)));
    return destination;
  };
  const phase = () => state.handlers.get("Use Brian:get-sign-in-state")!(sender());
  const callback = (server = state.servers.at(-1), browserUrl = state.openExternal.mock.calls.at(-1)![0]) => {
    const nonce = new URL(browserUrl).searchParams.get("state");
    const response = { writeHead: vi.fn(), end: vi.fn() };
    server.handler({ url: `/cb?code=fictional-destination-code&state=${nonce}` }, response);
    return response;
  };
  it.each([true, false])("authenticates the destination before switching and preserves the original account (bundled: %s)", async bundled => {
    await setup("pkce", bundled);
    const destination = await configure(), originalWindow = state.windows.at(-1);
    const originalTarget = state.files.get("/tmp/desktop-switch-test/target.json")!.toString();
    expect(await state.handlers.get("Use Brian:run-local")!(sender(), destination.appUrl)).toEqual({ ok: true, url: destination.appUrl });
    const browser = new URL(state.openExternal.mock.calls[0][0]);
    expect(browser.origin).toBe(destination.appUrl);
    expect(browser.pathname).toBe("/desktop/auth");
    expect(browser.searchParams.get("challenge")).toBeTruthy();
    expect(browser.searchParams.get("state")).toBeTruthy();
    expect(phase()).toEqual({ phase: "browser", appUrl: destination.appUrl });
    expect(originalWindow.destroyed).toBe(false);
    expect(state.files.get("/tmp/desktop-switch-test/target.json")!.toString()).toBe(originalTarget);
    expect(store.current(destination)).toBeNull();
    state.exchange.mockImplementation(async (api, _code, _verifier, fetch) => {
      expect(api).toBe(destination.apiUrl);
      expect(originalWindow.destroyed).toBe(false);
      await fetch(`${api}/fictional-exchange-probe`, { method: "POST" });
      return { ...tokens("destination"), accessTokenExpiresIn: 3600 };
    });
    callback();
    await vi.waitFor(() => expect(originalWindow.destroyed).toBe(true));
    await vi.waitFor(() => expect(phase().phase).toBe("idle"));
    expect(store.current(destination)?.accessToken).toBe("destination-access");
    expect(store.current(local)?.accessToken).toBe("local-access");
    expect(store.current(cloud)?.accessToken).toBe("cloud-access");
    expect(targetJar(destination).fetch).toHaveBeenCalledWith(`${destination.apiUrl}/fictional-exchange-probe`, expect.objectContaining({ credentials: "include" }));
    expect(JSON.parse(state.files.get("/tmp/desktop-switch-test/target.json")!.toString())).toMatchObject({ kind: "local", appUrl: destination.appUrl, apiUrl: destination.apiUrl, auth: "pkce" });
    expect(state.request).not.toHaveBeenCalled(); // No OSS owner-session mint.
  });
  it("reopens the same attempt and supersedes a different destination without changing the working window", async () => {
    const first = await configure(), win = state.windows.at(-1);
    await state.handlers.get("Use Brian:run-local")!(sender(), first.appUrl);
    const firstUrl = state.openExternal.mock.calls[0][0], firstServer = state.servers[0];
    await state.handlers.get("Use Brian:run-local")!(sender(), first.appUrl);
    expect(state.servers).toHaveLength(1);
    expect(state.openExternal).toHaveBeenLastCalledWith(firstUrl);
    const second = await configure(targetFor("https://another.example.com"));
    await state.handlers.get("Use Brian:run-local")!(sender(), second.appUrl);
    expect(firstServer.close).toHaveBeenCalled();
    expect(state.servers).toHaveLength(2);
    expect(new URL(state.openExternal.mock.calls.at(-1)![0]).origin).toBe(second.appUrl);
    expect(callback(firstServer, firstUrl).writeHead).toHaveBeenCalledWith(410);
    expect(state.exchange).not.toHaveBeenCalled();
    expect(win.destroyed).toBe(false);
    expect(store.current(local)?.accessToken).toBe("local-access");
  });
  it.each(["cancel", "exchange", "storage", "unload"] as const)("keeps the current deployment and credentials after destination %s failure", async failure => {
    const destination = await configure(), win = state.windows.at(-1);
    const persisted = state.files.get("/tmp/desktop-switch-test/target.json")!.toString();
    const { EmbeddedBrowser } = await import("../embedded-browser.js");
    const dispose = vi.spyOn(EmbeddedBrowser.prototype, "dispose");
    await state.handlers.get("Use Brian:run-local")!(sender(), destination.appUrl);
    dispose.mockClear();
    if (failure === "cancel") state.handlers.get("Use Brian:cancel-sign-in")!(sender());
    if (failure === "exchange") state.exchange.mockRejectedValue(new Error("Fictional exchange refused"));
    if (failure === "storage") {
      const { safeStorage } = await import("electron");
      vi.spyOn(safeStorage, "isEncryptionAvailable").mockReturnValue(false);
    }
    if (failure === "unload") win.preventClose = true;
    callback();
    await vi.waitFor(() => expect(phase().phase).toBe(failure === "cancel" ? "idle" : "error"));
    expect(win.destroyed).toBe(false);
    expect(state.files.get("/tmp/desktop-switch-test/target.json")!.toString()).toBe(persisted);
    if (failure !== "storage") expect(store.current(local)?.accessToken).toBe("local-access");
    if (failure !== "unload") expect(dispose).not.toHaveBeenCalled();
  });
  it("discards a cancelled destination exchange before a subsequent connection", async () => {
    const destination = await configure(), win = state.windows.at(-1);
    let release!: (value: unknown) => void;
    state.exchange.mockReturnValue(new Promise(resolve => { release = resolve; }));
    await state.handlers.get("Use Brian:run-local")!(sender(), destination.appUrl);
    callback();
    await vi.waitFor(() => expect(state.exchange).toHaveBeenCalledOnce());
    const signal = state.exchange.mock.calls[0][4] as AbortSignal;
    state.handlers.get("Use Brian:cancel-sign-in")!(sender());
    expect(signal.aborted).toBe(true);
    const next = await configure(targetFor("https://next.example.com"));
    const connecting = state.handlers.get("Use Brian:run-local")!(sender(), next.appUrl);
    release({ ...tokens("late-destination"), accessTokenExpiresIn: 3600 });
    expect(await connecting).toEqual({ ok: true, url: next.appUrl });
    expect(JSON.parse(state.files.get("/tmp/desktop-switch-test/pending-signin.json")!.toString()).destination.target.appUrl).toBe(next.appUrl);
    expect(phase()).toEqual({ phase: "browser", appUrl: next.appUrl });
    expect(win.destroyed).toBe(false);
    expect(store.current(destination)).toBeNull();
    expect(store.current(local)?.accessToken).toBe("local-access");
  });
  it.each([true, false])("restores a persisted destination only under its original source deployment (same source: %s)", async same => {
    const destination = await configure();
    await state.handlers.get("Use Brian:run-local")!(sender(), destination.appUrl);
    const pending = state.files.get("/tmp/desktop-switch-test/pending-signin.json")!;
    await setup("pkce", true, same);
    state.files.set("/tmp/desktop-switch-test/pending-signin.json", pending);
    const win = state.windows.at(-1);
    state.app.emit("open-url", { preventDefault: vi.fn() }, "usebrian://auth?code=fictional-cold-code");
    await vi.waitFor(() => expect(phase().phase).toBe(same ? "idle" : "error"));
    if (same) {
      await vi.waitFor(() => expect(win.destroyed).toBe(true));
      expect(state.exchange).toHaveBeenCalledWith(destination.apiUrl, "fictional-cold-code", expect.any(String), expect.any(Function), expect.any(AbortSignal));
      expect(store.current(destination)?.accessToken).toBe("signed-in-access");
    } else {
      expect(state.exchange).not.toHaveBeenCalled();
      expect(win.destroyed).toBe(false);
      expect(store.current(destination)).toBeNull();
    }
  });
});


describe("[COMP:app-desktop/main] destination gateway validation", () => {
  it.each([false, true])("uses the final destination jar for login, probes and owner exchange (discovered API: %s)", async (differentApi) => {
    const { localTarget } = await import("../target-store.js");
    const appUrl = "https://brain.example.com";
    const guessed = { ...localTarget(appUrl)!, kind: "local" as const };
    const destination = { ...guessed, apiUrl: differentApi ? "https://service.example.com" : guessed.apiUrl };
    const active = targetJar(local);
    const activeCalls = active.fetch.mock.calls.length;
    const activeCookies = await active.cookies.get({});
    const persisted = state.files.get("/tmp/desktop-switch-test/target.json")!.toString();
    const pair = await mockAppBridge({ appUrl, status: 307, location: appUrl + "/" });
    for (const target of [guessed, destination]) {
      const jar = targetJar(target);
      jar.fetch.mockImplementation(async (url: string) => {
        const authenticated = (await jar.cookies.get({ name: "CF_Authorization" })).length > 0;
        return authenticated
          ? new Response(JSON.stringify(url.endsWith("/health") ? { status: "ok" } : { apiUrl: destination.apiUrl, edition: "oss" }))
          : new Response("gateway login", { status: 403 });
      });
    }
    const event = sender();
    const connecting = state.handlers.get("Use Brian:run-local")!(event, appUrl);
    for (const target of differentApi ? [guessed, destination] : [destination]) {
      const jar = targetJar(target);
      await vi.waitFor(() => expect(state.windows.some((win) => !win.destroyed && win.options.title === "Authenticate to Local Brain" && win.options.webPreferences.session === jar)).toBe(true));
      const login = state.windows.find((win) => !win.destroyed && win.options.title === "Authenticate to Local Brain" && win.options.webPreferences.session === jar);
      expect(state.files.get("/tmp/desktop-switch-test/target.json")!.toString()).toBe(persisted);
      await jar.cookies.set({ url: appUrl, name: "CF_Authorization", value: "destination-only", httpOnly: true });
      login.webContents.emit("did-navigate", {}, appUrl, 200);
    }
    expect(await connecting).toEqual({ ok: true, url: appUrl });
    expect(state.request.mock.calls[0][0].session).toBe(targetJar(destination));
    expect(store.current(destination)?.accessToken).toBe(pair.accessToken);
    expect(active.fetch.mock.calls.length).toBe(activeCalls);
    expect(await active.cookies.get({})).toEqual(activeCookies);
    expect(await targetJar(destination).cookies.get({ name: "CF_Authorization" })).toHaveLength(1);
  });

  it("cancelling destination gateway login leaves the current deployment unchanged", async () => {
    const { localTarget } = await import("../target-store.js");
    const target = { ...localTarget("https://cancel.example.com")!, kind: "local" as const };
    targetJar(target).fetch.mockResolvedValue(new Response("login", { status: 403 }));
    const persisted = state.files.get("/tmp/desktop-switch-test/target.json")!.toString();
    const connecting = state.handlers.get("Use Brian:run-local")!(sender(), target.appUrl);
    await vi.waitFor(() => expect(state.windows.at(-1).options.title).toBe("Authenticate to Local Brain"));
    state.windows.at(-1).close();
    expect(await connecting).toMatchObject({ ok: false, error: "gateway-auth" });
    expect(state.files.get("/tmp/desktop-switch-test/target.json")!.toString()).toBe(persisted);
    expect(state.request).not.toHaveBeenCalled();
    expect(store.current(local)?.accessToken).toBe("local-access");
  });
});


describe("[COMP:app-desktop/main] main app account entry", () => {
  it("starts signed-out packaged launches in the installed app", async () => {
    await setup("pkce", true, false);
    const win = state.windows.at(-1);
    expect(win.webContents.getURL()).toContain("renderer/index.html");
    expect(win.webContents.loadFile).toHaveBeenCalledOnce();
  });
  it("returns to the app after signing out and preserves other saved accounts", async () => {
    const win = state.windows.at(-1);
    state.handlers.get("Use Brian:sign-out")!(sender());
    await vi.waitFor(() => expect(store.current(local)).toBeNull());
    await vi.waitFor(() => expect(win.webContents.loadFile).toHaveBeenCalledTimes(2));
    expect(win.webContents.getURL()).toContain("renderer/index.html");
    expect(store.current(cloud)?.refreshToken).toBe("cloud-refresh");
  });
  it("shows accounts after session rejection and ignores subframe or foreign requests", async () => {
    const win = state.windows.at(-1);
    const show = state.handlers.get("Use Brian:show-accounts")!;
    const loads = win.webContents.loadFile.mock.calls.length;
    show({ ...sender(), senderFrame: {} });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(win.webContents.loadFile).toHaveBeenCalledTimes(loads);
    show(sender());
    await vi.waitFor(() => expect(win.webContents.loadFile).toHaveBeenLastCalledWith(
      expect.stringContaining("renderer/index.html"), expect.objectContaining({ query: expect.objectContaining({ accountEntry: "signed-out" }) })));
    await win.webContents.loadURL("https://untrusted.example/");
    show(sender());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(win.webContents.getURL()).toBe("https://untrusted.example/");
  });
  it("keeps the current destination when the shared session guard handles reauthentication", async () => {
    const win = state.windows.at(-1);
    await win.webContents.loadURL(win.webContents.getURL() + "#/w/workspace-one/chat?thread=two");
    const before = win.webContents.getURL(), loads = win.webContents.loadFile.mock.calls.length;
    state.handlers.get("Use Brian:session-guard-ready")!(sender(), true);
    state.handlers.get("Use Brian:show-accounts")!(sender());
    expect(win.webContents.send).toHaveBeenCalledWith("Use Brian:session-cleared", "expired");
    expect(win.webContents.getURL()).toBe(before); expect(win.webContents.loadFile).toHaveBeenCalledTimes(loads);
  });
  it("routes an unreachable local deployment to main app recovery without minting again", async () => {
    const win = state.windows.at(-1);
    win.webContents.emit("did-fail-load", {}, -105, "unreachable", local.appUrl, true);
    await vi.waitFor(() => expect(win.webContents.loadFile).toHaveBeenLastCalledWith(
      expect.stringContaining("renderer/index.html"), expect.objectContaining({ query: expect.objectContaining({ accountEntry: "unreachable" }) })));
    expect(state.request).not.toHaveBeenCalled();
  });
});


describe("[COMP:app-desktop/main] sign-in lifecycle and return intent", () => {
  const start = (options?: { userId?: string }) => state.handlers.get("Use Brian:sign-in")!(sender(), options);
  const phase = () => state.handlers.get("Use Brian:get-sign-in-state")!(sender()).phase;
  const callback = (nonce?: string) => {
    const server = state.servers.at(-1); const res = { writeHead: vi.fn(), end: vi.fn() };
    const expected = nonce ?? new URL(state.openExternal.mock.calls.at(-1)![0]).searchParams.get("state");
    server.handler({ url: `/cb?code=fictional-code&state=${expected}` }, res); return res;
  };
  it("retains a non-null nonce and reopens the same browser attempt", async () => {
    start(); const first = state.openExternal.mock.calls[0][0];
    expect(new URL(first).searchParams.get("state")).toBeTruthy(); expect(phase()).toBe("browser");
    state.handlers.get("Use Brian:reopen-sign-in")!(sender());
    expect(state.openExternal).toHaveBeenLastCalledWith(first); expect(state.servers).toHaveLength(1);
    const rejected = callback("wrong-nonce"); expect(rejected.writeHead).toHaveBeenCalledWith(404, expect.anything());
    expect(state.exchange).not.toHaveBeenCalled();
  });
  it("shows actionable failure when the system browser cannot open", async () => {
    state.openExternal.mockRejectedValue(new Error("Browser unavailable"));
    start(); await vi.waitFor(() => expect(phase()).toBe("error"));
    expect(state.servers.at(-1).close).toHaveBeenCalled();
    expect(state.files.has("/tmp/desktop-switch-test/pending-signin.json")).toBe(false);
  });
  it("cancels listener/verifier state and refuses a late callback", async () => {
    start(); const server = state.servers.at(-1); state.handlers.get("Use Brian:cancel-sign-in")!(sender());
    expect(server.close).toHaveBeenCalled(); expect(phase()).toBe("idle");
    expect(state.files.has("/tmp/desktop-switch-test/pending-signin.json")).toBe(false);
    callback(); await new Promise(resolve => setTimeout(resolve, 0)); expect(state.exchange).not.toHaveBeenCalled();
  });
  it.each([true, false])("resumes only the original identity's route (same identity: %s)", async same => {
    const win = state.windows.at(-1);
    await win.webContents.loadURL(win.webContents.getURL() + "#/w/workspace-one/chat?thread=two");
    state.exchange.mockResolvedValue({ ...tokens("signed-in"), user: { id: same ? "same-user" : "different-user", name: "Example user", email: "person@example.com" }, accessTokenExpiresIn: 3600 });
    start(); callback(); await vi.waitFor(() => expect(phase()).toBe("idle"));
    const options = state.windows.at(-1).webContents.loadFile.mock.calls.at(-1)[1];
    expect(options.hash).toBe(same ? "/w/workspace-one/chat?thread=two" : undefined);
    if (same) expect(win.webContents.send).toHaveBeenCalledWith("Use Brian:session-restored");
  });
  it("preserves the old identity and draft window when an account-change unload is vetoed", async () => {
    const win = state.windows.at(-1); win.preventClose = true;
    state.exchange.mockResolvedValue({ ...tokens("new-account"), user: { id: "different-user", name: "Example user", email: "other@example.com" }, accessTokenExpiresIn: 3600 });
    start(); callback(); await vi.waitFor(() => expect(phase()).toBe("error"));
    expect(win.destroyed).toBe(false); expect(store.current(local)?.user?.id).toBe("same-user");
  });
  it("discards exchange results after cancellation", async () => {
    let release!: (value: unknown) => void; state.exchange.mockReturnValue(new Promise(resolve => { release = resolve; }));
    start(); callback(); await vi.waitFor(() => expect(phase()).toBe("exchanging"));
    const signal = state.exchange.mock.calls[0][4] as AbortSignal;
    state.handlers.get("Use Brian:cancel-sign-in")!(sender()); expect(signal.aborted).toBe(true);
    release({ ...tokens("late-sign-in"), accessTokenExpiresIn: 3600 });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(store.current(local)?.accessToken).toBe("local-access"); expect(phase()).toBe("idle");
  });
  it("notifies every account renderer and refuses a late token write after logout", async () => {
    const win = state.windows.at(-1); state.handlers.get("Use Brian:sign-out")!(sender());
    await vi.waitFor(() => expect(store.current(local)).toBeNull());
    expect(win.webContents.send).toHaveBeenCalledWith("Use Brian:session-cleared", "logout");
    state.handlers.get("Use Brian:set-tokens")!(sender(), tokens("late-refresh"));
    expect(store.current(local)).toBeNull();
  });
  it("ignores lifecycle commands from a child frame", () => {
    state.handlers.get("Use Brian:sign-in")!({ ...sender(), senderFrame: {} });
    expect(state.openExternal).not.toHaveBeenCalled();
  });
});
