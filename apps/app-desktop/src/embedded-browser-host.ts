import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BrowserWindow, WebContentsView, ipcMain, session, type WebContents, type IpcMainEvent, type Session } from "electron";

const COMMAND = "embedded-browser:command";
const STATE = "embedded-browser:state";
const TOOLBAR_HEIGHT = 144;
const DEFAULT_URL = "https://www.google.com/";
const toolbarPath = fileURLToPath(new URL("./embedded-browser.html", import.meta.url));
const toolbarUrl = pathToFileURL(toolbarPath).href;
const activeSessions = new WeakSet<Session>();

// Intentionally no scheme guessing: neither IPC nor callers may load local URLs.
function validWebUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

type Callbacks = { approveTab?: (id: number) => void; stop: () => void; closed: () => void; tabClosed: (id: number) => void; detached: (id: number) => void };
type Tab = { id: number; handle: string; taskOwned: boolean; contents: WebContents; view: WebContentsView };

/** Owns an exclusive persistent browsing partition; never use an app deployment partition. */
export class EmbeddedBrowserHost {
  private readonly window: BrowserWindow;
  private readonly browsingSession: Session;
  private readonly entries = new Map<number, Tab>();
  private selected: number | null = null;
  private status = "Manual browsing ready";
  private disposed = false;

  constructor(partition: string, private readonly callbacks: Callbacks) {
    if (!partition.startsWith("persist:") || partition.length <= 8 || partition.startsWith("persist:deployment-")) {
      throw new Error("Embedded browser requires a dedicated persistent partition (not an app deployment partition)");
    }
    this.browsingSession = session.fromPartition(partition);
    if (this.browsingSession === session.defaultSession || activeSessions.has(this.browsingSession)) {
      throw new Error("Embedded browser partition is already in use");
    }
    activeSessions.add(this.browsingSession);
    this.browsingSession.setPermissionRequestHandler((_wc, _permission, reply) => reply(false));
    this.browsingSession.setPermissionCheckHandler(() => false);
    this.browsingSession.setDevicePermissionHandler(() => false);
    // Covers requests not initiated through ordinary navigation (including file/custom schemes).
    this.browsingSession.webRequest.onBeforeRequest((details, reply) => {
      const navigation = details.resourceType === "mainFrame" || details.resourceType === "subFrame";
      let allowed = !!validWebUrl(details.url);
      if (!navigation) {
        // Sites need in-memory images/media and websocket connections, but never local files.
        allowed ||= /^(data:|blob:|wss?:)/i.test(details.url);
      }
      reply({ cancel: !allowed });
    });
    this.browsingSession.on("will-download", this.onDownload);
    this.window = new BrowserWindow({
      width: 1200, height: 850, minWidth: 640, minHeight: 360, show: false,
      title: "Brian Browser", autoHideMenuBar: true,
      webPreferences: {
        preload: fileURLToPath(new URL("./embedded-browser-preload.cjs", import.meta.url)),
        partition: `embedded-toolbar-${randomUUID()}`,
        sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true,
        webviewTag: false, navigateOnDragDrop: false,
      },
    });
    const toolbar = this.window.webContents;
    toolbar.session.setPermissionRequestHandler((_wc, _permission, reply) => reply(false));
    toolbar.session.setPermissionCheckHandler(() => false);
    toolbar.session.setDevicePermissionHandler(() => false);
    toolbar.setWindowOpenHandler(() => ({ action: "deny" }));
    toolbar.on("will-navigate", event => event.preventDefault());
    toolbar.on("will-frame-navigate", event => event.preventDefault());
    toolbar.on("will-redirect", event => event.preventDefault());
    toolbar.on("did-finish-load", () => this.publish());
    ipcMain.on(COMMAND, this.onCommand);
    this.window.on("resize", () => this.layout());
    this.window.on("closed", () => {
      if (this.disposed) return;
      this.cleanup();
      this.notify(() => this.callbacks.closed());
    });
    void this.window.loadFile(toolbarPath).catch(() => this.setStatus("Browser toolbar failed to load"));
  }

