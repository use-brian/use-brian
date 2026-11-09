// @vitest-environment jsdom
/** External human consent reuses the real card, not native tool execution authority. */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalActionConfirmation as Request } from "@/lib/api/pending-questions";

const api = vi.hoisted(() => ({ respondByKind: vi.fn(), resume: vi.fn() }));
vi.mock("@/lib/api/approvals", () => ({ respondByKind: api.respondByKind }));
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
  api.resume.mockReset().mockImplementation(() => { throw new Error("External consent must not resume a chat"); });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.useRealTimers();
  expect(api.resume).not.toHaveBeenCalled();
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
