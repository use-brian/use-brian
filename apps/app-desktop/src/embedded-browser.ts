import { createHash } from "node:crypto";
import { app, dialog, type BrowserWindow } from "electron";
import { join } from "node:path";
import { BrowserApprovals } from "./browser-approvals.js";
import { TabExecutor, ExecutorError, type ExecutorPlatform, type ExecutorTabUpdatedListener } from "@use-brian/browser-control/executor.js";
import { RelayClient, type WebSocketLike } from "@use-brian/browser-control/relay-client.js";
import type { LocalControlMode } from "@use-brian/browser-control/protocol.js";
import { EmbeddedBrowserHost } from "./embedded-browser-host.js";
import { parseBrowserTheme } from "./browser-theme.js";

export function browserUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 16_384) throw new Error("Invalid browser URL");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Only HTTP(S) URLs are supported");
  return url.href;
}

/** Parse claims ONLY to name storage. The relay, not this parser, authenticates the token. */
export function browserPairing(input: unknown, accountScope: string) {
  const value = input as { relayUrl?: unknown; pairingToken?: unknown } | null;
  if (!value || typeof value.relayUrl !== "string" || typeof value.pairingToken !== "string" || value.pairingToken.length > 8192) throw new Error("Invalid pairing request");
  const url = new URL(value.relayUrl);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "wss:" && !(url.protocol === "ws:" && loopback)) || url.username || url.password || url.hash || url.search) throw new Error("Use a secure relay (ws is allowed only on loopback)");
  const parts = value.pairingToken.split(".");
  if (parts.length !== 3) throw new Error("Invalid pairing token");
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as Record<string, unknown>;
  if (claims.kind !== "browser-ext-pair" || typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now() ||
      ![claims.userId, claims.workspaceId, claims.browserProfileId].every(v => typeof v === "string" && v.length > 0 && v.length < 256)) throw new Error("Invalid or expired pairing token");
  const key = createHash("sha256").update(JSON.stringify([accountScope, url.href, claims.userId, claims.workspaceId, claims.browserProfileId])).digest("hex");
  return { relayUrl: url.href, token: value.pairingToken, userId: claims.userId as string,
    workspaceId: claims.workspaceId as string, browserProfileId: claims.browserProfileId as string,
    partition: `persist:embedded-browser-${key}` };
}

type Command = { id: string; op: string; args: Record<string, unknown>; controlMode: LocalControlMode; controlEpoch?: number };
const text = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("Expected text");
  return value;
};

/** One explicitly approved, profile-scoped session. Tokens live only in main-process memory.
 * Restart/sign-out/switch requires fresh pairing credentials, but native profile consent persists.
 */
export class EmbeddedBrowser {
  private host: EmbeddedBrowserHost | null = null;
  private relay: RelayClient | null = null;
  private executor: TabExecutor | null = null;
  private generation = 0;
  private active = false;
  private pairing = false;
  private queue: Promise<void> = Promise.resolve();
  private cancelReady: (() => void) | null = null;
  private identity: { workspaceId: string; browserProfileId: string } | null = null;

  private automaticBlocked = false;
  // Keep only the approved control channel while the browser renderers are shut down.
  private partition: string | null = null;
  private commandEpoch: number | undefined;
  private uploadApproval: AbortController | null = null;
  private readonly approvals: Pick<BrowserApprovals, "has" | "grant">;

  constructor(private readonly options: {
    getDockWindow?: () => BrowserWindow | null;
    approvals?: Pick<BrowserApprovals, "has" | "grant">;
  } = {}) {
    this.approvals = options.approvals ?? new BrowserApprovals(() => join(app.getPath("userData"), "browser-approvals.json"));
  }

  show(): void {
    if (!this.host && this.partition && this.relay?.getState() === "ready") {
      this.generation++;
      this.startHost(this.partition);
    } else this.host?.show();
  }
  cancelPending(): void { if (this.pairing) this.dispose(); }
  setTheme(input: unknown): void {
    const theme = parseBrowserTheme(input);
    if (theme) this.host?.setTheme(theme);
  }

  isDockedFocused(): boolean { return this.host?.isDockedFocused() ?? false; }

  status(): { connected: boolean; automaticBlocked: boolean; controlEpoch: number; workspaceId?: string; browserProfileId?: string } {
    return { connected: this.active && this.relay?.getState() === "ready",
      automaticBlocked: this.automaticBlocked, controlEpoch: this.generation, ...this.identity };
  }

