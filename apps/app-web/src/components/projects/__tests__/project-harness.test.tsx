// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const ports = vi.hoisted(() => ({ fetch: vi.fn(), prompt: vi.fn(), confirm: vi.fn(), viewer: "me" }));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: ports.fetch }));
vi.mock("@/components/ui/prompt-dialog", () => ({ promptDialog: ports.prompt }));
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: ports.confirm }));
vi.mock("@/lib/offline/application-write-authority", () => ({ currentOfflineWriteAuthority: () => ({ apiOrigin: "https://api.example", workspaceId: "w", viewerId: ports.viewer }) }));
vi.mock("@/lib/i18n/client", async () => { const { en } = await import("@/lib/i18n/dictionaries/en"); return { useT: () => en }; });
import { en } from "@/lib/i18n/dictionaries/en";
import { ProjectHarness, type HarnessContext } from "../project-harness";
import { HarnessRuns, HarnessRunDetail, createRunInput } from "../harness-runs";
import { authoredPatch, extendAuthoredPatch, applyPatch, checklistResult, definitionText, emptyDefinition, parseDefinition, scopeArchived, canApprove } from "../harness-model";
import { projectHarnessApi, type HarnessRevision, type HarnessEvidence, type HarnessRun, type EffectiveHarness } from "@/lib/api/project-harness";
import { invalidateSurfaceCache, markSurfaceCacheStale } from "@/lib/surface-cache";
import { projectHarnessCacheKey } from "@/lib/surface-prefetch";
const t = en.projectHarness;
let host: HTMLDivElement, root: Root;
let head: HarnessRevision;
let effective: EffectiveHarness;
let denial: number;
const run: HarnessRun = { id: "run", approvalId: "approval", revisionId: "r1", requestedBy: "me", executor: "human", status: "pending", createdAt: "2026-01-01", expiresAt: "2099-01-01", result: null,
  preview: { runId: "run", packetSha256: "hash", specification: { workspaceId: "w", projectId: "p", scope: { kind: "project" }, revisionId: "r1", revision: 1, definitionSha256: "definition", scenarioSha256: "scenario" }, build: { buildId: "b", deploymentId: "d" }, target: { url: "https://test.example/", permittedOrigins: ["https://test.example"] }, environment: { environmentId: "qa", locale: "en", timezone: "UTC", viewport: { width: 360, height: 800 } }, scenario: { key: "journey", title: "Test journey", preconditions: ["Test account"], steps: ["Open page"], criteria: [{ key: "one", observation: "First outcome", evidence: "Record first value" }, { key: "two", observation: "Second outcome", evidence: "Record second value" }] } } };
