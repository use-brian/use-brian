// @vitest-environment jsdom

/** [COMP:app-web/crm-commercial-operations] Governed records: reviews, engagement tracking, protected values, billing, recurrence, external invoices, governance. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const commercial = vi.hoisted(() => ({
  executeCrmCommercialCommand: vi.fn(),
  getCrmPreparation: vi.fn(),
  listCrmCommercialProfiles: vi.fn(),
  listCrmCustomerAccounts: vi.fn(),
  listCrmInvoices: vi.fn(),
  listCrmOperationDefinitions: vi.fn(),
  listCrmSellers: vi.fn(),
  resolveCrmCommercialFields: vi.fn(),
}));
const governed = vi.hoisted(() => ({
  listCrmChangeRequests: vi.fn(),
  getCrmChangeRequest: vi.fn(),
  getCrmEngagement: vi.fn(),
  listCrmBillingRequests: vi.fn(),
  getCrmBillingBalance: vi.fn(),
  previewCrmRecurringSuccessors: vi.fn(),
  getCrmGovernance: vi.fn(),
}));
vi.mock("@/lib/api/crm-commercial", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/api/crm-commercial")>(),
  ...commercial,
}));
vi.mock("@/lib/api/crm-governed", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/api/crm-governed")>(),
  ...governed,
}));
vi.mock("@/lib/api/departments", () => ({ fetchDepartments: vi.fn(async () => ({ departments: [], homes: [] })) }));
vi.mock("@/lib/office/api", () => ({ readOfficeReleasedFile: vi.fn() }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: vi.fn(async () => true) }));

import { confirmDialog } from "@/components/ui/confirm-dialog";
import { CrmReviewQueue } from "../operations/review-queue";
import { CrmDealEngagement } from "../operations/deal-engagement";
import { CrmCompanyChangeRequests } from "../operations/change-requests";
import { CrmGovernanceSettings } from "../operations/governance-settings";
import { CrmRecordAccounts } from "../operations/record-accounts";
import { InvoicePreparationPanel } from "../operations/invoice-preparation";
import type { CrmCustomerAccount, CrmInvoiceSummary, CrmOperationDefinition, CrmPreparationDetail, CrmSellerProfile } from "@/lib/api/crm-commercial";
import type {
  CrmBillingRequest,
  CrmChangeRequest,
  CrmChangeRequestDetail,
  CrmEngagement,
  CrmGovernance,
} from "@/lib/api/crm-governed";
import { CrmReferenceRequestError } from "@/lib/api/crm-references";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const g = en.crmPage.governed;
const WORKSPACE_ID = "workspace-1";
const ME = "00000000-0000-4000-8000-0000000000a1";
const TEAMMATE = "00000000-0000-4000-8000-0000000000a2";
const COMPANY_ID = "00000000-0000-4000-8000-000000000101";
const DEAL_ID = "00000000-0000-4000-8000-000000000a01";
const REQUEST_ID = "00000000-0000-4000-8000-000000000e01";
const BILLING_ID = "00000000-0000-4000-8000-000000000f01";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000501";
const INVOICE_ID = "00000000-0000-4000-8000-000000000c01";
const members = [{ userId: ME, name: "Alex Example" }, { userId: TEAMMATE, name: "Sam Sample" }];

const governance: CrmGovernance = {
  catalogs: [
    { catalog: "service_category", version: 1, entries: [{ key: "audit", label: "Audit", archived: false }] },
    { catalog: "work_status", version: 4, entries: [
      { key: "in_progress", label: "In progress", archived: false },
      { key: "done", label: "Done", archived: false },
    ] },
  ],
  policies: [
    { subject: "client_change", version: 0, default: true, policy: { mode: "single_review", directRoles: ["owner", "admin"], reviewerDepartmentId: null, financeDepartmentId: null, allowSelfReview: false } },
    { subject: "engagement_change", version: 0, default: true, policy: { mode: "single_review", directRoles: ["owner", "admin"], reviewerDepartmentId: null, financeDepartmentId: null, allowSelfReview: false } },
    { subject: "commercial_values", version: 0, default: true, policy: { mode: "single_review", directRoles: ["owner", "admin"], reviewerDepartmentId: null, financeDepartmentId: null, allowSelfReview: false } },
    { subject: "billing_request", version: 2, policy: { mode: "reviewer_then_finance", directRoles: [], reviewerDepartmentId: null, financeDepartmentId: null, allowSelfReview: false } },
  ],
};

const changeRequest = (patch: Partial<CrmChangeRequest> = {}): CrmChangeRequest => ({
  id: REQUEST_ID,
  targetKind: "deal",
  targetId: DEAL_ID,
  appliedTargetId: null,
  policySubject: "engagement_change",
  state: "submitted",
  revision: 2,
  draftChanges: { name: "Annual audit 2026", engagement: { serviceCategory: "audit" }, assignReferences: [] },
  note: "Renamed after kickoff",
  authorKind: "user",
  authorUserId: TEAMMATE,
  version: 3,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
  ...patch,
});

const changeDetail: CrmChangeRequestDetail = {
  request: changeRequest(),
  revisions: [{
    revision: 2,
    changes: { name: "Annual audit 2026", engagement: { serviceCategory: "audit" }, assignReferences: [] },
    currentSnapshot: { name: "Annual audit", "engagement.serviceCategory": null },
    policyVersion: 0,
    actorKind: "user",
    actorUserId: TEAMMATE,
    createdAt: "2026-10-02T00:00:00.000Z",
  }],
  decisions: [],
};

const engagement = (patch: Partial<CrmEngagement> = {}): CrmEngagement => ({
  id: DEAL_ID,
  displayName: "Annual audit",
  companyId: COMPANY_ID,
  pipelineStage: "won",
  serviceCategory: "audit",
  periodStart: "2026-01-01",
  periodEnd: "2026-12-31",
  financialPeriod: "FY2026",
  workStatus: "in_progress",
  deadline: "2026-11-30",
  ownerUserId: ME,
  participantIds: [TEAMMATE],
  recurrenceParentDealId: null,
  recurrencePeriodKey: null,
  trackingVersion: 3,
  commercialValues: [],
  ...patch,
});

const billingRequest = (patch: Partial<CrmBillingRequest> = {}): CrmBillingRequest => ({
  id: BILLING_ID,
  dealId: DEAL_ID,
  state: "review",
  reviewStep: "reviewer",
  amount: "5000",
  currency: "HKD",
  description: "First milestone",
  authorUserId: TEAMMATE,
  reviewedByUserId: null,
  financeByUserId: null,
  invoiceId: null,
  returnReason: null,
  version: 1,
  ...patch,
});

const seller: CrmSellerProfile = {
  id: "00000000-0000-4000-8000-000000000601",
  sellerKey: "example_studio",
  legalName: "Example Studio Ltd",
  displayName: "Example Studio",
  companyId: null,
  timezone: "UTC",
  status: "active",
  sensitivity: "internal",
  version: 1,
};

const account: CrmCustomerAccount = {
  id: ACCOUNT_ID,
  sellerId: seller.id,
  sellerKey: seller.sellerKey,
  companyId: COMPANY_ID,
  companyName: "Example Trading Ltd",
  label: "Retainer account",
  billingContactId: null,
  billingAddress: null,
  status: "active",
  sensitivity: "internal",
  version: 1,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const externalInvoice: CrmInvoiceSummary = {
  id: INVOICE_ID,
  origin: "external",
  externalProvider: "xero",
  externalRemoteId: "remote-77",
  state: "issued",
  number: "EXT-0007",
  issueDate: "2026-10-05",
  currency: "HKD",
  total: "5000",
  preparationId: null,
  accountId: ACCOUNT_ID,
  version: 2,
  issuedAt: "2026-10-05T00:00:00.000Z",
};

let host: HTMLDivElement;
let root: Root;

async function settle() {
  for (let index = 0; index < 10; index += 1) await act(async () => { await Promise.resolve(); });
}
async function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<I18nProvider locale="en" dict={en}>{node}</I18nProvider>));
  await settle();
}
const buttons = () => Array.from(host.querySelectorAll<HTMLButtonElement>("button"));
const button = (label: string, within: ParentNode = host) =>
  Array.from(within.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim() === label);
const field = <T extends HTMLElement = HTMLInputElement>(label: string, within: ParentNode = host) => within.querySelector<T>(`[aria-label="${label}"]`)!;
async function click(target: HTMLElement | undefined | null) {
  expect(target).toBeTruthy();
  await act(async () => target!.click());
  await settle();
}
async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!;
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}
const ok = (record: unknown, extra: { duplicate?: boolean } = {}) => ({ command: "x", record, created: true, duplicate: extra.duplicate ?? false, emittedEventIds: [] });
const sent = (index = 0) => commercial.executeCrmCommercialCommand.mock.calls[index][1];
const queue = (canDecide = true) => (
  <CrmReviewQueue workspaceId={WORKSPACE_ID} canDecide={canDecide} members={members}
    recordName={(id) => id === DEAL_ID ? "Annual audit" : null} />
);
const dealPanel = (canConfigure = false) => (
  <CrmDealEngagement workspaceId={WORKSPACE_ID} dealId={DEAL_ID} canConfigure={canConfigure} currentUserId={ME} members={members} />
);

beforeEach(() => {
  vi.clearAllMocks();
  governed.getCrmGovernance.mockResolvedValue(governance);
  governed.listCrmChangeRequests.mockResolvedValue([]);
  governed.getCrmChangeRequest.mockResolvedValue(changeDetail);
  governed.getCrmEngagement.mockResolvedValue(engagement());
  governed.listCrmBillingRequests.mockResolvedValue([]);
  governed.getCrmBillingBalance.mockResolvedValue({ deals: [], unbilledByCurrency: [] });
  commercial.listCrmSellers.mockResolvedValue([seller]);
  commercial.listCrmCustomerAccounts.mockResolvedValue([account]);
  commercial.listCrmOperationDefinitions.mockResolvedValue([]);
  commercial.listCrmInvoices.mockResolvedValue([]);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.querySelectorAll("[data-base-ui-portal]").forEach((node) => node.remove());
});

describe("[COMP:app-web/crm-commercial-operations] governed records UI", () => {
  it("shows the latest revision as current versus proposed and approves against its revision", async () => {
    governed.listCrmChangeRequests.mockImplementation(async (_ws: string, input: { reviewable?: boolean }) => input.reviewable ? [changeRequest()] : []);
    commercial.executeCrmCommercialCommand.mockResolvedValue(ok({ request: changeRequest({ state: "approved" }) }));
    await mount(queue());
    expect(governed.listCrmChangeRequests).toHaveBeenCalledWith(WORKSPACE_ID, { reviewable: true });
    const name = host.querySelector('[data-diff-row="name"]')!;
    expect(name.querySelector("[data-diff-current]")?.textContent).toBe("Annual audit");
    expect(name.querySelector("[data-diff-proposed]")?.textContent).toBe("Annual audit 2026");
    const category = host.querySelector('[data-diff-row="engagement.serviceCategory"]')!;
    expect(category.querySelector("[data-diff-current]")?.textContent).toBe(g.notSet);
    expect(category.querySelector("[data-diff-proposed]")?.textContent).toBe("Audit");
    expect(host.textContent).toContain(g.submittedBy.replace("{author}", "Sam Sample").replace("{revision}", "2"));
    expect(button(g.returnAction)?.disabled).toBe(true);
    await click(button(g.approveAction));
    expect(sent()).toEqual({
      kind: "decide_change_request",
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      requestId: REQUEST_ID,
      expectedRevision: 2,
      decision: "approve",
    });
    expect(host.textContent).toContain(g.decided.approve);
  });

  it.each([["return", g.returnAction], ["reject", g.rejectAction]] as const)("%ss with a required reason after a confirm", async (decision, label) => {
    governed.listCrmChangeRequests.mockResolvedValue([changeRequest()]);
    commercial.executeCrmCommercialCommand.mockResolvedValue(ok({}));
    await mount(queue());
    await type(field<HTMLTextAreaElement>(g.decisionReason), "Name must match the engagement letter");
    await click(button(label));
    expect(vi.mocked(confirmDialog)).toHaveBeenCalledTimes(1);
    expect(sent()).toMatchObject({ kind: "decide_change_request", requestId: REQUEST_ID, expectedRevision: 2, decision, reason: "Name must match the engagement letter" });
  });

  it.each([
    ["stale_review", g.refusals.stale_review],
    ["self_review", g.refusals.self_review],
  ])("renders the %s refusal truthfully", async (reason, text) => {
    governed.listCrmChangeRequests.mockResolvedValue([changeRequest()]);
    commercial.executeCrmCommercialCommand.mockRejectedValue(new CrmReferenceRequestError(reason === "self_review" ? "not_authorized" : "conflict", reason === "self_review" ? 403 : 409, { reason }));
    await mount(queue());
    await click(button(g.approveAction));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(text);
    if (reason === "stale_review") expect(text).toContain("Return it so the author can resubmit");
  });

  it("shows members what is waiting but no decision controls", async () => {
    governed.listCrmChangeRequests.mockResolvedValue([changeRequest()]);
    governed.listCrmBillingRequests.mockResolvedValue([billingRequest()]);
    await mount(queue(false));
    expect(host.textContent).toContain(g.reviewsReadOnly);
    expect(button(g.approveAction)).toBeUndefined();
    expect(host.querySelector("[data-review-decision]")).toBeNull();
    expect(host.querySelector("[data-review-billing-decision]")).toBeNull();
  });

  it("labels billing review steps and explains a same-reviewer refusal", async () => {
    governed.listCrmBillingRequests.mockResolvedValue([billingRequest({ reviewStep: "finance", reviewedByUserId: ME })]);
    commercial.executeCrmCommercialCommand.mockRejectedValue(new CrmReferenceRequestError("not_authorized", 403, { reason: "same_reviewer" }));
    await mount(queue());
    expect(governed.listCrmBillingRequests).toHaveBeenCalledWith(WORKSPACE_ID, { state: "review" });
    expect(host.querySelector('[data-billing-step="finance"]')?.textContent).toBe(g.reviewSteps.finance);
    expect(host.textContent).toContain(g.billingReviewedBy.replace("{reviewer}", "Alex Example"));
    await click(button(g.approveFinance));
    expect(sent()).toMatchObject({ kind: "decide_billing_request", requestId: BILLING_ID, expectedVersion: 1, decision: "approve" });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(g.refusals.same_reviewer);
  });

  it("keeps work status apart from the sales stage and edits tracking without fees", async () => {
    commercial.executeCrmCommercialCommand.mockResolvedValue(ok({}));
    await mount(dealPanel());
    expect(host.querySelector('[data-engagement-field="workStatus"]')?.textContent).toContain("In progress");
    expect(host.querySelector('[data-engagement-field="pipelineStage"]')?.textContent).toContain("won");
    expect(host.textContent).toContain(g.workStatusHelp);
    await click(button(g.editTracking));
    await type(field(g.fields.deadline), "2026-12-15");
    await click(button(g.saveTracking));
    const command = sent();
    expect(command).toEqual({
      kind: "update_engagement_tracking",
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      dealId: DEAL_ID,
      expectedVersion: 3,
      tracking: { deadline: "2026-12-15" },
    });
    expect(JSON.stringify(command)).not.toMatch(/amount|fee|commercial/i);
    expect(host.textContent).toContain(g.trackingSaved);
  });

  it("reuses the operation id when an uncertain tracking write is retried", async () => {
    commercial.executeCrmCommercialCommand
      .mockRejectedValueOnce(new CrmReferenceRequestError("network_error", null))
      .mockResolvedValueOnce(ok({}));
    await mount(dealPanel());
    await click(button(g.editTracking));
    await type(field(g.fields.deadline), "2026-12-15");
    await click(button(g.saveTracking));
    await click(button(en.crmPage.commercial.retryWrite));
    expect(sent(1)).toEqual(sent(0));
    expect(sent(1).operationId).toBe(sent(0).operationId);
  });

  it("hides protected values from a viewer who receives none, and shows null as not set", async () => {
    await mount(dealPanel(false));
    expect(host.querySelector("[data-engagement-values]")).toBeNull();
    act(() => root.unmount());
    host.remove();

    governed.getCrmEngagement.mockResolvedValue(engagement({
      commercialValues: [{ valueKind: "confirmed", version: 2, amount: null, currency: "HKD", evidence: null }],
    }));
    await mount(dealPanel(false));
    const values = host.querySelector("[data-engagement-values]")!;
    expect(values.querySelector('[data-commercial-value="confirmed"]')?.textContent).toContain(g.notSet);
    expect(values.querySelector('[data-commercial-value="quoted"]')).toBeNull();
    expect(values.textContent).not.toMatch(/\b0\b/);
    expect(button(g.editValues)).toBeUndefined();
  });

  it("sets protected values with evidence after a confirm, naming each expected version", async () => {
    governed.getCrmEngagement.mockResolvedValue(engagement({
      commercialValues: [{ valueKind: "quoted", version: 4, amount: "12000", currency: "HKD", evidence: null }],
    }));
    commercial.executeCrmCommercialCommand.mockResolvedValue(ok({}));
    await mount(dealPanel(true));
    expect(host.querySelector('[data-commercial-value="confirmed"]')?.textContent).toContain(g.notSet);
    await click(button(g.editValues));
    await type(field(g.valueAmount.replace("{kind}", g.valueKinds.confirmed)), "11500");
    await type(field(g.valueCurrency.replace("{kind}", g.valueKinds.confirmed)), "HKD");
    await type(field(g.evidenceSource), "Signed engagement letter");
    await type(field(g.evidenceReason), "Client accepted the revised scope");
    await click(button(g.saveValues));
    expect(vi.mocked(confirmDialog).mock.calls[0][0].title).toBe(g.valuesConfirmTitle);
    expect(sent()).toMatchObject({
      kind: "set_commercial_values",
      dealId: DEAL_ID,
      values: [{ valueKind: "confirmed", expectedVersion: 0, amount: "11500", currency: "HKD", rate: null }],
      evidence: { source: "Signed engagement letter", reason: "Client accepted the revised scope" },
    });
  });

  it("creates a billing request and reports the review step it waits for; balance never shows zero for a missing fee", async () => {
    governed.listCrmBillingRequests.mockResolvedValue([billingRequest({ state: "returned", reviewStep: null, returnReason: "Split by milestone" })]);
    governed.getCrmBillingBalance.mockResolvedValue({
      deals: [{ dealId: DEAL_ID, displayName: "Annual audit", confirmedFee: null, billed: [], unbilled: null }],
      unbilledByCurrency: [],
    });
    commercial.executeCrmCommercialCommand.mockResolvedValue(ok({ request: billingRequest({ id: "new", state: "review", reviewStep: "reviewer" }) }));
    await mount(dealPanel());
    expect(host.querySelector("[data-billing-unbilled]")?.textContent).toBe(g.noConfirmedFee);
    expect(host.textContent).toContain(g.returnedBecause.replace("{reason}", "Split by milestone"));
    await click(button(g.newBillingRequest));
    await type(field(g.billingAmount), "2500");
    await type(field<HTMLTextAreaElement>(g.billingDescription), "Second milestone");
    await click(button(g.submitForReview, host.querySelector("[data-billing-request-form]")!));
    expect(sent()).toEqual({
      kind: "create_billing_request",
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      dealId: DEAL_ID,
      amount: "2500",
      currency: "HKD",
      description: "Second milestone",
      submit: true,
    });
    expect(host.textContent).toContain(g.billingInReview.replace("{step}", g.reviewSteps.reviewer));
  });

  it("previews the next period, then reports the committed outcomes as returned", async () => {
    governed.previewCrmRecurringSuccessors.mockResolvedValue({
      periodKey: "2027",
      candidates: [{ sourceDealId: DEAL_ID, outcome: "create", proposedName: "Annual audit (2027)" }],
    });
    commercial.executeCrmCommercialCommand.mockResolvedValue(ok({ periodKey: "2027", outcomes: [{ sourceDealId: DEAL_ID, outcome: "existing", dealId: "other" }] }));
    await mount(dealPanel());
    await click(button(g.createNextPeriod));
    const panel = host.querySelector("[data-engagement-next-period]")!;
    await type(field(g.periodKey, panel), "2027");
    await type(field(g.fields.periodStart, panel), "2027-01-01");
    await type(field(g.fields.periodEnd, panel), "2027-12-31");
    await click(button(g.preview, panel));
    expect(governed.previewCrmRecurringSuccessors).toHaveBeenCalledWith(WORKSPACE_ID, { sourceDealIds: [DEAL_ID], periodKey: "2027" });
    expect(panel.querySelector('[data-preview-outcome="create"]')?.textContent).toBe(g.previewCreate.replace("{name}", "Annual audit (2027)"));
    const commit = Array.from(panel.querySelectorAll<HTMLButtonElement>("button")).filter((item) => item.textContent?.trim() === g.createNextPeriod).at(-1);
    await click(commit);
    expect(sent()).toMatchObject({
      kind: "commit_recurring_successors",
      sourceDealIds: [DEAL_ID],
      period: { key: "2027", periodStart: "2027-01-01", periodEnd: "2027-12-31", financialPeriod: null, deadline: null },
      carryForward: ["serviceCategory", "owner", "participants"],
    });
    expect(panel.querySelector('[data-commit-outcome="existing"]')?.textContent).toBe(g.outcomeExisting);
  });

  it("shows a stale preview truthfully and does not offer to commit it", async () => {
    governed.previewCrmRecurringSuccessors.mockResolvedValue({
      periodKey: "2027",
      candidates: [{ sourceDealId: DEAL_ID, outcome: "stale", reason: "source_without_company" }],
    });
    await mount(dealPanel());
    await click(button(g.createNextPeriod));
    const panel = host.querySelector("[data-engagement-next-period]")!;
    await type(field(g.periodKey, panel), "2027");
    await type(field(g.fields.periodStart, panel), "2027-01-01");
    await type(field(g.fields.periodEnd, panel), "2027-12-31");
    await click(button(g.preview, panel));
    expect(panel.querySelector('[data-preview-outcome="stale"]')?.textContent).toBe(g.previewStale.replace("{reason}", g.staleReasons.source_without_company));
    const commit = Array.from(panel.querySelectorAll<HTMLButtonElement>("button")).filter((item) => item.textContent?.trim() === g.createNextPeriod).at(-1);
    expect(commit?.disabled).toBe(true);
  });

  it("proposes only the changed company fields, saves then submits, and says it awaits review", async () => {
    commercial.executeCrmCommercialCommand
      .mockResolvedValueOnce(ok({ request: { id: REQUEST_ID, version: 1, state: "draft" } }))
      .mockResolvedValueOnce(ok({ request: { id: REQUEST_ID, version: 2, state: "submitted" }, applied: false }));
    await mount(<CrmCompanyChangeRequests workspaceId={WORKSPACE_ID} companyId={COMPANY_ID} companyName="Example Trading" domain={null}
      currentUserId={ME} members={members} />);
    await click(button(g.proposeChange));
    await type(field(g.fields.domain), "example.com");
    await click(button(g.submitProposal));
    expect(sent(0)).toEqual({
      kind: "save_change_request",
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      target: { kind: "company", id: COMPANY_ID },
      changes: { assignReferences: [], domain: "example.com" },
    });
    expect(sent(1)).toMatchObject({ kind: "submit_change_request", requestId: REQUEST_ID, expectedVersion: 1 });
    expect(sent(1).operationId).not.toBe(sent(0).operationId);
    expect(host.textContent).toContain(g.submittedForReview);
  });

  it("lets only the author withdraw an open request, with a reason and a confirm", async () => {
    governed.listCrmChangeRequests.mockResolvedValue([
      changeRequest({ id: "mine", targetKind: "company", targetId: COMPANY_ID, authorUserId: ME, state: "returned", version: 5 }),
      changeRequest({ id: "theirs", targetKind: "company", targetId: COMPANY_ID, authorUserId: TEAMMATE }),
    ]);
    commercial.executeCrmCommercialCommand.mockResolvedValue(ok({}));
    await mount(<CrmCompanyChangeRequests workspaceId={WORKSPACE_ID} companyId={COMPANY_ID} companyName="Example Trading" domain={null}
      currentUserId={ME} members={members} />);
    expect(governed.listCrmChangeRequests).toHaveBeenCalledWith(WORKSPACE_ID, { targetId: COMPANY_ID });
    const theirs = host.querySelector('[data-change-request="theirs"]')!;
    expect(button(g.withdraw, theirs)).toBeUndefined();
    const mine = host.querySelector('[data-change-request="mine"]')!;
    await click(button(g.withdraw, mine));
    expect(button(g.withdraw, host.querySelector('[data-change-request-withdraw]')!)?.disabled).toBe(true);
    await type(field<HTMLTextAreaElement>(g.withdrawReason), "No longer needed");
    await click(button(g.withdraw, host.querySelector('[data-change-request-withdraw]')!));
    expect(vi.mocked(confirmDialog).mock.calls[0][0]).toMatchObject({ title: g.withdrawConfirmTitle, variant: "destructive" });
    expect(sent()).toEqual({
      kind: "withdraw_change_request",
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      requestId: "mine",
      expectedVersion: 5,
      reason: "No longer needed",
    });
  });

  it("records an external invoice behind a confirm and corrects its reference without deleting it", async () => {
    commercial.listCrmInvoices.mockResolvedValue([externalInvoice]);
    governed.listCrmBillingRequests.mockImplementation(async (_ws: string, input: { state?: string }) =>
      input.state === "invoiced" ? [billingRequest({ state: "invoiced", invoiceId: INVOICE_ID })] : []);
    commercial.executeCrmCommercialCommand.mockResolvedValue(ok({ invoiceId: "new-invoice" }));
    await mount(<CrmRecordAccounts workspaceId={WORKSPACE_ID} companyId={COMPANY_ID} canConfigure deals={[{ id: DEAL_ID, name: "Annual audit" }]} />);
    await click(button(en.crmPage.invoices.toggle));
    const row = host.querySelector('[data-invoice-origin="external"]')!;
    expect(row.textContent).toContain(g.externalBadge.replace("{provider}", "xero"));

    await click(button(g.recordExternal));
    const form = host.querySelector("[data-external-invoice-form]")!;
    await type(field(g.provider, form), "xero");
    await type(field(g.remoteId, form), "remote-88");
    await type(field(g.invoiceNumber, form), "EXT-0008");
    await type(field(g.issueDate, form), "2026-10-10");
    await type(field(g.invoiceTotal, form), "2500");
    await type(field(g.allocationAmount, form), "2500");
    await click(button(g.recordExternal, form));
    expect(vi.mocked(confirmDialog).mock.calls[0][0].description).toContain("cannot be voided");
    expect(sent()).toEqual({
      kind: "record_external_invoice",
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      accountId: ACCOUNT_ID,
      provider: "xero",
      remoteId: "remote-88",
      number: "EXT-0008",
      issueDate: "2026-10-10",
      currency: "HKD",
      total: "2500",
      allocations: [{ dealId: DEAL_ID, amount: "2500" }],
    });
    expect(host.textContent).toContain(g.externalRecorded);

    await click(button(g.correctReference, host.querySelector('[data-invoice-origin="external"]')!));
    const correction = host.querySelector("[data-external-correction]")!;
    expect(correction.textContent).toContain("The invoice is not deleted");
    await type(field(g.newNumber, correction), "EXT-0007A");
    await click(Array.from(correction.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.getAttribute("aria-pressed") === "false"));
    await type(field<HTMLTextAreaElement>(g.correctionReason, correction), "Provider renumbered the invoice");
    await click(button(g.correctReference, correction));
    expect(vi.mocked(confirmDialog).mock.calls[1][0].description).toBe(g.correctConfirmDescription);
    expect(g.correctConfirmDescription).toContain("not deleted");
    expect(sent(1)).toEqual({
      kind: "correct_external_invoice_reference",
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      invoiceId: INVOICE_ID,
      expectedVersion: 2,
      number: "EXT-0007A",
      reopenBillingRequestIds: [BILLING_ID],
      reason: "Provider renumbered the invoice",
    });
  });

  it("explains an allocation mismatch on an external invoice", async () => {
    commercial.executeCrmCommercialCommand.mockRejectedValue(new CrmReferenceRequestError("invalid_input", 400, { reason: "allocation_total_mismatch" }));
    await mount(<CrmRecordAccounts workspaceId={WORKSPACE_ID} companyId={COMPANY_ID} canConfigure deals={[{ id: DEAL_ID, name: "Annual audit" }]} />);
    await click(button(en.crmPage.invoices.toggle));
    await click(button(g.recordExternal));
    const form = host.querySelector("[data-external-invoice-form]")!;
    await type(field(g.provider, form), "xero");
    await type(field(g.remoteId, form), "remote-88");
    await type(field(g.invoiceNumber, form), "EXT-0008");
    await type(field(g.issueDate, form), "2026-10-10");
    await type(field(g.invoiceTotal, form), "2500");
    await type(field(g.allocationAmount, form), "2000");
    await click(button(g.recordExternal, form));
    expect(form.querySelector('[role="alert"]')?.textContent).toBe(g.refusals.allocation_total_mismatch);
  });

  it("keeps a native allocation's ready billing request on revision", async () => {
    const operation: CrmOperationDefinition = {
      id: "op", operationKey: "invoice", operationKind: "invoice", label: "Invoice", currentVersionId: "v1", status: "active", version: 1,
      versions: [{ id: "v1", versionNumber: 1, state: "accepted", instructions: "", instructionSource: null, fieldBindings: [], templateBinding: null,
        reviewPolicy: "exact_version_review", referenceDefinitionKey: "invoice_number", configHash: "h", proposedByKind: "user", acceptedByKind: "user",
        acceptedAt: null, createdAt: "2026-10-01T00:00:00.000Z" }],
    };
    const detail: CrmPreparationDetail = {
      preparation: { id: "prep", title: "October", state: "draft", version: 2, readyVersion: null, operationVersionId: "v1", accountId: ACCOUNT_ID,
        officeArtifactId: null, officeVersion: null, officeBinding: null, draftRenderError: null },
      current: {
        version: 2,
        content: { dealIds: [DEAL_ID], servicePeriodStart: null, servicePeriodEnd: null, values: {},
          lines: [{ description: "Milestone", quantity: "1", unitPrice: "5000", dealId: DEAL_ID }],
          allocations: [{ dealId: DEAL_ID, amount: "5000", billingRequestId: BILLING_ID }] },
        resolution: { fields: {} },
        totals: null,
        questions: [],
        draftReady: false,
        issueReady: false,
      },
      invoice: null,
    };
    commercial.getCrmPreparation.mockResolvedValue(detail);
    governed.listCrmBillingRequests.mockResolvedValue([billingRequest({ state: "ready_to_bill", reviewStep: null })]);
    commercial.executeCrmCommercialCommand.mockResolvedValue(ok({ preparation: { id: "prep" }, version: { version: 3 } }));
    await mount(<InvoicePreparationPanel workspaceId={WORKSPACE_ID} preparationId="prep" canIssue={false}
      deals={[{ id: DEAL_ID, name: "Annual audit" }]} operations={[operation]} onChanged={() => {}} />);
    await click(button(en.crmPage.invoices.revise));
    expect(governed.listCrmBillingRequests).toHaveBeenCalledWith(WORKSPACE_ID, { state: "ready_to_bill" });
    expect(host.querySelector(`[data-invoice-allocation="${DEAL_ID}"]`)).toBeTruthy();
    await click(button(en.crmPage.invoices.submitRevise));
    expect(sent().allocations).toEqual([{ dealId: DEAL_ID, amount: "5000", billingRequestId: BILLING_ID }]);
  });

  it("archives a catalog entry instead of removing it, and explains a removal refusal", async () => {
    commercial.executeCrmCommercialCommand.mockRejectedValueOnce(new CrmReferenceRequestError("conflict", 409, { reason: "catalog_key_removed" }));
    await mount(<CrmGovernanceSettings workspaceId={WORKSPACE_ID} canConfigure />);
    const catalog = host.querySelector('[data-governance-catalog="work_status"]')!;
    expect(catalog.querySelector(`[aria-label="${g.removeNewEntry}"]`)).toBeNull();
    const entry = catalog.querySelector('[data-catalog-entry="in_progress"]')!;
    await click(button(g.archive, entry));
    await click(button(g.saveCatalog, catalog));
    expect(sent()).toEqual({
      kind: "save_engagement_catalog",
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      catalog: "work_status",
      expectedVersion: 4,
      entries: [
        { key: "in_progress", label: "In progress", archived: true },
        { key: "done", label: "Done", archived: false },
      ],
    });
    expect(catalog.querySelector('[role="alert"]')?.textContent).toBe(g.refusals.catalog_key_removed);
  });

  it("saves a policy against the version it read and keeps department ids when no directory is available", async () => {
    commercial.executeCrmCommercialCommand.mockResolvedValue(ok({}));
    await mount(<CrmGovernanceSettings workspaceId={WORKSPACE_ID} canConfigure />);
    const policy = host.querySelector('[data-governance-policy="billing_request"]')!;
    await click(button(g.allowSelfReview, policy));
    await click(button(g.savePolicy, policy));
    expect(sent()).toEqual({
      kind: "save_governance_policy",
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      subject: "billing_request",
      expectedVersion: 2,
      policy: { mode: "reviewer_then_finance", directRoles: [], reviewerDepartmentId: null, financeDepartmentId: null, allowSelfReview: true },
    });
  });

  it("shows governance read-only to members", async () => {
    await mount(<CrmGovernanceSettings workspaceId={WORKSPACE_ID} canConfigure={false} />);
    expect(host.textContent).toContain(g.settingsReadOnly);
    expect(button(g.savePolicy)).toBeUndefined();
    expect(button(g.saveCatalog)).toBeUndefined();
    expect(buttons().some((item) => item.textContent?.trim() === g.archive)).toBe(false);
  });
});
