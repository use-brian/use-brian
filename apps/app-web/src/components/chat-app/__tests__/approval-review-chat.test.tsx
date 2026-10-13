// @vitest-environment jsdom
/**
 * Chat attention and reviewer controls (features/approval-review.md ->
 * "Surfaces"; chat-app.md -> "Attention"): the badge counts unseen
 * server-derived items, opening marks them seen, the list narrows to this
 * chat's Project or session, a waiting request shows its reviewer and why it
 * is still with the person, "ask the reviewer" and explicit request
 * assignment go through the shared API, patterns revoke with confirmation
 * and expected revision, a failed load is never shown as "nothing", the
 * workspace approval signal refreshes it, tap targets meet the phone size,
 * and all four locales carry the copy. The workflow default reviewer is an
 * explicit assignment. HTTP is mocked; component state and signals are real.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionItem } from "@/lib/api/approval-review";

const api = vi.hoisted(() => ({
  fetchAttention: vi.fn(),
  markAttentionSeen: vi.fn(async () => ({ marked: 1 })),
  requestReview: vi.fn(),
  assignReviewer: vi.fn(async () => ({ outcome: "created", assignment: {} })),
  revokeReviewer: vi.fn(async () => ({})),
  changeReviewer: vi.fn(async () => ({})),
  listPatterns: vi.fn(),
  revokePattern: vi.fn(async () => ({})),
  listAssignments: vi.fn(),
  listWorkspaceAssistants: vi.fn(async () => [{ id: "rev-1", name: "Ops" }, { id: "rev-2", name: "Brian" }]),
  confirmDialog: vi.fn(async () => true),
}));
vi.mock("@/lib/api/approval-review", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/approval-review")>()),
  fetchAttention: api.fetchAttention, markAttentionSeen: api.markAttentionSeen, requestReview: api.requestReview,
  assignReviewer: api.assignReviewer, revokeReviewer: api.revokeReviewer, changeReviewer: api.changeReviewer,
  listPatterns: api.listPatterns, revokePattern: api.revokePattern, listAssignments: api.listAssignments,
}));
vi.mock("@/lib/api/views", () => ({ listWorkspaceAssistants: api.listWorkspaceAssistants }));
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: api.confirmDialog }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
// Minimal popover: the trigger toggles, the content renders while open.
vi.mock("@/components/ui/popover", () => {
  const Ctx = React.createContext<{ open: boolean; set: (v: boolean) => void }>({ open: false, set: () => {} });
  return {
    Popover: ({ open, onOpenChange, children }: { open: boolean; onOpenChange: (v: boolean) => void; children: React.ReactNode }) =>
      <Ctx.Provider value={{ open, set: onOpenChange }}>{children}</Ctx.Provider>,
    PopoverTrigger: ({ children, ...rest }: { children: React.ReactNode }) => {
      const c = React.useContext(Ctx)
      return <button type="button" {...rest} onClick={() => c.set(!c.open)}>{children}</button>
    },
    PopoverContent: ({ children }: { children: React.ReactNode }) => {
      const c = React.useContext(Ctx)
      return c.open ? <div data-testid="popover">{children}</div> : null
    },
  };
});
vi.mock("@/components/ui/searchable-select", () => ({
  SearchableSelect: ({ items, onValueChange, ...rest }: { items: Array<{ value: string; label: string }>; onValueChange: (v: string) => void; "aria-label"?: string }) =>
    <div data-testid="select" aria-label={rest["aria-label"]}>{items.map((i) => <button key={i.value} type="button" data-item={i.value} onClick={() => onValueChange(i.value)}>{i.label}</button>)}</div>,
}));
vi.mock("@/lib/i18n/client", async () => {
  const { en } = await import("@/lib/i18n/dictionaries/en");
  return { useT: () => en, useLocale: () => "en", format: (text: string, vars: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_m, key) => String(vars[key] ?? "")) };
});
import { en } from "@/lib/i18n/dictionaries/en";
import { ja } from "@/lib/i18n/dictionaries/ja";
import { zh } from "@/lib/i18n/dictionaries/zh";
import { zhCN } from "@/lib/i18n/dictionaries/zh-cn";
import { requestApprovalsRefresh } from "@/lib/approvals-events";
import { ApprovalReviewAttention, reasonText } from "../approval-review-attention";
import { WorkflowReviewerSetting } from "@/components/workflow/workflow-reviewer-setting";

const t = en.chatApp.approvalReview;
let host: HTMLDivElement, root: Root, ws = "";
let seq = 0;
const render = async (node: React.ReactNode) => { await act(async () => root.render(node)); await flush(); };
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const button = (label: string) => Array.from(host.querySelectorAll("button")).find((b) => b.textContent === label);
const click = async (el: Element | undefined | null) => { if (!el) throw new Error("missing element"); await act(async () => (el as HTMLElement).click()); await flush(); };

const waiting = (over: Partial<Extract<AttentionItem, { kind: "approval_waiting" }>> = {}): AttentionItem => ({
  key: "approval:ap-1", kind: "approval_waiting", approvalId: "ap-1", approvalKind: "workflow_step", toolName: "slackPostMessage",
  summary: "Post the fictional daily digest", createdAt: "2026-10-13T00:00:00Z", sessionId: "s-1", workflowRunId: "run-1", projectIds: ["p-1"],
  review: { assignmentId: "as-1", reviewerAssistantId: "rev-1", reviewerName: "Ops", lastAttempt: { outcome: "needs_human", reasons: ["no_active_pattern", "human_only:payment"], at: "2026-10-13T00:00:00Z" } },
  seen: false, ...over,
});

beforeEach(() => {
  ws = `ws-${++seq}`;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  for (const fn of Object.values(api)) fn.mockClear();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe("[COMP:app-web/approval-review-chat] chat attention and reviewer controls", () => {
  it("badges unseen items, marks them seen on open and narrows the list to this chat's Project", async () => {
    api.fetchAttention.mockResolvedValue({ items: [waiting()], unseen: 1 });
    await render(<ApprovalReviewAttention workspaceId={ws} sessionId="s-1" projectId="p-1" />);
    const trigger = host.querySelector('[data-testid="approval-review-attention"]')!;
    expect(trigger.getAttribute("aria-label")).toBe(t.iconLabelCount.replace("{count}", "1"));
    expect(trigger.className).toContain("max-md:size-11");
    await click(trigger);
    expect(api.markAttentionSeen).toHaveBeenCalledWith(ws, ["approval:ap-1"]);
    expect(api.fetchAttention).toHaveBeenCalledWith(ws, { projectId: "p-1", sessionId: "s-1" });
    expect(host.textContent).toContain(t.waiting);
    expect(host.textContent).toContain(t.reviewer.replace("{name}", "Ops"));
    expect(host.textContent).toContain(t.reasons.no_active_pattern);
    expect(host.textContent).toContain(t.reasons.human_only);
    await click(button(t.scopeAll));
    // "Everywhere" is the unscoped list the badge already holds.
    expect(api.fetchAttention.mock.calls.some((c) => c.length === 1 && c[0] === ws)).toBe(true);
    expect(host.textContent).toContain(t.waiting);
  });

  it("asks the assigned reviewer and reports the server's decision, never its own", async () => {
    api.fetchAttention.mockResolvedValue({ items: [waiting()], unseen: 0 });
    api.requestReview.mockResolvedValueOnce({ outcome: "needs_human", reasons: ["no_active_pattern"] })
      .mockResolvedValueOnce({ outcome: "resolved", receipt: { id: "r-1", reviewerAssistantId: "rev-1" }, replay: false });
    await render(<ApprovalReviewAttention workspaceId={ws} sessionId={null} projectId={null} />);
    await click(host.querySelector('[data-testid="approval-review-attention"]'));
    await click(button(t.reviewNow));
    expect(api.requestReview).toHaveBeenCalledWith(ws, "ap-1");
    expect(host.textContent).toContain(t.reviewLeft);
    await click(button(t.reviewNow));
    expect(host.textContent).toContain(t.reviewResolved.replace("{name}", "Ops"));
  });

  it("assigns a reviewer to exactly this request with a fresh idempotency key", async () => {
    api.fetchAttention.mockResolvedValue({ items: [waiting({ review: null })], unseen: 0 });
    await render(<ApprovalReviewAttention workspaceId={ws} sessionId={null} projectId={null} />);
    await click(host.querySelector('[data-testid="approval-review-attention"]'));
    expect(host.textContent).toContain(t.noReviewer);
    await click(button(t.assign));
    await click(host.querySelector('[data-item="rev-1"]'));
    await click(button(t.assignSave));
    expect(api.assignReviewer).toHaveBeenCalledWith(ws, expect.objectContaining({ reviewerAssistantId: "rev-1", scopeKind: "request", scopeId: "ap-1", idempotencyKey: expect.stringMatching(/^chat-assign-/) }));
  });

  it("shows decisions made on the person's behalf and route blockers with links to the real work", async () => {
    api.fetchAttention.mockResolvedValue({ unseen: 0, items: [
      { key: "decision:r-1", kind: "delegated_decision", approvalId: "ap-2", receiptId: "r-1", reviewerAssistantId: "rev-1", reviewerName: "Ops", toolName: "slackPostMessage", decidedAt: "2026-10-13T00:00:00Z", invalidated: true, sessionId: null, projectIds: [], seen: true },
      { key: "route:e-1", kind: "route_blocker", eventId: "e-1", workflowId: "wf-1", blocker: "reconcile_before_retry", createdAt: "2026-10-13T00:00:00Z", projectIds: [], seen: true },
    ] });
    await render(<ApprovalReviewAttention workspaceId={ws} sessionId={null} projectId={null} />);
    await click(host.querySelector('[data-testid="approval-review-attention"]'));
    expect(host.textContent).toContain(t.decidedInvalid.replace("{name}", "Ops"));
    expect(host.textContent).toContain(t.routeBlockers.reconcile_before_retry);
    expect(host.querySelector(`a[href="/w/${ws}/workflow/wf-1"]`)).toBeTruthy();
    expect(host.querySelector(`a[href="/w/${ws}/p?panel=approvals&approval=ap-2"]`)).toBeTruthy();
  });

  it("a failed load is an error with retry, never an empty list; the approval signal refreshes", async () => {
    api.fetchAttention.mockRejectedValue(new Error("boom"));
    await render(<ApprovalReviewAttention workspaceId={ws} sessionId={null} projectId={null} />);
    await click(host.querySelector('[data-testid="approval-review-attention"]'));
    expect(host.textContent).toContain(t.unavailable);
    expect(host.textContent).not.toContain(t.empty);
    api.fetchAttention.mockResolvedValue({ items: [], unseen: 0 });
    const before = api.fetchAttention.mock.calls.length;
    await act(async () => requestApprovalsRefresh(ws));
    await flush();
    expect(api.fetchAttention.mock.calls.length).toBeGreaterThan(before);
    expect(host.textContent).toContain(t.empty);
  });

  it("revokes a pattern only after confirmation, with its expected revision", async () => {
    api.fetchAttention.mockResolvedValue({ items: [], unseen: 0 });
    api.listPatterns.mockResolvedValue({ patterns: [{ id: "pt-1", status: "active", version: 1, revision: 4, actionKind: "slackPostMessage", procedureKind: "workflow", procedureId: "wf-1", suspendedReason: null, support: { approvedChains: 3, required: 3, contradicted: false }, updatedAt: "2026-10-13T00:00:00Z" }] });
    await render(<ApprovalReviewAttention workspaceId={ws} sessionId={null} projectId={null} />);
    await click(host.querySelector('[data-testid="approval-review-attention"]'));
    await click(button(t.tabPatterns));
    expect(host.textContent).toContain(t.patternSupport.replace("{count}", "3").replace("{required}", "3"))
    api.confirmDialog.mockResolvedValueOnce(false);
    await click(button(t.revoke));
    expect(api.revokePattern).not.toHaveBeenCalled();
    await click(button(t.revoke));
    expect(api.revokePattern).toHaveBeenCalledWith(ws, "pt-1", 4);
  });

  it("the workflow default is an explicit assignment; no reviewer by default", async () => {
    api.listAssignments.mockResolvedValue({ assignments: [] });
    await render(<WorkflowReviewerSetting workspaceId={ws} workflowId="wf-1" />);
    expect(host.textContent).toContain(en.chatApp.workflowReviewer.title);
    expect(button(en.chatApp.workflowReviewer.save)?.disabled).toBe(true);
    await click(host.querySelector('[data-item="rev-2"]'));
    await click(button(en.chatApp.workflowReviewer.save));
    expect(api.assignReviewer).toHaveBeenCalledWith(ws, expect.objectContaining({ reviewerAssistantId: "rev-2", scopeKind: "workflow", scopeId: "wf-1" }));
  });

  it("removes an existing workflow reviewer through revocation", async () => {
    api.listAssignments.mockResolvedValue({ assignments: [{ id: "as-9", workspaceId: ws, reviewerAssistantId: "rev-1", delegatorUserId: "u", scopeKind: "workflow", scopeId: "wf-1", status: "active", revision: 2, origin: "ui" }] });
    await render(<WorkflowReviewerSetting workspaceId={ws} workflowId="wf-1" />);
    await click(host.querySelector('[data-item="__none__"]'));
    await click(button(en.chatApp.workflowReviewer.remove));
    expect(api.revokeReviewer).toHaveBeenCalledWith(ws, "as-9", 2);
  });

  it("carries the copy in all four locales, without em dashes, and maps unknown reasons", () => {
    for (const d of [en, ja, zh, zhCN]) {
      expect(Object.keys(d.chatApp.approvalReview.reasons).sort()).toEqual(Object.keys(en.chatApp.approvalReview.reasons).sort());
      const text = JSON.stringify([d.chatApp.approvalReview, d.chatApp.workflowReviewer])
      expect(text).not.toContain("—");
    }
    expect(reasonText(t, "mismatch:identity_mismatch")).toBe(t.reasons.mismatch);
    expect(reasonText(t, "something_new")).toBe(t.reasons.other.replace("{code}", "something_new"));
  });
});
