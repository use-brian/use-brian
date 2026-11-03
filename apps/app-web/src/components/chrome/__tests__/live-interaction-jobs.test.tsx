// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InteractionRequestError } from "@/lib/live-interaction/api";
import { en } from "@/lib/i18n/dictionaries/en";
const mocks = vi.hoisted(() => ({ request: vi.fn(), messages: vi.fn(), prompt: vi.fn() }));
vi.mock("@/lib/live-interaction/api", () => ({ interactionRequest: mocks.request, InteractionRequestError: class extends Error { constructor(public status: number) { super(`Interaction ${status}`); } } }));
vi.mock("@/lib/api/sessions", () => ({ fetchSessionMessages: mocks.messages }));
vi.mock("@/lib/i18n/client", () => ({ useT: () => en }));
vi.mock("@/components/ui/button", () => ({ Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} /> }));
vi.mock("@/components/ui/prompt-dialog", () => ({ promptDialog: mocks.prompt }));
import { LiveInteractionJobs, LiveInteractionQuestionControls } from "../live-interaction-jobs";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let container: HTMLDivElement;
const canonical = vi.fn();
const job = (id: string, status = "running") => ({ id, captureId: "capture", chatSessionId: "original", pageId: "page", question: `question ${id}`, answer: `answer ${id}`, status, error: null, createdAt: "2026-01-01", userMessageId: `q-${id}`, assistantMessageId: `a-${id}` });
async function render(sessionId = "original", messageIds = new Set<string>(), recordingSessionId: string | null = sessionId) {
  await act(async () => root.render(<LiveInteractionJobs workspaceId="workspace" sessionId={sessionId} recordingSessionId={recordingSessionId} recordingCaptureId={recordingSessionId ? "capture" : null} messageIds={messageIds} onCanonical={canonical} />));
}
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  mocks.request.mockResolvedValue({ jobs: [] }); mocks.messages.mockResolvedValue([]);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); });
describe("[COMP:app-web/live-interaction-jobs] active recording checks", () => {
it("renders concurrent answers separately, filters other chats, and cancels/retries by stable job id", async () => {
  mocks.request.mockResolvedValue({ jobs: [job("one"), job("two", "failed"), { ...job("foreign"), chatSessionId: "other" }] });
  await render();
  expect(container.querySelectorAll("article")).toHaveLength(2);
  expect(container.textContent).not.toContain("foreign");
  const buttons = [...container.querySelectorAll("button")];
  await act(async () => buttons[0].click()); await act(async () => buttons.find((button) => button.textContent === en.liveInteraction.retry)!.click());
  expect(mocks.request).toHaveBeenCalledWith("/jobs/one/cancel", {});
  expect(mocks.request).toHaveBeenCalledWith("/jobs/two/retry", {});
});
it("waits for both canonical rows, removes the provisional pair after handoff, and avoids repeated full refresh", async () => {
  mocks.request.mockResolvedValue({ jobs: [job("one", "completed")] });
  mocks.messages.mockResolvedValueOnce([{ id: "q-one" }]);
  await render();
  expect(canonical.mock.calls[0][2].size).toBe(0);
  expect(container.querySelectorAll("article")).toHaveLength(1);
  mocks.messages.mockResolvedValue([{ id: "a-one" }, { id: "q-one" }]);
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect([...canonical.mock.calls.at(-1)![2]]).toEqual(["q-one", "a-one"]);
  await render("original", new Set(["q-one", "a-one"]));
  expect(container.querySelectorAll("article")).toHaveLength(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(mocks.messages).toHaveBeenCalledTimes(2);
});
it("does not publish an old canonical fetch after switching chats", async () => {
  let resolve!: (value: unknown) => void;
  mocks.request.mockResolvedValueOnce({ jobs: [job("one", "completed")] });
  mocks.messages.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
  await render(); await render("other");
  await act(async () => resolve([{ id: "q-one" }, { id: "a-one" }]));
  expect(canonical).not.toHaveBeenCalled(); expect(container.textContent).not.toContain("question one");
});
it("keeps background poll failures quiet and reports explicit action failures", async () => {
  mocks.request.mockRejectedValueOnce(new Error("offline")); await render();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  mocks.request.mockResolvedValue({ jobs: [job("one")] });
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(container.querySelector('[role="alert"]')).toBeNull();
  mocks.request.mockRejectedValueOnce(new Error("cancel failed"));
  await act(async () => container.querySelector("button")!.click());
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
});

it("edits with the original question, cancels the prior job, and submits a new manual occurrence", async () => {
  mocks.request.mockResolvedValue({ jobs: [job("one", "failed")] });
  mocks.prompt.mockResolvedValue("Corrected question?");
  await render();
  await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent === en.liveInteraction.editQuestion)!.click());
  expect(mocks.prompt).toHaveBeenCalledWith(expect.objectContaining({ defaultValue: "question one" }));
  const calls = mocks.request.mock.calls;
  expect(calls).toContainEqual(["/jobs/one/cancel", {}]);
  expect(calls).toContainEqual(["/capture/question", { id: expect.any(String), action: "submit", text: "Corrected question?" }]);
});
it("asks explicitly and cancels pending detection without uploading typed speech", async () => {
  mocks.prompt.mockResolvedValue("Ask this now");
  await act(async () => root.render(<LiveInteractionQuestionControls captureId="capture" />));
  await act(async () => container.querySelectorAll("button")[0].click());
  await act(async () => container.querySelectorAll("button")[1].click());
  expect(mocks.request.mock.calls).toEqual([
    ["/capture/question", { id: expect.any(String), action: "submit", text: "Ask this now" }],
    ["/capture/question", { id: expect.any(String), action: "cancel" }],
  ]);
  expect(mocks.request.mock.calls[0][1].id).not.toBe(mocks.request.mock.calls[1][1].id);
});
it("does nothing when the correction prompt is dismissed", async () => {
  mocks.request.mockResolvedValue({ jobs: [job("one")] });
  mocks.prompt.mockResolvedValue(null);
  await render(); mocks.request.mockClear();
  await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent === en.liveInteraction.editQuestion)!.click());
  expect(mocks.request).not.toHaveBeenCalled();
});

