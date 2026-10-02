import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ request: vi.fn(), start: vi.fn(), stop: vi.fn(), pause: vi.fn(), constructors: vi.fn() }));
vi.mock("../api", () => ({ interactionRequest: mocks.request }));
vi.mock("../stream", () => ({ InteractionStream: class {
  constructor(...args: unknown[]) { mocks.constructors(...args); }
  start = mocks.start; stop = mocks.stop; setPaused = mocks.pause;
} }));
import { startInteractionCapture } from "../capture";
const binding = { workspaceId: "w", pageId: "p", chatSessionId: "original", assistantId: "a" };
const sources = { microphone: {} as MediaStream, system: {} as MediaStream };
beforeEach(() => {
  vi.clearAllMocks(); mocks.request.mockResolvedValue({ id: "capture" });
  mocks.start.mockResolvedValue(undefined); mocks.stop.mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());
it("binds both isolated streams to the original chat and closes server state after all accepted audio drains", async () => {
  const capture = await startInteractionCapture(binding, sources, () => 123, vi.fn());
  expect(mocks.request).toHaveBeenCalledWith("/start", binding);
  expect(mocks.constructors.mock.calls.map((args) => args.slice(0, 3))).toEqual([
    ["capture", "microphone", sources.microphone], ["capture", "system", sources.system],
  ]);
  capture.pause(true); expect(mocks.pause).toHaveBeenCalledTimes(2);
  let drain!: () => void;
  mocks.stop.mockImplementation(() => new Promise<void>((r) => { drain = r; })).mockResolvedValueOnce(undefined);
  const done = capture.stop(); expect(capture.stop()).toBe(done);
  expect(mocks.request).not.toHaveBeenCalledWith("/capture/stop", {});
  drain(); await done;
  expect(mocks.request).toHaveBeenLastCalledWith("/capture/stop", {});
});
it("does not start stale microphone capture if disabled while creating the server capture", async () => {
  let resolve!: (value: unknown) => void;
  mocks.request.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
  const controller = new AbortController();
  const pending = startInteractionCapture(binding, sources, () => 0, vi.fn(), controller.signal);
  controller.abort(); resolve({ id: "late" });
  const capture = await pending; await capture.stop();
  expect(mocks.constructors).not.toHaveBeenCalled();
  expect(mocks.request).toHaveBeenLastCalledWith("/late/stop", {});
});
it("aborts both lanes immediately even if their startup has not resolved", async () => {
  let resolve!: () => void;
  mocks.start.mockImplementationOnce(() => new Promise<void>((r) => { resolve = r; }));
  const controller = new AbortController();
  const pending = startInteractionCapture(binding, sources, () => 0, vi.fn(), controller.signal);
  await Promise.resolve(); controller.abort();
  expect(mocks.stop).toHaveBeenCalledTimes(2);
  resolve(); const capture = await pending; await capture.stop();
});
it("reports server stop failure instead of cancelling accepted answer jobs", async () => {
  const gap = vi.fn();
  const capture = await startInteractionCapture(binding, { ...sources, system: null }, () => 0, gap);
  mocks.request.mockRejectedValueOnce(new Error("offline")); await capture.stop();
  expect(gap).toHaveBeenCalled();
  expect(mocks.request.mock.calls.some(([path]) => path.includes("cancel"))).toBe(false);
});
it("publishes the validated capture ID before either stream connects", async () => {
  let connect!: () => void;
  mocks.start.mockImplementationOnce(() => new Promise<void>((resolve) => { connect = resolve; }));
  const ready = vi.fn();
  const pending = startInteractionCapture(binding, sources, () => 0, vi.fn(), undefined, ready);
  expect(ready).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(ready).toHaveBeenCalledExactlyOnceWith("capture");
  connect();
  expect((await pending).captureId).toBe("capture");
});
it("never publishes a marker for a failed or cancelled start", async () => {
  const ready = vi.fn();
  mocks.request.mockRejectedValueOnce(new Error("offline"));
  await expect(startInteractionCapture(binding, sources, () => 0, vi.fn(), undefined, ready)).rejects.toThrow("offline");
  const controller = new AbortController(); controller.abort();
  await startInteractionCapture(binding, sources, () => 0, vi.fn(), controller.signal, ready);
  expect(ready).not.toHaveBeenCalled();
});