  async createTab(url: string, taskOwned: boolean): Promise<number> {
    const target = validWebUrl(url);
    if (!target) throw new Error("Only HTTP(S) URLs without embedded credentials are allowed");
    if (this.disposed) throw new Error("Embedded browser is closed");
    const view = new WebContentsView({ webPreferences: {
      session: this.browsingSession, sandbox: true, nodeIntegration: false,
      contextIsolation: true, webSecurity: true, webviewTag: false,
      navigateOnDragDrop: false, allowRunningInsecureContent: false, disableDialogs: true,
      // Deliberately no preload. The website has no bridge into the application.
    } });
    const contents = view.webContents;
    const id = contents.id;
    const tab: Tab = { id, handle: randomUUID(), taskOwned, contents, view };
    this.entries.set(id, tab);
    // about:blank exists only as the initial, empty document. Every subsequent
    // navigation/redirect, including subframes and popup destinations, must be HTTP(S).
    contents.on("will-frame-navigate", event => {
      if (!validWebUrl(event.url)) { event.preventDefault(); this.setStatus("Blocked non-HTTP(S) navigation"); }
    });
    contents.on("will-navigate", (event, destination) => {
      if (!validWebUrl(destination)) event.preventDefault();
    });
    contents.on("will-redirect", (event, destination) => {
      if (!validWebUrl(destination)) { event.preventDefault(); this.setStatus("Blocked non-HTTP(S) redirect"); }
    });
    contents.setWindowOpenHandler(() => {
      // Deny all popups: recreating a URL as a tab loses POST bodies and opener
      // semantics. Manual navigation is not a substitute for popup/OAuth support.
      this.setStatus("Popup blocked. Open the destination manually in a new tab; popup-based sign-in may not work.");
      return { action: "deny" };
    });
    contents.on("did-navigate", () => this.publish());
    contents.on("did-navigate-in-page", () => this.publish());
    contents.on("page-title-updated", () => this.publish());
    contents.on("did-start-loading", () => this.publish());
    contents.on("did-stop-loading", () => this.publish());
    contents.on("render-process-gone", () => {
      this.setStatus("Tab renderer stopped. Reload to continue browsing.");
      this.notify(() => this.callbacks.detached(id));
    });
    contents.on("destroyed", () => this.removeTab(id));
    contents.on("before-input-event", (event, input) => {
      if ((input.control || input.meta) && input.key.toLowerCase() === "l") {
        event.preventDefault();
        this.window.webContents.focus();
        this.window.webContents.send("embedded-browser:focus-address");
      }
    });
    this.window.contentView.addChildView(view);
    this.selectTab(id);
    await this.load(tab, target);
    return id;
  }

  selectTab(id: number): void {
    if (this.disposed || !this.entries.has(id)) return;
    this.selected = id;
    for (const tab of this.entries.values()) tab.view.setVisible(tab.id === id);
    this.layout();
    this.entries.get(id)?.contents.focus();
    this.publish();
  }

  /** Called by the controller only after its active-session check and native consent. */
  approveTab(id: number): void {
    const tab = this.entries.get(id);
    if (this.disposed || !tab || tab.contents.isDestroyed()) return;
    tab.taskOwned = true;
    this.publish();
  }

  closeTab(id: number): void {
    const tab = this.entries.get(id);
    if (!tab) return;
    this.removeTab(id);
    if (!tab.contents.isDestroyed()) tab.contents.close({ waitForBeforeUnload: false });
  }

  tabs(): Array<{ id: number; handle: string; taskOwned: boolean; contents: WebContents }> {
    return [...this.entries.values()].map(({ id, handle, taskOwned, contents }) => ({ id, handle, taskOwned, contents }));
  }
  selectedId(): number | null { return this.selected; }
  show(): void { if (!this.disposed) { this.window.show(); this.window.focus(); } }
  setStatus(status: string): void { this.status = status; this.publish(); }
  destroy(): void {
    if (this.disposed) return;
    this.cleanup();
    this.window.destroy();
  }

  private readonly onDownload = (event: Electron.Event): void => {
    event.preventDefault();
    this.setStatus("Download blocked: saving files is not enabled in this browser");
  };