  async pair(input: unknown, accountScope: string): Promise<boolean> {
    if (this.pairing) return false;
    const pair = browserPairing(input, accountScope);
    const { automatic: auto, expectedControlEpoch } = input as { automatic?: unknown; expectedControlEpoch?: unknown };
    // An explicit Resume must not override a newer Stop while credentials were minted.
    if (expectedControlEpoch !== undefined && expectedControlEpoch !== this.generation) return false;
    const automatic = auto === true;
    if (automatic && (this.automaticBlocked || this.active)) return false;
    this.pairing = true;
    this.dispose();
    this.identity = { workspaceId: pair.workspaceId, browserProfileId: pair.browserProfileId };
    const generation = this.generation;
    try {
      if (!this.approvals.has(pair.partition)) {
        const answer = await dialog.showMessageBox({ type: "question", title: "Set up Brian Browser", message: "Allow this browser profile to start automatically?",
          detail: `Relay: ${new URL(pair.relayUrl).origin}\n\nBrian can read and interact with all in-app tabs, including tabs you open manually and sites you sign in to. This never grants access to your system browser or the Use Brian app. This browser has separate cookies from your normal browser. Approval is remembered for this account, relay and profile. Stop Brian closes all in-app browser tabs. The browser button or a new Brian navigation request can start it again. Webpage downloads (up to 32 MiB each) are held temporarily and can be read or saved to workspace files by Brian. Uploads use authorized workspace files (up to 4 MiB each) and require approval; websites may send them immediately upon selection. Temporary files are deleted when this browser closes. Protected credential filling is not supported. This replaces any browser already paired to this profile.`,
          buttons: ["Not now", "Allow automatic sessions"], defaultId: 0, cancelId: 0 });
        if (generation !== this.generation) return false;
        if (answer.response !== 1) { this.automaticBlocked = true; return false; }
      }
      let token = pair.token;
      let settle!: (ok: boolean) => void;
      const ready = new Promise<boolean>(resolve => { settle = resolve; });
      this.cancelReady = () => settle(false);
      const relay = new RelayClient({
        clientKind: "electron",
        getUrl: async () => pair.relayUrl,
        getToken: async () => token,
        connect: url => new WebSocket(url) as unknown as WebSocketLike,
        onSessionToken: async next => { token = next; },
        onStateChange: state => {
          if (this.relay !== relay) return;
          if (state === "ready") settle(true);
          else if (state === "unpaired" || state === "replaced") { settle(false); this.stop(); }
          else if (state === "disconnected") this.stop(false);
        },
        onCommand: cmd => {
          if (this.relay === relay) this.receive(cmd, this.generation);
        },
      });
      this.relay = relay;
      const timeout = setTimeout(() => settle(false), 15_000);
      relay.start();
      const connected = await ready;
      clearTimeout(timeout);
      this.cancelReady = null;
      if (!connected || generation !== this.generation) { if (generation === this.generation) this.dispose(); return false; }
      this.approvals.grant(pair.partition);
      this.startHost(pair.partition);
      return true;
    } catch {
      if (generation === this.generation) this.dispose();
      return false;
    } finally { this.pairing = false; }
  }

  private startHost(partition: string): void {
    const generation = this.generation;
    this.host = new EmbeddedBrowserHost(partition, {
      stop: () => { if (generation === this.generation) this.shutdown(); },
      closed: () => { if (generation === this.generation) this.dispose(); },
      tabClosed: id => {
        if (generation === this.generation && this.executor?.attachedTab() === id) {
          this.executor.onDetached(id); this.relay?.sendEvent("tab_closed");
        }
      },
      detached: id => {
        if (generation === this.generation && this.executor?.onDetached(id)) this.stop();
      },
    }, { dockWindow: this.options.getDockWindow?.() });
    this.partition = partition;
    this.automaticBlocked = false;
    this.active = true;
    this.executor = new TabExecutor(this.platform(generation));
    this.host.setStatus("");
    this.host.show();
  }

  /** Close every renderer, but retain the approved relay for an explicit new browser task. */
  private shutdown(): void { this.stop(true, true); }

  /** Synchronous revocation before any async detach. Queued/in-flight CDP calls are fenced. */
  stop(blockAutomatic = true, keepControlChannel = false): void {
    if (blockAutomatic) this.automaticBlocked = true;
    this.active = false;
    this.uploadApproval?.abort();
    this.uploadApproval = null;
    this.generation++;
    this.cancelReady?.();
    this.cancelReady = null;
    const relay = this.relay;
    if (!keepControlChannel) this.relay = null;
    this.commandEpoch = keepControlChannel ? this.generation : undefined;
    relay?.sendEvent("stopped", this.commandEpoch);
    if (!keepControlChannel) {
      relay?.stop();
      this.partition = null;
    }
    const executor = this.executor;
    this.executor = null;
    void executor?.detach().catch(() => undefined);
    // Detach directly too: adapter intentionally refuses all commands after revocation.
    for (const tab of this.host?.tabs() ?? []) {
      try {
        if (!tab.contents.isDestroyed()) {
          tab.contents.stop();
          if (tab.contents.debugger.isAttached()) tab.contents.debugger.detach();
        }
      } catch { /* A renderer/debugger can disappear during teardown; revocation still wins. */ }
    }
    const host = this.host;
    this.host = null;
    host?.destroy();
    this.queue = Promise.resolve();
  }

