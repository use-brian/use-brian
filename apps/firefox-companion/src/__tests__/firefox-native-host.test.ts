import { describe, expect, it, vi } from "vitest";
import { PassThrough, Writable } from "node:stream";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FirefoxBidiExecutor } from "../firefox-bidi.js";
import {
  MAX_NATIVE_MESSAGE_BYTES,
  NativeMessageDecoder,
  encodeNativeMessage,
  runFirefoxNativeHost,
} from "../firefox-native-host.js";

describe("[COMP:ext/firefox-companion] native-message framing", () => {
  it("decodes fragmented and coalesced little-endian frames", () => {
    const first = encodeNativeMessage({ id: "1", type: "status" });
    const second = encodeNativeMessage({ id: "2", type: "stop" });
    const decoder = new NativeMessageDecoder();
    expect(decoder.push(first.subarray(0, 3))).toEqual([]);
    expect(decoder.push(Buffer.concat([first.subarray(3), second]))).toEqual([
      { id: "1", type: "status" },
      { id: "2", type: "stop" },
    ]);
  });

  it("rejects oversized frames before allocating their body", () => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(MAX_NATIVE_MESSAGE_BYTES + 1);
    expect(() => new NativeMessageDecoder().push(header)).toThrow("native_message_too_large");
  });
});


function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

type HostReply = { id: string; ok: boolean; code?: string; data?: unknown };
async function hostFixture() {
  const directory = await mkdtemp(join(tmpdir(), "firefox-host-stop-"));
  const profile = join(directory, "fixture.default");
  await mkdir(profile);
  await writeFile(join(profile, "WebDriverBiDiServer.json"), JSON.stringify({ ws_host: "127.0.0.1", ws_port: 9222 }));
  const input = new PassThrough();
  const decoder = new NativeMessageDecoder();
  const replies: HostReply[] = [];
  const output = new Writable({ write(chunk, _encoding, done) { replies.push(...decoder.push(chunk) as HostReply[]); done(); } });
  const connect = deferred<void>();
  const bind = deferred<{ bound: true }>();
  let holdConnect = false;
  let holdBind = false;
  const executors: Array<{
    connect: ReturnType<typeof vi.fn>;
    bindFocusedContext: ReturnType<typeof vi.fn>;
    execute: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }> = [];
  const createExecutor = vi.fn(() => {
    const executor = {
      connect: vi.fn(async () => { if (holdConnect && executors.length === 1) await connect.promise; }),
      bindFocusedContext: vi.fn(async () => holdBind && executors.length === 1 ? bind.promise : { bound: true }),
      execute: vi.fn(async (op: string, args: Record<string, unknown>) => ({ op, url: args.url })),
      stop: vi.fn(async () => {}),
    };
    executors.push(executor);
    return executor as unknown as FirefoxBidiExecutor;
  });
  const running = runFirefoxNativeHost({ input, output, error: new PassThrough(), platform: "linux",
    env: { USE_BRIAN_FIREFOX_PROFILE_ROOT: directory }, home: directory, createExecutor });
  return {
    replies, executors, createExecutor, connect, bind,
    holdConnect: () => { holdConnect = true; }, holdBind: () => { holdBind = true; },
    send: (id: string, type: string, extra: Record<string, unknown> = {}) => input.write(encodeNativeMessage({ id, type, ...extra })),
    reply: (id: string) => replies.find((value) => value.id === id),
    async close() { connect.resolve(); bind.resolve({ bound: true }); input.end(); await running; await rm(directory, { recursive: true, force: true }); },
  };
}

describe("[COMP:ext/firefox-companion] actual framed host Stop fence", () => {
  it("disposes a late connection and refuses queued pre-Stop bind and execute", async () => {
    const host = await hostFixture();
    host.holdConnect();
    try {
      host.send("opening", "status");
      await vi.waitFor(() => expect(host.executors[0]?.connect).toHaveBeenCalledOnce());
      host.send("old-bind", "bind", { args: { url: "https://destination.example/" } });
      host.send("old-execute", "execute", { op: "navigate", args: { url: "https://destination.example/old" } });
      host.send("stop", "stop");
      await vi.waitFor(() => expect(host.reply("stop")).toMatchObject({ ok: true, data: { stopped: true } }));
      // Safety Stop acknowledges without waiting for the unresolved connection.
      expect(host.reply("opening")).toBeUndefined();
      host.connect.resolve();
      await vi.waitFor(() => expect(host.reply("old-execute")).toBeDefined());
      expect(host.reply("old-bind")).toMatchObject({ ok: false, code: "stopped" });
      expect(host.reply("old-execute")).toMatchObject({ ok: false, code: "stopped" });
      expect(host.executors.flatMap(executor => executor.bindFocusedContext.mock.calls)).toEqual([]);
      expect(host.executors.flatMap(executor => executor.execute.mock.calls)).toEqual([]);
      expect(host.executors[0]!.stop).toHaveBeenCalled();
      expect(host.createExecutor).toHaveBeenCalledOnce();
    } finally { await host.close(); }
  });

  it("withholds a raced bind success and never runs the old queued effect", async () => {
    const host = await hostFixture();
    host.holdBind();
    try {
      host.send("old-bind", "bind", { args: { url: "https://destination.example/" } });
      await vi.waitFor(() => expect(host.executors[0]?.bindFocusedContext).toHaveBeenCalledOnce());
      host.send("old-execute", "execute", { op: "navigate", args: { url: "https://destination.example/old" } });
      host.send("stop", "stop");
      await vi.waitFor(() => expect(host.reply("stop")).toMatchObject({ ok: true, data: { stopped: true } }));
      host.bind.resolve({ bound: true });
      await vi.waitFor(() => expect(host.reply("old-execute")).toBeDefined());
      expect(host.reply("old-bind")).toMatchObject({ ok: false, code: "stopped" });
      expect(host.reply("old-execute")).toMatchObject({ ok: false, code: "stopped" });
      expect(host.executors.flatMap(executor => executor.execute.mock.calls)).toEqual([]);
      expect(host.createExecutor).toHaveBeenCalledOnce();
    } finally { await host.close(); }
  });

  it("allows a fresh bind and operation after Stop without replaying the old effect", async () => {
    const host = await hostFixture();
    try {
      host.send("first-bind", "bind", { args: { url: "https://destination.example/" } });
      await vi.waitFor(() => expect(host.reply("first-bind")).toMatchObject({ ok: true, data: { bound: true } }));
      host.send("stop", "stop");
      await vi.waitFor(() => expect(host.reply("stop")).toMatchObject({ ok: true, data: { stopped: true } }));
      host.send("fresh-bind", "bind", { args: { url: "https://destination.example/" } });
      host.send("fresh-execute", "execute", { op: "navigate", args: { url: "https://destination.example/fresh" } });
      await vi.waitFor(() => expect(host.reply("fresh-execute")).toMatchObject({ ok: true, data: { op: "navigate", url: "https://destination.example/fresh" } }));
      expect(host.reply("fresh-bind")).toMatchObject({ ok: true });
      expect(host.executors.flatMap(executor => executor.execute.mock.calls)).toEqual([["navigate", { url: "https://destination.example/fresh" }]]);
      expect(host.executors[0]!.stop).toHaveBeenCalledOnce();
    } finally { await host.close(); }
  });
});
