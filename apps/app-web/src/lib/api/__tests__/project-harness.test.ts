import { beforeEach, describe, expect, it, vi } from "vitest";
const fetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth-fetch", () => ({ authFetch: fetch }));
vi.mock("@/lib/runtime-public-config", () => ({ publicRuntimeConfig: () => ({ apiUrl: "https://api.example" }) }));
import { projectHarnessApi, harnessScopeKey, harnessScopeQuery, type CreateHarnessRun, type VerificationResult } from "../project-harness";
const api = projectHarnessApi("workspace", "project");
beforeEach(() => { fetch.mockReset(); fetch.mockResolvedValue({ ok: true, json: async () => ({}) }); });
const last = () => { const [url, init] = fetch.mock.calls.at(-1)!; return { url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined, cache: init.cache }; };
describe("[COMP:app-web/project-harness] API wire contracts", () => {
  it("qualifies hierarchy queries with both ancestors", async () => {
    const scope = { kind: "component", productId: "p", componentId: "c" } as const;
    expect(harnessScopeKey(scope)).toBe("component:p:c");
    expect(harnessScopeQuery(scope)).toBe("scope=component&productId=p&componentId=c");
    await api.definition(scope);
    expect(last()).toMatchObject({ url: "https://api.example/api/workspaces/workspace/projects/project/harness/definition?scope=component&productId=p&componentId=c", cache: "no-store" });
    await api.approvals(scope); expect(last().url).toContain("/approvals?scope=component&productId=p&componentId=c");
    await api.runs(scope); expect(last().url).toContain("/runs?scope=component&productId=p&componentId=c");
  });
  it("sends optimistic node revisions and exact review bodies", async () => {
    await api.updateNode({ kind: "component", productId: "p", componentId: "c" }, { expectedRevision: 3, status: "archived" });
    expect(last()).toMatchObject({ method: "PATCH", body: { expectedRevision: 3, status: "archived" } });
    expect(last().url).toContain("/products/p/components/c");
    await api.approve("r", 4, "Reviewed all criteria");
    expect(last()).toMatchObject({ method: "POST", body: { expectedRevision: 4, reason: "Reviewed all criteria" } });
    expect(last().url).toContain("/revisions/r/approve");
  });
  it("does not add fields to strict execution contracts", async () => {
    const input: CreateHarnessRun = { approvalId: "a", scenarioKey: "journey", executor: "human", build: { buildId: "b", deploymentId: "d" }, target: { url: "https://test.example/", permittedOrigins: ["https://test.example"] }, environment: { environmentId: "test", locale: "en", timezone: "UTC", viewport: { width: 360, height: 800 } } };
    await api.createRun(input); expect(last().body).toEqual(input);
    await api.addEvidence("run", "outcome", "Observed value"); expect(last().body).toEqual({ criterionKey: "outcome", text: "Observed value" });
    const result = { binding: { runId: "run" }, criteria: [], evidence: [], status: "blocked" } as unknown as VerificationResult;
    await api.result("run", result); expect(last().body).toEqual(result);
    await api.cancel("run"); expect(last().body).toEqual({}); expect(last().url).toContain("/runs/run/cancel");
    expect(api).not.toHaveProperty("dispatch");
    await api.run("run"); expect(last().url).toContain("/runs/run");
    await api.evidence("run"); expect(last().url).toContain("/runs/run/evidence");
  });
  it.each([401, 403, 404, 409, 503])("preserves HTTP %s for denial/conflict handling", async status => {
    fetch.mockResolvedValue({ ok: false, status, json: async () => ({ error: "harness_error" }) });
    await expect(api.tree()).rejects.toMatchObject({ status, code: "harness_error" });
  });
});
