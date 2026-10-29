// @vitest-environment jsdom
/**
 * Direct work pickup (project-briefs.md -> "Work"; chat-app.md -> "Work
 * entry"): real claim / follow-up commands, answer and detail links,
 * draft-only chat pickup, resolved-card removal, typed errors, loading vs
 * unavailable vs empty.
 * The HTTP layer is mocked; component state, the surface cache and the
 * commands' wiring are real.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkItem, WorkProjection } from "@/lib/api/work";

const api = vi.hoisted(() => ({
  fetchWork: vi.fn(), claimWorkTask: vi.fn(), adjustBrainRow: vi.fn(), listWorkspaceAssistants: vi.fn(),
  requestBrainRefresh: vi.fn(),
}));
vi.mock("@/lib/api/work", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/work")>()),
  fetchWork: api.fetchWork, claimWorkTask: api.claimWorkTask,
}));
vi.mock("@/lib/api/brain-inbox", () => ({ adjustBrainRow: api.adjustBrainRow }));
vi.mock("@/lib/api/views", () => ({ listWorkspaceAssistants: api.listWorkspaceAssistants }));
vi.mock("@/lib/brain-events", () => ({ requestBrainRefresh: api.requestBrainRefresh }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock("@/components/ui/searchable-select", () => ({
  SearchableSelect: ({ items, onValueChange, placeholder }: { items: { value: string; label: string }[]; onValueChange: (v: string) => void; placeholder: string }) => (
    <select aria-label={placeholder} onChange={(event) => onValueChange(event.target.value)} defaultValue="">
      <option value="" />
      {items.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
    </select>
  ),
}));
vi.mock("@/lib/i18n/client", async () => {
  const { en } = await import("@/lib/i18n/dictionaries/en");
  return { useT: () => en, useLocale: () => "en", format: (text: string, vars: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_m, key) => vars[key] ?? "") };
});
import { en } from "@/lib/i18n/dictionaries/en";
import { resetSurfaceCache } from "@/lib/surface-cache";
import { WorkRequestError } from "@/lib/api/work";
import { BriefWork } from "../brief-work";

const t = en.briefs.work;
let host: HTMLDivElement, root: Root;
const render = async (node: React.ReactNode) => { await act(async () => root.render(node)); };
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const button = (label: string) => Array.from(host.querySelectorAll("button")).find((b) => b.textContent === label);
const click = async (label: string) => { const b = button(label); if (!b) throw new Error(`no button ${label}`); await act(async () => b.click()); await flush(); };
const cards = () => Array.from(host.querySelectorAll("li[data-task-id]")).map((li) => li.getAttribute("data-task-id"));

function item(over: Partial<WorkItem>): WorkItem {
  return {
    taskId: "t", title: "Fictional task", status: "todo", due: null, home: null, executor: { kind: "unassigned" },
    followUp: { source: "none" }, reasons: [], nextAction: "open", blockerReason: null, updatedAt: "2026-10-12T00:00:00Z", ...over,
  };
}
function work(sections: Partial<WorkProjection["sections"]>): WorkProjection {
  const full = { needsYou: [], myWork: [], needsAssignment: [], ...sections };
  return { scope: { kind: "personal" }, viewer: { memberId: "member-me" }, sections: full, generatedAt: "2026-10-13T00:00:00Z",
    counts: { needsYou: full.needsYou.length, myWork: full.myWork.length, needsAssignment: full.needsAssignment.length } };
}
const queue = item({ taskId: "queue", title: "Unassigned invoice run", home: { kind: "department", id: "dept" }, nextAction: "assign", reasons: ["unassigned"], followUp: { source: "owner_queue", home: { kind: "department", id: "dept" } } });
const question = item({ taskId: "question", title: "Assistant needs a decision", executor: { kind: "assistant", assistantId: "a1", name: "Ops" },
  followUp: { source: "explicit", memberId: "member-me", name: "Fictional Person" }, nextAction: "answer", reasons: ["question", "follow_up"] });
const unroutable = item({ taskId: "loose", title: "Assistant work with no home", executor: { kind: "assistant", assistantId: "a1", name: "Ops" },
  followUp: { source: "missing_routing", reason: "no_home" }, nextAction: "select_follow_up", reasons: ["missing_routing"] });
const mine = item({ taskId: "mine", title: "My own task", executor: { kind: "person", memberId: "member-me", name: "Fictional Person" }, reasons: ["assigned_to_you"] });

describe("[COMP:app-web/brief-work] direct work pickup", () => {
  beforeEach(() => {
    resetSurfaceCache();
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    for (const fn of [api.fetchWork, api.claimWorkTask, api.adjustBrainRow, api.listWorkspaceAssistants, api.requestBrainRefresh]) fn.mockReset();
    api.sidebar = { dock: null, dockLoading: false };
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

  it("renders each section with counts equal to its rows, and the reason, executor and follow-up of each card", async () => {
    api.fetchWork.mockResolvedValue(work({ needsYou: [question], myWork: [mine], needsAssignment: [queue] }));
    await render(<BriefWork workspaceId="w1" scope={{ kind: "personal" }} />); await flush();
    expect(cards()).toEqual(["question", "mine", "queue"]);
    for (const section of ["needsYou", "myWork", "needsAssignment"]) {
      expect(host.querySelector(`[data-section="${section}"] span[aria-label="1"]`)).not.toBeNull();
    }
    expect(host.textContent).toContain("Assistant: Ops");
    expect(host.textContent).toContain("Follow-up: Fictional Person");
    expect(host.textContent).toContain(t.reasons.question);
  });

  it("claims an owner-queue task for the viewer through the guarded command and removes the card at once", async () => {
    api.fetchWork.mockResolvedValue(work({ needsAssignment: [queue] }));
    api.claimWorkTask.mockResolvedValue({ id: "queue-next" });
    await render(<BriefWork workspaceId="w1" scope={{ kind: "department", id: "dept" }} />); await flush();
    api.fetchWork.mockResolvedValue(work({ myWork: [{ ...queue, taskId: "queue-next", nextAction: "open", reasons: ["assigned_to_you"] }] }));
    await click(t.actions.take);
    expect(api.claimWorkTask).toHaveBeenCalledWith("w1", "queue", { kind: "person" });
    expect(cards()).not.toContain("queue");
    expect(api.requestBrainRefresh).toHaveBeenCalledWith("w1");
  });

  it("assigns an owner-queue task to an assistant chosen from the roster, never an app assistant", async () => {
    api.fetchWork.mockResolvedValue(work({ needsAssignment: [queue] }));
    api.listWorkspaceAssistants.mockResolvedValue([
      { id: "a1", name: "Ops", kind: "standard", iconSeed: null, appType: null },
      { id: "app", name: "Distribution", kind: "app", iconSeed: null, appType: "distribution" },
    ]);
    api.claimWorkTask.mockResolvedValue({ id: "queue-next" });
    await render(<BriefWork workspaceId="w1" scope={{ kind: "personal" }} />); await flush();
    await click(t.actions.assignAssistant);
    const picker = host.querySelector(`select[aria-label="${t.actions.assistantPlaceholder}"]`) as HTMLSelectElement;
    expect(Array.from(picker.options).map((o) => o.value)).toEqual(["", "a1"]);
    await act(async () => { picker.value = "a1"; picker.dispatchEvent(new Event("change", { bubbles: true })); }); await flush();
    expect(api.claimWorkTask).toHaveBeenCalledWith("w1", "queue", { kind: "assistant", assistantId: "a1" });
  });

  it("shows a typed error when someone else already took the task, and keeps the card", async () => {
    api.fetchWork.mockResolvedValue(work({ needsAssignment: [queue] }));
    api.claimWorkTask.mockRejectedValue(new WorkRequestError("task_already_claimed", 409));
    await render(<BriefWork workspaceId="w1" scope={{ kind: "personal" }} />); await flush();
    await click(t.actions.take);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(t.errors.task_already_claimed);
    expect(cards()).toEqual(["queue"]);
  });

  it("lets the person who started unroutable assistant work follow up through the canonical adjust", async () => {
    api.fetchWork.mockResolvedValue(work({ needsYou: [unroutable] }));
    api.adjustBrainRow.mockResolvedValue({ ok: true, newId: "loose-next" });
    await render(<BriefWork workspaceId="w1" scope={{ kind: "personal" }} />); await flush();
    await click(t.actions.followUpMyself);
    expect(api.adjustBrainRow).toHaveBeenCalledWith("w1", "task", "loose", { follow_up_member_id: "member-me" });
    expect(cards()).toEqual([]);
  });

  it("answers in Approvals and opens the real task; chat pickup is draft-only and only offered when wired", async () => {
    api.fetchWork.mockResolvedValue(work({ needsYou: [question] }));
    const onContinue = vi.fn();
    await render(<BriefWork workspaceId="w1" scope={{ kind: "personal" }} onContinueInChat={onContinue} />); await flush();
    const links = Array.from(host.querySelectorAll("a")).map((a) => [a.textContent, a.getAttribute("href")]);
    expect(links).toContainEqual([t.actions.answer, "/w/w1/p?panel=approvals"]);
    expect(links).toContainEqual([t.actions.openTask, "/w/w1/brain?row=question"]);
    await click(t.actions.continueInChat);
    expect(onContinue).toHaveBeenCalledWith(question, 'Work on task "Assistant needs a decision" (task question).');
    // Nothing was sent or changed by the pickup.
    expect(api.claimWorkTask).not.toHaveBeenCalled();
    expect(api.adjustBrainRow).not.toHaveBeenCalled();
    await render(<BriefWork workspaceId="w1" scope={{ kind: "project", id: "p1" }} />); await flush();
    expect(button(t.actions.continueInChat)).toBeUndefined();
    expect(button(t.actions.take)).toBeUndefined();
  });

  it("keeps controls as real buttons and links with phone tap targets", async () => {
    api.fetchWork.mockResolvedValue(work({ needsAssignment: [queue] }));
    await render(<BriefWork workspaceId="w1" scope={{ kind: "personal" }} />); await flush();
    expect(button(t.actions.take)?.tagName).toBe("BUTTON");
    expect(button(t.actions.take)?.className).toContain("max-sm:min-h-11");
    for (const link of Array.from(host.querySelectorAll("li a"))) expect(link.className).toContain("max-sm:min-h-11");
  });

  it("separates unavailable, stale and empty", async () => {
    api.fetchWork.mockRejectedValueOnce(new WorkRequestError("work_unavailable", 503));
    await render(<BriefWork workspaceId="w1" scope={{ kind: "personal" }} />); await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(t.unavailable);
    expect(host.textContent).not.toContain(t.empty);
    api.fetchWork.mockResolvedValue(work({}));
    await click(t.retry);
    expect(host.textContent).toContain(t.empty);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});
