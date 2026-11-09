// @vitest-environment jsdom
/** External human consent reuses the real card, not native tool execution authority. */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalActionConfirmation as Request } from "@/lib/api/pending-questions";

const api = vi.hoisted(() => ({ respondByKind: vi.fn(), answerExternalQuestion: vi.fn(), resume: vi.fn(), nativeSubmit: vi.fn(), nativeCancel: vi.fn() }));
vi.mock("@/lib/api/approvals", () => ({ respondByKind: api.respondByKind, answerExternalQuestion: api.answerExternalQuestion }));
vi.mock("@/lib/api/pending-questions", () => ({ submitAnswer: api.nativeSubmit, cancelPendingQuestion: api.nativeCancel }));
// The real card is deliberately not mocked. Any accidental network/resume work fails the test.
vi.mock("@/lib/auth-fetch", () => ({ authFetch: api.resume }));
vi.mock("@/lib/i18n/client", async () => {
  const { en } = await import("@/lib/i18n/dictionaries/en");
  return { useT: () => en, useLocale: () => "en" };
});
import { en } from "@/lib/i18n/dictionaries/en";
import { ExternalActionConfirmation } from "../external-action-confirmation";

const t = en.chatApp.approvalReview;
let host: HTMLDivElement, root: Root;
const request = (over: Partial<Request> = {}): Request => ({
  approvalId: "external-1", title: "Approve <b>literal title</b>\nSecond title line",
  message: `${"Full request, not a truncated summary. ".repeat(50)}\n<script>not executable</script>\n[not a link](https://example.com)`,
  options: ["Allow once", "Deny"], expiresAt: "2099-01-01T00:00:00Z", ...over,
});
const render = async (props: { request?: Request; onResolved?: () => void } = {}) => {
  await act(async () => root.render(<ExternalActionConfirmation workspaceId="ws-1" request={props.request ?? request()} onResolved={props.onResolved} />));
};
const buttons = () => Array.from(host.querySelectorAll("button"));
const button = (label: string) => {
  const found = buttons().find((el) => el.textContent === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
};
const click = async (label: string) => { await act(async () => button(label).click()); };

beforeEach(() => {
  api.respondByKind.mockReset().mockResolvedValue({ ok: true, status: "approved" });
  api.answerExternalQuestion.mockReset().mockResolvedValue({ ok: true, status: "answered" });
  api.resume.mockReset().mockImplementation(() => { throw new Error("External consent must not resume a chat"); });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.useRealTimers();
  expect(api.resume).not.toHaveBeenCalled();
  expect(api.nativeSubmit).not.toHaveBeenCalled();
  expect(api.nativeCancel).not.toHaveBeenCalled();
});

describe("[COMP:app-web/external-action-confirmation] independent external consent", () => {
  it("renders the complete literal title and message with only the two one-time decisions", async () => {
    const row = request(); await render({ request: row });
    expect(host.textContent).toContain(row.title);
    expect(host.textContent).toContain(row.message);
    expect(host.querySelector("b, script, a, textarea, input, details")).toBeNull();
    expect(buttons().map((el) => el.textContent)).toEqual(["Allow once", "Deny"]);
    for (const value of [row.title, row.message]) {
      const node = Array.from(host.querySelectorAll("div, p")).find((el) => el.textContent === value);
      expect(node?.className).toContain("whitespace-pre-wrap");
    }
  });

  it.each([["Allow once", "approved", t.allowed], ["Deny", "rejected", t.denied]])("%s routes only external_action and resolves once", async (label, decision, outcome) => {
    api.respondByKind.mockResolvedValueOnce({ ok: true, status: decision });
    const onResolved = vi.fn(); await render({ onResolved }); await click(label);
    expect(api.respondByKind).toHaveBeenCalledExactlyOnceWith({ id: "external-1", kind: "external_action" }, decision);
    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="status"]')?.textContent).toBe(outcome);
    expect(buttons()).toHaveLength(0);
  });

  it("locks synchronously against competing clicks before React updates", async () => {
    let resolve!: (result: { ok: true; status: string }) => void;
    api.respondByKind.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const onResolved = vi.fn(); await render({ onResolved });
    const allow = button("Allow once"), deny = button("Deny");
    await act(async () => { allow.click(); deny.click(); allow.click(); });
    expect(api.respondByKind).toHaveBeenCalledTimes(1);
    expect(buttons().every((el) => el.disabled)).toBe(true);
    expect(onResolved).not.toHaveBeenCalled();
    await act(async () => resolve({ ok: true, status: "approved" }));
    expect(onResolved).toHaveBeenCalledTimes(1);
  });

  it.each(["2000-01-01T00:00:00Z", "invalid"])("disables expired or invalid expiry %s", async (expiresAt) => {
    await render({ request: request({ expiresAt }) });
    expect(buttons().every((el) => el.disabled)).toBe(true);
    expect(host.textContent).toContain(t.expired);
    await act(async () => buttons().forEach((el) => el.click()));
    expect(api.respondByKind).not.toHaveBeenCalled();
  });

  it("disables an open request when its expiry passes", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    await render({ request: request({ expiresAt: "2026-01-01T00:00:01Z" }) });
    expect(button("Allow once").disabled).toBe(false);
    await act(async () => { vi.advanceTimersByTime(1001); });
    expect(buttons().every((el) => el.disabled)).toBe(true);
    expect(host.textContent).toContain(t.expired);
    expect(api.respondByKind).not.toHaveBeenCalled();
  });

  it("reports a 409 competing decision as changed, never as this person's allowance", async () => {
    api.respondByKind.mockResolvedValueOnce({ ok: false, status: 409, error: "external_approval_changed" });
    const onResolved = vi.fn(); await render({ onResolved }); await click("Allow once");
    expect(host.querySelector('[role="status"]')?.textContent).toBe(t.changed);
    expect(host.textContent).not.toContain(t.allowed);
    expect(buttons()).toHaveLength(0);
    expect(onResolved).toHaveBeenCalledTimes(1);
  });

  it("keeps a network failure retryable and only resolves after a successful retry", async () => {
    api.respondByKind.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ ok: true, status: "rejected" });
    const onResolved = vi.fn(); await render({ onResolved }); await click("Allow once");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(t.decisionFailed);
    expect(buttons().every((el) => !el.disabled)).toBe(true);
    expect(onResolved).not.toHaveBeenCalled();
    await click("Deny");
    expect(api.respondByKind).toHaveBeenCalledTimes(2);
    expect(api.respondByKind).toHaveBeenLastCalledWith({ id: "external-1", kind: "external_action" }, "rejected");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toBe(t.denied);
    expect(onResolved).toHaveBeenCalledTimes(1);
  });
});


