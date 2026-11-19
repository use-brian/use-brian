/** Fake transports and a manual scheduler for conversation controller tests. */
import { vi } from "vitest";
import type { ConversationScheduler, ConversationTransport, PendingInputProbe } from "../conversation-controller";

export const TURN_A = "a".repeat(64);
export const TURN_B = "b".repeat(64);
export const TURN_C = "c".repeat(64);
export const SCOPE = { apiOrigin: "https://api.example", viewerId: "viewer-1", workspaceId: "workspace-1" };

export type FakeSse = {
  response: Response;
  send: (event: string, data: unknown) => void;
  close: () => void;
  fail: () => void;
  aborted: () => boolean;
};

export function fakeSse(signal?: AbortSignal | null): FakeSse {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let open = true;
  let wasAborted = false;
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  const encoder = new TextEncoder();
  signal?.addEventListener("abort", () => {
    wasAborted = true;
    if (open) { open = false; controller.error(new DOMException("aborted", "AbortError")); }
  });
  return {
    response: new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    send(event, data) { if (open) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); },
    close() { if (open) { open = false; controller.close(); } },
    fail() { if (open) { open = false; controller.error(new Error("socket reset")); } },
    aborted: () => wasAborted,
  };
}

type FollowPlan = (signal: AbortSignal | null | undefined) => Promise<Response> | Response;

/** Routes `/api/chat` and `/api/sessions/:id/stream` to scripted streams. */
export function fakeTransport() {
  const chats: Array<{ body: Record<string, unknown>; sse: FakeSse }> = [];
  const sides: Array<Record<string, unknown>> = [];
  const follows: Array<{ sessionId: string; sse: FakeSse | null }> = [];
  const followPlans: FollowPlan[] = [];
  let chatFailure: Error | null = null;
  const chatRefusals: Response[] = [];
  const status = { current: { status: "running", turnId: TURN_A as string | null } };
  const pending: { current: PendingInputProbe } = { current: { pending: null, toolConfirmation: null } };
  const transport: ConversationTransport & {
    readStatus: ReturnType<typeof vi.fn>;
    stopTurn: ReturnType<typeof vi.fn>;
    confirmLive: ReturnType<typeof vi.fn>;
    respondRestored: ReturnType<typeof vi.fn>;
    fetchPending: ReturnType<typeof vi.fn>;
    answerQuestion: ReturnType<typeof vi.fn>;
    cancelQuestion: ReturnType<typeof vi.fn>;
    loadHistory: ReturnType<typeof vi.fn>;
  } = {
    apiUrl: "https://api.example",
    async authFetch(input, init) {
      const url = String(input);
      if (url.endsWith("/api/chat")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        if (body.midTurn === true && typeof body.inputId === "string") {
          sides.push(body);
          return new Response(`event: input_queued\ndata: {"inputId":"${body.inputId}"}\n\nevent: done\ndata: {}\n\n`);
        }
        if (chatFailure) { const failure = chatFailure; chatFailure = null; throw failure; }
        const refusal = chatRefusals.shift();
        if (refusal) { chats.push({ body, sse: fakeSse(null) }); return refusal; }
        const sse = fakeSse(init?.signal);
        chats.push({ body, sse });
        return sse.response;
      }
      const match = url.match(/\/api\/sessions\/([^/]+)\/stream$/);
      if (match) {
        const plan = followPlans.shift();
        if (plan) {
          follows.push({ sessionId: decodeURIComponent(match[1]!), sse: null });
          return plan(init?.signal);
        }
        const sse = fakeSse(init?.signal);
        follows.push({ sessionId: decodeURIComponent(match[1]!), sse });
        return sse.response;
      }
      throw new Error(`unexpected request ${url}`);
    },
    readStatus: vi.fn(async () => ({ ...status.current })),
    stopTurn: vi.fn(async () => ({ stopped: true })),
    confirmLive: vi.fn(async () => ({ ok: true, status: 200 })),
    respondRestored: vi.fn(async () => ({ ok: true })),
    fetchPending: vi.fn(async () => pending.current),
    answerQuestion: vi.fn(async () => ({ ok: true })),
    cancelQuestion: vi.fn(async () => ({ ok: true })),
    loadHistory: vi.fn(async () => []),
  };
  return {
    transport, chats, sides, follows, followPlans, status, pending,
    failNextChat(error = new Error("network")) { chatFailure = error; },
    /** The next direct POST answers with this response instead of a stream. */
    refuseNextChat(response: Response) { chatRefusals.push(response); },
    lastChat: () => chats.at(-1)!,
    lastFollow: () => follows.at(-1)!,
  };
}

/** Manual animation frames and timers on a fake epoch clock. */
export function fakeScheduler() {
  let now = 1_700_000_000_000;
  let seq = 0;
  const frames = new Map<number, () => void>();
  const timers = new Map<number, { at: number; callback: () => void }>();
  let frameRequests = 0;
  const scheduler: ConversationScheduler = {
    requestFrame: (callback) => { frameRequests++; frames.set(++seq, callback); return seq; },
    cancelFrame: (handle) => { frames.delete(handle as number); },
    setTimeout: (callback, ms) => { timers.set(++seq, { at: now + ms, callback }); return seq; },
    clearTimeout: (handle) => { timers.delete(handle as number); },
    now: () => now,
    monotonic: () => now,
  };
  return {
    scheduler,
    runFrames() { const due = [...frames.values()]; frames.clear(); for (const callback of due) callback(); },
    frameRequests: () => frameRequests,
    pendingFrames: () => frames.size,
    /** Timers other than the paint fallback. */
    timerDelays: () => [...timers.values()].map((timer) => timer.at - now).filter((delay) => delay !== 100),
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at).find(([, timer]) => timer.at <= target);
        if (!next) break;
        now = Math.max(now, next[1].at);
        timers.delete(next[0]);
        next[1].callback();
        await settle();
      }
      now = target;
      await settle();
    },
  };
}

/** Let stream reads, awaited status reads and callbacks run. */
export async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