const evidence: HarnessEvidence[] = run.preview.scenario.criteria.map((c, i) => ({ id: `e${i}`, runId: "run", criterionKey: c.key, kind: "observation", provenance: "human_reported", text: "Observed", base64: null, contentType: null, sha256: "hash", createdAt: "2026-01-01" }));
const button = (text: string) => [...host.querySelectorAll("button")].find(b => b.textContent === text);
const click = async (text: string) => { expect(button(text), text).toBeTruthy(); await act(async () => button(text)!.click()); };
const render = async (node: React.ReactNode) => { await act(async () => root.render(node)); };
const editor = () => host.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${t.editor}"]`)!;
const edit = async (node: HTMLTextAreaElement, value: string) => { await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(node, value); node.dispatchEvent(new Event("input", { bubbles: true })); }); };
function panel(owner = true, participant = true, archived = false) { return <ProjectHarness workspaceId="w" projectId="p" viewerId={ports.viewer} owner={owner} participant={participant} archived={archived} />; }
function context(owner = false, participant = true): HarnessContext { return { workspaceId: "w", projectId: "p", viewerId: "me", owner, participant, archived: false, api: projectHarnessApi("w", "p"), busy: false, mutate: async work => { await work(); return true; }, protect: work => work() }; }
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); localStorage.clear(); invalidateSurfaceCache("project-harness:"); ports.viewer = "me"; denial = 0;
  head = { id: "r1", revision: 1, scope: { kind: "project" }, createdBy: "me", createdAt: "2026-01-01", definition: { ...emptyDefinition, rules: [{ key: "safety", kind: "invariant", value: "Protected server rule", override: false }], acceptanceScenarios: [run.preview.scenario] } };
  effective = { status: "resolved", sources: [], rules: [], codeChecks: [], acceptanceScenarios: [], conflicts: [] };
  ports.confirm.mockResolvedValue(true); ports.prompt.mockResolvedValue("Renamed");
  ports.fetch.mockImplementation(async (url: string, init: RequestInit) => {
    if (denial) return { ok: false, status: denial, json: async () => ({ error: "denied" }) };
    const path = new URL(url, "https://api.example").pathname.split("/harness")[1];
    const body = path === "/tree" ? { products: [{ id: "product", name: "Product A", status: "active", revision: 2 }], components: [{ id: "component", productId: "product", name: "Component A", status: "active", revision: 3 }] }
      : path === "/definition" ? { definition: head }
      : path === "/history" ? { revisions: [head], limit: 100 }
      : path === "/effective" ? { effective }
      : path === "/approvals" ? { approvals: [] }
      : path === "/runs" ? { runs: [] }
      : path === "/runs/run" ? { run }
      : path === "/runs/run/evidence" ? { evidence }
      : {};
    return { ok: true, json: async () => body };
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); invalidateSurfaceCache("project-harness:"); });

