// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { en } from "@/lib/i18n/dictionaries/en";
import type { WorkflowFull } from "@/lib/api/workflow";
import type { WorkflowPublicationConsents } from "@/lib/api/workflow-publication-consent";
import { resetSurfaceCache } from "@/lib/surface-cache";
import { requestWorkflowRefresh } from "@/lib/workflow-events";
import { ConfirmDialogProvider } from "@/components/ui/confirm-dialog";
import { WorkflowPublicationConsent } from "../publication-consent";
const api = vi.hoisted(() => ({ get: vi.fn(), approve: vi.fn(), revoke: vi.fn() }));
vi.mock("@/lib/api/workflow-publication-consent", () => ({ getWorkflowPublicationConsents: api.get, approveWorkflowPublicationConsent: api.approve, revokeWorkflowPublicationConsent: api.revoke }));
vi.mock("@/lib/i18n/client", () => ({ useT: () => en }));
vi.mock("@/lib/surface-prefetch", () => ({ workflowPublicationConsentCacheKey: (w: string, id: string) => `consents:${w}:${id}` }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const c = en.workflowPublicationConsent;
const workflow = { id: "wf", workspaceId: "ws", updatedAt: "2026-01-01T00:00:00Z", definition: { steps: [{ id: "step", type: "assistant_call", prompt: "SECRET PRIVATE PROMPT", deliver: { channelType: "telegram", channelId: "-100123:42", channelIntegrationId: "integration" } }] } } as WorkflowFull;
const grant = { stepId: "step", channelType: "telegram" as const, channelId: "-100123:42", channelIntegrationId: "integration", approvedAt: "2026-01-01T00:00:00Z", expiresAt: "2099-01-31T00:00:00Z", active: true };
let metadata: WorkflowPublicationConsents;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks(); resetSurfaceCache();
  metadata = { canManage: true, workflowUpdatedAt: workflow.updatedAt, consentVersion: "12", eligibleStepIds: ["step"], consents: [] };
  api.get.mockImplementation(async () => metadata);
  api.approve.mockImplementation(async () => ({ ...metadata, consents: [grant] }));
  api.revoke.mockImplementation(async () => ({ ...metadata, consents: [] }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); resetSurfaceCache(); });
async function render(dirty = false, saved = workflow) {
  await act(async () => { root.render(<><ConfirmDialogProvider /><WorkflowPublicationConsent workflow={saved} dirty={dirty} /></>); });
}
function button(label: string) { return [...document.querySelectorAll("button")].find(node => node.textContent === label) as HTMLButtonElement | undefined; }
async function click(label: string) { expect(button(label)).toBeDefined(); await act(async () => button(label)!.click()); }

describe("[COMP:app-web/workflow-publication-consent] explicit publication", () => {
  it("never auto-grants, cancel sends no write, and confirmation warns of disclosure", async () => {
    await render(); expect(api.approve).not.toHaveBeenCalled();
    await click(c.approve);
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain(c.warning);
    expect(dialog?.textContent).toContain("-100123:42");
    expect(dialog?.textContent).toContain("integration");
    expect(document.body.textContent).not.toContain("SECRET PRIVATE PROMPT");
    await click(c.cancel); expect(api.approve).not.toHaveBeenCalled();
  });
  it("approves only after explicit confirmation using the GET version and paints returned metadata", async () => {
    await render(); await click(c.approve); expect(api.approve).not.toHaveBeenCalled();
    await click(c.confirm);
    expect(api.approve).toHaveBeenCalledExactlyOnceWith("wf", "step", workflow.updatedAt, "12");
    expect(host.textContent).toContain(c.active); expect(host.textContent).toContain(grant.expiresAt);
  });
  it("revokes independently, including while the workflow draft is dirty", async () => {
    metadata.consents = [grant]; await render(true);
    expect(button(c.reapprove)?.disabled).toBe(true);
    await click(c.revoke); expect(api.revoke).toHaveBeenCalledExactlyOnceWith("wf", "step");
    expect(button(c.revoke)).toBeUndefined();
  });
  it("allows own consent revocation despite version mismatch, demotion, and unsaved edits", async () => {
    metadata = { ...metadata, workflowUpdatedAt: "new-server-version", canManage: false, consents: [grant] };
    await render(true);
    expect(button(c.revoke)?.disabled).toBe(false);
    await click(c.revoke);
    expect(api.revoke).toHaveBeenCalledExactlyOnceWith("wf", "step");
    expect(button(c.revoke)).toBeUndefined();
  });
  it("uses GET management permission, not a guessed local role", async () => {
    metadata.canManage = false; metadata.consents = [grant]; await render();
    expect(button(c.reapprove)).toBeUndefined(); expect(button(c.revoke)?.disabled).toBe(false);
    expect(host.textContent).toContain(c.permission);
    await click(c.revoke); expect(api.revoke).toHaveBeenCalledExactlyOnceWith("wf", "step");
  });
  it("blocks grants while dirty or mismatched with the saved version", async () => {
    await render(true); expect(button(c.approve)?.disabled).toBe(true);
    await render(false, { ...workflow, updatedAt: "new-version" });
    expect(button(c.approve)?.disabled).toBe(true);
  });
  it("uses server eligibility, not destination presence alone", async () => {
    metadata.eligibleStepIds = []; await render();
    expect(button(c.approve)).toBeUndefined(); expect(host.textContent).toContain(c.empty);
  });
  it("cancels an open confirmation when unsaved edits appear", async () => {
    await render(); await click(c.approve); await render(true);
    expect(button(c.confirm)).toBeUndefined(); expect(api.approve).not.toHaveBeenCalled();
  });
  it("refreshes on workflow signals and cancels old confirmation authority", async () => {
    await render(); await click(c.approve);
    const reads = api.get.mock.calls.length;
    metadata = { ...metadata, canManage: false };
    await act(async () => requestWorkflowRefresh("ws"));
    expect(api.get.mock.calls.length).toBeGreaterThan(reads);
    expect(button(c.confirm)).toBeUndefined(); expect(button(c.approve)).toBeUndefined();
    expect(api.approve).not.toHaveBeenCalled();
  });
  it("cancels an older dialog when refreshed consent generation changes", async () => {
    await render(); await click(c.approve);
    metadata = { ...metadata, consentVersion: "13" };
    await act(async () => requestWorkflowRefresh("ws"));
    expect(button(c.confirm)).toBeUndefined(); expect(api.approve).not.toHaveBeenCalled();
    await click(c.approve); await click(c.confirm);
    expect(api.approve).toHaveBeenCalledExactlyOnceWith("wf", "step", workflow.updatedAt, "13");
  });
  it("blocks revocation when the authority read fails even with cached own consent", async () => {
    metadata.consents = [grant]; await render();
    api.get.mockRejectedValue(new Error("unavailable"));
    await click(c.refresh);
    expect(button(c.revoke)?.disabled).toBe(true);
    await click(c.revoke); expect(api.revoke).not.toHaveBeenCalled();
  });
  it("ignores other workspaces' refresh signals", async () => {
    await render(); const reads = api.get.mock.calls.length;
    await act(async () => requestWorkflowRefresh("other")); expect(api.get).toHaveBeenCalledTimes(reads);
  });
  it("fails closed on a read failure and offers retry without showing diagnostics", async () => {
    api.get.mockRejectedValue(new Error("SECRET SERVER DETAILS")); await render();
    expect(host.textContent).toContain(c.error); expect(host.textContent).not.toContain("SECRET");
    expect(button(c.approve)).toBeUndefined();
    api.get.mockResolvedValue(metadata); await click(c.refresh);
    expect(button(c.approve)?.disabled).toBe(false);
  });
  it("blocks after a failed write without painting a successful approval", async () => {
    api.approve.mockRejectedValue(new Error("SECRET SERVER DETAILS"));
    await render(); await click(c.approve); await click(c.confirm);
    expect(host.textContent).toContain(c.error); expect(host.textContent).not.toContain("SECRET");
    expect(button(c.approve)?.disabled).toBe(true); expect(button(c.revoke)).toBeUndefined();
    await click(c.refresh); expect(button(c.approve)?.disabled).toBe(false);
  });
  it("does not claim expired consent is active", async () => {
    metadata.consents = [{ ...grant, expiresAt: "2000-01-01T00:00:00Z" }]; await render();
    expect(host.textContent).toContain(c.inactive);
  });
});
