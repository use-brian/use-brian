// @vitest-environment jsdom
/**
 * Live Office job progress client. [COMP:app-web/office-job-stream]
 * Spec: docs/architecture/features/office.md -> "Live job progress".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const net = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: (...args: unknown[]) => net.fetch(...args) }));

import { _resetOfficeJobStreams, applyOfficeJobFrame, awaitOfficeJob, readOfficeJobStream, subscribeOfficeJobStream } from "../job-stream";
import { officeEventLabel, officeJobStateLabel } from "../job-labels";
import { en } from "@/lib/i18n/dictionaries/en";

const JOB = "job-1";
const job = (status: string) => ({ id: JOB, workspaceId: "w", artifactId: "a", status, stage: status, errorCode: null });
const event = (seq: number, code = "office.job.context_grounded") => ({ id: `e${seq}`, seq, code, params: {}, safeNarration: null, createdAt: "2026-10-10T00:00:00Z" });

type Push = (event: string, data: unknown) => void;
/** An SSE response the test can push frames into and end. */
function sse(frames: Array<[string, unknown]>): { response: Response; push: Push; end: () => void } {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encode = (name: string, data: unknown) => new TextEncoder().encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  const response = new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c; for (const [name, data] of frames) c.enqueue(encode(name, data)); } }), { status: 200 });
  return { response, push: (name, data) => controller.enqueue(encode(name, data)), end: () => controller.close() };
}

async function flush(ms = 0) {
  for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  net.fetch.mockReset();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
afterEach(() => {
  _resetOfficeJobStreams();
  vi.useRealTimers();
});

describe("[COMP:app-web/office-job-stream] stream client", () => {
  it("dedupes events by seq and ignores anything at or below the last seen seq", () => {
    let state = { job: null, events: [], connection: "reconnecting" as const, ended: null };
    let lastSeq = 0;
    for (const seq of [1, 2, 2, 1, 3]) {
      const next = applyOfficeJobFrame(state, lastSeq, "event", event(seq));
      state = next.state as typeof state;
      lastSeq = next.lastSeq;
    }
    expect((state.events as Array<{ seq: number }>).map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(lastSeq).toBe(3);
  });

  it("shares one connection per job across subscribers and closes it with the last one", async () => {
    const stream = sse([["job", job("running")]]);
    net.fetch.mockResolvedValue(stream.response);
    const a = subscribeOfficeJobStream(JOB, () => undefined);
    const b = subscribeOfficeJobStream(JOB, () => undefined);
    await flush();
    expect(net.fetch).toHaveBeenCalledTimes(1);
    a();
    expect(readOfficeJobStream(JOB).job?.status).toBe("running");
    b();
    expect(readOfficeJobStream(JOB).job).toBeNull();
  });

  it("reconnects from the last seen seq, shows reconnecting meanwhile, and never duplicates a seq", async () => {
    const first = sse([["job", job("running")], ["event", event(1)], ["event", event(2)]]);
    const second = sse([["event", event(2)], ["event", event(3)]]);
    net.fetch.mockResolvedValueOnce(first.response).mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(second.response);
    const off = subscribeOfficeJobStream(JOB, () => undefined);
    await flush();
    expect(readOfficeJobStream(JOB).connection).toBe("live");
    first.end();
    await flush();
    // The failed reconnect leaves the stream reconnecting, showing the last persisted step.
    expect(readOfficeJobStream(JOB).connection).toBe("reconnecting");
    expect(readOfficeJobStream(JOB).events.map((row) => row.seq)).toEqual([1, 2]);
    await flush(1_000);
    expect(net.fetch).toHaveBeenCalledTimes(3);
    for (const call of net.fetch.mock.calls.slice(1)) expect((call[1] as RequestInit).headers).toEqual({ "Last-Event-ID": "2" });
    expect(readOfficeJobStream(JOB).events.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(readOfficeJobStream(JOB).connection).toBe("live");
    off();
  });

  it("stops on done and does not reconnect", async () => {
    const stream = sse([["job", job("completed")], ["event", event(1, "office.job.completed")], ["done", { status: "completed" }]]);
    net.fetch.mockResolvedValue(stream.response);
    const off = subscribeOfficeJobStream(JOB, () => undefined);
    await flush(5_000);
    expect(readOfficeJobStream(JOB).ended).toBe("done");
    expect(net.fetch).toHaveBeenCalledTimes(1);
    off();
  });

  it("clears the job on revoked and on a 404, and stops", async () => {
    net.fetch.mockResolvedValueOnce(sse([["job", job("running")], ["revoked", {}]]).response);
    const off = subscribeOfficeJobStream(JOB, () => undefined);
    await flush(5_000);
    expect(readOfficeJobStream(JOB)).toMatchObject({ job: null, events: [], ended: "revoked" });
    off();
    net.fetch.mockResolvedValueOnce(new Response("{}", { status: 404 }));
    const again = subscribeOfficeJobStream(JOB, () => undefined);
    await flush(5_000);
    expect(readOfficeJobStream(JOB).ended).toBe("revoked");
    expect(net.fetch).toHaveBeenCalledTimes(2);
    again();
  });

  it("releases a hidden tab's stream after the grace window and resumes on visible", async () => {
    net.fetch.mockImplementation(async () => sse([["job", job("running")]]).response);
    const off = subscribeOfficeJobStream(JOB, () => undefined);
    await flush();
    const signal = (net.fetch.mock.calls[0]![1] as RequestInit).signal!;
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    await flush(60_000);
    expect(signal.aborted).toBe(true);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(net.fetch).toHaveBeenCalledTimes(2);
    off();
  });

  it("awaitOfficeJob resolves on a settled status with no wall-clock cap, and rejects on revoke", async () => {
    const stream = sse([["job", job("running")]]);
    net.fetch.mockResolvedValueOnce(stream.response);
    const waiting = awaitOfficeJob(JOB);
    await flush(10 * 60_000);
    stream.push("job", job("needs_input"));
    await expect(waiting).resolves.toMatchObject({ status: "needs_input" });

    net.fetch.mockResolvedValueOnce(sse([["revoked", {}]]).response);
    const denied = expect(awaitOfficeJob(JOB)).rejects.toThrow("office_job_revoked");
    await flush();
    await denied;
  });
});

describe("[COMP:app-web/office-job-stream] no generic Working", () => {
  const t = en.office;
  it("labels a running job by its latest persisted event, never a generic in-progress label", () => {
    expect(officeJobStateLabel(t, "running", { code: "office.job.started" })).toBe(t.eventStarted);
    expect(officeJobStateLabel(t, "running", { code: "office.job.unmapped", safeNarration: "Server narration" })).toBe("Server narration");
    expect(officeJobStateLabel(t, "running", null)).toBeNull();
    expect(officeJobStateLabel(t, "needs_input", { code: "office.job.started" })).toBe(t.eventNeedsInput);
    expect(officeEventLabel(t, { code: "office.job.unmapped", safeNarration: null })).toBeNull();
    expect(Object.keys(t)).not.toContain("running");
  });
});
