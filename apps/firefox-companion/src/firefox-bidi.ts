/**
 * Fixed-vocabulary WebDriver BiDi executor for Firefox My Browser.
 * It is deliberately not a generic protocol proxy.
 * [COMP:ext/firefox-companion]
 */
import WebSocket from "ws";

export class FirefoxBidiError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "FirefoxBidiError";
  }
}

type BidiSocket = {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open", listener: () => void, opts?: { once?: boolean }): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "error", listener: () => void, opts?: { once?: boolean }): void;
};

type BidiSocketFactory = (url: string) => BidiSocket;
type BidiResponse = { id?: number; result?: unknown; error?: string; message?: string };
type BrowsingContextInfo = { context: string; url?: string; children?: BrowsingContextInfo[] | null };
type SnapshotNode = {
  ref: string;
  role: string;
  name: string;
  value?: string;
  disabled?: boolean;
};

type StoredRef = { context: string; sharedId: string };
const BIDI_COMMAND_TIMEOUT_MS = 30_000;

const SNAPSHOT_FUNCTION = String.raw`() => {
  const roles = new Set([
    "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio",
    "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "switch", "slider",
    "spinbutton", "option", "listbox"
  ]);
  const implicitRole = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return el.multiple ? "listbox" : "combobox";
    if (tag !== "input") return "";
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (["button", "submit", "reset", "image"].includes(type)) return "button";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "range") return "slider";
    if (type === "number") return "spinbutton";
    if (type === "search") return "searchbox";
    if (["hidden", "file"].includes(type)) return "";
    return "textbox";
  };
  const nameOf = (el) => {
    const aria = (el.getAttribute("aria-label") || "").trim();
    if (aria) return aria;
    const labelled = (el.getAttribute("aria-labelledby") || "").trim();
    if (labelled) {
      const text = labelled.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ").trim();
      if (text) return text;
    }
    if (el.labels?.length) {
      const text = Array.from(el.labels).map((label) => label.textContent || "").join(" ").trim();
      if (text) return text;
    }
    return (el.getAttribute("alt") || el.getAttribute("title") || el.getAttribute("placeholder") || el.textContent || "")
      .replace(/\s+/g, " ").trim().slice(0, 500);
  };
  const visible = (el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  const nodes = [];
  for (const el of document.querySelectorAll("a,button,input,textarea,select,[role],[tabindex],[contenteditable='true']")) {
    if (nodes.length >= 1000) break;
    if (!visible(el)) continue;
    const role = (el.getAttribute("role") || implicitRole(el) || (el.isContentEditable ? "textbox" : "")).toLowerCase();
    const focusable = el.tabIndex >= 0 || el.isContentEditable;
    if (!roles.has(role) && !focusable) continue;
    const name = nameOf(el);
    if (!name && !roles.has(role)) continue;
    const isPassword = el instanceof HTMLInputElement && el.type.toLowerCase() === "password";
    const value = !isPassword && "value" in el && typeof el.value === "string" ? el.value.slice(0, 500) : "";
    nodes.push({
      role: role || "node",
      name,
      ...(value ? { value } : {}),
      ...(el.matches(":disabled,[aria-disabled='true']") ? { disabled: true } : {}),
      element: el
    });
  }
  return { url: location.href, title: document.title, nodes };
}`;

function decodeRemoteValue(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const remote = value as { type?: string; value?: unknown };
  if (remote.type === "undefined") return undefined;
  if (remote.type === "null") return null;
  if (remote.type === "node") {
    const sharedId = (remote as { sharedId?: unknown }).sharedId;
    return typeof sharedId === "string" ? { $sharedId: sharedId } : null;
  }
  if (["string", "boolean", "number", "bigint"].includes(remote.type ?? "")) return remote.value;
  if (remote.type === "array" && Array.isArray(remote.value)) {
    return remote.value.map((entry) => decodeRemoteValue(entry));
  }
  if (remote.type === "object" && Array.isArray(remote.value)) {
    return Object.fromEntries(
      remote.value
        .filter((entry): entry is [unknown, unknown] => Array.isArray(entry) && entry.length === 2)
        .map(([key, entry]) => [String(decodeRemoteValue(key)), decodeRemoteValue(entry)]),
    );
  }
  return remote.value;
}

function flattenContexts(contexts: readonly BrowsingContextInfo[]): BrowsingContextInfo[] {
  const flattened: BrowsingContextInfo[] = [];
  for (const context of contexts) {
    flattened.push(context);
    if (context.children) flattened.push(...flattenContexts(context.children));
  }
  return flattened;
}

