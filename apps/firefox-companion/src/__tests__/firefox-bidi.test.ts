import { describe, expect, it } from "vitest";
import { FirefoxBidiExecutor, FirefoxBidiError, firefoxBidiInternals } from "../firefox-bidi.js";
import { ACTION_CURSOR_MARKER } from "../action-cursor.js";

type Listener = (...args: any[]) => void;
type WireCommand = { id: number; method: string; params: Record<string, unknown> };

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
  readonly sent: WireCommand[] = [];
  private holds: Array<{ matches: (message: WireCommand) => boolean; accept: (message: WireCommand, respond: () => void) => void }> = [];
  private listeners = new Map<string, Listener[]>();

  constructor() {
    queueMicrotask(() => this.emit("open"));
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  holdNext(matches: (message: WireCommand) => boolean) {
    let release = () => {};
    let reached!: (message: WireCommand) => void;
    const pending = new Promise<WireCommand>((resolve) => { reached = resolve; });
    this.holds.push({ matches, accept: (message, respond) => {
      release = respond;
      reached(message);
    } });
    return { reached: pending, release: () => release() };
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
      } else if (String(message.params.functionDeclaration).includes("window.innerWidth")) {
        result = { type: "success", result: remote({ width: 800, height: 600 }) };
      } else if (message.params.functionDeclaration === "() => document.title") {
        result = { type: "success", result: remote("Example") };
      } else {
        const mode = (message.params.arguments as Array<{ value?: unknown }> | undefined)?.[0]?.value;
        result = {
          type: "success",
          result: remote({
            url: "https://example.com",
            title: "Example",
            nodes: [
              { role: "button", name: "Continue", element: { __node: true } },
              ...(mode === "full" ? [{ role: "cell", name: "Adult fare 5.9" }] : []),
            ],
          }),
        };
      }
    } else if (message.method === "browsingContext.navigate") {
      result = { url: message.params.url };
    } else if (message.method === "browsingContext.captureScreenshot") {
      result = { data: "jpeg-data" };
    }
    const respond = () => queueMicrotask(() => this.emit("message", { data: JSON.stringify({ id: message.id, result }) }));
    const held = this.holds.findIndex((hold) => hold.matches(message));
    if (held >= 0) this.holds.splice(held, 1)[0]!.accept(message, respond);
    else respond();
  }

  close(): void {
    this.emit("close");
  }

  private emit(type: string, value?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(value);
  }
}

describe("[COMP:ext/firefox-companion] Firefox BiDi executor", () => {
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
    const cursors = socket.sent.filter(
      (message) => message.method === "script.callFunction"
        && String(message.params.functionDeclaration).includes(ACTION_CURSOR_MARKER),
    );
    expect(cursors.map((message) => (message.params.arguments as Array<{ value: string }>)[0]?.value))
      .toEqual(["pointer", "typing"]);
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
    expect(socket.sent.filter(
      (message) => message.method === "script.callFunction"
        && String(message.params.functionDeclaration).includes(ACTION_CURSOR_MARKER),
    )).toHaveLength(2);
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

  it("returns static information without refs in a full snapshot", async () => {
    const socket = new FakeSocket();
    const executor = new FirefoxBidiExecutor("ws://127.0.0.1:9222/session", () => socket);
    await executor.connect();
    await executor.bindFocusedContext();

    const snapshot = await executor.execute("snapshot", { mode: "full" });

    expect(snapshot).toMatchObject({
      nodes: [
        { ref: "@e1", role: "button", name: "Continue" },
        { role: "cell", name: "Adult fare 5.9" },
      ],
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
      event: { kind: "pointer", action: "move", x: 120, y: 60, frameW: 200, frameH: 100 },
    });
    await executor.execute("takeoverInput", {
      event: { kind: "pointer", action: "up", x: 100, y: 50, frameW: 200, frameH: 100 },
    });

    const events = socket.sent.filter((message) => message.method === "input.performActions").slice(-3);
    const down = ((events[0]?.params.actions as Array<{ actions: Array<{ type: string }> }>)[0]?.actions ?? []);
    const move = ((events[1]?.params.actions as Array<{ actions: Array<{ type: string }> }>)[0]?.actions ?? []);
    const up = ((events[2]?.params.actions as Array<{ actions: Array<{ type: string }> }>)[0]?.actions ?? []);
    expect(down.map((action) => action.type)).toEqual(["pointerMove", "pointerDown"]);
    expect(move.map((action) => action.type)).toEqual(["pointerMove"]);
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
    expect(firefoxBidiInternals.snapshotFunction).toContain('? "statictext"')
  });

  it("requires an approved focused context", async () => {
    const socket = new FakeSocket();
    const executor = new FirefoxBidiExecutor("ws://127.0.0.1:9222/session", () => socket);
    await executor.connect();
    await expect(executor.execute("currentUrl", {})).rejects.toBeInstanceOf(FirefoxBidiError);
  });
});

it("explicitly refuses batch filling without sending browser input", async () => {
  const socket = new FakeSocket();
  const executor = new FirefoxBidiExecutor("ws://127.0.0.1:9222/session", () => socket);
  await expect(executor.execute("fillForm", {
    fields: [{ action: "fill", ref: "@e1", value: "hello" }],
  })).rejects.toMatchObject({ code: "unsupported_browser" });
  expect(socket.sent).toEqual([]);
});

