import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../api", () => ({ interactionRequest: mocks.request }));
import { startInteractionCapture } from "../capture";
const binding = { workspaceId: "w", pageId: "p", chatSessionId: "original", assistantId: "a" };
beforeEach(() => { vi.clearAllMocks(); mocks.request.mockResolvedValue({ id: "capture" }); });
it("sets up only server state and stops idempotently without WebRTC", async () => {
  const ready = vi.fn();
  const capture = await startInteractionCapture(binding, vi.fn(), undefined, ready);
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith("/start", binding);
  expect(ready).toHaveBeenCalledExactlyOnceWith("capture");
  const done = capture.stop(); expect(capture.stop()).toBe(done); await done;
  expect(mocks.request).toHaveBeenLastCalledWith("/capture/stop", {});
  expect(mocks.request).toHaveBeenCalledTimes(2);
});
it("closes stale server state if disabled during setup without publishing its ID", async () => {
  let resolve!: (value: unknown) => void;
  mocks.request.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
  const controller = new AbortController(); const ready = vi.fn();
  const pending = startInteractionCapture(binding, vi.fn(), controller.signal, ready);
  controller.abort(); resolve({ id: "late" });
  const capture = await pending; await capture.stop();
  expect(ready).not.toHaveBeenCalled();
  expect(mocks.request).toHaveBeenLastCalledWith("/late/stop", {});
  expect(mocks.request).toHaveBeenCalledTimes(2);
});
it("reports server stop failure without cancelling accepted jobs", async () => {
  const gap = vi.fn();
  const capture = await startInteractionCapture(binding, gap);
  mocks.request.mockRejectedValueOnce(new Error("offline")); await capture.stop();
  expect(gap).toHaveBeenCalled();
  expect(mocks.request.mock.calls.some(([path]) => path.includes("cancel"))).toBe(false);
});
it("does not publish failed starts", async () => {
  const ready = vi.fn(); mocks.request.mockRejectedValueOnce(new Error("offline"));
  await expect(startInteractionCapture(binding, vi.fn(), undefined, ready)).rejects.toThrow("offline");
  expect(ready).not.toHaveBeenCalled();
});