it.each([null, "another-chat"])("makes no voice requests without this chat's active capture (%s)", async (recordingSessionId) => {
  await render("original", new Set(), recordingSessionId);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(mocks.request).not.toHaveBeenCalled();
  expect(container.childElementCount).toBe(0);
});
it("starts with recording, stops on recording end, and can start again", async () => {
  await render("original", new Set(), null);
  expect(mocks.request).not.toHaveBeenCalled();
  await render();
  expect(mocks.request).toHaveBeenCalledTimes(1);
  await render("original", new Set(), null);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(mocks.request).toHaveBeenCalledTimes(2); // final settling read
  expect(container.textContent).toBe("");
  await render();
  expect(mocks.request).toHaveBeenCalledTimes(3);
});
it("ignores a pending voice response after recording stops", async () => {
  let resolve!: (value: unknown) => void;
  mocks.request.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await render();
  await render("original", new Set(), null);
  await act(async () => resolve({ jobs: [job("one", "completed")] }));
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(mocks.messages).not.toHaveBeenCalled();
  expect(canonical).not.toHaveBeenCalled();
  expect(mocks.request).toHaveBeenCalledTimes(2); // stopped capture is checked once
  expect(container.textContent).toBe("");
});
it("does not turn capture summaries into transcript errors", async () => {
  mocks.request.mockResolvedValue({ jobs: [], captureErrors: [{ captureId: "capture", error: "missed" }] });
  await render();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toBe("");
});

it("finishes final speech detection and submitted jobs after Stop, then stops checking", async () => {
  mocks.request.mockResolvedValue({ jobs: [], processing: true });
  await render();
  await render("original", new Set(), null);
  mocks.request.mockResolvedValue({ jobs: [job("one")], processing: false });
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(container.textContent).toContain("question one");
  mocks.request.mockResolvedValue({ jobs: [job("one", "completed")], processing: false });
  mocks.messages.mockResolvedValue([{ id: "q-one" }, { id: "a-one" }]);
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(canonical).toHaveBeenCalled();
  await render("original", new Set(["q-one", "a-one"]), null);
  const count = mocks.request.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(mocks.request).toHaveBeenCalledTimes(count);
  expect(container.textContent).toBe("");
});
it("retains failed job recovery after Stop and rechecks only when Retry is requested", async () => {
  mocks.request.mockResolvedValue({ jobs: [job("one", "failed")], processing: false });
  await render(); await render("original", new Set(), null);
  const count = mocks.request.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(mocks.request).toHaveBeenCalledTimes(count);
  expect(container.textContent).toContain("question one");
  await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === en.liveInteraction.retry)!.click());
  expect(mocks.request.mock.calls.length).toBeGreaterThan(count + 1);
});

it("does not keep discovery alive for an unrelated historical capture", async () => {
  mocks.request.mockResolvedValue({ jobs: [{ ...job("historic"), captureId: "unrelated" }], processing: false });
  await render(); await render("original", new Set(), null);
  const count = mocks.request.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(mocks.request).toHaveBeenCalledTimes(count);
  expect(container.childElementCount).toBe(0);
});

it.each([400, 401, 403, 404])("clears cards and stops settling after a definite denial (%s)", async status => {
  mocks.request.mockResolvedValue({ jobs: [job("one")], processing: true });
  await render();
  mocks.request.mockRejectedValue(new InteractionRequestError(status));
  await render("original", new Set(), null);
  const count = mocks.request.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(mocks.request).toHaveBeenCalledTimes(count);
  expect(container.childElementCount).toBe(0);
});

});