describe("[COMP:app-web/project-harness] scope, governance and recovery", () => {
  it("renders hierarchy/current revision without persisting protected server content", async () => {
    await render(panel());
    expect(host.textContent).toContain("Product A"); expect(host.textContent).toContain("Component A");
    expect(host.textContent).toContain(`${t.revision}: 1`); expect(editor().value).toContain("Protected server rule");
    expect(localStorage.length).toBe(0); expect(button(t.approve)).toBeUndefined(); expect(host.textContent).toContain(t.sameAuthor);
    await click("Component A");
    expect(ports.fetch.mock.calls.some(([url]) => String(url).includes("scope=component&productId=product&componentId=component"))).toBe(true);
  });
  it("preserves authored patches across scopes and remount without auto-copying unchanged content", async () => {
    await render(panel());
    await edit(editor(), editor().value.replace("Protected server rule", "My authored rule"));
    const saved = Object.values(localStorage).join(); expect(saved).toContain("My authored"); expect(saved).not.toContain("Protected server rule");
    await click("Product A"); expect(editor().value).toContain("Protected server rule");
    await click(t.addCheck); expect(editor().value).toContain(t.checkTemplate);
    await click(t.project); expect(editor().value).toContain("My authored rule");
    await render(<div />); await render(panel()); expect(editor().value).toContain("My authored rule");
    ports.viewer = "another"; await render(<ProjectHarness key="another" workspaceId="w" projectId="p" viewerId="another" owner participant archived={false} />);
    expect(editor().value).not.toContain("My authored rule");
  });
  it("keeps governance owner-only and archived scopes read-only", async () => {
    await render(panel(false)); expect(editor().readOnly).toBe(true); expect(button(t.createProduct)).toBeUndefined(); expect(button(t.save)).toBeUndefined();
    await render(panel(true, true, true)); expect(editor().readOnly).toBe(true); expect(button(t.archive)).toBeUndefined();
  });
  it("sends node expected revisions, archive/restore and creation bodies", async () => {
    await render(panel()); await click(t.rename);
    expect(ports.fetch.mock.calls.some(([, init]) => init.method === "PATCH" && JSON.parse(init.body).expectedRevision === 2)).toBe(true);
    await click(t.archive); expect(ports.fetch.mock.calls.some(([, init]) => init.body && JSON.parse(init.body).status === "archived")).toBe(true);
    await click(t.createProduct); expect(ports.fetch.mock.calls.some(([url, init]) => String(url).endsWith("/products") && init.method === "POST" && JSON.parse(init.body).name === "Renamed")).toBe(true);
  });
  it.each([false, true])("rebases without persisting confidential text (changed base: %s)", async changed => {
    head.definition = { ...head.definition, rules: [{ key: "before", kind: "default", value: "alpha CONFIDENTIAL omega", override: false }] };
    const old = head;
    await render(panel());
    await edit(editor(), editor().value.replace("alpha", "AUTHORED-A"));
    await edit(editor(), editor().value.replace("omega", "AUTHORED-Z"));
    const saved = Object.values(localStorage).join();
    expect(saved).not.toContain("CONFIDENTIAL");
    head = { ...old, id: "r2", revision: 2, definition: changed ? { ...old.definition, rules: [...old.definition.rules, { key: "extra", kind: "default", value: "server change", override: false }] } : old.definition };
    const fetch = ports.fetch.getMockImplementation()!;
    ports.fetch.mockImplementation(async (url: string, init: RequestInit) => String(url).includes("/history") ? { ok: true, json: async () => ({ revisions: [head, old] }) } : fetch(url, init));
    await act(async () => markSurfaceCacheStale(projectHarnessCacheKey("w", "p", "me")));
    await click(t.rebase);
    expect(Object.values(localStorage).join()).not.toContain("CONFIDENTIAL");
    if (changed) {
      expect(Object.values(localStorage).join()).toBe(saved);
      expect(host.textContent).toContain(t.rebaseBlocked);
      expect(host.querySelector("pre")?.textContent).toContain("AUTHORED-A");
      expect(host.querySelector("pre")?.textContent).toContain("AUTHORED-Z");
    } else {
      expect(button(t.rebase)).toBeUndefined();
      expect(editor().value).toContain("AUTHORED-A CONFIDENTIAL AUTHORED-Z");
    }
  });
  it("retains readable content and revalidates after an operation-specific 403", async () => {
    await render(panel());
    const fetch = ports.fetch.getMockImplementation()!;
    ports.fetch.mockImplementation(async (url: string, init: RequestInit) => init.method === "PATCH" ? { ok: false, status: 403, json: async () => ({ error: "operation denied" }) } : fetch(url, init));
    const reads = ports.fetch.mock.calls.filter(([url]) => String(url).endsWith("/tree")).length;
    await click(t.rename);
    expect(host.textContent).toContain(t.operationDenied);
    expect(host.textContent).toContain("Product A");
    expect(editor()).not.toBeNull();
    expect(host.textContent).not.toContain(t.denied);
    expect(ports.fetch.mock.calls.filter(([url]) => String(url).endsWith("/tree")).length).toBeGreaterThan(reads);
  });
  it.each(["scope", "owner", "archive", "unmount", "account", "identity", "denial"])("does not submit deferred creates after %s changes", async change => {
    await render(panel());
    let resolve!: (value: string) => void;
    ports.prompt.mockImplementation(() => new Promise<string>(done => { resolve = done; }));
    await click(t.createComponent);
    const signal = ports.prompt.mock.calls[0][0].signal as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    if (change === "scope") await click("Product A");
    if (change === "owner") await render(panel(false));
    if (change === "archive") await render(panel(true, true, true));
    if (change === "unmount") await render(<div />);
    if (change === "account") ports.viewer = "another"; // live auth changes before React rerenders
    if (change === "identity") { ports.viewer = "another"; await render(panel()); }
    if (change === "denial") { denial = 403; await act(async () => markSurfaceCacheStale(projectHarnessCacheKey("w", "p", "me"))); }
    if (change !== "account") expect(signal.aborted).toBe(true);
    await act(async () => resolve("Stale create"));
    expect(ports.fetch.mock.calls.some(([, init]) => init.method === "POST")).toBe(false);
  });
  it("keeps rename open across identical tree refreshes but aborts real node changes", async () => {
    await render(panel());
    let resolve!: (value: string) => void;
    ports.prompt.mockImplementation(() => new Promise<string>(done => { resolve = done; }));
    await click(t.rename);
    const signal = ports.prompt.mock.calls[0][0].signal as AbortSignal;
    await act(async () => markSurfaceCacheStale(projectHarnessCacheKey("w", "p", "me")));
    expect(signal.aborted).toBe(false);
    await act(async () => resolve("Still valid"));
    expect(ports.fetch.mock.calls.some(([, init]) => init.method === "PATCH")).toBe(true);
    await click(t.rename);
    const nextSignal = ports.prompt.mock.calls[1][0].signal as AbortSignal;
    const fetch = ports.fetch.getMockImplementation()!;
    ports.fetch.mockImplementation(async (url: string, init: RequestInit) => String(url).endsWith("/tree") ? { ok: true, json: async () => ({ products: [], components: [] }) } : fetch(url, init));
    await act(async () => markSurfaceCacheStale(projectHarnessCacheKey("w", "p", "me")));
    expect(nextSignal.aborted).toBe(true);
    const writes = ports.fetch.mock.calls.filter(([, init]) => init.method === "PATCH").length;
    await act(async () => resolve("Stale rename"));
    expect(ports.fetch.mock.calls.filter(([, init]) => init.method === "PATCH").length).toBe(writes);
  });
  it("displays effective conflicts with revision origins and review reasons", async () => {
    head.createdBy = "other-owner";
    effective = { ...effective, status: "conflicted", conflicts: [{ key: "safety", reason: "invariant_override", origin: { revisionId: "r1", revision: 1, scope: { kind: "project" } } }] };
    await render(panel()); expect(host.textContent).toContain(t.invariant_override); expect(host.textContent).toContain(t.origin); expect(button(t.approve)?.disabled).toBe(true);
  });
  it("preserves drafts after 409 and never silently changes expected revision", async () => {
    await render(panel()); await click(t.addRule); denial = 409; await click(t.save);
    expect(host.textContent).toContain(t.conflict); expect(editor().value).toContain(t.ruleTemplate);
    const call = ports.fetch.mock.calls.find(([, init]) => init.method === "PUT"); expect(JSON.parse(call![1].body).expectedRevision).toBe(1);
  });
  it.each([401, 403, 404])("removes all protected content after %s revalidation", async status => {
    await render(panel()); expect(host.textContent).toContain("Product A"); denial = status;
    await act(async () => markSurfaceCacheStale(projectHarnessCacheKey("w", "p", "me")));
    expect(host.textContent).toContain(t.denied); expect(host.textContent).not.toContain("Product A"); expect(editor()).toBeNull();
  });
  it("isolates cache keys by viewer, project and scope", () => {
    expect(new Set([projectHarnessCacheKey("w", "p", "a", "project"), projectHarnessCacheKey("w", "p", "b", "project"), projectHarnessCacheKey("w", "p", "a", "product:x"), projectHarnessCacheKey("w", "q", "a", "project")]).size).toBe(4);
    expect(scopeArchived({ products: [{ id: "p", name: "P", description: null, revision: 1, status: "archived" }], components: [] }, { kind: "component", productId: "p", componentId: "c" })).toBe(true);
    expect(canApprove(head, "me", true, false)).toBe(false); expect(canApprove(head, "other", true, false)).toBe(true);
  });
});

