/** Firefox native-messaging stdio host. [COMP:ext/firefox-companion] */
import type { Readable, Writable } from "node:stream";
import { FirefoxBidiExecutor, FirefoxBidiError } from "./firefox-bidi.js";
import { discoverFirefoxRemoteEndpoint, firefoxProfilesRoots } from "./firefox-launcher.js";

// Firefox caps native-host -> extension frames at 1 MiB. Leave framing headroom.
export const MAX_NATIVE_MESSAGE_BYTES = 900 * 1024;

export function encodeNativeMessage(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > MAX_NATIVE_MESSAGE_BYTES) throw new Error("native_message_too_large");
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

export class NativeMessageDecoder {
  private buffered = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    const messages: unknown[] = [];
    while (this.buffered.length >= 4) {
      const length = this.buffered.readUInt32LE(0);
      if (length > MAX_NATIVE_MESSAGE_BYTES) throw new Error("native_message_too_large");
      if (this.buffered.length < 4 + length) break;
      const body = this.buffered.subarray(4, 4 + length);
      this.buffered = this.buffered.subarray(4 + length);
      messages.push(JSON.parse(body.toString("utf8")) as unknown);
    }
    return messages;
  }
}

type NativeRequest = {
  id: string;
  type: "status" | "bind" | "execute" | "stop" | "openDesktop";
  op?: string;
  args?: Record<string, unknown>;
};

function parseRequest(value: unknown): NativeRequest | null {
  if (!value || typeof value !== "object") return null;
  const req = value as Partial<NativeRequest>;
  if (typeof req.id !== "string") return null;
  if (!(["status", "bind", "execute", "stop", "openDesktop"] as const).includes(req.type as NativeRequest["type"])) {
    return null;
  }
  return {
    id: req.id,
    type: req.type as NativeRequest["type"],
    ...(typeof req.op === "string" ? { op: req.op } : {}),
    ...(req.args && typeof req.args === "object" ? { args: req.args } : {}),
  };
}

export type FirefoxNativeHostDeps = {
  input: Readable;
  output: Writable;
  error: Writable;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  createExecutor?: (url: string) => FirefoxBidiExecutor;
  openControl?: () => Promise<void> | void;
};

export async function runFirefoxNativeHost(deps: FirefoxNativeHostDeps): Promise<void> {
  const decoder = new NativeMessageDecoder();
  let executor: FirefoxBidiExecutor | null = null;
  const profilesRoots = firefoxProfilesRoots(deps.platform, deps.env, deps.home);

  const ensureExecutor = async (): Promise<FirefoxBidiExecutor> => {
    if (executor) return executor;
    if (profilesRoots.length === 0) {
      throw new FirefoxBidiError("Firefox is not supported on this platform.", "unsupported_browser");
    }
    const endpoint = await discoverFirefoxRemoteEndpoint(profilesRoots);
    if (!endpoint) {
      throw new FirefoxBidiError(
        "Firefox was not started for My Browser. Quit Firefox, then run use-brian-firefox start or choose Start Firefox for My Browser in the Use Brian desktop app.",
        "firefox_restart_required",
      );
    }
    const host = endpoint.wsHost.includes(":") ? `[${endpoint.wsHost}]` : endpoint.wsHost;
    const candidate = (deps.createExecutor ?? ((url) => new FirefoxBidiExecutor(url)))(
      `ws://${host}:${endpoint.wsPort}/session`,
    );
    try {
      await candidate.connect();
      executor = candidate;
      return candidate;
    } catch (error) {
      executor = null;
      throw error;
    }
  };

  const reply = (value: unknown): void => {
    deps.output.write(encodeNativeMessage(value));
  };

  const handle = async (value: unknown): Promise<void> => {
    const req = parseRequest(value);
    if (!req) {
      reply({ id: null, ok: false, error: "Invalid native-host request.", code: "backend_error" });
      return;
    }
    try {
      if (req.type === "status") {
        try {
          await ensureExecutor();
          reply({ id: req.id, ok: true, data: { ready: true } });
        } catch (error) {
          reply({
            id: req.id,
            ok: true,
            data: {
              ready: false,
              reason: error instanceof FirefoxBidiError ? error.code : "firefox_restart_required",
            },
          });
        }
        return;
      }
      if (req.type === "bind") {
        const active = await ensureExecutor();
        reply({
          id: req.id,
          ok: true,
          data: await active.bindFocusedContext({
            ...(typeof req.args?.url === "string" ? { url: req.args.url } : {}),
            ...(typeof req.args?.title === "string" ? { title: req.args.title } : {}),
          }),
        });
        return;
      }
      if (req.type === "openDesktop") {
        if (!deps.openControl) {
          throw new FirefoxBidiError(
            "Quit Firefox, then run use-brian-firefox start in a terminal.",
            "firefox_restart_required",
          );
        }
        await deps.openControl();
        reply({ id: req.id, ok: true, data: { opened: true } });
        return;
      }
      if (req.type === "stop") {
        await executor?.stop();
        executor = null;
        reply({ id: req.id, ok: true, data: { stopped: true } });
        return;
      }
      if (!req.op) throw new FirefoxBidiError("Missing browser operation.", "backend_error");
      const active = await ensureExecutor();
      reply({ id: req.id, ok: true, data: await active.execute(req.op, req.args ?? {}) });
    } catch (error) {
      const code = error instanceof FirefoxBidiError ? error.code : "backend_error";
      if (code === "detached") executor = null;
      reply({
        id: req.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        code,
      });
    }
  };

  await new Promise<void>((resolve, reject) => {
    let queue = Promise.resolve();
    deps.input.on("data", (chunk: Buffer | string) => {
      try {
        for (const message of decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) {
          if ((message as { type?: unknown } | null)?.type === "stop") void handle(message);
          else queue = queue.then(() => handle(message));
        }
        queue.catch(reject);
      } catch (error) {
        reject(error);
      }
    });
    deps.input.on("end", () => queue.finally(resolve));
    deps.input.on("error", reject);
  }).finally(async () => {
    await executor?.stop();
  });
}
