// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ fetchCrmTimeline: vi.fn(), createCrmActivity: vi.fn(), listCrmDealParticipants: vi.fn(), listApprovals: vi.fn() }));
vi.mock("@/lib/api/crm", () => api);
vi.mock("@/lib/api/approvals", () => ({ listApprovals: api.listApprovals }));
vi.mock("@/lib/crm-r2", () => ({ matchingEmailApprovals: (_record: unknown, _data: unknown, rows: unknown[]) => rows, linkedContactsForEmailApproval: () => [] }));
vi.mock("@/lib/approval-previews", () => ({ parseToolPreview: () => ({ kind: "email_send", email: { subject: "Protected draft", to: ["fixture@example.test"] } }) }));
import { CrmActivityTimeline } from "../crm-activity";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { CrmData } from "@/lib/api/crm";
import type { CrmApprovalRecord } from "@/lib/crm-r2";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const t = en.crmPage.r2;
const first = { id: "activity-a", activityType: "note", direction: "internal", occurredAt: "2026-01-01T00:00:00Z", subject: null, summary: "First protected history", sourceKind: null, metadata: {} };
const second = { ...first, id: "activity-b", summary: "Second history" };
const data = { contacts: [], companies: [], deals: [] } as unknown as CrmData;
let host: HTMLDivElement, root: Root;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); }); }
async function render(workspaceId = "workspace-a", id = "deal-a") {
  const record = { kind: "deal", row: { id } } as CrmApprovalRecord;
  await act(async () => root.render(<I18nProvider locale="en" dict={en}><CrmActivityTimeline workspaceId={workspaceId} record={record} data={data} onOpenContact={vi.fn()} onReviewEmail={vi.fn()} /></I18nProvider>));
  await settle();
}
function button(label: string) { return [...host.querySelectorAll("button")].find(node => node.textContent === label)!; }
async function click(label: string) { expect(button(label)).toBeTruthy(); await act(async () => button(label).click()); await settle(); }
async function compose() {
  await click(t.logActivity);
  const field = host.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "Fixture note");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  api.fetchCrmTimeline.mockResolvedValue([first]);
  api.listCrmDealParticipants.mockResolvedValue([]);
  api.listApprovals.mockResolvedValue([{ id: "draft-a", approvalPayload: {}, arguments: {} }]);
  api.createCrmActivity.mockResolvedValue(first);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("[COMP:app-web/crm-activity] scoped activity recovery", () => {
  it.each(["workspace", "record"])("discards a late response after changing %s", async axis => {
    const pending = deferred<typeof first[]>();
    api.fetchCrmTimeline.mockReturnValueOnce(pending.promise).mockResolvedValueOnce([second]);
    await render();
    await render(axis === "workspace" ? "workspace-b" : "workspace-a", axis === "record" ? "deal-b" : "deal-a");
    await act(async () => pending.resolve([first])); await settle();
    expect(host.textContent).toContain(second.summary);
    expect(host.textContent).not.toContain(first.summary);
  });

  it("requires a fresh authorized timeline before showing email summaries or enabling the composer", async () => {
    api.fetchCrmTimeline.mockRejectedValueOnce(new Error("Unavailable"));
    await render();
    expect(host.textContent).toContain(t.activityLoadFailed);
    expect(host.textContent).not.toContain("Protected draft");
    expect(button(t.logActivity).disabled).toBe(true);
    await click(t.retry);
    expect(host.textContent).toContain(first.summary);
    expect(host.textContent).toContain("Protected draft");
    expect(button(t.logActivity).disabled).toBe(false);
    expect(api.fetchCrmTimeline).toHaveBeenCalledTimes(2);
  });

  it.each(["approvals", "participants"])("suppresses email matches when %s cannot be read", async source => {
    (source === "approvals" ? api.listApprovals : api.listCrmDealParticipants).mockRejectedValueOnce(new Error("Unavailable"));
    await render();
    expect(host.textContent).toContain(first.summary);
    expect(host.textContent).toContain(t.approvalsLoadFailed);
    expect(host.textContent).not.toContain("Protected draft");
    await click(t.retry);
    expect(host.textContent).toContain("Protected draft");
  });

  it("evicts history, drafts and composer text on a refused save without retrying the write", async () => {
    await render(); await compose();
    api.createCrmActivity.mockRejectedValueOnce(new Error("Scope refused"));
    await click(t.saveActivity);
    expect(api.createCrmActivity).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain(t.activityLoadFailed);
    expect(host.textContent).not.toContain(first.summary);
    expect(host.textContent).not.toContain("Protected draft");
    expect(host.querySelector("textarea")).toBeNull();
    expect(button(t.logActivity).disabled).toBe(true);
    await click(t.retry);
    expect(api.createCrmActivity).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain(first.summary);
  });

  it("does not refresh a different record when an old save finishes", async () => {
    await render(); await compose();
    const pending = deferred<typeof first>();
    api.createCrmActivity.mockReturnValueOnce(pending.promise);
    await click(t.saveActivity);
    api.fetchCrmTimeline.mockResolvedValueOnce([second]);
    await render("workspace-a", "deal-b");
    const reads = api.fetchCrmTimeline.mock.calls.length;
    await act(async () => pending.resolve(first)); await settle();
    expect(host.textContent).toContain(second.summary);
    expect(host.textContent).not.toContain(first.summary);
    expect(api.fetchCrmTimeline).toHaveBeenCalledTimes(reads);
  });
});
