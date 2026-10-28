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
  updateWorkspacePickerPreferences: vi.fn(async () => ({})),
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
vi.mock("@/lib/api/workspaces", () => ({ updateWorkspacePickerPreferences: api.updateWorkspacePickerPreferences }));
import { I18nProvider } from "@/lib/i18n/client";
import { WorkspaceContextProvider } from "@/lib/workspace-context";
import { setUserInfoCache } from "@/lib/user";
import type { Locale } from "@/lib/i18n/config";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { en } from "@/lib/i18n/dictionaries/en";
import { ja } from "@/lib/i18n/dictionaries/ja";
import { zh } from "@/lib/i18n/dictionaries/zh";
import { zhCN } from "@/lib/i18n/dictionaries/zh-cn";
import { RESEARCH_CHANGED_EVENT, ResearchApiError } from "@/lib/api/research";
import { allDomainDispatches, routeWorkspaceChange } from "@/lib/workspace-events";
import { ChatResearchCard, ResearchDetail, useSessionResearch } from "../research-detail";

const t = en.chatApp.research;
let host: HTMLDivElement, root: Root;
type Owner = { workspaceId: string; viewerId: string; locale?: Locale; dict?: Dictionary };
const defaultOwner: Owner = { workspaceId: "w-1", viewerId: "viewer-a" };
const render = async (node: React.ReactNode, owner: Owner = defaultOwner) => {
  await act(async () => {
    setUserInfoCache({ id: owner.viewerId, name: "Synthetic viewer", email: "viewer@example.com" });
    root.render(
    <I18nProvider locale={owner.locale ?? "en"} dict={owner.dict ?? en}>
      <WorkspaceContextProvider value={{ workspaceId: owner.workspaceId, name: "Research fixture", role: "member", clearance: "internal", me: { id: owner.viewerId } }}>
        {node}
      </WorkspaceContextProvider>
    </I18nProvider>,
    );
  });
};
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
  vi.resetAllMocks();
  api.confirmDialog.mockResolvedValue(true);
  api.updateWorkspacePickerPreferences.mockResolvedValue({});
  api.getResearchActivity.mockResolvedValue(detail());
  api.listResearchActivities.mockResolvedValue({ activities: [] });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); setUserInfoCache(null); });

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


function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function markedDetail(mark: string, activityId = "activity-A"): ResearchActivityDetail {
  const original = detail();
  return detail({
    activity: { ...original.activity, id: activityId, summary: `summary-${mark}`,
      sources: [{ kind: "web", ref: `https://${mark.toLowerCase()}.example/`, title: `source-${mark}`, inspected: true, readAt: original.activity.createdAt }] },
    artifacts: [{ ...original.artifacts[0]!, id: `link-${mark}`, artifactId: `artifact-${mark}` }],
    feedback: [{ ...original.feedback[0]!, id: `feedback-${mark}` }],
    lessons: original.lessons.map((lesson) => ({ ...lesson, id: `${lesson.id}-${mark}`, rule: `lesson-${mark}-${lesson.id}` })),
  });
}
const showDetail = (activityId = "activity-A", workspaceId = "w-1") =>
  <ResearchDetail workspaceId={workspaceId} activityId={activityId} onOpenArtifact={() => {}} />;
