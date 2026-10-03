// @vitest-environment jsdom
/**
 * [COMP:app-web/approvals] The approvals queue paints from the surface cache
 * (instant-navigation contract N1 / N3 / N7).
 *
 * Report E "Worst offenders" #4: the panel used to `setRows(null)` on every
 * mount, paint "Loading…" until `listApprovals` answered, and only THEN fetch
 * the skill-card snapshots. It now reads two cache slots in parallel, paints
 * the last-known queue on the first frame, and revalidates behind the paint
 * when the spine marks `approvals:<wid>` stale.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { WORKSPACE_IDENTITY_REFRESH_EVENT } from "@/lib/workspace-identity-events";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import type { PendingApprovalRow } from "@/lib/api/approvals";
import {
  loadSurfaceCache,
  markSurfaceCacheStale,
  resetSurfaceCache,
} from "@/lib/surface-cache";
import {
  approvalSkillDetailsCacheKey,
  approvalsCacheKey,
} from "@/lib/surface-prefetch";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaces: () => ({ activeId: "w1", workspaces: [], active: null }),
}));
vi.mock("@/lib/user", () => ({
  getUserInfo: () => ({ id: "u1", name: "n", email: "e" }),
}));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/lib/api/studio", () => ({ listAssistants: vi.fn(async () => []) }));
vi.mock("../approval-tool-previews", () => ({
  GenericToolPreview: () => null,
  ToolInputToggle: () => null,
  ToolPreview: () => null,
}));

const api = vi.hoisted(() => ({
  listApprovals: vi.fn(),
  listSkillApprovalDetails: vi.fn(),
}));
vi.mock("@/lib/api/approvals", () => ({
  listApprovals: (...args: unknown[]) => api.listApprovals(...args),
  listSkillApprovalDetails: (...args: unknown[]) => api.listSkillApprovalDetails(...args),
  isSkillApprovalKind: (kind: string) =>
    kind === "staged_skill_creation" ||
    kind === "staged_skill_update" ||
    kind === "workflow_refinement",
  respondByKind: vi.fn(),
  reviseEmailApproval: vi.fn(),
}));

import { ApprovalsPanel } from "../approvals-panel";

const dict = en as unknown as Dictionary;

function row(id: string, senderName: string): PendingApprovalRow {
  return {
    id,
    kind: "email_sender",
    status: "pending",
    toolName: "",
    arguments: {},
    approvalPayload: {
      sender: `${senderName.toLowerCase().replace(" ", ".")}@example.com`,
      senderName,
      inboxAddress: "inbox@example.com",
      subject: "Hello",
    },
    approverUserId: "u1",
    originatingAssistantId: null,
    blockingSessionId: null,
    workflowRunId: null,
    workflowStepRunId: null,
    deliveryChannelType: "web",
    createdAt: "2026-09-01T00:00:00.000Z",
    expiresAt: null,
  };
}

const pending = () => new Promise<never>(() => {});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <I18nProvider locale="en" dict={dict}>
        <ApprovalsPanel />
      </I18nProvider>,
    );
    await settle();
  });
}

beforeEach(() => {
  resetSurfaceCache();
  api.listApprovals.mockReset();
  api.listSkillApprovalDetails.mockReset();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe("[COMP:app-web/approvals] approvals queue paints from the surface cache", () => {
  it("first paint renders the warmed rows while the revalidation is still pending (no skeleton, no Loading text)", async () => {
    await loadSurfaceCache(approvalsCacheKey("w1"), async () => [row("a1", "Ada Example")]);
    await loadSurfaceCache(approvalSkillDetailsCacheKey("w1"), async () => ({}));
    // A stale slot means the mount genuinely kicks off a fetch - which never
    // answers here - so what renders is the cache, not the network.
    markSurfaceCacheStale(approvalsCacheKey("w1"));
    api.listApprovals.mockReturnValue(pending());
    api.listSkillApprovalDetails.mockReturnValue(pending());

    await mount();

    expect(host!.textContent).toContain("Ada Example");
    expect(host!.querySelector("[aria-busy]")).toBeNull();
    expect(host!.textContent).not.toContain(en.approvalsPage.loading);
    expect(api.listApprovals).toHaveBeenCalledTimes(1);
  });

  it("fetches the queue and the skill snapshots in PARALLEL on a cold cache (N7), painting a skeleton meanwhile", async () => {
    api.listApprovals.mockReturnValue(pending());
    api.listSkillApprovalDetails.mockReturnValue(pending());

    await mount();

    // Both requests are in flight at once - the snapshots no longer wait for
    // the queue to answer first.
    expect(api.listApprovals).toHaveBeenCalledTimes(1);
    expect(api.listSkillApprovalDetails).toHaveBeenCalledTimes(1);
    expect(host!.querySelector("[aria-busy]")).not.toBeNull();
    expect(host!.textContent).not.toContain(en.approvalsPage.loading);
  });

  it("a spine mark-stale repaints behind the paint: rows stay up, then update when the fetch lands", async () => {
    await loadSurfaceCache(approvalsCacheKey("w1"), async () => [row("a1", "Ada Example")]);
    await loadSurfaceCache(approvalSkillDetailsCacheKey("w1"), async () => ({}));
    await mount();
    expect(host!.textContent).toContain("Ada Example");

    let resolveQueue: (rows: PendingApprovalRow[]) => void = () => {};
    api.listApprovals.mockReturnValue(
      new Promise<PendingApprovalRow[]>((resolve) => {
        resolveQueue = resolve;
      }),
    );
    api.listSkillApprovalDetails.mockResolvedValue({});

    // The family prefix the spine map marks on APPROVALS_REFRESH_EVENT.
    await act(async () => {
      markSurfaceCacheStale("approvals:w1");
      await settle();
    });
    // No blank frame: the old rows are still painted while the refetch runs.
    expect(host!.textContent).toContain("Ada Example");
    expect(host!.querySelector("[aria-busy]")).toBeNull();
    expect(api.listApprovals).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveQueue([row("a2", "Bea Example")]);
      await settle();
    });
    expect(host!.textContent).toContain("Bea Example");
    expect(host!.textContent).not.toContain("Ada Example");
  });
  it("keeps the batch selection and a half-typed reason through the stream catch-up, and clears them on a real identity change", async () => {
    await loadSurfaceCache(approvalsCacheKey("w1"), async () => [{ ...row("a1", "Ada Example"), kind: "tool_invocation" }]);
    await loadSurfaceCache(approvalSkillDetailsCacheKey("w1"), async () => ({}));
    api.listApprovals.mockReturnValue(pending());
    api.listSkillApprovalDetails.mockReturnValue(pending());
    await mount();
    const selectAll = host!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => { selectAll.click(); await settle(); });
    const reason = () => host!.querySelector<HTMLInputElement>(`input[placeholder="${en.approvalsPage.batch.reasonPlaceholder}"]`);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(reason()!, "Checked with finance");
      reason()!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // The stream reconnects every ~5 minutes; its catch-up changes nothing the viewer chose.
    await act(async () => { window.dispatchEvent(new CustomEvent(WORKSPACE_IDENTITY_REFRESH_EVENT, { detail: { workspaceId: "w1", catchUp: true } })); await settle(); });
    expect(reason()?.value).toBe("Checked with finance");
    await act(async () => { window.dispatchEvent(new CustomEvent(WORKSPACE_IDENTITY_REFRESH_EVENT, { detail: { workspaceId: "w1" } })); await settle(); });
    expect(reason()).toBeNull();
  });
  it("renders an explicit departmental review and links to a fresh access review without batch selection",async()=>{
    const card:PendingApprovalRow={...row('department-review','Unused'),kind:'department_access',approvalPayload:{targetTeamName:'Research',beneficiaryName:'Riley',beneficiaryKind:'team',reason:'Review requirements',startsAt:'2030-01-01T00:00:00Z',expiresAt:'2030-01-31T00:00:00Z'}};
    await loadSurfaceCache(approvalsCacheKey('w1'),async()=>[card]);
    await loadSurfaceCache(approvalSkillDetailsCacheKey('w1'),async()=>({}));
    await mount();
    expect(host!.textContent).toContain('Riley');expect(host!.textContent).toContain(en.workspaceAccess.readOnly);expect(host!.textContent).toContain(en.workspaceAccess.futureMembers);
    expect(host!.querySelector('[role="checkbox"]')).toBeNull();
    const event=vi.fn();window.addEventListener('doc:open-settings',event);
    try {
      const button=[...host!.querySelectorAll('button')].find(b=>b.textContent===en.workspaceAccess.title)!;
      await act(async()=>button.click());expect(event).toHaveBeenCalledWith(expect.objectContaining({detail:{section:'ws-access'}}));
    } finally{window.removeEventListener('doc:open-settings',event)}
  });

});