describe("[COMP:ext/firefox-companion] inside-execute Stop fence", () => {
  it.each(["click", "type"] as const)("refuses %s after its held cursor reply when Stop teardown is pending", async (op) => {
    const socket = new FakeSocket();
    const executor = new FirefoxBidiExecutor("ws://127.0.0.1:9222/session", () => socket);
    await executor.connect();
    await executor.bindFocusedContext();
    await executor.execute("snapshot", {});
    const cursor = socket.holdNext((frame) => frame.method === "script.callFunction"
      && String(frame.params.functionDeclaration).includes(ACTION_CURSOR_MARKER));
    const teardown = socket.holdNext((frame) => frame.method === "input.releaseActions");
    const operation = executor.execute(op, { ref: "@e1", text: "ok" })
      .then(() => ({ ok: true }), () => ({ ok: false }));
    let stopping: Promise<void> | undefined;
    try {
      await cursor.reached;
      expect(socket.sent.filter((frame) => frame.method === "input.performActions")).toEqual([]);
      stopping = executor.stop();
      const stopFrame = await teardown.reached;
      cursor.release();
      const result = await operation;
      expect({ result, laterEffects: socket.sent.filter((frame) => frame.id > stopFrame.id && frame.method === "input.performActions") })
        .toEqual({ result: { ok: false }, laterEffects: [] });
    } finally {
      cursor.release();
      teardown.release();
      await stopping;
      await executor.stop();
      await operation;
    }
  });

  it.each(["click", "pointer"] as const)("refuses Take-Over %s after its held viewport reply when Stop teardown is pending", async (kind) => {
    const socket = new FakeSocket();
    const executor = new FirefoxBidiExecutor("ws://127.0.0.1:9222/session", () => socket);
    await executor.connect();
    await executor.bindFocusedContext();
    const viewport = socket.holdNext((frame) => frame.method === "script.callFunction"
      && String(frame.params.functionDeclaration).includes("window.innerWidth"));
    const teardown = socket.holdNext((frame) => frame.method === "input.releaseActions");
    const operation = executor.execute("takeoverInput", {
      event: { kind, action: "down", x: 100, y: 50, frameW: 200, frameH: 100 },
    }).then(() => ({ ok: true }), () => ({ ok: false }));
    let stopping: Promise<void> | undefined;
    try {
      await viewport.reached;
      expect(socket.sent.filter((frame) => frame.method === "input.performActions")).toEqual([]);
      stopping = executor.stop();
      const stopFrame = await teardown.reached;
      viewport.release();
      const result = await operation;
      expect({ result, laterEffects: socket.sent.filter((frame) => frame.id > stopFrame.id && frame.method === "input.performActions") })
        .toEqual({ result: { ok: false }, laterEffects: [] });
    } finally {
      viewport.release();
      teardown.release();
      await stopping;
      await executor.stop();
      await operation;
    }
  });

  it("does not send type keys after Stop while its already dispatched click awaits a reply", async () => {
    const socket = new FakeSocket();
    const executor = new FirefoxBidiExecutor("ws://127.0.0.1:9222/session", () => socket);
    await executor.connect();
    await executor.bindFocusedContext();
    await executor.execute("snapshot", {});
    const click = socket.holdNext((frame) => frame.method === "input.performActions");
    const teardown = socket.holdNext((frame) => frame.method === "input.releaseActions");
    const operation = executor.execute("type", { ref: "@e1", text: "ok" })
      .then(() => ({ ok: true }), () => ({ ok: false }));
    let stopping: Promise<void> | undefined;
    try {
      const firstInput = await click.reached;
      expect((firstInput.params.actions as Array<{ type: string }>)[0]?.type).toBe("pointer");
      stopping = executor.stop();
      const stopFrame = await teardown.reached;
      click.release();
      const result = await operation;
      expect({ result, laterEffects: socket.sent.filter((frame) => frame.id > stopFrame.id && frame.method === "input.performActions") })
        .toEqual({ result: { ok: false }, laterEffects: [] });
    } finally {
      click.release();
      teardown.release();
      await stopping;
      await executor.stop();
      await operation;
    }
  });

  it("keeps normal input and a freshly connected executor usable after ordinary Stop", async () => {
    const sockets: FakeSocket[] = [];
    const executor = new FirefoxBidiExecutor("ws://127.0.0.1:9222/session", () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });
    try {
      await executor.connect();
      await executor.bindFocusedContext();
      await executor.execute("snapshot", {});
      await expect(executor.execute("type", { ref: "@e1", text: "ok" })).resolves.toEqual({ typed: true });
      await executor.stop();
      expect(sockets[0]!.sent.filter((frame) => frame.method === "input.performActions")).toHaveLength(2);
      expect(sockets[0]!.sent.slice(-2).map((frame) => frame.method)).toEqual(["input.releaseActions", "session.end"]);
      await executor.connect();
      await executor.bindFocusedContext();
      await expect(executor.execute("navigate", { url: "https://destination.example/fresh" }))
        .resolves.toEqual({ url: "https://destination.example/fresh" });
      expect(sockets).toHaveLength(2);
    } finally { await executor.stop(); }
  });
});