const signal = async () => { await act(async () => { window.dispatchEvent(new CustomEvent(RESEARCH_CHANGED_EVENT)); }); };
const resolveRead = async <T,>(read: ReturnType<typeof deferred<T>>, value: T) => { await act(async () => { read.resolve(value); }); await flush(); };
const rejectRead = async <T,>(read: ReturnType<typeof deferred<T>>, error: unknown) => { await act(async () => { read.reject(error); }); await flush(); };
async function setField(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  await act(async () => { el.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function fillImprovement() {
  await setField(host.querySelector("input")!, "Synthetic coverage improvement");
  const fields = host.querySelectorAll("textarea");
  await setField(fields[0]!, "Comparisons omit support terms");
  await setField(fields[1]!, "Include supported terms");
}
const coldFailure = "Could not load this research.";
const refreshFailure = "Could not refresh this research. Showing the last loaded version.";

// Layout effects observe the committed DOM before passive effects can hide an
// old owner's protected content. An eventual flush alone would miss that flash.
function CommitProbe({ children, observe }: { children: React.ReactNode; observe: (text: string) => void }) {
  React.useLayoutEffect(() => { observe(host.textContent ?? ""); });
  return <>{children}</>;
}
function ListProbe({ workspaceId, sessionId, observe }: {
  workspaceId: string | null; sessionId: string | null; observe?: (keys: string[]) => void;
}) {
  const result = useSessionResearch(workspaceId, sessionId);
  const keys = [...result.keys()];
  observe?.(keys);
  return <output data-testid="research-list">{keys.join(",")}</output>;
}


describe("[COMP:app-web/research-detail] current owner and newest read", () => {
  it.each([401, 403, 404])("a newer definitive %s cannot be reversed by an older protected result", async status => {
    const older = deferred<ResearchActivityDetail>(), newer = deferred<ResearchActivityDetail>();
    api.getResearchActivity.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    await render(showDetail());
    await signal();
    expect(api.getResearchActivity).toHaveBeenCalledTimes(2);
    await rejectRead(newer, new ResearchApiError("research_unavailable", status));
    expect(host.textContent).toBe(t.unavailable);
    await resolveRead(older, markedDetail("OLD"));
    expect(host.textContent).toBe(t.unavailable);
    expect(host.querySelector("[data-research-activity]")).toBeNull();
    expect(host.querySelector("[data-feedback-id]")).toBeNull();
  });

  it("the newest successful detail wins over older success and rejection", async () => {
    const first = deferred<ResearchActivityDetail>(), second = deferred<ResearchActivityDetail>(), latest = deferred<ResearchActivityDetail>();
    api.getResearchActivity.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(latest.promise);
    await render(showDetail());
    await signal(); await signal();
    await resolveRead(latest, markedDetail("LATEST"));
    await resolveRead(first, markedDetail("OLD"));
    await rejectRead(second, new ResearchApiError("research_not_found", 404));
    expect(host.textContent).toContain("source-LATEST");
    expect(host.textContent).not.toContain("source-OLD");
    expect(host.textContent).not.toContain(t.unavailable);
  });

  it.each(["activity", "workspace", "viewer"] as const)("masks protected detail on the first committed %s change", async change => {
    api.getResearchActivity.mockResolvedValueOnce(markedDetail("OLD"));
    const pending = deferred<ResearchActivityDetail>();
    const commits: string[] = [];
    const observe = (text: string) => { commits.push(text); };
    await render(<CommitProbe observe={observe}>{showDetail()}</CommitProbe>);
    await flush();
    expect(host.textContent).toContain("source-OLD");
    await fillImprovement();
    api.getResearchActivity.mockReturnValue(pending.promise);
    commits.length = 0;
    const workspaceId = change === "workspace" ? "w-2" : "w-1";
    await render(<CommitProbe observe={observe}>{showDetail(change === "activity" ? "activity-B" : "activity-A", workspaceId)}</CommitProbe>,
      { workspaceId, viewerId: change === "viewer" ? "viewer-b" : "viewer-a" });
    expect(commits[0]).not.toContain("source-OLD");
    expect(commits[0]).not.toContain("lesson-OLD");
    expect(api.getResearchActivity).toHaveBeenCalledTimes(2);
    await resolveRead(pending, markedDetail("NEW"));
    expect(host.textContent).toContain("source-NEW");
    expect(host.querySelector("input")?.value).toBe("");
  });

  it("does not revive the first A incarnation after A to B to A", async () => {
    const oldA = deferred<ResearchActivityDetail>(), b = deferred<ResearchActivityDetail>(), currentA = deferred<ResearchActivityDetail>();
    api.getResearchActivity.mockReturnValueOnce(oldA.promise).mockReturnValueOnce(b.promise).mockReturnValueOnce(currentA.promise);
    await render(showDetail("A"));
    await render(showDetail("B"));
    await render(showDetail("A"));
    await resolveRead(currentA, markedDetail("CURRENT", "A"));
    await resolveRead(oldA, markedDetail("OLD", "A"));
    await rejectRead(b, new ResearchApiError("research_forbidden", 403));
    expect(host.textContent).toContain("source-CURRENT");
    expect(host.textContent).not.toContain("source-OLD");
    expect(host.textContent).not.toContain(t.unavailable);
  });

  it("fences abandoned detail reads under StrictMode replay and owner replacement", async () => {
    const reads: Array<ReturnType<typeof deferred<ResearchActivityDetail>>> = [];
    api.getResearchActivity.mockImplementation(() => { const read = deferred<ResearchActivityDetail>(); reads.push(read); return read.promise; });
    await render(<React.StrictMode>{showDetail("A")}</React.StrictMode>);
    const abandoned = reads.slice();
    expect(abandoned.length).toBeGreaterThan(0);
    await render(<React.StrictMode>{showDetail("B")}</React.StrictMode>);
    const current = reads.at(-1)!;
    expect(current).not.toBe(abandoned.at(-1));
    await resolveRead(current, markedDetail("CURRENT", "B"));
    for (const read of reads.filter(read => read !== current)) await resolveRead(read, markedDetail("ABANDONED", abandoned.includes(read) ? "A" : "B"));
    expect(host.textContent).toContain("source-CURRENT");
    expect(host.textContent).not.toContain("source-ABANDONED");
  });

  it.each(["empty", "newer"] as const)("session list keeps the latest %s answer over an old overlapping read", async mode => {
    const first = deferred<{ activities: ResearchActivityDetail["activity"][] }>(), next = deferred<{ activities: ResearchActivityDetail["activity"][] }>();
    api.listResearchActivities.mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise);
    await render(<ListProbe workspaceId="w-1" sessionId="s-1" />);
    await signal();
    await resolveRead(next, { activities: mode === "empty" ? [] : [{ ...markedDetail("NEW").activity, outputMessageId: "new-message" }] });
    await resolveRead(first, { activities: [{ ...markedDetail("OLD").activity, outputMessageId: "old-message" }] });
    expect(host.querySelector("output")?.textContent).toBe(mode === "empty" ? "" : "new-message");
  });

  it.each(["workspace", "session", "viewer", "null"] as const)("session list returns no previous-owner values during the first %s render", async change => {
    api.listResearchActivities.mockResolvedValueOnce({ activities: [detail().activity] });
    const firstKeys: string[][] = [];
    const observe = (keys: string[]) => { firstKeys.push(keys); };
    await render(<ListProbe workspaceId="w-1" sessionId="s-1" observe={observe} />);
    await flush();
    expect(host.querySelector("output")?.textContent).toBe("m-1");
    const pending = deferred<{ activities: ResearchActivityDetail["activity"][] }>();
    api.listResearchActivities.mockReturnValue(pending.promise);
    firstKeys.length = 0;
    const workspaceId = change === "workspace" ? "w-2" : "w-1";
    await render(<ListProbe workspaceId={change === "null" ? null : workspaceId} sessionId={change === "session" ? "s-2" : "s-1"} observe={observe} />,
      { workspaceId, viewerId: change === "viewer" ? "viewer-b" : "viewer-a" });
    expect(firstKeys[0]).toEqual([]);
    expect(api.listResearchActivities).toHaveBeenCalledTimes(change === "null" ? 1 : 2);
    await resolveRead(pending, { activities: [] });
    expect(host.querySelector("output")?.textContent).toBe("");
  });

  it("session-list StrictMode replay and a later refresh cannot revive abandoned rows", async () => {
    const reads: Array<ReturnType<typeof deferred<{ activities: ResearchActivityDetail["activity"][] }>>> = [];
    api.listResearchActivities.mockImplementation(() => {
      const read = deferred<{ activities: ResearchActivityDetail["activity"][] }>();
      reads.push(read); return read.promise;
    });
    await render(<React.StrictMode><ListProbe workspaceId="w-1" sessionId="s-1" /></React.StrictMode>);
    await signal();
    const current = reads.at(-1)!;
    expect(reads.length).toBeGreaterThan(1);
    await resolveRead(current, { activities: [] });
    for (const read of reads.filter(read => read !== current)) await resolveRead(read, { activities: [detail().activity] });
    expect(host.querySelector("output")?.textContent).toBe("");
  });

  it("session-list transient failure retains its current-owner data, then latest empty evicts it", async () => {
    api.listResearchActivities.mockResolvedValueOnce({ activities: [detail().activity] });
    await render(<ListProbe workspaceId="w-1" sessionId="s-1" />); await flush();
    api.listResearchActivities.mockRejectedValueOnce(new Error("Synthetic offline"));
    await signal(); await flush();
    expect(host.querySelector("output")?.textContent).toBe("m-1");
    api.listResearchActivities.mockResolvedValueOnce({ activities: [] });
    await signal(); await flush();
    expect(host.querySelector("output")?.textContent).toBe("");
  });

  it("session list never restores the first A incarnation after A to B to A", async () => {
    const first = deferred<{ activities: ResearchActivityDetail["activity"][] }>(), middle = deferred<{ activities: ResearchActivityDetail["activity"][] }>(), latest = deferred<{ activities: ResearchActivityDetail["activity"][] }>();
    api.listResearchActivities.mockReturnValueOnce(first.promise).mockReturnValueOnce(middle.promise).mockReturnValueOnce(latest.promise);
    await render(<ListProbe workspaceId="w-1" sessionId="A" />);
    await render(<ListProbe workspaceId="w-1" sessionId="B" />);
    await render(<ListProbe workspaceId="w-1" sessionId="A" />);
    await resolveRead(latest, { activities: [] });
    await resolveRead(first, { activities: [detail().activity] });
    await rejectRead(middle, new Error("Synthetic old failure"));
    expect(host.querySelector("output")?.textContent).toBe("");
  });
});


describe("[COMP:app-web/research-detail] truthful detail read recovery", () => {
  it.each([new Error("Synthetic transport failure"), new ResearchApiError("synthetic_unavailable", 503)])("ends a cold failure with Retry instead of an endless skeleton (%s)", async failure => {
    const retry = deferred<ResearchActivityDetail>();
    api.getResearchActivity.mockRejectedValueOnce(failure).mockReturnValueOnce(retry.promise);
    await render(showDetail()); await flush();
    expect(host.querySelector('[aria-busy="true"]')).toBeNull();
    expect(host.textContent).toContain(coldFailure);
    expect(host.textContent).not.toContain(t.unavailable);
    expect(host.textContent).not.toContain(failure.message);
    expect(host.querySelector('[role="status"]')?.textContent).toContain(coldFailure);
    const recovery = button(en.chat.retry)!;
    expect(recovery.className).toContain("min-h-11");
    await click(recovery);
    expect(api.getResearchActivity).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
    // Retrying never loops or admits a second concurrent button submission.
    button(en.chat.retry)?.click(); button(en.chat.retry)?.click();
    expect(api.getResearchActivity).toHaveBeenCalledTimes(2);
    await resolveRead(retry, markedDetail("RECOVERED"));
    expect(host.textContent).toContain("source-RECOVERED");
    expect(host.textContent).not.toContain(coldFailure);
  });

  it("warns that a failed same-owner refresh retains the last version and Retry clears the warning", async () => {
    api.getResearchActivity.mockResolvedValueOnce(markedDetail("RETAINED"));
    await render(showDetail()); await flush();
    api.getResearchActivity.mockRejectedValueOnce(new ResearchApiError("synthetic_unavailable", 503));
    await signal(); await flush();
    expect(host.textContent).toContain("source-RETAINED");
    expect(host.textContent).toContain(refreshFailure);
    expect(host.querySelector('[role="status"]')?.textContent).toContain(refreshFailure);
    const retry = deferred<ResearchActivityDetail>();
    api.getResearchActivity.mockReturnValueOnce(retry.promise);
    await click(button(en.chat.retry));
    expect(host.textContent).toContain("source-RETAINED");
    await resolveRead(retry, markedDetail("REFRESHED"));
    expect(host.textContent).toContain("source-REFRESHED");
    expect(host.textContent).not.toContain(refreshFailure);
  });

  it("a newer cold error cannot be replaced by an older successful read", async () => {
    const old = deferred<ResearchActivityDetail>(), current = deferred<ResearchActivityDetail>();
    api.getResearchActivity.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    await render(showDetail()); await signal();
    await rejectRead(current, new Error("Synthetic latest offline"));
    expect(host.textContent).toContain(coldFailure);
    await resolveRead(old, markedDetail("OLD"));
    expect(host.textContent).toContain(coldFailure);
    expect(host.textContent).not.toContain("source-OLD");
  });

  it.each([401, 403, 404])("a current %s clears retained protected detail and its notices", async status => {
    api.getResearchActivity.mockResolvedValueOnce(markedDetail("RETAINED"));
    await render(showDetail()); await flush();
    api.getResearchActivity.mockRejectedValueOnce(new Error("Synthetic offline"));
    await signal(); await flush();
    api.getResearchActivity.mockRejectedValueOnce(new ResearchApiError("research_unavailable", status));
    await signal(); await flush();
    expect(host.textContent).toBe(t.unavailable);
    expect(host.querySelector('[data-research-activity]')).toBeNull();
    expect(host.querySelectorAll("input, textarea, button")).toHaveLength(0);
  });

  it.each([
    ["en", en, "Could not load this research."],
    ["ja", ja, "このリサーチを読み込めませんでした。"],
    ["zh", zh, "無法載入這項研究。"],
    ["zh-CN", zhCN, "无法加载这项研究。"],
  ] as const)("renders %s recovery copy through the real I18nProvider", async (locale, dict, expected) => {
    api.getResearchActivity.mockRejectedValueOnce(new Error("Synthetic offline"));
    await render(showDetail(), { ...defaultOwner, locale, dict }); await flush();
    expect(host.textContent).toContain(expected);
    expect(button(dict.chat.retry)).toBeDefined();
    expect(host.textContent).not.toContain("Synthetic offline");
    expect(host.textContent).not.toContain("—");
  });
});


describe("[COMP:app-web/research-detail] action completion belongs to its initiating owner", () => {
  it("does not issue a lesson POST after its pending confirmation loses its owner", async () => {
    const confirmation = deferred<boolean>();
    api.confirmDialog.mockReturnValueOnce(confirmation.promise);
    api.getResearchActivity.mockResolvedValue(markedDetail("A", "A"));
    await render(showDetail("A")); await flush();
    await click(button(t.retire));
    expect(api.confirmDialog).toHaveBeenCalledOnce();
    api.getResearchActivity.mockResolvedValue(markedDetail("B", "B"));
    await render(showDetail("B")); await flush();
    const reads = api.getResearchActivity.mock.calls.length;
    await resolveRead(confirmation, true);
    expect(api.decideResearchLesson).not.toHaveBeenCalled();
    expect(api.getResearchActivity).toHaveBeenCalledTimes(reads);
    expect(host.textContent).toContain("source-B");
  });

  it.each(["success", "stale", "forbidden"] as const)("ignores an old correction's %s completion after owner change", async outcome => {
    const correction = deferred<unknown>();
    api.correctResearchFeedback.mockReturnValueOnce(correction.promise);
    api.getResearchActivity.mockResolvedValue(markedDetail("A", "A"));
    await render(showDetail("A")); await flush();
    await click(host.querySelector('[data-item="missing_coverage"]'));
    expect(api.correctResearchFeedback).toHaveBeenCalledWith("w-1", "feedback-A", "missing_coverage", 1);
    api.getResearchActivity.mockResolvedValue(markedDetail("B", "B"));
    await render(showDetail("B")); await flush();
    const reads = api.getResearchActivity.mock.calls.length;
    const changed = vi.fn(); window.addEventListener(RESEARCH_CHANGED_EVENT, changed);
    try {
      if (outcome === "success") await resolveRead(correction, {});
      else await rejectRead(correction, new ResearchApiError(outcome === "stale" ? "research_stale" : "research_forbidden", outcome === "stale" ? 409 : 403));
      expect(changed).not.toHaveBeenCalled();
      expect(api.getResearchActivity).toHaveBeenCalledTimes(reads);
      expect(host.textContent).toContain("source-B");
      expect(host.querySelector('[role="status"]')).toBeNull();
    } finally { window.removeEventListener(RESEARCH_CHANGED_EVENT, changed); }
  });

  it("an old action finally cannot clear the new owner's pending action", async () => {
    const old = deferred<unknown>(), current = deferred<unknown>();
    api.decideResearchLesson.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    api.getResearchActivity.mockResolvedValue(markedDetail("A", "A"));
    await render(showDetail("A")); await flush();
    await click(button(t.approveCompany));
    api.getResearchActivity.mockResolvedValue(markedDetail("B", "B"));
    await render(showDetail("B")); await flush();
    expect(button(t.approveCompany)?.disabled).toBe(false);
    await click(button(t.approveCompany));
    expect(api.decideResearchLesson).toHaveBeenLastCalledWith("w-1", "les-1-B", "approve", 1);
    await resolveRead(old, {});
    expect(button(t.approveCompany)?.disabled).toBe(true);
    await resolveRead(current, {});
    expect(button(t.approveCompany)?.disabled).toBe(false);
  });

  it("does not attach an old improvement success notice to a new activity", async () => {
    const nomination = deferred<unknown>();
    api.nominateResearchImprovement.mockReturnValueOnce(nomination.promise);
    api.getResearchActivity.mockResolvedValue(markedDetail("A", "A"));
    await render(showDetail("A")); await flush();
    await fillImprovement(); await click(button(t.improvement.submit));
    api.getResearchActivity.mockResolvedValue(markedDetail("B", "B"));
    await render(showDetail("B")); await flush();
    const reads = api.getResearchActivity.mock.calls.length;
    const changed = vi.fn(); window.addEventListener(RESEARCH_CHANGED_EVENT, changed);
    try {
      await resolveRead(nomination, {});
      expect(changed).not.toHaveBeenCalled();
      expect(api.getResearchActivity).toHaveBeenCalledTimes(reads);
      expect(host.textContent).toContain("source-B");
      expect(host.textContent).not.toContain(t.improvement.done);
      expect(host.querySelector("[role=status]")).toBeNull();
    } finally { window.removeEventListener(RESEARCH_CHANGED_EVENT, changed); }
  });

  it("does not publish an old improvement success or announce after unmount", async () => {
    const nomination = deferred<unknown>();
    api.nominateResearchImprovement.mockReturnValueOnce(nomination.promise);
    api.getResearchActivity.mockResolvedValue(markedDetail("A", "A"));
    await render(showDetail("A")); await flush();
    await fillImprovement(); await click(button(t.improvement.submit));
    expect(api.nominateResearchImprovement).toHaveBeenCalledOnce();
    await render(<div>Different surface</div>);
    const changed = vi.fn(); window.addEventListener(RESEARCH_CHANGED_EVENT, changed);
    const reads = api.getResearchActivity.mock.calls.length;
    try {
      await resolveRead(nomination, {});
      expect(changed).not.toHaveBeenCalled();
      expect(api.getResearchActivity).toHaveBeenCalledTimes(reads);
      expect(host.textContent).toBe("Different surface");
    } finally { window.removeEventListener(RESEARCH_CHANGED_EVENT, changed); }
  });
});
