// @vitest-environment jsdom

/** [COMP:app-web/crm-operations] Entitlement and participation UI parity. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";

const api = vi.hoisted(() => ({
  listCrmEntitlementPlans: vi.fn(),
  listCrmEntitlements: vi.fn(),
  listCrmEvents: vi.fn(),
  listCrmParticipation: vi.fn(),
  grantCrmEntitlement: vi.fn(),
  updateCrmEntitlement: vi.fn(),
  recordCrmParticipation: vi.fn(),
  updateCrmParticipation: vi.fn(),
}));
vi.mock("@/lib/api/crm", () => api);

import { CrmContactLifecycle } from "../operations/contact-lifecycle";
import { CrmProgramsPanel } from "../operations/programs-panel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PLAN_ID = "11111111-1111-4111-8111-111111111111";
const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const CONTACT_ID = "33333333-3333-4333-8333-333333333333";

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  api.listCrmEntitlementPlans.mockResolvedValue([{ id: PLAN_ID, planKey: "member", name: "Member", published: true, commerceManaged: false }]);
  api.listCrmEntitlements.mockResolvedValue([{ id: "entitlement-1", contactId: CONTACT_ID, contactName: "Example Person", planId: PLAN_ID, planKey: "member", planName: "Member", status: "active" }]);
  api.listCrmEvents.mockResolvedValue([{ id: EVENT_ID, slug: "annual-meeting", title: "Annual meeting", status: "published", commerceManaged: true }]);
  api.listCrmParticipation.mockResolvedValue([{ id: "participation-1", eventId: EVENT_ID, eventKey: "annual-meeting", eventTitle: "Annual meeting", contactId: CONTACT_ID, contactName: "Example Person", attendeeName: "Example Person", status: "registered", sourceStatus: "confirmed", sourceKind: "commerce", commerceManaged: true }]);
  api.grantCrmEntitlement.mockResolvedValue({ record: { id: "entitlement-2" }, created: true });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("[COMP:app-web/crm-operations] entitlement and participation lifecycle", () => {
  it("reads canonical contact state and explains the commerce mutation boundary", async () => {
    await act(async () => root.render(
      <I18nProvider locale="en" dict={en}>
        <CrmContactLifecycle workspaceId="workspace-1" contactId={CONTACT_ID} contactName="Example Person" contactEmail="person@example.com" />
      </I18nProvider>,
    ));
    await flush();
    expect(api.listCrmEntitlements).toHaveBeenCalledWith("workspace-1", { contactId: CONTACT_ID, limit: 100 });
    expect(api.listCrmParticipation).toHaveBeenCalledWith("workspace-1", { contactId: CONTACT_ID, limit: 100 });
    expect(container.textContent).toContain("Member");
    expect(container.textContent).toContain("Commerce-managed participation");
    const selects = [...container.querySelectorAll<HTMLButtonElement>("button[role=combobox]")];
    expect(selects.some((button) => button.disabled)).toBe(true);
  });

  it("shows addressable plan and event catalogs with cross-surface lifecycle reads", async () => {
    const selectPlan = vi.fn();
    const selectEvent = vi.fn();
    await act(async () => root.render(
      <I18nProvider locale="en" dict={en}>
        <CrmProgramsPanel workspaceId="workspace-1" selectedPlanId={PLAN_ID} selectedEventId={null} onSelectPlan={selectPlan} onSelectEvent={selectEvent} />
      </I18nProvider>,
    ));
    await flush();
    expect(container.textContent).toContain("Member");
    expect(container.textContent).toContain("1 entitlements use this plan");
    expect(api.listCrmEntitlements).toHaveBeenCalledWith("workspace-1", { planId: PLAN_ID, limit: 100 });
  });
});
