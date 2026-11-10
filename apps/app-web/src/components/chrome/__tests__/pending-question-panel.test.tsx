// @vitest-environment jsdom
/** [COMP:app-web/question-answer-form] Native transport stays in the wrapper. */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), confirm: vi.fn(), connect: vi.fn() }));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: mocks.fetch }));
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: mocks.confirm }));
vi.mock("@/lib/connector-authorization-popup", () => ({ supportsInlineConnector: () => true, openConnectorAuthorization: mocks.connect }));
import { PendingQuestionPanel } from "../pending-question-panel";
import { en } from "@/lib/i18n/dictionaries/en";
const t = en.chat.pendingQuestion;
let host: HTMLDivElement, root: Root;
const answered = vi.fn(), cancelled = vi.fn();
const reply = (body = {}, status = 200) => new Response(JSON.stringify(body), { status });
const render = async (props = {}) => {
  await act(async () => root.render(<PendingQuestionPanel sessionId="session" approvalId="approval" dict={t}
    onAnswered={answered} onCancelled={cancelled} action={null} {...props} />));
};
const click = async (label: string) => {
  const button = Array.from(host.querySelectorAll("button")).find(el => el.textContent === label)!;
  await act(async () => button.click());
};
const type = async (value: string) => {
  await act(async () => {
    const input = host.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
beforeEach(() => {
  mocks.fetch.mockReset().mockImplementation(() => Promise.resolve(reply()));
  mocks.confirm.mockReset().mockResolvedValue(true); mocks.connect.mockReset(); answered.mockReset(); cancelled.mockReset();
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe("[COMP:app-web/question-answer-form] native wrapper", () => {
  it("retains native autofocus, trims to the native answer endpoint and notifies once", async () => {
    await render(); expect(document.activeElement).toBe(host.querySelector("textarea"));
    await type("  answer\n  "); await click(t.submit);
    expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/\/api\/sessions\/session\/answer\/approval$/), expect.objectContaining({ method: "POST", body: JSON.stringify({ answer: "answer" }) }));
    expect(answered).toHaveBeenCalledOnce(); expect(cancelled).not.toHaveBeenCalled();
    expect(host.querySelector("textarea")?.value).toBe("");
  });
  it("confirms cancellation, calls only native cancel and notifies onCancelled", async () => {
    await render(); await click(t.cancel);
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: t.cancel, description: t.cancelConfirm, cancelLabel: t.cancelConfirmKeep }));
    expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/\/api\/sessions\/session\/cancel\/approval$/), expect.objectContaining({ method: "POST", body: "{}" }));
    expect(cancelled).toHaveBeenCalledOnce(); expect(answered).not.toHaveBeenCalled();
  });
  it("leaves an unconfirmed cancellation alone", async () => {
    mocks.confirm.mockResolvedValueOnce(false); await render(); await click(t.cancel);
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(cancelled).not.toHaveBeenCalled();
  });
  it("keeps native error drafts retryable and respects idempotent already-answered", async () => {
    mocks.fetch.mockResolvedValueOnce(reply({ error: "retry" }, 503)).mockResolvedValueOnce(reply({ idempotent: true }, 409));
    await render(); await type(" draft "); await click(t.submit);
    expect(host.textContent).toContain("retry"); expect(host.querySelector("textarea")?.value).toBe(" draft ");
    expect(answered).not.toHaveBeenCalled(); await click(t.submit); expect(answered).toHaveBeenCalledOnce();
  });
  it("resolves connector actions before showing answer controls and preserves connect/cancel behavior", async () => {
    const action = { kind: "connector_authorization", provider: "gcal", label: "Google Calendar", connectPath: "/connect" };
    mocks.fetch.mockResolvedValueOnce(reply({ pending: { approvalId: "approval", action } }));
    await render({ action: undefined });
    expect(mocks.fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/sessions\/session\/pending$/));
    expect(host.querySelector("textarea")).toBeNull();
    await click(t.connectAction);
    expect(mocks.connect).toHaveBeenCalledWith(expect.objectContaining({ action, sessionId: "session", approvalId: "approval" }));
    await act(async () => mocks.connect.mock.calls[0][0].onComplete()); expect(answered).toHaveBeenCalledOnce();
    await click(t.cancel); expect(cancelled).toHaveBeenCalledOnce();
    expect(mocks.fetch.mock.calls.some(([url]) => String(url).includes("/answer/"))).toBe(false);
  });
});
