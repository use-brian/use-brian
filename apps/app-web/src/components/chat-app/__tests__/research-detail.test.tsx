// @vitest-environment jsdom
/**
 * Saved research card and side-pane detail (features/research.md -> "UI"):
 * status and save reason, artifact opening, read vs found sources, follow-up
 * label correction with its version, stale and revoked handling, lesson scope
 * and owner review with confirmation, improvement nomination, cross-tab
 * refresh through the research signal, phone tap targets and all four
 * locales. HTTP is mocked; component state and signals are real.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchActivityDetail } from "@/lib/api/research";

const api = vi.hoisted(() => ({
  getResearchActivity: vi.fn(),
  listResearchActivities: vi.fn(),
  correctResearchFeedback: vi.fn(),
  decideResearchLesson: vi.fn(),
  nominateResearchImprovement: vi.fn(),
  confirmDialog: vi.fn(async () => true),
}));
vi.mock("@/lib/api/research", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/research")>()),
  getResearchActivity: api.getResearchActivity,
  listResearchActivities: api.listResearchActivities,
  correctResearchFeedback: api.correctResearchFeedback,
  decideResearchLesson: api.decideResearchLesson,
  nominateResearchImprovement: api.nominateResearchImprovement,
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: api.confirmDialog }));
// A minimal stand-in for the Select primitive: each item is a button that
// reports its value, so the component's own change handling is exercised.
vi.mock("@/components/ui/select", () => {
  const Ctx = React.createContext<(v: string) => void>(() => {});
  return {
    Select: ({ onValueChange, children }: { onValueChange: (v: string) => void; children: React.ReactNode }) =>
      <Ctx.Provider value={onValueChange}><div data-testid="select">{children}</div></Ctx.Provider>,
    SelectTrigger: ({ children, ...rest }: { children: React.ReactNode }) => <div {...rest}>{children}</div>,
    SelectValue: ({ children }: { children: React.ReactNode }) => <span data-testid="select-value">{children}</span>,
    SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => {
      const change = React.useContext(Ctx)
      return <button type="button" data-item={value} onClick={() => change(value)}>{children}</button>
    },
  };
});
vi.mock("@/lib/i18n/client", async () => {
  const { en } = await import("@/lib/i18n/dictionaries/en");
  return { useT: () => en, useLocale: () => "en", format: (text: string, vars: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_m, key) => String(vars[key] ?? "")) };
});
import { en } from "@/lib/i18n/dictionaries/en";
import { ja } from "@/lib/i18n/dictionaries/ja";
import { zh } from "@/lib/i18n/dictionaries/zh";
import { zhCN } from "@/lib/i18n/dictionaries/zh-cn";
import { RESEARCH_CHANGED_EVENT, ResearchApiError } from "@/lib/api/research";
import { allDomainDispatches, routeWorkspaceChange } from "@/lib/workspace-events";
import { ChatResearchCard, ResearchDetail, useSessionResearch } from "../research-detail";

const t = en.chatApp.research;
let host: HTMLDivElement, root: Root;
const render = async (node: React.ReactNode) => { await act(async () => root.render(node)); };
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const button = (label: string) => Array.from(host.querySelectorAll("button")).find((b) => b.textContent === label);
const click = async (el: Element | undefined | null) => { if (!el) throw new Error("missing element"); await act(async () => (el as HTMLElement).click()); await flush(); };

function detail(over: Partial<ResearchActivityDetail> = {}): ResearchActivityDetail {
  return {
    activity: { id: "act-1", sessionId: "s-1", outputMessageId: "m-1", projectId: "p-1", entry: "explicit", status: "saved",
      sources: [
        { kind: "web", ref: "https://vendor-a.example/pricing", title: null, readAt: "2026-10-13T00:00:00Z", inspected: true },
        { kind: "web", ref: "https://vendor-b.example/pricing", title: null, readAt: "2026-10-13T00:00:00Z", inspected: false },
      ],
      gaps: ["Not read: https://vendor-c.example/terms"], summary: "Vendor A leads on price.", saveError: null, createdAt: "2026-10-13T00:00:00Z" },
    artifacts: [{ id: "l-1", kind: "page", artifactId: "page-1", version: 1, relation: "output" }],
    feedback: [{ id: "fb-1", actorUserId: "u-1", outputKey: "page:page-1:1", association: "explicit_reply", kind: "uncertain", uncertain: true,
      origin: "machine", version: 1, createdAt: "2026-10-13T00:00:00Z", revisions: [] }],
    lessons: [
      { id: "les-1", rule: "Lead with a short summary.", scope: "workspace", status: "suggested", evidenceCount: 3, revision: 1, supportCount: 3 },
      { id: "les-2", rule: "Use bullet points.", scope: "user", status: "active", evidenceCount: 3, revision: 2, supportCount: 3 },
    ],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getResearchActivity.mockResolvedValue(detail());
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe("[COMP:app-web/research-detail] saved research card and detail", () => {
  it("R17: shows status, artifacts, read vs found sources, gaps, uncertain follow-ups and scoped lessons", async () => {
    const onOpenArtifact = vi.fn();
    await render(<ResearchDetail workspaceId="w-1" activityId="act-1" onOpenArtifact={onOpenArtifact} />);
    await flush();
    expect(host.querySelector("[data-testid=research-status]")?.textContent).toBe(t.status.saved);
    expect(host.textContent).toContain(t.sourceRead);
    expect(host.textContent).toContain(t.sourceFound);
    expect(host.textContent).toContain("Not read: https://vendor-c.example/terms");
    expect(host.textContent).toContain(t.uncertain);
    expect(host.textContent).toContain(`${t.scopes.workspace} · ${t.lessonStatus.suggested}`);
    expect(host.textContent).toContain(`${t.scopes.user} · ${t.lessonStatus.active}`);
    await click(button(t.openArtifact.replace("{kind}", t.kinds.page)));
    expect(onOpenArtifact).toHaveBeenCalledWith(expect.objectContaining({ kind: "page", artifactId: "page-1" }));
  })

  it("R17: correcting a label sends the shown version and refreshes; a stale version explains and reloads", async () => {
    api.correctResearchFeedback.mockResolvedValue({ revision: 2, stance: "interpretation" });
    await render(<ResearchDetail workspaceId="w-1" activityId="act-1" onOpenArtifact={() => {}} />);
    await flush();
    await click(host.querySelector('[data-item="missing_coverage"]'));
    expect(api.correctResearchFeedback).toHaveBeenCalledWith("w-1", "fb-1", "missing_coverage", 1);
    expect(api.getResearchActivity).toHaveBeenCalledTimes(2);
    api.correctResearchFeedback.mockRejectedValue(new ResearchApiError("research_stale", 409));
    await click(host.querySelector('[data-item="preference"]'));
    expect(host.querySelector("[role=status]")?.textContent).toBe(t.stale);
    expect(api.getResearchActivity).toHaveBeenCalledTimes(3);
  })

  it("R17: company review needs the confirmation-free approve; retire and reject confirm first; forbidden is explained", async () => {
    api.decideResearchLesson.mockResolvedValue({ lesson: {} });
    await render(<ResearchDetail workspaceId="w-1" activityId="act-1" onOpenArtifact={() => {}} />);
    await flush();
    await click(button(t.approveCompany));
    expect(api.decideResearchLesson).toHaveBeenLastCalledWith("w-1", "les-1", "approve", 1);
    api.confirmDialog.mockResolvedValueOnce(false);
    await click(button(t.retire));
    expect(api.decideResearchLesson).toHaveBeenCalledTimes(1);
    await click(button(t.retire));
    expect(api.confirmDialog).toHaveBeenLastCalledWith(expect.objectContaining({ variant: "destructive", title: t.retireConfirmTitle }));
    expect(api.decideResearchLesson).toHaveBeenLastCalledWith("w-1", "les-2", "retire", 2);
    api.decideResearchLesson.mockRejectedValue(new ResearchApiError("research_forbidden", 403));
    await click(button(t.reject));
    expect(host.querySelector("[role=status]")?.textContent).toBe(t.forbidden);
  })

  it("R17: a revoked or deleted result evicts what was shown", async () => {
    await render(<ResearchDetail workspaceId="w-1" activityId="act-1" onOpenArtifact={() => {}} />);
    await flush();
    expect(host.textContent).toContain("Lead with a short summary.");
    api.getResearchActivity.mockRejectedValue(new ResearchApiError("research_not_found", 404));
    await act(async () => { window.dispatchEvent(new CustomEvent(RESEARCH_CHANGED_EVENT)); });
    await flush();
    expect(host.textContent).toBe(t.unavailable);
  })

  it("R14/R17: nominating an improvement cites this result's follow-ups and activity", async () => {
    api.nominateResearchImprovement.mockResolvedValue({ improvement: { id: "i-1" } });
    await render(<ResearchDetail workspaceId="w-1" activityId="act-1" onOpenArtifact={() => {}} />);
    await flush();
    const setValue = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
      const proto = Object.getPrototypeOf(el) as object;
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
      await act(async () => { el.dispatchEvent(new Event("input", { bubbles: true })); });
    };
    const [title] = Array.from(host.querySelectorAll("input"));
    const [pattern, desired] = Array.from(host.querySelectorAll("textarea"));
    expect(button(t.improvement.submit)?.disabled).toBe(true);
    await setValue(title!, "Coverage gap");
    await setValue(pattern!, "Comparisons skip support terms");
    await setValue(desired!, "Always cover support terms");
    await click(button(t.improvement.submit));
    expect(api.nominateResearchImprovement).toHaveBeenCalledWith("w-1", { title: "Coverage gap", pattern: "Comparisons skip support terms",
      desiredBehavior: "Always cover support terms", feedbackIds: ["fb-1"], activityIds: ["act-1"] });
  })

  it("R17: the card and every action keep phone tap targets; inputs keep a 16px phone font", async () => {
    const onOpen = vi.fn();
    await render(<ChatResearchCard status="partial" onOpen={onOpen} />);
    const card = host.querySelector("button")!;
    expect(card.textContent).toContain(t.card.partial);
    expect(card.className).toContain("min-h-11");
    await click(card);
    expect(onOpen).toHaveBeenCalled();
    await render(<ResearchDetail workspaceId="w-1" activityId="act-1" onOpenArtifact={() => {}} />);
    await flush();
    for (const b of host.querySelectorAll("button:not([data-item])")) expect(b.className).toMatch(/min-h-11/);
    for (const f of host.querySelectorAll("input, textarea")) expect(f.className).toMatch(/text-base/);
  })

  it("R17: chat replies pick up saved research across tabs through the research signal", async () => {
    api.listResearchActivities.mockResolvedValueOnce({ activities: [] }).mockResolvedValue({ activities: [detail().activity] });
    let seen: Map<string, unknown> = new Map();
    function Probe() { seen = useSessionResearch("w-1", "s-1"); return null; }
    await render(<Probe />);
    await flush();
    expect(seen.size).toBe(0);
    await act(async () => { window.dispatchEvent(new CustomEvent(RESEARCH_CHANGED_EVENT)); });
    await flush();
    expect([...seen.keys()]).toEqual(["m-1"]);
  })

  it("R17: a research change on another tab or device reaches this one through the workspace event spine", () => {
    expect(routeWorkspaceChange({ workspaceId: "w-1", primitive: "research", action: "update", rowId: "act-1" } as never))
      .toEqual([{ event: RESEARCH_CHANGED_EVENT, detail: { workspaceId: "w-1", rowId: "act-1" } }]);
    expect(allDomainDispatches("w-1").map((d) => d.event)).toContain(RESEARCH_CHANGED_EVENT);
  })

  it("R17: every locale carries the research copy without em dashes", () => {
    for (const dict of [en, ja, zh, zhCN]) {
      const copy = JSON.stringify(dict.chatApp.research) + dict.chatApp.sidePane.research;
      expect(Object.keys(dict.chatApp.research).sort()).toEqual(Object.keys(en.chatApp.research).sort());
      expect(copy).not.toContain("—");
    }
  })
})