const typeAnswer = async (value: string) => {
  await act(async () => {
    const input = host.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const question = (over: Partial<Request> = {}) => request({ method: "question", options: undefined, ...over });
const selectAnswer = async (label: string) => {
  await act(async () => { (host.querySelector('[role="combobox"]') as HTMLButtonElement).click(); });
  const item = Array.from(document.querySelectorAll('[role="option"]')).find(el => el.textContent === label);
  expect(item).toBeTruthy();
  await act(async () => (item as HTMLElement).click());
};
describe("[COMP:app-web/external-action-confirmation] external questions", () => {
  it("shows the full literal question, submits raw whitespace without native decisions", async () => {
    const row = question(); await render({ request: row });
    expect(host.textContent).toContain(row.title);
    expect(host.textContent).toContain(row.message);
    expect(host.querySelector("form")?.getAttribute("aria-label")).toBe(row.title);
    expect(host.textContent).toContain(en.chat.pendingQuestion.heading);
    expect(host.querySelector("textarea")?.placeholder).toBe(en.chat.pendingQuestion.placeholder);
    expect(document.activeElement).not.toBe(host.querySelector("textarea"));
    expect(host.querySelector("script, b, a")).toBeNull();
    expect(buttons().map(el => el.textContent)).toEqual([en.chat.pendingQuestion.submit]);
    expect(host.querySelector("label")?.htmlFor).toBe(host.querySelector("textarea")?.id);
    expect(button(en.chat.pendingQuestion.submit).disabled).toBe(true);
    await typeAnswer(" \t\n "); expect(button(en.chat.pendingQuestion.submit).disabled).toBe(true);
    const literal = "  <b>raw</b>\nanswer\t  "; await typeAnswer(literal); await click(en.chat.pendingQuestion.submit);
    expect(api.answerExternalQuestion).toHaveBeenCalledExactlyOnceWith("external-1", literal);
    expect(api.respondByKind).not.toHaveBeenCalled();
    expect(host.textContent).toBe(t.answered);
  });
  it("does not truncate an overlong answer or submit it", async () => {
    await render({ request: question() });
    await typeAnswer("x".repeat(32769));
    expect(host.querySelector("textarea")?.value).toHaveLength(32769);
    expect(button(en.chat.pendingQuestion.submit).disabled).toBe(true);
    await typeAnswer("x".repeat(32768));
    expect(button(en.chat.pendingQuestion.submit).disabled).toBe(false);
  });
  it("keeps the mounted draft through a network failure and retries only explicitly", async () => {
    api.answerExternalQuestion.mockRejectedValueOnce(new Error("offline"));
    const onResolved = vi.fn(); const row = question(); await render({ request: row, onResolved });
    await typeAnswer("  retry\n "); await click(en.chat.pendingQuestion.submit);
    await render({ request: { ...row }, onResolved });
    expect(host.querySelector("textarea")?.value).toBe("  retry\n ");
    expect(host.textContent).toContain(t.answerFailed); expect(onResolved).not.toHaveBeenCalled();
    expect(api.answerExternalQuestion).toHaveBeenCalledTimes(1);
    await click(en.chat.pendingQuestion.submit); expect(onResolved).toHaveBeenCalledTimes(1);
    expect(api.answerExternalQuestion).toHaveBeenLastCalledWith("external-1", "  retry\n ");
  });
  it.each([403, 404, 409, 410])("reports changed rather than the attempted answer on %s", async status => {
    api.answerExternalQuestion.mockResolvedValueOnce({ ok: false, status });
    await render({ request: question() }); await typeAnswer("mine"); await click(en.chat.pendingQuestion.submit);
    expect(host.textContent).toBe(t.changed); expect(host.textContent).not.toContain(t.answered);
  });
  it("disables a mounted question and retains its draft when expiry passes", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    await render({ request: question({ expiresAt: "2026-01-01T00:00:01Z" }) });
    await typeAnswer("draft");
    await act(async () => { vi.advanceTimersByTime(1001); });
    expect(host.querySelector("textarea")?.value).toBe("draft");
    expect(host.querySelector("textarea")?.disabled).toBe(true);
    await click(en.chat.pendingQuestion.submit); expect(api.answerExternalQuestion).not.toHaveBeenCalled();
    expect(host.textContent).toContain(t.expired);
  });
  it("shows literal option text rather than internal indices after selection", async () => {
    const row = question({ options: ["Alpha", "Beta"] });
    await render({ request: row });
    expect(host.querySelector('[data-slot="select-value"]')?.textContent).toBe(t.chooseAnswer);
    await selectAnswer("Alpha");
    expect(host.querySelector('[data-slot="select-value"]')?.textContent).toBe("Alpha");
    await selectAnswer("Beta");
    await render({ request: { ...row } });
    expect(host.querySelector('[data-slot="select-value"]')?.textContent).toBe("Beta");
    await click(en.chat.pendingQuestion.submit);
    expect(api.answerExternalQuestion).toHaveBeenCalledExactlyOnceWith("external-1", "Beta");
  });
  it("offers literal closed single choices and preserves selection for retry", async () => {
    const options = ["  <b>First</b>\n ", "Second"];
    api.answerExternalQuestion.mockRejectedValueOnce(new Error("offline"));
    await render({ request: question({ options }) });
    expect(host.querySelector("textarea, select")).toBeNull();
    expect(host.textContent).toContain(options[0]);
    await selectAnswer(options[0]); await click(en.chat.pendingQuestion.submit);
    expect(api.answerExternalQuestion).toHaveBeenCalledWith("external-1", options[0]);
    expect(button(en.chat.pendingQuestion.submit).disabled).toBe(false);
    await click(en.chat.pendingQuestion.submit); expect(host.textContent).toBe(t.answered);
  });
  it("offers custom text only when explicitly allowed and retains its independent draft", async () => {
    await render({ request: question({ options: ["One", "Two"], allowCustom: true }) });
    expect(host.querySelector("textarea")).toBeNull();
    await selectAnswer(t.customAnswer); await typeAnswer(" custom\n ");
    expect(host.querySelector('[data-slot="select-value"]')?.textContent).toBe(t.customAnswer);
    await selectAnswer("One"); expect(host.querySelector("textarea")).toBeNull();
    await selectAnswer(t.customAnswer); expect(host.querySelector("textarea")?.value).toBe(" custom\n ");
    await click(en.chat.pendingQuestion.submit);
    expect(api.answerExternalQuestion).toHaveBeenCalledExactlyOnceWith("external-1", " custom\n ");
  });
  it("keeps concurrent cards independent", async () => {
    await act(async () => root.render(<><ExternalActionConfirmation workspaceId="ws-1" request={question()} /><ExternalActionConfirmation workspaceId="ws-1" request={question({ approvalId: "external-2" })} /></>));
    await typeAnswer("first");
    expect(Array.from(host.querySelectorAll("textarea")).map(el => el.value)).toEqual(["first", ""]);
    expect(new Set(Array.from(host.querySelectorAll("textarea")).map(el => el.id)).size).toBe(2);
    expect(Array.from(host.querySelectorAll("textarea"))).not.toContain(document.activeElement);
  });
  it("keeps concurrent option and text cards usable while another answer is in flight", async () => {
    let resolve!: (value: { ok: true; status: string }) => void;
    api.answerExternalQuestion.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const composer = document.createElement("textarea"); document.body.appendChild(composer); composer.focus();
    try {
      await act(async () => root.render(<>
        <ExternalActionConfirmation workspaceId="ws-1" request={question()} />
        <ExternalActionConfirmation workspaceId="ws-1" request={question({ approvalId: "external-2", options: ["  option\n ", "Other"] })} />
      </>));
      expect(document.activeElement).toBe(composer);
      await typeAnswer("first");
      const first = button(en.chat.pendingQuestion.submit);
      await act(async () => { first.click(); first.click(); });
      expect(api.answerExternalQuestion).toHaveBeenCalledTimes(1);
      expect(host.querySelector("textarea")?.disabled).toBe(true);
      expect((host.querySelector('[role="combobox"]') as HTMLButtonElement).disabled).toBe(false);
      expect(composer.disabled).toBe(false);
      await selectAnswer("  option\n ");
      const sends = buttons().filter(el => el.textContent === en.chat.pendingQuestion.submit);
      expect(sends).toHaveLength(1); expect(sends[0].disabled).toBe(false);
      await act(async () => sends[0].click());
      expect(api.answerExternalQuestion).toHaveBeenLastCalledWith("external-2", "  option\n ");
      await act(async () => resolve({ ok: true, status: "answered" }));
    } finally { composer.remove(); }
  });
});
