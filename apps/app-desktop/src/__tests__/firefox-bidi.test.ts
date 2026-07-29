import { describe, expect, it } from "vitest";
import { FirefoxBidiExecutor, FirefoxBidiError, firefoxBidiInternals } from "../firefox-bidi.js";

type Listener = (...args: any[]) => void;

function remote(value: unknown): unknown {
  if (value === null) return { type: "null" };
  if (typeof value === "object" && (value as { __node?: unknown }).__node === true) {
    return { type: "node", sharedId: "node-1" };
  }
  if (Array.isArray(value)) return { type: "array", value: value.map(remote) };
  if (typeof value === "object") {
    return {
      type: "object",
      value: Object.entries(value as Record<string, unknown>).map(([key, entry]) => [remote(key), remote(entry)]),
    };
  }
  return { type: typeof value, value };
}

class FakeSocket {
  readonly sent: Array<{ id: number; method: string; params: Record<string, unknown> }> = [];
  private listeners = new Map<string, Listener[]>();

  constructor() {
    queueMicrotask(() => this.emit("open"));
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    const message = JSON.parse(data) as { id: number; method: string; params: Record<string, unknown> };
    this.sent.push(message);
    let result: unknown = {};
    if (message.method === "browsingContext.getTree") {
      result = { contexts: [{ context: "tab-1", url: "https://example.com", children: [] }] };
    } else if (message.method === "script.evaluate") {
      result = { type: "success", result: remote({ focused: true, title: "Example" }) };
    } else if (message.method === "script.callFunction") {
      if (String(message.params.functionDeclaration).includes("document.querySelector(selector)")) {
        result = { type: "success", result: { type: "node", sharedId: "node-1" } };
      } else if (message.params.functionDeclaration === "() => document.title") {
        result = { type: "success", result: remote("Example") };
      } else {
        result = {
          type: "success",
          result: remote({
            url: "https://example.com",
            title: "Example",
            nodes: [{ role: "button", name: "Continue", element: { __node: true } }],
          }),
        };
      }
    } else if (message.method === "browsingContext.navigate") {
      result = { url: message.params.url };
    } else if (message.method === "browsingContext.captureScreenshot") {
      result = { data: "jpeg-data" };
    }
    queueMicrotask(() => this.emit("message", { data: JSON.stringify({ id: message.id, result }) }));
  }

  close(): void {
    this.emit("close");
  }

  private emit(type: string, value?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(value);
  }
}

describe("[COMP:app-desktop/firefox-native-host] Firefox BiDi executor", () => {
  it("binds the focused tab and executes the fixed operation vocabulary", async () => {
    const socket = new FakeSocket();
    const executor = new FirefoxBidiExecutor("ws://127.0.0.1:9222/session", () => socket);
    await executor.connect();
    await executor.bindFocusedContext();
    const snapshot = await executor.execute("snapshot", {});
    expect(snapshot).toEqual({
      url: "https://example.com",
      title: "Example",
      nodes: [{ ref: "@e1", role: "button", name: "Continue" }],
    });
    await executor.execute("click", { ref: "@e1" });
    await executor.execute("type", { ref: "@e1", text: "ok" });
    expect(socket.sent.filter((message) => message.method === "input.performActions")).toHaveLength(3);
    expect(await executor.execute("currentUrl", {})).toEqual({
      url: "https://example.com",
      title: "Example",
    });
    expect(await executor.execute("captureFrame", {})).toEqual({
      data: "jpeg-data",
      mimeType: "image/jpeg",
    });
    await executor.execute("takeoverInput", {
      event: { kind: "click", x: 100, y: 50, frameW: 200, frameH: 100 },
    });
    expect(socket.sent.some((message) => message.method === "browsingContext.captureScreenshot")).toBe(true);
  });

  it("rejects generic protocol access and non-http navigation", async () => {
    const socket = new FakeSocket();
    const executor = new FirefoxBidiExecutor("ws://127.0.0.1:9222/session", () => socket);
    await executor.connect();
    await executor.bindFocusedContext();
    await expect(executor.execute("sendCommand", {})).rejects.toMatchObject({ code: "backend_error" });
    await expect(executor.execute("navigate", { url: "file:///etc/passwd" })).rejects.toMatchObject({
      code: "backend_error",
    });
  });

  it("keeps the BiDi pointer pressed until a separate pointer-up event", async () => {
    const socket = new FakeSocket();
    const executor = new FirefoxBidiExecutor("ws://127.0.0.1:9222/session", () => socket);
    await executor.connect();
    await executor.bindFocusedContext();
    await executor.execute("takeoverInput", {
      event: { kind: "pointer", action: "down", x: 100, y: 50, frameW: 200, frameH: 100 },
    });
    await executor.execute("takeoverInput", {
      event: { kind: "pointer", action: "up", x: 100, y: 50, frameW: 200, frameH: 100 },
    });

    const events = socket.sent.filter((message) => message.method === "input.performActions").slice(-2);
    const down = ((events[0]?.params.actions as Array<{ actions: Array<{ type: string }> }>)[0]?.actions ?? []);
    const up = ((events[1]?.params.actions as Array<{ actions: Array<{ type: string }> }>)[0]?.actions ?? []);
    expect(down.map((action) => action.type)).toEqual(["pointerMove", "pointerDown"]);
    expect(up.map((action) => action.type)).toEqual(["pointerMove", "pointerUp"]);
  });

  it("decodes BiDi remote values without eval", () => {
    expect(
      firefoxBidiInternals.decodeRemoteValue(
        remote({ nodes: [{ role: "link", name: "Docs" }], ready: true }),
      ),
    ).toEqual({ nodes: [{ role: "link", name: "Docs" }], ready: true });
  });

  it("never serializes password values and bounds ordinary form values", () => {
    expect(firefoxBidiInternals.snapshotFunction).toContain('el.type.toLowerCase() === "password"')
    expect(firefoxBidiInternals.snapshotFunction).toContain('el.value.slice(0, 500)')
  });

  it("requires an approved focused context", async () => {
    const socket = new FakeSocket();
    const executor = new FirefoxBidiExecutor("ws://127.0.0.1:9222/session", () => socket);
    await executor.connect();
    await expect(executor.execute("currentUrl", {})).rejects.toBeInstanceOf(FirefoxBidiError);
  });
});
