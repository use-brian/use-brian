import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BaseWindow, type BrowserWindow, WebContentsView, ipcMain, session, type WebContents, type IpcMainEvent, type Session, type View } from "electron";

const COMMAND = "embedded-browser:command";
const STATE = "embedded-browser:state";
const TOOLBAR_HEIGHT = 128;
const DEFAULT_URL = "https://www.google.com/";
const toolbarPath = fileURLToPath(new URL("./embedded-browser.html", import.meta.url));
const toolbarUrl = pathToFileURL(toolbarPath).href;
const activeSessions = new WeakSet<Session>();

// Navigation/redirect/network boundaries remain strict. Only typed addresses get a default scheme.
function validWebUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** Normalize human-entered addresses without permitting explicit unsafe schemes. */
export function browserAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const address = value.trim();
  if (!address || address.length > 16_384 || /[\s\\]/.test(address)) return null;
  const hostPort = /^(?:localhost|(?:[^/?#:\s]+\.)+[^/?#:\s]+):\d+(?:[/?#]|$)/i.test(address);
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(address);
  if (address.startsWith("//")) return validWebUrl(`https:${address}`);
  if (address.startsWith("/")) return null;
  return validWebUrl(hasScheme && !hostPort ? address : `https://${address}`);
}

type Callbacks = { stop: () => void; closed: () => void; tabClosed: (id: number) => void; detached: (id: number) => void };
type Tab = { id: number; handle: string; taskOwned: boolean; contents: WebContents; view: WebContentsView };

/** Owns an exclusive persistent browsing partition; never use an app deployment partition. */
export class EmbeddedBrowserHost {
  private readonly toolbar: WebContentsView;
  private readonly dockWindow: BrowserWindow | null;
  // Retain event emitters: reading native BrowserWindow properties from its
  // closed callback is unsafe after Electron has destroyed the window.
  private readonly dockContents: WebContents | null;
  private readonly dockContentView: View | null;
  private detachedWindow: BaseWindow | null = null;
  private owner!: BaseWindow;
  private docked: boolean;
  private userCollapsed = false;
  private collapsed = false;
  private preferredWidth = 480;
  private panelWidth = 480;
  private maxWidth = 480;
  private readonly browsingSession: Session;
  private readonly entries = new Map<number, Tab>();
  private selected: number | null = null;
  private status = "";
  private disposed = false;

  constructor(partition: string, private readonly callbacks: Callbacks, options: { dockWindow?: BrowserWindow | null } = {}) {
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
    this.dockWindow = options.dockWindow && !options.dockWindow.isDestroyed() ? options.dockWindow : null;
    this.docked = !!this.dockWindow;
    this.dockContents = this.dockWindow?.webContents ?? null;
    this.dockContentView = this.dockWindow?.contentView ?? null;
    this.toolbar = new WebContentsView({
      webPreferences: {
        preload: fileURLToPath(new URL("./embedded-browser-preload.cjs", import.meta.url)),
        partition: `embedded-toolbar-${randomUUID()}`,
        sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true,
        webviewTag: false, navigateOnDragDrop: false,
      },
    });
    const toolbar = this.toolbar.webContents;
    toolbar.setZoomFactor(1);
    void toolbar.setVisualZoomLevelLimits(1, 1).catch(() => {});
    toolbar.on("zoom-changed", () => toolbar.setZoomFactor(1));
    toolbar.session.on("will-download", this.onDownload);
    this.owner = this.dockWindow ?? this.getDetachedWindow();
    this.owner.contentView.addChildView(this.toolbar);
    this.dockWindow?.on("resize", this.onLayout);
    // Native content bounds also change on programmatic resize/menu/fullscreen
    // transitions that do not consistently emit window resize on every platform.
    this.dockContentView?.on("bounds-changed", this.onLayout);
    this.dockWindow?.on("closed", this.onMainClosed);
    this.dockContents?.on("did-finish-load", this.onLayout);
    this.dockContents?.on("dom-ready", this.onLayout);
    toolbar.session.setPermissionRequestHandler((_wc, _permission, reply) => reply(false));
    toolbar.session.setPermissionCheckHandler(() => false);
    toolbar.session.setDevicePermissionHandler(() => false);
    toolbar.setWindowOpenHandler(() => ({ action: "deny" }));
    toolbar.on("will-navigate", event => event.preventDefault());
    toolbar.on("will-frame-navigate", event => event.preventDefault());
    toolbar.on("will-redirect", event => event.preventDefault());
    toolbar.on("did-finish-load", () => this.publish());
    ipcMain.on(COMMAND, this.onCommand);
    this.layout();
    void toolbar.loadFile(toolbarPath).catch(() => this.setStatus("Browser toolbar failed to load"));
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
        this.toolbar.webContents.focus();
        this.toolbar.webContents.send("embedded-browser:focus-address");
      }
    });
    this.owner.contentView.addChildView(view);
    this.selectTab(id);
    await this.load(tab, target);
    return id;
  }

  selectTab(id: number): void {
    if (this.disposed || !this.entries.has(id)) return;
    this.selected = id;
    this.layout();
    if (!this.collapsed) this.entries.get(id)?.contents.focus();
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
  show(): void {
    if (this.disposed) return;
    this.userCollapsed = false;
    this.layout();
    this.owner.show();
    this.focusBrowser();
  }
  focusBrowser(): void {
    if (this.disposed) return;
    this.owner.focus();
    const tab = this.selected === null ? undefined : this.entries.get(this.selected);
    if (!this.collapsed && tab) tab.contents.focus();
    else this.toolbar.webContents.focus();
  }
  isDockedFocused(): boolean {
    return !this.disposed && this.docked && (this.toolbar.webContents.isFocused() ||
      (!this.collapsed && [...this.entries.values()].some(tab => tab.id === this.selected && !tab.contents.isDestroyed() && tab.contents.isFocused())));
  }
  setStatus(status: string): void { this.status = status; this.publish(); }
  destroy(): void {
    if (this.disposed) return;
    this.cleanup();
  }

  private readonly onDownload = (event: Electron.Event): void => {
    event.preventDefault();
    this.setStatus("Download blocked: saving files is not enabled in this browser");
  };

  private readonly onCommand = (event: IpcMainEvent, command: unknown, value: unknown): void => {
    if (this.disposed || event.sender !== this.toolbar.webContents ||
        event.senderFrame !== this.toolbar.webContents.mainFrame || event.senderFrame.url !== toolbarUrl) return;
    const tab = this.selected === null ? undefined : this.entries.get(this.selected);
    try {
      switch (command) {
        case "detach": this.move(false); break;
        case "dock": this.move(true); break;
        case "collapse": this.userCollapsed = true; this.layout(); break;
        case "expand": this.userCollapsed = false; this.layout(); break;
        case "resize":
          if (this.docked && value && typeof value === "object" &&
              Object.keys(value).length === 1 && "width" in value &&
              typeof value.width === "number" && Number.isFinite(value.width)) {
            this.preferredWidth = Math.round(Math.max(360, Math.min(this.maxWidth, value.width)));
            this.layout();
          }
          break;
        case "ready": this.publish(); break;
        case "stop":
          this.notify(() => this.callbacks.stop());
          break;
        case "new": void this.createTab(DEFAULT_URL, false).catch(() => this.setStatus("Could not create tab")); break;
        case "select": if (typeof value === "number") this.selectTab(value); break;
        case "close": if (typeof value === "number") this.closeTab(value); break;
        case "navigate": {
          const url = browserAddress(value);
          if (!url) { this.setStatus("Cannot open this address"); break; }
          this.setStatus("");
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
  private readonly onLayout = (): void => this.layout();
  private readonly onMainClosed = (): void => {
    if (this.disposed) return;
    this.cleanup();
    this.notify(() => this.callbacks.closed());
  };
  private readonly onDetachedClose = (event: Electron.Event): void => {
    if (this.disposed) return;
    if (this.dockWindow && !this.dockWindow.isDestroyed()) {
      event.preventDefault();
      this.move(true);
    } else {
      this.cleanup();
      this.notify(() => this.callbacks.closed());
    }
  };
  private getDetachedWindow(): BaseWindow {
    if (!this.detachedWindow) {
      this.detachedWindow = new BaseWindow({ width: 480, height: 850, minWidth: 360,
        minHeight: 240, show: false, title: "Brian Browser", autoHideMenuBar: true });
      this.detachedWindow.on("resize", this.onLayout);
      this.detachedWindow.contentView.on("bounds-changed", this.onLayout);
      this.detachedWindow.on("close", this.onDetachedClose);
    }
    return this.detachedWindow;
  }
  private move(docked: boolean): void {
    if (this.disposed || docked === this.docked || (docked && (!this.dockWindow || this.dockWindow.isDestroyed()))) return;
    const next = docked ? this.dockWindow! : this.getDetachedWindow();
    for (const view of [this.toolbar, ...[...this.entries.values()].map(tab => tab.view)]) {
      this.owner.contentView.removeChildView(view);
      next.contentView.addChildView(view);
    }
    this.owner = next;
    this.docked = docked;
    if (docked) this.detachedWindow?.hide();
    this.layout();
    this.owner.show();
    this.focusBrowser();
  }
  public publishDockLayout(): void {
    if (!this.dockWindow || this.dockWindow.isDestroyed() || this.dockWindow.webContents.isDestroyed()) return;
    const [contentWidth] = this.dockWindow.getContentSize();
    this.dockWindow.webContents.send("embedded-browser:dock-layout", {
      reservedWidth: !this.disposed && this.docked ? this.panelWidth : 0, contentWidth,
    });
  }
  private layout(): void {
    if (this.disposed) return;
    const [width, height] = this.owner.getContentSize();
    this.maxWidth = this.docked ? Math.max(360, width - 640) : width;
    this.collapsed = this.docked && (this.userCollapsed || width < 1000);
    this.panelWidth = this.docked ? (this.collapsed ? 56 : Math.min(this.maxWidth, this.preferredWidth)) : width;
    const x = this.docked ? Math.max(0, width - this.panelWidth) : 0;
    this.toolbar.setBounds({ x, y: 0, width: this.panelWidth, height });
    for (const tab of this.entries.values()) {
      tab.view.setVisible(!this.collapsed && tab.id === this.selected);
      // Collapsing hides the view, not its page layout. Keep a usable viewport
      // for background automation instead of squeezing the site into the rail.
      const pageWidth = this.collapsed ? Math.min(this.maxWidth, this.preferredWidth) : this.panelWidth;
      tab.view.setBounds({ x: x + 8, y: TOOLBAR_HEIGHT, width: Math.max(0, pageWidth - 8), height: Math.max(0, height - TOOLBAR_HEIGHT) });
    }
    this.publishDockLayout();
    this.publish();
  }
  private publish(): void {
    if (this.disposed || this.toolbar.webContents.isDestroyed()) return;
    this.toolbar.webContents.send(STATE, {
      status: this.status, selected: this.selected,
      presentation: { mode: this.docked ? "docked" : "detached", collapsed: this.collapsed,
        panelWidth: this.panelWidth, minWidth: 360, maxWidth: this.maxWidth },
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
    if (!this.owner.isDestroyed()) this.owner.contentView.removeChildView(tab.view);
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
    this.publishDockLayout();
    this.dockWindow?.removeListener("resize", this.onLayout);
    this.dockContentView?.removeListener("bounds-changed", this.onLayout);
    this.dockWindow?.removeListener("closed", this.onMainClosed);
    this.dockContents?.removeListener("did-finish-load", this.onLayout);
    this.dockContents?.removeListener("dom-ready", this.onLayout);
    this.toolbar.webContents.session.removeListener("will-download", this.onDownload);
    if (!this.owner.isDestroyed()) {
      this.owner.contentView.removeChildView(this.toolbar);
      for (const tab of this.entries.values()) this.owner.contentView.removeChildView(tab.view);
    }
    if (!this.toolbar.webContents.isDestroyed()) this.toolbar.webContents.close({ waitForBeforeUnload: false });
    if (this.detachedWindow) {
      this.detachedWindow.removeListener("resize", this.onLayout);
      this.detachedWindow.contentView.removeListener("bounds-changed", this.onLayout);
      this.detachedWindow.removeListener("close", this.onDetachedClose);
      if (!this.detachedWindow.isDestroyed()) this.detachedWindow.destroy();
    }
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