  private readonly onCommand = (event: IpcMainEvent, command: unknown, value: unknown): void => {
    if (this.disposed || event.sender !== this.window.webContents ||
        event.senderFrame !== this.window.webContents.mainFrame || event.senderFrame.url !== toolbarUrl) return;
    const tab = this.selected === null ? undefined : this.entries.get(this.selected);
    try {
      switch (command) {
        case "ready": this.publish(); break;
        case "approve":
          // A toolbar click only requests consent; it never grants ownership.
          if (tab && !tab.taskOwned && !tab.contents.isDestroyed()) {
            this.notify(() => this.callbacks.approveTab?.(tab.id));
          }
          break;
        case "stop":
          this.setStatus("Brian disconnected — manual browsing remains available");
          this.notify(() => this.callbacks.stop());
          break;
        case "new": void this.createTab(DEFAULT_URL, false).catch(() => this.setStatus("Could not create tab")); break;
        case "select": if (typeof value === "number") this.selectTab(value); break;
        case "close": if (typeof value === "number") this.closeTab(value); break;
        case "navigate": {
          const url = validWebUrl(value);
          if (!url) { this.setStatus("Enter a complete http:// or https:// address"); break; }
          if (tab) void this.load(tab, url);
          else void this.createTab(url, false).catch(() => this.setStatus("Could not create tab"));
          break;
        }
        case "back": if (tab?.contents.navigationHistory.canGoBack()) tab.contents.navigationHistory.goBack(); break;
        case "forward": if (tab?.contents.navigationHistory.canGoForward()) tab.contents.navigationHistory.goForward(); break;
        case "reload": tab?.contents.reload(); break;
      }
    } catch { this.setStatus("Browser action could not be completed"); }
  };

  private async load(tab: Tab, url: string): Promise<void> {
    try { await tab.contents.loadURL(url); }
    catch { if (this.entries.has(tab.id)) this.setStatus("Page could not be loaded (or navigation was cancelled)"); }
  }
  private layout(): void {
    if (this.disposed) return;
    const [width, height] = this.window.getContentSize();
    for (const tab of this.entries.values()) tab.view.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width, height: Math.max(0, height - TOOLBAR_HEIGHT) });
  }
  private publish(): void {
    if (this.disposed || this.window.webContents.isDestroyed()) return;
    this.window.webContents.send(STATE, {
      status: this.status, selected: this.selected,
      tabs: [...this.entries.values()].filter(tab => !tab.contents.isDestroyed()).map(tab => ({
        id: tab.id, title: tab.contents.getTitle() || "New tab", url: tab.contents.getURL(),
        taskOwned: tab.taskOwned, back: tab.contents.navigationHistory.canGoBack(),
        forward: tab.contents.navigationHistory.canGoForward(),
      })),
    });
  }
  private removeTab(id: number): void {
    const tab = this.entries.get(id);
    if (!tab) return;
    this.entries.delete(id);
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(tab.view);
    if (this.selected === id) {
      this.selected = null;
      const next = this.entries.keys().next().value;
      if (next !== undefined) this.selectTab(next);
    }
    this.publish();
    this.notify(() => this.callbacks.tabClosed(id));
  }
  private notify(callback: () => void): void {
    // Controller errors (including accidentally async callbacks) must not escape Electron events.
    try { void Promise.resolve(callback()).catch(() => this.setStatus("Browser callback failed")); }
    catch { this.setStatus("Browser callback failed"); }
  }
  private cleanup(): void {
    this.disposed = true;
    ipcMain.removeListener(COMMAND, this.onCommand);
    this.browsingSession.removeListener("will-download", this.onDownload);
    // Retain deny-by-default session policy even after the window closes.
    this.browsingSession.webRequest.onBeforeRequest(null);
    activeSessions.delete(this.browsingSession);
    const tabs = [...this.entries.values()];
    this.entries.clear();
    this.selected = null;
    for (const tab of tabs) if (!tab.contents.isDestroyed()) tab.contents.close({ waitForBeforeUnload: false });
  }
}
