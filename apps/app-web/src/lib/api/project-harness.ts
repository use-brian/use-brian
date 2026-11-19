/** Project harness wire contracts. Server remains the authority. [COMP:app-web/project-harness] */
import { authFetch } from "@/lib/auth-fetch";
import { publicRuntimeConfig } from "@/lib/runtime-public-config";

export type HarnessScope = { kind: "project" } | { kind: "product"; productId: string } | { kind: "component"; productId: string; componentId: string };
export type EngineeringNode = { id: string; name: string; description: string | null; status: "active" | "archived"; revision: number; productId?: string };
export type HarnessTree = { products: EngineeringNode[]; components: EngineeringNode[] };
export type HarnessRule = { key: string; kind: "invariant" | "default" | "local"; value: string; override: boolean };
export type AcceptanceScenario = { key: string; title: string; preconditions: readonly string[]; steps: readonly string[]; criteria: readonly { key: string; observation: string; evidence: string }[] };
export type HarnessDefinition = { schemaVersion: 1; rules: HarnessRule[]; codeChecks: { key: string; kind: "unit" | "integration" | "contract"; instructions: string; command?: string }[]; acceptanceScenarios: AcceptanceScenario[]; [extension: string]: unknown };
export type HarnessRevision = { id: string; revision: number; scope: HarnessScope; definition: HarnessDefinition; createdBy: string | null; createdAt: string };
export type HarnessOrigin = { revisionId: string; revision: number; scope: HarnessScope };
export type EffectiveHarness = { status: "resolved" | "conflicted"; sources: HarnessOrigin[]; rules: (HarnessRule & { origin: HarnessOrigin })[]; codeChecks: (HarnessDefinition["codeChecks"][number] & { origin: HarnessOrigin })[]; acceptanceScenarios: (AcceptanceScenario & { origin: HarnessOrigin })[]; conflicts: { key: string; reason: "invariant_override" | "override_required" | "override_without_default"; origin: HarnessOrigin; inheritedFrom?: HarnessOrigin }[] };
export type HarnessApproval = { id: string; revisionId: string; approvedBy: string; approvedAt: string; reason: string };
export type CreateHarnessRun = {
  approvalId: string; scenarioKey: string; executor: "human";
  build: { buildId: string; deploymentId: string };
  target: { url: string; permittedOrigins: string[] };
  environment: { environmentId: string; locale: string; timezone: string; viewport: { width: number; height: number } };
};
export type ResultStatus = "passed" | "failed" | "blocked" | "inconclusive";
export type VerificationSpecification = { workspaceId: string; projectId: string; scope: HarnessScope; revisionId: string; revision: number; definitionSha256: string; scenarioSha256: string };
export type VerificationResult = {
  binding: { runId: string; packetSha256: string; specification: VerificationSpecification; build: CreateHarnessRun["build"]; scenarioKey: string };
  status: ResultStatus;
  criteria: { criterionKey: string; status: ResultStatus; evidenceIds: string[]; reason?: string }[];
  evidence: { id: string; criterionKey: string; kind: "screenshot" | "recording" | "observation" | "artifact"; reference: string }[];
};
export type HarnessRun = {
  id: string; revisionId: string; approvalId: string; requestedBy: string; executor: "human" | "agent";
  status: "pending" | "running" | ResultStatus | "cancelled" | "expired";
  preview: { runId: string; packetSha256: string; specification: VerificationSpecification; build: CreateHarnessRun["build"]; target: CreateHarnessRun["target"]; environment: CreateHarnessRun["environment"]; scenario: AcceptanceScenario };
  result: VerificationResult | null; createdAt: string; expiresAt: string;
};
export type HarnessEvidence = { id: string; runId: string; criterionKey: string; kind: "observation" | "screenshot"; provenance: "human_reported" | "isolated_browser"; text: string | null; base64: string | null; contentType: "image/png" | null; sha256: string; createdAt: string };
export class HarnessApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export function harnessScopeKey(scope: HarnessScope): string {
  return scope.kind === "project" ? "project" : scope.kind === "product" ? `product:${scope.productId}` : `component:${scope.productId}:${scope.componentId}`;
}
export function harnessScopeQuery(scope: HarnessScope): string {
  const query = new URLSearchParams({ scope: scope.kind });
  if (scope.kind !== "project") query.set("productId", scope.productId);
  if (scope.kind === "component") query.set("componentId", scope.componentId);
  return query.toString();
}
const segment = encodeURIComponent;
export function projectHarnessApi(workspaceId: string, projectId: string) {
  const base = `${publicRuntimeConfig().apiUrl ?? "http://localhost:4000"}/api/workspaces/${segment(workspaceId)}/projects/${segment(projectId)}/harness`;
  async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const response = await authFetch(base + path, { method, cache: "no-store", ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({})) as { error?: string };
      throw new HarnessApiError(response.status, detail.error ?? "harness_request_failed");
    }
    return response.json() as Promise<T>;
  }
  const nodePath = (scope: Exclude<HarnessScope, { kind: "project" }>) => `/products/${segment(scope.productId)}${scope.kind === "component" ? `/components/${segment(scope.componentId)}` : ""}`;
  return {
    tree: () => request<HarnessTree>("/tree"),
    createProduct: (name: string) => request<{ product: EngineeringNode }>("/products", "POST", { name }),
    createComponent: (productId: string, name: string) => request<{ component: EngineeringNode }>(`/products/${segment(productId)}/components`, "POST", { name }),
    updateNode: (scope: Exclude<HarnessScope, { kind: "project" }>, input: { expectedRevision: number; name?: string; status?: "active" | "archived" }) => request<{ product?: EngineeringNode; component?: EngineeringNode }>(nodePath(scope), "PATCH", input),
    definition: (scope: HarnessScope) => request<{ definition: HarnessRevision | null }>(`/definition?${harnessScopeQuery(scope)}`),
    history: (scope: HarnessScope) => request<{ revisions: HarnessRevision[]; limit: number }>(`/history?${harnessScopeQuery(scope)}`),
    effective: (scope: HarnessScope) => request<{ effective: EffectiveHarness }>(`/effective?${harnessScopeQuery(scope)}`),
    save: (scope: HarnessScope, expectedRevision: number, definition: HarnessDefinition) => request<{ definition: HarnessRevision }>("/definition", "PUT", { scope, expectedRevision, definition }),
    approvals: (scope: HarnessScope) => request<{ approvals: HarnessApproval[] }>(`/approvals?${harnessScopeQuery(scope)}`),
    approve: (revisionId: string, expectedRevision: number, reason: string) => request<{ approval: HarnessApproval }>(`/revisions/${segment(revisionId)}/approve`, "POST", { expectedRevision, reason }),
    runs: (scope: HarnessScope) => request<{ runs: HarnessRun[] }>(`/runs?${harnessScopeQuery(scope)}`),
    createRun: (input: CreateHarnessRun) => request<{ run: HarnessRun }>("/runs", "POST", input),
    run: (runId: string) => request<{ run: HarnessRun }>(`/runs/${segment(runId)}`),
    evidence: (runId: string) => request<{ evidence: HarnessEvidence[] }>(`/runs/${segment(runId)}/evidence`),
    addEvidence: (runId: string, criterionKey: string, text: string) => request<{ evidence: HarnessEvidence }>(`/runs/${segment(runId)}/evidence`, "POST", { criterionKey, text }),
    result: (runId: string, result: VerificationResult) => request<{ run: HarnessRun }>(`/runs/${segment(runId)}/result`, "POST", result),
    cancel: (runId: string) => request<{ run: HarnessRun }>(`/runs/${segment(runId)}/cancel`, "POST", {}),
  };
}
export type ProjectHarnessApi = ReturnType<typeof projectHarnessApi>;