function topLevelContexts(result: unknown): BrowsingContextInfo[] {
  const contexts = (result as { contexts?: unknown } | null)?.contexts;
  return Array.isArray(contexts)
    ? contexts.filter(
        (context): context is BrowsingContextInfo =>
          Boolean(context) && typeof context === "object" && typeof (context as BrowsingContextInfo).context === "string",
      )
    : [];
}

export class FirefoxBidiExecutor {
  private socket: BidiSocket | null = null;
  private nextId = 0;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private contextId: string | null = null;
  private refs = new Map<string, StoredRef>();

  constructor(
    private readonly url: string,
    private readonly createSocket: BidiSocketFactory = (url) => new WebSocket(url) as unknown as BidiSocket,
  ) {}

  async connect(): Promise<void> {
    if (this.socket) return;
    const socket = this.createSocket(this.url);
    this.socket = socket;
    socket.addEventListener("message", (event) => this.onMessage(event.data));
    socket.addEventListener("close", () => this.onClosed());
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new FirefoxBidiError("Could not connect to Firefox.", "detached")), {
        once: true,
      });
    });
    await this.command("session.new", { capabilities: { alwaysMatch: {} } });
  }

  private onMessage(raw: unknown): void {
    if (typeof raw !== "string") return;
    let response: BidiResponse;
    try {
      response = JSON.parse(raw) as BidiResponse;
    } catch {
      return;
    }
    if (typeof response.id !== "number") return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.error) {
      pending.reject(new FirefoxBidiError(response.message ?? response.error, "backend_error"));
    } else {
      pending.resolve(response.result);
    }
  }

  private onClosed(): void {
    this.socket = null;
    this.contextId = null;
    this.refs.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new FirefoxBidiError("Firefox ended the browser-control session.", "detached"));
    }
    this.pending.clear();
  }

  private command(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.socket) return Promise.reject(new FirefoxBidiError("Firefox is not connected.", "detached"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new FirefoxBidiError(`Firefox timed out while running ${method}.`, "backend_error"));
      }, BIDI_COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.socket?.send(JSON.stringify({ id, method, params }));
    });
  }

  private async getTree(): Promise<BrowsingContextInfo[]> {
    return topLevelContexts(await this.command("browsingContext.getTree", { maxDepth: 8 }));
  }

  async bindFocusedContext(expected?: { url?: string; title?: string }): Promise<{ bound: true }> {
    const contexts = await this.getTree();
    const candidates = contexts.filter((context) => !expected?.url || context.url === expected.url);
    const focusedMatches: Array<{ context: BrowsingContextInfo; title: string }> = [];
    for (const context of candidates) {
      const evaluated = (await this.command("script.evaluate", {
        expression: "({ focused: document.hasFocus(), title: document.title })",
        target: { context: context.context },
        awaitPromise: false,
        resultOwnership: "none",
        serializationOptions: { maxObjectDepth: 1 },
      })) as { type?: string; result?: unknown };
      if (evaluated.type !== "success") continue;
      const state = decodeRemoteValue(evaluated.result) as { focused?: unknown; title?: unknown };
      const title = typeof state?.title === "string" ? state.title : "";
      if (state?.focused === true) {
        focusedMatches.push({ context, title });
      }
    }
    if (focusedMatches.length === 1) {
      this.contextId = focusedMatches[0].context.context;
      this.refs.clear();
      return { bound: true };
    }
    throw new FirefoxBidiError(
      "The approved Firefox tab could not be matched. Focus the tab you want Use Brian to control and allow it again.",
      "no_eligible_tab",
    );
  }

  private mustContext(): string {
    if (!this.contextId) {
      throw new FirefoxBidiError("No Firefox tab has been approved for this task.", "consent_denied");
    }
    return this.contextId;
  }

  private async callFunction(
    functionDeclaration: string,
    args: unknown[] = [],
    resultOwnership: "none" | "root" = "none",
  ): Promise<{ type?: string; result?: unknown }> {
    return (await this.command("script.callFunction", {
      functionDeclaration,
      target: { context: this.mustContext() },
      arguments: args.map((value) => ({ type: "string", value: String(value) })),
      awaitPromise: true,
      resultOwnership,
      serializationOptions: { maxObjectDepth: 8, maxDomDepth: 0 },
    })) as { type?: string; result?: unknown };
  }

  async execute(op: string, args: Record<string, unknown>): Promise<unknown> {
    switch (op) {
      case "navigate":
        return this.navigate(String(args.url ?? ""));
      case "snapshot":
        return this.snapshot();
      case "click":
        await this.click(String(args.ref ?? ""));
        return { clicked: true };
      case "type":
        await this.type(String(args.ref ?? ""), String(args.text ?? ""));
        return { typed: true };
      case "currentUrl":
        return this.currentUrl();
      case "captureFrame":
        return this.captureFrame();
      case "takeoverInput":
        await this.takeoverInput(args.event as Record<string, unknown>);
        return { forwarded: true };
      default:
        throw new FirefoxBidiError(`Unknown browser operation ${op}.`, "backend_error");
    }
  }

  private async navigate(url: string): Promise<{ url: string }> {
    if (!/^https?:\/\//i.test(url)) {
      throw new FirefoxBidiError("My Browser navigation accepts only http(s) URLs.", "backend_error");
    }
    this.refs.clear();
    const result = (await this.command("browsingContext.navigate", {
      context: this.mustContext(),
      url,
      wait: "complete",
    })) as { url?: unknown };
    return { url: typeof result.url === "string" ? result.url : url };
  }

  private async snapshot(): Promise<{ url: string; title: string; nodes: SnapshotNode[] }> {
    const context = this.mustContext();
    const response = await this.callFunction(SNAPSHOT_FUNCTION);
    if (response.type !== "success") {
      throw new FirefoxBidiError("Firefox could not read this page.", "backend_error");
    }
    const decoded = decodeRemoteValue(response.result) as {
      url?: unknown;
      title?: unknown;
      nodes?: Array<Record<string, unknown>>;
    };
    this.refs.clear();
    const nodes: SnapshotNode[] = [];
    for (const raw of Array.isArray(decoded?.nodes) ? decoded.nodes : []) {
      const sharedId = (raw.element as { $sharedId?: unknown } | undefined)?.$sharedId;
      if (typeof sharedId !== "string" || typeof raw.role !== "string" || typeof raw.name !== "string") continue;
      const ref = `@e${nodes.length + 1}`;
      this.refs.set(ref, { context, sharedId });
      nodes.push({
        ref,
        role: raw.role,
        name: raw.name,
        ...(typeof raw.value === "string" && raw.value ? { value: raw.value } : {}),
        ...(raw.disabled === true ? { disabled: true } : {}),
      });
    }
    return {
      url: typeof decoded?.url === "string" ? decoded.url : "",
      title: typeof decoded?.title === "string" ? decoded.title : "",
      nodes,
    };
  }

  private resolveRef(ref: string): StoredRef {
    const stored = this.refs.get(ref);
    if (!stored || stored.context !== this.mustContext()) {
      throw new FirefoxBidiError(
        `Unknown ref ${ref}; refs are valid for the latest snapshot only. Take a fresh browserSnapshot.`,
        "stale_ref",
      );
    }
    return stored;
  }

  private sharedNode(ref: string): { sharedId: string } {
    const stored = this.resolveRef(ref);
    return { sharedId: stored.sharedId };
  }

  private async click(ref: string): Promise<void> {
    const element = this.sharedNode(ref);
    try {
      await this.command("input.performActions", {
        context: this.mustContext(),
        actions: [
          {
            type: "pointer",
            id: "use-brian-mouse",
            parameters: { pointerType: "mouse" },
            actions: [
              { type: "pointerMove", x: 0, y: 0, duration: 0, origin: { type: "element", element } },
              { type: "pointerDown", button: 0 },
              { type: "pointerUp", button: 0 },
            ],
          },
        ],
      });
    } catch (error) {
      if (error instanceof FirefoxBidiError && /node|element|reference|stale/i.test(error.message)) {
        throw new FirefoxBidiError(`Ref ${ref} is no longer on the page. Take a fresh browserSnapshot.`, "stale_ref");
      }
      throw error;
    }
  }

  private async type(ref: string, text: string): Promise<void> {
    await this.click(ref);
    await this.command("input.performActions", {
      context: this.mustContext(),
      actions: [
        {
          type: "key",
          id: "use-brian-keyboard",
          actions: Array.from(text).flatMap((value) => [
            { type: "keyDown", value },
            { type: "keyUp", value },
          ]),
        },
      ],
    });
  }

  private async currentUrl(): Promise<{ url: string; title: string }> {
    const contextId = this.mustContext();
    const context = flattenContexts(await this.getTree()).find((candidate) => candidate.context === contextId);
    if (!context) {
      this.contextId = null;
      this.refs.clear();
      throw new FirefoxBidiError("The approved Firefox tab was closed.", "tab_closed");
    }
    const titleResponse = await this.callFunction("() => document.title");
    return {
      url: context.url ?? "",
      title: typeof decodeRemoteValue(titleResponse.result) === "string" ? String(decodeRemoteValue(titleResponse.result)) : "",
    };
  }

  private async captureFrame(): Promise<{ data: string; mimeType: string }> {
    const result = (await this.command("browsingContext.captureScreenshot", {
      context: this.mustContext(),
      origin: "viewport",
      format: { type: "image/jpeg", quality: 0.55 },
    })) as { data?: unknown };
    if (typeof result.data !== "string" || !result.data) {
      throw new FirefoxBidiError("Firefox returned an empty browser frame.", "backend_error");
    }
    return { data: result.data, mimeType: "image/jpeg" };
  }

  private async takeoverInput(event: Record<string, unknown>): Promise<void> {
    const context = this.mustContext();
    if (event.kind === "click" || event.kind === "pointer") {
      const x = Number(event.x);
      const y = Number(event.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new FirefoxBidiError("Invalid Take-Over click coordinates.", "backend_error");
      }
      const viewportResult = await this.callFunction("() => ({ width: window.innerWidth, height: window.innerHeight })");
      const viewport = decodeRemoteValue(viewportResult.result) as { width?: unknown; height?: unknown };
      const frameW = Number(event.frameW);
      const frameH = Number(event.frameH);
      const px = frameW > 0 && typeof viewport.width === "number" ? (x * viewport.width) / frameW : x;
      const py = frameH > 0 && typeof viewport.height === "number" ? (y * viewport.height) / frameH : y;
      const actions: Array<Record<string, unknown>> = [
        { type: "pointerMove", x: Math.round(px), y: Math.round(py), duration: 0, origin: "viewport" },
      ];
      if (event.kind === "click" || event.action === "down") actions.push({ type: "pointerDown", button: 0 });
      if (event.kind === "click" || event.action === "up") actions.push({ type: "pointerUp", button: 0 });
      await this.command("input.performActions", {
        context,
        actions: [{
          type: "pointer",
          id: "use-brian-takeover-mouse",
          parameters: { pointerType: "mouse" },
          actions,
        }],
      });
      return;
    }
    if (event.kind === "key") {
      const raw = String(event.text ?? "");
      const named: Record<string, string> = {
        Enter: "\uE007", Tab: "\uE004", Backspace: "\uE003", Delete: "\uE017",
        Escape: "\uE00C", ArrowLeft: "\uE012", ArrowUp: "\uE013",
        ArrowRight: "\uE014", ArrowDown: "\uE015", Home: "\uE011", End: "\uE010",
        PageUp: "\uE00E", PageDown: "\uE00F",
      };
      const value = raw.length === 1 ? raw : named[raw];
      if (!value) return;
      await this.command("input.performActions", {
        context,
        actions: [{
          type: "key",
          id: "use-brian-takeover-keyboard",
          actions: [{ type: "keyDown", value }, { type: "keyUp", value }],
        }],
      });
      return;
    }
    if (event.kind === "scroll") {
      const deltaY = Number(event.deltaY);
      if (!Number.isFinite(deltaY)) {
        throw new FirefoxBidiError("Invalid Take-Over scroll distance.", "backend_error");
      }
      await this.command("input.performActions", {
        context,
        actions: [{
          type: "wheel",
          id: "use-brian-takeover-wheel",
          actions: [{ type: "scroll", x: 0, y: 0, deltaX: 0, deltaY: Math.round(deltaY), duration: 0, origin: "viewport" }],
        }],
      });
      return;
    }
    if (event.kind !== "navigate") {
      throw new FirefoxBidiError("Invalid Take-Over input event.", "backend_error");
    }
    const action = String(event.action ?? "");
    if (action === "reload") {
      await this.command("browsingContext.reload", { context, wait: "complete" });
    } else if (action === "goto") {
      const url = String(event.url ?? "");
      if (!/^https?:\/\//i.test(url)) {
        throw new FirefoxBidiError("Take-Over navigation accepts only http(s) URLs.", "backend_error");
      }
      this.refs.clear();
      await this.command("browsingContext.navigate", { context, url, wait: "complete" });
    } else if (action === "back" || action === "forward") {
      await this.command("browsingContext.traverseHistory", { context, delta: action === "back" ? -1 : 1 });
    } else {
      throw new FirefoxBidiError("Invalid Take-Over navigation action.", "backend_error");
    }
  }

  async stop(): Promise<void> {
    if (!this.socket) return;
    try {
      if (this.contextId) {
        await this.command("input.releaseActions", { context: this.contextId });
      }
      await this.command("session.end", {});
    } catch {
      // Firefox may already have exited.
    }
    this.contextId = null;
    this.refs.clear();
    this.socket?.close();
    this.socket = null;
  }
}

export const firefoxBidiInternals = {
  decodeRemoteValue,
  flattenContexts,
  topLevelContexts,
  snapshotFunction: SNAPSHOT_FUNCTION,
};
