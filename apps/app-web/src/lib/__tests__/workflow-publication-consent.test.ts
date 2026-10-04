import { beforeEach, describe, expect, it, vi } from "vitest";
import { approveWorkflowPublicationConsent, getWorkflowPublicationConsents, revokeWorkflowPublicationConsent } from "../api/workflow-publication-consent";
const fetcher = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth-fetch", () => ({ authFetch: fetcher }));
vi.mock("@/lib/runtime-public-config", () => ({ publicRuntimeConfig: () => ({ apiUrl: "https://api.example" }) }));
const metadata = { canManage: true, workflowUpdatedAt: "version", consentVersion: "12", eligibleStepIds: ["step"], consents: [] };
beforeEach(() => { fetcher.mockReset(); fetcher.mockResolvedValue({ ok: true, json: async () => metadata }); });
describe("[COMP:app-web/workflow-publication-consent] API contract", () => {
  it("reads permissions from the dedicated endpoint", async () => {
    expect(await getWorkflowPublicationConsents("wf/a")).toEqual(metadata);
    expect(fetcher).toHaveBeenCalledWith("https://api.example/api/workflows/wf%2Fa/publication-consents", undefined);
  });
  it("posts only acknowledgment and the saved workflow and consent versions, never definition or private context", async () => {
    expect(await approveWorkflowPublicationConsent("wf/a", "step/b", "version", "12")).toEqual(metadata);
    expect(fetcher).toHaveBeenCalledWith("https://api.example/api/workflows/wf%2Fa/steps/step%2Fb/publication-consent", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: '{"acknowledged":true,"workflowUpdatedAt":"version","consentVersion":"12"}',
    });
  });
  it("revokes without an acknowledgment or definition payload", async () => {
    expect(await revokeWorkflowPublicationConsent("wf", "step")).toEqual(metadata);
    expect(fetcher).toHaveBeenCalledWith("https://api.example/api/workflows/wf/steps/step/publication-consent", { method: "DELETE" });
  });
  it.each([401, 403, 409, 500])("hides server diagnostics (%s)", async status => {
    const json = vi.fn(async () => ({ error: "PRIVATE SOURCE TEXT" }));
    fetcher.mockResolvedValue({ ok: false, status, json });
    await expect(getWorkflowPublicationConsents("wf")).rejects.toThrow("publication_consent_failed");
    expect(json).not.toHaveBeenCalled();
  });
  it("drops unexpected private response fields", async () => {
    fetcher.mockResolvedValue({ ok: true, json: async () => ({ ...metadata, privateContext: "SECRET" }) });
    expect(await getWorkflowPublicationConsents("wf")).toEqual(metadata);
  });
  it.each([undefined, null, "", " ", "1.2", "-1", "1e3", "12\n", 12])("rejects malformed consent generations (%s) on reads and mutations", async consentVersion => {
    fetcher.mockResolvedValue({ ok: true, json: async () => ({ ...metadata, consentVersion }) });
    await expect(getWorkflowPublicationConsents("wf")).rejects.toThrow("publication_consent_failed");
    await expect(approveWorkflowPublicationConsent("wf", "step", "version", "12")).rejects.toThrow("publication_consent_failed");
    await expect(revokeWorkflowPublicationConsent("wf", "step")).rejects.toThrow("publication_consent_failed");
  });
  it("fails closed on malformed permissions", async () => {
    fetcher.mockResolvedValue({ ok: true, json: async () => ({ ...metadata, canManage: "true" }) });
    await expect(getWorkflowPublicationConsents("wf")).rejects.toThrow("publication_consent_failed");
  });
});