  dispose(preserveAutomaticBlock = false): void {
    this.stop(false);
    if (!preserveAutomaticBlock) this.automaticBlocked = false;
    this.identity = null;
  }

  private check(generation: number): void {
    if (!this.active || generation !== this.generation) throw new ExecutorError("Browser is stopped. Open it from Browsers or start a new navigation.", "user_stopped");
  }

  private platform(generation: number): ExecutorPlatform {
    const listeners = new Map<ExecutorTabUpdatedListener, Array<() => void>>();
    const contents = (id: number) => {
      this.check(generation);
      const tab = this.host?.tabs().find(t => t.id === id);
      if (!tab || tab.contents.isDestroyed()) throw new ExecutorError("Tab was closed", "tab_closed");
      return tab.contents;
    };
    return {
      debugger: {
        attach: async ({ tabId }, version) => {
          const wc = contents(tabId);
          if (!wc.debugger.isAttached()) wc.debugger.attach(version);
        },
        detach: async ({ tabId }) => { const wc = contents(tabId); if (wc.debugger.isAttached()) wc.debugger.detach(); },
        sendCommand: async ({ tabId }, method, params) => {
          // All page navigation, including takeover goto, passes this boundary.
          if (method === "Page.navigate") browserUrl(params?.url);
          const result = await contents(tabId).debugger.sendCommand(method, params);
          this.check(generation);
          return result;
        },
      },
      tabs: {
        get: async id => { const wc = contents(id); return { url: wc.getURL(), title: wc.getTitle(), status: wc.isLoading() ? "loading" : "complete" }; },
        onUpdated: {
          addListener: listener => {
            const cleanup: Array<() => void> = [];
            for (const tab of this.host?.tabs() ?? []) {
              const done = () => listener(tab.id, { status: "complete" });
              tab.contents.on("did-stop-loading", done);
              cleanup.push(() => { if (!tab.contents.isDestroyed()) tab.contents.removeListener("did-stop-loading", done); });
            }
            listeners.set(listener, cleanup);
          },
          removeListener: listener => { for (const cleanup of listeners.get(listener) ?? []) cleanup(); listeners.delete(listener); },
        },
      },
    };
  }

  private receive(cmd: Command, generation: number): void {
    const relay = this.relay;
    if (this.commandEpoch !== undefined && cmd.controlEpoch !== this.commandEpoch) {
      relay?.sendResult({ id: cmd.id, ok: false, error: "Command predates browser shutdown. Start a new navigation with an updated browser relay.", code: "user_stopped" });
      return;
    }
    if (cmd.op === "stop") { relay?.sendResult({ id: cmd.id, ok: true, data: { stopped: true } }); this.shutdown(); return; }
    // Follow-up reads/clicks from the stopped task must not reopen the browser.
    // Only a URL-bearing starter can create a fresh task session.
    if (!this.active && this.partition && (cmd.op === "navigate" || cmd.op === "openTab")) {
      try {
        browserUrl(cmd.args.url);
        generation = ++this.generation;
        this.startHost(this.partition);
      } catch (error) {
        relay?.sendResult({ id: cmd.id, ok: false, error: error instanceof Error ? error.message : "Could not start browser", code: "backend_error" });
        return;
      }
    }
    // Do not allow a delayed native approval to execute after relay timeout.
    const deadline = Date.now() + 20_000;
    this.queue = this.queue.then(async () => {
      try {
        this.check(generation);
        const data = await this.execute(cmd, generation, deadline);
        this.check(generation);
        relay?.sendResult({ id: cmd.id, ok: true, data });
      } catch (error) {
        if (generation !== this.generation) return;
        relay?.sendResult({ id: cmd.id, ok: false, error: error instanceof Error ? error.message : "Browser command failed", code: error instanceof ExecutorError ? error.code : "backend_error" });
      }
    });
  }