describe("[COMP:app-web/project-harness] approved human checklist", () => {
  it("admits participant QA, not oversight, without granting governance", async () => {
    const approval = { id: "a", revisionId: head.id, approvedBy: "reviewer", approvedAt: "today", reason: "reviewed" };
    await render(<HarnessRuns context={context()} scope={{ kind: "project" }} revision={head} approval={approval} runs={[]} refresh={async () => {}} />);
    expect(button(t.startHuman)).toBeTruthy(); expect(button(t.approve)).toBeUndefined();
    expect(host.textContent).toContain(t.automationHelp);
    expect(host.textContent).toContain(t.humanNotice);
    expect([...host.querySelectorAll("button")].filter(b => !b.hasAttribute("role")).map(b => b.textContent)).toEqual([t.startHuman]);
    await render(<HarnessRuns context={context(false, false)} scope={{ kind: "project" }} revision={head} approval={approval} runs={[]} refresh={async () => {}} />);
    expect(button(t.startHuman)).toBeUndefined();
  });
  it.each(["unapproved", "stale-approval", "archived"])("does not offer checklist creation when %s", async state => {
    const approval = state === "unapproved" ? null : { id: "a", revisionId: state === "stale-approval" ? "old" : head.id, approvedBy: "reviewer", approvedAt: "today", reason: "reviewed" };
    await render(<HarnessRuns context={{ ...context(), archived: state === "archived" }} scope={{ kind: "project" }} revision={head} approval={approval} runs={[]} refresh={async () => {}} />);
    expect(button(t.startHuman)).toBeUndefined();
    expect(host.textContent).toContain(t.automationHelp);
    expect(ports.fetch.mock.calls.some(([, init]) => init.method === "POST")).toBe(false);
  });
  it.each(["archived", "nonparticipant", "busy", "expired", "completed"])("does not allow historical agent cancellation when %s", async state => {
    const fetch = ports.fetch.getMockImplementation()!;
    const historicalRun = { ...run, executor: "agent", status: state === "completed" ? "passed" : "pending", expiresAt: state === "expired" ? "2000-01-01" : run.expiresAt };
    ports.fetch.mockImplementation(async (url: string, init: RequestInit) => String(url).endsWith("/runs/run") ? { ok: true, json: async () => ({ run: historicalRun }) } : fetch(url, init));
    await render(<HarnessRunDetail context={{ ...context(false, state !== "nonparticipant"), archived: state === "archived", busy: state === "busy" }} runId="run" />);
    expect(host.textContent).toContain("First outcome");
    expect(host.textContent).toContain(t.humanNotice);
    expect(host.querySelectorAll("button")).toHaveLength(0);
    expect(host.querySelector("textarea")).toBeNull();
  });
  it("requires every criterion and stored human evidence, and blocks agent spoofing", () => {
    expect(checklistResult(run, {}, evidence)).toBeNull();
    const answers = { one: { status: "passed" as const, reason: "" }, two: { status: "passed" as const, reason: "" } };
    expect(checklistResult(run, answers, [])).toBeNull();
    expect(checklistResult(run, answers, evidence)?.criteria).toHaveLength(2);
    expect(checklistResult(run, answers, evidence)?.binding.packetSha256).toBe("hash");
    expect(checklistResult({ ...run, executor: "agent" }, answers, evidence)).toBeNull();
    expect(checklistResult({ ...run, preview: { ...run.preview, scenario: { ...run.preview.scenario, criteria: [] } } }, {}, [])).toBeNull();
    expect(checklistResult(run, { ...answers, two: { status: "blocked", reason: "Environment unavailable" } }, evidence)?.status).toBe("blocked");
  });
  it("shows a usable requester checklist with human provenance and no vacuous submit", async () => {
    await render(<HarnessRunDetail context={context()} runId="run" />);
    expect(host.textContent).toContain("First outcome"); expect(host.textContent).toContain(t.human_reported);
    expect(button(t.complete)?.disabled).toBe(true);
    await click(t.passed); expect(button(t.complete)?.disabled).toBe(true);
    const passButtons = [...host.querySelectorAll("button")].filter(b => b.textContent === t.passed);
    await act(async () => passButtons[1].click()); expect(button(t.complete)?.disabled).toBe(false);
    await click(t.complete);
    const call = ports.fetch.mock.calls.find(([url]) => String(url).endsWith("/result"));
    expect(JSON.parse(call![1].body).criteria).toHaveLength(2);
    expect(JSON.parse(call![1].body).evidence[0].reference).toBe("e0");
  });
  it("keeps historical agent reports readable and cancel requester-only without dispatch", async () => {
    const fetch = ports.fetch.getMockImplementation()!;
    ports.fetch.mockImplementation(async (url: string, init: RequestInit) => String(url).endsWith("/runs/run") ? { ok: true, json: async () => ({ run: { ...run, executor: "agent" } }) } : fetch(url, init));
    await render(<HarnessRunDetail context={{ ...context(true), viewerId: "other-owner" }} runId="run" />);
    expect(button(t.cancel)).toBeUndefined();
    expect(host.textContent).toContain("First outcome");
    expect(host.textContent).toContain(t.automationHelp);
    expect(host.querySelectorAll("button")).toHaveLength(0);
    await render(<HarnessRunDetail context={context(true)} runId="run" />);
    expect(button(t.cancel)).toBeTruthy();
    expect([...host.querySelectorAll("button")].map(b => b.textContent)).toEqual([t.cancel]);
    expect(host.querySelector("textarea")).toBeNull();
    await click(t.cancel);
    expect(ports.fetch.mock.calls.filter(([, init]) => init.method === "POST").map(([url]) => new URL(url, "https://api.example").pathname)).toEqual(["/api/workspaces/w/projects/p/harness/runs/run/cancel"]);
  });
  it("renders historical agent results and provenance without treating reports as acceptance", async () => {
    const fetch = ports.fetch.getMockImplementation()!;
    const result = checklistResult(run, { one: { status: "passed", reason: "Recorded outcome" }, two: { status: "passed", reason: "Recorded outcome" } }, evidence)!;
    ports.fetch.mockImplementation(async (url: string, init: RequestInit) => String(url).endsWith("/runs/run")
      ? { ok: true, json: async () => ({ run: { ...run, executor: "agent", status: "passed", result } }) }
      : String(url).endsWith("/runs/run/evidence")
        ? { ok: true, json: async () => ({ evidence: evidence.map(e => ({ ...e, provenance: "isolated_browser" })) }) }
        : fetch(url, init));
    await render(<HarnessRunDetail context={context()} runId="run" />);
    expect(host.textContent).toContain("Recorded outcome");
    expect(host.textContent).toContain(t.isolated_browser);
    expect(host.textContent).toContain(t.humanNotice);
    expect(host.textContent).toContain(t.automationHelp);
    expect(host.querySelectorAll("button")).toHaveLength(0);
  });
  it("builds only the strict run contract and rejects unsafe URLs or empty identity", () => {
    const form = { scenarioKey: "journey", buildId: "b", deploymentId: "d", environmentId: "qa", url: "https://test.example/", locale: "en", timezone: "UTC", width: "360", height: "800" };
    expect(createRunInput(form, "a")?.executor).toBe("human");
    expect(createRunInput(form, "a")?.target).toEqual({ url: form.url, permittedOrigins: ["https://test.example"] });
    expect(createRunInput({ ...form, url: "http://test.example/" }, "a")).toBeNull();
    expect(createRunInput({ ...form, url: "https://test.example/?token=x" }, "a")).toBeNull();
    expect(createRunInput({ ...form, buildId: "" }, "a")).toBeNull();
  });
  it("preserves optional definition extensions and round-trips authored patches", () => {
    const definition = { ...emptyDefinition, dependencies: [{ key: "dep" }], ownership: { team: "qa" }, interfaces: [] };
    expect(parseDefinition(definitionText(definition))).toEqual(definition);
    const patch = authoredPatch("protected prefix old protected suffix", "protected prefix new protected suffix", 4, "r4");
    expect(patch.inserted).toBe("new"); expect(applyPatch("protected prefix old protected suffix", patch)).toBe("protected prefix new protected suffix");
    const first = authoredPatch("a protected middle z", "A protected middle z", 1, "r1");
    const second = extendAuthoredPatch("a protected middle z", "A protected middle Z", 1, "r1", first);
    expect(JSON.stringify(second)).not.toContain("protected middle");
    expect(applyPatch("a protected middle z", second)).toBe("A protected middle Z");
  });
});