  private async execute(cmd: Command, generation: number, deadline = Date.now() + 20_000): Promise<unknown> {
    const host = this.host!;
    const executor = this.executor!;
    const { op, args } = cmd;
    // Both control modes cover this isolated host; taskOwned records creation source only.
    const eligible = () => host.tabs();
    const selection = (id: number) => { const t = host.tabs().find(t => t.id === id)!; return { tabId: t.handle, url: t.contents.getURL(), title: t.contents.getTitle() }; };
    if (op === "openTab") {
      const id = await host.createTab(browserUrl(args.url), true);
      this.check(generation);
      await executor.attach(id);
      return selection(id);
    }
    if (op === "listTabs") return { tabs: eligible().map(t => ({ id: t.handle, url: t.contents.getURL(), title: t.contents.getTitle(), taskOwned: t.taskOwned, active: t.id === host.selectedId() })), activeTabId: eligible().find(t => t.id === host.selectedId())?.handle ?? null };
    if (op === "switchTab" || op === "closeTab") {
      const tab = eligible().find(t => t.handle === args.tabId);
      if (!tab) throw new ExecutorError("Tab is not in this approved session", "no_eligible_tab");
      if (op === "closeTab") { if (executor.attachedTab() === tab.id) await executor.detach(); this.check(generation); host.closeTab(tab.id); return { closed: true, activeTabId: eligible().find(t => t.id === host.selectedId())?.handle ?? null }; }
      host.selectTab(tab.id);
      await executor.attach(tab.id);
      return selection(tab.id);
    }
    if (op === "listDownloads") return host.files.list();
    if (op === "readDownload") return host.files.read(text(args.id), args.offset);
    if (op === "browserFillReference") throw new ExecutorError("Protected credential filling is not supported by the in-app browser", "protected_fill_denied");
    const allowed = ["navigate", "snapshot", "click", "type", "fillForm", "currentUrl", "captureState", "captureFrame", "takeoverInput", "uploadFile"];
    if (!allowed.includes(op)) throw new ExecutorError("Unsupported browser operation", "backend_error");
    let tab = eligible().find(t => t.id === host.selectedId());
    if (!tab && op === "navigate") {
      const id = await host.createTab(browserUrl(args.url), true);
      this.check(generation);
      tab = eligible().find(t => t.id === id);
      await executor.attach(id);
      return { url: tab!.contents.getURL() };
    }
    if (!tab) throw new ExecutorError("Open or select an in-app tab first", "no_eligible_tab");
    await executor.attach(tab.id);
    this.check(generation);
    switch (op) {
      case "navigate": return executor.navigate(browserUrl(args.url));
      case "snapshot": return executor.snapshot(args.mode === "full" ? "full" : "interactive");
      case "click": await executor.click(text(args.ref)); return {};
      case "type": await executor.type(text(args.ref), text(args.text)); return {};
      case "fillForm": return executor.fillForm(args);
      case "uploadFile": {
        const ref = text(args.ref);
        const name = text(args.name);
        const data = text(args.data);
        const url = tab.contents.getURL();
        const tabId = tab.id;
        if (Date.now() >= deadline) throw new ExecutorError("Upload approval expired; retry the upload.", "user_denied");
        const approval = new AbortController();
        this.uploadApproval = approval;
        const timer = setTimeout(() => approval.abort(), deadline - Date.now());
        let answer: Electron.MessageBoxReturnValue;
        try {
          answer = await dialog.showMessageBox({ type: "question", title: "Upload a workspace file?",
            message: `Send ${name.slice(0, 200)} to ${new URL(browserUrl(url)).origin}?`,
            detail: "The website can read or upload this file immediately after selection, without a Submit click. Approve only a file and destination you intended. Approval expires after 20 seconds.",
            buttons: ["Cancel", "Upload file"], defaultId: 0, cancelId: 0, signal: approval.signal });
        } finally {
          clearTimeout(timer);
          if (this.uploadApproval === approval) this.uploadApproval = null;
        }
        this.check(generation);
        if (answer.response !== 1 || approval.signal.aborted) throw new ExecutorError("File upload was not approved", "user_denied");
        const unchanged = () => {
          this.check(generation);
          if (Date.now() >= deadline || host.selectedId() !== tabId || tab!.contents.isDestroyed() || tab!.contents.getURL() !== url) {
            throw new ExecutorError("Upload destination changed. Take a fresh browserSnapshot and approve again.", "stale_ref");
          }
        };
        unchanged();
        const path = await host.files.stageUpload(name, data);
        unchanged();
        await executor.uploadFile(ref, path);
        return {};
      }
      case "currentUrl": return executor.currentUrl();
      case "captureFrame": return executor.captureFrame();
      case "captureState": {
        const site = text(args.site);
        const answer = await dialog.showMessageBox({ type: "question", message: `Share saved sign-in state for ${site}?`, detail: "This sends this site's cookies and local storage to Brian for use outside this browser. Only approve a request you initiated.", buttons: ["Cancel", "Share sign-in state"], defaultId: 0, cancelId: 0 });
        this.check(generation);
        if (answer.response !== 1) throw new ExecutorError("Sign-in state export was not approved", "user_denied");
        return executor.captureState(site);
      }
      case "takeoverInput": {
        const event = args.event as Parameters<TabExecutor["takeoverInput"]>[0];
        if (!event || !["click", "pointer", "key", "scroll", "navigate"].includes(event.kind)) throw new Error("Invalid input event");
        if (event.kind === "navigate" && event.action === "goto") browserUrl(event.url);
        await executor.takeoverInput(event); return {};
      }
    }
  }
}
